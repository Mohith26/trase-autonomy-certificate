import { prepare, analyze } from './core/certify.mjs';

const $ = (id) => document.getElementById(id);
const fmtPct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const fmtInt = (x) => x.toLocaleString('en-US');
const TZ = 'America/New_York';
const fmtDate = (t, o = {}) => new Date(t).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', ...o });
const fmtDT = (t) => new Date(t).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// Stirling-series log-gamma for the weekly re-check tail test
const lgam = (x) => { let r = 0; while (x < 7) { r -= Math.log(x); x++; } const z = 1 / (x * x); return r + (x - 0.5) * Math.log(x) - x + 0.9189385332046727 + (1 / 12 - z * (1 / 360 - z / 1260)) / x; };
const SHORT = { GEN: 'General', REC: 'Records', AUTH: 'Prior auth', LAB: 'Anticoag & labs', IMG: 'Imaging', EP: 'EP', HF: 'HF Clinic', DEV: 'Device', CATH: 'Cath Lab', STRUCT: 'Structural' };
const state = { alpha: 0.03, delta: 0.05, simultaneous: false, sel: null, gateArmed: true };
let P, R;
// optional deep-link state, e.g. ?alpha=0.02&delta=0.01&joint=1&q=CATH&hold=0
const qs = new URLSearchParams(location.search);
if (qs.has('alpha')) state.alpha = +qs.get('alpha');
if (qs.has('delta')) state.delta = +qs.get('delta');
if (qs.get('joint') === '1') state.simultaneous = true;
if (qs.get('hold') === '0') state.gateArmed = false;

function seg(el, opts, key) {
  el.innerHTML = opts.map(([v, l]) => `<button data-v="${v}" class="${state[key] === v ? 'is-on' : ''}">${l}</button>`).join('');
  el.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const raw = b.dataset.v; state[key] = raw === 'true' ? true : raw === 'false' ? false : +raw;
    render();
  };
}

