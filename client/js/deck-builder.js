// Collection viewer + deck builder.
//
// Renders an overlay panel listing every card the user owns. From there they
// can drag-or-tap cards into a 30-slot deck list and save it. The active deck
// is the one used in single-player when "Battle" is pressed and in
// multiplayer matchmaking.

import { renderCard } from "./cards.js";
import { encodeDeckIds } from "./deck-codes-client.js";
import { filterDecks } from "./search-utils.js";

const DECK_SIZE = 30;
const MAX_COPIES = 2;

let _onClose = null;          // close callback
let _collection = [];          // [{id, name, types, ..., quantity}]
let _decks = [];               // [{id, name, card_ids[], is_active}]
let _activeDeckId = null;      // id of the user's currently-active deck (used in matches)
let _editingDeckId = null;     // id of the deck the user is currently editing (or null = new)
let _editingDeckName = "Main Deck";
let _editorIds = [];           // current draft as a flat list of pokemon ids
let _filter = { type: "all", tier: "all", search: "" };

export async function open({ onClose }) {
  _onClose = onClose;
  const overlay = ensureOverlay();
  overlay.classList.remove("hidden");
  await refresh();
}

// Convenience used by the ?d=<code> URL handler: open the builder and
// preload the shared deck.
export async function openWithCode(code) {
  const overlay = ensureOverlay();
  overlay.classList.remove("hidden");
  await refresh();
  await loadFromCode(code);
}

export function close() {
  document.querySelector(".collection-overlay")?.classList.add("hidden");
  _onClose?.();
}

// Copy a /d/<code> URL for the currently-edited 30-card deck to the
// clipboard. Opened from the deck-builder's "🔗 Share" button.
async function shareDeckCode() {
  if (_editorIds.length !== 30) return;
  try {
    const code = encodeDeckIds(_editorIds);
    const url = `${location.origin}/d/${code}`;
    // Best-effort: claim ownership of this code so result-loop results
    // come back to us. Signed-in only; failure is silent.
    fetch("/me/shared-decks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, cardIds: _editorIds }),
    }).catch(() => {});
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = url; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch {}
      ta.remove();
    }
    // Brief visual confirmation on the button.
    const btn = document.querySelector(".cb-share");
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = "✓ Copied!";
      setTimeout(() => { btn.textContent = orig; }, 1600);
    }
    // Best-effort native share too.
    if (navigator.share) {
      navigator.share({ title: "My Pokémon TCG deck", url }).catch(() => {});
    }
  } catch (err) {
    alert("Couldn't build a deck code: " + (err.message || "unknown"));
  }
}

