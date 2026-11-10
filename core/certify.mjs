// Autonomy Certificate core: routing model (softmax regression), per-queue risk-controlled escalation thresholds
// (Learn-then-Test with exact binomial tests), and an exchangeability sentinel
// (online conformal p-values + Shiryaev-Roberts procedure) with term-enrichment for the novel cluster.
// Pure ES module, no dependencies; runs in the browser and under `node --test`.

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- data ----------
export function decode(data) {
  const qIndex = Object.fromEntries(data.queues.map((q, i) => [q.id, i]));
  const docs = data.docs.map(([id, s, t, label, sender, pages, enc]) => ({
    id, split: s === 't' ? 'train' : s === 'c' ? 'cal' : 'live', t, label,
    y: label in qIndex ? qIndex[label] : -1, // -1 = a type with no queue in the model (must go to a human)
    sender: data.senders[sender], pages,
    toks: enc.split(' ').map(x => parseInt(x, 36)),
  }));
  return { docs, K: data.queues.length, V: data.vocab.length, queues: data.queues, vocab: data.vocab, meta: data.meta, novel: data.novel };
}

// ---------- routing model: L2-regularised softmax regression on log-tf features ----------
// (stands in for the agent's classification micro-agent; any model that emits a confidence works)
export function features(model, toks) {
  const tf = new Map();
  for (const w of toks) if (model.seen[w]) tf.set(w, (tf.get(w) || 0) + 1);
  let norm = 0; const out = [];
  for (const [w, c] of tf) { const v = 1 + Math.log(c); out.push([w, v]); norm += v * v; }
  norm = Math.sqrt(norm) || 1;
  return out.map(([w, v]) => [w, v / norm]);
}
export function trainSoftmax(docs, K, V, { epochs = 40, lr = 0.5, l2 = 1e-4, seed = 11 } = {}) {
  const seen = new Uint8Array(V);
  for (const d of docs) for (const w of d.toks) seen[w] = 1;   // words never seen in history carry no evidence
  const model = { K, V, seen, W: Array.from({ length: K }, () => new Float64Array(V)), b: new Float64Array(K), T: 1 };
  const rows = docs.filter(d => d.y >= 0).map(d => ({ x: features(model, d.toks), y: d.y }));
  const rng = mulberry32(seed);
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
    const eta = lr / (1 + ep * 0.1);
    for (const { x, y } of rows) {
      const s = scores(model, x);
      const p = softmax(s, 1);
      for (let k = 0; k < K; k++) {
        const g = p[k] - (k === y ? 1 : 0);
        model.b[k] -= eta * g;
        const Wk = model.W[k];
        for (const [w, v] of x) Wk[w] -= eta * (g * v + l2 * Wk[w]);
      }
    }
  }
  return model;
}
function scores(model, x) {
  const s = Array.from(model.b);
  for (let k = 0; k < model.K; k++) { const Wk = model.W[k]; for (const [w, v] of x) s[k] += Wk[w] * v; }
  return s;
}
export function logits(model, toks) { return scores(model, features(model, toks)); }

export function softmax(s, T = 1) {
  const m = Math.max(...s);
  const e = s.map(x => Math.exp((x - m) / T));
  const z = e.reduce((a, b) => a + b, 0);
  return e.map(x => x / z);
}

export function fitTemperature(model, docs) {
  const rows = docs.filter(d => d.y >= 0).map(d => [logits(model, d.toks), d.y]);
  let best = { T: 1, nll: Infinity };
  for (let T = 0.3; T <= 4; T += 0.05) {
    let nll = 0;
    for (const [s, y] of rows) nll -= Math.log(Math.max(1e-12, softmax(s, T)[y]));
    if (nll < best.nll) best = { T: +T.toFixed(2), nll };
  }
  return best.T;
}

export function buildModel(train, K, V) {
  // temperature fitted on a held-out 20% of the history, then the model is refit on all of it
  const cut = Math.floor(train.length * 0.8);
  const m0 = trainSoftmax(train.slice(0, cut), K, V);
  const T = fitTemperature(m0, train.slice(cut));
  const model = trainSoftmax(train, K, V);
  model.T = T;
  return model;
}

export function predict(model, d) {
  const p = softmax(logits(model, d.toks), model.T);
  let k = 0;
  for (let j = 1; j < p.length; j++) if (p[j] > p[k]) k = j;
  return { pred: k, conf: p[k], probs: p };
}