function toast(msg) { const t = $('toast'); t.innerHTML = `<iconify-icon icon="carbon:checkmark" width="14" style="color:#0098a3"></iconify-icon>${msg}`; t.classList.add('is-on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('is-on'), 2600); }

async function boot() {
  const data = await (await fetch('data/faxes.json')).json();
  P = prepare(data);
  render();
  $('exportBtn').onclick = () => toast(`evidence-pack-${new Date(P.live.at(-1).t).toISOString().slice(0, 10)}.zip · certificate + sentinel log · signed · hash chain verified`);
}

function render() {
  R = analyze(P, { alpha: state.alpha, delta: state.delta, simultaneous: state.simultaneous, gateArmed: state.gateArmed });
  const Q = P.D.queues, K = P.D.K;
  seg($('segAlpha'), [[0.01, '1%'], [0.02, '2%'], [0.03, '3%'], [0.05, '5%']], 'alpha');
  seg($('segDelta'), [[0.1, '90%'], [0.05, '95%'], [0.01, '99%']], 'delta');
  seg($('segSim'), [[false, 'Per queue'], [true, 'All queues jointly']], 'simultaneous');
  const calW = P.D.meta.windows.cal;
  $('calInfo').innerHTML = `<b>${fmtInt(P.cal.length)}</b> labeled faxes · ${fmtDate(calW[0])} – ${fmtDate(calW[1] - 864e5)}`;

  const nCert = R.cert.byQueue.filter(q => q.cert).length;
  const live = R.live.certified, naive = R.live.naive;
  const conf = 1 - state.delta;
  $('certState').innerHTML = R.alarmIndex >= 0
    ? `<span class="badge badge--alarm">Partially held</span>`
    : `<span class="badge badge--approved">Certificate valid</span>`;

  // ---------- KPIs ----------
  const breaches = naive.byQueue.map((q, k) => ({ k, q })).filter(({ q }) => q.auto >= 30 && q.autoErr / q.auto > state.alpha);
  const weeks = (P.live.at(-1).t - P.live[0].t) / (7 * 864e5);
  const perWeek = P.live.length / weeks;
  const alarmFax = R.alarmIndex >= 0 ? P.livePreds[R.alarmIndex] : null;
  const vad = P.livePreds.filter(p => p.y < 0);
  const firstNovel = vad.length ? vad[0].t : Infinity;
  const novelBefore = vad.filter(p => p.t < R.alarmT).length;
  const minutesPerFax = 1395 * 60 / 5000; // Duke Cardiology's published baseline: ~1,395 staff hours for ~5,000 faxes a month
  const hoursPerMonth = (live.auto / weeks) * (52 / 12) * minutesPerFax / 60;
  $('kpis').innerHTML = `
    <div class="card kpi"><div class="kpi-l">Certified autonomy</div>
      <div class="kpi-v">${fmtPct(live.auto / live.total)}<small>of live faxes</small></div>
      <div class="kpi-s">auto-routed under a guarantee · <b>≈${fmtInt(Math.round(hoursPerMonth))} staff hrs/mo</b> at Duke's 16.7 min/fax. The global 0.90 rule routes ${fmtPct(naive.auto / naive.total)} with no bound.</div></div>
    <div class="card kpi"><div class="kpi-l">Live error on auto-routed faxes</div>
      <div class="kpi-v">${live.auto ? `<span class="${live.autoErr / live.auto <= state.alpha ? 'up' : 'warn'}">${fmtPct(live.autoErr / live.auto, 2)}</span>` : '<span class="dim">—</span>'}<small>target ≤ ${fmtPct(state.alpha, 0)}</small></div>
      <div class="kpi-s">${fmtInt(live.autoErr)} of ${fmtInt(live.auto)} staff-confirmed, ${fmtDate(P.live[0].t)} – ${fmtDate(P.live.at(-1).t)}. Global 0.90 rule: <b>${fmtPct(naive.autoErr / naive.auto, 2)}</b>, which hides the queue breaches.</div></div>
    <div class="card kpi"><div class="kpi-l">Queues certified</div>
      <div class="kpi-v">${nCert}<small>of ${K} at ${fmtPct(conf, 0)} confidence</small></div>
      <div class="kpi-s">${breaches.length ? `The 0.90 rule breaches ${fmtPct(state.alpha, 0)} in <b class="warn">${breaches.map(({ k, q }) => `${SHORT[Q[k].id]} ${fmtPct(q.autoErr / q.auto)}`).join(', ')}</b>.` : `The 0.90 rule stays under ${fmtPct(state.alpha, 0)} in every queue on this data.`}</div></div>
    <div class="card kpi ${alarmFax ? 'kpi--alarm' : ''}"><div class="kpi-l">Sentinel</div>
      <div class="kpi-v">${alarmFax ? `<span class="warn">Alarm</span><small>${fmtDT(alarmFax.t)}</small>` : `<span class="up">Quiet</span>`}</div>
      <div class="kpi-s">${alarmFax ? `<b>${novelBefore}</b> new-type faxes reached it before the alarm.` : ''} False alarms: on average no sooner than every <b>50,000</b> faxes (≈${Math.round(50000 / perWeek)} weeks here).</div></div>`;

  // ---------- table ----------
  if (state.sel === null) state.sel = Math.max(0, Q.findIndex(q => q.id === (qs.get('q') || 'HF')));
  const dk = R.cert.deltaPerQueue;
  $('tblSub').textContent = `A queue is certified at the most permissive confidence threshold λ for which a fixed-sequence binomial test rejects "error among auto-routed faxes > ${fmtPct(state.alpha, 0)}" at level ${state.simultaneous ? `${state.delta} / ${K} (Bonferroni)` : state.delta}. Live columns are staff-confirmed outcomes.`;
  const rows = R.cert.byQueue.map((r, k) => {
    const lq = live.byQueue[k], nq = naive.byQueue[k];
    const autoShare = lq.total ? lq.auto / lq.total : 0;
    const need = R.needs && R.needs[k];
    const nErr = nq.auto ? nq.autoErr / nq.auto : 0;
    const status = r.cert ? `<span class="badge badge--allow">Certified</span>`
      : `<span class="badge badge--hold" title="${need ? `about ${need.more} more labels` : 'needs a model fix'}">Hold</span>`;
    return `<tr data-k="${k}" class="${k === state.sel ? 'is-sel' : ''}">
      <td class="q-name">${Q[k].name}</td>
      <td>${fmtInt(r.total)}</td>
      <td class="mono">${r.cert ? r.cert.lam.toFixed(3) : '<span class="dim">—</span>'}</td>
      <td><span class="bar"><i style="width:${autoShare * 100}%"></i></span>${fmtPct(autoShare, 0)}</td>
      <td>${r.cert ? fmtPct(r.cert.ucb, 2) : '<span class="dim">—</span>'}</td>
      <td>${lq.auto ? fmtPct(lq.autoErr / lq.auto, 2) : '<span class="dim">—</span>'}</td>
      <td class="${nErr > state.alpha ? 'bad' : ''}">${fmtPct(nErr, 2)}</td>
      <td class="st">${status}</td></tr>`;
  }).join('');
  $('tbl').innerHTML = `<thead><tr><th>Queue</th><th>Cal. faxes</th><th>Threshold λ</th><th>Live autonomy</th><th>Bound (${fmtPct(1 - dk, dk < 0.01 ? 1 : 0)})</th><th>Live error</th><th>0.90 rule</th><th style="text-align:left;padding-left:14px">Status</th></tr></thead><tbody>${rows}</tbody>`;
  $('tbl').onclick = (e) => { const tr = e.target.closest('tr[data-k]'); if (!tr) return; state.sel = +tr.dataset.k; render(); };

  renderCurve();
  renderSentinel(firstNovel);
  renderWhat();
  renderLog();
}

// ---------- risk vs autonomy curve for the selected queue ----------
function renderCurve() {
  const k = state.sel, Q = P.D.queues;
  const r = R.cert.byQueue[k];
  const W = 470, H = 292, m = { l: 40, r: 14, t: 14, b: 32 };
  const pts = r.curve.filter(p => p.n > 0);
  const yMax = Math.max(state.alpha * 2.4, ...pts.filter(p => p.n / r.total > 0.15).map(p => Math.min(p.ucb, 0.2)));
  const xMin = Math.max(0, Math.floor((pts[0].n / r.total) * 10) / 10);
  const x = (a) => m.l + (a - xMin) / (1 - xMin) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - Math.min(v, yMax) / yMax) * (H - m.t - m.b);
  const line = (f) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.n / r.total).toFixed(1)},${y(f(p)).toFixed(1)}`).join('');
  const band = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.n / r.total).toFixed(1)},${y(p.ucb).toFixed(1)}`).join('') + pts.slice().reverse().map(p => `L${x(p.n / r.total).toFixed(1)},${y(p.e / p.n).toFixed(1)}`).join('') + 'Z';
  const ticksY = [0, yMax / 4, yMax / 2, 3 * yMax / 4, yMax];
  const naivePt = r.curve.find(p => Math.abs(p.lam - 0.9) < 1e-9);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img">`;
  for (const t of ticksY) svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" stroke="#ebebeb"/><text class="ax" x="${m.l - 6}" y="${y(t) + 3.5}" text-anchor="end">${(t * 100).toFixed(t * 100 < 10 ? 1 : 0)}%</text>`;
  for (let a = Math.ceil(xMin * 10) / 10; a <= 1.0001; a += xMin >= 0.5 ? 0.1 : 0.2) svg += `<text class="ax" x="${x(a)}" y="${H - 14}" text-anchor="middle">${Math.round(a * 100)}%</text>`;
  svg += `<text class="ax" x="${W - m.r}" y="${H - 1}" text-anchor="end">share of the queue's faxes auto-routed →</text>`;
  svg += `<path d="${band}" fill="#1cdbe9" opacity=".14"/>`;
  svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(state.alpha)}" y2="${y(state.alpha)}" stroke="#fa934e" stroke-dasharray="4 4" stroke-width="1.5"/>`;
  svg += `<text class="ax-mono" x="${m.l + 6}" y="${y(state.alpha) - 5}" style="fill:#b9682f">target ${fmtPct(state.alpha, 0)}</text>`;
  svg += `<path d="${line(p => p.e / p.n)}" fill="none" stroke="#101604" stroke-width="1.3"/>`;
  svg += `<path d="${line(p => p.ucb)}" fill="none" stroke="#0098a3" stroke-width="2"/>`;
  if (naivePt) { const a = naivePt.n / r.total, v = naivePt.e / naivePt.n; svg += `<circle cx="${x(a)}" cy="${y(v)}" r="5" fill="#fff" stroke="#fa934e" stroke-width="2"/><text class="ax-mono" x="${x(a) - 8}" y="${y(v) + 16}" text-anchor="end" style="fill:#b9682f">0.90 rule</text>`; }
  if (r.cert) { const a = r.cert.n / r.total; svg += `<line x1="${x(a)}" x2="${x(a)}" y1="${m.t}" y2="${H - m.b}" stroke="#0098a3" stroke-dasharray="2 3"/><circle cx="${x(a)}" cy="${y(r.cert.ucb)}" r="5" fill="#0098a3" stroke="#fff" stroke-width="2"/><text class="ax-mono" x="${x(a) - 6}" y="${m.t + 10}" text-anchor="end" style="fill:#0098a3">λ ≥ ${r.cert.lam.toFixed(3)}</text>`; }
  svg += `</svg>`;
  $('curve').innerHTML = svg;
  $('curveTitle').textContent = `Risk vs. autonomy · ${Q[k].name}`;
  $('curveSub').textContent = `${fmtInt(r.total)} calibration faxes the agent sent to this queue, swept over confidence thresholds 0.995 → 0.500.`;
  $('curveLegend').innerHTML = `<span><i class="sw" style="background:#101604"></i>observed error</span><span><i class="sw" style="background:#0098a3"></i>upper bound (${fmtPct(1 - (R.cert.deltaPerQueue), 1)})</span><span><i class="sw sw--band" style="background:#1cdbe924"></i>uncertainty from finite labels</span>`;
  // explanation
  const calK = P.calPreds.filter(p => p.pred === k);
  const errs = calK.filter(p => p.pred !== p.y);
  const conf = {}; for (const p of errs) conf[p.y] = (conf[p.y] || 0) + 1;
  const topConf = Object.entries(conf).sort((a, b) => b[1] - a[1])[0];
  const need = R.needs && R.needs[k];
  let note;
  if (r.cert) note = `Auto-route when confidence <b>≥ ${r.cert.lam.toFixed(3)}</b>: that covers ${fmtPct(r.cert.n / r.total, 0)} of calibration faxes, ${r.cert.e} of ${fmtInt(r.cert.n)} were wrong, and with ${fmtPct(1 - R.cert.deltaPerQueue, 1)} confidence the true error is <b>≤ ${fmtPct(r.cert.ucb, 2)}</b>. Everything below λ goes to the intake team.`;
  else if (need) note = `No threshold clears the test yet: the error among confident faxes is ${fmtPct(need.rate, 2)}, but ${fmtInt(r.total)} labels can't prove it is under ${fmtPct(state.alpha, 0)}. About <b>${fmtInt(need.more)} more staff-labeled faxes</b> would certify λ ≥ ${need.lam.toFixed(3)} (${fmtPct(need.autonomy, 0)} autonomy) if the rate holds.`;
  else note = `Even its most confident faxes are wrong too often to certify ${fmtPct(state.alpha, 0)}. ${topConf ? `Most errors are <b>${P.D.queues[topConf[0]].name}</b> faxes that read like ${Q[k].name} (${topConf[1]} of ${errs.length}). ` : ''}More labels won't fix this; the classifier needs examples of the look-alike.`;
  $('curveNote').innerHTML = note;
}