// Load a deck-code's cards into the editor draft. Called from main.js
// when the URL is ?d=<code>. Resolves once the editor reflects the
// loaded ids (it stays in "unsaved draft" state — the user can press
// Save to persist).
export async function loadFromCode(code) {
  try {
    const r = await fetch(`/api/deck-code/${encodeURIComponent(code)}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    const { ids } = await r.json();
    _editorIds = ids.slice();
    _editingDeckId = null;
    _editingDeckName = `Shared deck (${code.slice(0, 6)}…)`;
    render();
  } catch (err) {
    alert("Couldn't load shared deck: " + (err.message || "unknown"));
  }
}

function ensureOverlay() {
  let el = document.querySelector(".collection-overlay");
  if (el) return el;
  el = document.createElement("div");
  el.className = "collection-overlay hidden";
  document.body.appendChild(el);
  return el;
}

async function refresh() {
  const overlay = ensureOverlay();
  overlay.innerHTML = `<div class="cb-loading">Loading your collection…</div>`;
  try {
    const [colRes, deckRes] = await Promise.all([
      fetch("/me/collection"),
      fetch("/me/decks"),
    ]);
    if (!colRes.ok || !deckRes.ok) throw new Error("not signed in");
    const colData = await colRes.json();
    const deckData = await deckRes.json();
    _collection = colData.cards;
    _decks = deckData.decks;
    const active = _decks.find((d) => d.is_active);
    if (active) {
      _activeDeckId = active.id;
      // If the editor is empty (first open), default to editing the active deck.
      if (!_editingDeckId) {
        loadDeckIntoEditor(active);
      }
    } else {
      _activeDeckId = null;
    }
    render();
  } catch (err) {
    overlay.innerHTML = `
      <div class="cb-error">
        Couldn't load your collection: ${err.message || "unknown error"}.
        <button class="cb-close">Close</button>
      </div>`;
    overlay.querySelector(".cb-close")?.addEventListener("click", close);
  }
}

function render() {
  const overlay = ensureOverlay();
  // Preserve scroll position of the collection grid AND the deck list so a
  // single click doesn't fling the user back to the top after every pick.
  const prevGridScroll = overlay.querySelector(".cb-collection")?.scrollTop ?? 0;
  const prevDeckScroll = overlay.querySelector(".cb-deck-list")?.scrollTop ?? 0;
  const prevOuterScroll = overlay.querySelector(".cb-body")?.scrollTop ?? 0;
  const prevActiveSelector = (() => {
    const a = document.activeElement;
    if (!a || !overlay.contains(a)) return null;
    if (a.classList.contains("cb-search")) return ".cb-search";
    if (a.classList.contains("cb-deck-name")) return ".cb-deck-name";
    return null;
  })();
  const ownedById = new Map(_collection.map((c) => [c.id, c]));
  const usedById = new Map();
  for (const id of _editorIds) usedById.set(id, (usedById.get(id) || 0) + 1);

  // Filter the visible collection
  const filtered = _collection.filter((c) => {
    if (_filter.type !== "all" && !(c.types || []).includes(_filter.type)) return false;
    if (_filter.tier !== "all" && c.tier !== Number(_filter.tier)) return false;
    if (_filter.search) {
      const q = _filter.search.toLowerCase();
      if (!c.name.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const deckSummary = summarize(_editorIds, ownedById);

  overlay.innerHTML = `
    <div class="cb-panel">
      <header class="cb-header">
        <div class="cb-title">Your Collection</div>
        <div class="cb-controls">
          <input type="text" class="cb-search" placeholder="Search by name…" value="${escape(_filter.search)}">
          <select class="cb-filter-type">
            ${renderTypeOptions(_filter.type)}
          </select>
          <select class="cb-filter-tier">
            ${[["all","All tiers"],[1,"Tier 1"],[2,"Tier 2"],[3,"Tier 3"],[4,"Tier 4"],[5,"Tier 5"]]
              .map(([v,l]) => `<option value="${v}" ${String(_filter.tier)===String(v)?"selected":""}>${l}</option>`).join("")}
          </select>
        </div>
        <button class="cb-x">✕</button>
      </header>

      <div class="cb-body">
        <section class="cb-collection">
          <div class="cb-section-title">${filtered.length} card${filtered.length===1?"":"s"} shown · ${_collection.length} owned</div>
          <div class="cb-grid"></div>
        </section>

        <aside class="cb-deck">
          ${_decks.length > 3 ? `
            <input type="search" class="cb-deck-search" placeholder="Search decks by name or Pokémon…" autocomplete="off">
          ` : ""}
          <div class="cb-deck-switcher">
            <select class="cb-deck-select">
              <option value="__new__" ${!_editingDeckId ? "selected" : ""}>+ New deck</option>
              ${_decks.map((d) => `
                <option value="${d.id}" ${d.id === _editingDeckId ? "selected" : ""}>
                  ${escape(d.name)}${d.is_active ? " ★" : ""}
                </option>
              `).join("")}
            </select>
            <input type="text" class="cb-deck-name" value="${escape(_editingDeckName)}" maxlength="40">
            ${_editingDeckId
              ? `<button class="cb-deck-delete" title="Delete this deck">🗑</button>`
              : ""}
          </div>
          <div class="cb-section-title">
            Deck (<span class="cb-deck-count">${_editorIds.length}</span>/${DECK_SIZE})
            <div class="cb-deck-bymtier">
              ${[1,2,3,4,5].map((t) => `<span class="tier-pip tier-${t}">${deckSummary.byTier[t] || 0}</span>`).join("")}
            </div>
          </div>
          <div class="cb-deck-list"></div>
          <div class="cb-deck-actions">
            <button class="cb-auto">Auto-fill</button>
            <button class="cb-preset" title="Suggested deck archetypes">Recipes ▾</button>
            <button class="cb-share" ${_editorIds.length === DECK_SIZE ? "" : "disabled"} title="${_editorIds.length === DECK_SIZE ? "Copy a shareable deck-code link" : "Build a full 30-card deck first"}">🔗 Share</button>
            <button class="cb-clear">Clear</button>
            <button class="cb-save primary" ${_editorIds.length === DECK_SIZE ? "" : "disabled"}>
              ${_editingDeckId ? "Save" : "Save deck"}
            </button>
            ${_editingDeckId && _editingDeckId !== _activeDeckId
              ? `<button class="cb-activate">Use this</button>`
              : ""}
          </div>
          <div class="cb-deck-hint">${deckHint(deckSummary, _editorIds.length)}</div>
        </aside>
      </div>
    </div>
  `;

  // Populate the grids using the existing renderCard for visual consistency.
  const grid = overlay.querySelector(".cb-grid");
  for (const c of filtered) {
    const wrapper = document.createElement("div");
    wrapper.className = "cb-card-wrapper";
    const used = usedById.get(c.id) || 0;
    const remaining = c.quantity - used;
    if (remaining <= 0) wrapper.classList.add("exhausted");
    if (c.shinyLevel > 0) wrapper.classList.add("is-shiny");
    const card = renderCard(c, { compact: true });
    card.classList.add("cb-collection-card");
    if (c.shinyLevel > 0) card.classList.add(`shiny-${c.shinyLevel}`);
    wrapper.appendChild(card);
    const tag = document.createElement("div");
    tag.className = "cb-qty";
    tag.textContent = `${remaining}/${c.quantity}`;
    wrapper.appendChild(tag);
    // Upgrade button: when the user owns ≥3 copies and isn't maxed.
    if (c.quantity >= 3 && (c.shinyLevel || 0) < 3) {
      const up = document.createElement("button");
      up.className = "cb-upgrade";
      up.title = `Fuse 3 copies to upgrade to shiny L${(c.shinyLevel || 0) + 1} (+1 HP, +1 ATK)`;
      up.innerHTML = `★ Fuse → L${(c.shinyLevel || 0) + 1}`;
      up.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Fuse 3 copies of ${c.name} into a shiny L${(c.shinyLevel || 0) + 1}?`)) return;
        try {
          const res = await fetch(`/me/cards/${c.id}/upgrade`, { method: "POST" });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "upgrade failed");
          await refresh();
        } catch (err) {
          alert(err.message || "Upgrade failed");
        }
      });
      wrapper.appendChild(up);
    }
    wrapper.addEventListener("click", () => {
      if (_editorIds.length >= DECK_SIZE) return;
      const used = usedById.get(c.id) || 0;
      const cap = Math.min(c.quantity, MAX_COPIES);
      if (used >= cap) return;
      _editorIds.push(c.id);
      render();
    });
    grid.appendChild(wrapper);
  }

  // The deck list: count grouping, click to remove one.
  const deckList = overlay.querySelector(".cb-deck-list");
  const grouped = [..._editorIds.reduce((m, id) => m.set(id, (m.get(id) || 0) + 1), new Map())];
  grouped.sort((a, b) => {
    const ca = ownedById.get(a[0]) || {};
    const cb = ownedById.get(b[0]) || {};
    return (ca.tier || 0) - (cb.tier || 0) || (ca.name || "").localeCompare(cb.name || "");
  });
  if (grouped.length === 0) {
    deckList.innerHTML = `<div class="cb-deck-empty">Tap cards on the left to add them.</div>`;
  } else {
    for (const [id, qty] of grouped) {
      const c = ownedById.get(id);
      if (!c) continue;
      const row = document.createElement("div");
      row.className = `cb-deck-row type-${c.types?.[0] || "normal"}`;
      row.innerHTML = `
        <span class="cb-deck-name">${escape(c.name)}</span>
        <span class="cb-deck-meta">T${c.tier} · ⚡${c.energyCost}</span>
        <span class="cb-deck-count-pill">×${qty}</span>
      `;
      row.addEventListener("click", () => {
        const i = _editorIds.indexOf(id);
        if (i >= 0) _editorIds.splice(i, 1);
        render();
      });
      deckList.appendChild(row);
    }
  }

  // Wire controls
  overlay.querySelector(".cb-x").addEventListener("click", close);
  overlay.querySelector(".cb-search").addEventListener("input", (e) => {
    _filter.search = e.target.value;
    render();
  });
  overlay.querySelector(".cb-filter-type").addEventListener("change", (e) => {
    _filter.type = e.target.value;
    render();
  });
  overlay.querySelector(".cb-filter-tier").addEventListener("change", (e) => {
    _filter.tier = e.target.value;
    render();
  });
  overlay.querySelector(".cb-auto").addEventListener("click", autoFill);
  overlay.querySelector(".cb-preset")?.addEventListener("click", openPresetMenu);
  overlay.querySelector(".cb-share")?.addEventListener("click", shareDeckCode);
  overlay.querySelector(".cb-clear").addEventListener("click", () => { _editorIds = []; render(); });
  overlay.querySelector(".cb-save").addEventListener("click", saveDeck);
  overlay.querySelector(".cb-deck-select")?.addEventListener("change", onSwitchDeck);
  overlay.querySelector(".cb-deck-name")?.addEventListener("input", (e) => {
    _editingDeckName = e.target.value.slice(0, 40);
  });
  overlay.querySelector(".cb-deck-delete")?.addEventListener("click", deleteCurrentDeck);
  // Deck search — filters the deck-select dropdown by deck name OR
  // contained Pokémon name/type. Live filter via hidden options so
  // there's no full re-render mid-typing.
  const searchEl = overlay.querySelector(".cb-deck-search");
  if (searchEl) {
    const dexById = new Map((_collection || []).map((c) => [c.id, c]));
    searchEl.addEventListener("input", (e) => {
      const q = e.target.value;
      const matching = new Set(filterDecks(_decks, dexById, q).map((d) => d.id));
      const sel = overlay.querySelector(".cb-deck-select");
      if (!sel) return;
      for (const opt of sel.options) {
        if (opt.value === "__new__") { opt.hidden = false; continue; }
        opt.hidden = !matching.has(opt.value);
      }
    });
  }
  overlay.querySelector(".cb-activate")?.addEventListener("click", setCurrentAsActive);

  // Restore scroll + focus so a click on a card doesn't fling the user back
  // to the top of the grid on every selection.
  const cbCollection = overlay.querySelector(".cb-collection");
  const cbDeckList   = overlay.querySelector(".cb-deck-list");
  const cbBody       = overlay.querySelector(".cb-body");
  if (cbCollection) cbCollection.scrollTop = prevGridScroll;
  if (cbDeckList)   cbDeckList.scrollTop   = prevDeckScroll;
  if (cbBody)       cbBody.scrollTop       = prevOuterScroll;
  if (prevActiveSelector) {
    const el = overlay.querySelector(prevActiveSelector);
    if (el) { el.focus(); /* preserve caret position too */
      try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
    }
  }
}

