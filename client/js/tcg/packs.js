// Booster-pack generation. A pack is 5 cards: three commons, one uncommon, and
// one "rare slot" that is usually Rare and occasionally an Ultra Rare — so
// pulling a rainbow-foil ace feels like a real hit.

import { POKEMON, TRAINERS } from "./catalog.js";
import { rng } from "./effects.js";

export const PACK_SIZE = 5;
export const ULTRA_CHANCE = 0.16;

// Card pool grouped by rarity. Pokémon carry their own rarity; Trainers map by
// kind (Stadium = Rare, Supporter = Uncommon, Item = Common). Energy excluded.
const POOL = { common: [], uncommon: [], rare: [], ultra: [] };
for (const p of POKEMON) (POOL[p.rarity] || POOL.common).push(p.id);
for (const t of TRAINERS) {
  const r = t.kind === "stadium" ? "rare" : t.kind === "supporter" ? "uncommon" : "common";
  POOL[r].push(t.id);
}

function pick(rarity) {
  const arr = POOL[rarity]?.length ? POOL[rarity] : POOL.common;
  return arr[Math.floor(rng() * arr.length)];
}

// Returns an array of PACK_SIZE card ids.
export function rollPack() {
  return [
    pick("common"), pick("common"), pick("common"),
    pick("uncommon"),
    pick(rng() < ULTRA_CHANCE ? "ultra" : "rare"),
  ];
}
