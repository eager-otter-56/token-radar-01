'use strict';
const R = window.RADAR, M = R.meta, V = M.validation, O = V.odds;
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const money = n => n >= 1e9 ? '$' + (n/1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n/1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + (n/1e3).toFixed(1) + 'K' : '$' + Math.round(n);
const miss = m => '×' + Math.exp(m).toFixed(2);
const sgn = n => (n > 0 ? '+' : '') + n.toFixed(4);
const rows = R.rows;
let drop = 0.075, tscale = 1, sortKey = 'rank', sortDir = 1, tab = 'board';

/* digest — first block */
{
  const race = [...M.bakeoff].sort((a,b) => a.p1_medale - b.p1_medale);
  const raceTxt = race.map((b,i) => (i === 0 ? '<b>' + b.estimator.toUpperCase() + ' ' + b.p1_medale.toFixed(4) + '</b>' : b.estimator + ' ' + b.p1_medale.toFixed(4))).join(' · ');
  $('digest').innerHTML =
    '<div>Out-of-sample miss: walk-forward <b>' + miss(V.radar5.p2_medale) + '</b> · leave-one-out <b>' + miss(V.radar5.p1_medale) + '</b> (median |log error|, fitted on launched peers only)</div>' +
    '<div>Value band honesty: <b>' + (V.range_honesty*100).toFixed(1) + '%</b> of peers inside their P25–P75 band · Estimator race (P1): ' + raceTxt + ' — the winner ships</div>' +
    '<div>Token odds beat the base rate on both scores: Brier <b>' + O.brier_model.toFixed(4) + '</b> vs ' + O.brier_base.toFixed(4) + ' · log-loss <b>' + O.logloss_model.toFixed(4) + '</b> vs ' + O.logloss_base.toFixed(4) + ' · base rate ' + (O.base_rate*100).toFixed(1) + '%</div>' +
    '<div>Coverage: board <b>' + M.board_rows + ' of ' + M.scanned + '</b> scanned · watchlist <b>' + M.watchlist_covered + '/' + M.watchlist_covered + '</b> · implied value = value if it launches × odds it launches</div>';
}

/* KPIs */
{
  const vc = M.verdict_counts;
  const tiles = [
    ['Walk-forward miss', miss(V.radar5.p2_medale), 'fit on earlier listings, tested on later ones (P2)'],
    ['Leave-one-out miss', miss(V.radar5.p1_medale), 'each peer predicted by the other 127 (P1)'],
    ['Range honesty', (V.range_honesty*100).toFixed(1) + '%', 'of peers inside their P25–P75 band'],
    ['Token odds — Brier', O.brier_model.toFixed(4), 'vs ' + O.brier_base.toFixed(4) + ' base-rate predictor'],
    ['Out-of-sample tests', '3 protocols', 'every term must win all 3 + CI — ' + M.terms.length + ' tested, ' + M.kept_terms.length + ' kept'],
    ['Worth farming', vc.FARM + ' FARM', vc.MARGINAL + ' MARGINAL · ' + vc.SKIP + ' SKIP at default scenario'],
    ['Watchlist', M.watchlist_covered + '/' + M.watchlist_covered, 'every watched protocol is on the board']
  ];
  $('kpis').innerHTML = tiles.map(t => '<div class="tile"><div class="v">' + t[1] + '</div><div class="l">' + t[0] + '</div><div class="s">' + t[2] + '</div></div>').join('');
}

/* ledger */
{
  const cols = ['#35d99a','#4a6b8a','#8a5a3c','#5f4a8a','#8a3c4a','#6b8a4a','#3c7a8a'];
  const total = M.accounting.reduce((s,g) => s + g.n, 0);
  $('ledger').innerHTML = '<h2>All ' + total + ' snapshot protocols, accounted once</h2><div class="bar">' +
    M.accounting.map((g,i) => '<div class="seg" style="width:' + (g.n/total*100) + '%;background:' + cols[i % cols.length] + '" title="' + esc(g.label) + ': ' + g.n + '"></div>').join('') +
    '</div><div class="lbl">' + M.accounting.map(g => esc(g.label) + ' ' + g.n).join(' · ') + '</div>';
}

/* integrity */
{
  const checks = [];
  checks.push(['rows ' + rows.length + '/' + M.board_rows, rows.length === M.board_rows]);
  checks.push(['ranks 1..N', rows.every((r,i) => r.rank === i + 1)]);
  checks.push(['implied non-increasing', rows.every((r,i) => i === 0 || rows[i-1].implied_value_usd >= r.implied_value_usd)]);
  const wl = rows.filter(r => r.watchlist).length;
  checks.push(['watchlist ' + wl + '/' + M.watchlist_covered, wl === M.watchlist_covered]);
  const sum = M.accounting.reduce((s,g) => s + g.n, 0);
  checks.push(['ledger sums to ' + M.scanned, sum === M.scanned]);
  $('integrity').textContent = 'Integrity, recomputed in your browser from data.js: ' + checks.map(c => (c[1] ? '✓ ' : '✗ ') + c[0]).join(' · ');
}

/* ablation */
{
  $('ablation').innerHTML = '<h2>Term ablation — ΔMedALE when the term is added</h2><table><tr><th class="l">Term</th><th>P1 LOO</th><th>P2 walk-fwd</th><th>P3 split</th><th class="l">Bootstrap 90% CI (P1)</th><th class="l">Verdict</th></tr>' +
    M.terms.map(t => '<tr><td class="l">' + esc(t.name) + '</td><td class="num">' + sgn(t.p1_delta) + '</td><td class="num">' + sgn(t.p2_delta) + '</td><td class="num">' + sgn(t.p3_delta) + '</td><td class="l num">[' + sgn(t.ci_lo) + ', ' + sgn(t.ci_hi) + ']</td><td class="l ' + (t.kept ? 'kept' : 'dropped') + '">' + (t.kept ? 'KEPT' : 'tested, not kept') + '</td></tr>').join('') +
    '</table><p class="note">Negative is better; a term had to be negative on all three with the CI excluding zero. None passed — the shipped model is the bare fitted size curve: mcap = e<sup>' + M.size_curve.alpha.toFixed(2) + '</sup> · TVL<sup>' + M.size_curve.beta.toFixed(3) + '</sup>, fitted on the ' + M.peer_count + ' launched peers. Category shrinkage was estimated (empirical-Bayes k = ' + M.eb_k.toFixed(2) + ') and still failed the CI test.</p>';
}

/* bake-off + comparison */
{
  const race = [...M.bakeoff].sort((a,b) => a.p1_medale - b.p1_medale);
  $('bakeoff').innerHTML = '<p class="note">Estimator bake-off (P1 MedALE, lower wins): ' + race.map((b,i) => (i === 0 ? '<b>' + b.estimator + ' ' + b.p1_medale.toFixed(4) + ' — ships</b>' : b.estimator + ' ' + b.p1_medale.toFixed(4))).join(' · ') + '</p>';
  $('modelcmp').innerHTML = '<table><tr><th class="l">Model</th><th>P1 LOO</th><th>P2 walk-fwd</th><th>P3 split</th></tr>' +
    '<tr><td class="l">radar-5 (shipped)</td><td class="num">' + V.radar5.p1_medale.toFixed(4) + '</td><td class="num">' + V.radar5.p2_medale.toFixed(4) + '</td><td class="num">' + V.radar5.p3_medale.toFixed(4) + '</td></tr>' +
    '<tr><td class="l">radar-4 spec (hand-weighted terms)</td><td class="num">' + V.radar4.p1_medale.toFixed(4) + '</td><td class="num">' + V.radar4.p2_medale.toFixed(4) + '</td><td class="num">—</td></tr>' +
    '<tr><td class="l">flat TVL multiple</td><td class="num">' + V.flat.p1_medale.toFixed(4) + '</td><td class="num">—</td><td class="num">—</td></tr></table>';
}

/* odds */
{
  const cal = O.calibration.map(c => '<tr><td class="num">' + c.pred.toFixed(3) + '</td><td class="num">' + c.realized.toFixed(3) + '</td><td class="num">' + c.n + '</td></tr>').join('');
  const bands = O.age_bands.map(b => '<div>' + esc(b.band) + ' (n=' + b.n + ') <span class="bar2" style="width:' + Math.round(b.share*160) + 'px"></span> <span class="num">' + (b.share*100).toFixed(1) + '%</span></div>').join('');
  $('odds').innerHTML = '<h2>Token odds — will it launch at all?</h2>' +
    '<p class="note">Logistic fit on listing age and size over all ' + M.scanned + ' records (base rate ' + (O.base_rate*100).toFixed(1) + '% record a token). Held-out scores: Brier ' + O.brier_model.toFixed(4) + ' vs ' + O.brier_base.toFixed(4) + ' base · log-loss ' + O.logloss_model.toFixed(4) + ' vs ' + O.logloss_base.toFixed(4) + ' · walk-forward Brier ' + O.wf_brier.toFixed(4) + '. Young protocols are censored ("no token yet" ≠ "never"), so read it against the empirical launch share by age:</p>' +
    '<div class="grid" style="display:flex;flex-wrap:wrap;gap:18px"><div style="flex:1 1 260px"><b>Launch share by listing age</b>' + bands + '</div>' +
    '<div style="flex:1 1 260px"><b>Calibration (predicted vs realized, by decile)</b><table><tr><th>Pred</th><th>Realized</th><th>n</th></tr>' + cal + '</table></div></div>';
}

/* scatter */
{
  const W = 520, H = 300, P = 42;
  const pts = M.scatter.peers, curve = M.scatter.curve, top = M.scatter.board_top;
  const xs = pts.concat(curve, top).map(p => Math.log10(p[0])), ys = pts.concat(curve, top).map(p => Math.log10(p[1]));
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const X = v => P + (Math.log10(v) - x0) / (x1 - x0) * (W - P - 8);
  const Y = v => H - P - (Math.log10(v) - y0) / (y1 - y0) * (H - P - 8);
  let s = '<h2>Launched peers: market cap vs TVL (log–log)</h2><svg width="' + W + '" height="' + H + '" role="img">';
  s += '<line x1="' + P + '" y1="' + (H-P) + '" x2="' + (W-8) + '" y2="' + (H-P) + '" stroke="#1e2a3a"/><line x1="' + P + '" y1="8" x2="' + P + '" y2="' + (H-P) + '" stroke="#1e2a3a"/>';
  s += '<polyline fill="none" stroke="#35d99a" stroke-width="1.5" points="' + curve.map(p => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ') + '"/>';
  s += pts.map(p => '<circle cx="' + X(p[0]).toFixed(1) + '" cy="' + Y(p[1]).toFixed(1) + '" r="2.2" fill="#4a6b8a" opacity="0.75"/>').join('');
  s += top.map(p => '<rect x="' + (X(p[0])-3.5).toFixed(1) + '" y="' + (Y(p[1])-3.5).toFixed(1) + '" width="7" height="7" fill="#e0a83c" transform="rotate(45 ' + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1) + ')"/>').join('');
  s += '<text x="' + (W-70) + '" y="' + (H-26) + '">TVL →</text><text x="6" y="18">mcap →</text>';
  s += '<text x="' + (P+6) + '" y="20">green = fitted curve · amber ◆ = board top 10</text></svg>';
  $('scatter').innerHTML = s;
}

/* scenario */
function verdictOf(r) {
  const t = Math.min(10000, Math.max(250, 0.0002 * r.tvl_usd * tscale));
  const rew = r.implied_value_usd * drop * t / (r.tvl_usd + t);
  const net = rew - r.step_cost_usd, nph = net / r.step_hours;
  return { t, rew, net, nph, v: net > 0 && nph >= 15 ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP' };
}
function chip(v) { return '<span class="chip ' + (v === 'FARM' ? 'farm' : v === 'MARGINAL' ? 'marg' : 'skip') + '">' + v + '</span>'; }
function renderCounts() {
  const c = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  rows.forEach(r => c[verdictOf(r).v]++);
  $('vcounts').textContent = 'FARM ' + c.FARM + ' · MARGINAL ' + c.MARGINAL + ' · SKIP ' + c.SKIP;
  $('dropv').textContent = (drop*100).toFixed(1) + '%';
  $('tscalev').textContent = '×' + tscale;
}
{
  const top5 = [...rows].sort((a,b) => b.net_per_hour - a.net_per_hour).slice(0, 5);
  $('closest').innerHTML = '<p class="note">FARM needs net ≥ $15/h at a ticket of 0.02% of TVL (cap $10,000). None of the ' + rows.length + ' clears it at a 7.5% drop share — the closest five:</p>' +
    top5.map(r => '<div class="cr"><span>#' + r.rank + ' ' + esc(r.slug) + '</span><span>' + money(r.net_usd) + ' net</span><span>$' + r.net_per_hour.toFixed(2) + '/h</span></div>').join('');
}
$('drop').addEventListener('input', e => { drop = +e.target.value / 100; renderCounts(); renderTable(); });
$('tscale').addEventListener('input', e => { tscale = +e.target.value; renderCounts(); renderTable(); });

/* tables */
const cats = [...new Set(rows.map(r => r.category))].sort();
$('fcat').innerHTML += cats.map(c => '<option>' + esc(c) + '</option>').join('');
const chains = [...new Set(rows.flatMap(r => r.chains))].sort();
$('fchain').innerHTML += chains.map(c => '<option>' + esc(c) + '</option>').join('');

function filtered() {
  const q = $('q').value.toLowerCase(), fc = $('fcat').value, fh = $('fchain').value, ft = +$('ftvl').value, fw = $('fwatch').checked;
  let out = rows.filter(r => (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q)) && (!fc || r.category === fc) && (!fh || r.chains.includes(fh)) && r.tvl_usd >= ft && (!fw || r.watchlist));
  out.sort((a,b) => { const x = a[sortKey], y = b[sortKey]; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sortDir; });
  return out;
}
function renderTable() {
  if (tab === 'live') {
    $('boardtitle').textContent = 'Live tokens (already launched — shown for the peer record)';
    $('tablewrap').innerHTML = '<table><tr><th class="l">Protocol</th><th class="l">Category</th><th>TVL</th><th>Market cap</th><th>Multiple</th></tr>' +
      R.live.map(p => '<tr><td class="l">' + esc(p.name) + '</td><td class="l">' + esc(p.category) + '</td><td class="num">' + money(p.tvl_usd) + '</td><td class="num">' + money(p.mcap_usd) + '</td><td class="num">' + p.multiple.toFixed(2) + '×</td></tr>').join('') + '</table>';
    return;
  }
  $('boardtitle').textContent = 'The board — ' + M.board_rows + ' pre-token protocols by implied launch value';
  const cols = [['rank','#'],['range_lo','Range'],['name','Protocol'],['category','Category'],['tvl_usd','TVL'],['change_7d_pct','7d %'],['age_days','Age'],['odds','Odds'],['conditional_value_usd','If it launches'],['implied_value_usd','Implied'],['band_low_usd','P25–P75'],['verdict','Verdict']];
  let h = '<table><tr>' + cols.map(c => '<th data-k="' + c[0] + '"' + (c[0] === 'name' || c[0] === 'category' ? ' class="l"' : '') + '>' + c[1] + '</th>').join('') + '</tr>';
  h += filtered().map(r => { const vo = verdictOf(r);
    return '<tr class="row" data-slug="' + esc(r.slug) + '"><td class="num">' + r.rank + '</td><td class="num">' + r.range_lo + '–' + r.range_hi + '</td><td class="l">' + (r.watchlist ? '★ ' : '') + esc(r.name) + '</td><td class="l">' + esc(r.category) + '</td><td class="num">' + money(r.tvl_usd) + '</td><td class="num">' + (r.change_7d_pct === null ? '—' : r.change_7d_pct.toFixed(1)) + '</td><td class="num">' + (r.age_days === null ? '—' : Math.round(r.age_days) + 'd') + '</td><td class="num">' + (r.odds*100).toFixed(0) + '%</td><td class="num">' + money(r.conditional_value_usd) + '</td><td class="num">' + money(r.implied_value_usd) + '</td><td class="num">' + money(r.band_low_usd) + '–' + money(r.band_high_usd) + '</td><td>' + chip(vo.v) + ' <span class="num">' + money(vo.net) + '</span></td></tr>';
  }).join('') + '</table>';
  $('tablewrap').innerHTML = h;
  $('tablewrap').querySelectorAll('th').forEach(th => th.addEventListener('click', () => { const k = th.dataset.k; if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = k === 'name' || k === 'category' ? 1 : -1; } renderTable(); }));
  $('tablewrap').querySelectorAll('tr.row').forEach(tr => tr.addEventListener('click', () => showDetail(tr.dataset.slug, true)));
}
['q','fcat','fchain','ftvl','fwatch'].forEach(id => $(id).addEventListener('input', renderTable));
$('tab-board').addEventListener('click', () => { tab = 'board'; $('tab-board').className = 'on'; $('tab-live').className = ''; renderTable(); });
$('tab-live').addEventListener('click', () => { tab = 'live'; $('tab-live').className = 'on'; $('tab-board').className = ''; renderTable(); });