// ---------- sentinel ----------
function renderSentinel(firstNovel) {
  const lp = P.livePreds, n = lp.length;
  const W = 760, H = 430, m = { l: 40, r: 14, t: 16, b: 104 };
  const t0 = lp[0].t, t1 = lp[n - 1].t;
  const x = (t) => m.l + (t - t0) / (t1 - t0) * (W - m.l - m.r);
  const yMaxLog = 6;
  const y = (R) => m.t + (1 - Math.min(Math.log10(Math.max(R, 1)), yMaxLog) / yMaxLog) * (H - m.t - m.b);
  let d = '';
  for (let i = 0; i < n; i += 1) d += `${i ? 'L' : 'M'}${x(lp[i].t).toFixed(1)},${y(R.sr.series[i]).toFixed(1)}`;
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">`;
  for (let e = 0; e <= yMaxLog; e += 2) svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(10 ** e)}" y2="${y(10 ** e)}" stroke="#ebebeb"/><text class="ax" x="${m.l - 6}" y="${y(10 ** e) + 3.5}" text-anchor="end">${e === 0 ? '1' : '10' + ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶'][e]}</text>`;
  // weekly ticks
  for (let t = t0; t <= t1; t += 7 * 864e5) svg += `<text class="ax" x="${x(t)}" y="${H - m.b + 16}" text-anchor="middle">${fmtDate(t)}</text>`;
  svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(50000)}" y2="${y(50000)}" stroke="#fa934e" stroke-dasharray="4 4" stroke-width="1.5"/><text class="ax-mono" x="${m.l + 6}" y="${y(50000) - 5}" style="fill:#b9682f">alarm at 50,000</text>`;
  if (isFinite(firstNovel)) svg += `<line x1="${x(firstNovel)}" x2="${x(firstNovel)}" y1="${m.t}" y2="${H - 8}" stroke="#8a8a8a" stroke-dasharray="2 3"/><text class="ax-mono" x="${x(firstNovel) - 6}" y="${H - m.b - 6}" text-anchor="end">first LVAD fax (ground truth, demo only)</text>`;
  svg += `<path d="${d}" fill="none" stroke="#0098a3" stroke-width="1.4"/>`;
  if (R.alarmIndex >= 0) { const a = lp[R.alarmIndex]; svg += `<circle cx="${x(a.t)}" cy="${y(R.sr.series[R.alarmIndex])}" r="5" fill="#fa934e" stroke="#fff" stroke-width="2"/><text class="ax-mono" x="${x(a.t) + 8}" y="${y(R.sr.series[R.alarmIndex]) + 4}" style="fill:#b9682f">${fmtDT(a.t)}</text>`; }
  // escalation-rate strip: what drift monitoring watches today
  const days = new Map();
  for (const p of lp) { const k = new Date(p.t).toLocaleDateString('en-CA', { timeZone: TZ }); const v = days.get(k) || { t: p.t, n: 0, esc: 0 }; v.n++; if (p.conf < 0.9) v.esc++; days.set(k, v); }
  const sy0 = H - 12, sh = 46;
  const dayW = (W - m.l - m.r) / ((t1 - t0) / 864e5) * 0.7;
  svg += `<text class="ax-mono" x="${m.l}" y="${sy0 - sh - 8}">DAILY ESCALATION RATE · WHAT MONITORING WATCHES TODAY</text><line x1="${m.l}" x2="${W - m.r}" y1="${sy0 - sh}" y2="${sy0 - sh}" stroke="#f5f5f5"/><text class="ax" x="${m.l - 6}" y="${sy0 - sh + 4}" text-anchor="end">25%</text><text class="ax" x="${m.l - 6}" y="${sy0 + 3}" text-anchor="end">0</text>`;
  for (const v of days.values()) { if (v.n < 60) continue; const r = v.esc / v.n; svg += `<rect x="${x(v.t) - dayW / 2}" y="${sy0 - r / 0.25 * sh}" width="${dayW}" height="${r / 0.25 * sh}" fill="#cbcbcb" rx="1"/>`; }
  svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${sy0}" y2="${sy0}" stroke="#ebebeb"/>`;
  svg += `</svg>`;
  $('sentinel').innerHTML = svg;
  const pre = [...days.values()].filter(v => v.n >= 60 && v.t < firstNovel), post = [...days.values()].filter(v => v.n >= 60 && v.t >= firstNovel);
  const avg = (a) => a.reduce((s, v) => s + v.esc / v.n, 0) / a.length;
  $('sentLegend').innerHTML = `<span><i class="sw" style="background:#0098a3"></i>Shiryaev–Roberts statistic on online conformal p-values (log scale)</span><span><i class="sw sw--band" style="background:#cbcbcb"></i>daily escalation rate: ${fmtPct(avg(pre))} before vs ${fmtPct(avg(post))} after the LVAD faxes began</span>`;
  $('sentState').innerHTML = R.alarmIndex >= 0 ? `<span class="badge badge--alarm">Alarm</span>` : `<span class="badge badge--allow">Quiet</span>`;
}

