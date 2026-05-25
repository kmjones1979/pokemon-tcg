// Pokémon evolution chains — pre-evolved → next form mapping.
//
// Hand-curated for the most iconic Gen-1 chains (kid favorites + the
// classic "watch your starter grow up" moments). Each entry maps a
// Pokédex id to the id of its next evolved form. Final forms have NO
// entry — looking them up returns null and the engine no-ops.
//
// Why static + Gen-1 only: PokeAPI's evolution-chain endpoint requires
// a multi-step lookup per species (~1300 species → ~600 chain trees)
// and the data shape covers level requirements, items, friendship, etc.
// — overkill for an in-match "your Pokémon grew up" moment. The most
// commonly-played Gen-1 chains cover 90% of the joy with zero DB work.
// Later slices can extend this map with more generations or load from
// a JSON file.

const EVOLVES_TO = {
  // Bulbasaur line
  1: 2,    // Bulbasaur → Ivysaur
  2: 3,    // Ivysaur → Venusaur
  // Charmander line
  4: 5,    // Charmander → Charmeleon
  5: 6,    // Charmeleon → Charizard
  // Squirtle line
  7: 8,    // Squirtle → Wartortle
  8: 9,    // Wartortle → Blastoise
  // Caterpie line
  10: 11,  // Caterpie → Metapod
  11: 12,  // Metapod → Butterfree
  // Weedle line
  13: 14,  // Weedle → Kakuna
  14: 15,  // Kakuna → Beedrill
  // Pidgey line
  16: 17,  // Pidgey → Pidgeotto
  17: 18,  // Pidgeotto → Pidgeot
  // Rattata
  19: 20,  // Rattata → Raticate
  // Spearow
  21: 22,  // Spearow → Fearow
  // Ekans
  23: 24,  // Ekans → Arbok
  // Pikachu — yes, kids will see Raichu (controversial but canonical)
  25: 26,  // Pikachu → Raichu
  // Sandshrew
  27: 28,  // Sandshrew → Sandslash
  // Nidoran ♀ + ♂
  29: 30,  // Nidoran♀ → Nidorina
  30: 31,  // Nidorina → Nidoqueen
  32: 33,  // Nidoran♂ → Nidorino
  33: 34,  // Nidorino → Nidoking
  // Clefairy
  35: 36,  // Clefairy → Clefable
  // Vulpix
  37: 38,  // Vulpix → Ninetales
  // Jigglypuff
  39: 40,  // Jigglypuff → Wigglytuff
  // Zubat
  41: 42,  // Zubat → Golbat
  // Oddish
  43: 44,  // Oddish → Gloom
  44: 45,  // Gloom → Vileplume
  // Paras
  46: 47,  // Paras → Parasect
  // Venonat
  48: 49,  // Venonat → Venomoth
  // Diglett
  50: 51,  // Diglett → Dugtrio
  // Meowth
  52: 53,  // Meowth → Persian
  // Psyduck
  54: 55,  // Psyduck → Golduck
  // Mankey
  56: 57,  // Mankey → Primeape
  // Growlithe
  58: 59,  // Growlithe → Arcanine
  // Poliwag
  60: 61,  // Poliwag → Poliwhirl
  61: 62,  // Poliwhirl → Poliwrath
  // Abra
  63: 64,  // Abra → Kadabra
  64: 65,  // Kadabra → Alakazam
  // Machop
  66: 67,  // Machop → Machoke
  67: 68,  // Machoke → Machamp
  // Bellsprout
  69: 70,  // Bellsprout → Weepinbell
  70: 71,  // Weepinbell → Victreebel
  // Tentacool
  72: 73,  // Tentacool → Tentacruel
  // Geodude
  74: 75,  // Geodude → Graveler
  75: 76,  // Graveler → Golem
  // Ponyta
  77: 78,  // Ponyta → Rapidash
  // Slowpoke
  79: 80,  // Slowpoke → Slowbro
  // Magnemite
  81: 82,  // Magnemite → Magneton
  // Doduo
  84: 85,  // Doduo → Dodrio
  // Seel
  86: 87,  // Seel → Dewgong
  // Grimer
  88: 89,  // Grimer → Muk
  // Shellder
  90: 91,  // Shellder → Cloyster
  // Gastly
  92: 93,  // Gastly → Haunter
  93: 94,  // Haunter → Gengar
  // Drowzee
  96: 97,  // Drowzee → Hypno
  // Krabby
  98: 99,  // Krabby → Kingler
  // Voltorb
  100: 101, // Voltorb → Electrode
  // Exeggcute
  102: 103, // Exeggcute → Exeggutor
  // Cubone
  104: 105, // Cubone → Marowak
  // Koffing
  109: 110, // Koffing → Weezing
  // Rhyhorn
  111: 112, // Rhyhorn → Rhydon
  // Horsea
  116: 117, // Horsea → Seadra
  // Goldeen
  118: 119, // Goldeen → Seaking
  // Staryu
  120: 121, // Staryu → Starmie
  // Magikarp → Gyarados (the iconic underdog)
  129: 130, // Magikarp → Gyarados
  // Eevee — pick Vaporeon as the default chain destination.
  // (Multi-evolutions need extra UI; one is plenty for the MVP.)
  133: 134, // Eevee → Vaporeon
  // Omanyte
  138: 139, // Omanyte → Omastar
  // Kabuto
  140: 141, // Kabuto → Kabutops
  // Dratini line — the dragon dream
  147: 148, // Dratini → Dragonair
  148: 149, // Dragonair → Dragonite
};

// Threshold: how many enemy KOs an instance needs before it
// auto-evolves. 2 is the sweet spot — frequent enough that kids see
// the moment regularly, rare enough that it feels like an
// accomplishment.
const EVOLUTION_KO_THRESHOLD = 2;

function evolutionFor(pokemonId) {
  return EVOLVES_TO[pokemonId] || null;
}

function hasEvolution(card) {
  return !!evolutionFor(card?.id);
}

// All ids that appear as a "from" in the chain — useful for tests
// (e.g. confirming the table doesn't reference a missing pokémon).
function evolvingFromIds() {
  return Object.keys(EVOLVES_TO).map(Number);
}

// All ids that appear as a "to" in the chain — i.e. forms that are
// reachable via evolution. Useful for tests.
function evolvingToIds() {
  return Object.values(EVOLVES_TO);
}

module.exports = {
  EVOLVES_TO,
  EVOLUTION_KO_THRESHOLD,
  evolutionFor,
  hasEvolution,
  evolvingFromIds,
  evolvingToIds,
};
