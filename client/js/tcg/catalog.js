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
const TYPE_LETTER = { F: "fire", W: "water", G: "grass", L: "lightning", P: "psychic", T: "fighting", C: "colorless", D: "darkness", M: "metal" };
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
    attacks: [atk("Fire Fang", "FC", 50, { type: "applyStatusCoin", kind: "burn" }, "Flip a coin. If heads, the Defending Pokémon is now Burned."), atk("Heat Tackle", "FFC", 100, { type: "recoil", amount: 20 }, "This Pokémon does 20 damage to itself.")] }),
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
    attacks: [atk("Poison Powder", "G", 10, { type: "applyStatus", kind: "poison" }, "The Defending Pokémon is now Poisoned."), atk("Razor Leaf", "GC", 30)] }),
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
    attacks: [atk("Quick Attack", "C", 10, { type: "coinFlipBonus", damage: 10 }, "Flip a coin. If heads, +10 damage."), atk("Thunder Shock", "L", 20, { type: "applyStatusCoin", kind: "paralyze" }, "Flip a coin. If heads, the Defending Pokémon is now Paralyzed.")] }),
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
    attacks: [atk("Confuse Ray", "PC", 30, { type: "applyStatus", kind: "confuse" }, "The Defending Pokémon is now Confused."), atk("Psybeam", "PPC", 50)] }),
  mon({ id: "psychic-alakazam", name: "Alakazam", dex: 65, stage: "stage2", from: "psychic-kadabra", type: "psychic", hp: 140, weak: "psychic", retreat: 2,
    attacks: [atk("Psychic", "PCC", 60), atk("Super Psy", "PPP", 110, { type: "selfDiscardEnergy", amount: 1 }, "Discard 1 Psychic Energy.")] }),
  mon({ id: "psychic-gastly", name: "Gastly", dex: 92, stage: "basic", type: "psychic", hp: 50, weak: "psychic", retreat: 0,
    attacks: [atk("Lick", "C", 10), atk("Night Shade", "P", 20)] }),
  mon({ id: "psychic-haunter", name: "Haunter", dex: 93, stage: "stage1", from: "psychic-gastly", type: "psychic", hp: 80, weak: "psychic", retreat: 1,
    attacks: [atk("Shadow Punch", "PC", 40)] }),
  mon({ id: "psychic-gengar", name: "Gengar", dex: 94, stage: "stage2", from: "psychic-haunter", type: "psychic", hp: 130, weak: "psychic", retreat: 1,
    attacks: [atk("Hypnosis", "P", 10, { type: "applyStatus", kind: "sleep" }, "The Defending Pokémon is now Asleep."), atk("Shadow Ball", "PPC", 90)] }),
  mon({ id: "psychic-drowzee", name: "Drowzee", dex: 96, stage: "basic", type: "psychic", hp: 70, weak: "psychic", retreat: 1,
    attacks: [atk("Pound", "C", 10), atk("Confusion", "PC", 30, { type: "applyStatusCoin", kind: "confuse" }, "Flip a coin. If heads, the Defending Pokémon is now Confused.")] }),
  mon({ id: "psychic-hypno", name: "Hypno", dex: 97, stage: "stage1", from: "psychic-drowzee", type: "psychic", hp: 110, weak: "psychic", retreat: 2,
    attacks: [atk("Psybeam", "PC", 50), atk("Nightmare", "PPC", 80, { type: "applyStatus", kind: "sleep" }, "The Defending Pokémon is now Asleep.")] }),

  // ===== FIGHTING =====
  mon({ id: "fighting-machop", name: "Machop", dex: 66, stage: "basic", type: "fighting", hp: 70, weak: "psychic", retreat: 1,
    attacks: [atk("Low Kick", "T", 20), atk("Karate Chop", "TC", 40)] }),
  mon({ id: "fighting-machoke", name: "Machoke", dex: 67, stage: "stage1", from: "fighting-machop", type: "fighting", hp: 100, weak: "psychic", retreat: 2,
    attacks: [atk("Submission", "TTC", 60, { type: "recoil", amount: 20 }, "This Pokémon does 20 damage to itself.")] }),
  mon({ id: "fighting-machamp", name: "Machamp", dex: 68, stage: "stage2", from: "fighting-machoke", type: "fighting", hp: 160, weak: "psychic", retreat: 3,
    attacks: [atk("Cross Chop", "TTC", 80), atk("Seismic Toss", "TTCC", 120, { type: "recoil", amount: 20 }, "This Pokémon does 20 damage to itself.")] }),
  mon({ id: "fighting-geodude", name: "Geodude", dex: 74, stage: "basic", type: "fighting", hp: 70, weak: "psychic", retreat: 1,
    attacks: [atk("Tackle", "C", 10), atk("Rock Throw", "TC", 30)] }),
  mon({ id: "fighting-graveler", name: "Graveler", dex: 75, stage: "stage1", from: "fighting-geodude", type: "fighting", hp: 100, weak: "psychic", retreat: 3,
    attacks: [atk("Rock Slide", "TC", 40), atk("Rollout", "TTC", 70)] }),
  mon({ id: "fighting-golem", name: "Golem", dex: 76, stage: "stage2", from: "fighting-graveler", type: "fighting", hp: 150, weak: "psychic", retreat: 4,
    attacks: [atk("Mega Punch", "TCC", 60), atk("Earthquake", "TTCC", 110, { type: "recoil", amount: 20 }, "This Pokémon does 20 damage to itself.")] }),
  mon({ id: "fighting-mankey", name: "Mankey", dex: 56, stage: "basic", type: "fighting", hp: 60, weak: "psychic", retreat: 1,
    attacks: [atk("Scratch", "C", 10), atk("Low Kick", "T", 20)] }),
  mon({ id: "fighting-primeape", name: "Primeape", dex: 57, stage: "stage1", from: "fighting-mankey", type: "fighting", hp: 100, weak: "psychic", retreat: 1,
    attacks: [atk("Rage", "TC", 40), atk("Thrash", "TTC", 70, { type: "coinFlipBonus", damage: 20 }, "Flip a coin. If heads, +20 damage.")] }),

  // ===== EXPANSION: more Fire =====
  mon({ id: "fire-magmar", name: "Magmar", dex: 126, stage: "basic", type: "fire", hp: 70, weak: "water", retreat: 2,
    attacks: [atk("Fire Punch", "FC", 30), atk("Smokescreen", "FFC", 60, { type: "applyStatusCoin", kind: "burn" }, "Flip a coin. If heads, the Defending Pokémon is now Burned.")] }),
  mon({ id: "fire-flareon", name: "Flareon", dex: 136, stage: "stage1", from: "colorless-eevee", type: "fire", hp: 110, weak: "water", retreat: 1,
    attacks: [atk("Flame Tail", "FC", 40), atk("Firestorm", "FFC", 90, { type: "selfDiscardEnergy", amount: 1 }, "Discard 1 Fire Energy.")] }),

  // ===== EXPANSION: more Water =====
  mon({ id: "water-poliwag", name: "Poliwag", dex: 60, stage: "basic", type: "water", hp: 50, weak: "lightning", retreat: 1,
    attacks: [atk("Bubble", "W", 10, { type: "applyStatusCoin", kind: "paralyze" }, "Flip a coin. If heads, the Defending Pokémon is now Paralyzed.")] }),
  mon({ id: "water-poliwhirl", name: "Poliwhirl", dex: 61, stage: "stage1", from: "water-poliwag", type: "water", hp: 90, weak: "lightning", retreat: 1,
    attacks: [atk("Doubleslap", "WC", 30, { type: "coinFlipBonus", damage: 10 }, "Flip a coin. If heads, +10 damage."), atk("Water Gun", "WWC", 50)] }),
  mon({ id: "water-poliwrath", name: "Poliwrath", dex: 62, stage: "stage2", from: "water-poliwhirl", type: "water", hp: 150, weak: "lightning", retreat: 3,
    attacks: [atk("Dynamic Punch", "WCC", 60), atk("Whirlpool", "WWCC", 100, { type: "selfDiscardEnergy", amount: 1 }, "Discard 1 Water Energy.")] }),
  mon({ id: "water-seel", name: "Seel", dex: 86, stage: "basic", type: "water", hp: 70, weak: "lightning", retreat: 1,
    attacks: [atk("Headbutt", "WC", 20)] }),
  mon({ id: "water-dewgong", name: "Dewgong", dex: 87, stage: "stage1", from: "water-seel", type: "water", hp: 110, weak: "lightning", retreat: 2,
    attacks: [atk("Aurora Beam", "WC", 40), atk("Ice Beam", "WWC", 70, { type: "applyStatusCoin", kind: "paralyze" }, "Flip a coin. If heads, the Defending Pokémon is now Paralyzed.")] }),
  mon({ id: "water-vaporeon", name: "Vaporeon", dex: 134, stage: "stage1", from: "colorless-eevee", type: "water", hp: 110, weak: "lightning", retreat: 1,
    attacks: [atk("Aqua Jet", "WC", 40), atk("Hydro Pump", "WWC", 60, { type: "plusPerEnergy", per: 20, energyType: "water", ignore: 2 }, "+20 for each extra Water Energy attached.")] }),
  mon({ id: "water-lapras", name: "Lapras", dex: 131, stage: "basic", type: "water", hp: 130, weak: "lightning", retreat: 3,
    attacks: [atk("Water Gun", "WC", 30), atk("Blizzard", "WWCC", 100, { type: "applyStatusCoin", kind: "paralyze" }, "Flip a coin. If heads, the Defending Pokémon is now Paralyzed.")] }),

  // ===== EXPANSION: more Grass =====
  mon({ id: "grass-exeggcute", name: "Exeggcute", dex: 102, stage: "basic", type: "grass", hp: 50, weak: "fire", retreat: 1,
    attacks: [atk("Hypnosis", "P", 10, { type: "applyStatus", kind: "sleep" }, "The Defending Pokémon is now Asleep.")] }),
  mon({ id: "grass-exeggutor", name: "Exeggutor", dex: 103, stage: "stage1", from: "grass-exeggcute", type: "grass", hp: 130, weak: "fire", retreat: 3,
    attacks: [atk("Stomp", "GCC", 40, { type: "coinFlipBonus", damage: 20 }, "Flip a coin. If heads, +20 damage."), atk("Egg Bomb", "GGCC", 90)] }),
  mon({ id: "grass-tangela", name: "Tangela", dex: 114, stage: "basic", type: "grass", hp: 80, weak: "fire", retreat: 2,
    attacks: [atk("Bind", "GC", 20, { type: "applyStatusCoin", kind: "paralyze" }, "Flip a coin. If heads, the Defending Pokémon is now Paralyzed."), atk("Vine Whip", "GGC", 50)] }),
  mon({ id: "grass-scyther", name: "Scyther", dex: 123, stage: "basic", type: "grass", hp: 90, weak: "fire", retreat: 0,
    attacks: [atk("Quick Slash", "GC", 30), atk("Slash", "GCC", 60)] }),

  // ===== EXPANSION: more Lightning =====
  mon({ id: "lightning-jolteon", name: "Jolteon", dex: 135, stage: "stage1", from: "colorless-eevee", type: "lightning", hp: 100, weak: "fighting", retreat: 0,
    attacks: [atk("Pin Missile", "LC", 20, { type: "coinFlipBonus", damage: 20 }, "Flip a coin. If heads, +20 damage."), atk("Thunder", "LLC", 90, { type: "selfDiscardEnergy", amount: 1 }, "Discard 1 Lightning Energy.")] }),
  mon({ id: "lightning-zapdos", name: "Zapdos", dex: 145, stage: "basic", type: "lightning", hp: 130, weak: "fighting", retreat: 2,
    attacks: [atk("Thunder Spear", "LL", 50), atk("Thunderstorm", "LLLC", 120, { type: "recoil", amount: 30 }, "This Pokémon does 30 damage to itself.")] }),

  // ===== EXPANSION: more Psychic =====
  mon({ id: "psychic-slowpoke", name: "Slowpoke", dex: 79, stage: "basic", type: "psychic", hp: 70, weak: "psychic", retreat: 1,
    attacks: [atk("Yawn", "C", 0, { type: "applyStatus", kind: "sleep" }, "The Defending Pokémon is now Asleep."), atk("Headbutt", "PC", 30)] }),
  mon({ id: "psychic-slowbro", name: "Slowbro", dex: 80, stage: "stage1", from: "psychic-slowpoke", type: "psychic", hp: 120, weak: "psychic", retreat: 2,
    attacks: [atk("Psyshock", "PC", 40), atk("Psychic", "PPC", 70)] }),
  mon({ id: "psychic-jynx", name: "Jynx", dex: 124, stage: "basic", type: "psychic", hp: 80, weak: "psychic", retreat: 1,
    attacks: [atk("Lovely Kiss", "P", 10, { type: "applyStatusCoin", kind: "sleep" }, "Flip a coin. If heads, the Defending Pokémon is now Asleep."), atk("Psywave", "PPC", 50)] }),
  mon({ id: "psychic-mrmime", name: "Mr. Mime", dex: 122, stage: "basic", type: "psychic", hp: 70, weak: "psychic", retreat: 1,
    attacks: [atk("Confuse Ray", "PC", 20, { type: "applyStatus", kind: "confuse" }, "The Defending Pokémon is now Confused."), atk("Psybeam", "PPC", 50)] }),
  mon({ id: "psychic-mewtwo", name: "Mewtwo", dex: 150, stage: "basic", type: "psychic", hp: 140, weak: "psychic", retreat: 2,
    attacks: [atk("Psychic", "PCC", 50, { type: "plusPerEnergy", per: 10, energyType: "psychic", ignore: 3 }, "+10 for each extra Psychic Energy attached."), atk("Psyburn", "PPPC", 120, { type: "selfDiscardEnergy", amount: 2 }, "Discard 2 Energy attached to this Pokémon.")] }),

  // ===== EXPANSION: more Fighting =====
  mon({ id: "fighting-hitmonlee", name: "Hitmonlee", dex: 106, stage: "basic", type: "fighting", hp: 90, weak: "psychic", retreat: 2,
    attacks: [atk("Low Kick", "TC", 30), atk("High Jump Kick", "TTC", 80)] }),
  mon({ id: "fighting-hitmonchan", name: "Hitmonchan", dex: 107, stage: "basic", type: "fighting", hp: 90, weak: "psychic", retreat: 2,
    attacks: [atk("Jab", "TC", 30), atk("Special Punch", "TTC", 70)] }),
  mon({ id: "fighting-onix", name: "Onix", dex: 95, stage: "basic", type: "fighting", hp: 110, weak: "grass", retreat: 3,
    attacks: [atk("Rock Throw", "TC", 20), atk("Harden", "TT", 0, { type: "healSelf", amount: 20 }, "Heal 20 damage from this Pokémon.")] }),
  mon({ id: "fighting-cubone", name: "Cubone", dex: 104, stage: "basic", type: "fighting", hp: 60, weak: "grass", retreat: 1,
    attacks: [atk("Bonemerang", "TC", 30, { type: "coinFlipBonus", damage: 20 }, "Flip a coin. If heads, +20 damage.")] }),
  mon({ id: "fighting-marowak", name: "Marowak", dex: 105, stage: "stage1", from: "fighting-cubone", type: "fighting", hp: 100, weak: "grass", retreat: 1,
    attacks: [atk("Bone Club", "TC", 40), atk("Bonemerang", "TTC", 80, { type: "coinFlipBonus", damage: 20 }, "Flip a coin. If heads, +20 damage.")] }),
  mon({ id: "fighting-rhyhorn", name: "Rhyhorn", dex: 111, stage: "basic", type: "fighting", hp: 90, weak: "grass", retreat: 2,
    attacks: [atk("Horn Attack", "TC", 30), atk("Stomp", "TTC", 50, { type: "coinFlipBonus", damage: 10 }, "Flip a coin. If heads, +10 damage.")] }),
  mon({ id: "fighting-rhydon", name: "Rhydon", dex: 112, stage: "stage1", from: "fighting-rhyhorn", type: "fighting", hp: 140, weak: "grass", retreat: 3,
    attacks: [atk("Horn Drill", "TCC", 60), atk("Earthquake", "TTCC", 100, { type: "recoil", amount: 20 }, "This Pokémon does 20 damage to itself.")] }),

  // ===== EXPANSION: more Colorless =====
  mon({ id: "colorless-rattata", name: "Rattata", dex: 19, stage: "basic", type: "colorless", hp: 40, weak: "fighting", retreat: 0,
    attacks: [atk("Bite", "C", 10), atk("Quick Attack", "CC", 20, { type: "coinFlipBonus", damage: 10 }, "Flip a coin. If heads, +10 damage.")] }),
  mon({ id: "colorless-raticate", name: "Raticate", dex: 20, stage: "stage1", from: "colorless-rattata", type: "colorless", hp: 80, weak: "fighting", retreat: 1,
    attacks: [atk("Super Fang", "CC", 40), atk("Hyper Fang", "CCC", 60, { type: "coinFlipBonus", damage: 20 }, "Flip a coin. If heads, +20 damage.")] }),
  mon({ id: "colorless-meowth", name: "Meowth", dex: 52, stage: "basic", type: "colorless", hp: 60, weak: "fighting", retreat: 1,
    attacks: [atk("Scratch", "C", 10), atk("Pay Day", "CC", 20, { type: "draw", count: 1 }, "Draw a card.")] }),
  mon({ id: "colorless-persian", name: "Persian", dex: 53, stage: "stage1", from: "colorless-meowth", type: "colorless", hp: 90, weak: "fighting", retreat: 0,
    attacks: [atk("Slash", "CC", 40), atk("Fury Swipes", "CCC", 60, { type: "coinFlipBonus", damage: 20 }, "Flip a coin. If heads, +20 damage.")] }),
  mon({ id: "colorless-jigglypuff", name: "Jigglypuff", dex: 39, stage: "basic", type: "colorless", hp: 60, weak: "fighting", retreat: 1,
    attacks: [atk("Sing", "C", 0, { type: "applyStatusCoin", kind: "sleep" }, "Flip a coin. If heads, the Defending Pokémon is now Asleep."), atk("Pound", "CC", 20)] }),
  mon({ id: "colorless-wigglytuff", name: "Wigglytuff", dex: 40, stage: "stage1", from: "colorless-jigglypuff", type: "colorless", hp: 110, weak: "fighting", retreat: 2,
    attacks: [atk("Double Slap", "CC", 30, { type: "coinFlipBonus", damage: 10 }, "Flip a coin. If heads, +10 damage."), atk("Do the Wave", "CCC", 70)] }),
  mon({ id: "colorless-dratini", name: "Dratini", dex: 147, stage: "basic", type: "colorless", hp: 60, weak: "fighting", retreat: 1,
    attacks: [atk("Wrap", "C", 10, { type: "applyStatusCoin", kind: "paralyze" }, "Flip a coin. If heads, the Defending Pokémon is now Paralyzed.")] }),
  mon({ id: "colorless-dragonair", name: "Dragonair", dex: 148, stage: "stage1", from: "colorless-dratini", type: "colorless", hp: 100, weak: "fighting", retreat: 2,
    attacks: [atk("Slam", "CC", 30, { type: "coinFlipBonus", damage: 20 }, "Flip a coin. If heads, +20 damage."), atk("Hyper Beam", "CCC", 50)] }),
  mon({ id: "colorless-dragonite", name: "Dragonite", dex: 149, stage: "stage2", from: "colorless-dragonair", type: "colorless", hp: 160, weak: "fighting", retreat: 2,
    attacks: [atk("Wing Attack", "CCC", 50), atk("Hyper Beam", "CCCC", 110, { type: "selfDiscardEnergy", amount: 1 }, "Discard 1 Energy attached to this Pokémon.")] }),
  mon({ id: "colorless-snorlax", name: "Snorlax", dex: 143, stage: "basic", type: "colorless", hp: 150, weak: "fighting", retreat: 4,
    attacks: [atk("Body Slam", "CCC", 40, { type: "applyStatusCoin", kind: "paralyze" }, "Flip a coin. If heads, the Defending Pokémon is now Paralyzed."), atk("Heavy Impact", "CCCC", 100)] }),
  mon({ id: "colorless-tauros", name: "Tauros", dex: 128, stage: "basic", type: "colorless", hp: 90, weak: "fighting", retreat: 1,
    attacks: [atk("Rampage", "CC", 20, { type: "coinFlipBonus", damage: 20 }, "Flip a coin. If heads, +20 damage."), atk("Take Down", "CCC", 60, { type: "recoil", amount: 20 }, "This Pokémon does 20 damage to itself.")] }),

  // ===== DARKNESS =====
  mon({ id: "darkness-houndour", name: "Houndour", dex: 228, stage: "basic", type: "darkness", hp: 60, weak: "fighting", retreat: 1,
    attacks: [atk("Bite", "C", 10), atk("Ember", "DC", 30, { type: "applyStatusCoin", kind: "burn" }, "Flip a coin. If heads, the Defending Pokémon is now Burned.")] }),
  mon({ id: "darkness-houndoom", name: "Houndoom", dex: 229, stage: "stage1", from: "darkness-houndour", type: "darkness", hp: 110, weak: "fighting", retreat: 1,
    attacks: [atk("Fire Fang", "DC", 40, { type: "applyStatusCoin", kind: "burn" }, "Flip a coin. If heads, the Defending Pokémon is now Burned."), atk("Dark Flame", "DDC", 90, { type: "selfDiscardEnergy", amount: 1 }, "Discard 1 Darkness Energy.")] }),
  mon({ id: "darkness-sneasel", name: "Sneasel", dex: 215, stage: "basic", type: "darkness", hp: 70, weak: "fighting", retreat: 1,
    attacks: [atk("Scratch", "C", 10), atk("Slash", "DC", 30, { type: "coinFlipBonus", damage: 20 }, "Flip a coin. If heads, +20 damage.")] }),
  mon({ id: "darkness-murkrow", name: "Murkrow", dex: 198, stage: "basic", type: "darkness", hp: 60, weak: "lightning", retreat: 0,
    attacks: [atk("Peck", "C", 10), atk("Mean Look", "DC", 20, { type: "draw", count: 1 }, "Draw a card.")] }),
  mon({ id: "darkness-zubat", name: "Zubat", dex: 41, stage: "basic", type: "darkness", hp: 40, weak: "lightning", retreat: 0,
    attacks: [atk("Leech Life", "D", 10, { type: "healSelf", amount: 10 }, "Heal 10 damage from this Pokémon.")] }),
  mon({ id: "darkness-golbat", name: "Golbat", dex: 42, stage: "stage1", from: "darkness-zubat", type: "darkness", hp: 90, weak: "lightning", retreat: 1,
    attacks: [atk("Wing Attack", "DC", 30), atk("Poison Fang", "DDC", 60, { type: "applyStatus", kind: "poison" }, "The Defending Pokémon is now Poisoned.")] }),
  mon({ id: "darkness-ekans", name: "Ekans", dex: 23, stage: "basic", type: "darkness", hp: 50, weak: "fighting", retreat: 1,
    attacks: [atk("Spit Poison", "D", 10, { type: "applyStatusCoin", kind: "poison" }, "Flip a coin. If heads, the Defending Pokémon is now Poisoned.")] }),
  mon({ id: "darkness-arbok", name: "Arbok", dex: 24, stage: "stage1", from: "darkness-ekans", type: "darkness", hp: 110, weak: "fighting", retreat: 2,
    attacks: [atk("Bite", "DC", 40), atk("Toxic Fang", "DDC", 70, { type: "applyStatus", kind: "poison" }, "The Defending Pokémon is now Poisoned.")] }),
  mon({ id: "darkness-umbreon", name: "Umbreon", dex: 197, stage: "stage1", from: "colorless-eevee", type: "darkness", hp: 110, weak: "fighting", retreat: 1,
    attacks: [atk("Confuse Ray", "DC", 30, { type: "applyStatus", kind: "confuse" }, "The Defending Pokémon is now Confused."), atk("Moonlight Blast", "DDC", 80)] }),

  // ===== METAL =====
  mon({ id: "metal-onix-steelix", name: "Steelix", dex: 208, stage: "stage1", from: "fighting-onix", type: "metal", hp: 150, weak: "fire", retreat: 4,
    attacks: [atk("Iron Tail", "MC", 40, { type: "coinFlipBonus", damage: 30 }, "Flip a coin. If heads, +30 damage."), atk("Earthquake", "MMCC", 100, { type: "recoil", amount: 10 }, "This Pokémon does 10 damage to itself.")] }),
  mon({ id: "metal-scyther-scizor", name: "Scizor", dex: 212, stage: "stage1", from: "grass-scyther", type: "metal", hp: 120, weak: "fire", retreat: 1,
    attacks: [atk("Metal Claw", "MC", 40), atk("Steel Wing", "MMC", 70)] }),
  mon({ id: "metal-skarmory", name: "Skarmory", dex: 227, stage: "basic", type: "metal", hp: 90, weak: "fire", retreat: 1,
    attacks: [atk("Steel Wing", "MC", 30), atk("Sky Attack", "MMC", 70, { type: "coinFlipBonus", damage: 20 }, "Flip a coin. If heads, +20 damage.")] }),
  mon({ id: "metal-pineco", name: "Pineco", dex: 204, stage: "basic", type: "metal", hp: 60, weak: "fire", retreat: 2,
    attacks: [atk("Tackle", "C", 10), atk("Rollout", "MC", 20)] }),
  mon({ id: "metal-forretress", name: "Forretress", dex: 205, stage: "stage1", from: "metal-pineco", type: "metal", hp: 120, weak: "fire", retreat: 3,
    attacks: [atk("Gyro Ball", "MC", 40), atk("Heavy Bomber", "MMC", 80, { type: "recoil", amount: 10 }, "This Pokémon does 10 damage to itself.")] }),
  mon({ id: "metal-beldum", name: "Beldum", dex: 374, stage: "basic", type: "metal", hp: 60, weak: "fire", retreat: 1,
    attacks: [atk("Take Down", "MC", 30, { type: "recoil", amount: 10 }, "This Pokémon does 10 damage to itself.")] }),

  // ===== More WATER =====
  mon({ id: "water-horsea", name: "Horsea", dex: 116, stage: "basic", type: "water", hp: 50, weak: "lightning", retreat: 1,
    attacks: [atk("Smokescreen", "W", 10), atk("Water Gun", "WC", 20)] }),
  mon({ id: "water-seadra", name: "Seadra", dex: 117, stage: "stage1", from: "water-horsea", type: "water", hp: 90, weak: "lightning", retreat: 1,
    attacks: [atk("Waterfall", "WC", 40), atk("Agility", "WWC", 60, { type: "coinFlipBonus", damage: 10 }, "Flip a coin. If heads, +10 damage.")] }),
  mon({ id: "water-shellder", name: "Shellder", dex: 90, stage: "basic", type: "water", hp: 60, weak: "lightning", retreat: 1,
    attacks: [atk("Supersonic", "W", 10, { type: "applyStatusCoin", kind: "confuse" }, "Flip a coin. If heads, the Defending Pokémon is now Confused.")] }),
  mon({ id: "water-cloyster", name: "Cloyster", dex: 91, stage: "stage1", from: "water-shellder", type: "water", hp: 120, weak: "lightning", retreat: 2,
    attacks: [atk("Spike Cannon", "WC", 40, { type: "coinFlipBonus", damage: 20 }, "Flip a coin. If heads, +20 damage."), atk("Hydro Pump", "WWC", 60, { type: "plusPerEnergy", per: 20, energyType: "water", ignore: 2 }, "+20 for each extra Water Energy attached.")] }),
  mon({ id: "water-krabby", name: "Krabby", dex: 98, stage: "basic", type: "water", hp: 50, weak: "lightning", retreat: 1,
    attacks: [atk("Vice Grip", "WC", 20)] }),
  mon({ id: "water-kingler", name: "Kingler", dex: 99, stage: "stage1", from: "water-krabby", type: "water", hp: 110, weak: "lightning", retreat: 2,
    attacks: [atk("Crabhammer", "WC", 40), atk("Guillotine", "WWCC", 90)] }),
  mon({ id: "water-tentacool", name: "Tentacool", dex: 72, stage: "basic", type: "water", hp: 50, weak: "lightning", retreat: 1,
    attacks: [atk("Poison Sting", "W", 10, { type: "applyStatusCoin", kind: "poison" }, "Flip a coin. If heads, the Defending Pokémon is now Poisoned.")] }),
  mon({ id: "water-tentacruel", name: "Tentacruel", dex: 73, stage: "stage1", from: "water-tentacool", type: "water", hp: 100, weak: "lightning", retreat: 1,
    attacks: [atk("Tentacle Whip", "WC", 30), atk("Poison Ray", "WWC", 60, { type: "applyStatus", kind: "poison" }, "The Defending Pokémon is now Poisoned.")] }),

  // ===== More FIRE / GRASS / PSYCHIC / COLORLESS =====
  mon({ id: "fire-moltres", name: "Moltres", dex: 146, stage: "basic", type: "fire", hp: 130, weak: "water", retreat: 2,
    attacks: [atk("Wing Attack", "FC", 40), atk("Sky Fire", "FFCC", 120, { type: "selfDiscardEnergy", amount: 2 }, "Discard 2 Fire Energy.")] }),
  mon({ id: "grass-pinsir", name: "Pinsir", dex: 127, stage: "basic", type: "grass", hp: 90, weak: "fire", retreat: 1,
    attacks: [atk("Vice Grip", "GC", 30), atk("Guillotine", "GGC", 70, { type: "coinFlipBonus", damage: 20 }, "Flip a coin. If heads, +20 damage.")] }),
  mon({ id: "grass-paras", name: "Paras", dex: 46, stage: "basic", type: "grass", hp: 50, weak: "fire", retreat: 1,
    attacks: [atk("Spore", "G", 0, { type: "applyStatusCoin", kind: "sleep" }, "Flip a coin. If heads, the Defending Pokémon is now Asleep.")] }),
  mon({ id: "grass-parasect", name: "Parasect", dex: 47, stage: "stage1", from: "grass-paras", type: "grass", hp: 100, weak: "fire", retreat: 2,
    attacks: [atk("Slash", "GC", 30), atk("Spore Cloud", "GGC", 60, { type: "applyStatus", kind: "poison" }, "The Defending Pokémon is now Poisoned.")] }),
  mon({ id: "psychic-mew", name: "Mew", dex: 151, stage: "basic", type: "psychic", hp: 90, weak: "psychic", retreat: 1,
    attacks: [atk("Psywave", "P", 20), atk("Psyburst", "PPC", 70, { type: "coinFlipBonus", damage: 30 }, "Flip a coin. If heads, +30 damage.")] }),
  mon({ id: "colorless-kangaskhan", name: "Kangaskhan", dex: 115, stage: "basic", type: "colorless", hp: 120, weak: "fighting", retreat: 3,
    attacks: [atk("Fetch", "C", 0, { type: "draw", count: 2 }, "Draw 2 cards."), atk("Mega Punch", "CCC", 60)] }),
  mon({ id: "fighting-aerodactyl", name: "Aerodactyl", dex: 142, stage: "basic", type: "fighting", hp: 100, weak: "grass", retreat: 0,
    attacks: [atk("Wing Attack", "TC", 30), atk("Rock Slide", "TTC", 70)] }),
  mon({ id: "colorless-clefairy", name: "Clefairy", dex: 35, stage: "basic", type: "colorless", hp: 60, weak: "fighting", retreat: 1,
    attacks: [atk("Sing", "C", 0, { type: "applyStatusCoin", kind: "sleep" }, "Flip a coin. If heads, the Defending Pokémon is now Asleep."), atk("Metronome", "CC", 30)] }),
  mon({ id: "colorless-clefable", name: "Clefable", dex: 36, stage: "stage1", from: "colorless-clefairy", type: "colorless", hp: 100, weak: "fighting", retreat: 1,
    attacks: [atk("Moonlight", "CC", 0, { type: "healSelf", amount: 40 }, "Heal 40 damage from this Pokémon."), atk("Comet Punch", "CCC", 60, { type: "coinFlipBonus", damage: 20 }, "Flip a coin. If heads, +20 damage.")] }),
  mon({ id: "colorless-chansey", name: "Chansey", dex: 113, stage: "basic", type: "colorless", hp: 130, weak: "fighting", retreat: 1,
    attacks: [atk("Soft-Boiled", "CC", 0, { type: "healSelf", amount: 40 }, "Heal 40 damage from this Pokémon."), atk("Double-edge", "CCCC", 90, { type: "recoil", amount: 20 }, "This Pokémon does 20 damage to itself.")] }),

  // ===== MEGA EVOLUTION EX — premium chase cards. Give up 2 Prizes when KO'd. =====
  mon({ id: "mega-charizard-ex", name: "Mega Charizard EX", dex: 10034, stage: "mega", from: "fire-charizard", type: "fire", hp: 240, weak: "water", retreat: 3, ex: true, mega: true, prizeValue: 2,
    attacks: [atk("Wing Blade", "FFC", 100), atk("Crimson Storm", "FFFCC", 200, { type: "selfDiscardEnergy", amount: 3 }, "Discard 3 Fire Energy.")] }),
  mon({ id: "mega-blastoise-ex", name: "Mega Blastoise EX", dex: 10036, stage: "mega", from: "water-blastoise", type: "water", hp: 230, weak: "lightning", retreat: 4, ex: true, mega: true, prizeValue: 2,
    attacks: [atk("Deluge Cannon", "WWC", 100), atk("Hydro Bombard", "WWWCC", 180, { type: "selfDiscardEnergy", amount: 2 }, "Discard 2 Water Energy.")] }),
  mon({ id: "mega-venusaur-ex", name: "Mega Venusaur EX", dex: 10033, stage: "mega", from: "grass-venusaur", type: "grass", hp: 240, weak: "fire", retreat: 4, ex: true, mega: true, prizeValue: 2,
    attacks: [atk("Vine Crush", "GGC", 90), atk("Crisis Bloom", "GGGCC", 170, { type: "healSelf", amount: 60 }, "Heal 60 damage from this Pokémon.")] }),
  mon({ id: "mega-gengar-ex", name: "Mega Gengar EX", dex: 10038, stage: "mega", from: "psychic-gengar", type: "psychic", hp: 220, weak: "psychic", retreat: 1, ex: true, mega: true, prizeValue: 2,
    attacks: [atk("Shadow Sneak", "PC", 60), atk("Void Ball", "PPPC", 170, { type: "applyStatus", kind: "sleep" }, "The Defending Pokémon is now Asleep.")] }),
  mon({ id: "mega-alakazam-ex", name: "Mega Alakazam EX", dex: 10037, stage: "mega", from: "psychic-alakazam", type: "psychic", hp: 220, weak: "psychic", retreat: 2, ex: true, mega: true, prizeValue: 2,
    attacks: [atk("Mind Shatter", "PPC", 90), atk("Psychic Nova", "PPPP", 190, { type: "selfDiscardEnergy", amount: 2 }, "Discard 2 Psychic Energy.")] }),
  mon({ id: "mega-gyarados-ex", name: "Mega Gyarados EX", dex: 10041, stage: "mega", from: "water-gyarados", type: "water", hp: 230, weak: "lightning", retreat: 3, ex: true, mega: true, prizeValue: 2,
    attacks: [atk("Aqua Fang", "WWC", 90), atk("Tidal Wrath", "WWWCC", 180, { type: "coinFlipBonus", damage: 40 }, "Flip a coin. If heads, +40 damage.")] }),
  mon({ id: "mega-mewtwo-ex", name: "Mega Mewtwo EX", dex: 10043, stage: "mega", from: "psychic-mewtwo", type: "psychic", hp: 230, weak: "psychic", retreat: 2, ex: true, mega: true, prizeValue: 2,
    attacks: [atk("Psystrike", "PPC", 110), atk("Genesis Wave", "PPPPC", 200, { type: "plusPerEnergy", per: 10, energyType: "psychic", ignore: 5 }, "+10 for each extra Psychic Energy attached.")] }),
  mon({ id: "mega-kangaskhan-ex", name: "Mega Kangaskhan EX", dex: 10039, stage: "mega", from: "colorless-kangaskhan", type: "colorless", hp: 240, weak: "fighting", retreat: 3, ex: true, mega: true, prizeValue: 2,
    attacks: [atk("Parental Bond", "CCC", 80, { type: "coinFlipBonus", damage: 40 }, "Flip a coin. If heads, +40 damage."), atk("Outrage", "CCCCC", 160)] }),
];

