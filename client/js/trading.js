// Trading panel — market browse, create offer, manage own offers, history.

import { TYPE_COLORS } from "./type-chart.js";
import { flashVerdict } from "./animations.js";

let _stage = null;
let _tab = "market"; // market | mine | create | history
let _collection = []; // cached on first open
let _pokedex = [];

function escape(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
}

function ensureStage() {
  if (_stage) return _stage;
  _stage = document.createElement("section");
  _stage.id = "trade-stage";
  document.body.appendChild(_stage);
  return _stage;
}

function close() {
  _stage?.remove();
  _stage = null;
}

export async function openTradeMarket({ currentUser } = {}) {
  if (!currentUser) {
    flashVerdict("Sign in to trade cards", "weak");
    return;
  }
  ensureStage();
  _stage.innerHTML = `<div class="trade-loading">Loading market…</div>`;
  await Promise.all([
    loadCollection(),
    loadPokedexCache(),
  ]);
  await renderTab();
}

async function loadCollection() {
  try {
    const r = await fetch("/me/collection");
    if (r.ok) {
      const data = await r.json();
      _collection = data.cards || data.collection || [];
    }
  } catch {}
}

async function loadPokedexCache() {
  if (_pokedex.length) return;
  try {
    const r = await fetch("/api/deck"); // returns 30 random cards w/ pokedex shape — not full dex
    // Better: use a dedicated endpoint. /api/pokedex/full would be the right
    // hook; for now we lazily build via existing endpoints. Skipped for v1
    // since the trade UI shows specific offers and pulls card metadata
    // through the server's offer decorator anyway.
  } catch {}
}

async function renderTab() {
  const tabs = `
    <header class="trade-header">
      <button class="trade-x" data-act="close">✕</button>
      <h1 class="trade-title">Trading Post</h1>
      <nav class="trade-tabs">
        <button class="trade-tab ${_tab === "market" ? "active" : ""}" data-tab="market">Market</button>
        <button class="trade-tab ${_tab === "create" ? "active" : ""}" data-tab="create">Create Offer</button>
        <button class="trade-tab ${_tab === "mine" ? "active" : ""}" data-tab="mine">My Offers</button>
        <button class="trade-tab ${_tab === "history" ? "active" : ""}" data-tab="history">History</button>
      </nav>
    </header>
    <div class="trade-body" id="trade-body"></div>`;
  _stage.innerHTML = tabs;
  _stage.querySelector("[data-act=close]").addEventListener("click", close);
  _stage.querySelectorAll(".trade-tab").forEach((btn) => {
    btn.addEventListener("click", () => { _tab = btn.dataset.tab; renderTab(); });
  });
  const body = _stage.querySelector("#trade-body");
  if (_tab === "market") await renderMarket(body);
  else if (_tab === "create") await renderCreate(body);
  else if (_tab === "mine") await renderMine(body);
  else if (_tab === "history") await renderHistory(body);
}

async function renderMarket(body) {
  body.innerHTML = `<div class="trade-loading">Loading offers…</div>`;
  try {
    const r = await fetch("/api/trades/market");
    const { offers } = await r.json();
    if (!offers.length) {
      body.innerHTML = `<div class="trade-empty">No open trades right now. Be the first to <a data-jump="create">create one</a>.</div>`;
      body.querySelector("[data-jump=create]")?.addEventListener("click", () => { _tab = "create"; renderTab(); });
      return;
    }
    const ownedById = new Map(_collection.map((c) => [c.id, c]));
    body.innerHTML = `
      <div class="trade-grid">
        ${offers.map((o) => offerCard(o, ownedById)).join("")}
      </div>`;
    body.querySelectorAll("[data-accept]").forEach((btn) =>
      btn.addEventListener("click", () => acceptOffer(btn.dataset.accept)));
  } catch (err) {
    body.innerHTML = `<div class="trade-error">${escape(err.message)}</div>`;
  }
}

function offerCard(offer, ownedById) {
  const wantedOwned = (ownedById.get(offer.wanted?.id)?.quantity) || 0;
  const canAccept = wantedOwned >= 1;
  return `
    <div class="offer-card">
      <div class="offer-trainer">${escape(offer.offererName || "Trainer")}</div>
      <div class="offer-swap">
        ${cardTile(offer.offered, "Offers")}
        <div class="swap-arrow">↔</div>
        ${cardTile(offer.wanted, "Wants")}
      </div>
      ${canAccept
        ? `<button class="primary" data-accept="${offer.id}">Accept ▸</button>`
        : `<button disabled title="You don't own ${escape(offer.wanted?.name || "this card")}">You need ${escape(offer.wanted?.name || "the wanted card")}</button>`}
    </div>`;
}

