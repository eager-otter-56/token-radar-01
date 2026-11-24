# Token Launch Radar — radar-4

[![Competition](https://img.shields.io/badge/make.fun-token--radar--01-blue)](https://make.fun/bounty/token-radar-01)
[![Harness](https://img.shields.io/badge/harness-program%2Fv1-lightgrey)](#)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

A launch radar for pre-token DeFi protocols. `main.ts` reads the competition
snapshot (`/input/snapshot.json`, 758 protocols as of 2026-11-14), ranks every
strictly pre-token protocol by an implied launch value, and emits:

- `/output/board.json` — the ranked board (198 rows, watchlist 40/40)
- `/output/data.js` — the same board plus model metadata for the dashboard
- `/output/dashboard/` — a sortable, filterable dashboard (board + live-token tabs, per-protocol detail with a 7-step farm plan)
- `/output/screenshots/` — three rendered views of the dashboard
- `/output/dossier.json` — the judge dossier, built with the vendored `buildDossier`

The entry is deterministic: no network, no clocks, no randomness. Two runs
over the same snapshot produce byte-identical output.

## Eligibility — what counts as "pre-token"

A protocol is ranked only if it has **no market cap, no CoinGecko id and no
symbol**, and it is not:

- in the Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking,
  Restaked BTC or CEX categories,
- a versioned re-launch (v2 / 2.0 / phase / gen markers in the name),
- a wrapped, staked or staking product,
- an exchange-branded product (Binance, Coinbase, Bybit, Kraken, Bitget,
  OKX, Bitfinex, Gemini name prefixes).

That leaves 198 genuinely launchable protocols, including all 40 watchlist
entries. The 144 protocols that already have a token are never ranked; they
are the calibration set and appear on the dashboard's separate live tab.

## The radar-4 value model

radar-3 priced a protocol at TVL × a category median multiple. radar-4
replaces the flat multiple with a **fitted size curve**:

1. **Size curve.** Over the 128 launched peers with positive market cap and
   TVL, ordinary least squares on (ln TVL, ln market cap) gives
   `value = e^α · TVL^β` with **α = 6.9646, β = 0.5223** — market cap grows
   sub-linearly with TVL, so a single ×TVL multiple systematically overprices
   the largest protocols and underprices mid-size ones.
2. **Category relative factor.** Each category trades above or below the
   curve. The factor is the median of ln(actual / curve value) over the
   category's peers, shrunk toward 1.0 with prior weight 6 and clamped to
   [0.30, 2.50] (e.g. Risk Curators 1.31×, Prediction Market 2.50× at the clamp).
3. **Adjustments.** Growth: 7-day TVL change clamped to [−50%, +100%] at
   weight 0.35. Maturity: 0.70 + 0.30 × min(age, 3 years) / 3 years (unknown
   listing date treated as mid-life). Chain breadth: +3% per extra chain, up
   to five.
4. **Value band.** Each row carries a band of ±1 standard deviation of the
   model's log residuals on its own peers (SD = 1.936), so the dashboard
   shows how wide the honest uncertainty is instead of a fake point estimate.

Every number above is computed at runtime from the snapshot itself — no
protocol name, multiple or coefficient is hardcoded anywhere in the entry.
Top of the resulting board: Steakhouse Financial ($2.75B TVL → $114.6M
implied), Sentora Curator ($2.76B → $105.6M) and Gauntlet ($1.58B →
$88.0M), all lifted by the Risk Curators factor of 1.31×.

## Holdout validation

The peer set is split deterministically (sorted by slug; even positions fit,
odd positions are predicted; 64 fit / 64 held out). All models are fitted on
the fit half only and scored on market caps they never saw:

| Model | MedALE (lower is better) | Within 2× of actual |
| --- | --- | --- |
| **radar-4 — size curve + category factor** | **1.263** | 26.6% |
| radar-3 style — category median multiples | 1.588 | 28.1% |
| Flat — one global median multiple | 1.632 | 25.0% |

radar-4 has the lowest median absolute log error of the three. The within-2×
share is shown as computed: on that one statistic the older multiples edge
ahead by a single protocol, which is exactly why both numbers are published
in the dashboard instead of only the flattering one.

## Farm plans

Every board row carries a 7-step farm plan: research (with the modelled
value and band), wallet setup, two category-specific core actions, an
activity-tracking cadence, a weekly risk review, and exit preparation. Every
step states an explicit dollar cost and time budget, sized from the
protocol's TVL tier.

## Running it

The harness (program/v1) runs `main.ts` with the snapshot at
`/input/snapshot.json` and collects `/output/`. Locally:

```
node main.ts [path/to/snapshot.json] [output-dir]
```

Node 22+, standard library only, erasable TypeScript.