// --- Energy ---------------------------------------------------------------

const ENERGY = [
  { id: "energy-fire", kind: "energy", name: "Fire Energy", energyType: "fire" },
  { id: "energy-water", kind: "energy", name: "Water Energy", energyType: "water" },
  { id: "energy-grass", kind: "energy", name: "Grass Energy", energyType: "grass" },
  { id: "energy-lightning", kind: "energy", name: "Lightning Energy", energyType: "lightning" },
  { id: "energy-psychic", kind: "energy", name: "Psychic Energy", energyType: "psychic" },
  { id: "energy-fighting", kind: "energy", name: "Fighting Energy", energyType: "fighting" },
  { id: "energy-darkness", kind: "energy", name: "Darkness Energy", energyType: "darkness" },
  { id: "energy-metal", kind: "energy", name: "Metal Energy", energyType: "metal" },
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
  { id: "trainer-hyper-potion", kind: "item", name: "Hyper Potion", text: "Heal 120 damage from 1 of your Pokémon.", effect: { type: "heal", amount: 120 } },
  { id: "trainer-pokemon-catcher", kind: "item", name: "Pokémon Catcher", text: "Switch your opponent's Active Pokémon with 1 of their Benched Pokémon.", effect: { type: "switchOpponent" } },
];

// Prefer bespoke illustrator-style artwork (scripts/generate-tcg-art.js) when a
// card has it; it fills the whole art window (artStyle "art").
for (const t of TRAINERS) {
  if (GENERATED_ART[t.id]) { t.art = GENERATED_ART[t.id]; t.artStyle = "art"; }
  t.rarity = t.kind === "stadium" ? "rare" : t.kind === "supporter" ? "uncommon" : "common";
}