function cardTile(card, label) {
  if (!card) return `<div class="card-tile"><div class="tile-label">${label}</div><div class="tile-empty">?</div></div>`;
  const color = TYPE_COLORS[card.types?.[0]] || "#888";
  const rare = card.is_mythical ? "mythical" : card.is_legendary ? "legendary" : "";
  return `
    <div class="card-tile" style="--type:${color}" ${rare ? `data-rare="${rare}"` : ""}>
      <div class="tile-label">${label}</div>
      <div class="tile-art">${card.sprite_front ? `<img src="${card.sprite_front}" alt="${escape(card.name)}" loading="lazy">` : ""}</div>
      <div class="tile-name">${escape(card.name)}</div>
      <div class="tile-stats">T${card.tier} · ⚔${card.cardAttack} · ❤${card.cardHp}</div>
    </div>`;
}

async function acceptOffer(id) {
  if (!confirm("Accept this trade? The swap is final.")) return;
  try {
    const r = await fetch(`/me/trades/${id}/accept`, { method: "POST" });
    const data = await r.json();
    if (!r.ok) { flashVerdict(data.error || "Couldn't accept.", "weak"); return; }
    flashVerdict("Trade complete! Cards swapped.", "super");
    await loadCollection();
    renderTab();
  } catch (err) {
    flashVerdict(`Network error: ${err.message}`, "weak");
  }
}

async function renderCreate(body) {
  if (!_collection.length) {
    body.innerHTML = `<div class="trade-empty">You don't own any cards yet. Win matches to earn cards, then trade.</div>`;
    return;
  }
  // Sort by quantity desc — duplicates first, so the most "tradable" cards
  // surface at the top.
  const sorted = [..._collection].sort((a, b) => (b.quantity || 0) - (a.quantity || 0));
  body.innerHTML = `
    <div class="trade-create">
      <div class="trade-step">
        <div class="trade-step-num">1</div>
        <div class="trade-step-content">
          <div class="trade-step-title">Card you'll offer (from your collection)</div>
          <div class="trade-pick-grid" id="offer-pick">
            ${sorted.map((c) => pickTile(c, "offered")).join("")}
          </div>
        </div>
      </div>
      <div class="trade-step">
        <div class="trade-step-num">2</div>
        <div class="trade-step-content">
          <div class="trade-step-title">Pokémon you want (search any of the 1,025)</div>
          <input type="search" class="trade-want-search" placeholder="Name or # (e.g. Charizard or 6)…" />
          <div class="trade-pick-grid" id="want-pick"></div>
        </div>
      </div>
      <div class="trade-submit-row">
        <div class="trade-summary" id="trade-summary">Pick what you offer + what you want above.</div>
        <button class="primary" id="trade-submit" disabled>Create offer</button>
      </div>
    </div>`;
  let chosenOffer = null;
  let chosenWant = null;
  const refreshSubmit = () => {
    const btn = body.querySelector("#trade-submit");
    const sum = body.querySelector("#trade-summary");
    if (chosenOffer && chosenWant) {
      btn.disabled = false;
      sum.innerHTML = `Trade <strong>${escape(chosenOffer.name)}</strong> for <strong>${escape(chosenWant.name)}</strong>?`;
    } else {
      btn.disabled = true;
      sum.textContent = "Pick what you offer + what you want above.";
    }
  };
  body.querySelectorAll("#offer-pick [data-pick]").forEach((tile) => {
    tile.addEventListener("click", () => {
      body.querySelectorAll("#offer-pick [data-pick]").forEach((t) => t.classList.remove("selected"));
      tile.classList.add("selected");
      const id = Number(tile.dataset.pick);
      chosenOffer = _collection.find((c) => c.id === id);
      refreshSubmit();
    });
  });
  const wantInput = body.querySelector(".trade-want-search");
  const wantGrid = body.querySelector("#want-pick");
  async function refreshWantGrid() {
    const q = wantInput.value.trim().toLowerCase();
    if (q.length < 2) {
      wantGrid.innerHTML = `<div class="trade-hint">Type to search the Pokédex…</div>`;
      return;
    }
    try {
      const r = await fetch(`/api/pokedex/search?q=${encodeURIComponent(q)}`);
      if (!r.ok) { wantGrid.innerHTML = `<div class="trade-hint">Search unavailable.</div>`; return; }
      const { results } = await r.json();
      if (!results?.length) { wantGrid.innerHTML = `<div class="trade-hint">No matches.</div>`; return; }
      wantGrid.innerHTML = results.slice(0, 24).map((c) => pickTile({ ...c, quantity: 0 }, "wanted")).join("");
      wantGrid.querySelectorAll("[data-pick]").forEach((tile) => {
        tile.addEventListener("click", () => {
          wantGrid.querySelectorAll("[data-pick]").forEach((t) => t.classList.remove("selected"));
          tile.classList.add("selected");
          const id = Number(tile.dataset.pick);
          chosenWant = results.find((c) => c.id === id);
          refreshSubmit();
        });
      });
    } catch (err) {
      wantGrid.innerHTML = `<div class="trade-hint">Search error.</div>`;
    }
  }
  let _wantTimer = null;
  wantInput.addEventListener("input", () => {
    clearTimeout(_wantTimer);
    _wantTimer = setTimeout(refreshWantGrid, 240);
  });
  refreshWantGrid();
  body.querySelector("#trade-submit").addEventListener("click", async () => {
    if (!chosenOffer || !chosenWant) return;
    if (chosenOffer.quantity <= 1 && !confirm(`You only own one ${chosenOffer.name}. Trade it anyway?`)) return;
    const r = await fetch("/me/trades", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offeredPokemonId: chosenOffer.id, wantedPokemonId: chosenWant.id }),
    });
    const data = await r.json();
    if (!r.ok) { flashVerdict(data.error || "Couldn't create offer.", "weak"); return; }
    flashVerdict("Offer posted to the market.", "super");
    _tab = "mine"; renderTab();
  });
}

