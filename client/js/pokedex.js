// Pokédex completion overlay. Renders all 1025 species as a grid;
// owned ones are colored + show count, unowned ones are silhouettes.
// Generation totals are shown at the top for the "gotta catch 'em all"
// progress bar feel. A search box at the top live-filters by name,
// dex id, type, or generation (e.g. "char fire" or "gen3 grass").

import { filterPokedexEntries } from "./search-utils.js";

let _allRows = [];   // unfiltered rows from /me/pokedex
let _query = "";     // current search string

export async function open() {
  let overlay = document.querySelector(".pdx-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "pdx-overlay";
    document.body.appendChild(overlay);
  }
  overlay.classList.remove("hidden");
  overlay.innerHTML = `<div class="pdx-loading">Loading Pokédex…</div>`;
  try {
    const r = await fetch("/me/pokedex");
    if (!r.ok) throw new Error(r.statusText);
    const { total, owned, rows } = await r.json();
    render(overlay, rows, owned, total);
  } catch (err) {
    overlay.innerHTML = `<div class="pdx-err">Couldn't load: ${err.message || "unknown"}</div>`;
  }
}

export function close() {
  document.querySelector(".pdx-overlay")?.remove();
}

function render(overlay, rows, owned, total) {
  // Per-generation breakdown.
  const byGen = new Map();
  for (const r of rows) {
    const g = r.generation || 0;
    if (!byGen.has(g)) byGen.set(g, { count: 0, owned: 0 });
    const b = byGen.get(g);
    b.count++;
    if (r.quantity > 0) b.owned++;
  }
  const gens = [...byGen.entries()].sort((a, b) => a[0] - b[0]);
  const pct = Math.round((owned / total) * 1000) / 10;

  _allRows = rows;
  overlay.innerHTML = `
    <div class="pdx-card">
      <header class="pdx-header">
        <div class="pdx-title">Pokédex</div>
        <div class="pdx-summary">
          <div class="pdx-pct">${pct.toFixed(1)}%</div>
          <div class="pdx-count">${owned} / ${total} caught</div>
        </div>
        <button class="pdx-x">✕</button>
      </header>
      <div class="pdx-search-row">
        <input type="search" class="pdx-search" placeholder="Search by name, #id, type, or gen…" autocomplete="off" autocapitalize="off" spellcheck="false">
        <span class="pdx-search-count"></span>
      </div>
      <div class="pdx-genbar">
        ${gens.map(([g, b]) => `
          <div class="pdx-gen">
            <span class="pdx-gen-label">Gen ${g}</span>
            <div class="pdx-gen-bar"><div class="pdx-gen-fill" style="width:${(b.owned / b.count) * 100}%"></div></div>
            <span class="pdx-gen-count">${b.owned}/${b.count}</span>
          </div>
        `).join("")}
      </div>
      <div class="pdx-grid"></div>
    </div>
  `;
  const searchEl = overlay.querySelector(".pdx-search");
  const countEl  = overlay.querySelector(".pdx-search-count");
  searchEl.value = _query;
  const applyFilter = () => {
    const filtered = filterPokedexEntries(_allRows, _query);
    countEl.textContent = _query
      ? `${filtered.length} of ${_allRows.length}`
      : "";
    paintGrid(overlay, filtered);
  };
  searchEl.addEventListener("input", (e) => {
    _query = e.target.value;
    applyFilter();
  });
  applyFilter();
  overlay.querySelector(".pdx-x").addEventListener("click", close);
}

function paintGrid(overlay, rows) {
  const grid = overlay.querySelector(".pdx-grid");
  if (!grid) return;
  grid.innerHTML = "";
  if (rows.length === 0) {
    grid.innerHTML = `<div class="pdx-empty">No Pokémon match that search.</div>`;
    return;
  }
  for (const r of rows) {
    const cell = document.createElement("div");
    const ownedClass = r.quantity > 0 ? "owned" : "locked";
    const rarity = r.legendary ? "legendary" : r.mythical ? "mythical" : "";
    cell.className = `pdx-cell ${ownedClass} ${rarity}`;
    cell.title = r.quantity > 0
      ? `#${r.id} ${r.name} ×${r.quantity}${r.shinyLevel ? ` ★${r.shinyLevel}` : ""}`
      : `#${r.id} ???`;
    cell.innerHTML = `
      <div class="pdx-id">${String(r.id).padStart(3, "0")}</div>
      <img src="${r.sprite}" loading="lazy" alt="${r.quantity > 0 ? escape(r.name) : '???'}">
      <div class="pdx-name">${r.quantity > 0 ? escape(r.name) : "???"}</div>
      ${r.quantity > 1 ? `<div class="pdx-qty">×${r.quantity}</div>` : ""}
      ${r.shinyLevel > 0 ? `<div class="pdx-shiny">★${r.shinyLevel}</div>` : ""}
    `;
    grid.appendChild(cell);
  }
}

function escape(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