// ---------- exact binomial machinery ----------
function logGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
const logChoose = (n, k) => logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
export function binomCdf(e, n, p) {
  if (e >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return e >= n ? 1 : 0;
  let s = 0;
  for (let i = 0; i <= e; i++) s += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log1p(-p));
  return Math.min(1, s);
}
// one-sided Clopper-Pearson upper bound: largest p with P(Bin(n,p) <= e) >= delta
export function cpUpper(e, n, delta) {
  if (n === 0) return 1;
  if (e >= n) return 1;
  let lo = e / n, hi = 1;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (binomCdf(e, n, mid) > delta) lo = mid; else hi = mid;
  }
  return hi;
}

// ---------- Learn-then-Test threshold (fixed-sequence testing from the strictest threshold down) ----------
// items: [{conf, err}] for faxes the model would send to one queue (or all queues for a global certificate).
// Controls P( P(error | routed here, conf >= lambda) > alpha ) <= delta.
export const GRID = Array.from({ length: 100 }, (_, i) => +(0.995 - i * 0.005).toFixed(3)); // 0.995 .. 0.500
export function lttThreshold(items, alpha, delta, grid = GRID) {
  const sorted = items.slice().sort((a, b) => b.conf - a.conf);
  let j = 0, n = 0, e = 0;
  const curve = [];
  let cert = null, stopped = false;
  // smallest number of clean calibration faxes that could ever certify alpha at this delta.
  // The sequence starts at the strictest threshold that has at least minN faxes above it; that start
  // depends only on the (unlabeled) confidences, so the fixed-sequence guarantee is unaffected.
  const minN = Math.ceil(Math.log(delta) / Math.log1p(-alpha));
  for (const lam of grid) {
    while (j < sorted.length && sorted[j].conf >= lam) { n++; e += sorted[j].err ? 1 : 0; j++; }
    const pval = n === 0 ? 1 : binomCdf(e, n, alpha);
    const ucb = cpUpper(e, n, delta);
    curve.push({ lam, n, e, pval, ucb });
    if (!stopped && n >= minN) {
      if (pval <= delta) cert = { lam, n, e, ucb, pval };
      else stopped = true; // fixed sequence: the first non-rejection ends the search
    }
  }
  return { cert, curve, total: items.length, minN };
}

export function certify(calPreds, K, { alpha, delta, perQueue = true, simultaneous = true }) {
  if (!perQueue) {
    const r = lttThreshold(calPreds.map(p => ({ conf: p.conf, err: p.pred !== p.y })), alpha, delta);
    return { mode: 'global', global: r, lambdas: Array(K).fill(r.cert ? r.cert.lam : Infinity), byQueue: null };
  }
  // simultaneous: Bonferroni, all K queue certificates hold together with prob >= 1 - delta;
  // otherwise each queue's certificate holds with prob >= 1 - delta on its own.
  const dk = simultaneous ? delta / K : delta;
  const byQueue = [];
  for (let k = 0; k < K; k++) {
    const items = calPreds.filter(p => p.pred === k).map(p => ({ conf: p.conf, err: p.pred !== p.y }));
    byQueue.push(lttThreshold(items, alpha, dk));
  }
  return { mode: 'queue', byQueue, lambdas: byQueue.map(r => (r.cert ? r.cert.lam : Infinity)), deltaPerQueue: dk };
}

// policy: auto-route when conf >= lambdas[pred] (and the novelty gate, if armed, does not hold it)
export function evaluate(preds, K, lambdas, gate = null) {
  const q = Array.from({ length: K }, () => ({ total: 0, auto: 0, autoErr: 0 }));
  let total = 0, auto = 0, autoErr = 0, held = 0;
  for (const p of preds) {
    const s = q[p.pred]; s.total++; total++;
    const gated = gate ? gate(p) : false;
    if (gated) held++;
    if (!gated && p.conf >= lambdas[p.pred]) {
      s.auto++; auto++;
      if (p.pred !== p.y) { s.autoErr++; autoErr++; }
    }
  }
  return { byQueue: q, total, auto, autoErr, held };
}