// Rarity tiers (visual treatment, like real TCG): marquee Pokémon are Ultra
// Rares (rainbow holo, full-art), Stage 2s + a set of standout Stage 1s are
// Rares (holo), other Stage 1s Uncommon, Basics Common. Bespoke Pokémon
// illustrations (generate-pokemon-art.js) fill the card full-bleed as an
// "Illustration Rare"-style full art.
const ULTRA = new Set([
  "fire-charizard", "water-blastoise", "grass-venusaur", "lightning-raichu",
  "psychic-alakazam", "psychic-gengar", "fighting-machamp", "fighting-golem",
  // Chase Ultra Rares — iconic evolution-line finishers & fan favourites.
  "water-gyarados", "fire-arcanine", "grass-vileplume", "colorless-eevee",
  "lightning-electabuzz", "fighting-primeape",
  // Legendary / marquee chase cards from the expansion.
  "psychic-mewtwo", "colorless-dragonite", "colorless-snorlax",
  "lightning-zapdos", "water-lapras",
  // Darkness / Metal chase Ultras + the new legend Moltres & Mew.
  "darkness-houndoom", "darkness-umbreon", "metal-onix-steelix", "metal-scyther-scizor",
  "fire-moltres", "psychic-mew",
]);
// Standout Stage 1s / strong Basics promoted to Rare (holo, no full-art).
const RARE_PLUS = new Set([
  "fire-ninetales", "fire-rapidash", "water-starmie", "water-golduck",
  "lightning-magneton", "psychic-hypno", "colorless-pidgeotto", "lightning-electrode",
  // Expansion promotions.
  "fire-flareon", "water-vaporeon", "water-dewgong", "lightning-jolteon",
  "grass-exeggutor", "grass-scyther", "fighting-rhydon", "fighting-marowak",
  "fighting-hitmonlee", "fighting-hitmonchan", "psychic-slowbro", "colorless-dragonair",
  "colorless-persian", "colorless-wigglytuff",
  // Darkness / Metal / expansion promotions.
  "darkness-golbat", "darkness-arbok", "darkness-sneasel", "metal-forretress",
  "metal-skarmory", "water-seadra", "water-cloyster", "water-kingler",
  "water-tentacruel", "grass-parasect", "grass-pinsir", "colorless-clefable",
  "colorless-chansey", "fighting-aerodactyl",
]);

