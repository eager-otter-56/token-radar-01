'use strict';
const R = window.RADAR, M = R.meta, ROWS = R.rows, LIVE = R.live;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const full = (v) => '$' + Math.round(v).toLocaleString('en-US');
const money = (v) => {
  const a = Math.abs(v);
  if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(v);
};
const sgn = (v) => (v > 0 ? '+' : '') + v.toFixed(2);
const ageFmt = (d) => (d === null ? '—' : d >= 548 ? (d / 365.25).toFixed(1) + ' yr' : d + ' d');

// ---- header + KPI strip
$('asof').textContent = 'DefiLlama snapshot ' + M.as_of + ' · ' + M.scanned + ' protocols · ' + M.peer_count + ' launched peers fitted';
const V = M.validation, O = V.odds;
const miss = (m) => '×' + Math.exp(m).toFixed(2);
const tiles = [
  [miss(V.radar5.p2_medale), 'Walk-forward miss', 'MedALE ' + V.radar5.p2_medale.toFixed(4) + ' (P2)'],
  [miss(V.radar5.p1_medale), 'Leave-one-out miss', 'MedALE ' + V.radar5.p1_medale.toFixed(4) + ' (P1)'],
  [Math.round(V.range_honesty * 100) + '%', 'Range honesty', 'of peers inside their P25–P75'],
  [O.brier_model.toFixed(3), 'Token-odds Brier', 'base rate ' + O.brier_base.toFixed(3)],
  [M.kept_terms.length + ' of ' + M.terms.length, 'Terms survived', 'all three protocols + CI'],
  [M.verdict_counts.FARM + ' FARM', 'Worth farming', 'of ' + M.board_rows + ' · ' + M.verdict_counts.MARGINAL + ' marginal'],
  [M.watchlist_covered + ' / 40', 'Watchlist ranked', 'every one on the board'],
];
$('kpis').innerHTML = tiles.map((t) => '<div class="kpi"><div class="v">' + t[0] + '</div><div class="l">' + t[1] + '</div><div class="s">' + t[2] + '</div></div>').join('');

// ---- accounting bar + integrity line (recomputed here, from data.js)
const ACCT_COLORS = ['#57c98a', '#5aa2e0', '#8a6d3b', '#7a5ba6', '#a65b7a', '#5ba6a0', '#96a0ab'];
$('acctbar').innerHTML = M.accounting.map((g, i) =>
  '<div style="background:' + ACCT_COLORS[i % ACCT_COLORS.length] + ';width:' + (100 * g.n / M.scanned) + '%" title="' + esc(g.label) + ': ' + g.n + '"></div>').join('');
$('acctlegend').innerHTML = M.accounting.map((g, i) =>
  '<span style="color:' + ACCT_COLORS[i % ACCT_COLORS.length] + '">■</span> ' + esc(g.label) + ' <b>' + g.n + '</b>').join(' · ');
{
  const checks = [];
  const ok = (cond, label) => checks.push('<span class="' + (cond ? '' : 'fail') + '">' + (cond ? '✓' : '✗') + ' ' + label + '</span>');
  ok(ROWS.length === M.board_rows, 'rows ' + ROWS.length + ' = board.json');
  ok(ROWS.every((r, i) => r.rank === i + 1), 'ranks 1–' + ROWS.length + ' in order');
  ok(ROWS.every((r, i) => i === 0 || ROWS[i - 1].implied_value_usd >= r.implied_value_usd), 'implied values never rise');
  ok(ROWS.filter((r) => r.watchlist).length === 40, 'watchlist 40 of 40');
  ok(M.accounting.reduce((s, g) => s + g.n, 0) === M.scanned, 'ledger ' + M.scanned + ' of ' + M.scanned + ' protocols');
  ok(ROWS.every((r) => r.farm_steps.length === 7), '7 farm steps on every row');
  $('integrity').innerHTML = 'Integrity, recomputed in this browser: ' + checks.join(' · ');
}