function loadDeckIntoEditor(deck) {
  _editingDeckId = deck.id;
  _editingDeckName = deck.name;
  _editorIds = deck.card_ids.slice();
}

function onSwitchDeck(e) {
  const v = e.target.value;
  if (v === "__new__") {
    _editingDeckId = null;
    _editingDeckName = `Deck ${_decks.length + 1}`;
    _editorIds = [];
  } else {
    const d = _decks.find((x) => x.id === v);
    if (d) loadDeckIntoEditor(d);
  }
  render();
}

async function deleteCurrentDeck() {
  if (!_editingDeckId) return;
  if (!confirm(`Delete "${_editingDeckName}"?`)) return;
  try {
    const r = await fetch(`/me/decks/${_editingDeckId}`, { method: "DELETE" });
    if (!r.ok) throw new Error("delete failed");
    _editingDeckId = null;
    _editingDeckName = "Main Deck";
    _editorIds = [];
    await refresh();
  } catch (err) {
    alert("Could not delete: " + (err.message || "unknown"));
  }
}

async function setCurrentAsActive() {
  if (!_editingDeckId) return;
  try {
    const r = await fetch(`/me/decks/${_editingDeckId}/active`, { method: "POST" });
    if (!r.ok) throw new Error("activate failed");
    _activeDeckId = _editingDeckId;
    await refresh();
  } catch (err) {
    alert("Could not activate: " + (err.message || "unknown"));
  }
}

