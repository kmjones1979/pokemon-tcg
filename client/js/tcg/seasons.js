// TCG Seasons — time-boxed competitive periods, each with a theme, a featured
// seasonal booster, and a climbing ladder (Bronze → Master) that grants pack
// rewards as you rank up. Progress is stored client-side (localStorage) and
// resets when a new season begins, so every season is a fresh climb.
//
// Season points (SP): +50 for a win, +12 for a hard-fought loss. Crossing a
// tier threshold grants a booster pack, claimed exactly once per season.

import { addPacks } from "./collection.js";

const PKEY = "tcg-season-v1";

// Ladder tiers, ascending. `min` is the SP needed to reach the tier.
export const TIERS = [
  { key: "bronze",   name: "Bronze",   min: 0,   color: "#c8813f" },
  { key: "silver",   name: "Silver",   min: 120, color: "#b8c0cc" },
  { key: "gold",     name: "Gold",     min: 280, color: "#f2c14e" },
  { key: "platinum", name: "Platinum", min: 480, color: "#5fd0c5" },
  { key: "master",   name: "Master",   min: 750, color: "#c86bff" },
];

export const WIN_SP = 50;
export const LOSS_SP = 12;

// Season calendar. Absolute UTC date ranges (end-exclusive). Themed around the
// featured type — the seasonal booster leans into that type's chase Ultras.
// `featuredUltras` are the marquee guest-artist / chase cards to spotlight.
export const SEASONS = [
  { id: "s1-kanto-embers", name: "Kanto Embers", theme: "fire", emoji: "🔥",
    start: "2026-06-01", end: "2026-08-01",
    blurb: "The set ignites. Charizard leads the charge in Akira Toriyama's guest art.",
    featuredUltras: ["fire-charizard", "fire-arcanine"] },
  { id: "s2-tidal-surge", name: "Tidal Surge", theme: "water", emoji: "🌊",
    start: "2026-08-01", end: "2026-10-01",
    blurb: "The tide turns. Blastoise storms in, drawn by Eiichiro Oda.",
    featuredUltras: ["water-blastoise", "water-gyarados"] },
  { id: "s3-verdant-dream", name: "Verdant Dream", theme: "grass", emoji: "🌿",
    start: "2026-10-01", end: "2026-12-01",
    blurb: "Nature awakens. Venusaur blooms in Hayao Miyazaki's guest art.",
    featuredUltras: ["grass-venusaur", "grass-vileplume"] },
  { id: "s4-psychic-static", name: "Psychic Static", theme: "psychic", emoji: "🔮",
    start: "2026-12-01", end: "2027-02-01",
    blurb: "Minds collide. Alakazam & Gengar arrive via Lichtenstein and Killer Acid.",
    featuredUltras: ["psychic-alakazam", "psychic-gengar"] },
];

const ms = (d) => Date.parse(`${d}T00:00:00Z`);

// The season covering `now` (defaults to the current time). Falls back to the
// nearest season so the hub always has something to show off-calendar.
export function currentSeason(now = Date.now()) {
  for (const s of SEASONS) {
    if (now >= ms(s.start) && now < ms(s.end)) return s;
  }
  // Before the first / after the last — clamp to the nearest edge.
  if (now < ms(SEASONS[0].start)) return SEASONS[0];
  return SEASONS[SEASONS.length - 1];
}

export function daysLeft(season, now = Date.now()) {
  return Math.max(0, Math.ceil((ms(season.end) - now) / 86_400_000));
}

// ---- progress (localStorage) --------------------------------------------
function read() {
  try { return JSON.parse(localStorage.getItem(PKEY)) || null; } catch { return null; }
}
function write(v) { try { localStorage.setItem(PKEY, JSON.stringify(v)); } catch {} }

// Return this season's progress, resetting if the season rolled over.
export function getProgress(now = Date.now()) {
  const season = currentSeason(now);
  let p = read();
  if (!p || p.seasonId !== season.id) {
    p = { seasonId: season.id, points: 0, claimed: [] };
    write(p);
  }
  return p;
}

export function tierFor(points) {
  let t = TIERS[0];
  for (const tier of TIERS) if (points >= tier.min) t = tier;
  return t;
}

// The next tier above the current points, or null at Master.
export function nextTier(points) {
  return TIERS.find((t) => t.min > points) || null;
}

// Award SP for a match result. Returns { points, tier, newTier, rewardPacks }
// where newTier is set when the player just crossed into a higher tier and
// rewardPacks is how many booster packs that milestone granted.
export function recordResult(won, now = Date.now()) {
  const p = getProgress(now);
  const before = tierFor(p.points);
  p.points += won ? WIN_SP : LOSS_SP;
  const after = tierFor(p.points);

  let rewardPacks = 0;
  let newTier = null;
  if (after.min > before.min && !p.claimed.includes(after.key)) {
    p.claimed.push(after.key);
    newTier = after;
    rewardPacks = after.key === "master" ? 3 : after.key === "platinum" ? 2 : 1;
    addPacks(rewardPacks);
  }
  write(p);
  return { points: p.points, tier: after, newTier, rewardPacks };
}