// ---------- novelty: kNN cosine on tf-idf against the training history ----------
export function buildIndex(train, V) {
  const df = new Float64Array(V);
  for (const d of train) for (const w of new Set(d.toks)) df[w]++;
  const N = train.length;
  const idfKnown = new Float64Array(V);
  for (let w = 0; w < V; w++) idfKnown[w] = Math.log((N + 1) / (df[w] + 1)) + 1;
  const vec = (toks) => {
    const tf = new Map();
    for (const w of toks) tf.set(w, (tf.get(w) || 0) + 1);
    let norm = 0;
    const out = [];
    for (const [w, c] of tf) { const v = (1 + Math.log(c)) * idfKnown[w]; out.push([w, v]); norm += v * v; }
    norm = Math.sqrt(norm) || 1;
    return out.map(([w, v]) => [w, v / norm]);
  };
  const postings = Array.from({ length: V }, () => []);
  train.forEach((d, i) => { for (const [w, v] of vec(d.toks)) postings[w].push([i, v]); });
  return { vec, postings, N };
}
// nonconformity = 1 - mean cosine similarity of the k nearest historical faxes
export function knnScore(index, toks, k = 10, excludeId = -1) {
  const acc = new Float64Array(index.N);
  for (const [w, v] of index.vec(toks)) for (const [i, u] of index.postings[w]) acc[i] += v * u;
  if (excludeId >= 0) acc[excludeId] = -1;
  // partial top-k
  const top = new Float64Array(k).fill(-1);
  for (let i = 0; i < acc.length; i++) {
    const a = acc[i];
    if (a > top[k - 1]) { let j = k - 1; while (j > 0 && top[j - 1] < a) { top[j] = top[j - 1]; j--; } top[j] = a; }
  }
  let s = 0; for (const a of top) s += Math.max(0, a);
  return 1 - s / k;
}

// online smoothed conformal p-values: each live score is ranked against calibration + all earlier live scores.
// Under exchangeability these p-values are independent Uniform(0,1) (Vovk et al.).
export function onlinePvalues(calScores, liveScores, rng) {
  const bag = calScores.slice().sort((a, b) => a - b);
  const insert = (x) => { let lo = 0, hi = bag.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bag[m] < x) lo = m + 1; else hi = m; } bag.splice(lo, 0, x); };
  const countGreater = (x) => { let lo = 0, hi = bag.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bag[m] <= x) lo = m + 1; else hi = m; } return bag.length - lo; };
  const countEqual = (x) => { let lo = 0, hi = bag.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bag[m] < x) lo = m + 1; else hi = m; } let c = 0; while (lo + c < bag.length && bag[lo + c] === x) c++; return c; };
  const out = [];
  for (const a of liveScores) {
    insert(a);
    const n = bag.length;
    out.push((countGreater(a) + rng() * countEqual(a)) / n);
  }
  return out;
}

// tail-betting calibrator: f(p) = 1 - w + (w/c) 1[p <= c]; integrates to 1 over Uniform(0,1)
export const calibrator = (p, c, w) => 1 - w + (p <= c ? w / c : 0);

// Shiryaev-Roberts change detector on conformal p-values. Under exchangeability E[R_n] = n,
// so the expected number of faxes before a false alarm at threshold A is at least A.
export function shiryaevRoberts(pvals, { c = 0.01, w = 0.05, A = 50000 } = {}) {
  let R = 0, alarm = -1;
  const series = new Float64Array(pvals.length);
  for (let i = 0; i < pvals.length; i++) {
    R = (1 + R) * calibrator(pvals[i], c, w);
    series[i] = R;
    if (alarm < 0 && R >= A) alarm = i;
  }
  return { series, alarm };
}

// ---------- what is new: log-odds with an informative Dirichlet prior (Monroe, Colaresi & Quinn 2008) ----------
export function enrichedTerms(groupDocs, refDocs, V, top = 8) {
  const a = new Float64Array(V), b = new Float64Array(V);
  for (const d of groupDocs) for (const w of d.toks) a[w]++;
  for (const d of refDocs) for (const w of d.toks) b[w]++;
  const na = a.reduce((x, y) => x + y, 0), nb = b.reduce((x, y) => x + y, 0);
  const prior = new Float64Array(V); let a0 = 0;
  for (let w = 0; w < V; w++) { prior[w] = 0.01 * (a[w] + b[w]) + 0.01; a0 += prior[w]; }
  const res = [];
  for (let w = 0; w < V; w++) {
    if (a[w] < 3) continue;
    const la = Math.log((a[w] + prior[w]) / (na + a0 - a[w] - prior[w]));
    const lb = Math.log((b[w] + prior[w]) / (nb + a0 - b[w] - prior[w]));
    const varr = 1 / (a[w] + prior[w]) + 1 / (b[w] + prior[w]);
    res.push({ w, z: (la - lb) / Math.sqrt(varr), inGroup: a[w], inRef: b[w] });
  }
  return res.sort((x, y) => y.z - x.z).slice(0, top);
}

