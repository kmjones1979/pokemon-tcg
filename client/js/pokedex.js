// Pokédex completion overlay. Renders all 1025 species as a grid;
// owned ones are colored + show count, unowned ones are silhouettes.
// Generation totals are shown at the top for the "gotta catch 'em all"
// progress bar feel. A search box at the top live-filters by name,
// dex id, type, or generation (e.g. "char fire" or "gen3 grass").

import { filterPokedexEntries } from "./search-utils.js";

let _allRows = [];   // unfiltered rows from /me/pokedex
let _query = "";     // current search string
let _evolveOnly = false; // when true, grid shows only "ready to evolve" species
let _nameById = new Map(); // id → name, for resolving evolution targets

// Copies you must own before a species can be evolved. Must match the
// server's EVOLVE_MIN_COPIES in server-modules/collection.js. The number
// actually consumed is stage-dependent and comes from each row's evolveCost.
const EVOLVE_MIN_COPIES = 3;

// A species is ready to evolve when you own enough duplicates AND it has a
// next form. Single source of truth for the button + the filter view.
function isReadyToEvolve(r) {
  return !!r.evolvesToId && r.quantity >= EVOLVE_MIN_COPIES;
}

export async function open() {
  let overlay = document.querySelector(".pdx-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "pdx-overlay";
    document.body.appendChild(overlay);
  }
  overlay.classList.remove("hidden");
  await refresh(overlay, { showLoading: true });
}

// Fetch the latest Pokédex state and (re)render. Preserves the active search
// query. Called on open and after each successful evolution.
async function refresh(overlay, { showLoading = false } = {}) {
  if (showLoading) overlay.innerHTML = `<div class="pdx-loading">Loading Pokédex…</div>`;
  try {
    const r = await fetch("/me/pokedex");
    if (!r.ok) throw new Error(r.statusText);
    const { total, owned, rows } = await r.json();
    _nameById = new Map(rows.map((row) => [row.id, row.name]));
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
  const readyCount = rows.filter(isReadyToEvolve).length;
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
        <button class="pdx-evolve-filter ${_evolveOnly ? "active" : ""}" ${readyCount || _evolveOnly ? "" : "disabled"}
                title="Show only Pokémon you can evolve right now">
          ▲ Ready to Evolve <span class="pdx-evolve-badge">${readyCount}</span>
        </button>
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
  const evoBtn   = overlay.querySelector(".pdx-evolve-filter");
  searchEl.value = _query;
  const applyFilter = () => {
    let filtered = filterPokedexEntries(_allRows, _query);
    if (_evolveOnly) filtered = filtered.filter(isReadyToEvolve);
    countEl.textContent = (_query || _evolveOnly)
      ? `${filtered.length} of ${_allRows.length}`
      : "";
    paintGrid(overlay, filtered, { evolveView: _evolveOnly });
  };
  searchEl.addEventListener("input", (e) => {
    _query = e.target.value;
    applyFilter();
  });
  evoBtn?.addEventListener("click", () => {
    _evolveOnly = !_evolveOnly;
    evoBtn.classList.toggle("active", _evolveOnly);
    applyFilter();
  });
  applyFilter();
  overlay.querySelector(".pdx-x").addEventListener("click", close);
}

function paintGrid(overlay, rows, { evolveView = false } = {}) {
  const grid = overlay.querySelector(".pdx-grid");
  if (!grid) return;
  grid.innerHTML = "";
  if (rows.length === 0) {
    grid.innerHTML = `<div class="pdx-empty">${evolveView
      ? `Nothing ready to evolve yet — collect ${EVOLVE_MIN_COPIES} copies of a Pokémon that has a next form.`
      : "No Pokémon match that search."}</div>`;
    return;
  }
  for (const r of rows) {
    const cell = document.createElement("div");
    const ownedClass = r.quantity > 0 ? "owned" : "locked";
    const rarity = r.legendary ? "legendary" : r.mythical ? "mythical" : "";
    // Evolvable when we own enough duplicates AND the species has a next form.
    const canEvolve = isReadyToEvolve(r);
    const evoName = r.evolvesToId ? (_nameById.get(r.evolvesToId) || `#${r.evolvesToId}`) : "";
    // Copies this evolution actually consumes (1 for a basic, 2 for a stage 1).
    const cost = r.evolveCost || 1;
    cell.className = `pdx-cell ${ownedClass} ${rarity}${canEvolve ? " can-evolve" : ""}`;
    cell.title = r.quantity > 0
      ? `#${r.id} ${r.name} ×${r.quantity}${r.shinyLevel ? ` ★${r.shinyLevel}` : ""}`
      : `#${r.id} ???`;
    cell.innerHTML = `
      <div class="pdx-id">${String(r.id).padStart(3, "0")}</div>
      <img src="${r.sprite}" loading="lazy" alt="${r.quantity > 0 ? escape(r.name) : '???'}">
      <div class="pdx-name">${r.quantity > 0 ? escape(r.name) : "???"}</div>
      ${r.quantity > 1 ? `<div class="pdx-qty">×${r.quantity}</div>` : ""}
      ${r.shinyLevel > 0 ? `<div class="pdx-shiny">★${r.shinyLevel}</div>` : ""}
      ${canEvolve ? `<button class="pdx-evolve" title="Evolve into ${escape(evoName)} (uses ${cost} ${cost === 1 ? "copy" : "copies"})">▲ Evolve</button>` : ""}
    `;
    if (canEvolve) {
      cell.querySelector(".pdx-evolve").addEventListener("click", (e) => {
        e.stopPropagation();
        evolveCard(overlay, r.id, r.name, evoName, cost);
      });
    }
    grid.appendChild(cell);
  }
}

// Evolve one copy of `pokemonId` into its next form. `cost` copies are
// consumed (1 for a basic, 2 for a stage 1); the server is authoritative.
async function evolveCard(overlay, pokemonId, fromName, toName, cost) {
  const copies = cost === 1 ? "1 copy" : `${cost} copies`;
  if (!confirm(`Evolve ${fromName} into ${toName}?\n\nThis uses ${copies} of ${fromName} and gives you 1 ${toName}.`)) {
    return;
  }
  try {
    const r = await fetch("/me/evolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pokemonId }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || r.statusText || "Evolution failed");
    // Refresh so counts (both species) and evolve eligibility update in place.
    await refresh(overlay);
    toast(overlay, `✨ ${fromName} evolved into ${data.to?.name || toName}!`);
  } catch (err) {
    toast(overlay, `Couldn't evolve: ${err.message || "unknown"}`, true);
  }
}

// Lightweight self-dismissing toast anchored to the overlay.
function toast(overlay, message, isError = false) {
  const el = document.createElement("div");
  el.className = `pdx-toast${isError ? " err" : ""}`;
  el.textContent = message;
  overlay.appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

function escape(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
