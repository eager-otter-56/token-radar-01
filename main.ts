// radar-4: a token launch radar fitted to the snapshot's own launched peers.
//
// The board ranks every strictly pre-token protocol in the snapshot by an
// implied launch value. The value model is a size curve — an ordinary least
// squares fit of ln(market cap) on ln(TVL) over the protocols that already
// launched — corrected by a per-category relative factor, then adjusted for
// 7-day growth, maturity and chain breadth. The model's honesty is checked
// in the open: a deterministic holdout split of the peer set compares this
// model against the previous radar-3 style category multiples and a flat
// TVL multiple, and the results ship inside data.js for the dashboard.
//
// Harness contract (program/v1): reads /input/snapshot.json, writes
// /output/board.json and /output/data.js, copies dashboard/ and
// screenshots/ into /output, and writes /output/dossier.json built with
// the vendored buildDossier. Optional argv overrides ([input] [output])
// exist only for local runs. No network, no clocks, no randomness: two
// runs over the same snapshot produce byte-identical output.

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";

// ------------------------------------------------------------------ types

interface ProtocolRecord {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  protocols: ProtocolRecord[];
  watchlist: string[];
}

interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  chain_count: number;
  tvl_usd: number;
  change_7d_pct: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  peer_count: number;
  size_curve_value_usd: number;
  category_factor: number;
  growth_factor: number;
  maturity_factor: number;
  chain_factor: number;
  implied_value_usd: number;
  band_low_usd: number;
  band_high_usd: number;
  farm_steps: string[];
}

interface ModelScore {
  medale: number;
  within2: number;
}

// --------------------------------------------------------------- helpers

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function roundTo(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** "$1,234,567" — manual comma grouping so output never depends on ICU. */
function fmtUsd(x: number): string {
  const neg = x < 0;
  const digits = String(Math.round(Math.abs(x)));
  return (neg ? "-$" : "$") + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ------------------------------------------------------------- eligibility

const EXCLUDED_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
]);