function pickTile(c, kind) {
  const color = TYPE_COLORS[c.types?.[0]] || "#888";
  const rare = c.is_mythical ? "mythical" : c.is_legendary ? "legendary" : "";
  const qty = c.quantity || 0;
  return `
    <button class="trade-pick-tile" data-pick="${c.id}" style="--type:${color}" ${rare ? `data-rare="${rare}"` : ""}>
      <div class="tile-art-sm">${c.sprite_front ? `<img src="${c.sprite_front}" alt="" loading="lazy">` : ""}</div>
      <div class="tile-name-sm">${escape(c.name)}</div>
      ${kind === "offered" ? `<div class="tile-qty">×${qty}</div>` : ""}
    </button>`;
}

async function renderMine(body) {
  body.innerHTML = `<div class="trade-loading">Loading…</div>`;
  try {
    const r = await fetch("/me/trades");
    const { offers } = await r.json();
    if (!offers.length) {
      body.innerHTML = `<div class="trade-empty">You have no open offers. <a data-jump="create">Create one</a> to start trading.</div>`;
      body.querySelector("[data-jump=create]")?.addEventListener("click", () => { _tab = "create"; renderTab(); });
      return;
    }
    body.innerHTML = `<div class="trade-grid">${offers.map((o) => mineCard(o)).join("")}</div>`;
    body.querySelectorAll("[data-cancel]").forEach((btn) =>
      btn.addEventListener("click", () => cancelOffer(btn.dataset.cancel)));
  } catch (err) {
    body.innerHTML = `<div class="trade-error">${escape(err.message)}</div>`;
  }
}

function mineCard(o) {
  const remaining = Math.max(0, new Date(o.expiresAt).getTime() - Date.now());
  const hours = Math.floor(remaining / 3600000);
  const mins = Math.floor((remaining % 3600000) / 60000);
  return `
    <div class="offer-card mine">
      <div class="offer-trainer">Your offer · expires in ${hours}h ${mins}m</div>
      <div class="offer-swap">
        ${cardTile(o.offered, "Offering")}
        <div class="swap-arrow">↔</div>
        ${cardTile(o.wanted, "Wanting")}
      </div>
      <button class="danger" data-cancel="${o.id}">Cancel offer</button>
    </div>`;
}

async function cancelOffer(id) {
  if (!confirm("Cancel this offer?")) return;
  const r = await fetch(`/me/trades/${id}/cancel`, { method: "POST" });
  if (!r.ok) { const d = await r.json().catch(() => ({})); flashVerdict(d.error || "Couldn't cancel.", "weak"); return; }
  flashVerdict("Offer cancelled.", "weak");
  renderTab();
}

async function renderHistory(body) {
  body.innerHTML = `<div class="trade-loading">Loading…</div>`;
  try {
    const r = await fetch("/me/trades/history");
    const { offers } = await r.json();
    if (!offers.length) {
      body.innerHTML = `<div class="trade-empty">No completed trades yet.</div>`;
      return;
    }
    body.innerHTML = `<div class="trade-grid">${offers.map((o) => historyCard(o)).join("")}</div>`;
  } catch (err) {
    body.innerHTML = `<div class="trade-error">${escape(err.message)}</div>`;
  }
}

function historyCard(o) {
  const label = o.status === "accepted" ? `✓ Swapped with ${escape(o.accepterName || "Trainer")}`
              : o.status === "cancelled" ? "✕ Cancelled"
              : "⌛ Expired";
  return `
    <div class="offer-card history status-${o.status}">
      <div class="offer-trainer">${label}</div>
      <div class="offer-swap">
        ${cardTile(o.offered, "Offered")}
        <div class="swap-arrow">↔</div>
        ${cardTile(o.wanted, "Wanted")}
      </div>
    </div>`;
}
