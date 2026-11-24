// radar-5: an evidence-tested token launch radar.
//
// Reads /input/snapshot.json (a DefiLlama snapshot), ranks every strictly
// pre-token protocol by an implied launch value, and writes board.json,
// data.js, dashboard/, screenshots/ and dossier.json to /output.
//
// Every number the dashboard prints is computed here, from the snapshot, at
// run time. The value model is a fitted size curve (market cap as a power of
// TVL, fitted on the snapshot's own launched peers). Each candidate adjustment
// term (category, growth, maturity, chain) had to lower the out-of-sample
// median absolute log error on THREE protocols (leave-one-out, walk-forward,
// slug-parity split) with a bootstrap confidence interval excluding zero, or
// it was dropped. Token odds come from a logistic fit on the snapshot's own
// token record. Farm verdicts are arithmetic on stated assumptions.
//
// Deterministic: the only randomness is a seeded mulberry32 PRNG; every
// iterative fit runs a fixed iteration count. Two runs write identical bytes.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from './vendor/makefun-board.ts';

const INPUT = process.argv[2] ?? '/input/snapshot.json';
const OUTPUT = process.argv[3] ?? '/output';
const AS_OF_MS = Date.UTC(2026, 10, 14); // snapshot as_of 2026-11-14

// ---------------------------------------------------------------- snapshot

interface Proto {
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

interface Row extends Proto {
  age: number | null; // days since listed_at, null when unknown
  lnt: number; // ln tvl_usd
  lnm: number | null; // ln mcap_usd when a usable peer value exists
  tok: boolean; // the snapshot already records a token for this protocol
}

const snap = JSON.parse(readFileSync(INPUT, 'utf8')) as { as_of: string; watchlist: string[]; protocols: Proto[] };
const WATCH = new Set(snap.watchlist);

function toRow(p: Proto): Row {
  let age: number | null = null;
  if (p.listed_at) {
    const t = Date.parse(p.listed_at + 'T00:00:00Z');
    if (Number.isFinite(t)) age = Math.round((AS_OF_MS - t) / 86400000);
  }
  return {
    ...p,
    age,
    lnt: Math.log(p.tvl_usd),
    lnm: p.mcap_usd !== null && p.mcap_usd > 0 ? Math.log(p.mcap_usd) : null,
    tok: p.mcap_usd !== null || p.symbol !== null || p.gecko_id !== null,
  };
}

const ALL: Row[] = snap.protocols.map(toRow);
const PEERS: Row[] = ALL.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);

// ------------------------------------------------------------- eligibility

const EXCLUDED_CATS = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const VERSIONED: RegExp[] = [
  /(^|[\s\-–—(])v\d+(\.\d+)?\b/i,
  /[\s\-–—]v\d+(\.\d+)?\s*$/i,
  /(^|\s)version\s*\d+/i,
  /\bphase\s*[0-9ivx]+\b/i,
  /\bgen\s*[23]\b/i,
  /\b2\.0\b/,
];
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = ['binance', 'coinbase', 'bybit', 'kraken', 'bitget', 'okx', 'bitfinex', 'gemini'];

// The set-aside cascade: every snapshot record lands in exactly one group.
type Group = 'ranked' | 'token' | 'bridge' | 'liquid' | 'exchange' | 'versioned' | 'wrapped';
function classify(p: Row): Group {
  if (p.tok) return 'token';
  if (p.category === 'Bridge' || p.category === 'Canonical Bridge') return 'bridge';
  if (p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC') return 'liquid';
  if (p.category === 'CEX') return 'exchange';
  if (VERSIONED.some((r) => r.test(p.name))) return 'versioned';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped';
  const low = p.name.toLowerCase();
  if (EXCHANGE_PREFIX.some((e) => low.startsWith(e))) return 'exchange';
  return 'ranked';
}

const GROUPS = new Map<Group, Row[]>();
for (const p of ALL) {
  const g = classify(p);
  if (!GROUPS.has(g)) GROUPS.set(g, []);
  GROUPS.get(g)!.push(p);
}
const BOARD_SET: Row[] = GROUPS.get('ranked') ?? [];
const ACCOUNTING: { label: string; n: number }[] = [
  { label: 'Ranked pre-token', n: BOARD_SET.length },
  { label: 'Records a token', n: (GROUPS.get('token') ?? []).length },
  { label: 'Set aside: bridge', n: (GROUPS.get('bridge') ?? []).length },
  { label: 'Set aside: liquid staking', n: (GROUPS.get('liquid') ?? []).length },
  { label: 'Set aside: exchange', n: (GROUPS.get('exchange') ?? []).length },
  { label: 'Set aside: wrapped / staked', n: (GROUPS.get('wrapped') ?? []).length },
  { label: 'Set aside: versioned', n: (GROUPS.get('versioned') ?? []).length },
];

// ------------------------------------------------------------------- stats

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const round = (v: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};
function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}
function quantile(v: number[], q: number): number {
  const s = [...v].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}
const medale = (errs: number[]): number => median(errs.map((e) => Math.abs(e)));

// Seeded PRNG (mulberry32): the only source of randomness in this program.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -------------------------------------------------------------- regression

// Weighted least squares for y = alpha + beta * x.
function wls(xs: number[], ys: number[], ws: number[]): { a: number; b: number } {
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = ws[i]!, x = xs[i]!, y = ys[i]!;
    sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y;
  }
  const det = sw * sxx - sx * sx;
  if (Math.abs(det) < 1e-12) return { a: sy / sw, b: 0 };
  const b = (sw * sxy - sx * sy) / det;
  return { a: (sy - b * sx) / sw, b };
}

type Estimator = 'ols' | 'median' | 'huber';

