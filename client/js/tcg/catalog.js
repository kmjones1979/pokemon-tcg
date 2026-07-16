// Curated card catalog for the TCG mode. All cards are code-defined (the same
// pattern as shared/spell-cards.js) with string ids, so they never collide
// with the DB pokemon ids or the crowded 10000+ synthetic band.
//
// Card kinds: "pokemon" | "energy" | "item" | "supporter" | "stadium".
// Effects are declarative descriptors interpreted by effects.js.

import GENERATED_ART from "./tcg-art.js";

const ART = (dex) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${dex}.png`;

// Energy-cost shorthand: F fire, W water, G grass, L lightning, P psychic,
// T fighting, C colorless. e.g. k("FFC") -> ["fire","fire","colorless"].
const TYPE_LETTER = { F: "fire", W: "water", G: "grass", L: "lightning", P: "psychic", T: "fighting", C: "colorless" };
const k = (s) => [...s].map((c) => TYPE_LETTER[c]);

const atk = (name, cost, damage, effect = null, text = "") => ({ name, cost: k(cost), damage, effect, text });
const mon = (o) => ({ kind: "pokemon", art: ART(o.dex), status: null, ...o });

// --- Pokémon --------------------------------------------------------------

const POKEMON = [
  // ===== FIRE =====
  mon({ id: "fire-charmander", name: "Charmander", dex: 4, stage: "basic", type: "fire", hp: 60, weak: "water", retreat: 1,
    attacks: [atk("Scratch", "C", 10), atk("Ember", "FC", 30, { type: "selfDiscardEnergy", amount: 1 }, "Discard 1 Energy attached to this Pokémon.")] }),
  mon({ id: "fire-charmeleon", name: "Charmeleon", dex: 5, stage: "stage1", from: "fire-charmander", type: "fire", hp: 90, weak: "water", retreat: 1,
    attacks: [atk("Slash", "CC", 30), atk("Flamethrower", "FFC", 70, { type: "selfDiscardEnergy", amount: 1 }, "Discard 1 Fire Energy.")] }),
  mon({ id: "fire-charizard", name: "Charizard", dex: 6, stage: "stage2", from: "fire-charmeleon", type: "fire", hp: 160, weak: "water", retreat: 3,
    attacks: [atk("Claw Slash", "CC", 40), atk("Fire Blast", "FFCC", 120, { type: "selfDiscardEnergy", amount: 2 }, "Discard 2 Energy attached to this Pokémon.")] }),
  mon({ id: "fire-growlithe", name: "Growlithe", dex: 58, stage: "basic", type: "fire", hp: 70, weak: "water", retreat: 1,
    attacks: [atk("Bite", "C", 10), atk("Flame Tail", "FC", 20)] }),
  mon({ id: "fire-arcanine", name: "Arcanine", dex: 59, stage: "stage1", from: "fire-growlithe", type: "fire", hp: 120, weak: "water", retreat: 2,
    attacks: [atk("Fire Fang", "FC", 50), atk("Heat Tackle", "FFC", 100, { type: "recoil", amount: 20 }, "This Pokémon does 20 damage to itself.")] }),
  mon({ id: "fire-vulpix", name: "Vulpix", dex: 37, stage: "basic", type: "fire", hp: 60, weak: "water", retreat: 1,
    attacks: [atk("Quick Attack", "C", 10, { type: "coinFlipBonus", damage: 10 }, "Flip a coin. If heads, +10 damage."), atk("Ember", "FC", 30, { type: "selfDiscardEnergy", amount: 1 }, "Discard 1 Energy.")] }),
  mon({ id: "fire-ninetales", name: "Ninetales", dex: 38, stage: "stage1", from: "fire-vulpix", type: "fire", hp: 110, weak: "water", retreat: 1,
    attacks: [atk("Flamethrower", "FFC", 80, { type: "selfDiscardEnergy", amount: 1 }, "Discard 1 Fire Energy.")] }),
  mon({ id: "fire-ponyta", name: "Ponyta", dex: 77, stage: "basic", type: "fire", hp: 70, weak: "water", retreat: 1,
    attacks: [atk("Stomp", "C", 10, { type: "coinFlipBonus", damage: 10 }, "Flip a coin. If heads, +10 damage."), atk("Flame Mane", "FC", 30)] }),
  mon({ id: "fire-rapidash", name: "Rapidash", dex: 78, stage: "stage1", from: "fire-ponyta", type: "fire", hp: 100, weak: "water", retreat: 1,
    attacks: [atk("Rear Kick", "CC", 30), atk("Fire Blast", "FFC", 90, { type: "selfDiscardEnergy", amount: 1 }, "Discard 1 Fire Energy.")] }),

  // ===== WATER =====
  mon({ id: "water-squirtle", name: "Squirtle", dex: 7, stage: "basic", type: "water", hp: 60, weak: "lightning", retreat: 1,
    attacks: [atk("Tackle", "C", 10), atk("Bubble", "WC", 20)] }),
  mon({ id: "water-wartortle", name: "Wartortle", dex: 8, stage: "stage1", from: "water-squirtle", type: "water", hp: 90, weak: "lightning", retreat: 1,
    attacks: [atk("Water Gun", "WC", 30), atk("Bite", "CC", 40)] }),
  mon({ id: "water-blastoise", name: "Blastoise", dex: 9, stage: "stage2", from: "water-wartortle", type: "water", hp: 160, weak: "lightning", retreat: 3,
    attacks: [atk("Skull Bash", "CCC", 80), atk("Hydro Pump", "WWC", 60, { type: "plusPerEnergy", per: 20, energyType: "water", ignore: 2 }, "+20 for each extra Water Energy attached.")] }),
  mon({ id: "water-magikarp", name: "Magikarp", dex: 129, stage: "basic", type: "water", hp: 30, weak: "lightning", retreat: 1,
    attacks: [atk("Tackle", "C", 10)] }),
  mon({ id: "water-gyarados", name: "Gyarados", dex: 130, stage: "stage1", from: "water-magikarp", type: "water", hp: 130, weak: "lightning", retreat: 3,
    attacks: [atk("Bite", "CC", 30), atk("Dragon Rage", "WWC", 90)] }),
  mon({ id: "water-staryu", name: "Staryu", dex: 120, stage: "basic", type: "water", hp: 50, weak: "lightning", retreat: 1,
    attacks: [atk("Water Splash", "W", 20)] }),
  mon({ id: "water-starmie", name: "Starmie", dex: 121, stage: "stage1", from: "water-staryu", type: "water", hp: 90, weak: "lightning", retreat: 1,
    attacks: [atk("Swift", "CC", 30), atk("Hydro Splash", "WWC", 60)] }),
  mon({ id: "water-psyduck", name: "Psyduck", dex: 54, stage: "basic", type: "water", hp: 70, weak: "lightning", retreat: 1,
    attacks: [atk("Scratch", "C", 10), atk("Water Gun", "WC", 20)] }),
  mon({ id: "water-golduck", name: "Golduck", dex: 55, stage: "stage1", from: "water-psyduck", type: "water", hp: 120, weak: "lightning", retreat: 1,
    attacks: [atk("Aqua Tail", "WCC", 70), atk("Surf", "WWC", 80)] }),

  // ===== GRASS =====
  mon({ id: "grass-bulbasaur", name: "Bulbasaur", dex: 1, stage: "basic", type: "grass", hp: 60, weak: "fire", retreat: 1,
    attacks: [atk("Tackle", "C", 10), atk("Vine Whip", "GC", 20)] }),
  mon({ id: "grass-ivysaur", name: "Ivysaur", dex: 2, stage: "stage1", from: "grass-bulbasaur", type: "grass", hp: 90, weak: "fire", retreat: 1,
    attacks: [atk("Razor Leaf", "GC", 30), atk("Vine Slap", "GCC", 50)] }),
  mon({ id: "grass-venusaur", name: "Venusaur", dex: 3, stage: "stage2", from: "grass-ivysaur", type: "grass", hp: 160, weak: "fire", retreat: 3,
    attacks: [atk("Solar Beam", "GGC", 80), atk("Mega Drain", "GGCC", 100, { type: "healSelf", amount: 30 }, "Heal 30 damage from this Pokémon.")] }),
  mon({ id: "grass-oddish", name: "Oddish", dex: 43, stage: "basic", type: "grass", hp: 50, weak: "fire", retreat: 1,
    attacks: [atk("Absorb", "G", 10, { type: "healSelf", amount: 10 }, "Heal 10 damage from this Pokémon.")] }),
  mon({ id: "grass-gloom", name: "Gloom", dex: 44, stage: "stage1", from: "grass-oddish", type: "grass", hp: 70, weak: "fire", retreat: 1,
    attacks: [atk("Razor Leaf", "GC", 30)] }),
  mon({ id: "grass-vileplume", name: "Vileplume", dex: 45, stage: "stage2", from: "grass-gloom", type: "grass", hp: 130, weak: "fire", retreat: 2,
    attacks: [atk("Mega Drain", "GGC", 70, { type: "healSelf", amount: 20 }, "Heal 20 damage from this Pokémon.")] }),
  mon({ id: "grass-bellsprout", name: "Bellsprout", dex: 69, stage: "basic", type: "grass", hp: 50, weak: "fire", retreat: 1,
    attacks: [atk("Vine Whip", "G", 10)] }),
  mon({ id: "grass-weepinbell", name: "Weepinbell", dex: 70, stage: "stage1", from: "grass-bellsprout", type: "grass", hp: 80, weak: "fire", retreat: 1,
    attacks: [atk("Razor Leaf", "GC", 30)] }),
  mon({ id: "grass-victreebel", name: "Victreebel", dex: 71, stage: "stage2", from: "grass-weepinbell", type: "grass", hp: 140, weak: "fire", retreat: 2,
    attacks: [atk("Razor Leaf", "GCC", 50), atk("Acid", "GGC", 60)] }),

  // ===== COLORLESS utility (bench support / splashable) =====
  mon({ id: "colorless-pidgey", name: "Pidgey", dex: 16, stage: "basic", type: "colorless", hp: 60, weak: "lightning", retreat: 1,
    attacks: [atk("Gust", "C", 10)] }),
  mon({ id: "colorless-pidgeotto", name: "Pidgeotto", dex: 17, stage: "stage1", from: "colorless-pidgey", type: "colorless", hp: 90, weak: "lightning", retreat: 1,
    attacks: [atk("Wing Attack", "CC", 30)] }),
  mon({ id: "colorless-eevee", name: "Eevee", dex: 133, stage: "basic", type: "colorless", hp: 60, weak: "fighting", retreat: 1,
    attacks: [atk("Tackle", "C", 10), atk("Quick Attack", "CC", 20, { type: "coinFlipBonus", damage: 10 }, "Flip a coin. If heads, +10 damage.")] }),

  // ===== LIGHTNING =====
  mon({ id: "lightning-pikachu", name: "Pikachu", dex: 25, stage: "basic", type: "lightning", hp: 60, weak: "fighting", retreat: 1,
    attacks: [atk("Quick Attack", "C", 10, { type: "coinFlipBonus", damage: 10 }, "Flip a coin. If heads, +10 damage."), atk("Thunder Shock", "L", 20)] }),
  mon({ id: "lightning-raichu", name: "Raichu", dex: 26, stage: "stage1", from: "lightning-pikachu", type: "lightning", hp: 120, weak: "fighting", retreat: 1,
    attacks: [atk("Agility", "CC", 30), atk("Thunderbolt", "LLC", 100, { type: "selfDiscardEnergy", amount: 2 }, "Discard 2 Energy attached to this Pokémon.")] }),
  mon({ id: "lightning-magnemite", name: "Magnemite", dex: 81, stage: "basic", type: "lightning", hp: 60, weak: "fighting", retreat: 1,
    attacks: [atk("Tackle", "C", 10), atk("Thunder Wave", "L", 20)] }),
  mon({ id: "lightning-magneton", name: "Magneton", dex: 82, stage: "stage1", from: "lightning-magnemite", type: "lightning", hp: 100, weak: "fighting", retreat: 1,
    attacks: [atk("Sonic Boom", "LC", 40), atk("Thunderbolt", "LLC", 80)] }),
  mon({ id: "lightning-voltorb", name: "Voltorb", dex: 100, stage: "basic", type: "lightning", hp: 60, weak: "fighting", retreat: 1,
    attacks: [atk("Tackle", "C", 10), atk("Spark", "L", 20)] }),
  mon({ id: "lightning-electrode", name: "Electrode", dex: 101, stage: "stage1", from: "lightning-voltorb", type: "lightning", hp: 90, weak: "fighting", retreat: 1,
    attacks: [atk("Electro Ball", "LC", 50), atk("Electro Blast", "LL", 70, { type: "recoil", amount: 20 }, "This Pokémon does 20 damage to itself.")] }),
  mon({ id: "lightning-electabuzz", name: "Electabuzz", dex: 125, stage: "basic", type: "lightning", hp: 70, weak: "fighting", retreat: 2,
    attacks: [atk("Thunder Punch", "LC", 40), atk("Thunderbolt", "LLC", 90, { type: "selfDiscardEnergy", amount: 1 }, "Discard 1 Lightning Energy.")] }),

  // ===== PSYCHIC =====
  mon({ id: "psychic-abra", name: "Abra", dex: 63, stage: "basic", type: "psychic", hp: 50, weak: "psychic", retreat: 0,
    attacks: [atk("Psyshock", "P", 10)] }),
  mon({ id: "psychic-kadabra", name: "Kadabra", dex: 64, stage: "stage1", from: "psychic-abra", type: "psychic", hp: 80, weak: "psychic", retreat: 1,
    attacks: [atk("Confuse Ray", "PC", 30), atk("Psybeam", "PPC", 50)] }),
  mon({ id: "psychic-alakazam", name: "Alakazam", dex: 65, stage: "stage2", from: "psychic-kadabra", type: "psychic", hp: 140, weak: "psychic", retreat: 2,
    attacks: [atk("Psychic", "PCC", 60), atk("Super Psy", "PPP", 110, { type: "selfDiscardEnergy", amount: 1 }, "Discard 1 Psychic Energy.")] }),
  mon({ id: "psychic-gastly", name: "Gastly", dex: 92, stage: "basic", type: "psychic", hp: 50, weak: "psychic", retreat: 0,
    attacks: [atk("Lick", "C", 10), atk("Night Shade", "P", 20)] }),
  mon({ id: "psychic-haunter", name: "Haunter", dex: 93, stage: "stage1", from: "psychic-gastly", type: "psychic", hp: 80, weak: "psychic", retreat: 1,
    attacks: [atk("Shadow Punch", "PC", 40)] }),
  mon({ id: "psychic-gengar", name: "Gengar", dex: 94, stage: "stage2", from: "psychic-haunter", type: "psychic", hp: 130, weak: "psychic", retreat: 1,
    attacks: [atk("Night Shade", "PC", 40), atk("Shadow Ball", "PPC", 90)] }),
  mon({ id: "psychic-drowzee", name: "Drowzee", dex: 96, stage: "basic", type: "psychic", hp: 70, weak: "psychic", retreat: 1,
    attacks: [atk("Pound", "C", 10), atk("Confusion", "PC", 30)] }),
  mon({ id: "psychic-hypno", name: "Hypno", dex: 97, stage: "stage1", from: "psychic-drowzee", type: "psychic", hp: 110, weak: "psychic", retreat: 2,
    attacks: [atk("Psybeam", "PC", 50), atk("Nightmare", "PPC", 80)] }),
];

// --- Energy ---------------------------------------------------------------

const ENERGY = [
  { id: "energy-fire", kind: "energy", name: "Fire Energy", energyType: "fire" },
  { id: "energy-water", kind: "energy", name: "Water Energy", energyType: "water" },
  { id: "energy-grass", kind: "energy", name: "Grass Energy", energyType: "grass" },
  { id: "energy-lightning", kind: "energy", name: "Lightning Energy", energyType: "lightning" },
  { id: "energy-psychic", kind: "energy", name: "Psychic Energy", energyType: "psychic" },
  { id: "energy-fighting", kind: "energy", name: "Fighting Energy", energyType: "fighting" },
];

// --- Trainers (Item / Supporter / Stadium) --------------------------------

// Authentic Pokémon art for Trainer cards: official item sprites for Items
// (pixel style), Showdown trainer character art for Supporters, and Pokémon
// artwork for Stadiums. `artStyle` tells the renderer how to fit each.
const ITEM_ART = (n) => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/${n}.png`;
const TRAINER_ART = (n) => `https://play.pokemonshowdown.com/sprites/trainers/${n}.png`;

