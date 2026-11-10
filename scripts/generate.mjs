// Seeded synthetic generator for an inbound cardiology fax stream.
// node scripts/generate.mjs  ->  data/faxes.json
// Everything downstream (model, certificates, sentinel) is computed from this file.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED = 20260427;
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const randint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
function pickWeighted(items, weights) {
  const s = weights.reduce((a, b) => a + b, 0);
  let u = rnd() * s;
  for (let i = 0; i < items.length; i++) { u -= weights[i]; if (u <= 0) return items[i]; }
  return items[items.length - 1];
}

// Destination queues the agent routes to (ids are stable keys used by the app).
export const QUEUES = [
  { id: 'GEN', name: 'General Cardiology', share: 0.21 },
  { id: 'REC', name: 'Medical Records', share: 0.14 },
  { id: 'AUTH', name: 'Prior Authorization', share: 0.12 },
  { id: 'LAB', name: 'Anticoagulation & Labs', share: 0.12 },
  { id: 'IMG', name: 'Cardiac Imaging', share: 0.10 },
  { id: 'EP', name: 'Electrophysiology', share: 0.09 },
  { id: 'HF', name: 'Heart Failure Clinic', share: 0.08 },
  { id: 'DEV', name: 'Device Clinic', share: 0.06 },
  { id: 'CATH', name: 'Interventional / Cath Lab', share: 0.05 },
  { id: 'STRUCT', name: 'Structural Heart', share: 0.03 },
];
// A fax type the agent has never seen: mechanical circulatory support (LVAD) coordinator faxes.
export const NOVEL = { id: 'VAD', name: 'LVAD / MCS Coordinator' };

const SIG = {
  GEN: 'referral new patient consult chest pain palpitations murmur dyspnea exertion hypertension syncope evaluate establish care pcp family medicine internal medicine r07 9 r00 2 abnormal ekg',
  REC: 'records request release information authorization hipaa roi copies medical records subpoena attorney law office disability claim chart copies office notes please send all records',
  AUTH: 'prior authorization insurance determination approved denied pending member id payer cpt 93306 78452 utilization review peer to peer appeal coverage aetna humana bcbs medicare advantage reference number',
  LAB: 'inr warfarin coumadin dose lab result anticoagulation clinic pt inr 2 4 lipid panel ldl potassium creatinine bmp cbc hemoglobin draw date result value range dosing adjust',
  IMG: 'echocardiogram tte tee nuclear stress test spect cardiac mri ct angiography calcium score ejection fraction imaging order schedule study protocol contrast',
  EP: 'atrial fibrillation afib flutter ablation holter monitor zio patch qtc svt wpw cha2ds2 vasc rate control rhythm cardioversion i48 91 electrophysiology',
  HF: 'heart failure hfref hfpef nyha class bnp nt probnp diuretic furosemide gdmt sacubitril valsartan entresto spironolactone volume overload edema weight gain i50',
  DEV: 'pacemaker icd crt remote interrogation transmission medtronic boston scientific abbott battery longevity lead impedance pacing percent shock episode device check',
  CATH: 'cardiac catheterization pci stent stenosis lad rca circumflex troponin stemi nstemi angiogram cath lab dual antiplatelet clopidogrel ticagrelor femoral radial access',
  STRUCT: 'aortic stenosis tavr tavi valve area gradient mitral regurgitation mitraclip sts score heart team valve clinic structural surgical risk annulus',
  VAD: 'lvad heartmate 3 pump speed rpm flow lpm pulsatility index pi power watts driveline exit site vad coordinator controller alarm low flow event ldh hemolysis suction mcs',
};
// Words that legitimately overlap with known queues (makes novel faxes look familiar to the model).
const VAD_OVERLAP = 'heart failure heart failure nyha class bnp diuretic furosemide edema inr warfarin battery device check transmission abbott remote'.split(' ');
const SHARED = 'patient dob mrn fax pages cover sheet from to attn cardiology dept please thank you dr md np pa clinic date phone confidential notice intended recipient re regarding see attached signed office hospital health system urgent routine follow up visit note history medications allergies'.split(' ');
const CONFUSE = {
  GEN: ['HF', 'EP', 'IMG'], REC: ['AUTH'], AUTH: ['IMG', 'REC'], LAB: ['HF', 'EP'], IMG: ['STRUCT', 'AUTH', 'GEN'],
  EP: ['DEV', 'GEN'], HF: ['GEN', 'LAB', 'DEV'], DEV: ['EP', 'HF'], CATH: ['STRUCT', 'IMG'], STRUCT: ['CATH', 'IMG'],
};
const HARD = { GEN: 0.08, REC: 0.04, AUTH: 0.06, LAB: 0.04, IMG: 0.14, EP: 0.14, HF: 0.08, DEV: 0.14, CATH: 0.14, STRUCT: 0.28 };
const SENDERS = ['Lakeside Family Medicine', 'Piedmont Internal Medicine', 'Carolina Urgent Care', 'Blue Ridge Health Plan', 'Mercy Regional Hospital', 'Hollis & Grant LLP', 'Quest Diagnostics', 'LabCorp', 'Medtronic CareLink', 'Abbott Merlin.net', 'Westfield Cardiology Associates', 'Triad Imaging Center', 'Humana Clinical Review', 'Aetna Precertification', 'Social Security Disability', 'Northside Hospice', 'Eastgate Pediatrics', 'Riverside ED'];
const VAD_SENDERS = ['VAD Coordinator, Mercy Regional', 'HeartMate Field Clinical Support', 'Home Health of the Triad', 'Westfield Advanced HF Program'];

