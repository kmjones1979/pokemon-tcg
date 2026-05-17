// Champion battles — preset legendary-heavy decks that play like end-of-
// region bosses. Difficulty is Hard with the AI's special-use cranked up,
// and win rewards are a 5-pick offer with at least one guaranteed
// legendary in the pool.
//
//   GET /api/champion/list           -> list of champion meta
//   GET /api/champion/:id/deck       -> 30-card deck for that champion
//
// The champion deck builder uses a curated id list per champion, falling
// back to Pokémon Showdown-style typed picks if a curated id isn't in the
// Pokédex (so it always returns 30 cards).

const { toCard } = require("../shared/deck-builder");

const CHAMPIONS = {
  lance: {
    id: "lance",
    name: "Lance",
    title: "Dragon Master",
    portrait: "lance",
    bio: "Kanto Champion. Specializes in pseudo-legendary dragons.",
    typeFilter: ["dragon", "flying"],
    coreIds: [149, 130, 142, 230, 373, 445, 635, 706, 718, 887], // Dragonite, Gyarados, Aerodactyl, Kingdra, Salamence, Garchomp, Hydreigon, Goodra, Zygarde, Dragapult
  },
  cynthia: {
    id: "cynthia",
    name: "Cynthia",
    title: "Sinnoh Champion",
    portrait: "cynthia",
    bio: "Adapts to any matchup with a balanced legendary roster.",
    typeFilter: null,
    coreIds: [445, 612, 448, 442, 407, 467, 488, 491, 487, 493], // Garchomp, Haxorus, Lucario, Spiritomb, Roserade, Magmortar, Cresselia, Darkrai, Giratina, Arceus
  },
  steven: {
    id: "steven",
    name: "Steven",
    title: "Steel Magnate",
    portrait: "steven",
    bio: "Hoenn champion. Iron-clad steel-type Pokémon only.",
    typeFilter: ["steel"],
    coreIds: [376, 227, 306, 411, 462, 530, 599, 681, 707, 805], // Metagross, Skarmory, Aggron, Bastiodon, Magnezone, Excadrill, Klang, Aegislash, Klefki, Stakataka
  },
  red: {
    id: "red",
    name: "Red",
    title: "Pallet's Champion",
    portrait: "red",
    bio: "Classic Kanto: starters, Pikachu, and iconic Gen 1 heavies.",
    typeFilter: null,
    coreIds: [3, 6, 9, 25, 130, 131, 143, 149, 150, 151], // Venusaur, Charizard, Blastoise, Pikachu, Gyarados, Lapras, Snorlax, Dragonite, Mewtwo, Mew
  },
};

async function buildChampionDeck(supabase, champion) {
  const seen = new Set();
  const deck = [];
  // First pass — curated core ids (each once, then any duplicates as 2nd copy).
  const { data: coreRows } = await supabase
    .from("pokemon")
    .select("*")
    .in("id", champion.coreIds);
  const byId = new Map((coreRows || []).map((r) => [r.id, r]));
  // 2 copies of each core (10 × 2 = 20).
  for (const id of champion.coreIds) {
    const row = byId.get(id);
    if (!row) continue;
    deck.push(toCard(row));
    deck.push(toCard(row));
    seen.add(id);
  }
  // Fill the remaining 10 with type-filtered or tier-balanced extras.
  const need = 30 - deck.length;
  let { data: pool } = champion.typeFilter
    ? await supabase
        .from("pokemon")
        .select("*")
        .overlaps("types", champion.typeFilter)
        .order("hp", { ascending: false })
        .limit(200)
    : await supabase
        .from("pokemon")
        .select("*")
        .order("hp", { ascending: false })
        .limit(300);
  pool = (pool || []).filter((r) => !seen.has(r.id));
  // Shuffle deterministically-enough via Math.random for filler.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  for (let i = 0; i < pool.length && deck.length < 30; i++) {
    deck.push(toCard(pool[i]));
    seen.add(pool[i].id);
  }
  return deck.slice(0, 30);
}

function mount(app, supabase) {
  app.get("/api/champion/list", (_req, res) => {
    res.json({
      champions: Object.values(CHAMPIONS).map((c) => ({
        id: c.id, name: c.name, title: c.title, portrait: c.portrait, bio: c.bio,
      })),
    });
  });

  app.get("/api/champion/:id/deck", async (req, res) => {
    const champ = CHAMPIONS[req.params.id];
    if (!champ) return res.status(404).json({ error: "Unknown champion" });
    if (!supabase) return res.status(503).json({ error: "DB unavailable" });
    try {
      const deck = await buildChampionDeck(supabase, champ);
      res.json({ champion: champ, deck });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { mount };
