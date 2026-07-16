// Preconstructed 60-card starter decks for the TCG mode. Each list respects
// the real construction rules used in v1: exactly 60 cards, at most 4 copies of
// any non-Energy card, basic Energy unlimited. Each deck carries ~9-10 Basic
// Pokémon for opening-hand consistency.

import { cardById } from "./catalog.js";

const rep = (id, n) => Array(n).fill(id);

// Shared Trainer package (20) + a deck-specific Stadium (2) = 22 Trainers.
const TRAINER_CORE = [
  ...rep("trainer-research", 3),
  ...rep("trainer-hop", 2),
  ...rep("trainer-poke-ball", 4),
  ...rep("trainer-great-ball", 2),
  ...rep("trainer-potion", 3),
  ...rep("trainer-super-potion", 2),
  ...rep("trainer-switch", 2),
  ...rep("trainer-energy-search", 2),
];

export const STARTER_DECKS = [
  {
    id: "fire",
    name: "Blazing Roar",
    type: "fire",
    cover: 6, // Charizard
    blurb: "Charizard hits hardest of all — ramp Fire Energy and burn through walls.",
    cards: [
      ...rep("fire-charmander", 4), ...rep("fire-charmeleon", 3), ...rep("fire-charizard", 2),
      ...rep("fire-growlithe", 3), ...rep("fire-arcanine", 2),
      ...rep("fire-vulpix", 2), ...rep("fire-ninetales", 2),
      ...TRAINER_CORE, ...rep("trainer-stadium-arena", 2),
      ...rep("energy-fire", 20),
    ],
  },
  {
    id: "water",
    name: "Tidal Guard",
    type: "water",
    cover: 9, // Blastoise
    blurb: "Blastoise tanks and Hydro Pumps scale with every Water Energy you attach.",
    cards: [
      ...rep("water-squirtle", 4), ...rep("water-wartortle", 3), ...rep("water-blastoise", 2),
      ...rep("water-psyduck", 3), ...rep("water-golduck", 2),
      ...rep("water-staryu", 2), ...rep("water-starmie", 2),
      ...TRAINER_CORE, ...rep("trainer-stadium-spa", 2),
      ...rep("energy-water", 20),
    ],
  },
  {
    id: "grass",
    name: "Verdant Bloom",
    type: "grass",
    cover: 3, // Venusaur
    blurb: "Venusaur drains and heals — outlast opponents with relentless Grass recovery.",
    cards: [
      ...rep("grass-bulbasaur", 4), ...rep("grass-ivysaur", 3), ...rep("grass-venusaur", 2),
      ...rep("grass-oddish", 3), ...rep("grass-gloom", 2), ...rep("grass-vileplume", 1),
      ...rep("grass-bellsprout", 3),
      ...TRAINER_CORE, ...rep("trainer-stadium-spa", 2),
      ...rep("energy-grass", 20),
    ],
  },
];

export const deckById = (id) => STARTER_DECKS.find((d) => d.id === id) || null;

// Composition summary for the deck-selection screen: card-type counts plus the
// marquee Pokémon (highest evolution stages first) for preview thumbnails.
export function deckStats(deck) {
  let pokemon = 0, trainers = 0, energy = 0;
  const weight = new Map(); // dex → stage weight (Stage 2 ranks highest)
  for (const id of deck.cards) {
    const c = cardById(id);
    if (c.kind === "energy") energy++;
    else if (c.kind === "pokemon") {
      pokemon++;
      const w = c.stage === "stage2" ? 100 : c.stage === "stage1" ? 10 : 1;
      weight.set(c.dex, Math.max(weight.get(c.dex) || 0, w));
    } else trainers++;
  }
  const preview = [...weight.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map((e) => e[0]);
  return { pokemon, trainers, energy, preview };
}
