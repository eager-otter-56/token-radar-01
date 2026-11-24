"use strict";

// Token Launch Radar — radar-4 dashboard.
// Everything renders from window.RADAR (../data.js), which main.ts builds
// from the snapshot. No network calls, no external assets.

const R = window.RADAR;
const meta = R.meta;
const rows = R.rows;
const live = R.live;

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtUsd(x) {
  if (x === null || x === undefined) return "—";
  const neg = x < 0;
  const digits = String(Math.round(Math.abs(x)));
  return (neg ? "-$" : "$") + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtPct(x) {
  if (x === null || x === undefined) return "—";
  const v = Math.round(x * 10) / 10;
  return (v > 0 ? "+" : "") + v.toFixed(1) + "%";
}

function fmtMult(x) {
  if (x === null || x === undefined || !isFinite(x)) return "—";
  return (Math.round(x * 100) / 100).toFixed(2) + "×";
}

// ------------------------------------------------------------------ state

const params = new URLSearchParams(window.location.search);
const state = {
  tab: "board",
  search: "",
  category: params.get("category") || "",
  chain: "",
  minTvl: 0,
  watchlistOnly: params.get("watchlist") === "1",
  sortKey: "rank",
  sortDir: 1,
  selected: params.get("protocol") || null,
};

// ----------------------------------------------------------------- header

$("as-of").textContent = meta.as_of;

const statDefs = [
  [meta.scanned, "Scanned"],
  [meta.board_rows, "Board rows"],
  [meta.watchlist_covered + " / 40", "Watchlist"],
  [meta.live_token_count, "Live set aside"],
  [meta.peer_count, "Peers fitted"],
];
$("stats").innerHTML = statDefs
  .map(([v, k]) => `<div class="stat"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`)
  .join("");

// ------------------------------------------------------------------ model

$("fit-peers").textContent = meta.peer_count;
$("fit-alpha").textContent = meta.size_curve.alpha.toFixed(4);
$("fit-beta").textContent = meta.size_curve.beta.toFixed(4);
$("fit-sd").textContent = meta.residual_sd.toFixed(3);
$("fit-split").textContent = meta.validation.fit_n + " fit / " + meta.validation.test_n + " held out";

const valRows = [
  ["radar-4 — size curve + category factor", meta.validation.radar4, true],
  ["radar-3 style — category multiples", meta.validation.radar3, false],
  ["Flat — one global multiple", meta.validation.flat, false],
];
$("validation-body").innerHTML = valRows
  .map(
    ([label, s, best]) =>
      `<tr class="${best ? "best" : ""}"><td>${esc(label)}</td><td>${s.medale.toFixed(3)}</td><td>${Math.round(s.within2 * 100)}%</td></tr>`,
  )
  .join("");

// ---------------------------------------------------------------- filters

const categories = [...new Set(rows.map((r) => r.category))].sort();
$("filter-category").innerHTML =
  '<option value="">All categories</option>' +
  categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
if (state.category) $("filter-category").value = state.category;

const chains = [...new Set(rows.flatMap((r) => r.chains))].sort();
$("filter-chain").innerHTML =
  '<option value="">All chains</option>' +
  chains.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");

$("filter-watchlist").checked = state.watchlistOnly;

// ------------------------------------------------------------------- board

function rowMult(r) {
  return r.tvl_usd > 0 ? r.implied_value_usd / r.tvl_usd : null;
}

function filteredRows() {
  const q = state.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (state.watchlistOnly && !r.watchlist) return false;
    if (state.category && r.category !== state.category) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (r.tvl_usd < state.minTvl) return false;
    if (q && !r.name.toLowerCase().includes(q) && !r.slug.toLowerCase().includes(q)) return false;
    return true;
  });
}

function sortRows(list) {
  const key = state.sortKey;
  const dir = state.sortDir;
  const val = (r) => {
    if (key === "mult") return rowMult(r) ?? -1;
    if (key === "watchlist") return r.watchlist ? 1 : 0;
    if (key === "name") return r.name.toLowerCase();
    if (key === "category") return r.category.toLowerCase();
    return r[key] ?? -Infinity;
  };
  return [...list].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return a.rank - b.rank;
  });
}

function renderBoard() {
  const list = sortRows(filteredRows());
  $("row-count").textContent = `Showing ${list.length} of ${rows.length} pre-token protocols`;
  $("board-body").innerHTML = list
    .map((r) => {
      const chgCls = r.change_7d_pct === null ? "" : r.change_7d_pct >= 0 ? "pos" : "neg";
      return (
        `<tr data-slug="${esc(r.slug)}" class="${state.selected === r.slug ? "selected" : ""}">` +
        `<td>${r.rank}</td>` +
        `<td><span class="pname">${esc(r.name)}</span><br><span class="pslug">${esc(r.slug)}</span></td>` +
        `<td>${esc(r.category)}</td>` +
        `<td class="num">${fmtUsd(r.tvl_usd)}</td>` +
        `<td class="num ${chgCls}">${fmtPct(r.change_7d_pct)}</td>` +
        `<td class="num implied">${fmtUsd(r.implied_value_usd)}</td>` +
        `<td class="num band">${fmtUsd(r.band_low_usd)} – ${fmtUsd(r.band_high_usd)}</td>` +
        `<td class="num">${fmtMult(rowMult(r))}</td>` +
        `<td>${r.watchlist ? '<span class="star">★</span>' : ""}</td>` +
        `</tr>`
      );
    })
    .join("");
  for (const tr of $("board-body").querySelectorAll("tr")) {
    tr.addEventListener("click", () => selectProtocol(tr.dataset.slug));
  }
  document.querySelectorAll("#board-table th").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.key === state.sortKey);
  });
}

