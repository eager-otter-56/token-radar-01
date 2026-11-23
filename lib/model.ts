// radar-3: the valuation model behind the token launch radar.
//
// One sealed DefiLlama snapshot goes in; one ranked board of pre-token
// protocols comes out. Every number on the board is computed from the
// snapshot itself at run time. No protocol is named in this file and no
// category carries a hand-set multiple: the multiples are read off the
// protocols whose tokens already trade, category by category.
//
//   implied value = TVL x peer multiple x growth x maturity x breadth
//
// - peer multiple: the median market-cap / TVL ratio of the live-token
//   protocols in the same category, pulled toward the all-market median
//   with a prior weight of 3 (so a category priced by a single peer does
//   not swing the board), then clamped to [0.02, 2.5]. A category with
//   no live peers uses the all-market median.
// - growth: the 7-day TVL change, clamped to [-50, +100] percent and
//   weighted lightly: 1 + (g / 100) x 0.35. Unreported change counts 0.
// - maturity: how long the protocol has been tracked with no token:
//   0.70 + 0.30 x min(age_days, 1095) / 1095. Unknown age counts as the
//   middle of the range, 547 days.
// - breadth: 1 + 0.03 for each chain past the first, up to five extra.
//
// Eligibility is the strict reading of "a token that does not exist
// yet": a protocol qualifies only when the snapshot records no token
// for it at all (no market cap, no CoinGecko id, no symbol) and it is
// not a wrapped, staked or bridged product of one that trades — see
// isEligible below for the exact exclusions.

/** One protocol record, exactly the ten fields the snapshot carries. */
export interface ProtocolRecord {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot document. */
export interface SnapshotDoc {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: ProtocolRecord[];
  watchlist: string[];
}

/** The peer statistics one category (or the whole market) produces. */
export interface PeerStats {
  count: number;
  /** Median mcap/TVL of the live peers, after shrinkage and clamping. */
  multiple: number;
  /** The same treatment applied to the 25th percentile ratio. */
  lowMultiple: number;
  /** The same treatment applied to the 75th percentile ratio. */
  highMultiple: number;
}

/** One ranked row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  peer_multiple: number;
  peer_count: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
  implied_value_usd: number;
  band_low_usd: number;
  band_high_usd: number;
  watchlist: boolean;
  farm_steps: string[];
}

/** A protocol whose token already trades: shown apart, never ranked. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  symbol: string | null;
}

/** Everything the dashboard renders, written to data.js as window.RADAR. */
export interface RadarPayload {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  scanned: number;
  board_size: number;
  watchlist_size: number;
  watchlist_covered: number;
  live_size: number;
  global_multiple: number;
  categories: string[];
  chains: string[];
  rows: BoardRow[];
  live: LiveRow[];
}

export const MODEL_VERSION = 'radar-3';

/** How many live-token protocols the dashboard's Live view carries. */
export const LIVE_VIEW_ROWS = 24;

const MS_PER_DAY = 86_400_000;
const PRIOR_WEIGHT = 3;
const MULTIPLE_FLOOR = 0.02;
const MULTIPLE_CAP = 2.5;
const UNKNOWN_AGE_DAYS = 547;
const MATURITY_SPAN_DAYS = 1095;

/** Raised when the snapshot is not the shape this model can score. */
export class SnapshotShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotShapeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Parse and validate the snapshot text; refuses anything off-shape. */
export function parseSnapshot(text: string): SnapshotDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotShapeError('snapshot.json is not valid JSON');
  }
  if (!isRecord(raw)) throw new SnapshotShapeError('snapshot.json is not an object');
  if (typeof raw.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.as_of)) {
    throw new SnapshotShapeError('snapshot.json carries no as_of date');
  }
  if (typeof raw.source !== 'string') throw new SnapshotShapeError('snapshot.json carries no source');
  if (typeof raw.floor_usd !== 'number' || !(raw.floor_usd > 0)) {
    throw new SnapshotShapeError('snapshot.json carries no floor_usd');
  }
  if (!Array.isArray(raw.protocols)) throw new SnapshotShapeError('snapshot.json carries no protocols array');
  if (!Array.isArray(raw.watchlist) || raw.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotShapeError('snapshot.json carries no watchlist of slugs');
  }
  const protocols = raw.protocols.map((entry, i) => {
    if (!isRecord(entry)) throw new SnapshotShapeError(`protocol ${i} is not an object`);
    if (typeof entry.slug !== 'string' || typeof entry.name !== 'string') {
      throw new SnapshotShapeError(`protocol ${i} lacks a slug or a name`);
    }
    if (typeof entry.tvl_usd !== 'number' || !Number.isFinite(entry.tvl_usd)) {
      throw new SnapshotShapeError(`protocol ${i} lacks a TVL`);
    }
    return {
      slug: entry.slug,
      name: entry.name,
      category: textOrNull(entry.category),
      chains: Array.isArray(entry.chains)
        ? entry.chains.filter((c): c is string => typeof c === 'string')
        : [],
      tvl_usd: entry.tvl_usd,
      change_7d: numberOrNull(entry.change_7d),
      mcap_usd: numberOrNull(entry.mcap_usd),
      listed_at: textOrNull(entry.listed_at),
      gecko_id: textOrNull(entry.gecko_id),
      symbol: textOrNull(entry.symbol),
    };
  });
  return {
    as_of: raw.as_of,
    source: raw.source,
    floor_usd: raw.floor_usd,
    protocols,
    watchlist: raw.watchlist as string[],
  };
}

