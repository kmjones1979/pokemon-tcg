// Trainer-avatar picker overlay.
//
// Opens from the account drawer's "Change avatar" button. Shows the
// full roster as a grid of trainer cards styled to match the in-game
// Pokémon cards (same .card class — holographic sheen, type-tinted
// gradient, hover lift). Locked tiers grey out with a lock badge.
//
// Public surface:
//   open({ onClose })       — show the picker
//   close()                 — hide it
//   getSelected()           — cached current selection (or null)
//   getRosterByKey(key)     — lookup helper for renderers (leaderboard,
//                             battle screen, math header) so they can
//                             resolve sprite/name without an extra fetch
//   prefetch()              — kick off the cache fill without rendering
//   renderTrainerCard(t)    — DOM helper: produces a TCG-style card for
//                             one trainer. Exported so the main menu's
//                             active-trainer banner can reuse the same
//                             visual treatment.

import { TYPE_COLORS } from "./type-chart.js";

// Tiny glyph map for the type badge — kept inline so the picker has
// no extra import surface. Mirrors the one in cards.js.
const TYPE_GLYPH = {
  normal: "★", fire: "🔥", water: "💧", electric: "⚡", grass: "🌿",
  ice: "❄", fighting: "✊", poison: "☠", ground: "⛰", flying: "🕊",
  psychic: "🌀", bug: "🐛", rock: "🪨", ghost: "👻", dragon: "🐉",
  dark: "🌒", steel: "⚙", fairy: "✨",
};

let _onClose = null;
let _cache = null;   // { selected, unlocked, level, roster }
let _rosterByKey = new Map();
let _selectListeners = new Set();

export function getSelected() {
  return _cache?.selected || null;
}

export function getCache() {
  return _cache;
}

export function getRosterByKey(key) {
  return _rosterByKey.get(key) || null;
}