// Guest-Artist Ultra Rares — a celebrated illustrator lends their signature
// style to a marquee card, credited on the face like real Pokémon TCG guest
// cards. Each is generated full-art in that style (see generate-pokemon-art.js).
const GUEST_ARTISTS = {
  "fire-charizard":   { illus: "Akira Toriyama",   style: "classic Akira Toriyama Dragon Ball manga art — bold confident ink linework, rounded muscular anatomy, cross-hatch shading, retro Shonen Jump colour palette, an explosive ki-blast aura crackling around it" },
  "water-blastoise":  { illus: "Eiichiro Oda",     style: "Eiichiro Oda One Piece manga style — exaggerated expressive proportions, playful adventurous spirit, bold varied line weights, bright saturated seafaring colour and cartoon dynamism" },
  "grass-venusaur":   { illus: "Hayao Miyazaki",   style: "Hayao Miyazaki Studio Ghibli hand-painted watercolour anime — lush verdant scenery, soft gouache clouds, gentle painterly sunlight, a wholesome sense of natural wonder" },
  "psychic-alakazam": { illus: "Roy Lichtenstein", style: "Roy Lichtenstein pop-art comic — thick black outlines, flat primary red/yellow/blue, bold Ben-Day dot halftone shading, graphic comic-panel composition" },
  "psychic-gengar":   { illus: "Killer Acid",      style: "Killer Acid psychedelic poster art — trippy neon acid colours, melting surreal shapes, swirling hypnotic patterns, glowing eyes, 1960s blacklight counterculture vibe" },
  "lightning-raichu": { illus: "Osamu Tezuka",     style: "Osamu Tezuka golden-age manga — clean rounded retro linework, big sparkling expressive eyes, mid-century Astro Boy cartoon charm, cheerful vintage ink-and-colour" },
};

for (const p of POKEMON) {
  // Mega EX / Pokémon-ex are always Ultra (full-art, premium) and hand the
  // opponent extra Prizes when Knocked Out.
  p.rarity = p.mega || p.ex ? "ultra"
    : ULTRA.has(p.id) ? "ultra"
    : p.stage === "stage2" || RARE_PLUS.has(p.id) ? "rare"
    : p.stage === "stage1" ? "uncommon" : "common";
  if ((p.mega || p.ex) && !p.prizeValue) p.prizeValue = 2;
  if (GENERATED_ART[p.id]) { p.art = GENERATED_ART[p.id]; p.genArt = true; }
  const guest = GUEST_ARTISTS[p.id];
  if (guest) { p.illus = guest.illus; p.guestStyle = guest.style; }
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