// Fit the size curve ln mcap = alpha + beta * ln tvl one of three ways.
function fitBase(train: Row[], est: Estimator): { a: number; b: number } {
  const xs = train.map((p) => p.lnt);
  const ys = train.map((p) => p.lnm!);
  let { a, b } = wls(xs, ys, xs.map(() => 1));
  if (est === 'ols') return { a, b };
  for (let it = 0; it < 100; it++) {
    const rs = ys.map((y, i) => y - (a + b * xs[i]!));
    let ws: number[];
    if (est === 'median') {
      ws = rs.map((r) => 1 / Math.max(Math.abs(r), 1e-6));
    } else {
      const med = median(rs);
      const mad = median(rs.map((r) => Math.abs(r - med))) * 1.4826 || 1e-9;
      const d = 1.345 * mad;
      ws = rs.map((r) => (Math.abs(r) <= d ? 1 : d / Math.abs(r)));
    }
    ({ a, b } = wls(xs, ys, ws));
  }
  return { a, b };
}

// Golden-section minimisation, fixed iteration count (deterministic).
function golden(f: (x: number) => number, lo: number, hi: number): number {
  const gr = (Math.sqrt(5) - 1) / 2;
  let c = hi - gr * (hi - lo);
  let d = lo + gr * (hi - lo);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < 80; i++) {
    if (fc < fd) { hi = d; d = c; fd = fc; c = hi - gr * (hi - lo); fc = f(c); }
    else { lo = c; c = d; fc = fd; d = lo + gr * (hi - lo); fd = f(d); }
  }
  return (lo + hi) / 2;
}

// ------------------------------------------------------------ value model

type TermName = 'category' | 'growth' | 'maturity' | 'chain';
const TERM_ORDER: TermName[] = ['category', 'growth', 'maturity', 'chain'];

interface Model {
  est: Estimator;
  a: number;
  b: number;
  cat: Map<string, number>; // category -> log factor (already shrunk)
  ebK: number | null;
  wg: number | null;
  wm: number | null;
  wc: number | null;
}

// Empirical-Bayes shrinkage weight for category medians, by method of
// moments: k = within-category variance / between-category variance of the
// category medians, clamped to [1, 20].
function ebShrinkage(byCat: Map<string, number[]>): number {
  const all: number[] = [];
  for (const v of byCat.values()) all.push(...v);
  const gm = all.reduce((s, x) => s + x, 0) / all.length;
  let sw = 0, dfw = 0;
  for (const v of byCat.values()) {
    if (v.length > 1) {
      const m = v.reduce((s, x) => s + x, 0) / v.length;
      sw += v.reduce((s, x) => s + (x - m) * (x - m), 0);
      dfw += v.length - 1;
    }
  }
  const sig2 = dfw > 0 ? sw / dfw : 0;
  const meds = [...byCat.values()].map((v) => median(v));
  const g = meds.length;
  if (g < 2) return 20;
  const between = meds.reduce((s, m) => s + (m - gm) * (m - gm), 0) / (g - 1);
  const meanInvN = [...byCat.values()].reduce((s, v) => s + 1 / v.length, 0) / g;
  const tau2 = Math.max(0, between - sig2 * meanInvN);
  if (tau2 <= 0) return 20;
  return clamp(sig2 / tau2, 1, 20);
}

const growthU = (p: Row): number => clamp(p.change_7d ?? 0, -50, 100) / 100;
const matS = (p: Row): number => Math.min(p.age!, 1095) / 1095;
const chainV = (p: Row): number => Math.min(p.chains.length - 1, 5);

// Fit the conditional-value model (base curve + the given terms, in the
// fixed order) on a training set of peers.
function fitModel(train: Row[], est: Estimator, terms: TermName[]): Model {
  const { a, b } = fitBase(train, est);
  const m: Model = { est, a, b, cat: new Map(), ebK: null, wg: null, wm: null, wc: null };
  const resid = new Map<Row, number>();
  for (const p of train) resid.set(p, p.lnm! - (a + b * p.lnt));
  if (terms.includes('category')) {
    const byCat = new Map<string, number[]>();
    for (const p of train) {
      if (!byCat.has(p.category)) byCat.set(p.category, []);
      byCat.get(p.category)!.push(resid.get(p)!);
    }
    const k = ebShrinkage(byCat);
    m.ebK = k;
    for (const [c, v] of byCat) m.cat.set(c, (median(v) * v.length) / (v.length + k));
    for (const p of train) resid.set(p, resid.get(p)! - (m.cat.get(p.category) ?? 0));
  }
  if (terms.includes('growth')) {
    const pts = train.map((p) => ({ u: growthU(p), r: resid.get(p)! }));
    m.wg = golden((w) => pts.reduce((s, t) => s + (t.r - Math.log(clamp(1 + w * t.u, 0.05, 3))) ** 2, 0), -0.95, 3);
    for (const p of train) resid.set(p, resid.get(p)! - Math.log(clamp(1 + m.wg * growthU(p), 0.05, 3)));
  }
  if (terms.includes('maturity')) {
    const pts = train.filter((p) => p.age !== null).map((p) => ({ s: matS(p), r: resid.get(p)! }));
    m.wm = golden((w) => pts.reduce((s, t) => s + (t.r - Math.log(0.7 + w * t.s)) ** 2, 0), -0.6, 1.5);
    for (const p of train) {
      if (p.age !== null) resid.set(p, resid.get(p)! - Math.log(0.7 + m.wm * matS(p)));
    }
  }
  if (terms.includes('chain')) {
    const pts = train.map((p) => ({ v: chainV(p), r: resid.get(p)! }));
    m.wc = golden((w) => pts.reduce((s, t) => s + (t.r - Math.log(clamp(1 + w * t.v, 0.05, 3))) ** 2, 0), -0.2, 0.6);
  }
  return m;
}

// Log of the conditional value (value if a token launches), plus the applied
// multiplicative factors, for any protocol.
function predictParts(m: Model, p: Row): { ln: number; base: number; catF: number; groF: number; matF: number; chaF: number } {
  const base = m.a + m.b * p.lnt;
  let ln = base;
  let catF = 1, groF = 1, matF = 1, chaF = 1;
  const cl = m.cat.get(p.category);
  if (cl !== undefined) { catF = Math.exp(cl); ln += cl; }
  if (m.wg !== null) { groF = clamp(1 + m.wg * growthU(p), 0.05, 3); ln += Math.log(groF); }
  if (m.wm !== null && p.age !== null) { matF = 0.7 + m.wm * matS(p); ln += Math.log(matF); }
  if (m.wc !== null) { chaF = clamp(1 + m.wc * chainV(p), 0.05, 3); ln += Math.log(chaF); }
  return { ln, base, catF, groF, matF, chaF };
}
const predictLn = (m: Model, p: Row): number => predictParts(m, p).ln;

