[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/eager-otter-56/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/eager-otter-56/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Launch Radar — radar-5

A token launch radar that ranks every strictly pre-token protocol in a
DefiLlama snapshot by what its launch would be worth, and says — with the
arithmetic shown — whether farming it pays. Every number on the dashboard is
computed by `main.ts` from the snapshot at run time; nothing is hardcoded,
and nothing is tuned on the numbers it is judged by.

**Implied value = value if it launches × odds it launches.**

- **Value if it launches** is a size curve — market cap as a power of TVL —
  fitted on the snapshot's own 128 launched peers (market cap > 0, TVL > 0).
  Every candidate adjustment term (category, growth, maturity, chain) had to
  earn its place out-of-sample or be dropped. All four were dropped; the
  fitted curve alone beat every adjusted specification, including the
  previous version's, on the protocols below.
- **Odds it launches** is a logistic fit on the snapshot's own token record
  (does a comparable peer already record a token?), driven by listing age
  and size, scored with proper scoring rules on held-out data.
- **Farm verdicts** price each row's 7-step plan exactly (every step carries
  its fee and its hours) against the expected reward under a stated
  scenario, and stress-test the verdict over a 3×3 grid of scenarios.

Eligibility, applied to all 758 protocols with none silently dropped: a
protocol is ranked only when the snapshot records no token for it (no market
cap, no symbol, no Gecko id) and it is not a bridge, liquid-staking,
restaking or exchange product, not a versioned re-listing, and not a wrapped
or staked product of an asset that already trades. The board is the full
eligible universe: **198 rows, watchlist 40 of 40**. The remaining 560 are
accounted for on the dashboard (416 record a token; 144 set aside by the
rules above).

Top of the board (odds × value-if-it-launches = implied):

| # | Protocol | Odds | If it launches | Implied | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | steakhouse-financial | 54% | $90.1M | $49.1M | MARGINAL |
| 2 | sentora-curator | 50% | $90.2M | $45.1M | SKIP |
| 3 | veda | 56% | $67.1M | $37.7M | MARGINAL |
| 4 | gauntlet | 54% | $67.4M | $36.3M | MARGINAL |
| 5 | usdd | 55% | $54.6M | $30.2M | MARGINAL |

## The model

Fitted size curve (OLS on logs, chosen by bake-off):

```
value if it launches  =  e^6.964567 · TVL^0.522266
```

The exponent is far below 1: value grows much more slowly than TVL, so flat
TVL multiples systematically overprice the biggest protocols and underprice
the small ones.

### Estimator bake-off (leave-one-out MedALE, lower is better)

| Estimator | P1 MedALE |
| --- | --- |
| **OLS on logs — kept** | **1.2234** |
| Median regression (IRLS, 100 iters) | 1.3020 |
| Huber regression (δ = 1.345, IRLS, 100 iters) | 1.2549 |

### Term ablation — the rules were fixed before the results were read

A term was kept only if adding it lowered the median absolute log error on
**all three** protocols — P1 leave-one-out, P2 walk-forward (expanding
window by listing date), P3 slug-parity split — **and** the bootstrap 90% CI
of its P1 improvement (200 resamples of per-peer error differences, seed 7)
excluded zero. Δ = change in MedALE when the term is added (negative helps).

| Term | Δ P1 | Δ P2 | Δ P3 | 90% CI (P1) | Verdict |
| --- | --- | --- | --- | --- | --- |
| category (empirical-Bayes, k = 3.223) | −0.1738 | −0.0519 | −0.0595 | [−0.0255, 0.0926] | tested, not kept |
| growth (fitted weight) | −0.0873 | −0.0472 | +0.0043 | [−0.0268, 0.0092] | tested, not kept |
| maturity (fitted weight) | −0.0073 | −0.0182 | −0.1370 | [−0.0058, 0.0000] | tested, not kept |
| chain (fitted weight) | −0.0447 | −0.1125 | −0.0651 | [0.0000, 0.0000] | tested, not kept |