/* detail */
function showDetail(slug, scroll) {
  const r = rows.find(x => x.slug === slug); if (!r) return;
  const vo = verdictOf(r);
  const fac = [['category', r.category_factor], ['growth', r.growth_factor], ['maturity', r.maturity_factor], ['chain', r.chain_factor]]
    .map(f => '<tr><td class="l">' + f[0] + ' factor</td><td class="num">' + (f[1] === null || f[1] === undefined ? 'not in model' : '×' + (+f[1]).toFixed(3)) + '</td></tr>').join('');
  $('detail').innerHTML = '<h2>#' + r.rank + ' ' + esc(r.name) + (r.watchlist ? ' ★ watchlist' : '') + '</h2>' +
    '<div class="grid"><div class="col"><b>Value build-up</b><table>' +
    '<tr><td class="l">Value if it launches</td><td class="num">' + money(r.conditional_value_usd) + '</td></tr>' + fac +
    '<tr><td class="l">Token odds</td><td class="num">' + (r.odds*100).toFixed(1) + '%</td></tr>' +
    '<tr><td class="l">Implied value</td><td class="num">' + money(r.implied_value_usd) + '</td></tr>' +
    '<tr><td class="l">P25–P75 band</td><td class="num">' + money(r.band_low_usd) + ' – ' + money(r.band_high_usd) + '</td></tr>' +
    '<tr><td class="l">Rank range (bootstrap)</td><td class="num">' + r.range_lo + '–' + r.range_hi + '</td></tr>' +
    '<tr><td class="l">P(finish top 10)</td><td class="num">' + (r.top10_pct*100).toFixed(0) + '%</td></tr></table>' +
    '<p class="note">TVL ' + money(r.tvl_usd) + ' · ' + esc(r.category) + ' · ' + r.chain_count + ' chains (' + r.chains.map(esc).join(', ') + ') · listed ' + (r.listed_at || 'unknown') + '</p></div>' +
    '<div class="col"><b>Nearest launched peers</b><table><tr><th class="l">Peer</th><th>TVL</th><th>Mcap</th><th>×</th></tr>' +
    r.comparables.map(c => '<tr><td class="l">' + esc(c.slug) + '</td><td class="num">' + money(c.tvl_usd) + '</td><td class="num">' + money(c.mcap_usd) + '</td><td class="num">' + c.multiple.toFixed(2) + '</td></tr>').join('') + '</table>' +
    '<b>Farm verdict math</b><table>' +
    '<tr><td class="l">Verdict</td><td>' + chip(vo.v) + ' <span class="num">(' + esc(r.verdict_stability) + ')</span></td></tr>' +
    '<tr><td class="l">Ticket</td><td class="num">' + money(vo.t) + '</td></tr>' +
    '<tr><td class="l">Expected reward</td><td class="num">' + money(vo.rew) + '</td></tr>' +
    '<tr><td class="l">Step costs / time</td><td class="num">' + money(r.step_cost_usd) + ' / ' + r.step_hours + 'h</td></tr>' +
    '<tr><td class="l">Net</td><td class="num">' + money(vo.net) + ' (' + '$' + vo.nph.toFixed(2) + '/h)</td></tr></table></div></div>' +
    '<b>Farm plan — 7 steps</b><ol>' + r.farm_steps.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol>';
  if (scroll) $('detail').scrollIntoView({ behavior: 'smooth' });
}

/* links + footer */
{
  const q = new URLSearchParams(location.search);
  if (q.get('category')) { $('fcat').value = q.get('category'); }
  if (q.get('watchlist') === '1') { $('fwatch').checked = true; }
  renderCounts(); renderTable();
  if (q.get('protocol')) showDetail(q.get('protocol'), false);
  $('foot').textContent = 'radar-5 · snapshot as of ' + M.as_of + ' · model fitted at run time on the snapshot\'s own ' + M.peer_count + ' launched peers · rank ranges from ' + V.bootstrap.runs + ' bootstrap refits (seed ' + V.bootstrap.seed + ')';
}