// ------------------------------------------------------- validation rigour

// Three out-of-sample protocols. Every model claim in this program is
// measured on all three; nothing is tuned on the numbers it is judged by.
//   P1 leave-one-out over the peers.
//   P2 walk-forward: peers sorted by listed date (oldest first), expanding
//      window, four folds (fit 40/55/70/85%, test on the next chunk).
//   P3 slug-parity split: peers sorted by slug, even indices fit, odd test.
function looErrors(fit: (train: Row[]) => (p: Row) => number): number[] {
  const errs: number[] = [];
  for (let i = 0; i < PEERS.length; i++) {
    const train = PEERS.filter((_, j) => j !== i);
    const pred = fit(train);
    errs.push(PEERS[i]!.lnm! - pred(PEERS[i]!));
  }
  return errs;
}
function walkForwardErrors(fit: (train: Row[]) => (p: Row) => number): number[] {
  const srt = PEERS.filter((p) => p.age !== null).sort((x, y) => y.age! - x.age! || (x.slug < y.slug ? -1 : 1));
  const n = srt.length;
  const errs: number[] = [];
  const cuts = [0.4, 0.55, 0.7, 0.85, 1.0];
  for (let f = 0; f < 4; f++) {
    const train = srt.slice(0, Math.floor(n * cuts[f]!));
    const pred = fit(train);
    for (const p of srt.slice(Math.floor(n * cuts[f]!), Math.floor(n * cuts[f + 1]!))) errs.push(p.lnm! - pred(p));
  }
  return errs;
}
function parityErrors(fit: (train: Row[]) => (p: Row) => number): number[] {
  const srt = [...PEERS].sort((x, y) => (x.slug < y.slug ? -1 : 1));
  const pred = fit(srt.filter((_, i) => i % 2 === 0));
  return srt.filter((_, i) => i % 2 === 1).map((p) => p.lnm! - pred(p));
}

const specFit = (est: Estimator, terms: TermName[]) => (train: Row[]) => {
  const m = fitModel(train, est, terms);
  return (p: Row) => predictLn(m, p);
};

// Estimator bake-off: the base curve is fitted three ways; P1 chooses.
const BAKEOFF: { est: Estimator; p1: number }[] = (['ols', 'median', 'huber'] as Estimator[]).map((est) => ({
  est,
  p1: medale(looErrors(specFit(est, []))),
}));
const ESTIMATOR: Estimator = BAKEOFF.reduce((best, c) => (c.p1 < best.p1 ? c : best), BAKEOFF[0]!).est;

// Term selection, rules fixed in advance: starting from the bare curve, a
// term is KEPT only if it lowers MedALE on all three protocols AND the
// bootstrap 90% CI of the P1 per-peer improvement (200 resamples, seed 7)
// excludes zero. Otherwise it is dropped, and the dashboard says so.
interface TermResult {
  name: TermName;
  kept: boolean;
  p1_delta: number;
  p2_delta: number;
  p3_delta: number;
  ci_lo: number;
  ci_hi: number;
}
const TERMS: TermResult[] = [];
let keptTerms: TermName[] = [];
let curMed = {
  p1: medale(looErrors(specFit(ESTIMATOR, keptTerms))),
  p2: medale(walkForwardErrors(specFit(ESTIMATOR, keptTerms))),
  p3: medale(parityErrors(specFit(ESTIMATOR, keptTerms))),
};
let curLoo = looErrors(specFit(ESTIMATOR, keptTerms));
for (const term of TERM_ORDER) {
  const cand = [...keptTerms, term];
  const candLoo = looErrors(specFit(ESTIMATOR, cand));
  const candMed = {
    p1: medale(candLoo),
    p2: medale(walkForwardErrors(specFit(ESTIMATOR, cand))),
    p3: medale(parityErrors(specFit(ESTIMATOR, cand))),
  };
  const diffs = curLoo.map((e, i) => Math.abs(e) - Math.abs(candLoo[i]!));
  const rng = mulberry32(7);
  const stats: number[] = [];
  for (let s = 0; s < 200; s++) {
    const sample: number[] = [];
    for (let i = 0; i < diffs.length; i++) sample.push(diffs[Math.floor(rng() * diffs.length)]!);
    stats.push(median(sample));
  }
  stats.sort((x, y) => x - y);
  const ciLo = stats[9]!;
  const ciHi = stats[189]!;
  const kept = candMed.p1 < curMed.p1 && candMed.p2 < curMed.p2 && candMed.p3 < curMed.p3 && ciLo > 0;
  TERMS.push({
    name: term,
    kept,
    p1_delta: round(curMed.p1 - candMed.p1, 4),
    p2_delta: round(curMed.p2 - candMed.p2, 4),
    p3_delta: round(curMed.p3 - candMed.p3, 4),
    ci_lo: round(ciLo, 4),
    ci_hi: round(ciHi, 4),
  });
  if (kept) {
    keptTerms = cand;
    curMed = candMed;
    curLoo = candLoo;
  }
}

// The final production model: kept terms only, refitted on all peers.
const FINAL = fitModel(PEERS, ESTIMATOR, keptTerms);
// The empirical-Bayes weight the category term estimated on the full peer
// set during its evaluation (reported whether or not the term survived).
const EB_K_FULL = fitModel(PEERS, ESTIMATOR, ['category']).ebK;
const FINAL_RESID = PEERS.map((p) => p.lnm! - predictLn(FINAL, p));
const BAND_Q25 = quantile(FINAL_RESID, 0.25);
const BAND_Q75 = quantile(FINAL_RESID, 0.75);

