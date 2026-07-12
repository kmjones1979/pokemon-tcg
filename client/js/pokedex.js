// Pokédex completion overlay. Renders all 1025 species as a grid;
// owned ones are colored + show count, unowned ones are silhouettes.
// Generation totals are shown at the top for the "gotta catch 'em all"
// progress bar feel. A search box at the top live-filters by name,
// dex id, type, or generation (e.g. "char fire" or "gen3 grass").

import { filterPokedexEntries } from "./search-utils.js";

let _allRows = [];   // unfiltered rows from /me/pokedex
let _megas = [];     // Mega showcase rows from /me/pokedex
let _query = "";     // current search string
let _evolveOnly = false; // when true, grid shows only "ready to evolve" species
let _nameById = new Map(); // id → name, for resolving evolution targets

// A species is ready to evolve when it has a next form AND you own at least
// its (stage-dependent) minimum: 2 for a basic, 3 for a stage 1. The server
// stamps evolveMinCopies per row. Single source of truth for the button +
// the filter view.
function isReadyToEvolve(r) {
  return !!r.evolvesToId && r.quantity >= (r.evolveMinCopies || Infinity);
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
    const { total, owned, rows, megas } = await r.json();
    _nameById = new Map(rows.map((row) => [row.id, row.name]));
    _megas = megas || [];
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
      ${renderMegaShowcase()}
      <div class="pdx-grid"></div>
    </div>
  `;
  bindMegaShowcase(overlay);
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

// --- Mega Evolution showcase -----------------------------------------------
// A collapsible strip above the grid. Owned Megas play their looping HD video;
// craftable ones show a "Mega Evolve" button; locked ones show progress toward
// the 3-copy requirement on the base form.
function renderMegaShowcase() {
  if (!_megas.length) return "";
  const readyN = _megas.filter((m) => m.canEvolveNow).length;
  const tiles = _megas.map((m) => {
    const baseName = _nameById.get(m.baseId) || `#${m.baseId}`;
    const media = m.owned && m.videoUrl
      ? `<video class="pdx-mega-vid" autoplay loop muted playsinline poster="${m.sprite}"><source src="${m.videoUrl}" type="video/mp4"></video>`
      : `<img class="pdx-mega-img${m.owned ? "" : " locked"}" src="${m.sprite}" loading="lazy" alt="${escape(m.name)}">`;
    let action;
    if (m.canEvolveNow) {
      action = `<button class="pdx-mega-btn" data-base="${m.baseId}">⚡ Mega Evolve</button>`;
    } else if (m.owned) {
      action = `<div class="pdx-mega-have">Owned ×${m.quantity}</div>`;
    } else {
      action = `<div class="pdx-mega-progress">${m.baseOwned}/${m.minCopies} ${escape(baseName)}</div>`;
    }
    return `
      <div class="pdx-mega-tile${m.owned ? " owned" : ""}${m.canEvolveNow ? " ready" : ""}">
        <div class="pdx-mega-media">
          ${media}
          ${m.owned ? `<span class="pdx-mega-badge">MEGA${m.quantity > 1 ? ` ×${m.quantity}` : ""}</span>` : ""}
        </div>
        <div class="pdx-mega-name">${escape(m.name)}</div>
        ${action}
      </div>`;
  }).join("");
  return `
    <details class="pdx-mega-section" ${readyN ? "open" : ""}>
      <summary class="pdx-mega-summary">⚡ Mega Evolutions${readyN ? ` <span class="pdx-mega-ready-badge">${readyN} ready</span>` : ""}</summary>
      <div class="pdx-mega-strip">${tiles}</div>
    </details>`;
}

function bindMegaShowcase(overlay) {
  overlay.querySelectorAll(".pdx-mega-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const baseId = Number(btn.dataset.base);
      const m = _megas.find((x) => x.baseId === baseId);
      if (m) megaEvolve(overlay, m);
    });
  });
}

// Mega Evolve: own MEGA_MIN_COPIES of the base, consume MEGA_CONSUMES.
async function megaEvolve(overlay, mega) {
  const baseName = _nameById.get(mega.baseId) || `#${mega.baseId}`;
  if (!confirm(`Mega Evolve ${baseName} into ${mega.name}?\n\nThis uses ${mega.consumes} of your ${mega.minCopies} ${baseName} copies and grants 1 ${mega.name}.`)) {
    return;
  }
  try {
    const r = await fetch("/me/mega-evolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pokemonId: mega.baseId }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || r.statusText || "Mega Evolution failed");
    await refresh(overlay);
    toast(overlay, `🌟 ${baseName} Mega Evolved into ${data.to?.name || mega.name}!`);
  } catch (err) {
    toast(overlay, `Couldn't Mega Evolve: ${err.message || "unknown"}`, true);
  }
}

function paintGrid(overlay, rows, { evolveView = false } = {}) {
  const grid = overlay.querySelector(".pdx-grid");
  if (!grid) return;
  grid.innerHTML = "";
  if (rows.length === 0) {
    grid.innerHTML = `<div class="pdx-empty">${evolveView
      ? "Nothing ready to evolve yet — collect duplicates of a Pokémon that has a next form (2 for a basic, 3 for a stage 1)."
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
    // Mega-evolvable when this stage-2 has a Mega and we own its threshold.
    const canMega = !!r.megaId && r.quantity >= (r.megaMinCopies || Infinity);
    cell.className = `pdx-cell ${ownedClass} ${rarity}${canEvolve ? " can-evolve" : ""}${canMega ? " can-mega" : ""}`;
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
      ${canMega ? `<button class="pdx-mega-evolve" title="Mega Evolve (uses 2 copies)">⚡ Mega</button>` : ""}
    `;
    if (canEvolve) {
      cell.querySelector(".pdx-evolve").addEventListener("click", (e) => {
        e.stopPropagation();
        evolveCard(overlay, r.id, r.name, evoName, cost);
      });
    }
    if (canMega) {
      cell.querySelector(".pdx-mega-evolve").addEventListener("click", (e) => {
        e.stopPropagation();
        const m = _megas.find((x) => x.baseId === r.id);
        if (m) megaEvolve(overlay, m);
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