/** Whole days between the day tracking began and the snapshot's day. */
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / MS_PER_DAY));
}

/** Categories that are products of another protocol's token, not launches. */
const PRODUCT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** A release suffix in the name: the record of a pool of another protocol. */
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whole words that mark a wrapped or staked product in a name. */
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;

/** Exchange names: a name opening with one is that exchange's product. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** True when the snapshot records no token at all for the protocol. */
export function recordsNoToken(p: ProtocolRecord): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * True when the protocol may be ranked: it records no token, and it is
 * not a wrapped, staked, bridged, versioned or exchange product of a
 * protocol whose token already trades.
 */
export function isEligible(p: ProtocolRecord): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (PRODUCT_WORD.test(p.name)) return false;
  for (const prefix of EXCHANGE_PREFIXES) {
    if (p.name.startsWith(prefix)) return false;
  }
  return true;
}

function sortedRatios(peers: ProtocolRecord[]): number[] {
  return peers
    .filter((p) => p.mcap_usd !== null && p.tvl_usd > 0)
    .map((p) => (p.mcap_usd as number) / p.tvl_usd)
    .sort((a, b) => a - b);
}

/** The value at a 0..1 quantile of a sorted, non-empty array. */
function quantile(sorted: number[], q: number): number {
  const at = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[at]!;
}

