// Anonymous (guest) game state — owned cards, story chapters cleared,
// champion victories, achievements seen — all persisted in localStorage
// until the user creates an account. On signup/login we POST the
// snapshot to /me/migrate-guest which merges it into the real user row.
//
// All read/write goes through this module so the on-disk shape can
// evolve without touching call sites.

const STORAGE_KEY = "pokemon-tcg-guest-state-v1";

function emptyState() {
  return {
    ownedCards: {},       // { [pokemonId]: quantity }
    storyProgress: [],    // [chapterId, ...]
    championWins: [],     // [championId, ...]
    achievementsViewed: [], // [achievementId, ...]
    updatedAt: 0,
  };
}

function read() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

function write(state) {
  try {
    state.updatedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function get() { return read(); }

export function addCard(pokemonId) {
  const s = read();
  // Cap each guest card at 5 — anti-abuse + matches the standard ≤2
  // copies in a deck × a few decks worth of duplicates.
  s.ownedCards[pokemonId] = Math.min(5, (s.ownedCards[pokemonId] || 0) + 1);
  write(s);
  return s;
}

export function markChapterCompleted(chapterId) {
  const s = read();
  if (!s.storyProgress.includes(chapterId)) s.storyProgress.push(chapterId);
  write(s);
  return s;
}

export function markChampionBeaten(championId) {
  const s = read();
  if (!s.championWins.includes(championId)) s.championWins.push(championId);
  write(s);
  return s;
}

export function isEmpty() {
  const s = read();
  return (
    Object.keys(s.ownedCards).length === 0 &&
    s.storyProgress.length === 0 &&
    s.championWins.length === 0
  );
}

export function clear() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

// Push the guest snapshot to the server right after signup/login.
// Server merges idempotently — calling twice is safe but redundant,
// so we clear the local copy on success.
export async function migrateOnSignup() {
  const s = read();
  if (isEmpty()) return { migrated: false, reason: "no-guest-state" };
  try {
    const r = await fetch("/me/migrate-guest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(s),
    });
    if (!r.ok) {
      return { migrated: false, reason: `http_${r.status}` };
    }
    const data = await r.json();
    clear();
    return { migrated: true, ...data };
  } catch (err) {
    return { migrated: false, reason: err.message || "network" };
  }
}