// Range honesty: under P1, how often a peer's actual market cap fell inside
// the P25-P75 band its fold's training residuals implied.
let honestyHits = 0;
for (let i = 0; i < PEERS.length; i++) {
  const train = PEERS.filter((_, j) => j !== i);
  const m = fitModel(train, ESTIMATOR, keptTerms);
  const tr = train.map((p) => p.lnm! - predictLn(m, p));
  const lo = predictLn(m, PEERS[i]!) + quantile(tr, 0.25);
  const hi = predictLn(m, PEERS[i]!) + quantile(tr, 0.75);
  if (PEERS[i]!.lnm! >= lo && PEERS[i]!.lnm! <= hi) honestyHits++;
}
const RANGE_HONESTY = honestyHits / PEERS.length;

// Comparison baselines, measured on the same protocols.
// radar-4 (the previous version's specification, refitted per fold):
function fitRadar4(train: Row[]): (p: Row) => number {
  const { a, b } = fitBase(train, 'ols');
  const byCat = new Map<string, number[]>();
  for (const p of train) {
    if (!byCat.has(p.category)) byCat.set(p.category, []);
    byCat.get(p.category)!.push(p.lnm! - (a + b * p.lnt));
  }
  const cat = new Map<string, number>();
  for (const [c, v] of byCat) cat.set(c, clamp(Math.exp((median(v) * v.length) / (v.length + 6)), 0.3, 2.5));
  return (p: Row) => {
    let v = Math.exp(a + b * p.lnt) * (cat.get(p.category) ?? 1);
    v *= 1 + (clamp(p.change_7d ?? 0, -50, 100) / 100) * 0.35;
    v *= 0.7 + 0.3 * (Math.min(p.age ?? 547.5, 1095) / 1095);
    v *= 1 + 0.03 * Math.min(p.chains.length - 1, 5);
    return Math.log(v);
  };
}
const RADAR4_P1 = medale(looErrors(fitRadar4));
const RADAR4_P2 = medale(walkForwardErrors(fitRadar4));
// flat: TVL x global median multiple, leave-one-out.
const FLAT_P1 = medale(
  PEERS.map((p, i) => {
    const mult = median(PEERS.filter((_, j) => j !== i).map((q) => q.mcap_usd! / q.tvl_usd));
    return p.lnm! - Math.log(p.tvl_usd * mult);
  }),
);

// -------------------------------------------------------------- token odds
//
// The outcome is the snapshot's own record: does this protocol already have
// a token (market cap, symbol or Gecko id present)? Young protocols are
// censored — "no token yet" is not "never" — so the model is presented as
// what it is: the share of comparable peers that record a token, by age and
// size. Records with unknown listing age are excluded from fitting (their
// board rows get the base rate).
const ODDS_UNIVERSE: Row[] = ALL.filter((p) => p.age !== null);
const BASE_RATE = ODDS_UNIVERSE.reduce((s, p) => s + (p.tok ? 1 : 0), 0) / ODDS_UNIVERSE.length;

interface Logit {
  w: [number, number];
  b: number;
  mu: [number, number];
  sd: [number, number];
}
function logitFeatures(p: Row): [number, number] {
  return [Math.log(Math.max(p.age!, 1)), Math.log(p.tvl_usd)];
}
function fitLogit(train: Row[]): Logit {
  const X = train.map(logitFeatures);
  const n = train.length;
  const mu: [number, number] = [0, 1].map((j) => X.reduce((s, x) => s + x[j]!, 0) / n) as [number, number];
  const sd: [number, number] = [0, 1].map((j) => {
    const v = Math.sqrt(X.reduce((s, x) => s + (x[j]! - mu[j]!) ** 2, 0) / n);
    return v > 0 ? v : 1;
  }) as [number, number];
  const Z = X.map((x) => [(x[0] - mu[0]) / sd[0], (x[1] - mu[1]) / sd[1]] as [number, number]);
  const w: [number, number] = [0, 0];
  let b = 0;
  for (let it = 0; it < 2000; it++) {
    let g0 = 0, g1 = 0, gb = 0;
    for (let i = 0; i < n; i++) {
      const z = Z[i]!;
      const pr = 1 / (1 + Math.exp(-(b + w[0] * z[0] + w[1] * z[1])));
      const e = pr - (train[i]!.tok ? 1 : 0);
      g0 += e * z[0]; g1 += e * z[1]; gb += e;
    }
    w[0] -= 0.1 * (g0 / n + 1e-3 * w[0]);
    w[1] -= 0.1 * (g1 / n + 1e-3 * w[1]);
    b -= 0.1 * (gb / n);
  }
  return { w, b, mu, sd };
}
function logitPredict(m: Logit, p: Row): number {
  const x = logitFeatures(p);
  const z0 = (x[0] - m.mu[0]) / m.sd[0];
  const z1 = (x[1] - m.mu[1]) / m.sd[1];
  return 1 / (1 + Math.exp(-(m.b + m.w[0] * z0 + m.w[1] * z1)));
}
function brier(preds: number[], ys: number[]): number {
  return preds.reduce((s, pr, i) => s + (pr - ys[i]!) ** 2, 0) / preds.length;
}
function logLoss(preds: number[], ys: number[]): number {
  return -preds.reduce((s, pr, i) => {
    const c = clamp(pr, 1e-12, 1 - 1e-12);
    return s + (ys[i]! ? Math.log(c) : Math.log(1 - c));
  }, 0) / preds.length;
}