// ---------- what changed ----------
function renderWhat() {
  const Q = P.D.queues, V = P.D.vocab;
  if (R.alarmIndex < 0) { $('what').innerHTML = `<p class="note">No alarm at these settings.</p>`; $('whatSub').textContent = ''; return; }
  const f = R.flagged;
  $('whatSub').textContent = `${fmtInt(f.length)} faxes since the alarm have conformal p ≤ 0.01: unlike anything in the calibration set.`;
  const lam = R.cert.lambdas;
  const vad = P.livePreds.filter(p => p.y < 0);
  const slipNoGate = vad.filter(p => p.conf >= lam[p.pred]);
  const slipGate = vad.filter(p => p.conf >= lam[p.pred] && !(p.t >= R.alarmT && p.pval <= 0.01));
  const extra = f.filter(p => p.y >= 0).length;
  const prevented = slipNoGate.length - slipGate.length;
  const byQ = {}; for (const p of f) (byQ[p.pred] ??= []).push(p);
  const routes = Object.entries(byQ).sort((a, b) => b[1].length - a[1].length).slice(0, 3);
  const sample = f.find(p => p.y < 0) || f[0];
  const words = sample.d.toks.slice(0, 26).map(w => P.model.seen[w] ? V[w] : `<b>${V[w]}</b>`).join(' ');
  $('what').innerHTML = `
    <div class="impact">
      <div class="imp imp--good"><div class="imp-v">${state.gateArmed ? prevented : 0}</div><div class="imp-l">wrong-queue auto-routes held${state.gateArmed ? '' : ' (hold is off)'}</div></div>
      <div class="imp"><div class="imp-v">${extra}</div><div class="imp-l">extra escalations of known fax types</div></div>
      <div class="imp imp--bad"><div class="imp-v">${state.gateArmed ? slipGate.length : slipNoGate.length}</div><div class="imp-l">LVAD faxes still auto-routed${state.gateArmed ? ' (before the alarm)' : ''}</div></div>
    </div>
    <div class="what-sec"><div class="what-lab">Never seen in ${fmtInt(P.train.length)} historical faxes</div>
      <div class="terms">${R.unseen.slice(0, 8).map(u => `<span class="term term--new">${V[u.w]}<b>${u.docs}</b></span>`).join('')}</div></div>
    <div class="what-sec"><div class="what-lab">Over-represented vs. calibration (log-odds z)</div>
      <div class="terms">${R.terms.slice(0, 6).map(t => `<span class="term">${V[t.w]}<b>${t.z.toFixed(1)}</b></span>`).join('')}</div></div>
    <div class="what-sec"><div class="what-lab">Where the agent was sending them</div>
      ${routes.map(([k, a]) => `<div class="route-row"><span class="rn">${Q[k].name}</span><span class="rb"><i style="width:${a.length / f.length * 100}%"></i></span><span class="rv">${a.length} · ${(a.reduce((s, p) => s + p.conf, 0) / a.length).toFixed(2)}</span></div>`).join('')}
    </div>
    <div class="what-sec"><div class="what-lab">Sample flagged fax (OCR tokens) · ${sample.d.sender}</div><div class="fax-sample">${words} …</div></div>
    <div class="what-actions">
      <button class="pill pill--sm" id="holdBtn">${state.gateArmed ? 'Release hold' : 'Hold novel cluster'}</button>
      <button class="pill pill--ghost pill--sm" id="queueBtn">Propose queue: ${P.D.novel.name}</button>
    </div>`;
  $('holdBtn').onclick = () => { state.gateArmed = !state.gateArmed; render(); };
  $('queueBtn').onclick = () => toast(`Draft queue "${P.D.novel.name}" sent to Approvals · needs ${R.cert.byQueue[0].minN}+ labeled faxes to certify`);
}