const sigTok = Object.fromEntries(Object.entries(SIG).map(([k, v]) => [k, v.split(' ')]));

// Systematic look-alikes: faxes that belong to one queue but are written almost entirely in another queue's language
// (a pre-TAVR workup that is mostly a cath report; an AF episode alert that arrives as a device transmission).
const LOOKALIKE = { STRUCT: ['CATH', 0.12], DEV: ['EP', 0.07] };
function makeDoc(cls) {
  const n = randint(20, 46);
  const out = [];
  if (LOOKALIKE[cls] && rnd() < LOOKALIKE[cls][1]) {
    const other = LOOKALIKE[cls][0];
    for (let i = 0; i < n; i++) { const u = rnd(); out.push(u < 0.05 ? pick(sigTok[cls]) : u < 0.45 ? pick(sigTok[other]) : pick(SHARED)); }
    return out;
  }
  const coverOnly = rnd() < 0.025;                           // mostly cover sheet, little signal
  const pSig = coverOnly ? 0.06 : 0.25 + 0.35 * rnd();       // strength of class signal varies per fax
  const conf = cls === 'VAD' ? null : pick(CONFUSE[cls]);
  const hard = HARD[cls] ?? 0.1;                              // how often this queue's faxes read like a neighbour's
  const pConf = cls === 'VAD' ? 0 : (rnd() < hard ? 0.10 + 0.25 * rnd() : 0.03 * rnd());
  const pOverlap = cls === 'VAD' ? 0.34 + 0.16 * rnd() : 0;
  for (let i = 0; i < n; i++) {
    const u = rnd();
    if (u < pSig) out.push(pick(sigTok[cls]));
    else if (u < pSig + pConf) out.push(pick(sigTok[conf]));
    else if (u < pSig + pConf + pOverlap) out.push(pick(VAD_OVERLAP));
    else out.push(pick(SHARED));
  }
  return out;
}

const DAY = 86400000;
const ET = 4 * 3600000; // all windows are local (EDT) midnights; timestamps are UTC ms
const t0Train = Date.UTC(2026, 0, 5) + ET, t1Train = Date.UTC(2026, 3, 4) + ET;     // Jan 5 - Apr 3: training history
const t0Cal = Date.UTC(2026, 3, 6) + ET, t1Cal = Date.UTC(2026, 3, 25) + ET;       // Apr 6 - Apr 25: hand-labeled validation window
const t0Live = Date.UTC(2026, 3, 27) + ET, t1Live = Date.UTC(2026, 5, 6) + ET;     // Apr 27 - Jun 6: production
const tNovel = Date.UTC(2026, 4, 26, 9) + ET;                               // May 26: LVAD program faxes begin

const docs = [];
function emit(split, count, tA, tB, novelShareAfter = 0) {
  for (let i = 0; i < count; i++) {
    // weekday-heavy arrival times
    let t;
    do { t = tA + rnd() * (tB - tA); } while ([0, 6].includes(new Date(t - ET).getUTCDay()) && rnd() < 0.85);
    let cls = pickWeighted(QUEUES.map(q => q.id), QUEUES.map(q => q.share));
    if (novelShareAfter && t >= tNovel && rnd() < novelShareAfter) cls = 'VAD';
    let label = cls;
    if (cls !== 'VAD' && rnd() < 0.001) label = pick(QUEUES).id;   // rare ground-truth ambiguity / mislabel
    const toks = makeDoc(cls);
    const sender = cls === 'VAD' ? pick(VAD_SENDERS) : pick(SENDERS);
    docs.push({ split, t: Math.round(t), label, sender, pages: randint(1, cls === 'REC' ? 14 : 6), toks });
  }
}
emit('train', 3600, t0Train, t1Train);
emit('cal', 4200, t0Cal, t1Cal);
emit('live', 6200, t0Live, t1Live, 0.05);
docs.sort((a, b) => a.t - b.t);

// compact encoding: shared vocabulary + base-36 token indices
const vocab = [];
const vIndex = new Map();
for (const d of docs) for (const w of d.toks) if (!vIndex.has(w)) { vIndex.set(w, vocab.length); vocab.push(w); }
const senders = [...new Set(docs.map(d => d.sender))];
const out = {
  meta: {
    seed: SEED,
    org: 'Riverside Health · Division of Cardiology (fictional)',
    generated_by: 'scripts/generate.mjs',
    windows: { train: [t0Train, t1Train], cal: [t0Cal, t1Cal], live: [t0Live, t1Live] },
    novel_onset: tNovel, // used only by tests and the "ground truth" marker, never by the algorithms
  },
  queues: QUEUES.map(({ id, name }) => ({ id, name })),
  novel: NOVEL,
  vocab,
  senders,
  docs: docs.map((d, i) => [i, d.split[0], d.t, d.label, senders.indexOf(d.sender), d.pages, d.toks.map(w => vIndex.get(w).toString(36)).join(' ')]),
};
const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, '..', 'data'), { recursive: true });
writeFileSync(join(here, '..', 'data', 'faxes.json'), JSON.stringify(out));
const counts = {};
for (const d of docs) counts[d.split + ':' + (d.label === 'VAD' ? 'VAD' : 'known')] = (counts[d.split + ':' + (d.label === 'VAD' ? 'VAD' : 'known')] || 0) + 1;
console.log('docs', docs.length, 'vocab', vocab.length, counts);
