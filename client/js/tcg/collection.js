// Client-side TCG collection + pack wallet, backed by localStorage so it works
// for guests and signed-in players alike (no server round-trip). Stores a map
// of owned card id → count, and a count of unopened booster packs.

import { POKEMON, TRAINERS } from "./catalog.js";

const CKEY = "tcg-collection-v1";
const PKEY = "tcg-packs-v1";
const DKEY = "tcg-decks-v1";
const SEED_KEY = "tcg-seeded-v1";

function read(key, def) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? def : v; }
  catch { return def; }
}
function write(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

export function getCards() { return read(CKEY, {}); }
export function addCards(ids) {
  const c = getCards();
  for (const id of ids) c[id] = (c[id] || 0) + 1;
  write(CKEY, c);
  return c;
}
export function ownedCount(id) { return getCards()[id] || 0; }
export function totalCards() { return Object.values(getCards()).reduce((a, b) => a + b, 0); }
export function uniqueCards() { return Object.keys(getCards()).length; }

export function getPacks() { return read(PKEY, 0); }
export function addPacks(n = 1) { const p = getPacks() + n; write(PKEY, p); return p; }
export function takePack() { const p = getPacks(); if (p > 0) { write(PKEY, p - 1); return true; } return false; }

// One-time welcome: grant every card except the 8 Ultra-Rare aces (2 copies of
// Common/Uncommon, 1 of each Rare) so you can build decks right away — the
// aces stay a pack-pull chase. Also gift a couple of packs to open.
export function ensureSeeded() {
  if (read(SEED_KEY, false)) return;
  const c = getCards();
  for (const card of [...POKEMON, ...TRAINERS]) {
    const n = card.rarity === "ultra" ? 0 : card.rarity === "rare" ? 1 : 2;
    if (n) c[card.id] = Math.max(c[card.id] || 0, n);
  }
  write(CKEY, c);
  write(PKEY, Math.max(getPacks(), 2));
  write(SEED_KEY, true);
}

// Custom decks: [{ id, name, type, cards: [cardId, ...] }]
export function getDecks() { return read(DKEY, []); }
export function saveDeck(deck) {
  const decks = getDecks();
  const i = decks.findIndex((d) => d.id === deck.id);
  if (i >= 0) decks[i] = deck; else decks.push(deck);
  write(DKEY, decks);
  return decks;
}
export function deleteDeck(id) { write(DKEY, getDecks().filter((d) => d.id !== id)); }