const TRAINERS = [
  { id: "trainer-potion", kind: "item", name: "Potion", text: "Heal 30 damage from 1 of your Pokémon.", effect: { type: "heal", amount: 30 }, art: ITEM_ART("potion"), artStyle: "item" },
  { id: "trainer-super-potion", kind: "item", name: "Super Potion", text: "Heal 60 damage from 1 of your Pokémon.", effect: { type: "heal", amount: 60 }, art: ITEM_ART("super-potion"), artStyle: "item" },
  { id: "trainer-poke-ball", kind: "item", name: "Poké Ball", text: "Search your deck for a Basic Pokémon and put it into your hand.", effect: { type: "search", filter: "basic", count: 1 }, art: ITEM_ART("poke-ball"), artStyle: "item" },
  { id: "trainer-great-ball", kind: "item", name: "Great Ball", text: "Search your deck for a Pokémon and put it into your hand.", effect: { type: "search", filter: "pokemon", count: 1 }, art: ITEM_ART("great-ball"), artStyle: "item" },
  { id: "trainer-energy-search", kind: "item", name: "Energy Search", text: "Search your deck for a basic Energy and put it into your hand.", effect: { type: "search", filter: "energy", count: 1 }, art: ITEM_ART("dowsing-machine"), artStyle: "item" },
  { id: "trainer-switch", kind: "item", name: "Switch", text: "Switch your Active Pokémon with 1 of your Benched Pokémon.", effect: { type: "switchOwn" }, art: ITEM_ART("escape-rope"), artStyle: "item" },
  { id: "trainer-research", kind: "supporter", name: "Professor's Research", text: "Discard your hand and draw 7 cards.", effect: { type: "discardHandDraw", count: 7 }, art: TRAINER_ART("magnolia"), artStyle: "trainer" },
  { id: "trainer-hop", kind: "supporter", name: "Hop", text: "Draw 3 cards.", effect: { type: "draw", count: 3 }, art: TRAINER_ART("hop"), artStyle: "trainer" },
  { id: "trainer-stadium-spa", kind: "stadium", name: "Health Spa", text: "At the start of each player's turn, heal 10 damage from that player's Active Pokémon.", effect: { type: "startTurnHeal", amount: 10 }, art: ART(113), artStyle: "mon" },
  { id: "trainer-stadium-arena", kind: "stadium", name: "Battle Arena", text: "Attacks from both players' Active Pokémon do 10 more damage to the opposing Active.", effect: { type: "attackBonus", amount: 10 }, art: ART(68), artStyle: "mon" },
  { id: "trainer-ultra-ball", kind: "item", name: "Ultra Ball", text: "Search your deck for any Pokémon and put it into your hand.", effect: { type: "search", filter: "pokemon", count: 1 } },
  { id: "trainer-full-heal", kind: "item", name: "Full Heal", text: "Heal 50 damage from 1 of your Pokémon.", effect: { type: "heal", amount: 50 } },
  { id: "trainer-max-potion", kind: "item", name: "Max Potion", text: "Heal 90 damage from 1 of your Pokémon.", effect: { type: "heal", amount: 90 } },
  { id: "trainer-cynthia", kind: "supporter", name: "Cynthia", text: "Discard your hand and draw 6 cards.", effect: { type: "discardHandDraw", count: 6 } },
];