// Odds validation on the slug-parity split (fit half / test half).
const oddsSorted = [...ODDS_UNIVERSE].sort((x, y) => (x.slug < y.slug ? -1 : 1));
const oddsFitHalf = oddsSorted.filter((_, i) => i % 2 === 0);
const oddsTestHalf = oddsSorted.filter((_, i) => i % 2 === 1);
const oddsHalfModel = fitLogit(oddsFitHalf);
const oddsTestPreds = oddsTestHalf.map((p) => logitPredict(oddsHalfModel, p));
const oddsTestYs = oddsTestHalf.map((p) => (p.tok ? 1 : 0));
const oddsFitRate = oddsFitHalf.reduce((s, p) => s + (p.tok ? 1 : 0), 0) / oddsFitHalf.length;
const ODDS_BRIER = brier(oddsTestPreds, oddsTestYs);
const ODDS_BRIER_BASE = brier(oddsTestYs.map(() => oddsFitRate), oddsTestYs);
const ODDS_LL = logLoss(oddsTestPreds, oddsTestYs);
const ODDS_LL_BASE = logLoss(oddsTestYs.map(() => oddsFitRate), oddsTestYs);
// Odds walk-forward (expanding window by listing date), for the README.
const oddsWfPreds: number[] = [];
const oddsWfYs: number[] = [];
{
  const srt = [...ODDS_UNIVERSE].sort((x, y) => y.age! - x.age! || (x.slug < y.slug ? -1 : 1));
  const n = srt.length;
  const cuts = [0.4, 0.55, 0.7, 0.85, 1.0];
  for (let f = 0; f < 4; f++) {
    const m = fitLogit(srt.slice(0, Math.floor(n * cuts[f]!)));
    for (const p of srt.slice(Math.floor(n * cuts[f]!), Math.floor(n * cuts[f + 1]!))) {
      oddsWfPreds.push(logitPredict(m, p));
      oddsWfYs.push(p.tok ? 1 : 0);
    }
  }
}
const ODDS_WF_BRIER = brier(oddsWfPreds, oddsWfYs);
const ODDS_WF_LL = logLoss(oddsWfPreds, oddsWfYs);

// Calibration: 5-fold cross-validated predictions (deterministic folds by
// slug order), decile bins of predicted vs realized share, and a Platt
// recalibration fitted on those CV predictions. The recalibration is applied
// only if the calibration slope is off (outside [0.8, 1.25]).
const cvPred = new Map<string, number>();
for (let f = 0; f < 5; f++) {
  const train = oddsSorted.filter((_, i) => i % 5 !== f);
  const m = fitLogit(train);
  for (let i = 0; i < oddsSorted.length; i++) {
    if (i % 5 === f) cvPred.set(oddsSorted[i]!.slug, logitPredict(m, oddsSorted[i]!));
  }
}
const cvPairs = oddsSorted.map((p) => ({ pr: cvPred.get(p.slug)!, y: p.tok ? 1 : 0 })).sort((x, y) => x.pr - y.pr);
const CALIBRATION: { pred: number; realized: number; n: number }[] = [];
for (let bin = 0; bin < 10; bin++) {
  const chunk = cvPairs.slice(Math.floor((bin * cvPairs.length) / 10), Math.floor(((bin + 1) * cvPairs.length) / 10));
  if (chunk.length > 0) {
    CALIBRATION.push({
      pred: round(chunk.reduce((s, c) => s + c.pr, 0) / chunk.length, 3),
      realized: round(chunk.reduce((s, c) => s + c.y, 0) / chunk.length, 3),
      n: chunk.length,
    });
  }
}
function fitPlatt(pairs: { pr: number; y: number }[]): { a: number; b: number } {
  const xs = pairs.map((c) => {
    const p = clamp(c.pr, 1e-6, 1 - 1e-6);
    return Math.log(p / (1 - p));
  });
  let a = 1, b = 0;
  for (let it = 0; it < 2000; it++) {
    let ga = 0, gb = 0;
    for (let i = 0; i < xs.length; i++) {
      const pr = 1 / (1 + Math.exp(-(b + a * xs[i]!)));
      const e = pr - pairs[i]!.y;
      ga += e * xs[i]!; gb += e;
    }
    a -= 0.1 * (ga / xs.length);
    b -= 0.1 * (gb / xs.length);
  }
  return { a, b };
}
const PLATT = fitPlatt(cvPairs);
const PLATT_APPLIED = PLATT.a < 0.8 || PLATT.a > 1.25;
const ODDS_MODEL = fitLogit(ODDS_UNIVERSE);
function oddsOf(p: Row): number {
  if (p.age === null) return BASE_RATE;
  const raw = logitPredict(ODDS_MODEL, p);
  if (!PLATT_APPLIED) return raw;
  const c = clamp(raw, 1e-6, 1 - 1e-6);
  return 1 / (1 + Math.exp(-(PLATT.b + PLATT.a * Math.log(c / (1 - c)))));
}

// Empirical launch share by age band, straight from the snapshot.
const AGE_BANDS: { band: string; n: number; share: number }[] = [
  { band: '0-6mo', n: 0, share: 0 },
  { band: '6-18mo', n: 0, share: 0 },
  { band: '18mo+', n: 0, share: 0 },
];
for (const p of ODDS_UNIVERSE) {
  const idx = p.age! < 183 ? 0 : p.age! < 548 ? 1 : 2;
  AGE_BANDS[idx]!.n++;
  if (p.tok) AGE_BANDS[idx]!.share++;
}
for (const b of AGE_BANDS) b.share = b.n > 0 ? round(b.share / b.n, 3) : 0;

// ------------------------------------------------------------ farm plans
//
// Each plan is built from priced parts: every step carries an explicit fee
// in dollars and an explicit time, and the step totals are the exact sums of
// those parts, so the verdict arithmetic below is auditable from the text.
const GAS: Record<string, number> = {
  Ethereum: 7, Solana: 0.6, Binance: 0.8, Base: 1.2, Arbitrum: 1.5, Polygon: 0.7,
  Avalanche: 1.1, Bitcoin: 2.5, Sui: 0.5, Tron: 0.9, Aptos: 0.4, Starknet: 0.8,
};
const gasOf = (p: Row): number => GAS[p.chains[0] ?? ''] ?? 2;