// Silent persistence (no UI). Called from the menu trainer grid so
// that picking a trainer to "Battle as" also updates the player's
// persisted avatar. Resolves with the new key, or null on failure.
export async function selectSilently(key) {
  if (!key || _cache?.selected === key) return key;
  try {
    const res = await fetch("/me/avatars/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) return null;
    if (_cache) _cache.selected = key;
    _selectListeners.forEach((fn) => { try { fn(key); } catch {} });
    return key;
  } catch { return null; }
}

export function onSelect(fn) {
  _selectListeners.add(fn);
  return () => _selectListeners.delete(fn);
}

async function loadState() {
  const res = await fetch("/me/avatars");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  _cache = await res.json();
  _rosterByKey = new Map((_cache.roster || []).map((r) => [r.key, r]));
  return _cache;
}

export async function prefetch() {
  if (_cache) return _cache;
  try { return await loadState(); } catch { return null; }
}

export async function open({ onClose } = {}) {
  _onClose = onClose;
  let overlay = document.querySelector(".avatar-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "avatar-overlay";
    document.body.appendChild(overlay);
  }
  overlay.classList.remove("hidden");
  overlay.innerHTML = `<div class="avatar-loading">Loading trainers…</div>`;

  try {
    await loadState();
    render(overlay);
  } catch (err) {
    overlay.innerHTML = `
      <div class="avatar-error">
        Couldn't load avatars: ${escape(err.message || "unknown")}.
        <button class="avatar-close-btn">Close</button>
      </div>`;
    overlay.querySelector(".avatar-close-btn")?.addEventListener("click", close);
  }
}

export function close() {
  const o = document.querySelector(".avatar-overlay");
  if (o) { o.classList.add("hidden"); o.remove(); }
  _onClose?.();
  _onClose = null;
}

// Produce a TCG-style trainer card. Reuses the .card / .card-inner /
// .card-art / .card-footer markup from cards.js so we inherit the
// holographic sheen, hover lift, and type-tinted gradient for free.
//
// opts:
//   selected — show the "✓ Selected" footer pill
//   locked   — render dimmed with a lock overlay (also disables hover)
//   clickable — wrap in a <button> so it's keyboard/click-focusable
export function renderTrainerCard(t, { selected = false, locked = false, clickable = false } = {}) {
  const type = t.portrait || "normal";
  const color = TYPE_COLORS[type] || "#888";
  const tag = clickable ? "button" : "div";
  const html = `
    <${tag} class="card card-trainer type-${escape(type)} ${selected ? "is-selected" : ""} ${locked ? "is-locked" : ""}"
            style="--type-1:${color}; --type-2:${color}"
            data-key="${escape(t.key)}"
            ${clickable && locked ? "disabled" : ""}
            ${clickable ? `title="${escape(t.name)} — ${escape(t.game || "")}"` : ""}>
      <div class="card-inner">
        <div class="card-sheen"></div>
        <header class="card-header">
          <div class="cost-gem trainer-level-gem" title="Unlocks at trainer level ${t.levelRequired}">L${t.levelRequired}</div>
          <div class="card-types">
            <span class="type-badge" style="background:${color}" title="${escape(type)}">${TYPE_GLYPH[type] || "•"}</span>
          </div>
        </header>
        <div class="card-art card-art-trainer">
          <img src="${escape(t.sprite)}" alt="${escape(t.name)}" loading="lazy" draggable="false">
        </div>
        <footer class="card-footer card-footer-trainer">
          <div class="card-name">${escape(t.name)}</div>
          ${t.bio ? `<div class="card-ability-bio">${escape(t.bio)}</div>` : ""}
        </footer>
        ${selected ? `<div class="card-trainer-selected-pill">✓ Selected</div>` : ""}
        ${locked  ? `<div class="card-trainer-lock"><div class="lock-icon">🔒</div><div class="lock-label">L${t.levelRequired}</div></div>` : ""}
      </div>
    </${tag}>
  `;
  return html;
}

function render(overlay) {
  const { selected, level, roster } = _cache;
  // Group roster by levelRequired so tiers render as labeled sections.
  const byTier = new Map();
  for (const a of roster) {
    if (!byTier.has(a.levelRequired)) byTier.set(a.levelRequired, []);
    byTier.get(a.levelRequired).push(a);
  }
  const tiers = [...byTier.keys()].sort((a, b) => a - b);

  overlay.innerHTML = `
    <div class="avatar-card">
      <header class="avatar-header">
        <div class="avatar-title">Choose your trainer</div>
        <button class="avatar-x" aria-label="Close">✕</button>
      </header>
      <div class="avatar-sub">You're trainer level <strong>${level}</strong>. New trainers unlock every 10 levels.</div>
      <div class="avatar-grid">
        ${tiers.map((tier) => {
          const all = byTier.get(tier);
          const anyUnlocked = all.some((a) => a.unlocked);
          return `
            <div class="avatar-tier ${anyUnlocked ? "" : "is-locked-tier"}">
              <div class="avatar-tier-label">Level ${tier}${tier === 1 ? " · Starter" : ""}</div>
              <div class="avatar-tier-row trainer-card-row">
                ${all.map((a) => renderTrainerCard(a, {
                  selected: selected === a.key,
                  locked: !a.unlocked,
                  clickable: true,
                })).join("")}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;

  overlay.querySelector(".avatar-x")?.addEventListener("click", close);
  overlay.querySelectorAll(".card-trainer:not(.is-locked)").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.getAttribute("data-key");
      if (key === _cache.selected) return;
      // Optimistic UI — flip selected immediately, roll back on error.
      const prev = _cache.selected;
      _cache.selected = key;
      overlay.querySelectorAll(".card-trainer").forEach((c) => {
        const isSel = c.getAttribute("data-key") === key;
        c.classList.toggle("is-selected", isSel);
        // Add or remove the "✓ Selected" pill to match new state.
        const inner = c.querySelector(".card-inner");
        const existingPill = inner?.querySelector(".card-trainer-selected-pill");
        if (isSel && !existingPill && !c.classList.contains("is-locked")) {
          const pill = document.createElement("div");
          pill.className = "card-trainer-selected-pill";
          pill.textContent = "✓ Selected";
          inner?.appendChild(pill);
        } else if (!isSel && existingPill) {
          existingPill.remove();
        }
      });
      try {
        const res = await fetch("/me/avatars/select", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        _selectListeners.forEach((fn) => { try { fn(key); } catch {} });
      } catch (err) {
        _cache.selected = prev;
        // Restore visual state on failure.
        render(overlay);
        alert(err.message || "Couldn't save.");
      }
    });
  });
}

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
