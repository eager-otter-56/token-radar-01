'use strict';
/* Token Launch Radar — the page. Everything renders from window.RADAR
   (../data.js, written by main.ts from the same board as board.json):
   no fetch, no network, no recomputation of the model in the page.
   Filter, sort, view and detail state live in the URL query string,
   so every view has a link of its own. */

const R = window.RADAR;
const app = document.getElementById('app');
const params = new URLSearchParams(location.search);

const state = {
  view: params.get('view') === 'live' ? 'live' : 'board',
  q: params.get('q') || '',
  category: params.get('category') || '',
  chain: params.get('chain') || '',
  watchlist: params.get('watchlist') === '1',
  min: Number(params.get('min') || 0),
  sort: params.get('sort') || 'rank',
  dir: params.get('dir') === 'desc' ? -1 : 1,
  protocol: params.get('protocol') || '',
};

const bySlug = new Map(R.rows.map((row) => [row.slug, row]));

/* ---------- formatting ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtUsd(n) {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n;
}

function fmtFull(n) {
  return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtPct(v) {
  if (v === null) return '<span class="slug">—</span>';
  const cls = v > 0 ? 'up' : v < 0 ? 'down' : '';
  return `<span class="${cls}">${v > 0 ? '+' : ''}${v.toFixed(1)}%</span>`;
}

function fmtAge(days) {
  if (days === null) return '—';
  if (days >= 730) return (days / 365).toFixed(1) + ' y';
  return days + ' d';
}

function fmtMult(x) {
  return x.toFixed(2) + '×';
}

function chainLabel(chains) {
  if (chains.length === 0) return '—';
  if (chains.length <= 2) return esc(chains.join(', '));
  return esc(chains.slice(0, 2).join(', ')) + ' +' + (chains.length - 2);
}

/* ---------- URL state ---------- */

function syncUrl() {
  const p = new URLSearchParams();
  if (state.view === 'live') p.set('view', 'live');
  if (state.q) p.set('q', state.q);
  if (state.category) p.set('category', state.category);
  if (state.chain) p.set('chain', state.chain);
  if (state.watchlist) p.set('watchlist', '1');
  if (state.min) p.set('min', String(state.min));
  if (state.sort !== 'rank') p.set('sort', state.sort);
  if (state.dir === -1) p.set('dir', 'desc');
  if (state.protocol) p.set('protocol', state.protocol);
  const qs = p.toString();
  history.replaceState(null, '', qs ? '?' + qs : location.pathname);
}

/* ---------- shared chrome ---------- */

function masthead() {
  return `
  <header class="masthead">
    <p class="eyebrow">Token Launch Radar · model ${esc(R.model_version)}</p>
    <h1>Pre-token protocols, <span class="thin">ranked by what their launch would be worth.</span></h1>
    <p class="lede">Every protocol in the sealed DefiLlama snapshot that <strong>records no token yet</strong> —
    and is not a wrapped, staked or bridged product of one that trades — scored by a valuation model
    calibrated on the protocols whose tokens already trade, and given a concrete plan for farming it.</p>
    <p class="source-line">Snapshot: ${esc(R.as_of)} · Source: ${esc(R.source)} · Watchlist floor: ${fmtUsd(R.floor_usd)} TVL</p>
    <div class="stats">
      <div class="stat"><div class="num">${R.scanned}</div><div class="lab">Protocols scanned</div></div>
      <div class="stat"><div class="num">${R.board_size}</div><div class="lab">Pre-token protocols ranked</div></div>
      <div class="stat"><div class="num"><em>${R.watchlist_covered}/${R.watchlist_size}</em></div><div class="lab">Watchlist covered</div></div>
      <div class="stat"><div class="num">${R.live_size}</div><div class="lab">Tokens already trading, set aside</div></div>
    </div>
  </header>`;
}

function slimHead() {
  return `
  <header class="masthead slim">
    <p class="eyebrow">Token Launch Radar · model ${esc(R.model_version)}</p>
    <p class="source-line">Snapshot: ${esc(R.as_of)} · Source: ${esc(R.source)}</p>
  </header>`;
}

function modelSection() {
  return `
    <section class="model-box">
      <h2>How the ranking is made — ${esc(R.model_version)}</h2>
      <p class="formula">implied value = TVL × peer multiple × growth × maturity × chain breadth</p>
      <p>The <strong>peer multiple</strong> is the median market-cap ÷ TVL of the live-token protocols in the
      same category (all-market median ${fmtMult(R.global_multiple)}), pulled toward that market median so a
      category priced by one or two peers cannot swing the board, and clamped between 0.02× and 2.50×.
      <strong>Growth</strong> adds the 7-day TVL change, clamped to −50%…+100% and weighted ×0.35.
      <strong>Maturity</strong> rewards time tracked with no token, from 0.70× up to 1.00× at three years.
      <strong>Breadth</strong> adds 3% per extra chain, up to five. No protocol is scored by name:
      one function, fed only by the snapshot, prices every row.</p>
      <p class="fine">Eligibility is strict: no market cap, no CoinGecko id and no symbol on the record, and the
      protocol is not a bridge, liquid-staking, restaking or exchange product, not a versioned pool and not a
      wrapped or staked product by name. The detail view of every row shows its full arithmetic, including the
      peer band between the category's 25th and 75th percentile multiples.</p>
    </section>`;
}

