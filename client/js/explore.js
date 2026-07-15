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
  closeSwipeMode();
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
        <button class="explore-swipe-launch" title="Swipe through cards full-screen">🎴 Swipe Mode</button>
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
  _overlay.querySelector(".explore-swipe-launch")?.addEventListener("click", () => {
    const rows = filterPokedexEntries(_allRows, _query);
    if (!rows.length) return;
    const startIdx = Math.max(0, rows.findIndex((r) => r.id === _selectedId));
    openSwipeMode(rows, startIdx);
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
    const isMega = !!row.is_mega;
    if (isMega) cell.classList.add("mega");
    else if (row.is_legendary) cell.classList.add("legendary");
    else if (row.is_mythical) cell.classList.add("mythical");
    const primary = row.types?.[0] || "normal";
    cell.style.setProperty("--type-1", TYPE_COLORS[primary] || "#888");
    // Megas play their looping video (only a handful exist); everything else
    // uses the static sprite.
    const media = isMega && row.videoUrl
      ? `<video class="explore-cell-vid" autoplay loop muted playsinline poster="${escapeAttr(row.sprite_front || "")}"><source src="${escapeAttr(row.videoUrl)}" type="video/mp4"></video>`
      : `<img class="explore-cell-sprite" src="${escapeAttr(row.sprite_front || "")}" alt="${escapeAttr(row.name)}" loading="lazy">`;
    cell.innerHTML = `
      <div class="explore-cell-id">${isMega ? "⚡ MEGA" : `#${String(row.id).padStart(3, "0")}`}</div>
      ${media}
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
      <div class="explore-detail-art${row.is_mega ? " mega" : ""}">
        ${row.is_mega && row.videoUrl
          ? `<video autoplay loop muted playsinline poster="${escapeAttr(row.sprite_front || "")}"><source src="${escapeAttr(row.videoUrl)}" type="video/mp4"></video>`
          : `<img src="${escapeAttr(row.sprite_front || "")}" alt="${escapeAttr(row.name)}">`}
        ${row.is_mega ? `<div class="explore-detail-flag mega">✦ MEGA ✦</div>`
         : row.is_legendary ? `<div class="explore-detail-flag legendary">★ LEGENDARY ★</div>`
         : row.is_mythical ? `<div class="explore-detail-flag mythical">✦ MYTHICAL ✦</div>` : ""}
      </div>
      <div class="explore-detail-id">${row.is_mega ? "⚡ MEGA EVOLUTION" : `#${String(row.id).padStart(3, "0")}`}</div>
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

// ---- Swipe Mode -----------------------------------------------------------
// Tactile full-screen card browser. One card at a time, idle float animation,
// drag-and-snap touch gestures, keyboard arrows on desktop. Built for iPhone
// but works anywhere. The card visibly responds to drag (translateX +
// slight rotation), then either springs back or animates off-screen
// depending on how far the user pulled it.

let _swipeRoot = null;
let _swipeKeyHandler = null;

function openSwipeMode(rows, startIdx = 0) {
  if (!rows?.length) return;
  closeSwipeMode();
  const state = { rows, idx: Math.max(0, Math.min(startIdx, rows.length - 1)) };

  _swipeRoot = document.createElement("div");
  _swipeRoot.className = "swipe-overlay";
  _swipeRoot.innerHTML = `
    <button class="swipe-close" aria-label="Close Swipe Mode">✕</button>
    <div class="swipe-counter" id="swipe-counter"></div>
    <button class="swipe-share" id="swipe-share" aria-label="Share this Pokémon">↗ Share</button>
    <div class="swipe-stage" id="swipe-stage"></div>
    <div class="swipe-hint">
      <span class="swipe-arrow">←</span>
      <span class="swipe-hint-text">Swipe to flip through</span>
      <span class="swipe-arrow">→</span>
    </div>
  `;
  document.body.appendChild(_swipeRoot);

  const stage = _swipeRoot.querySelector("#swipe-stage");
  const counter = _swipeRoot.querySelector("#swipe-counter");

  let dragStartX = 0, dragStartY = 0, dragging = false, currentDx = 0;
  let card = null;

  function paint(dir = "in") {
    counter.textContent = `${state.idx + 1} / ${state.rows.length}`;
    const row = state.rows[state.idx];
    const old = card;
    card = buildSwipeCard(row);
    if (dir === "left")       card.classList.add("from-right");
    else if (dir === "right") card.classList.add("from-left");
    else                       card.classList.add("from-center");
    stage.appendChild(card);
    requestAnimationFrame(() => card.classList.add("landed"));
    // Wire drag on the new card.
    wireDrag(card);
    // Remove the old card after the entry animation lands so it doesn't
    // pile up DOM nodes between swipes.
    if (old) {
      old.classList.add("exiting");
      setTimeout(() => old.remove(), 350);
    }
  }

  function next() {
    if (state.idx >= state.rows.length - 1) { bounce(card, "right"); return; }
    state.idx += 1;
    paint("left");
  }
  function prev() {
    if (state.idx <= 0) { bounce(card, "left"); return; }
    state.idx -= 1;
    paint("right");
  }

  function bounce(node, side) {
    if (!node) return;
    node.classList.add(side === "left" ? "bounce-left" : "bounce-right");
    setTimeout(() => node.classList.remove("bounce-left", "bounce-right"), 280);
  }

  function wireDrag(node) {
    const onStart = (x, y) => {
      dragStartX = x; dragStartY = y; dragging = true; currentDx = 0;
      node.classList.add("dragging");
    };
    const onMove = (x, y) => {
      if (!dragging) return;
      const dx = x - dragStartX;
      const dy = y - dragStartY;
      // If the gesture is dominantly vertical (scrolling), bail.
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 14) {
        dragging = false;
        node.style.transform = "";
        node.classList.remove("dragging");
        return;
      }
      currentDx = dx;
      const rot = Math.max(-15, Math.min(15, dx * 0.06));
      node.style.transform = `translateX(${dx}px) rotate(${rot}deg)`;
    };
    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      node.classList.remove("dragging");
      const threshold = 80;
      if (currentDx < -threshold) {
        // Pulled left: advance.
        node.style.transform = "translateX(-130%) rotate(-18deg)";
        node.style.opacity = "0";
        next();
      } else if (currentDx > threshold) {
        node.style.transform = "translateX(130%) rotate(18deg)";
        node.style.opacity = "0";
        prev();
      } else {
        // Spring back.
        node.style.transform = "";
      }
      currentDx = 0;
    };
    node.addEventListener("touchstart", (e) => onStart(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    node.addEventListener("touchmove",  (e) => onMove(e.touches[0].clientX, e.touches[0].clientY),  { passive: true });
    node.addEventListener("touchend",   onEnd);
    node.addEventListener("touchcancel", onEnd);
    // Mouse-drag for desktop, too — same gesture model.
    node.addEventListener("mousedown",  (e) => onStart(e.clientX, e.clientY));
    window.addEventListener("mousemove", (e) => { if (dragging) onMove(e.clientX, e.clientY); });
    window.addEventListener("mouseup",   onEnd);
  }

  // Keyboard nav on desktop. Esc closes.
  _swipeKeyHandler = (e) => {
    if (e.key === "ArrowLeft" || e.key === "PageUp")        { e.preventDefault(); prev(); }
    else if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); next(); }
    else if (e.key === "Escape")                              { closeSwipeMode(); }
  };
  window.addEventListener("keydown", _swipeKeyHandler);

  _swipeRoot.querySelector(".swipe-close").addEventListener("click", closeSwipeMode);
  _swipeRoot.querySelector("#swipe-share").addEventListener("click", () => {
    const row = state.rows[state.idx];
    if (row) shareCard(row);
  });

  paint("in");
}