// ---- evidence panel
{
  const sgn4 = (v) => (v > 0 ? '+' : '') + v.toFixed(4);
  const rows = M.terms.map((t) =>
    '<tr><td class="l">' + t.name + '</td><td>' + sgn4(t.p1_delta) + '</td><td>' + sgn4(t.p2_delta) + '</td><td>' + sgn4(t.p3_delta) + '</td>' +
    '<td>[' + t.ci_lo.toFixed(3) + ', ' + t.ci_hi.toFixed(3) + ']</td>' +
    '<td class="' + (t.kept ? 'kept' : 'dropped') + '">' + (t.kept ? 'KEPT' : 'tested, not kept') + '</td></tr>').join('');
  $('ablation').innerHTML = '<tr><th class="l">Term</th><th>Δ P1</th><th>Δ P2</th><th>Δ P3</th><th>90% CI</th><th>Verdict</th></tr>' + rows +
    '<tr><td class="l" colspan="6" style="font-family:inherit;color:var(--dim)">Δ = MedALE change when the term is added (negative helps). Kept only if it helps on all three protocols with the CI above zero.</td></tr>';
  $('bakeoff').innerHTML = 'Estimator bake-off, base curve (P1 MedALE): ' + M.bakeoff.map((b) =>
    (b.estimator === M.estimator ? '<b>' + b.estimator + ' ' + b.p1_medale.toFixed(4) + ' — kept</b>' : b.estimator + ' ' + b.p1_medale.toFixed(4))).join(' · ') +
    '. Fitted curve: value = e<sup>' + M.size_curve.alpha + '</sup> · TVL<sup>' + M.size_curve.beta + '</sup>. Category shrinkage was estimated, not set: empirical-Bayes k = ' + M.eb_k + '.';
  $('modelcmp').innerHTML = 'Same protocols, other specifications: <b>radar-5 P1 ' + V.radar5.p1_medale.toFixed(4) + ' / P2 ' + V.radar5.p2_medale.toFixed(4) + '</b> · ' +
    'radar-4 spec P1 ' + V.radar4.p1_medale.toFixed(4) + ' / P2 ' + V.radar4.p2_medale.toFixed(4) + ' · flat TVL multiple P1 ' + V.flat.p1_medale.toFixed(4) + '.';
  const bands = O.age_bands.map((b) => b.band + ' <b>' + Math.round(b.share * 100) + '%</b> of ' + b.n).join(' · ');
  $('oddspanel').innerHTML = 'Base rate: <b>' + Math.round(O.base_rate * 100) + '%</b> of age-known peers record a token. Held out (slug-parity): Brier <b>' + O.brier_model.toFixed(4) +
    '</b> vs base ' + O.brier_base.toFixed(4) + '; log-loss <b>' + O.logloss_model.toFixed(4) + '</b> vs base ' + O.logloss_base.toFixed(4) +
    '. Walk-forward Brier ' + O.wf_brier.toFixed(4) + '. Calibration slope ' + O.platt_slope + (O.platt_applied ? ' — outside [0.8, 1.25], Platt recalibration applied.' : ' — inside [0.8, 1.25], no recalibration applied.') +
    '<br>Launch share by age band: ' + bands + '.';
}

// ---- scatter (log-log): peers, fitted curve, top-10 board conditionals
{
  const W = 520, H = 215, pad = 34;
  const xs = M.scatter.peers.map((p) => Math.log10(p[0])), ys = M.scatter.peers.map((p) => Math.log10(p[1]));
  const x0 = Math.min(...xs, ...M.scatter.board_top.map((p) => Math.log10(p[0]))), x1 = Math.max(...xs);
  const y0 = Math.min(...ys, ...M.scatter.board_top.map((p) => Math.log10(p[1]))), y1 = Math.max(...ys);
  const X = (v) => pad + ((v - x0) / (x1 - x0)) * (W - pad - 6);
  const Y = (v) => H - 18 - ((v - y0) / (y1 - y0)) * (H - 26);
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img">';
  s += '<text x="' + pad + '" y="' + (H - 4) + '">TVL $' + Math.pow(10, x0).toExponential(0) + ' → $' + Math.pow(10, x1).toExponential(0) + '</text>';
  s += '<text x="2" y="12">mcap</text>';
  for (const p of M.scatter.peers) s += '<circle cx="' + X(Math.log10(p[0])).toFixed(1) + '" cy="' + Y(Math.log10(p[1])).toFixed(1) + '" r="2" fill="#5aa2e0" opacity="0.55"/>';
  s += '<polyline fill="none" stroke="#57c98a" stroke-width="1.6" points="' + M.scatter.curve.map((p) => X(Math.log10(p[0])).toFixed(1) + ',' + Y(Math.log10(p[1])).toFixed(1)).join(' ') + '"/>';
  for (const p of M.scatter.board_top) s += '<circle cx="' + X(Math.log10(p[0])).toFixed(1) + '" cy="' + Y(Math.log10(p[1])).toFixed(1) + '" r="3" fill="#e0b34e"/>';
  s += '</svg><p class="note">Blue: launched peers. Green: the fitted curve. Amber: the board\u2019s top 10, at their conditional values.</p>';
  $('scatter').innerHTML = s;
}

// ---- scenario + board
let drop = 0.075, scale = 1;
const scen = () => { $('dropv').textContent = (drop * 100).toFixed(1) + '%'; $('scalev').textContent = scale.toFixed(2) + '×'; };
$('drop').addEventListener('input', (e) => { drop = Number(e.target.value) / 100; scen(); render(); });
$('scale').addEventListener('input', (e) => { scale = Number(e.target.value); scen(); render(); });
scen();