function renderLive() {
  $("live-body").innerHTML = live
    .map(
      (p) =>
        `<tr><td><span class="pname">${esc(p.name)}</span><br><span class="pslug">${esc(p.slug)}</span></td>` +
        `<td>${esc(p.category)}</td>` +
        `<td class="num">${fmtUsd(p.tvl_usd)}</td>` +
        `<td class="num">${fmtUsd(p.mcap_usd)}</td>` +
        `<td class="num">${fmtMult(p.multiple)}</td></tr>`,
    )
    .join("");
}

// ------------------------------------------------------------------ detail

function factorRow(label, value) {
  return `<tr><td>${esc(label)}</td><td>${esc(value)}</td></tr>`;
}

function selectProtocol(slug) {
  state.selected = slug;
  const r = rows.find((x) => x.slug === slug);
  if (!r) {
    $("detail-panel").classList.add("hidden");
    renderBoard();
    return;
  }
  const panel = $("detail-panel");
  panel.classList.remove("hidden");
  $("detail-content").innerHTML =
    `<h3>${esc(r.name)} ${r.watchlist ? '<span class="star">★</span>' : ""}</h3>` +
    `<p class="sub">${esc(r.slug)} · ${esc(r.category)} · rank #${r.rank} of ${rows.length} · ` +
    `${r.chain_count} chain${r.chain_count === 1 ? "" : "s"}: ${esc(r.chains.join(", "))}</p>` +
    `<div class="detail-grid"><div>` +
    `<h4>Value breakdown</h4><table class="factor-table">` +
    factorRow("TVL", fmtUsd(r.tvl_usd)) +
    factorRow("Size-curve value (e^α · TVL^β)", fmtUsd(r.size_curve_value_usd)) +
    factorRow("Category factor (" + r.peer_count + (r.peer_count === 1 ? " peer" : " peers") + ")", "× " + r.category_factor.toFixed(2)) +
    factorRow("Growth factor (7d " + fmtPct(r.change_7d_pct) + ")", "× " + r.growth_factor.toFixed(3)) +
    factorRow("Maturity factor (" + (r.age_days === null ? "age unknown" : r.age_days + " days listed") + ")", "× " + r.maturity_factor.toFixed(3)) +
    factorRow("Chain factor", "× " + r.chain_factor.toFixed(3)) +
    `<tr class="total"><td>Implied launch value</td><td>${fmtUsd(r.implied_value_usd)}</td></tr>` +
    factorRow("Value band (±1 SD of peer residuals)", fmtUsd(r.band_low_usd) + " – " + fmtUsd(r.band_high_usd)) +
    factorRow("Implied ×TVL", fmtMult(rowMult(r))) +
    `</table></div><div>` +
    `<h4>Farm plan — 7 steps</h4><ol class="farm-steps">` +
    r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join("") +
    `</ol></div></div>`;
  renderBoard();
  panel.scrollIntoView({ behavior: "auto", block: "start" });
}

$("detail-close").addEventListener("click", () => {
  state.selected = null;
  $("detail-panel").classList.add("hidden");
  renderBoard();
});

// ------------------------------------------------------------------ events

$("tab-board").addEventListener("click", () => setTab("board"));
$("tab-live").addEventListener("click", () => setTab("live"));

function setTab(tab) {
  state.tab = tab;
  $("tab-board").classList.toggle("active", tab === "board");
  $("tab-live").classList.toggle("active", tab === "live");
  $("board-table").classList.toggle("hidden", tab !== "board");
  $("live-table").classList.toggle("hidden", tab !== "live");
}

$("search").addEventListener("input", (e) => {
  state.search = e.target.value;
  renderBoard();
});
$("filter-category").addEventListener("change", (e) => {
  state.category = e.target.value;
  renderBoard();
});
$("filter-chain").addEventListener("change", (e) => {
  state.chain = e.target.value;
  renderBoard();
});
$("filter-tvl").addEventListener("change", (e) => {
  state.minTvl = Number(e.target.value);
  renderBoard();
});
$("filter-watchlist").addEventListener("change", (e) => {
  state.watchlistOnly = e.target.checked;
  renderBoard();
});

document.querySelectorAll("#board-table th[data-key]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.key;
    if (state.sortKey === key) {
      state.sortDir = -state.sortDir;
    } else {
      state.sortKey = key;
      state.sortDir = key === "name" || key === "category" ? 1 : -1;
      if (key === "rank") state.sortDir = 1;
    }
    renderBoard();
  });
});

// --------------------------------------------------------------------- go

renderBoard();
renderLive();
if (state.selected) selectProtocol(state.selected);