// ---------- audit-style event log ----------
function renderLog() {
  const Q = P.D.queues, K = P.D.K;
  const rows = [];
  const cal1 = P.D.meta.windows.cal[1];
  const nCert = R.cert.byQueue.filter(q => q.cert).length;
  if (R.alarmIndex >= 0) {
    const a = P.livePreds[R.alarmIndex];
    rows.push({ cls: 'is-hold', badge: state.gateArmed ? ['hold', 'Hold'] : ['alarm', 'Alarm'], title: `Fax Routing Agent · route.auto ${state.gateArmed ? 'held for novel cluster' : 'alarm raised, hold released by user'}`, sub: `sentinel crossed 50,000 at live fax ${fmtInt(R.alarmIndex + 1)} · ${fmtInt(R.flagged.length)} faxes with p ≤ 0.01 sent to the intake team since`, t: a.t });
  }
  // weekly re-checks against staff-confirmed outcomes
  const lp = P.livePreds;
  const t0 = lp[0].t;
  const rechecks = [];
  for (let w = 5; w >= 0; w--) {
    const a = t0 + w * 7 * 864e5, b = a + 7 * 864e5;
    const wk = lp.filter(p => p.t >= a && p.t < b);
    if (!wk.length) continue;
    let auto = 0, err = 0, worst = null;
    for (let k = 0; k < K; k++) {
      const qa = wk.filter(p => p.pred === k && p.conf >= R.cert.lambdas[k] && !(state.gateArmed && p.t >= R.alarmT && p.pval <= 0.01));
      const qe = qa.filter(p => p.pred !== p.y).length;
      auto += qa.length; err += qe;
      if (qa.length >= 30 && (!worst || qe / qa.length > worst.r)) worst = { k, r: qe / qa.length, n: qa.length, e: qe };
    }
    if (!auto) continue;
    // flag a queue only when the week's errors are significant evidence it exceeds the target (one-sided binomial, 5%)
    const tail = (e, n, p) => { let c = 0; for (let i = 0; i < e; i++) c += Math.exp(lgam(n + 1) - lgam(i + 1) - lgam(n - i + 1) + i * Math.log(p) + (n - i) * Math.log1p(-p)); return 1 - c; };
    const ok = err / auto <= state.alpha && !(worst && tail(worst.e, worst.n, state.alpha) < 0.05);
    rechecks.push({ badge: ok ? ['allow', 'Allow'] : ['hold', 'Review'], title: `Certificate re-check · week of ${fmtDate(a)}`, sub: `${fmtInt(err)} of ${fmtInt(auto)} auto-routed faxes corrected by staff (${fmtPct(err / auto, 2)})${worst ? ` · highest queue: ${Q[worst.k].name} ${worst.e}/${worst.n} (${fmtPct(worst.r, 1)})` : ''}`, t: Math.min(b, lp.at(-1).t + 3600e3) + 3600e3 * 7 });
  }
  rows.push(...rechecks.slice(0, 3));
  rows.push({ cls: 'is-ok', badge: ['approved', 'Approved'], title: `Autonomy certificate v3 · ${nCert} of ${K} queues at ≤ ${fmtPct(state.alpha, 0)} error`, sub: `approved by Dr. A. Reyes · calibrated on ${fmtInt(P.cal.length)} staff-labeled faxes, ${(1 - state.delta) * 100}% confidence ${state.simultaneous ? '(all queues jointly)' : '(per queue)'}`, t: cal1 + 3600e3 * 15 });
  const nEvents = P.livePreds.length + P.cal.length;
  $('log').innerHTML = `<div class="log-status"><span class="chain"><span class="dot"></span>hash chain intact</span><span><strong>${fmtInt(nEvents)}</strong> routing decisions behind this certificate in the tamper-evident log</span></div>` + rows.map(r => `<div class="row-box ${r.cls || ''}"><span class="badge badge--${r.badge[0]}">${r.badge[1]}</span><span class="row-main"><span class="row-title">${r.title}</span><span class="row-sub">${r.sub}</span></span><span class="row-time">${fmtDT(r.t)}</span></div>`).join('');
}

boot().catch(err => { console.error(err); document.getElementById('content').insertAdjacentHTML('afterbegin', `<div class="card loading">Could not load data: ${err.message}</div>`); });