function medianOf(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function clampMultiple(value: number): number {
  return Math.min(MULTIPLE_CAP, Math.max(MULTIPLE_FLOOR, value));
}

/** Shrink one raw ratio toward the market median, then clamp it. */
function shrink(raw: number, peerCount: number, globalMedian: number): number {
  return clampMultiple((peerCount * raw + PRIOR_WEIGHT * globalMedian) / (peerCount + PRIOR_WEIGHT));
}

/**
 * Peer statistics for the whole market and for every category that has
 * live peers. The market entry is keyed by the empty string.
 */
export function peerStatistics(snapshot: SnapshotDoc): Map<string, PeerStats> {
  const live = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const marketRatios = sortedRatios(live);
  const globalMedian = medianOf(marketRatios);
  const byCategory = new Map<string, ProtocolRecord[]>();
  for (const p of live) {
    const key = p.category ?? '';
    const list = byCategory.get(key);
    if (list === undefined) byCategory.set(key, [p]);
    else list.push(p);
  }
  const stats = new Map<string, PeerStats>();
  const build = (ratios: number[]): PeerStats => ({
    count: ratios.length,
    multiple: shrink(medianOf(ratios), ratios.length, globalMedian),
    lowMultiple: shrink(quantile(ratios, 0.25), ratios.length, globalMedian),
    highMultiple: shrink(quantile(ratios, 0.75), ratios.length, globalMedian),
  });
  stats.set('', build(marketRatios));
  for (const [category, peers] of byCategory) {
    if (category !== '') stats.set(category, build(sortedRatios(peers)));
  }
  return stats;
}

/** The three adjustment factors and the age behind the maturity one. */
export interface FactorSet {
  growth: number;
  maturity: number;
  breadth: number;
  ageDays: number | null;
}

/** The adjustment factors one protocol earns under radar-3. */
export function factorsFor(p: ProtocolRecord, asOf: string): FactorSet {
  const rawChange = p.change_7d ?? 0;
  const change = Math.min(100, Math.max(-50, rawChange));
  const growth = 1 + (change / 100) * 0.35;
  const ageDays = ageInDays(asOf, p.listed_at);
  const effectiveAge = ageDays ?? UNKNOWN_AGE_DAYS;
  const maturity = 0.7 + 0.3 * (Math.min(effectiveAge, MATURITY_SPAN_DAYS) / MATURITY_SPAN_DAYS);
  const breadth = 1 + 0.03 * Math.min(Math.max(p.chains.length - 1, 0), 5);
  return { growth, maturity, breadth, ageDays };
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/** Score one eligible protocol against its category's peer statistics. */
function scoreRow(
  p: ProtocolRecord,
  snapshot: SnapshotDoc,
  stats: Map<string, PeerStats>,
  watchlist: Set<string>,
): BoardRow {
  const peers = stats.get(p.category ?? '') ?? stats.get('')!;
  const f = factorsFor(p, snapshot.as_of);
  const implied = Math.max(1, Math.round(p.tvl_usd * peers.multiple * f.growth * f.maturity * f.breadth));
  let bandLow: number;
  let bandHigh: number;
  if (peers.count >= 4) {
    bandLow = Math.max(1, Math.round(p.tvl_usd * peers.lowMultiple * f.growth * f.maturity * f.breadth));
    bandHigh = Math.max(1, Math.round(p.tvl_usd * peers.highMultiple * f.growth * f.maturity * f.breadth));
  } else {
    bandLow = Math.max(1, Math.round(implied * 0.6));
    bandHigh = Math.max(1, Math.round(implied * 1.5));
  }
  return {
    rank: 0,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: [...p.chains],
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    age_days: f.ageDays,
    peer_multiple: round4(peers.multiple),
    peer_count: peers.count,
    growth_multiplier: round4(f.growth),
    maturity_multiplier: round4(f.maturity),
    chain_multiplier: round4(f.breadth),
    implied_value_usd: implied,
    band_low_usd: bandLow,
    band_high_usd: bandHigh,
    watchlist: watchlist.has(p.slug),
    farm_steps: [],
  };
}

/** The chain a farm plan works on first: the record's first named chain. */
function homeChain(p: ProtocolRecord): string {
  return p.chains.length > 0 ? p.chains[0]! : 'the chain the protocol lists first in its app';
}

/** Starter capital for one farm position, scaled to the protocol's size. */
function capitalTier(tvl: number): number {
  if (tvl >= 5_000_000_000) return 250;
  if (tvl >= 1_000_000_000) return 150;
  if (tvl >= 100_000_000) return 100;
  return 50;
}

/** Days a position must rest to count in more than one weekly snapshot. */
function holdWindow(ageDays: number | null): number {
  if (ageDays === null) return 30;
  if (ageDays < 180) return 60;
  if (ageDays < 365) return 45;
  return 30;
}

interface CategoryActions {
  core: string;
  second: string;
  weekly: string;
}

/**
 * The hands-on actions for one category, in a farmer's words. The two
 * placeholders {cap} and {chain} are filled from the protocol's record.
 */
function actionsFor(category: string | null): CategoryActions {
  switch (category) {
    case 'Lending':
      return {
        core: 'Supply ${cap} of USDC as collateral in a {name} lending market on {chain}',
        second: 'Borrow about 30 percent of the supplied value in the same market, then repay it in full a week later',
        weekly: 'rebalance the collateral so the health factor stays above 1.6',
      };
    case 'Dexs':
      return {
        core: 'Add ${cap} of liquidity, split evenly between the two assets, to the busiest {name} pool on {chain}',
        second: 'Route three small swaps through {name} itself instead of an aggregator, one in each of the first three weeks',
        weekly: 'collect the accrued fees and re-deposit them into the same pool',
      };
    case 'Derivatives':
    case 'Perpetuals':
      return {
        core: 'Deposit ${cap} of USDC as margin on {name} and open one small hedged position, long and short in equal size',
        second: 'Close and reopen the hedge once after a week so the account shows two separate trading sessions',
        weekly: 'top the margin back up to the starting amount if funding payments have drawn it down',
      };
    case 'CDP':
    case 'CDP Manager':
      return {
        core: 'Lock ${cap} of collateral in a {name} vault on {chain} and mint about 40 percent of its value in the protocol stablecoin',
        second: 'Hold the minted stablecoin for a week, then repay half of it and mint again so the vault shows two mint cycles',
        weekly: 'check the vault collateral ratio and add collateral if it drifts toward the liquidation line',
      };
    case 'Yield':
    case 'Yield Aggregator':
      return {
        core: 'Deposit ${cap} of USDC into the main {name} vault on {chain} and keep the vault shares in the farming wallet',
        second: 'After two weeks, move a quarter of the position into a second {name} vault so both vaults record the wallet',
        weekly: 'harvest any claimable yield and compound it back into the first vault',
      };
    case 'Leveraged Farming':
    case 'Farm':
      return {
        core: 'Open a ${cap} leveraged farm position on {name} at the lowest leverage offered, on {chain}',
        second: 'Close the position after ten days and reopen it once, so the farm records two full position cycles',
        weekly: 'check the liquidation distance and add collateral whenever it falls below the level the app marks safe',
      };
    case 'Risk Curators':
      return {
        core: 'Deposit ${cap} of USDC into a vault curated through {name} on {chain} and keep the vault shares untouched',
        second: 'Split a second, smaller deposit across a different {name} curated vault so two curators record the wallet',
        weekly: 'review the vault allocation page and move the position if the curator shifts it into a market you do not recognise',
      };
    case 'Onchain Capital Allocator':
      return {
        core: 'Allocate ${cap} of USDC through {name} into its main on-chain strategy on {chain} and hold the position shares',
        second: 'Make one further allocation of about a quarter of the first amount after two weeks, building a deposit history',
        weekly: 'read the strategy report the protocol publishes and confirm the allocation is still deployed, not idle',
      };
    case 'RWA':
      return {
        core: 'Mint ${cap} of the real-world-asset token {name} issues on {chain}, completing its onboarding checks first',
        second: 'Hold the asset token through one full yield distribution so the wallet appears in a payout snapshot',
        weekly: 'confirm the asset token balance is unchanged and note the distribution date in the farm log',
      };
    case 'Insurance':
      return {
        core: 'Buy ${cap} of cover from {name} against a lending position you already hold, for the longest term offered',
        second: 'Stake a further small amount into the {name} cover pool so the wallet also appears on the underwriting side',
        weekly: 'check the cover is still active and renew it before the term lapses',
      };
    case 'Basis Trading':
      return {
        core: 'Deposit ${cap} of USDC into the {name} basis vault on {chain}, which runs the hedged position for you',
        second: 'After two weeks add a second deposit of about a quarter of the first, so the vault records repeat use',
        weekly: 'compare the vault share price with the deposit value and note the funding carry in the farm log',
      };
    case 'Restaking':
      return {
        core: 'Restake ${cap} of the liquid staking token {name} accepts, on {chain}, and keep the restaking receipt',
        second: 'Delegate the restaked position to one of the operators {name} lists, choosing one with a long running record',
        weekly: 'check the operator is still active and the restaked balance has not been slashed',
      };
    case 'Chain':
      return {
        core: 'Bridge ${cap} of USDC to the {name} chain and hold it in the farming wallet as native gas money and deposits',
        second: 'Use two different applications on the {name} chain in the first week, paying gas from the bridged funds',
        weekly: 'make one transaction on the chain, a transfer or an app interaction, so every week shows activity',
      };
    case 'Payments':
      return {
        core: 'Fund a {name} account with ${cap} and route one real payment of about a fifth of it through the service',
        second: 'Make a second payment to a different recipient a week later, so the account shows repeat, varied use',
        weekly: 'keep the account funded and make one small payment or top-up',
      };
    case 'Stablecoin':
    case 'Dual-Token Stablecoin':
    case 'Stablecoin Wrapper':
      return {
        core: 'Mint ${cap} of the {name} stable asset against USDC collateral on {chain} and hold the minted balance',
        second: 'Provide a quarter of the minted amount as liquidity beside the stable asset in its main pool',
        weekly: 'check the stable asset still trades at its peg and note any drift in the farm log',
      };
    case 'Liquidity Manager':
      return {
        core: 'Deposit ${cap} of liquidity into a {name} managed position on {chain} and keep the position receipt',
        second: 'After two weeks shift a quarter of the deposit into a second {name} range or pool',
        weekly: 'check the managed range is still in range and earning fees, and note the fee total',
      };
    default:
      return {
        core: 'Deposit ${cap} of USDC into {name} on {chain} through its own app and keep the position open',
        second: 'Repeat the core action once more after two weeks with about a quarter of the first amount',
        weekly: 'make one small interaction in the app, a deposit top-up, a claim or a vote',
      };
  }
}

/**
 * One protocol's farm plan: seven steps, each a concrete action with
 * its cost and its time stated in the step itself. Every figure comes
 * from the protocol's own record — its category, its first chain, its
 * TVL tier and its age — never from a list of names.
 */
export function farmPlan(p: ProtocolRecord, ageDays: number | null): string[] {
  const chain = homeChain(p);
  const capital = capitalTier(p.tvl_usd);
  const hold = holdWindow(ageDays);
  const gas = capital >= 150 ? 8 : 4;
  const act = actionsFor(p.category);
  const fill = (template: string): string =>
    template.split('{name}').join(p.name).split('{chain}').join(chain).split('{cap}').join(String(capital));
  return [
    `Set up one fresh wallet for ${p.name} alone and write its seed phrase on paper kept offline. Cost: $0 in funds, about $${gas} of gas for its first transaction. Time: 10 minutes, once.`,
    `${fill(act.core)}. Cost: $${capital} of capital plus about $${gas} in gas. Time: 20 minutes to set up.`,
    `${fill(act.second)}. Cost: about $${gas} in gas, with no new capital beyond the first position. Time: 15 minutes.`,
    `Once a week, ${fill(act.weekly)}. Cost: about $2 in gas each week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days without withdrawing, so the activity appears in more than one weekly snapshot. Cost: the $${capital} stays committed for the full ${hold} days. Time: ${hold} days.`,
    `Open the points or rewards page that ${p.name} itself publishes and claim only through the link it gives; never pay a fee to claim. Cost: $0 to check, and walk away from any page that asks for payment. Time: 10 minutes.`,
    `Write the wallet address, every date, amount and transaction hash in a farm log, and set the exit: withdraw after the ${hold} days unless a launch is announced. Cost: $0. Time: 15 minutes at the start and 5 minutes a week.`,
  ];
}

/** The ranked board: every eligible protocol, best implied value first. */
export function buildBoard(snapshot: SnapshotDoc): BoardRow[] {
  const stats = peerStatistics(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const rows = snapshot.protocols
    .filter(isEligible)
    .map((p) => scoreRow(p, snapshot, stats, watchlist));
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  rows.forEach((row, i) => {
    row.rank = i + 1;
    const source = bySlug.get(row.slug)!;
    row.farm_steps = farmPlan(source, row.age_days);
  });
  return rows;
}

/** The live-token protocols, set aside: the market's values, not the model's. */
export function buildLive(snapshot: SnapshotDoc): LiveRow[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null)
    .sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number) || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_VIEW_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: [...p.chains],
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      change_7d: p.change_7d,
      symbol: p.symbol,
    }));
}

