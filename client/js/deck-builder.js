// Collection viewer + deck builder.
//
// Renders an overlay panel listing every card the user owns. From there they
// can drag-or-tap cards into a 30-slot deck list and save it. The active deck
// is the one used in single-player when "Battle" is pressed and in
// multiplayer matchmaking.

import { renderCard } from "./cards.js";

const DECK_SIZE = 30;
const MAX_COPIES = 2;

let _onClose = null;          // close callback
let _collection = [];          // [{id, name, types, ..., quantity}]
let _decks = [];               // [{id, name, card_ids[], is_active}]
let _activeDeckId = null;      // id of the deck we're editing
let _editorIds = [];           // current draft as a flat list of pokemon ids
let _filter = { type: "all", tier: "all", search: "" };

export async function open({ onClose }) {
  _onClose = onClose;
  const overlay = ensureOverlay();
  overlay.classList.remove("hidden");
  await refresh();
}

export function close() {
  document.querySelector(".collection-overlay")?.classList.add("hidden");
  _onClose?.();
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
      _editorIds = active.card_ids.slice();
    } else {
      _activeDeckId = null;
      _editorIds = [];
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
          <div class="cb-section-title">
            Deck (<span class="cb-deck-count">${_editorIds.length}</span>/${DECK_SIZE})
            <div class="cb-deck-bymtier">
              ${[1,2,3,4,5].map((t) => `<span class="tier-pip tier-${t}">${deckSummary.byTier[t] || 0}</span>`).join("")}
            </div>
          </div>
          <div class="cb-deck-list"></div>
          <div class="cb-deck-actions">
            <button class="cb-auto">Auto-fill</button>
            <button class="cb-clear">Clear</button>
            <button class="cb-save primary" ${_editorIds.length === DECK_SIZE ? "" : "disabled"}>
              Save as Active
            </button>
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
    const card = renderCard(c, { compact: true });
    card.classList.add("cb-collection-card");
    wrapper.appendChild(card);
    const tag = document.createElement("div");
    tag.className = "cb-qty";
    tag.textContent = `${remaining}/${c.quantity}`;
    wrapper.appendChild(tag);
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
  overlay.querySelector(".cb-clear").addEventListener("click", () => { _editorIds = []; render(); });
  overlay.querySelector(".cb-save").addEventListener("click", saveDeck);
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
  // If the user already has an active deck we update it; otherwise create.
  const url = _activeDeckId ? `/me/decks/${_activeDeckId}` : "/me/decks";
  const method = _activeDeckId ? "PATCH" : "POST";
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Main Deck",
        card_ids: _editorIds,
        set_active: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "save failed");
    if (!_activeDeckId) {
      _activeDeckId = data.deck.id;
      // mark active explicitly (POST handles this server-side via set_active)
    } else {
      // If we updated, also make sure it's flagged active.
      await fetch(`/me/decks/${_activeDeckId}/active`, { method: "POST" });
    }
    flashSaved();
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