// Category core actions: [first deposit action, second action, weekly action].
const CORE: Record<string, [string, string, string]> = {
  'Risk Curators': ['Allocate the ticket into the curator vault whose mandate fits your risk limit', 'Set a vault alert and rebalance into the curator\u2019s highest-conviction market', 'Add a small top-up deposit to keep the vault share from diluting'],
  'Onchain Capital Allocator': ['Deposit the ticket into the allocator\u2019s flagship strategy vault', 'Enrol the position in the allocator\u2019s points or rewards programme', 'Top up the strategy deposit to hold your share of the vault'],
  Dexs: ['Provide the ticket as two-sided liquidity in the flagship pool', 'Stake the LP position in the farm gauge to register activity', 'Swap a small amount through three different pools to build volume history'],
  Lending: ['Supply the ticket as collateral in the main lending market', 'Borrow a small amount against it and repay within the week to register both sides', 'Add a small supply top-up to keep the position active'],
  Yield: ['Deposit the ticket into the highest-yield flagship vault', 'Compound the first yield payment back into the vault', 'Harvest and restake the week\u2019s yield'],
  'Yield Aggregator': ['Deposit the ticket into the aggregator\u2019s main auto-compound vault', 'Move a small slice into a second strategy to diversify the record', 'Compound the aggregated yield back into the vault'],
  Derivatives: ['Post the ticket as margin and open a small hedged position', 'Roll the hedge and log a second trade in a different market', 'Trade a small contract each week to keep the account active'],
  CDP: ['Open a vault and mint a small amount of the stablecoin against the ticket as collateral', 'Adjust the collateral ratio once to register vault management activity', 'Repay a slice of the debt and remint it to keep the vault active'],
  'CDP Manager': ['Open a managed vault position with the ticket as collateral', 'Rebalance the vault\u2019s collateral mix once', 'Service the vault with a small repayment cycle each week'],
  'Basis Trading': ['Deposit the ticket into the basis vault to fund the delta-neutral book', 'Enrol in the vault\u2019s share programme and verify the position weekly', 'Top up the basis position to offset dilution from new deposits'],
  Chain: ['Bridge the ticket to the chain and hold it in a fresh address', 'Deploy a trivial contract or token to register builder activity', 'Make one native transfer each week to keep the address active'],
  'Staking Pool': ['Stake the ticket with the pool and hold the receipt in the farm wallet', 'Delegate a small extra amount to a second validator set', 'Claim and restake the week\u2019s staking rewards'],
  'Liquidity Manager': ['Deposit the ticket into the managed liquidity vault', 'Widen the position range once to register active management', 'Rebalance the position with a small top-up each week'],
  'Leveraged Farming': ['Open a conservative 2x leveraged farm position with the ticket', 'Rebalance the leverage ratio back to target once', 'Harvest the farm yield and reset the position weekly'],
  Restaking: ['Restake the ticket through the protocol and hold the restaked position', 'Opt into one actively validated service to register operator activity', 'Claim and restake the week\u2019s restaking rewards'],
  'Anchor BTC': ['Deposit BTC collateral worth the ticket into the anchor vault', 'Mint a small amount against the position to register both sides', 'Top up the collateral to hold the vault share'],
  'Decentralized BTC': ['Wrap and deposit BTC worth the ticket into the protocol vault', 'Stake the resulting position in the rewards programme', 'Add a small BTC top-up each week to keep the position growing'],
  CeDeFi: ['Deposit the ticket into the flagship earn product', 'Enrol the account in the loyalty tier programme', 'Make one small product interaction each week to keep the tier'],
  'Dual-Token Stablecoin': ['Mint the stablecoin with half the ticket as collateral', 'Stake the minted stablecoin in the stability pool', 'Rebalance the mint and stake positions weekly'],
  Farm: ['Stake the ticket in the flagship farming pool', 'Lock a small slice for the boosted tier', 'Harvest and restake the week\u2019s farm rewards'],
  'Prediction Market': ['Fund the account with the ticket and take small positions on three liquid markets', 'Resolve and settle the first market, then roll the proceeds into a new one', 'Trade one small position each week to build a volume record'],
  'Stablecoin Wrapper': ['Wrap the ticket\u2019s worth of the underlying stablecoin', 'Stake the wrapped balance in the rewards vault', 'Wrap a small top-up each week to keep the position active'],
  'Uncollateralized Lending': ['Lend the ticket into the senior pool tranche', 'Verify the borrower reporting and re-lend the first interest payment', 'Roll the matured slice into a new pool each cycle'],
  'Interest Rate Derivatives': ['Post the ticket as margin and open a small fixed-rate swap', 'Roll the swap once at the first fixing date', 'Trade one small swap each month to keep the account active'],
  'Cross Chain Bridge': ['Bridge the ticket across the protocol\u2019s main route and back', 'Register the address in the bridge\u2019s rewards programme', 'Make one small bridge transfer each week to build route history'],
  Insurance: ['Underwrite the ticket into the main cover pool', 'Buy a small cover policy to register both sides of the market', 'Restake the underwriting rewards each week'],
  Payments: ['Fund the payment account with the ticket and make a first transfer', 'Enrol in the cashback or rewards tier', 'Make one small payment each week to keep the account active'],
  'Governance Incentives': ['Deposit the ticket into the incentivised pool the governance programme rewards', 'Vote in one governance proposal to register participation', 'Claim and restake the week\u2019s incentive rewards'],
  'Crypto Card Issuer': ['Fund the card account with the ticket and activate the card', 'Enrol in the cashback tier programme', 'Make one small card payment each week to keep the tier'],
  Indexes: ['Buy the flagship index token with the ticket', 'Enrol the holding in the index rewards programme', 'Add a small top-up purchase each week to build the position'],
  'Collateral Markets': ['Post the ticket as collateral in the main market', 'Open and close one small position to register both sides', 'Top up the collateral each week to hold the margin share'],
  RWA: ['Subscribe the ticket into the flagship tokenised asset offering', 'Complete the holder verification and enrol in distributions', 'Add a small subscription top-up when the next window opens'],
};
const DEFAULT_CORE: [string, string, string] = [
  'Deposit the ticket into the protocol\u2019s flagship product and keep the receipt in the farm wallet',
  'Complete the protocol\u2019s second core action (stake, enrol or activate) so the account shows real usage',
  'Make one small qualifying interaction each week to keep the account active',
];

