// Gen 6+ type effectiveness chart.
// CHART[attacker][defender] = multiplier (2, 0.5, 0, or 1).
// Lookups treat missing entries as 1×.

export const TYPES = [
  "normal", "fire", "water", "electric", "grass", "ice",
  "fighting", "poison", "ground", "flying", "psychic", "bug",
  "rock", "ghost", "dragon", "dark", "steel", "fairy",
];

export const TYPE_COLORS = {
  normal:   "#A8A77A",
  fire:     "#EE8130",
  water:    "#6390F0",
  electric: "#F7D02C",
  grass:    "#7AC74C",
  ice:      "#96D9D6",
  fighting: "#C22E28",
  poison:   "#A33EA1",
  ground:   "#E2BF65",
  flying:   "#A98FF3",
  psychic:  "#F95587",
  bug:      "#A6B91A",
  rock:     "#B6A136",
  ghost:    "#735797",
  dragon:   "#6F35FC",
  dark:     "#705746",
  steel:    "#B7B7CE",
  fairy:    "#D685AD",
};

// rows = attacker, cols = defender. Only non-1 entries listed.
const RAW = {
  normal:   { rock: 0.5, ghost: 0,   steel: 0.5 },
  fire:     { fire: 0.5, water: 0.5, grass: 2,   ice: 2,    bug: 2,    rock: 0.5, dragon: 0.5, steel: 2 },
  water:    { fire: 2,   water: 0.5, grass: 0.5, ground: 2, rock: 2,   dragon: 0.5 },
  electric: { water: 2,  electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
  grass:    { fire: 0.5, water: 2,   grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
  ice:      { fire: 0.5, water: 0.5, grass: 2,   ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
  fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5 },
  poison:   { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
  ground:   { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
  flying:   { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
  psychic:  { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
  bug:      { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5, fairy: 0.5 },
  rock:     { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
  ghost:    { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
  dragon:   { dragon: 2, steel: 0.5, fairy: 0 },
  dark:     { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
  steel:    { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
  fairy:    { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 },
};

// Damage multiplier for an attack of `attackerType` against a defender with
// `defenderTypes`. Stacks across the defender's types, but capped at 2x in
// both directions — this is a fairness departure from the official games,
// where 4x and 0.25x are possible. In our TCG, card HP is small (1-25), so
// uncapped 4x super-effective frequently one-shots a defender. The 2x cap
// keeps type-matchups meaningful without making turn-1 KOs trivial.
export function getMultiplier(attackerType, defenderTypes) {
  if (!attackerType || !defenderTypes || defenderTypes.length === 0) return 1;
  const row = RAW[attackerType];
  if (!row) return 1;
  let mult = 1;
  let immune = false;
  for (const t of defenderTypes) {
    if (t in row) {
      if (row[t] === 0) immune = true;
      mult *= row[t];
    }
  }
  if (immune) return 0;
  // Cap at [0.5, 2] outside of immunity.
  return Math.max(0.5, Math.min(2, mult));
}

// Human-readable verdict for an effectiveness multiplier (used by toasts).
export function describeMultiplier(mult) {
  if (mult === 0) return { text: "No effect!", tone: "miss" };
  if (mult >= 4) return { text: "Devastating!", tone: "super" };
  if (mult >= 2) return { text: "Super effective!", tone: "super" };
  if (mult <= 0.25) return { text: "Barely scratched...", tone: "weak" };
  if (mult < 1) return { text: "Not very effective.", tone: "weak" };
  return { text: "", tone: "normal" };
}