function verdictOf(r) {
  const t = r.ticket_usd * scale;
  const net = r.implied_value_usd * drop * (t / (r.tvl_usd + t)) - r.step_cost_usd;
  const per = net / r.step_hours;
  return { net, per, v: net > 0 && per >= 15 ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP' };
}

let sortKey = 'rank', sortDir = 1, tab = 'board';
const cats = [...new Set(ROWS.map((r) => r.category))].sort();
const chains = [...new Set(ROWS.flatMap((r) => r.chains))].sort();
$('fcat').innerHTML += cats.map((c) => '<option>' + esc(c) + '</option>').join('');
$('fchain').innerHTML += chains.map((c) => '<option>' + esc(c) + '</option>').join('');

function visible() {
  const q = $('q').value.trim().toLowerCase(), fc = $('fcat').value, fh = $('fchain').value, ft = Number($('ftvl').value), wl = $('fwl').checked;
  return ROWS.filter((r) =>
    (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q)) &&
    (!fc || r.category === fc) && (!fh || r.chains.includes(fh)) &&
    r.tvl_usd >= ft && (!wl || r.watchlist));
}
const COLS = [
  ['rank', '#'], ['range_lo', 'Range'], ['name', 'Protocol'], ['category', 'Category'], ['tvl_usd', 'TVL'],
  ['change_7d_pct', '7d %'], ['age_days', 'Age'], ['odds', 'Odds'], ['conditional_value_usd', 'If it launches'],
  ['implied_value_usd', 'Implied'], ['band_low_usd', 'P25–P75'], ['verdict', 'Verdict (net · $/hr)'],
];
function render() {
  if (tab === 'live') return renderLive();
  let rows = visible();
  rows.sort((a, b) => {
    let x = a[sortKey], y = b[sortKey];
    if (sortKey === 'verdict') { x = verdictOf(a).net; y = verdictOf(b).net; }
    if (sortKey === 'name' || sortKey === 'category') return sortDir * String(x).localeCompare(String(y));
    return sortDir * ((x ?? -Infinity) - (y ?? -Infinity));
  });
  $('count').textContent = rows.length + ' of ' + ROWS.length + ' shown';
  let h = '<thead><tr>' + COLS.map((c) => '<th data-k="' + c[0] + '"' + (c[0] === 'name' || c[0] === 'category' ? ' class="l"' : '') + '>' + c[1] + (sortKey === c[0] ? (sortDir > 0 ? ' ↑' : ' ↓') : '') + '</th>').join('') + '</tr></thead><tbody>';
  for (const r of rows) {
    const vd = verdictOf(r);
    h += '<tr data-slug="' + r.slug + '"><td>' + r.rank + '</td><td>' + r.range_lo + '–' + r.range_hi + '</td>' +
      '<td class="name">' + esc(r.name) + (r.watchlist ? ' <span class="star">★</span>' : '') + '<br><span class="band">' + r.slug + '</span></td>' +
      '<td class="l">' + esc(r.category) + '</td><td>' + money(r.tvl_usd) + '</td>' +
      '<td>' + (r.change_7d_pct === null ? '—' : sgn(r.change_7d_pct)) + '</td><td>' + ageFmt(r.age_days) + '</td>' +
      '<td>' + Math.round(r.odds * 100) + '%</td><td>' + money(r.conditional_value_usd) + '</td><td><b>' + money(r.implied_value_usd) + '</b></td>' +
      '<td><span class="band">' + money(r.band_low_usd) + ' – ' + money(r.band_high_usd) + '</span></td>' +
      '<td><span class="verdict v' + vd.v + '">' + vd.v + '</span> ' + (vd.net >= 0 ? '+' : '−') + money(Math.abs(vd.net)).slice(0) + ' · ' + (vd.per >= 0 ? '+' : '−') + '$' + Math.abs(vd.per).toFixed(2) +
      '<span class="dot d-' + r.verdict_stability + '" title="stability: ' + r.verdict_stability + '"></span></td></tr>';
  }
  $('board').innerHTML = h + '</tbody>';
  bindRows();
}
function renderLive() {
  $('count').textContent = LIVE.length + ' live-token protocols, set aside from the board';
  let h = '<thead><tr><th class="l">Protocol</th><th class="l">Category</th><th>TVL</th><th>Market cap</th><th>×TVL</th></tr></thead><tbody>';
  for (const p of LIVE) h += '<tr><td class="name">' + esc(p.name) + '<br><span class="band">' + p.slug + '</span></td><td class="l">' + esc(p.category) + '</td><td>' + money(p.tvl_usd) + '</td><td>' + money(p.mcap_usd) + '</td><td>' + (p.multiple === null ? '—' : p.multiple.toFixed(2)) + '</td></tr>';
  $('board').innerHTML = h + '</tbody>';
}
function bindRows() {
  document.querySelectorAll('#board tbody tr[data-slug]').forEach((tr) => tr.addEventListener('click', () => showDetail(tr.getAttribute('data-slug'))));
  document.querySelectorAll('#board th').forEach((th) => th.addEventListener('click', () => {
    const k = th.getAttribute('data-k'); if (!k) return;
    if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
    render();
  }));
}
$('tab-board').addEventListener('click', () => { tab = 'board'; $('tab-board').className = 'on'; $('tab-live').className = ''; render(); });
$('tab-live').addEventListener('click', () => { tab = 'live'; $('tab-live').className = 'on'; $('tab-board').className = ''; renderLive(); });
for (const id of ['q', 'fcat', 'fchain', 'ftvl', 'fwl']) $(id).addEventListener('input', render);