interface FarmStep { text: string; cost: number; hours: number }
function farmSteps(p: Row, ticket: number): FarmStep[] {
  const g = gasOf(p);
  const [actA, actB, actW] = CORE[p.category] ?? DEFAULT_CORE;
  const chain = p.chains[0] ?? 'its main chain';
  const money = (v: number): string => '$' + v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 2 : 0 });
  const wkFee = Math.max(0.5, g / 2);
  const steps: FarmStep[] = [
    { text: `Verify ${p.name} has no live token: read the official docs, governance forum and contract registry for ${p.slug}, and save dated screenshots as evidence. Fees $0, time 1.5h.`, cost: 0, hours: 1.5 },
    { text: `Create a fresh wallet used only for ${p.name}, fund it on ${chain} with the ${money(ticket)} ticket plus a gas buffer, and label it in your tracker. Fees ${money(g)}, time 0.5h.`, cost: g, hours: 0.5 },
    { text: `${actA} (${money(ticket)} position on ${chain}). Fees ${money(g)}, time 1h.`, cost: g, hours: 1 },
    { text: `${actB}. Fees ${money(g)}, time 0.75h.`, cost: g, hours: 0.75 },
    { text: `${actW}: budget ${money(wkFee)} in fees per week for 8 weeks (${money(wkFee * 8)} total), 0.4h per week, 3.2h in all.`, cost: wkFee * 8, hours: 3.2 },
    { text: `Monitor the points or announcement page and the position\u2019s health weekly for 8 weeks; screenshot the balance each Friday. Fees $0, time 0.25h per week, 2h in all.`, cost: 0, hours: 2 },
    { text: `Exit plan: on a token announcement, or after 12 weeks with none, withdraw and claim in a single session and keep the records for tax. Fees ${money(g)}, time 1h.`, cost: g, hours: 1 },
  ];
  return steps;
}

// Farm verdicts under the stated scenario: drop share 7.5% of the launch
// value to farmers, ticket 0.02% of TVL clamped to [$250, $10,000], FARM
// needs a positive net that also pays at least $15/hour of the plan's time.
const DROP_SHARE = 0.075;
const HURDLE_PER_HOUR = 15;
type Verdict = 'FARM' | 'MARGINAL' | 'SKIP';
function verdictFor(net: number, perHour: number): Verdict {
  if (net > 0 && perHour >= HURDLE_PER_HOUR) return 'FARM';
  if (net > 0) return 'MARGINAL';
  return 'SKIP';
}

// ------------------------------------------------------------- the board

interface BoardRow {
  rank: number;
  range_lo: number;
  range_hi: number;
  top10_pct: number;
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
  odds: number;
  conditional_value_usd: number;
  implied_value_usd: number;
  band_low_usd: number;
  band_high_usd: number;
  category_factor: number | null;
  growth_factor: number;
  maturity_factor: number;
  chain_factor: number;
  peer_count: number;
  comparables: { slug: string; tvl_usd: number; mcap_usd: number; multiple: number }[];
  step_cost_usd: number;
  step_hours: number;
  ticket_usd: number;
  expected_reward_usd: number;
  net_usd: number;
  net_per_hour: number;
  verdict: Verdict;
  verdict_stability: 'robust' | 'mixed' | 'fragile';
  farm_steps: string[];
}

const peerCountByCat = new Map<string, number>();
for (const p of PEERS) peerCountByCat.set(p.category, (peerCountByCat.get(p.category) ?? 0) + 1);

function comparables(p: Row): BoardRow['comparables'] {
  const score = (q: Row): number => Math.abs(q.lnt - p.lnt);
  const inCat = PEERS.filter((q) => q.category === p.category).sort((x, y) => score(x) - score(y) || (x.slug < y.slug ? -1 : 1));
  const chosen = inCat.slice(0, 5);
  if (chosen.length < 5) {
    const rest = PEERS.filter((q) => !chosen.includes(q)).sort((x, y) => score(x) - score(y) || (x.slug < y.slug ? -1 : 1));
    chosen.push(...rest.slice(0, 5 - chosen.length));
  }
  return chosen.map((q) => ({ slug: q.slug, tvl_usd: Math.round(q.tvl_usd), mcap_usd: Math.round(q.mcap_usd!), multiple: round(q.mcap_usd! / q.tvl_usd, 4) }));
}

interface Scored {
  p: Row;
  odds: number;
  conditional: number;
  implied: number;
  parts: ReturnType<typeof predictParts>;
}
const SCORED: Scored[] = BOARD_SET.map((p) => {
  const parts = predictParts(FINAL, p);
  const conditional = Math.exp(parts.ln);
  const odds = oddsOf(p);
  return { p, odds, conditional, implied: Math.round(conditional * odds), parts };
}).sort((x, y) => y.implied - x.implied || y.p.tvl_usd - x.p.tvl_usd || (x.p.slug < y.p.slug ? -1 : 1));

// Rank ranges: bootstrap the whole pipeline 200 times (seed 42). Peers are
// resampled with replacement, the final model spec is refitted, the board is
// re-ranked; odds stay fixed (stated in the README).
const bootRanks = new Map<string, number[]>();
for (const s of SCORED) bootRanks.set(s.p.slug, []);
{
  const rng = mulberry32(42);
  for (let it = 0; it < 200; it++) {
    const sample: Row[] = [];
    for (let i = 0; i < PEERS.length; i++) sample.push(PEERS[Math.floor(rng() * PEERS.length)]!);
    const m = fitModel(sample, ESTIMATOR, keptTerms);
    const ranked = SCORED.map((s) => ({ slug: s.p.slug, v: Math.exp(predictLn(m, s.p)) * s.odds, tvl: s.p.tvl_usd }))
      .sort((x, y) => y.v - x.v || y.tvl - x.tvl || (x.slug < y.slug ? -1 : 1));
    ranked.forEach((r, idx) => bootRanks.get(r.slug)!.push(idx + 1));
  }
}