function renderTypeOptions(current) {
  const types = ["all","normal","fire","water","electric","grass","ice","fighting","poison","ground","flying","psychic","bug","rock","ghost","dragon","dark","steel","fairy"];
  return types.map((t) =>
    `<option value="${t}" ${t===current?"selected":""}>${t === "all" ? "All types" : t}</option>`
  ).join("");
}

function summarize(ids, ownedById) {
  const byTier = {};
  for (const id of ids) {
    const c = ownedById.get(id);
    if (!c) continue;
    byTier[c.tier] = (byTier[c.tier] || 0) + 1;
  }
  return { byTier };
}

function deckHint(summary, total) {
  if (total < DECK_SIZE) return `Add ${DECK_SIZE - total} more card${DECK_SIZE - total === 1 ? "" : "s"}.`;
  return "Ready to save.";
}

// --- Preset deck "recipes" -----------------------------------------------
// Each recipe is a filter+priority function — the builder picks owned cards
// matching the filter, preferring those scored highest, until the deck is
// full. Falls back to autoFill afterward if the recipe can't supply 30.
const PRESETS = [
  {
    id: "mono-fire", label: "🔥 Mono Fire", hint: "Aggressive fire-only deck.",
    pref: (c) => (c.types || []).includes("fire") ? 100 : 0,
  },
  {
    id: "mono-water", label: "💧 Mono Water", hint: "Disrupt with water + heals.",
    pref: (c) => (c.types || []).includes("water") ? 100 : 0,
  },
  {
    id: "mono-grass", label: "🌿 Mono Grass", hint: "Sustain — heal over time.",
    pref: (c) => (c.types || []).includes("grass") ? 100 : 0,
  },
  {
    id: "mono-psychic", label: "🌀 Mono Psychic", hint: "Status effects + bursts.",
    pref: (c) => (c.types || []).includes("psychic") ? 100 : 0,
  },
  {
    id: "balanced", label: "⚖ Balanced", hint: "Mix of types — adapts to any matchup.",
    pref: (c) => 10 + Math.random() * 5,
  },
  {
    id: "tank", label: "🛡 Defender", hint: "Steel / rock walls, plus tank Pokémon.",
    pref: (c) => {
      const t = c.types || [];
      let s = 0;
      if (t.includes("steel") || t.includes("rock") || t.includes("ground")) s += 50;
      if (t.includes("fighting")) s += 20;
      // Bias toward higher HP cards.
      s += (c.cardHp || 0) * 2;
      return s;
    },
  },
  {
    id: "aggro", label: "⚡ Aggro", hint: "Cheap attackers — flood the field fast.",
    pref: (c) => {
      let s = 0;
      if (c.tier <= 2) s += 60;
      s += (c.cardAttack || 0) * 5;
      return s;
    },
  },
  {
    id: "legendary", label: "✨ Legendary", hint: "Heavy on legendaries + mythicals.",
    pref: (c) => {
      let s = 5;
      if (c.is_legendary) s += 200;
      if (c.is_mythical) s += 220;
      if (c.tier >= 4) s += 30;
      return s;
    },
  },
];

