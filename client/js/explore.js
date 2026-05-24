// Explore — browse every Pokémon in the Pokédex (signed-in or not),
// with a search box and a click-to-see-detail panel. Distinct from
// the existing Pokédex overlay (which is collection-tracking with
// silhouettes for unowned species) — Explore is a reference / browse
// experience.
//
// Data: /api/pokedex/all (public, cached). One fetch on open, kept in
// memory until the user closes the overlay so search + detail clicks
// don't round-trip.

import { TYPE_COLORS } from "./type-chart.js";
import { filterPokedexEntries } from "./search-utils.js";

let _overlay = null;
let _allRows = [];
let _query = "";
let _selectedId = null;

export async function open() {
  _overlay = document.querySelector(".explore-overlay");
  if (!_overlay) {
    _overlay = document.createElement("div");
    _overlay.className = "explore-overlay";
    document.body.appendChild(_overlay);
  }
  _overlay.classList.remove("hidden");
  _overlay.innerHTML = `<div class="explore-loading">Loading the Pokédex…</div>`;
  try {
    const r = await fetch("/api/pokedex/all");
    if (!r.ok) throw new Error(r.statusText);
    const data = await r.json();
    _allRows = data.rows;
    render();
  } catch (err) {
    _overlay.innerHTML = `<div class="explore-error">Couldn't load Pokédex: ${escapeHtml(err.message || "unknown")}</div>`;
  }
}

export function close() {
  document.querySelector(".explore-overlay")?.remove();
  _overlay = null;
  _allRows = [];
  _query = "";
  _selectedId = null;
}

function render() {
  if (!_overlay) return;
  _overlay.innerHTML = `
    <div class="explore-card">
      <header class="explore-header">
        <div class="explore-title">🔍 Explore</div>
        <div class="explore-subtitle">${_allRows.length} Pokémon to discover. Tap one to see its stats.</div>
        <button class="explore-x" aria-label="Close">✕</button>
      </header>
      <div class="explore-search-row">
        <input type="search" class="explore-search" placeholder="Search by name, #id, type, or gen…" autocomplete="off" autocapitalize="off" spellcheck="false" value="${escapeAttr(_query)}">
        <span class="explore-count"></span>
      </div>
      <div class="explore-body">
        <div class="explore-grid"></div>
        <aside class="explore-detail">
          <div class="explore-detail-hint">Tap a Pokémon to see its details here.</div>
        </aside>
      </div>
    </div>
  `;
  _overlay.querySelector(".explore-x").addEventListener("click", close);
  const searchEl = _overlay.querySelector(".explore-search");
  searchEl.addEventListener("input", (e) => {
    _query = e.target.value;
    paintGrid();
  });
  paintGrid();
  if (_selectedId) {
    const row = _allRows.find((r) => r.id === _selectedId);
    if (row) renderDetail(row);
  }
}

