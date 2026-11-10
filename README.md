# Autonomy Certificate for Trase Origin (concept demo)

**Live demo:** https://mohith26.github.io/trase-autonomy-certificate/

An unofficial concept for a new tab on a Trase Origin agent: **Autonomy certificate**. It answers the question a division chief asks before letting an agent act alone, in a form you can put in an evidence pack:

> "Auto-route a Heart Failure Clinic fax only when confidence ≥ 0.795. With 95% confidence, the error rate on those auto-routed faxes is at most 2.80% (target 3%)."

and it keeps that sentence honest after go-live with an **exchangeability sentinel** that notices when the incoming faxes stop looking like the faxes the certificate was calibrated on (the LVAD case from the Duke Cardiology deployment) and holds that cluster for people.

Built by Mohith Gajjela. Not affiliated with Trase. All data is synthetic.

## Why

Trase's public writing describes the pieces this would sit on: a judgment layer that decides which decisions are escalated, confidence scoring and thresholds in the safety layer, a validation card and a monitoring card for every use case, and drift tracked through evals and through "how often the system flags items for human review." Two gaps show up when you try to put a number on that:

1. **A single confidence threshold hides per-queue risk.** In this demo's data the global 0.90 rule has a 2.03% error rate on the faxes it auto-routes (it looks fine against a 3% target) while routing 5.2% wrong in Electrophysiology, 7.3% wrong in the Cath Lab and 8.0% wrong in the Heart Failure Clinic. Small queues absorb look-alike faxes (a pre-TAVR workup that is mostly a cath report).
2. **A certificate is only as good as its exchangeability assumption.** When a new fax type arrives (LVAD coordinator faxes), the classifier sends 74 of the 99 to the Heart Failure Clinic at a mean confidence of 0.82, and the daily escalation rate only moves from 12.5% to 15.2%. Watching the escalation rate does not catch it quickly. A certificate makes this sharper, not softer: it lowers the Heart Failure threshold to 0.795 because the calibration evidence supports it, so without a sentinel 51 LVAD faxes would be auto-routed (38 under the 0.90 rule).

## What the page computes (all in the browser, from `data/faxes.json`)

| Piece | Method |
|---|---|
| Routing model | L2-regularised softmax regression on log-tf features, temperature-scaled on held-out history. It stands in for the agent's classification micro-agent; any model that emits a confidence works. |
| Queue certificates | **Learn-then-Test** (Angelopoulos, Bates et al.) per predicted queue: thresholds λ from 0.995 down to 0.500 are tested in a fixed sequence with an exact binomial test of H₀: P(error \| routed here, conf ≥ λ) > α. The most permissive rejected λ is certified. Option: Bonferroni across queues so all certificates hold jointly. One-sided Clopper-Pearson bound shown for each certificate. |
| "Needs more labels" vs "needs a model fix" | For uncertified queues, finds the threshold that would certify with the fewest extra staff-labeled faxes if today's error rate holds; if the confident error rate is already too close to α, more labels can't help and the page says so. |
| Sentinel | Nonconformity = 1 − mean cosine similarity to the 10 nearest historical faxes (tf-idf). **Online smoothed conformal p-values** against calibration + all earlier live faxes (i.i.d. uniform under exchangeability), fed to a **Shiryaev-Roberts** procedure with a tail-betting calibrator f(p) = 1 − w + (w/c)·1[p ≤ c]. Under exchangeability E[Rₙ] = n, so the mean time to a false alarm at threshold 50,000 is at least 50,000 faxes. |
| Hold | After the alarm, faxes with p ≤ 0.01 are escalated instead of auto-routed (the "novelty gate"). |
| What changed | Terms never seen in the training history, plus log-odds with an informative Dirichlet prior (Monroe, Colaresi & Quinn 2008) against the calibration set. |
| Weekly re-check | Staff-confirmed outcomes per week; a queue is flagged only if a one-sided binomial test says its errors significantly exceed α. |

Headline numbers on the default settings (α = 3%, 95%, per queue): 7 of 10 queues certified, 76.8% of live faxes auto-routed, 1.05% live error on them; the first LVAD fax arrives May 26 at 9:16 AM and the sentinel alarms at 7:03 PM the same day, after 5 of them; the hold stops 46 of the 51 wrong-queue auto-routes at the cost of 11 extra escalations of known fax types.

## Data

`scripts/generate.mjs` (seed 20260427) writes 14,000 synthetic faxes for a fictional "Riverside Health" cardiology division: 3,600 history faxes (training), 4,200 staff-labeled validation faxes (calibration, Apr 6–24), and 6,200 production faxes (Apr 27–Jun 5). Ten queues with realistic volume shares, per-queue look-alike rates, cover-sheet-only faxes, rare label noise, and a new LVAD/MCS coordinator fax type that starts on May 26. Faxes are bags of OCR-like tokens, not real documents. The LVAD onset time is stored only for the tests and for the "ground truth" marker on the chart; no algorithm reads it.

## Run it

```bash
node scripts/generate.mjs      # regenerate data/faxes.json
node --test test/*.test.mjs    # 8 tests
python3 -m http.server         # then open http://localhost:8000
```

Tests cover: exact binomial CDF and Clopper-Pearson bound; the calibrator integrating to 1; LTT coverage by simulation (violation rate ≤ δ over 300 calibration draws with known ground truth); uniformity of online conformal p-values and the sentinel's false-alarm and detection behaviour on simulated streams; that certified queues meet the target on live data; that the alarm fires after (never before) the LVAD onset; and that the numbers on the page add up.

## Honest limitations

- Synthetic data and a simple bag-of-words classifier. The point is the statistical layer, which is model-agnostic.
- The guarantee is marginal over faxes the agent routes to a queue, conditional on exchangeability between calibration and live traffic. It is not a per-fax guarantee, and it says nothing once the sentinel has fired (that is why it holds the cluster).
- Calibration labels must be a fair sample of what the agent will see (the validation window), not only the escalated faxes. Faxes that were auto-routed and never corrected are treated as correct in production re-checks, which needs a real audit sample in practice.
- The sequence start is chosen from unlabeled confidences only (first λ with at least ⌈log δ / log(1−α)⌉ faxes above it); this keeps the fixed-sequence guarantee.
- No in-app screenshots of Trase Origin are public. The UI is built from Trase's own product components on trase.ai (audit and evidence log, agent wizard, badges, buttons) and their stylesheet tokens; the console shell and navigation are my inference.

## Novelty note

I checked trase.ai (platform, Origin, Arena, Leagues, healthcare, government, enterprise, pricing, security pages), the Trase blog and Duke customer story, press coverage of the June 2026 seed round, and the Google Cloud video. Trase describes confidence thresholds, escalation, drift monitoring through evals and flag rates, and a monitoring card. I found nothing about finite-sample guarantees on auto-routed error, per-queue certification, or sequential exchangeability testing on live traffic. The statistics are published research (conformal prediction, Learn-then-Test, conformal test martingales); the contribution here is fitting them into Origin's governance model as an auditable artifact.
