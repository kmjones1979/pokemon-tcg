// Client-side TCG collection + pack wallet, backed by localStorage so it works
// for guests and signed-in players alike (no server round-trip). Stores a map
// of owned card id → count, and a count of unopened booster packs.

const CKEY = "tcg-collection-v1";
const PKEY = "tcg-packs-v1";

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
