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
  {
    id: "lightning",
    name: "Static Surge",
    type: "lightning",
    cover: 26, // Raichu
    blurb: "Raichu's Thunderbolt hits fast and hard — shock Water decks before they set up.",
    cards: [
      ...rep("lightning-pikachu", 4), ...rep("lightning-raichu", 3),
      ...rep("lightning-magnemite", 3), ...rep("lightning-magneton", 2),
      ...rep("lightning-voltorb", 3), ...rep("lightning-electrode", 2),
      ...rep("lightning-electabuzz", 1),
      ...TRAINER_CORE, ...rep("trainer-stadium-arena", 2),
      ...rep("energy-lightning", 20),
    ],
  },
  {
    id: "psychic",
    name: "Mind Bender",
    type: "psychic",
    cover: 65, // Alakazam
    blurb: "Alakazam and Gengar bend the battle — big Psychic hits from a deep evolution bench.",
    cards: [
      ...rep("psychic-abra", 4), ...rep("psychic-kadabra", 3), ...rep("psychic-alakazam", 2),
      ...rep("psychic-gastly", 3), ...rep("psychic-haunter", 2), ...rep("psychic-gengar", 1),
      ...rep("psychic-drowzee", 3),
      ...TRAINER_CORE, ...rep("trainer-stadium-spa", 2),
      ...rep("energy-psychic", 20),
    ],
  },
  {
    id: "fighting",
    name: "Rock Crusher",
    type: "fighting",
    cover: 68, // Machamp
    blurb: "Machamp and Golem crush with raw Fighting power — Catcher a Benched threat, then hit like a landslide.",
    cards: [
      ...rep("fighting-machop", 4), ...rep("fighting-machoke", 3), ...rep("fighting-machamp", 2),
      ...rep("fighting-geodude", 3), ...rep("fighting-graveler", 2), ...rep("fighting-golem", 1),
      ...rep("fighting-mankey", 3),
      // 22 Trainers, showcasing the new Items.
      ...rep("trainer-research", 2), ...rep("trainer-hop", 2), ...rep("trainer-poke-ball", 4),
      ...rep("trainer-ultra-ball", 2), ...rep("trainer-potion", 2), ...rep("trainer-hyper-potion", 2),
      ...rep("trainer-pokemon-catcher", 2), ...rep("trainer-switch", 2), ...rep("trainer-max-potion", 2),
      ...rep("trainer-stadium-arena", 2),
      ...rep("energy-fighting", 20),
    ],
  },
  {
    id: "darkness",
    name: "Shadow Strike",
    type: "darkness",
    cover: 229, // Houndoom
    blurb: "Poison, burn and confuse from the shadows — Houndoom and Golbat grind you down.",
    cards: [
      ...rep("darkness-houndour", 4), ...rep("darkness-houndoom", 3),
      ...rep("darkness-ekans", 2), ...rep("darkness-arbok", 2),
      ...rep("darkness-sneasel", 2), ...rep("darkness-murkrow", 2),
      ...rep("darkness-zubat", 2), ...rep("darkness-golbat", 1),
      ...TRAINER_CORE, ...rep("trainer-stadium-spa", 2),
      ...rep("energy-darkness", 20),
    ],
  },
  {
    id: "metal",
    name: "Steel Fortress",
    type: "metal",
    cover: 208, // Steelix
    blurb: "Armor up. Steelix and Scizor wall out attackers, then hit back like a wrecking ball.",
    cards: [
      ...rep("fighting-onix", 3), ...rep("metal-onix-steelix", 2),
      ...rep("grass-scyther", 2), ...rep("metal-scyther-scizor", 2),
      ...rep("metal-skarmory", 3), ...rep("metal-pineco", 2),
      ...rep("metal-forretress", 2), ...rep("metal-beldum", 2),
      ...TRAINER_CORE, ...rep("trainer-stadium-arena", 2),
      ...rep("energy-metal", 20),
    ],
  },
  {
    id: "dragon",
    name: "Sky Kings",
    type: "colorless",
    cover: 149, // Dragonite
    blurb: "Colorless titans — Dragonite, Snorlax and Mega Kangaskhan EX bulldoze any matchup.",
    cards: [
      ...rep("colorless-dratini", 4), ...rep("colorless-dragonair", 3), ...rep("colorless-dragonite", 2),
      ...rep("colorless-snorlax", 2), ...rep("colorless-tauros", 2),
      ...rep("colorless-kangaskhan", 2), ...rep("mega-kangaskhan-ex", 1),
      ...rep("colorless-eevee", 2),
      ...TRAINER_CORE, ...rep("trainer-stadium-arena", 2),
      ...rep("energy-lightning", 20),
    ],
  },
  {
    id: "water-mega",
    name: "Abyssal Tide",
    type: "water",
    cover: 10041, // Mega Gyarados
    blurb: "Wash them away — Gyarados and Mega Gyarados EX crash down behind a wall of shellfish.",
    cards: [
      ...rep("water-magikarp", 3), ...rep("water-gyarados", 2), ...rep("mega-gyarados-ex", 1),
      ...rep("water-lapras", 2), ...rep("water-shellder", 2), ...rep("water-cloyster", 2),
      ...rep("water-krabby", 2), ...rep("water-kingler", 2),
      ...rep("water-tentacool", 2), ...rep("water-tentacruel", 2),
      ...TRAINER_CORE, ...rep("trainer-stadium-spa", 2),
      ...rep("energy-water", 18),
    ],
  },
  {
    id: "fire-mega",
    name: "Volcanic Fury",
    type: "fire",
    cover: 10034, // Mega Charizard X
    blurb: "All-out aggression. Ramp into Mega Charizard EX and end games in a single Crimson Storm.",
    cards: [
      ...rep("fire-growlithe", 3), ...rep("fire-arcanine", 2),
      ...rep("fire-vulpix", 2), ...rep("fire-ninetales", 2),
      ...rep("fire-magmar", 2), ...rep("fire-moltres", 2),
      ...rep("fire-charmander", 2), ...rep("fire-charmeleon", 1), ...rep("fire-charizard", 1), ...rep("mega-charizard-ex", 1),
      ...TRAINER_CORE, ...rep("trainer-stadium-arena", 2),
      ...rep("energy-fire", 20),
    ],
  },
  {
    id: "psychic-mega",
    name: "Psy Storm",
    type: "psychic",
    cover: 10043, // Mega Mewtwo X
    blurb: "Overwhelming psychic force — Mega Mewtwo EX and Mega Gengar EX from a deep bench.",
    cards: [
      ...rep("psychic-mewtwo", 2), ...rep("mega-mewtwo-ex", 1),
      ...rep("psychic-gastly", 3), ...rep("psychic-haunter", 2), ...rep("psychic-gengar", 1), ...rep("mega-gengar-ex", 1),
      ...rep("psychic-slowpoke", 2), ...rep("psychic-slowbro", 2),
      ...rep("psychic-jynx", 2), ...rep("psychic-mew", 1),
      ...TRAINER_CORE, ...rep("trainer-stadium-spa", 2),
      ...rep("energy-psychic", 21),
    ],
  },
  {
    id: "dragon-type",
    name: "Dragon's Den",
    type: "dragon",
    cover: 445, // Garchomp
    blurb: "Raw power. Garchomp, Salamence and Flygon hit for enormous damage once they land.",
    cards: [
      ...rep("dragon-gible", 3), ...rep("dragon-gabite", 2), ...rep("dragon-garchomp", 2),
      ...rep("dragon-bagon", 3), ...rep("dragon-shelgon", 2), ...rep("dragon-salamence", 1),
      ...rep("dragon-trapinch", 2), ...rep("dragon-vibrava", 1), ...rep("dragon-flygon", 1),
      ...TRAINER_CORE, ...rep("trainer-stadium-plant", 2),
      ...rep("energy-dragon", 21),
    ],
  },
  {
    id: "fairy-type",
    name: "Fairy Tale",
    type: "fairy",
    cover: 282, // Gardevoir
    blurb: "Grace under fire — Gardevoir and Togekiss heal and hit while you draw ahead.",
    cards: [
      ...rep("fairy-ralts", 3), ...rep("fairy-kirlia", 2), ...rep("fairy-gardevoir", 2),
      ...rep("fairy-togepi", 3), ...rep("fairy-togetic", 2), ...rep("fairy-togekiss", 1),
      ...rep("fairy-snubbull", 2), ...rep("fairy-granbull", 1), ...rep("fairy-mawile", 2),
      ...rep("trainer-research", 3), ...rep("trainer-bill", 2), ...rep("trainer-nest-ball", 3),
      ...rep("trainer-poke-ball", 2), ...rep("trainer-potion", 2), ...rep("trainer-full-restore", 2),
      ...rep("trainer-switch", 2), ...rep("trainer-erika", 2), ...rep("trainer-stadium-seas", 2),
      ...rep("energy-fairy", 22),
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