/** The full dashboard payload: board, live set, and the filter vocabularies. */
export function buildRadar(snapshot: SnapshotDoc): RadarPayload {
  const rows = buildBoard(snapshot);
  const live = buildLive(snapshot);
  const stats = peerStatistics(snapshot);
  const categories = [...new Set(rows.map((r) => r.category ?? 'Uncategorised'))].sort();
  const chains = [...new Set(rows.flatMap((r) => r.chains))].sort();
  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    scanned: snapshot.protocols.length,
    board_size: rows.length,
    watchlist_size: snapshot.watchlist.length,
    watchlist_covered: rows.filter((r) => r.watchlist).length,
    live_size: snapshot.protocols.filter((p) => p.mcap_usd !== null).length,
    global_multiple: round4(stats.get('')!.multiple),
    categories,
    chains,
    rows,
    live,
  };
}

/**
 * Why a board fails the gate, or null when it passes: coverage, exact
 * ranks, value order, and every farm step inside its length limits.
 */
export function boardIssue(rows: BoardRow[], snapshot: SnapshotDoc): string | null {
  if (rows.length < 100 || rows.length > 4000) return `the board holds ${rows.length} rows, outside 100..4000`;
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.slug)) return `slug ${row.slug} appears twice`;
    seen.add(row.slug);
  }
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `the board misses watchlist protocol ${slug}`;
  }
  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is missing or duplicated`;
  }
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) {
      return `row ${byRank[i]!.slug} outranks ${byRank[i - 1]!.slug} on implied value`;
    }
  }
  if (byRank.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return 'every row carries the same implied value: that is not a ranking';
  }
  for (const row of rows) {
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
      return `${row.slug} has implied value ${row.implied_value_usd}`;
    }
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `${row.slug} has ${row.farm_steps.length} farm steps`;
    }
    for (const step of row.farm_steps) {
      const length = step.trim().length;
      if (length < 20 || length > 600) return `${row.slug} has a farm step of ${length} characters`;
    }
  }
  return null;
}

/** The data.js script the dashboard loads: the whole payload, no fetch. */
export function dataScript(payload: RadarPayload): string {
  return `window.RADAR=${JSON.stringify(payload)};\n`;
}