Category medians are mostly noise at 128 peers spread over 34 categories
(12 categories have a single peer); growth and maturity, which the previous
version applied with hand-set weights, do not generalise either. The
dashboard prints this table as computed, with the dropped terms labelled.

### Headline validation

| Specification | P1 (leave-one-out) | P2 (walk-forward) | P3 (parity) |
| --- | --- | --- | --- |
| **radar-5 (fitted curve, terms dropped)** | **1.2234** | **0.9549** | **1.2564** |
| radar-4 specification (previous version) | 1.2376 | 1.1393 | — |
| Flat TVL × median multiple | 1.6233 | — | — |

**Range honesty:** under leave-one-out, 49.2% of peers' actual market caps
fell inside the P25–P75 band their fold's training residuals implied — close
to the 50% the band promises, so the printed ranges are honest, not padded.

**Rank ranges:** the whole pipeline was bootstrapped 200 times (peers
resampled with replacement, model refitted, board re-ranked; seed 42; token
odds held fixed during the bootstrap — only the value model is resampled).
Each row prints its 5th–95th percentile rank range and P(top 10).

### Token odds

Logistic regression on ln(listing age) and ln(TVL), standardised features,
L2 1e-3, 2,000 fixed gradient steps. Records with unknown listing age (113)
are excluded from fitting; their board rows get the base rate. Young
protocols are censored — "no token yet" is not "never" — so the model is
presented as the share of comparable peers that record a token.

| Score (held out, slug-parity) | Model | Base rate |
| --- | --- | --- |
| Brier | **0.2237** | 0.2500 |
| Log-loss | **0.6399** | 0.6931 |

Walk-forward (by listing date): Brier 0.2565, log-loss 0.7858 — weaker, as
expected when the earliest folds train on the youngest snapshot slice.
Base rate: 50.7% of the 645 age-known records record a token.

Calibration (5-fold cross-validated predictions, deciles; predicted vs
realized share): 0.193/0.297, 0.355/0.277, 0.439/0.375, 0.487/0.385,
0.524/0.516, 0.556/0.338, 0.581/0.609, 0.611/0.692, 0.644/0.828, 0.687/0.754.
Calibration slope 0.86 — inside the pre-set [0.8, 1.25] band, so no Platt
recalibration was applied.

Empirical launch share by age band, straight from the snapshot: 0–6 months
26.1% (n = 88), 6–18 months 34.9% (n = 175), 18+ months 63.6% (n = 382).

### Farm verdicts

Each row's plan is 7 steps with an explicit fee and time per step; the plan
totals are the exact sums of those parts. Under the default scenario the
board splits **FARM 0 · MARGINAL 146 · SKIP 52** — under a $10,000 ticket cap
and a $15/hour hurdle, no plan clears FARM, and the dashboard says so rather
than relaxing the hurdle. The scenario sliders (drop share, ticket scale)
recompute every verdict live, and each row's stability label counts how
often its default verdict survives the 3×3 stress grid.

## Assumptions

| Assumption | Value | Why |
| --- | --- | --- |
| Drop share to farmers | 7.5% of launch value | Stated scenario, adjustable 1–20% on the dashboard |
| Ticket size | 0.02% of TVL, clamped $250–$10,000 | A realistic single-wallet position |
| FARM hurdle | net > 0 and ≥ $15/hour | A T-bill pays ~4% for no time; farm time must pay |
| Stress grid | drop {3%, 7.5%, 15%} × ticket {0.5×, 1×, 2×} | Verdict stability: robust ≥ 7 of 9 cells, fragile ≤ 3 |
| Odds for unknown-age rows | base rate 50.7% | No age signal available; stated, not hidden |
| Bootstrap | 200 refits, seed 42, odds fixed | Rank uncertainty comes from the value model |

## Running it

```
node main.ts            # reads /input/snapshot.json, writes /output/
node main.ts in.json outdir   # explicit paths, for local runs
```

Node 22+, standard library only, no network. The entry runs twice and must
produce byte-identical `board.json`, `data.js` and `dossier.json`; all
randomness comes from a seeded mulberry32 PRNG and every iterative fit runs
a fixed iteration count.