function viewToggle() {
  return `
  <div class="toolbar">
    <div class="views" role="group" aria-label="View">
      <button type="button" data-view="board" aria-pressed="${state.view === 'board'}">Launch board</button>
      <button type="button" data-view="live" aria-pressed="${state.view === 'live'}">Live tokens</button>
    </div>
  </div>`;
}

/* ---------- the board ---------- */

const SORTS = {
  rank: { label: '#', num: true, get: (r) => r.rank },
  name: { label: 'Protocol', num: false, get: (r) => r.name.toLowerCase() },
  category: { label: 'Category', num: false, get: (r) => (r.category || '').toLowerCase() },
  tvl: { label: 'TVL', num: true, get: (r) => r.tvl_usd },
  change: { label: '7d %', num: true, get: (r) => (r.change_7d === null ? -Infinity : r.change_7d) },
  peer: { label: 'Peer ×', num: true, get: (r) => r.peer_multiple },
  implied: { label: 'Implied value', num: true, get: (r) => r.implied_value_usd },
  age: { label: 'Age', num: true, get: (r) => (r.age_days === null ? -1 : r.age_days) },
};

function filteredRows() {
  const q = state.q.trim().toLowerCase();
  const rows = R.rows.filter((r) => {
    if (state.watchlist && !r.watchlist) return false;
    if (state.category && (r.category || 'Uncategorised') !== state.category) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (state.min && r.tvl_usd < state.min) return false;
    if (q && !r.name.toLowerCase().includes(q) && !r.slug.includes(q)) return false;
    return true;
  });
  const get = SORTS[state.sort].get;
  rows.sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    const cmp = typeof va === 'string' ? (va < vb ? -1 : va > vb ? 1 : 0) : va - vb;
    return cmp * state.dir || a.rank - b.rank;
  });
  return rows;
}

function boardHead() {
  const th = (key) => {
    const s = SORTS[key];
    const arrow = state.sort === key ? ` <span class="dir">${state.dir === 1 ? '▲' : '▼'}</span>` : '';
    return `<th class="${s.num ? 'num' : ''}"><button type="button" data-sort="${key}">${s.label}${arrow}</button></th>`;
  };
  return `<thead><tr>${th('rank')}${th('name')}${th('category')}<th class="chains">Chains</th>${th('tvl')}${th('change')}${th('peer')}${th('implied')}${th('age')}</tr></thead>`;
}

function rowHtml(r) {
  return `<tr data-slug="${esc(r.slug)}" tabindex="0" title="Open the detail view for ${esc(r.name)}">
    <td class="rank">${r.rank}</td>
    <td class="name">${esc(r.name)}${r.watchlist ? '<span class="pill">Watchlist</span>' : ''}<span class="slug">${esc(r.slug)}</span></td>
    <td class="cat">${esc(r.category || 'Uncategorised')}</td>
    <td class="chains">${chainLabel(r.chains)}</td>
    <td class="num">${fmtUsd(r.tvl_usd)}</td>
    <td class="num">${fmtPct(r.change_7d)}</td>
    <td class="num">${fmtMult(r.peer_multiple)}</td>
    <td class="num implied">${fmtUsd(r.implied_value_usd)}</td>
    <td class="num">${fmtAge(r.age_days)}</td>
  </tr>`;
}

function filtersHtml() {
  const catOptions = ['<option value="">All categories</option>']
    .concat(R.categories.map((c) => `<option value="${esc(c)}"${c === state.category ? ' selected' : ''}>${esc(c)}</option>`))
    .join('');
  const chainOptions = ['<option value="">All chains</option>']
    .concat(R.chains.map((c) => `<option value="${esc(c)}"${c === state.chain ? ' selected' : ''}>${esc(c)}</option>`))
    .join('');
  const minOptions = [[0, 'Any TVL'], [1e7, '$10M +'], [25e6, '$25M +'], [5e7, '$50M +'], [1e8, '$100M +']]
    .map(([v, label]) => `<option value="${v}"${Number(v) === state.min ? ' selected' : ''}>${label}</option>`)
    .join('');
  return `
  <div class="filters">
    <div class="field"><label for="f-q">Search</label>
      <input type="search" id="f-q" data-role="q" placeholder="Name or slug…" value="${esc(state.q)}"></div>
    <div class="field"><label for="f-cat">Category</label><select id="f-cat" data-role="category">${catOptions}</select></div>
    <div class="field"><label for="f-chain">Chain</label><select id="f-chain" data-role="chain">${chainOptions}</select></div>
    <div class="field"><label for="f-min">Minimum TVL</label><select id="f-min" data-role="min">${minOptions}</select></div>
    <label class="check"><input type="checkbox" data-role="watchlist"${state.watchlist ? ' checked' : ''}> Watchlist only</label>
  </div>
  <p class="count" id="count"></p>`;
}