const VERSIONED_NAME: RegExp[] = [
  /(^|[\s\-–—(])v\d+(\.\d+)?\b/i,
  /[\s\-–—]v\d+(\.\d+)?\s*$/i,
  /(^|\s)version\s*\d+/i,
  /\bphase\s*[0-9ivx]+\b/i,
  /\bgen\s*[23]\b/i,
  /\b2\.0\b/,
];

const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

const EXCHANGE_PREFIXES = [
  "binance",
  "coinbase",
  "bybit",
  "kraken",
  "bitget",
  "okx",
  "bitfinex",
  "gemini",
];

/** True when the name starts with the given word as a whole word. */
function startsWithWord(name: string, word: string): boolean {
  const n = name.toLowerCase();
  if (!n.startsWith(word)) return false;
  const next = n.charAt(word.length);
  return next === "" || !/[a-z0-9]/.test(next);
}

/**
 * Strictly pre-token and genuinely launchable: no market cap, no CoinGecko
 * id and no symbol yet; not a bridge / staking wrapper / exchange category;
 * not a versioned re-launch of something that already exists; not a wrapped
 * or staked product; not an exchange-branded product.
 */
function isEligible(rec: ProtocolRecord): boolean {
  if (rec.mcap_usd !== null || rec.gecko_id !== null || rec.symbol !== null) {
    return false;
  }
  if (EXCLUDED_CATEGORIES.has(rec.category)) return false;
  if (VERSIONED_NAME.some((rx) => rx.test(rec.name))) return false;
  if (WRAPPED_WORD.test(rec.name)) return false;
  if (EXCHANGE_PREFIXES.some((p) => startsWithWord(rec.name, p))) return false;
  return true;
}

// ----------------------------------------------------------------- model

/** A launched peer: real positive market cap and TVL to learn from. */
function isPeer(rec: ProtocolRecord): boolean {
  return (
    rec.mcap_usd !== null && rec.mcap_usd > 0 &&
    rec.tvl_usd !== null && rec.tvl_usd > 0
  );
}

interface SizeCurve {
  alpha: number;
  beta: number;
}

/** OLS of ln(mcap) on ln(tvl): the market's own size curve. */
function fitSizeCurve(peers: ProtocolRecord[]): SizeCurve {
  const n = peers.length;
  let mx = 0;
  let my = 0;
  for (const p of peers) {
    mx += Math.log(p.tvl_usd);
    my += Math.log(p.mcap_usd as number);
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (const p of peers) {
    const dx = Math.log(p.tvl_usd) - mx;
    sxy += dx * (Math.log(p.mcap_usd as number) - my);
    sxx += dx * dx;
  }
  const beta = sxy / sxx;
  return { alpha: my - beta * mx, beta };
}

function curveValue(curve: SizeCurve, tvl: number): number {
  return Math.exp(curve.alpha) * Math.pow(tvl, curve.beta);
}

const CATEGORY_SHRINK_WEIGHT = 6;
const CATEGORY_FACTOR_MIN = 0.3;
const CATEGORY_FACTOR_MAX = 2.5;

/**
 * How a category trades relative to the size curve: the median log ratio
 * of actual to curve-fitted market cap among its launched peers, shrunk
 * toward 1.0 with a prior weight of 6 pseudo-peers, then clamped.
 */
function fitCategoryFactors(
  peers: ProtocolRecord[],
  curve: SizeCurve,
): Map<string, number> {
  const byCategory = new Map<string, number[]>();
  for (const p of peers) {
    const lr = Math.log(p.mcap_usd as number) - Math.log(curveValue(curve, p.tvl_usd));
    const arr = byCategory.get(p.category) ?? [];
    arr.push(lr);
    byCategory.set(p.category, arr);
  }
  const out = new Map<string, number>();
  for (const [cat, lrs] of byCategory) {
    const lnFactor = (lrs.length * median(lrs)) / (lrs.length + CATEGORY_SHRINK_WEIGHT);
    out.set(cat, clamp(Math.exp(lnFactor), CATEGORY_FACTOR_MIN, CATEGORY_FACTOR_MAX));
  }
  return out;
}

interface Radar4Model {
  curve: SizeCurve;
  factors: Map<string, number>;
}

function fitRadar4(peers: ProtocolRecord[]): Radar4Model {
  const curve = fitSizeCurve(peers);
  return { curve, factors: fitCategoryFactors(peers, curve) };
}

function predictRadar4(model: Radar4Model, rec: ProtocolRecord): number {
  return curveValue(model.curve, rec.tvl_usd) * (model.factors.get(rec.category) ?? 1);
}

// ------------------------------------------- radar-3 style model (baseline)

interface Radar3Model {
  multiples: Map<string, number>;
  globalMultiple: number;
}

/** TVL x category median mcap/TVL multiple, log-shrunk to the global one. */
function fitRadar3(peers: ProtocolRecord[]): Radar3Model {
  const globalMultiple = median(peers.map((p) => (p.mcap_usd as number) / p.tvl_usd));
  const byCategory = new Map<string, number[]>();
  for (const p of peers) {
    const arr = byCategory.get(p.category) ?? [];
    arr.push((p.mcap_usd as number) / p.tvl_usd);
    byCategory.set(p.category, arr);
  }
  const multiples = new Map<string, number>();
  for (const [cat, ms] of byCategory) {
    const ln = (ms.length * Math.log(median(ms)) + 3 * Math.log(globalMultiple)) /
      (ms.length + 3);
    multiples.set(cat, clamp(Math.exp(ln), 0.02, 2.5));
  }
  return { multiples, globalMultiple };
}

function predictRadar3(model: Radar3Model, rec: ProtocolRecord): number {
  return rec.tvl_usd * (model.multiples.get(rec.category) ?? model.globalMultiple);
}

function fitFlat(peers: ProtocolRecord[]): number {
  return median(peers.map((p) => (p.mcap_usd as number) / p.tvl_usd));
}

// ------------------------------------------------------- holdout validation

function scorePredictions(
  actual: number[],
  predicted: number[],
): ModelScore {
  const errs = actual.map((a, i) => Math.abs(Math.log(predicted[i]) - Math.log(a)));
  const within = errs.filter((e) => e <= Math.log(2)).length;
  return {
    medale: roundTo(median(errs), 4),
    within2: roundTo(within / errs.length, 4),
  };
}

/**
 * Deterministic holdout: peers sorted by slug, even indices fit, odd
 * indices are predicted. All three models see the same split.
 */
function holdoutValidation(peers: ProtocolRecord[]): {
  fit_n: number;
  test_n: number;
  radar4: ModelScore;
  radar3: ModelScore;
  flat: ModelScore;
} {
  const sorted = [...peers].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const fit = sorted.filter((_, i) => i % 2 === 0);
  const test = sorted.filter((_, i) => i % 2 === 1);
  const actual = test.map((p) => p.mcap_usd as number);

  const m4 = fitRadar4(fit);
  const m3 = fitRadar3(fit);
  const mf = fitFlat(fit);

  return {
    fit_n: fit.length,
    test_n: test.length,
    radar4: scorePredictions(actual, test.map((p) => predictRadar4(m4, p))),
    radar3: scorePredictions(actual, test.map((p) => predictRadar3(m3, p))),
    flat: scorePredictions(actual, test.map((p) => p.tvl_usd * mf)),
  };
}

// ------------------------------------------------------------ adjustments

function growthFactor(change7d: number | null): number {
  const g = clamp(change7d ?? 0, -50, 100);
  return 1 + (g / 100) * 0.35;
}

const UNKNOWN_AGE_DAYS = 547.5;

function maturityFactor(ageDays: number | null): number {
  const age = ageDays ?? UNKNOWN_AGE_DAYS;
  return 0.7 + 0.3 * (Math.min(age, 1095) / 1095);
}

function chainFactor(chainCount: number): number {
  return 1 + 0.03 * Math.min(Math.max(chainCount - 1, 0), 5);
}

function ageInDays(listedAt: string | null, asOfMs: number): number | null {
  if (listedAt === null) return null;
  const t = Date.parse(listedAt);
  if (Number.isNaN(t)) return null;
  return Math.floor((asOfMs - t) / 86400000);
}

// ------------------------------------------------------------- farm plans

/** Working-capital tier for a board row, from its TVL. */
function budgetFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 10000;
  if (tvl >= 250_000_000) return 5000;
  if (tvl >= 100_000_000) return 2500;
  if (tvl >= 50_000_000) return 1000;
  return 500;
}

interface CategoryActions {
  open: string;
  deepen: string;
  track: string;
}

// Category-specific core actions; {name} and {chain} are filled per row.
const CATEGORY_ACTIONS: Record<string, CategoryActions> = {
  "Dexs": {
    open: "Swap a first {budget} through {name} across its main pairs on {chain} so your wallet builds real trader history, not one wash trade.",
    deepen: "Add a two-sided LP position in the busiest pool and rebalance it weekly as volumes shift between pairs.",
    track: "Log every swap and LP fee in a sheet; points seasons on DEXes reward sustained weekly volume, not a single burst.",
  },
  "Lending": {
    open: "Supply {budget} of a blue-chip collateral asset to {name} on {chain} and leave it supplied; do not borrow against it yet.",
    deepen: "Open a small, well-collateralised borrow at under 40% of the limit and repay it in full to build a clean borrower record.",
    track: "Check the health factor twice a week and keep a liquidation buffer of at least 25% above the threshold.",
  },
  "CDP": {
    open: "Open a vault on {name} with {budget} of collateral on {chain} and mint a conservative amount of its stablecoin against it.",
    deepen: "Put the minted stablecoin to work in the protocol's own stability or liquidity pool rather than swapping it away.",
    track: "Watch the collateral ratio weekly; CDP points and liquidation risk both turn on keeping the vault boringly safe.",
  },
  "Derivatives": {
    open: "Fund a {budget} margin account on {name} and trade small perpetual positions with tight stops to build genuine volume history.",
    deepen: "Run a delta-neutral leg: hedge each perp position with spot on the same asset so fees and points accrue without directional risk.",
    track: "Record open interest, funding paid and realised PnL weekly; derivatives seasons usually score consistency over size.",
  },
  "Yield": {
    open: "Deposit {budget} into the flagship vault of {name} on {chain} and hold the receipt token in the same wallet.",
    deepen: "Ladder a second deposit into a different strategy vault so your activity spans more than one underlying market.",
    track: "Screenshot APY and your share of the vault monthly; yield points compound quietly and are easy to under-document.",
  },
  "Restaking": {
    open: "Restake {budget} of ETH or LSTs into {name} on {chain} through the native interface, never through an unaudited wrapper.",
    deepen: "Delegate to one large, long-running operator and keep the delegation unchanged for a full epoch cycle.",
    track: "Track restaking points and operator performance weekly; slashing news, not price, is the signal to act on.",
  },
  "Risk Curators": {
    open: "Allocate {budget} to one curated vault on {name} whose curator publishes its mandate and rebalancing history.",
    deepen: "Split a second tranche across a vault with a different risk profile so your exposure is not one curator's single bet.",
    track: "Read the curator's weekly allocation notes; curator-run vaults reward depositors who stay through rebalances.",
  },
  "AI Agents": {
    open: "Fund an agent wallet on {name} with {budget} and run its default strategy on {chain} at the smallest live size.",
    deepen: "Raise the agent's allocation in steps only after it has traded profitably through one full volatility swing.",
    track: "Export the agent's trade log weekly; agent platforms score live, funded, long-running agents over fresh ones.",
  },
  "Prediction Market": {
    open: "Place small, researched positions totalling {budget} across several liquid markets on {name}, sized by conviction.",
    deepen: "Provide two-sided quotes on one mid-volume market to earn maker share rather than only taking prices.",
    track: "Keep a calibration log of your forecasts versus outcomes; prediction platforms notice accurate, active accounts.",
  },
  "Chain": {
    open: "Bridge {budget} to {name} and use two native dApps in the first week so the wallet reads as a real chain user.",
    deepen: "Keep a standing balance and weekly transactions on the chain: deploy a trivial contract or mint its testnet-to-mainnet badges.",
    track: "Follow the chain's official quest and points channels; chain airdrops snapshot ordinary sustained activity.",
  },
  "RWA": {
    open: "Complete KYC on {name} and subscribe {budget} to its shortest-duration real-world asset offering on {chain}.",
    deepen: "Roll the matured proceeds into the next offering instead of withdrawing, building an unbroken holder history.",
    track: "Save every offering document and statement; RWA platforms verify holders from their own records at token time.",
  },
  "Gaming": {
    open: "Create your {name} account, link the wallet, and spend about {budget} on the in-game assets you will actually play with.",
    deepen: "Play in short daily sessions rather than weekend binges; game economies score daily-active retention hardest.",
    track: "Finish each season's battle pass and keep screenshots of ranks; game token drops favour proven players.",
  },
  "DePIN": {
    open: "Buy or stake the {budget} of hardware or node credit {name} requires and bring one node or device online on schedule.",
    deepen: "Keep the node above 95% uptime for a full month; DePIN rewards are overwhelmingly an uptime game.",
    track: "Log uptime and earnings weekly and claim every testnet or points epoch before it closes.",
  },
  "Privacy": {
    open: "Deposit a modest {budget} into {name} on {chain} from a fresh wallet and make one shielded transfer to yourself.",
    deepen: "Use the shielded pool for routine transfers over several weeks so the wallet has organic private activity.",
    track: "Keep your own off-chain records of deposits and withdrawals; privacy tools cannot reconstruct them for you later.",
  },
  "Launchpad": {
    open: "Complete the {name} KYC and stake or commit {budget} toward its next sale tier on {chain}.",
    deepen: "Participate in two consecutive sales, even at minimum size, instead of cherry-picking one hyped launch.",
    track: "Record allocation, vesting and claim dates for every sale in one sheet; launchpad tiers reward unbroken streaks.",
  },
  "Uncollateralized Lending": {
    open: "Pass {name}'s lender onboarding and fund one senior pool with {budget}, reading the borrower's disclosure first.",
    deepen: "Diversify into a second pool with a different borrower sector once the first pool completes a full cycle.",
    track: "Save quarterly pool reports; under-collateralised lenders are verified from platform records, not wallet history.",
  },
  "Farm": {
    open: "Stake {budget} in the headline farm of {name} on {chain} and compound the first harvest back in.",
    deepen: "Add the paired LP farm so your position spans both the single-asset and liquidity sides of the protocol.",
    track: "Harvest on a fixed weekly cadence; farm points systems usually count weeks active, not total clicks.",
  },
  "Perpetuals": {
    open: "Fund a {budget} margin account on {name} and trade small perpetual positions with tight stops to build genuine volume history.",
    deepen: "Run a delta-neutral leg: hedge each perp position with spot on the same asset so fees and points accrue without directional risk.",
    track: "Record open interest, funding paid and realised PnL weekly; derivatives seasons usually score consistency over size.",
  },
  "Prediction Markets": {
    open: "Place small, researched positions totalling {budget} across several liquid markets on {name}, sized by conviction.",
    deepen: "Provide two-sided quotes on one mid-volume market to earn maker share rather than only taking prices.",
    track: "Keep a calibration log of your forecasts versus outcomes; prediction platforms notice accurate, active accounts.",
  },
  "Indexes": {
    open: "Buy {budget} of the flagship index token on {name} through {chain} and hold it unbroken in one wallet.",
    deepen: "Add a second index with a different basket so your holdings span more than one methodology.",
    track: "Check rebalances monthly and never sell mid-rebalance; index issuers snapshot holders at announced dates.",
  },
  "Cross Chain Bridge": {
    open: "Bridge {budget} through {name} in both directions between {chain} and one other chain, using the canonical route.",
    deepen: "Bridge on a weekly cadence with varied amounts rather than a single large transfer.",
    track: "Save every source and destination transaction hash; bridge points are reconciled from both chains.",
  },
  "Staking Pool": {
    open: "Stake {budget} with {name} on {chain} and keep the staking receipt in the staking wallet.",
    deepen: "Restake or delegate a second tranche to a different validator set offered by the pool.",
    track: "Verify rewards actually land each epoch; pool dashboards and on-chain rewards often disagree.",
  },
  "Basis Trading": {
    open: "Open the protocol's basis position with {budget} on {name}: long spot, short the matching perp, through its own interface.",
    deepen: "Rebalance the hedge whenever the basis moves more than a few percent so the position stays market-neutral.",
    track: "Log funding collected weekly; basis vaults reward depositors who stay through negative-funding weeks.",
  },
  "Yield Aggregator": {
    open: "Deposit {budget} into the largest aggregator vault of {name} on {chain} and hold the vault share token.",
    deepen: "Spread a second deposit across a vault on a different underlying asset to diversify strategy risk.",
    track: "Compare the vault's realised APY against its quoted APY monthly and note any strategy migrations.",
  },
  "Onchain Capital Allocator": {
    open: "Allocate {budget} to one allocator vault on {name} after reading its allocation mandate and current holdings.",
    deepen: "Add a second vault run by a different allocator so manager risk is not concentrated in one strategy.",
    track: "Follow the allocator's published rebalances; allocator tokens tend to reward depositors with long holding periods.",
  },
  "Leveraged Farming": {
    open: "Open a conservative leveraged position on {name} with {budget} of equity at no more than 2x leverage on {chain}.",
    deepen: "Let the position run a full rewards epoch before resizing; leveraged farms score time-weighted balances.",
    track: "Check the liquidation threshold daily at first, then twice a week once the position proves stable.",
  },
  "Synthetics": {
    open: "Mint or trade a small synthetic position on {name} backed by {budget} of collateral on {chain}.",
    deepen: "Hold the synthetic through one funding or rebase cycle so your wallet shows a complete usage loop.",
    track: "Monitor the collateral ratio and oracle updates weekly; synthetic protocols fail at the oracle, not the UI.",
  },
  "Options": {
    open: "Buy one small, near-the-money option on {name} with part of {budget} rather than selling premium first.",
    deepen: "Sell one covered option against spot you hold to experience both sides of the order book.",
    track: "Log strike, expiry and outcome for every contract; options platforms score completed expiries.",
  },
  "Payments": {
    open: "Route a real payment of part of {budget} through {name} to a second wallet you control, end to end.",
    deepen: "Set up a recurring payment or payment link and let it run for several cycles without intervention.",
    track: "Keep receipts for every payment; payment networks verify volume from settled transactions only.",
  },
  "Insurance": {
    open: "Underwrite {budget} into one cover pool on {name} after reading exactly which risks the pool backs.",
    deepen: "Buy a small cover policy for a position you actually hold elsewhere, completing both sides of the market.",
    track: "Note pool capacity and claims history monthly; cover pools reward long, claim-free underwriting.",
  },
  "Services": {
    open: "Purchase the core service of {name} once with {budget} of usage credit, through the official checkout.",
    deepen: "Use the service on a weekly cadence for a month so the account shows retained, not trial, usage.",
    track: "Keep invoices and usage reports; service platforms airdrop to paying, retained customers first.",
  },
  "InfoFi": {
    open: "Connect your accounts to {name} and stake or commit {budget} behind your first researched information position.",
    deepen: "Publish or back information consistently for a full season instead of a single viral attempt.",
    track: "Track your accuracy and mindshare scores weekly; InfoFi rewards compound on reputation, not volume.",
  },
  "Sealed Bid Auction": {
    open: "Register for the next auction on {name} and place a sealed bid funded with {budget} of bid collateral.",
    deepen: "Bid in a second auction at a different clearing range to build a complete participation record.",
    track: "Record bid, clearing price and settlement for every auction; auction platforms verify bidders from settlements.",
  },
  "Analytics": {
    open: "Subscribe to {name} with {budget} of plan credit and build one dashboard or alert you will genuinely use.",
    deepen: "Share the dashboard publicly and keep it updated weekly so it accrues real viewers.",
    track: "Export your saved queries monthly; analytics platforms reward creators whose work others rely on.",
  },
  "SoFi": {
    open: "Complete {name}'s onboarding and make a first deposit of {budget}, finishing every identity and compliance step.",
    deepen: "Use one additional product — card, savings or investing — so the account is a real customer relationship.",
    track: "Keep statements from the first month; consumer fintech drops verify accounts from their own ledgers.",
  },
};

const DEFAULT_ACTIONS: CategoryActions = {
  open: "Make a first real deposit of {budget} into {name}'s main product on {chain} through the official interface only.",
  deepen: "Repeat the core action at a second size tier and hold the position for at least one full month without churning.",
  track: "Keep a dated log of every transaction hash; when points or a snapshot are announced, your own log is the proof.",
};

function fill(template: string, name: string, chain: string, budget: number): string {
  return template
    .replaceAll("{name}", name)
    .replaceAll("{chain}", chain)
    .replaceAll("{budget}", fmtUsd(budget));
}

function buildFarmSteps(rec: ProtocolRecord, row: BoardRow): string[] {
  const budget = budgetFor(rec.tvl_usd);
  const fee = Math.max(5, Math.round(budget * 0.01));
  const chain = rec.chains[0] ?? "its main chain";
  const acts = CATEGORY_ACTIONS[rec.category] ?? DEFAULT_ACTIONS;
  const chg = rec.change_7d === null ? "n/a" : `${roundTo(rec.change_7d, 1)}%`;
  return [
    `Research ${rec.name} before funding: radar-4 implies a launch value of ${fmtUsd(row.implied_value_usd)} (band ${fmtUsd(row.band_low_usd)} to ${fmtUsd(row.band_high_usd)}) on ${fmtUsd(rec.tvl_usd)} TVL; read the docs, audits and team posts first. (cost: $0, time: about 45 minutes)`,
    `Set up a fresh wallet for ${rec.name}, fund it with ${fmtUsd(budget)} of working capital on ${chain}, and keep a separate small gas float in the same wallet. (cost: about ${fmtUsd(fee)} in bridge and gas fees, time: about 30 minutes)`,
    `${fill(acts.open, rec.name, chain, budget)} (cost: about ${fmtUsd(Math.round(budget * 0.9))} deployed plus ${fmtUsd(fee)} fees, time: about 1 hour)`,
    `${fill(acts.deepen, rec.name, chain, budget)} (cost: about ${fmtUsd(Math.round(budget * 0.1))} in extra fees and slippage, time: about 1 hour)`,
    `${fill(acts.track, rec.name, chain, budget)} (cost: $0 beyond gas already budgeted, time: about 20 minutes a week)`,
    `Review the position weekly: cap total exposure to ${rec.name} at 10% of your farming bankroll, watch its TVL trend (7d change ${chg}), and cut size if governance or unlock news turns hostile. (cost: $0, time: about 20 minutes a week)`,
    `Prepare the exit before any token launch: bookmark only the official claim and listing channels, revoke stale approvals, and plan to sell into launch liquidity in tranches rather than all at once. (cost: about ${fmtUsd(fee)} in claim gas, time: about 1 hour at launch)`,
  ];
}

// -------------------------------------------------------------------- main

function main(): void {
  const entryDir = dirname(fileURLToPath(import.meta.url));
  const inputPath = process.argv[2] ?? "/input/snapshot.json";
  const outputDir = process.argv[3] ?? "/output";

  const snapshot = JSON.parse(readFileSync(inputPath, "utf8")) as Snapshot;
  const asOfMs = Date.parse(`${snapshot.as_of}T00:00:00Z`);
  const watchlist = new Set(snapshot.watchlist);

  const peers = snapshot.protocols.filter(isPeer);
  const model = fitRadar4(peers);
  const validation = holdoutValidation(peers);

  // Residual spread of the full model over its own peers sets the band.
  const residuals = peers.map(
    (p) => Math.log(p.mcap_usd as number) - Math.log(predictRadar4(model, p)),
  );
  const rMean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  const residualSd = Math.sqrt(
    residuals.reduce((a, r) => a + (r - rMean) * (r - rMean), 0) / residuals.length,
  );
  const bandLo = Math.exp(-residualSd);
  const bandHi = Math.exp(residualSd);

  const peerCountByCategory = new Map<string, number>();
  for (const p of peers) {
    peerCountByCategory.set(p.category, (peerCountByCategory.get(p.category) ?? 0) + 1);
  }

  const rows: BoardRow[] = [];
  for (const rec of snapshot.protocols) {
    if (!isEligible(rec)) continue;
    const age = ageInDays(rec.listed_at, asOfMs);
    const sizeValue = curveValue(model.curve, rec.tvl_usd);
    const catFactor = model.factors.get(rec.category) ?? 1;
    const g = growthFactor(rec.change_7d);
    const m = maturityFactor(age);
    const c = chainFactor(rec.chains.length);
    const implied = Math.max(1, Math.round(sizeValue * catFactor * g * m * c));
    const row: BoardRow = {
      rank: 0,
      slug: rec.slug,
      name: rec.name,
      category: rec.category,
      chains: rec.chains,
      chain_count: rec.chains.length,
      tvl_usd: rec.tvl_usd,
      change_7d_pct: rec.change_7d,
      listed_at: rec.listed_at,
      age_days: age,
      watchlist: watchlist.has(rec.slug),
      peer_count: peerCountByCategory.get(rec.category) ?? 0,
      size_curve_value_usd: Math.round(sizeValue),
      category_factor: roundTo(catFactor, 4),
      growth_factor: roundTo(g, 4),
      maturity_factor: roundTo(m, 4),
      chain_factor: roundTo(c, 4),
      implied_value_usd: implied,
      band_low_usd: Math.max(1, Math.round(implied * bandLo)),
      band_high_usd: Math.round(implied * bandHi),
      farm_steps: [],
    };
    row.farm_steps = buildFarmSteps(rec, row);
    rows.push(row);
  }

  rows.sort(
    (a, b) =>
      b.implied_value_usd - a.implied_value_usd ||
      b.tvl_usd - a.tvl_usd ||
      (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  const live = snapshot.protocols
    .filter((p) => p.mcap_usd !== null)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      multiple: p.tvl_usd > 0 ? roundTo((p.mcap_usd as number) / p.tvl_usd, 4) : null,
    }))
    .sort(
      (a, b) =>
        b.mcap_usd - a.mcap_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
    );

  const payload = {
    meta: {
      as_of: snapshot.as_of,
      model: "radar-4",
      scanned: snapshot.protocols.length,
      board_rows: rows.length,
      watchlist_covered: rows.filter((r) => r.watchlist).length,
      live_token_count: live.length,
      peer_count: peers.length,
      size_curve: { alpha: roundTo(model.curve.alpha, 6), beta: roundTo(model.curve.beta, 6) },
      residual_sd: roundTo(residualSd, 6),
      validation,
    },
    rows,
    live,
  };

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "board.json"), JSON.stringify(rows, null, 2) + "\n");
  writeFileSync(join(outputDir, "data.js"), `window.RADAR = ${JSON.stringify(payload)};\n`);
  cpSync(join(entryDir, "dashboard"), join(outputDir, "dashboard"), { recursive: true });
  cpSync(join(entryDir, "screenshots"), join(outputDir, "screenshots"), { recursive: true });

  const dossier = buildDossier(outputDir, { text_max_bytes: 65536 });
  writeFileSync(join(outputDir, "dossier.json"), dossier);

  console.log(
    `radar-4: ${rows.length} rows, watchlist ${payload.meta.watchlist_covered}/${snapshot.watchlist.length}, ` +
      `peers ${peers.length}, alpha ${payload.meta.size_curve.alpha}, beta ${payload.meta.size_curve.beta}, ` +
      `holdout MedALE radar-4 ${validation.radar4.medale} vs radar-3 ${validation.radar3.medale} vs flat ${validation.flat.medale}`,
  );
}

main();
