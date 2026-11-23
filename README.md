[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/eager-otter-56/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/eager-otter-56/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Launch Radar — radar-3

A dashboard that finds the DeFi protocols whose token does not exist yet, ranks them by what
their launch would be worth, and gives each one a concrete plan for farming it. Built for the
make.fun bounty [token-radar-01](https://make.fun/bounty/token-radar-01).

The program reads the sealed DefiLlama snapshot (758 protocols, fetched 2026-11-14), applies
the eligibility rule and the valuation model below, and writes a ranked board of **198
pre-token protocols** — the snapshot's whole 40-protocol watchlist plus every other eligible
protocol the sweep finds below the watchlist's $50M floor.

## Who gets ranked — the eligibility rule

A protocol is ranked only when the snapshot records **no token at all** for it — no market
cap, no CoinGecko id, no symbol — **and** it is not a wrapped, staked or bridged product of a
protocol whose token already trades. Concretely, the board excludes:

- categories `Bridge`, `Canonical Bridge`, `Liquid Staking`, `Liquid Restaking`,
  `Restaked BTC` and `CEX`;
- names ending in a version marker (`V2`, `v3`, `2.0`, …) — pools of another protocol;
- names carrying the whole word *wrapped*, *staked* or *staking*;
- names beginning with an exchange's name (Binance, Coinbase, Bybit, Kraken, Bitget, OKX,
  Bitfinex, Gemini).

Protocols whose tokens already trade are never ranked. They appear in the dashboard's
separate **Live tokens** view at the market's own values — and they calibrate the model.

## The model — radar-3

```text
implied value = TVL × peer multiple × growth × maturity × chain breadth
```

Every figure is computed from the snapshot at run time. No protocol is named in the code and
no category carries a hand-set multiple.

- **Peer multiple** — the median market-cap ÷ TVL of the live-token protocols in the same
  category, pulled toward the all-market median (0.17×) with a prior weight of 3 so a
  category priced by a single peer cannot swing the board, then clamped to [0.02×, 2.50×].
  A category with no live peers uses the all-market median.
- **Growth** — the 7-day TVL change clamped to [−50%, +100%], weighted ×0.35
  (`1 + (g/100) × 0.35`); unreported change counts as 0.
- **Maturity** — `0.70 + 0.30 × min(age_days, 1095) / 1095`, where age is the time DefiLlama
  has tracked the protocol with no token; unknown age uses the 547-day midpoint.
- **Chain breadth** — `1 + 0.03 × min(chains − 1, 5)`.

Each board row also carries a **peer band**: the implied value recomputed with the category's
25th and 75th percentile peer multiples (a flat 0.6×–1.5× band when a category has fewer
than four live peers). The dashboard's detail view shows every row's full arithmetic.

## Farm plans

Every row carries a seven-step plan generated from its own record — category, first chain,
TVL tier and age: set up a dedicated wallet, take the category's core position with a stated
amount of capital ($50–$250 by TVL tier), add a second interaction, keep a weekly qualifying
action, hold for an age-based window (30–60 days), check the protocol's own points page
(claim only from its published link, never pay to claim), and log everything with an exit
rule. Each step states its cost in dollars and the time it takes.

## Run it

Node.js 22.18 or later, standard library only, no install, no network:

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to>/snapshot.json
```

`--input` also accepts the directory holding `snapshot.json`; `--output` overrides
`MAKEFUN_OUTPUT_DIR`. The program is deterministic — two runs over the same snapshot write
byte-identical output — and it refuses to hand in a board that fails the gate's own checks
(coverage, exact ranks, value order, farm-step lengths).

Outputs:

| File | What it is |
| --- | --- |
| `board.json` | The ranked board: 198 rows with implied values, factor breakdowns, peer bands and farm plans. |
| `data.js` | The same board as `window.RADAR`, loaded by the dashboard. |
| `dashboard/` | The static page: sortable, filterable, a detail view per protocol, a live-tokens view. Renders with no network. |
| `screenshots/` | The board, a detail view and a filtered view, as rendered by the shipped page. |
| `dossier.json` | The judge's summary, built with `vendor/makefun-board.ts` exactly as the scorer rebuilds it. |

## Layout

```text
main.ts                  the entry program: snapshot in, hand-in out
lib/model.ts             eligibility, the radar-3 model, farm plans, gate self-check
vendor/makefun-board.ts  make.fun's dossier library (vendored, unmodified)
dashboard/               index.html, app.css, app.js — plain, no framework
screenshots/             1-board.jpg, 2-detail.jpg, 3-filtered.jpg
```

Every dashboard view has its own URL (`?category=Lending&watchlist=1`,
`?protocol=steakhouse-financial`, `?view=live`), which is also how the screenshots were
taken: the shipped page, rendered headless at 1440×1000.

## A note on the numbers

An implied value is this entry's model claim, not a prediction: the snapshot says nothing
about whether or when any protocol will issue a token, and a launch price is set by a
market, not a formula. The radar's claim is narrower and checkable — *if* a protocol's
record stayed as it is, the live market's own pricing of its category peers puts its launch
in this range, and here is the arithmetic, row by row.