function renderRows() {
  const rows = filteredRows();
  const body = document.getElementById('board-body');
  const count = document.getElementById('count');
  if (body) {
    body.innerHTML = rows.length
      ? rows.map(rowHtml).join('')
      : '<tr><td colspan="9" class="empty">No protocol matches these filters. Loosen one and sweep again.</td></tr>';
    body.querySelectorAll('tr[data-slug]').forEach((tr) => {
      const open = () => openDetail(tr.getAttribute('data-slug'));
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    });
  }
  if (count) {
    count.innerHTML = `Showing <strong>${rows.length}</strong> of ${R.board_size} ranked protocols` +
      (state.watchlist || state.category || state.chain || state.min || state.q ? ' — filters active, and this view has its own URL.' : '. Click a column to sort; click a row for its detail view and farm plan.');
  }
}

function boardView() {
  return masthead() + viewToggle() + `
  <section id="board">
    ${filtersHtml()}
    <table>${boardHead()}<tbody id="board-body"></tbody></table>
  </section>
  ${modelSection()}
  <p class="foot">Implied values are this radar's own model claims, not predictions and not make.fun's:
  a launch may never happen, and a token's first price is set by a market, not a formula. Farm plans are
  starting points for your own research — capital in any protocol can be lost, and a points page is only
  ever trusted at the address the protocol itself publishes.</p>`;
}

/* ---------- detail view ---------- */

function openDetail(slug) {
  state.protocol = slug || '';
  syncUrl();
  render();
  window.scrollTo(0, 0);
}

function factorRow(label, value, note) {
  return `<tr><td>${label}</td><td class="num">${value}</td><td>${note}</td></tr>`;
}

function detailView(r) {
  const band = r.peer_count >= 4
    ? `Peer band from the category's 25th–75th percentile multiples: ${fmtFull(r.band_low_usd)} – ${fmtFull(r.band_high_usd)}.`
    : `Only ${r.peer_count} live peer${r.peer_count === 1 ? '' : 's'} price this category, so the band is a flat 0.6×–1.5× of the implied value: ${fmtFull(r.band_low_usd)} – ${fmtFull(r.band_high_usd)}.`;
  return slimHead() + `
  <button type="button" class="back" id="back">← Back to the board</button>
  <section class="detail">
    <div class="detail-head">
      <h2>${esc(r.name)}</h2>
      <span class="rank-tag">Radar rank #${r.rank} of ${R.board_size}</span>
      ${r.watchlist ? '<span class="pill">Watchlist</span>' : ''}
    </div>
    <p class="source-line">${esc(r.slug)} · ${esc(r.category || 'Uncategorised')} · records no token in the snapshot
    (no market cap, no CoinGecko id, no symbol)${r.listed_at ? ` · tracked since ${esc(r.listed_at)}` : ' · tracking start unreported'}</p>
    <div class="kv">
      <div class="cell"><div class="k">Implied launch value</div><div class="v">${fmtFull(r.implied_value_usd)}<small>${band}</small></div></div>
      <div class="cell"><div class="k">TVL</div><div class="v">${fmtFull(r.tvl_usd)}<small>7-day change: ${r.change_7d === null ? 'unreported' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%'}</small></div></div>
      <div class="cell"><div class="k">Age with no token</div><div class="v">${r.age_days === null ? 'Unknown' : r.age_days + ' days'}<small>${r.age_days === null ? 'Model uses the 547-day midpoint.' : 'Tracked from ' + esc(r.listed_at || '') + ' to ' + esc(R.as_of) + '.'}</small></div></div>
      <div class="cell"><div class="k">Chains</div><div class="v">${r.chains.length || '—'}<small>${esc(r.chains.join(', ') || 'none named')}</small></div></div>
      <div class="cell"><div class="k">Category peers</div><div class="v">${r.peer_count} live<small>Live-token protocols in ${esc(r.category || 'this category')} price the multiple.</small></div></div>
      <div class="cell"><div class="k">Watchlist</div><div class="v">${r.watchlist ? 'Yes' : 'Below the floor'}<small>${r.watchlist ? 'At or above the ' + fmtUsd(R.floor_usd) + ' watchlist floor.' : 'Found by the early sweep below the ' + fmtUsd(R.floor_usd) + ' floor.'}</small></div></div>
    </div>
    <div class="breakdown">
      <h3>The arithmetic — ${esc(R.model_version)}</h3>
      <table>
        ${factorRow('TVL (snapshot)', fmtFull(r.tvl_usd), 'Total value locked on ' + esc(R.as_of) + '.')}
        ${factorRow('Peer multiple', fmtMult(r.peer_multiple), `Median market-cap ÷ TVL of ${r.peer_count} live ${esc(r.category || '')} peers, shrunk toward the market median.`)}
        ${factorRow('Growth', fmtMult(r.growth_multiplier), '7-day TVL change, clamped to −50%…+100%, weighted ×0.35.')}
        ${factorRow('Maturity', fmtMult(r.maturity_multiplier), 'Time tracked with no token, 0.70× rising to 1.00× at three years.')}
        ${factorRow('Chain breadth', fmtMult(r.chain_multiplier), '+3% per chain past the first, up to five extra chains.')}
        <tr class="total"><td>Implied value</td><td class="num">${fmtFull(r.implied_value_usd)}</td><td>TVL × the four factors above, rounded to whole dollars.</td></tr>
      </table>
    </div>
    <div class="farm">
      <h3>Farm plan — seven steps</h3>
      <ol>${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    </div>
  </section>`;
}