// Open the native share sheet if available (iOS / Android Web Share API),
// otherwise pop up a small fallback popover with Copy Link + X intent.
async function shareCard(row) {
  const name = (row.name || "Pokémon").replace(/\b\w/g, (c) => c.toUpperCase());
  const id3 = String(row.id).padStart(3, "0");
  const url = `${location.origin}/p/${row.id}`;
  const text = `Check out ${name} #${id3} on Pokémon Battle!`;
  const title = `${name} #${id3} — Pokémon Battle`;
  // Web Share API is the one good thing — iOS/Android show the native
  // sheet with Messages, Mail, AirDrop, X, WhatsApp, etc. Falls back to
  // our own popover when unsupported (most desktop browsers).
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch (err) {
      if (err.name === "AbortError") return; // User canceled the sheet — that's fine.
      // Otherwise fall through to popover.
    }
  }
  showShareFallback({ url, text, title, name });
}

function showShareFallback({ url, text, title, name }) {
  document.querySelector(".share-sheet")?.remove();
  const sheet = document.createElement("div");
  sheet.className = "share-sheet";
  const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  sheet.innerHTML = `
    <div class="share-sheet-card">
      <div class="share-sheet-title">Share ${escapeHtml(name)}</div>
      <div class="share-sheet-url">${escapeHtml(url)}</div>
      <button class="share-sheet-opt share-copy">📋 Copy Link</button>
      <a class="share-sheet-opt share-x" href="${escapeAttr(tweetUrl)}" target="_blank" rel="noopener">𝕏 Share on X</a>
      <button class="share-sheet-opt share-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
  sheet.querySelector(".share-cancel").addEventListener("click", close);
  sheet.querySelector(".share-copy").addEventListener("click", async () => {
    const btn = sheet.querySelector(".share-copy");
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = "✓ Link Copied!";
      setTimeout(close, 900);
    } catch {
      btn.textContent = "Copy failed — long-press the link above";
    }
  });
}

function closeSwipeMode() {
  if (_swipeKeyHandler) {
    window.removeEventListener("keydown", _swipeKeyHandler);
    _swipeKeyHandler = null;
  }
  if (_swipeRoot) {
    _swipeRoot.classList.add("closing");
    const r = _swipeRoot;
    _swipeRoot = null;
    setTimeout(() => r.remove(), 220);
  }
}

function buildSwipeCard(row) {
  const card = document.createElement("article");
  const primary = row.types?.[0] || "normal";
  const c1 = TYPE_COLORS[primary] || "#888";
  card.className = "swipe-card";
  if (row.is_mega) card.classList.add("mega");
  else if (row.is_legendary) card.classList.add("legendary");
  else if (row.is_mythical) card.classList.add("mythical");
  card.style.setProperty("--type-1", c1);
  const rarityLabel = (row.rarity || "common").replace(/^./, (c) => c.toUpperCase());
  const raw = row.raw || {};
  const statBar = (label, val) => {
    const pct = Math.min(100, Math.round(((val || 0) / 200) * 100));
    return `
      <div class="swipe-stat">
        <span class="swipe-stat-label">${escapeHtml(label)}</span>
        <span class="swipe-stat-val">${val ?? 0}</span>
        <div class="swipe-stat-bar"><div class="swipe-stat-fill" style="width:${pct}%"></div></div>
      </div>`;
  };
  card.innerHTML = `
    <div class="swipe-card-inner">
      ${row.is_mega ? `<div class="swipe-card-flag mega">✦ MEGA ✦</div>`
        : row.is_legendary ? `<div class="swipe-card-flag legendary">★ LEGENDARY ★</div>`
        : row.is_mythical ? `<div class="swipe-card-flag mythical">✦ MYTHICAL ✦</div>` : ""}
      <div class="swipe-card-art${row.is_mega ? " mega" : ""}">
        ${row.is_mega && row.videoUrl
          ? `<video autoplay loop muted playsinline poster="${escapeAttr(row.sprite_front || "")}"><source src="${escapeAttr(row.videoUrl)}" type="video/mp4"></video>`
          : `<img src="${escapeAttr(row.sprite_front || "")}" alt="${escapeAttr(row.name)}" draggable="false">`}
      </div>
      <div class="swipe-card-id">${row.is_mega ? "⚡ MEGA EVOLUTION" : `#${String(row.id).padStart(3, "0")}`}</div>
      <h2 class="swipe-card-name">${escapeHtml(row.name)}</h2>
      <div class="swipe-card-types">
        ${(row.types || []).map((t) => `<span class="swipe-type-pill" style="background:${TYPE_COLORS[t] || "#888"}">${escapeHtml(t)}</span>`).join("")}
      </div>
      <div class="swipe-card-meta">
        <span>Gen ${row.generation ?? "?"}</span>
        <span>Tier ${row.tier ?? "?"} (${escapeHtml(rarityLabel)})</span>
      </div>
      <div class="swipe-card-quickstats">
        <div><strong>${row.cardHp ?? "?"}</strong><span>HP</span></div>
        <div><strong>${row.cardAttack ?? "?"}</strong><span>ATK</span></div>
        <div><strong>${row.energyCost ?? "?"}</strong><span>⚡</span></div>
      </div>
      <div class="swipe-card-stats">
        ${statBar("HP", raw.hp)}
        ${statBar("ATK", raw.attack)}
        ${statBar("DEF", raw.defense)}
        ${statBar("SpA", raw.sp_attack)}
        ${statBar("SpD", raw.sp_defense)}
        ${statBar("SPD", raw.speed)}
      </div>
      ${row.flavor_text ? `<p class="swipe-card-flavor">${escapeHtml(row.flavor_text)}</p>` : ""}
    </div>
  `;
  return card;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s) { return escapeHtml(s); }