// ---- detail panel
function showDetail(slug) {
  const r = ROWS.find((x) => x.slug === slug);
  if (!r) return;
  const vd = verdictOf(r);
  const t = r.ticket_usd * scale;
  const reward = r.implied_value_usd * drop * (t / (r.tvl_usd + t));
  const baseVal = r.conditional_value_usd / ((r.category_factor ?? 1) * r.growth_factor * r.maturity_factor * r.chain_factor);
  const frow = (k, v) => '<div class="k">' + k + '</div><span>' + v + '</span>';
  let h = '<h3>' + esc(r.name) + (r.watchlist ? ' <span class="star">★ watchlist</span>' : '') + ' — rank ' + r.rank + ' of ' + ROWS.length + '</h3>';
  h += '<div class="dgrid">';
  h += frow('Category · chains', esc(r.category) + ' · ' + esc(r.chains.join(', ')));
  h += frow('TVL · 7d · age', money(r.tvl_usd) + ' · ' + (r.change_7d_pct === null ? '—' : sgn(r.change_7d_pct) + '%') + ' · ' + ageFmt(r.age_days));
  h += frow('Size-curve value', full(baseVal));
  h += frow('× category factor', r.category_factor === null ? 'term dropped' : r.category_factor.toFixed(4));
  h += frow('× growth factor', r.growth_factor.toFixed(4)) + frow('× maturity factor', r.maturity_factor.toFixed(4));
  h += frow('× chain factor', r.chain_factor.toFixed(4));
  h += frow('= value if it launches', '<b>' + full(r.conditional_value_usd) + '</b>');
  h += frow('× token odds', Math.round(r.odds * 100) + '%');
  h += frow('= implied value', '<b>' + full(r.implied_value_usd) + '</b>');
  h += frow('P25–P75 band', money(r.band_low_usd) + ' – ' + money(r.band_high_usd));
  h += frow('Rank range (bootstrap)', r.range_lo + '–' + r.range_hi + ' · P(top 10) ' + Math.round(r.top10_pct * 100) + '%');
  h += frow('Verdict math', 'ticket ' + full(t) + ' → expected reward ' + full(reward) + ' − plan cost ' + full(r.step_cost_usd) + ' = <b>' + (vd.net >= 0 ? '+' : '−') + full(Math.abs(vd.net)) + '</b> (' + (vd.per >= 0 ? '+' : '−') + '$' + Math.abs(vd.per).toFixed(2) + '/hr, ' + r.verdict_stability + ')');
  h += '</div>';
  h += '<h3>Comparables — nearest launched peers by TVL</h3><table class="ev"><tr><th class="l">Peer</th><th>TVL</th><th>Market cap</th><th>×TVL</th></tr>' +
    r.comparables.map((c) => '<tr><td class="l">' + c.slug + '</td><td>' + money(c.tvl_usd) + '</td><td>' + money(c.mcap_usd) + '</td><td>' + c.multiple.toFixed(2) + '</td></tr>').join('') + '</table>';
  h += '<h3>Farm plan — ' + vd.v + ' under the current scenario (plan totals: ' + full(r.step_cost_usd) + ' in fees, ' + r.step_hours + 'h)</h3><ol class="steps">' +
    r.farm_steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>';
  $('detail').innerHTML = h;
  $('detail').scrollIntoView({ block: 'nearest' });
}

// ---- URL query state
{
  const q = new URLSearchParams(location.search);
  if (q.get('category')) $('fcat').value = q.get('category');
  if (q.get('watchlist') === '1') $('fwl').checked = true;
  render();
  if (q.get('protocol')) showDetail(q.get('protocol'));
}