/* ---------- live tokens view ---------- */

function liveView() {
  const rows = R.live.map((p, i) => `<tr>
    <td class="rank">${i + 1}</td>
    <td class="name">${esc(p.name)}<span class="slug">${esc(p.slug)}${p.symbol ? ' · $' + esc(p.symbol) : ''}</span></td>
    <td class="cat">${esc(p.category || 'Uncategorised')}</td>
    <td class="chains">${chainLabel(p.chains)}</td>
    <td class="num">${fmtUsd(p.tvl_usd)}</td>
    <td class="num">${fmtPct(p.change_7d)}</td>
    <td class="num implied">${fmtUsd(p.mcap_usd)}</td>
  </tr>`).join('');
  return masthead() + viewToggle() + `
  <section id="board">
    <p class="count">These protocols <strong>already trade</strong>. The board never ranks them — their market
    caps are the market's own values, and they are what calibrates the peer multiples the radar prices
    pre-token protocols with. Showing the top ${R.live.length} of ${R.live_size} by market cap.</p>
    <table><thead><tr><th class="num">#</th><th>Protocol</th><th>Category</th><th class="chains">Chains</th>
    <th class="num">TVL</th><th class="num">7d %</th><th class="num">Market cap</th></tr></thead>
    <tbody>${rows}</tbody></table>
  </section>`;
}

/* ---------- render + wiring ---------- */

function render() {
  const detail = state.protocol ? bySlug.get(state.protocol) : undefined;
  app.setAttribute('aria-busy', 'false');
  app.innerHTML = '<div class="wrap">' +
    (detail ? detailView(detail) : state.view === 'live' ? liveView() : boardView()) +
    '</div>';
  app.querySelectorAll('[data-view]').forEach((b) => {
    b.addEventListener('click', () => {
      state.view = b.getAttribute('data-view');
      state.protocol = '';
      syncUrl();
      render();
    });
  });
  const back = document.getElementById('back');
  if (back) back.addEventListener('click', () => openDetail(''));
  if (!detail && state.view === 'board') {
    renderRows();
    app.querySelectorAll('[data-sort]').forEach((b) => {
      b.addEventListener('click', () => {
        const key = b.getAttribute('data-sort');
        if (state.sort === key) state.dir = state.dir === 1 ? -1 : 1;
        else {
          state.sort = key;
          state.dir = key === 'name' || key === 'category' || key === 'rank' ? 1 : -1;
        }
        syncUrl();
        render();
      });
    });
    const q = app.querySelector('[data-role="q"]');
    q.addEventListener('input', () => { state.q = q.value; syncUrl(); renderRows(); });
    const cat = app.querySelector('[data-role="category"]');
    cat.addEventListener('change', () => { state.category = cat.value; syncUrl(); renderRows(); });
    const chain = app.querySelector('[data-role="chain"]');
    chain.addEventListener('change', () => { state.chain = chain.value; syncUrl(); renderRows(); });
    const min = app.querySelector('[data-role="min"]');
    min.addEventListener('change', () => { state.min = Number(min.value); syncUrl(); renderRows(); });
    const wl = app.querySelector('[data-role="watchlist"]');
    wl.addEventListener('change', () => { state.watchlist = wl.checked; syncUrl(); renderRows(); });
  }
}

render();
