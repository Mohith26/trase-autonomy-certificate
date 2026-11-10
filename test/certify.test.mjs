import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  binomCdf, cpUpper, lttThreshold, onlinePvalues, shiryaevRoberts, calibrator, mulberry32,
  prepare, analyze, evaluate, labelsNeeded,
} from '../core/certify.mjs';

const data = JSON.parse(readFileSync(new URL('../data/faxes.json', import.meta.url)));
const P = prepare(data);
const R = analyze(P, {});

test('binomial CDF matches brute force and Clopper-Pearson bound is consistent', () => {
  const brute = (e, n, p) => { let s = 0; for (let i = 0; i <= e; i++) { let c = 1; for (let j = 0; j < i; j++) c = c * (n - j) / (j + 1); s += c * p ** i * (1 - p) ** (n - i); } return s; };
  for (const [e, n, p] of [[0, 10, 0.1], [3, 40, 0.05], [7, 120, 0.03], [12, 300, 0.02]]) assert.ok(Math.abs(binomCdf(e, n, p) - brute(e, n, p)) < 1e-9);
  const u = cpUpper(4, 500, 0.05);
  assert.ok(Math.abs(binomCdf(4, 500, u) - 0.05) < 1e-6);
  assert.ok(u > 4 / 500);
});

test('the tail-betting calibrator integrates to 1 under Uniform(0,1)', () => {
  let s = 0; const N = 200000;
  for (let i = 0; i < N; i++) s += calibrator((i + 0.5) / N, 0.01, 0.05);
  assert.ok(Math.abs(s / N - 1) < 1e-3);
});

test('Learn-then-Test: P(selective risk > alpha) <= delta over repeated calibration draws', () => {
  // known ground truth: error probability decreases with confidence; true selective risk computable exactly
  const rng = mulberry32(99);
  const errProb = (c) => 0.25 * (1 - c) ** 1.5;
  const trueRisk = (lam) => { // E[err | conf >= lam] with conf ~ Uniform(0.5, 1)
    let a = 0, b = 0; for (let i = 0; i < 4000; i++) { const c = 0.5 + 0.5 * (i + 0.5) / 4000; if (c >= lam) { a += errProb(c); b++; } } return b ? a / b : 0;
  };
  const alpha = 0.03, delta = 0.1;
  let viol = 0, certified = 0; const T = 300;
  for (let t = 0; t < T; t++) {
    const items = Array.from({ length: 600 }, () => { const c = 0.5 + 0.5 * rng(); return { conf: c, err: rng() < errProb(c) }; });
    const r = lttThreshold(items, alpha, delta);
    if (r.cert) { certified++; if (trueRisk(r.cert.lam) > alpha) viol++; }
  }
  assert.ok(certified > T * 0.8, 'should usually certify something');
  assert.ok(viol / T <= delta + 0.03, `violation rate ${viol / T}`);
});

test('online conformal p-values are uniform and the sentinel stays quiet under exchangeability', () => {
  const rng = mulberry32(5);
  let falseAlarms = 0;
  const runs = 40;
  for (let r = 0; r < runs; r++) {
    const cal = Array.from({ length: 2000 }, () => rng());
    const live = Array.from({ length: 3000 }, () => rng());
    const p = onlinePvalues(cal, live, rng);
    if (r === 0) {
      const mean = p.reduce((a, b) => a + b, 0) / p.length;
      const tail = p.filter(x => x <= 0.01).length / p.length;
      assert.ok(Math.abs(mean - 0.5) < 0.02);
      assert.ok(tail < 0.02);
    }
    if (shiryaevRoberts(p, { A: 50000 }).alarm >= 0) falseAlarms++;
  }
  // SR guarantee: E[R_n] = n, so P(alarm within 3,000) is at most about 3000/50000 per run
  assert.ok(falseAlarms <= 4, `false alarms ${falseAlarms}/${runs}`);
  // and it fires quickly when 5% of the stream becomes extreme
  const cal = Array.from({ length: 2000 }, () => rng());
  const live = Array.from({ length: 3000 }, (_, i) => (i > 1000 && rng() < 0.05 ? 2 + rng() : rng()));
  const sr = shiryaevRoberts(onlinePvalues(cal, live, rng), { A: 50000 });
  assert.ok(sr.alarm > 1000 && sr.alarm < 1600, `alarm at ${sr.alarm}`);
});

test('pipeline: certified queues hold the target on live traffic before the shift', () => {
  const pre = R.live.preAlarm.certified;
  R.cert.byQueue.forEach((q, k) => {
    if (!q.cert) { assert.equal(pre.byQueue[k].auto, 0); return; }
    const s = pre.byQueue[k];
    assert.ok(s.autoErr / s.auto <= 0.03, `${P.D.queues[k].id} realized ${(s.autoErr / s.auto).toFixed(4)}`);
    assert.ok(q.cert.ucb <= 0.03 + 1e-9);
  });
  // the global 0.90 confidence rule breaches the 3% target somewhere even though its average looks fine
  const naive = R.live.preAlarm.naive;
  assert.ok(naive.autoErr / naive.auto < 0.03);
  assert.ok(naive.byQueue.some(q => q.auto > 50 && q.autoErr / q.auto > 0.03));
});

test('pipeline: sentinel fires after the LVAD faxes begin, not before, and the gate holds them', () => {
  const onset = data.meta.novel_onset;
  assert.ok(R.alarmIndex >= 0);
  assert.ok(R.alarmT >= onset, 'no false alarm before the shift');
  const vad = P.livePreds.filter(p => p.y < 0);
  const before = vad.filter(p => p.t < R.alarmT).length;
  assert.ok(before <= 10, `LVAD faxes before alarm: ${before}`);
  const lam = R.cert.lambdas;
  const slipNoGate = vad.filter(p => p.conf >= lam[p.pred]).length;
  const slipGate = vad.filter(p => p.conf >= lam[p.pred] && !(p.t >= R.alarmT && p.pval <= 0.01)).length;
  assert.ok(slipGate < slipNoGate);
  const vadWords = new Set(['lvad', 'heartmate', 'pump', 'driveline', 'pulsatility', 'rpm', 'lpm', 'mcs']);
  assert.ok(R.unseen.filter(u => vadWords.has(P.D.vocab[u.w])).length >= 2);
});

test('numbers on the page are consistent with each other', () => {
  const all = R.live.certified;
  assert.equal(all.total, P.livePreds.length);
  assert.equal(all.byQueue.reduce((a, q) => a + q.auto, 0), all.auto);
  assert.equal(all.byQueue.reduce((a, q) => a + q.autoErr, 0), all.autoErr);
  const again = evaluate(P.livePreds, P.D.K, R.cert.lambdas);
  assert.equal(again.auto, R.live.certifiedNoGate.auto);
});

test('labelsNeeded returns a sample size that would actually pass the test', () => {
  const k = R.needs.findIndex(n => n);
  if (k < 0) return;
  const n = R.needs[k];
  const res = R.cert.byQueue[k];
  const target = Math.round((res.total + n.more) * n.autonomy);
  assert.ok(binomCdf(Math.floor(n.rate * target), target, 0.03) <= 0.05 + 1e-9);
  assert.ok(labelsNeeded(res, 0.03, 0.05).more === n.more);
});