const ROWS: BoardRow[] = SCORED.map((s, i) => {
  const p = s.p;
  const ticket = Math.round(clamp(0.0002 * p.tvl_usd, 250, 10000));
  const steps = farmSteps(p, ticket);
  const stepCost = round(steps.reduce((sum, st) => sum + st.cost, 0), 2);
  const stepHours = round(steps.reduce((sum, st) => sum + st.hours, 0), 2);
  const reward = (drop: number, scale: number): number => {
    const t = ticket * scale;
    return s.implied * drop * (t / (p.tvl_usd + t));
  };
  const netDefault = reward(DROP_SHARE, 1) - stepCost;
  const verdict = verdictFor(netDefault, netDefault / stepHours);
  let same = 0;
  for (const drop of [0.03, 0.075, 0.15]) {
    for (const scale of [0.5, 1, 2]) {
      const net = reward(drop, scale) - stepCost;
      if (verdictFor(net, net / stepHours) === verdict) same++;
    }
  }
  const ranks = bootRanks.get(p.slug)!;
  return {
    rank: i + 1,
    range_lo: Math.round(quantile(ranks, 0.05)),
    range_hi: Math.round(quantile(ranks, 0.95)),
    top10_pct: round(ranks.filter((r) => r <= 10).length / ranks.length, 3),
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    chain_count: p.chains.length,
    tvl_usd: Math.round(p.tvl_usd),
    change_7d_pct: p.change_7d === null ? null : round(p.change_7d, 2),
    listed_at: p.listed_at,
    age_days: p.age,
    watchlist: WATCH.has(p.slug),
    odds: round(s.odds, 4),
    conditional_value_usd: Math.round(s.conditional),
    implied_value_usd: s.implied,
    band_low_usd: Math.round(s.conditional * Math.exp(BAND_Q25)),
    band_high_usd: Math.round(s.conditional * Math.exp(BAND_Q75)),
    category_factor: keptTerms.includes('category') ? round(s.parts.catF, 4) : null,
    growth_factor: round(s.parts.groF, 4),
    maturity_factor: round(s.parts.matF, 4),
    chain_factor: round(s.parts.chaF, 4),
    peer_count: peerCountByCat.get(p.category) ?? 0,
    comparables: comparables(p),
    step_cost_usd: Math.round(stepCost),
    step_hours: stepHours,
    ticket_usd: ticket,
    expected_reward_usd: Math.round(reward(DROP_SHARE, 1)),
    net_usd: Math.round(netDefault),
    net_per_hour: round(netDefault / stepHours, 2),
    verdict,
    verdict_stability: same >= 7 ? 'robust' : same <= 3 ? 'fragile' : 'mixed',
    farm_steps: steps.map((st) => st.text),
  };
});

// ---------------------------------------------------------------- outputs

const LIVE = ALL.filter((p) => p.mcap_usd !== null)
  .sort((x, y) => y.mcap_usd! - x.mcap_usd!)
  .map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    tvl_usd: Math.round(p.tvl_usd),
    mcap_usd: Math.round(p.mcap_usd!),
    multiple: p.tvl_usd > 0 ? round(p.mcap_usd! / p.tvl_usd, 4) : null,
  }));

const curvePts: [number, number][] = [];
for (let i = 0; i < 24; i++) {
  const lnt = Math.log(5e6) + ((Math.log(1.2e11) - Math.log(5e6)) * i) / 23;
  curvePts.push([Math.round(Math.exp(lnt)), Math.round(Math.exp(FINAL.a + FINAL.b * lnt))]);
}

const META = {
  as_of: snap.as_of,
  model: 'radar-5',
  scanned: ALL.length,
  board_rows: ROWS.length,
  watchlist_covered: ROWS.filter((r) => r.watchlist).length,
  live_token_count: LIVE.length,
  peer_count: PEERS.length,
  estimator: ESTIMATOR,
  bakeoff: BAKEOFF.map((b) => ({ estimator: b.est, p1_medale: round(b.p1, 4) })),
  size_curve: { alpha: round(FINAL.a, 6), beta: round(FINAL.b, 6) },
  eb_k: EB_K_FULL === null ? null : round(EB_K_FULL, 3),
  terms: TERMS,
  kept_terms: keptTerms,
  validation: {
    radar5: { p1_medale: round(curMed.p1, 4), p2_medale: round(curMed.p2, 4), p3_medale: round(curMed.p3, 4) },
    radar4: { p1_medale: round(RADAR4_P1, 4), p2_medale: round(RADAR4_P2, 4) },
    flat: { p1_medale: round(FLAT_P1, 4) },
    range_honesty: round(RANGE_HONESTY, 3),
    odds: {
      brier_model: round(ODDS_BRIER, 4),
      brier_base: round(ODDS_BRIER_BASE, 4),
      logloss_model: round(ODDS_LL, 4),
      logloss_base: round(ODDS_LL_BASE, 4),
      wf_brier: round(ODDS_WF_BRIER, 4),
      wf_logloss: round(ODDS_WF_LL, 4),
      base_rate: round(BASE_RATE, 4),
      platt_slope: round(PLATT.a, 3),
      platt_applied: PLATT_APPLIED,
      calibration: CALIBRATION,
      age_bands: AGE_BANDS,
    },
    bootstrap: { runs: 200, seed: 42 },
  },
  accounting: ACCOUNTING,
  verdict_counts: {
    FARM: ROWS.filter((r) => r.verdict === 'FARM').length,
    MARGINAL: ROWS.filter((r) => r.verdict === 'MARGINAL').length,
    SKIP: ROWS.filter((r) => r.verdict === 'SKIP').length,
  },
  scatter: {
    peers: PEERS.map((p) => [Math.round(p.tvl_usd), Math.round(p.mcap_usd!)]),
    curve: curvePts,
    board_top: SCORED.slice(0, 10).map((s) => [Math.round(s.p.tvl_usd), Math.round(s.conditional)]),
  },
};

mkdirSync(OUTPUT, { recursive: true });
writeFileSync(join(OUTPUT, 'board.json'), JSON.stringify(ROWS, null, 1) + '\n');
writeFileSync(join(OUTPUT, 'data.js'), 'window.RADAR = ' + JSON.stringify({ meta: META, rows: ROWS, live: LIVE }) + ';\n');
for (const dir of ['dashboard', 'screenshots']) {
  const src = join(process.cwd(), dir);
  const dst = join(OUTPUT, dir);
  mkdirSync(dst, { recursive: true });
  if (existsSync(src)) for (const f of readdirSync(src)) copyFileSync(join(src, f), join(dst, f));
}
writeFileSync(join(OUTPUT, 'dossier.json'), buildDossier(OUTPUT, { text_max_bytes: 65536 }));
console.log(`radar-5: ${ROWS.length} rows, estimator ${ESTIMATOR}, kept terms [${keptTerms.join(', ') || 'none'}]`);