// words in the flagged faxes that never appeared anywhere in the training history
export function unseenTerms(groupDocs, seen, top = 8) {
  const c = new Map();
  for (const d of groupDocs) for (const w of new Set(d.toks)) if (!seen[w]) c.set(w, (c.get(w) || 0) + 1);
  return [...c.entries()].map(([w, n]) => ({ w, docs: n })).sort((a, b) => b.docs - a.docs).slice(0, top);
}

// For a queue without a certificate: how many more audited faxes would certify alpha, if the error rate
// among faxes above lambda stayed what it is today? Picks the lambda that needs the fewest new labels.
export function labelsNeeded(result, alpha, delta) {
  let best = null;
  const total = result.total;
  for (const pt of result.curve) {
    if (pt.n < 20) continue;
    const rate = pt.e / pt.n;
    if (rate >= alpha * 0.85) continue;
    const frac = pt.n / total;
    let n = pt.n;
    while (n < 20000 && binomCdf(Math.floor(rate * n), n, alpha) > delta) n += 10;
    if (n >= 20000) continue;
    const more = Math.max(0, Math.ceil(n / frac) - total);
    if (!best || more < best.more) best = { lam: pt.lam, more, autonomy: frac, rate };
  }
  return best; // null = today's error rate is too close to alpha for any amount of labels to help
}

// ---------- full pipeline ----------
export function prepare(data, { seed = 7 } = {}) {
  const D = decode(data);
  const train = D.docs.filter(d => d.split === 'train');
  const cal = D.docs.filter(d => d.split === 'cal');
  const live = D.docs.filter(d => d.split === 'live');
  const model = buildModel(train, D.K, D.V);
  const withPred = (d) => ({ ...predict(model, d), y: d.y, id: d.id, t: d.t, d });
  const calPreds = cal.map(withPred);
  const livePreds = live.map(withPred);
  const index = buildIndex(train, D.V);
  const calScores = cal.map(d => knnScore(index, d.toks));
  const liveScores = live.map(d => knnScore(index, d.toks));
  const pvals = onlinePvalues(calScores, liveScores, mulberry32(seed));
  livePreds.forEach((p, i) => { p.novelty = liveScores[i]; p.pval = pvals[i]; });
  return { D, train, cal, live, model, calPreds, livePreds, calScores };
}

export function analyze(P, { alpha = 0.03, delta = 0.05, perQueue = true, simultaneous = false, naive = 0.9, c = 0.01, w = 0.05, A = 50000, gateArmed = true } = {}) {
  const { D, calPreds, livePreds, cal } = P;
  const K = D.K;
  const cert = certify(calPreds, K, { alpha, delta, perQueue, simultaneous });
  const sr = shiryaevRoberts(livePreds.map(p => p.pval), { c, w, A });
  const alarmT = sr.alarm >= 0 ? livePreds[sr.alarm].t : Infinity;
  const gate = gateArmed && sr.alarm >= 0 ? (p) => p.t >= alarmT && p.pval <= c : null;
  const naiveL = Array(K).fill(naive);
  const pre = livePreds.filter(p => p.t < alarmT);
  const post = livePreds.filter(p => p.t >= alarmT);
  const flagged = post.filter(p => p.pval <= c);
  const terms = enrichedTerms(flagged.map(p => p.d), cal, D.V);
  const unseen = unseenTerms(flagged.map(p => p.d), P.model.seen);
  const dk = cert.mode === 'queue' ? cert.deltaPerQueue : delta;
  const needs = cert.mode === 'queue' ? cert.byQueue.map(r => (r.cert ? null : labelsNeeded(r, alpha, dk))) : null;
  return {
    cert, sr, alarmIndex: sr.alarm, alarmT,
    calAccuracy: calPreds.filter(p => p.pred === p.y).length / calPreds.length,
    live: {
      certified: evaluate(livePreds, K, cert.lambdas, gate),
      certifiedNoGate: evaluate(livePreds, K, cert.lambdas, null),
      naive: evaluate(livePreds, K, naiveL, null),
      preAlarm: { certified: evaluate(pre, K, cert.lambdas), naive: evaluate(pre, K, naiveL) },
      postAlarm: { certified: evaluate(post, K, cert.lambdas, gate), noGate: evaluate(post, K, cert.lambdas, null) },
    },
    flagged, terms, unseen, needs,
  };
}