function openPresetMenu(e) {
  document.querySelector(".cb-preset-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "cb-preset-menu";
  menu.innerHTML = `
    <div class="cb-preset-title">Pick a deck recipe</div>
    ${PRESETS.map((p) => `
      <button class="cb-preset-row" data-preset="${p.id}">
        <div class="cb-preset-label">${p.label}</div>
        <div class="cb-preset-hint">${escape(p.hint)}</div>
      </button>
    `).join("")}
    <button class="cb-preset-cancel">Cancel</button>
  `;
  document.body.appendChild(menu);
  menu.querySelectorAll(".cb-preset-row").forEach((row) => {
    row.addEventListener("click", () => {
      applyPreset(row.dataset.preset);
      menu.remove();
    });
  });
  menu.querySelector(".cb-preset-cancel").addEventListener("click", () => menu.remove());
}

function applyPreset(presetId) {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) return;
  // Start from scratch — applying a preset replaces the current draft.
  _editorIds = [];
  const used = new Map();
  // Score every owned card; sort desc.
  const scored = _collection
    .map((c) => ({ c, score: preset.pref(c) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  // Take up to 2 of each, prefer high-score, target 30 cards.
  for (const { c } of scored) {
    if (_editorIds.length >= DECK_SIZE) break;
    const inDeck = used.get(c.id) || 0;
    const cap = Math.min(c.quantity, MAX_COPIES);
    if (inDeck >= cap) continue;
    _editorIds.push(c.id);
    used.set(c.id, inDeck + 1);
  }
  // If the preset couldn't fill 30 (small collection / narrow filter),
  // top up with autoFill.
  if (_editorIds.length < DECK_SIZE) {
    autoFill();
  }
  render();
}

function autoFill() {
  // Use the existing collection, fill toward a 10/10/6/3/1 distribution
  // with cards the user owns. Respects ≤2 of each.
  const ownedById = new Map(_collection.map((c) => [c.id, c]));
  const used = new Map();
  for (const id of _editorIds) used.set(id, (used.get(id) || 0) + 1);

  const dist = { 1: 10, 2: 10, 3: 6, 4: 3, 5: 1 };
  const byTier = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (const c of _collection) byTier[c.tier]?.push(c);
  // Shuffle each tier for variety
  for (const bucket of Object.values(byTier)) {
    for (let i = bucket.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bucket[i], bucket[j]] = [bucket[j], bucket[i]];
    }
  }
  function tryAdd(tier) {
    for (const c of byTier[tier] || []) {
      const inDeck = used.get(c.id) || 0;
      const cap = Math.min(c.quantity, MAX_COPIES);
      if (inDeck < cap) {
        _editorIds.push(c.id);
        used.set(c.id, inDeck + 1);
        return true;
      }
    }
    return false;
  }
  while (_editorIds.length < DECK_SIZE) {
    // Pick the tier we're most behind on
    const currentByTier = {};
    for (const id of _editorIds) {
      const c = ownedById.get(id);
      if (c) currentByTier[c.tier] = (currentByTier[c.tier] || 0) + 1;
    }
    let pickTier = 1, worstDelta = -Infinity;
    for (const t of [1, 2, 3, 4, 5]) {
      const want = dist[t] || 0;
      const have = currentByTier[t] || 0;
      const delta = want - have;
      if (delta > worstDelta) { worstDelta = delta; pickTier = t; }
    }
    let ok = tryAdd(pickTier);
    if (!ok) {
      // Try any other tier
      ok = [1, 2, 3, 4, 5].some((t) => t !== pickTier && tryAdd(t));
      if (!ok) break; // collection exhausted
    }
  }
  render();
}

async function saveDeck() {
  if (_editorIds.length !== DECK_SIZE) return;
  // Update an existing deck (we're editing one) or create a new one.
  const url = _editingDeckId ? `/me/decks/${_editingDeckId}` : "/me/decks";
  const method = _editingDeckId ? "PATCH" : "POST";
  const setActive = !_activeDeckId; // first deck a user creates becomes active
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: _editingDeckName || "Main Deck",
        card_ids: _editorIds,
        set_active: setActive,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "save failed");
    if (!_editingDeckId) {
      _editingDeckId = data.deck.id;
      if (setActive) _activeDeckId = data.deck.id;
    }
    flashSaved();
    // Refresh the deck list so the new/renamed deck appears in the dropdown.
    const r = await fetch("/me/decks");
    if (r.ok) _decks = (await r.json()).decks;
    render();
  } catch (err) {
    alert("Save failed: " + (err.message || "unknown"));
  }
}

function flashSaved() {
  const btn = document.querySelector(".cb-save");
  if (!btn) return;
  const txt = btn.textContent;
  btn.textContent = "Saved ✓";
  btn.classList.add("saved");
  setTimeout(() => {
    btn.textContent = txt;
    btn.classList.remove("saved");
  }, 1400);
}

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