// Prefer bespoke illustrator-style artwork (scripts/generate-tcg-art.js) when a
// card has it; it fills the whole art window (artStyle "art").
for (const t of TRAINERS) {
  if (GENERATED_ART[t.id]) { t.art = GENERATED_ART[t.id]; t.artStyle = "art"; }
}

// Rarity tiers (visual treatment, like real TCG): the three deck aces are Ultra
// Rares (rainbow holo), Stage 2s are Rares (holo), Stage 1s Uncommon, Basics
// Common. Bespoke Pokémon illustrations (generate-pokemon-art.js) fill the card
// full-bleed as an "Illustration Rare"-style full art.
const ACES = new Set(["fire-charizard", "water-blastoise", "grass-venusaur", "lightning-raichu", "psychic-alakazam", "psychic-gengar"]);
for (const p of POKEMON) {
  p.rarity = ACES.has(p.id) ? "ultra"
    : p.stage === "stage2" ? "rare"
    : p.stage === "stage1" ? "uncommon" : "common";
  if (GENERATED_ART[p.id]) { p.art = GENERATED_ART[p.id]; p.genArt = true; }
}

// --- Lookup ---------------------------------------------------------------

export const ALL_CARDS = [...POKEMON, ...ENERGY, ...TRAINERS];
const BY_ID = Object.fromEntries(ALL_CARDS.map((c) => [c.id, c]));

export function cardById(id) {
  const c = BY_ID[id];
  if (!c) throw new Error(`Unknown TCG card id: ${id}`);
  return c;
}

export function isBasic(card) { return card.kind === "pokemon" && card.stage === "basic"; }
export function isPokemon(card) { return card.kind === "pokemon"; }
export function isEnergy(card) { return card.kind === "energy"; }

export { POKEMON, ENERGY, TRAINERS };
