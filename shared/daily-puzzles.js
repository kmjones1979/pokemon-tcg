// Daily Puzzle scenarios — Wordle-style fixed-board challenges.
//
// Every UTC day, every player faces the same scenario:
//   - A small pre-built board (2-3 of your Pokémon vs 2-4 enemies)
//   - Unlimited energy, no hand draws (this is a CHESS puzzle, not a
//     deck-building exercise)
//   - Goal: KO every enemy in `parMoves` moves or fewer
//
// The scenarios are hand-tuned so:
//   - There's a clear "best" line that hits par
//   - Suboptimal lines are visible enough to learn from
//   - Type matchups and signatures matter — encourages thinking
//
// Puzzle index advances daily (date - EPOCH) % PUZZLES.length.

const EPOCH_MS = new Date(Date.UTC(2026, 0, 1)).getTime();

function todayDateKey(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dayNumberFor(dateKey) {
  const t = new Date(dateKey + "T00:00:00Z").getTime();
  return Math.max(1, Math.floor((t - EPOCH_MS) / 86_400_000) + 1);
}

// Each puzzle: { id, title, par, player: [{ id, hp, atk }], enemy: [...] }.
// HP and attack on each instance are overrides — actual sprites + type
// data come from the pokedex at render time.
const PUZZLES = [
  {
    id: "first-strike",
    title: "First Strike",
    par: 2,
    flavor: "Two attackers, two targets. Pick well.",
    player: [
      { pokemonId: 6,   hp: 14, atk: 7 },   // Charizard
      { pokemonId: 9,   hp: 14, atk: 6 },   // Blastoise
    ],
    enemy: [
      { pokemonId: 3,   hp: 8, atk: 5 },    // Venusaur (water-weak to fire)
      { pokemonId: 95,  hp: 9, atk: 5 },    // Onix (rock — weak to water)
    ],
  },
  {
    id: "type-pressure",
    title: "Type Pressure",
    par: 3,
    flavor: "Three enemies, three moves. Order matters.",
    player: [
      { pokemonId: 25,  hp: 12, atk: 6 },   // Pikachu
      { pokemonId: 65,  hp: 12, atk: 8 },   // Alakazam
    ],
    enemy: [
      { pokemonId: 130, hp: 11, atk: 6 },   // Gyarados (water+flying — electric 4x)
      { pokemonId: 68,  hp: 9, atk: 6 },    // Machamp (psychic 2x)
      { pokemonId: 36,  hp: 8, atk: 4 },    // Clefable
    ],
  },
  {
    id: "guardian-gambit",
    title: "Guardian Gambit",
    par: 3,
    flavor: "The wall must fall first.",
    player: [
      { pokemonId: 6,   hp: 14, atk: 8 },
      { pokemonId: 25,  hp: 10, atk: 7 },
      { pokemonId: 65,  hp: 12, atk: 8 },
    ],
    enemy: [
      { pokemonId: 143, hp: 14, atk: 5 },   // Snorlax (Guardian — must hit first)
      { pokemonId: 94,  hp: 8,  atk: 6 },   // Gengar
      { pokemonId: 130, hp: 10, atk: 6 },   // Gyarados
    ],
  },
  {
    id: "the-burner",
    title: "The Burner",
    par: 2,
    flavor: "Fire melts steel. Use it.",
    player: [
      { pokemonId: 6,   hp: 16, atk: 9 },   // Charizard
    ],
    enemy: [
      { pokemonId: 81,  hp: 8, atk: 4 },    // Magnemite (steel — fire 2x)
      { pokemonId: 100, hp: 7, atk: 5 },    // Voltorb
    ],
  },
  {
    id: "double-tap",
    title: "Double Tap",
    par: 2,
    flavor: "Two-shot or be two-shot. Pick fast.",
    player: [
      { pokemonId: 9,   hp: 12, atk: 7 },
      { pokemonId: 144, hp: 10, atk: 8 },   // Articuno (ice)
    ],
    enemy: [
      { pokemonId: 149, hp: 13, atk: 7 },   // Dragonite (ice 4x)
      { pokemonId: 130, hp: 9, atk: 6 },    // Gyarados
    ],
  },
  {
    id: "psychic-storm",
    title: "Psychic Storm",
    par: 3,
    flavor: "Three psychics, three threats, three moves.",
    player: [
      { pokemonId: 65,  hp: 14, atk: 9 },
      { pokemonId: 150, hp: 16, atk: 10 },  // Mewtwo
    ],
    enemy: [
      { pokemonId: 68,  hp: 11, atk: 6 },   // Machamp (psychic 2x)
      { pokemonId: 24,  hp: 10, atk: 6 },   // Arbok (psychic 2x)
      { pokemonId: 92,  hp: 8, atk: 5 },    // Gastly (psychic 2x but ghost)
    ],
  },
  {
    id: "swarm",
    title: "Swarm",
    par: 4,
    flavor: "Many small foes. The bug net is wide.",
    player: [
      { pokemonId: 6,   hp: 14, atk: 8 },
      { pokemonId: 146, hp: 12, atk: 8 },   // Moltres
    ],
    enemy: [
      { pokemonId: 13,  hp: 6, atk: 3 },    // Weedle x4
      { pokemonId: 13,  hp: 6, atk: 3 },
      { pokemonId: 13,  hp: 6, atk: 3 },
      { pokemonId: 13,  hp: 6, atk: 3 },
    ],
  },
];

function puzzleForDay(dayNumber) {
  return PUZZLES[(dayNumber - 1) % PUZZLES.length];
}

module.exports = { PUZZLES, puzzleForDay, todayDateKey, dayNumberFor };