function paintGrid() {
  if (!_overlay) return;
  const grid = _overlay.querySelector(".explore-grid");
  const countEl = _overlay.querySelector(".explore-count");
  if (!grid || !countEl) return;
  const filtered = filterPokedexEntries(_allRows, _query);
  countEl.textContent = _query ? `${filtered.length} of ${_allRows.length}` : "";
  grid.innerHTML = "";
  if (filtered.length === 0) {
    grid.innerHTML = `<div class="explore-empty">No Pokémon match that search.</div>`;
    return;
  }
  for (const row of filtered) {
    const cell = document.createElement("button");
    cell.className = "explore-cell";
    cell.dataset.id = String(row.id);
    if (_selectedId === row.id) cell.classList.add("selected");
    if (row.is_legendary) cell.classList.add("legendary");
    else if (row.is_mythical) cell.classList.add("mythical");
    const primary = row.types?.[0] || "normal";
    cell.style.setProperty("--type-1", TYPE_COLORS[primary] || "#888");
    cell.innerHTML = `
      <div class="explore-cell-id">#${String(row.id).padStart(3, "0")}</div>
      <img class="explore-cell-sprite" src="${escapeAttr(row.sprite_front || "")}" alt="${escapeAttr(row.name)}" loading="lazy">
      <div class="explore-cell-name">${escapeHtml(row.name)}</div>
      <div class="explore-cell-types">${(row.types || []).map((t) => `<span class="explore-type-pill" style="background:${TYPE_COLORS[t] || "#888"}">${escapeHtml(t)}</span>`).join("")}</div>
    `;
    cell.addEventListener("click", () => {
      _selectedId = row.id;
      renderDetail(row);
      // Visually mark the selected cell without re-rendering the
      // whole grid (preserves scroll position).
      _overlay.querySelectorAll(".explore-cell.selected").forEach((c) => c.classList.remove("selected"));
      cell.classList.add("selected");
    });
    grid.appendChild(cell);
  }
}

function renderDetail(row) {
  if (!_overlay) return;
  const panel = _overlay.querySelector(".explore-detail");
  if (!panel) return;
  const primary = row.types?.[0] || "normal";
  const c1 = TYPE_COLORS[primary] || "#888";
  panel.style.setProperty("--type-1", c1);
  const rarityLabel = (row.rarity || "common").replace(/^./, (c) => c.toUpperCase());
  const raw = row.raw || {};
  const statRow = (label, val, max = 200) => {
    const pct = Math.min(100, Math.round(((val || 0) / max) * 100));
    return `
      <div class="explore-stat">
        <span class="explore-stat-label">${escapeHtml(label)}</span>
        <span class="explore-stat-val">${val ?? 0}</span>
        <div class="explore-stat-bar"><div class="explore-stat-fill" style="width:${pct}%"></div></div>
      </div>
    `;
  };
  panel.innerHTML = `
    <div class="explore-detail-inner">
      <div class="explore-detail-art">
        <img src="${escapeAttr(row.sprite_front || "")}" alt="${escapeAttr(row.name)}">
        ${row.is_legendary ? `<div class="explore-detail-flag legendary">★ LEGENDARY ★</div>`
         : row.is_mythical ? `<div class="explore-detail-flag mythical">✦ MYTHICAL ✦</div>` : ""}
      </div>
      <div class="explore-detail-id">#${String(row.id).padStart(3, "0")}</div>
      <h2 class="explore-detail-name">${escapeHtml(row.name)}</h2>
      <div class="explore-detail-types">
        ${(row.types || []).map((t) => `<span class="explore-type-pill" style="background:${TYPE_COLORS[t] || "#888"}">${escapeHtml(t)}</span>`).join("")}
      </div>
      <div class="explore-detail-meta">
        <span>Gen ${row.generation ?? "?"}</span>
        <span>Tier ${row.tier ?? "?"} (${escapeHtml(rarityLabel)})</span>
        <span>${row.energyCost ?? "?"} ⚡</span>
      </div>
      <div class="explore-detail-section">
        <h3>Card Stats</h3>
        <div class="explore-cardstats">
          <div><strong>${row.cardHp ?? "?"}</strong> HP</div>
          <div><strong>${row.cardAttack ?? "?"}</strong> ATK</div>
          <div><strong>${row.energyCost ?? "?"}</strong> ⚡ to play</div>
        </div>
      </div>
      <div class="explore-detail-section">
        <h3>Base Stats <span class="explore-bst-total">BST ${row.bst ?? "?"}</span></h3>
        ${statRow("HP", raw.hp)}
        ${statRow("Attack", raw.attack)}
        ${statRow("Defense", raw.defense)}
        ${statRow("Sp. Attack", raw.sp_attack)}
        ${statRow("Sp. Defense", raw.sp_defense)}
        ${statRow("Speed", raw.speed)}
      </div>
      ${Array.isArray(row.abilities) && row.abilities.length ? `
        <div class="explore-detail-section">
          <h3>Abilities</h3>
          <div class="explore-abilities">${row.abilities.map((a) => `<span class="explore-ability-pill">${escapeHtml(a)}</span>`).join("")}</div>
        </div>` : ""}
      ${row.flavor_text ? `
        <div class="explore-detail-section">
          <h3>Pokédex Entry</h3>
          <p class="explore-flavor">${escapeHtml(row.flavor_text)}</p>
        </div>` : ""}
    </div>
  `;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s) { return escapeHtml(s); }
