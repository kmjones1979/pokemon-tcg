// Card Mastery — per-user, per-Pokémon KO counter + derived level.
//
// Level thresholds (app-side so they can be retuned without migrating):
//   1 KO   → L1   (★)
//   5 KOs  → L2   (★★)
//   15 KOs → L3   (★★★) — engine applies a permanent +1 ATK to every
//                          instance of this card in matches from now on.
//
// Endpoints:
//   GET  /me/mastery               full mastery map for the signed-in user
//   POST /me/mastery/bump          { kos: { pokemonId: count } } — additive
//                                   merge, returns the updated map.
// All mastery effects on the engine flow through the createGame()
// option `masteryById` so the server stays authoritative for what
// counts.

const LEVELS = [
  { level: 1, threshold: 1 },
  { level: 2, threshold: 5 },
  { level: 3, threshold: 15 },
];

function levelFor(kos) {
  let lvl = 0;
  for (const { level, threshold } of LEVELS) {
    if (kos >= threshold) lvl = level;
  }
  return lvl;
}

function mount(app, supabase) {
  if (!supabase) return;

  app.get("/me/mastery", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const { data, error } = await supabase
      .from("card_mastery")
      .select("pokemon_id, kos, level")
      .eq("user_id", req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    const map = {};
    for (const row of (data || [])) {
      map[row.pokemon_id] = { kos: row.kos, level: row.level };
    }
    res.json({ mastery: map });
  });

  app.post("/me/mastery/bump", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const kos = req.body?.kos || {};
    if (!kos || typeof kos !== "object") {
      return res.status(400).json({ error: "kos must be an object" });
    }
    const entries = [];
    for (const [k, v] of Object.entries(kos)) {
      const id = Number(k);
      const inc = Math.max(0, Math.min(20, Math.floor(Number(v) || 0)));
      if (!Number.isInteger(id) || id < 1 || id > 4095) continue;
      if (inc === 0) continue;
      entries.push({ pokemonId: id, inc });
      if (entries.length >= 60) break;     // anti-spam
    }
    if (!entries.length) return res.json({ updated: {} });

    // Read existing rows, recompute, write back. Could be one batch
    // upsert but for ≤60 rows this is fine and easier to reason about.
    const ids = entries.map((e) => e.pokemonId);
    const { data: existing } = await supabase
      .from("card_mastery")
      .select("pokemon_id, kos, level")
      .eq("user_id", req.user.id)
      .in("pokemon_id", ids);
    const cur = new Map((existing || []).map((r) => [r.pokemon_id, r]));
    const updates = entries.map(({ pokemonId, inc }) => {
      const before = cur.get(pokemonId) || { kos: 0 };
      const newKos = before.kos + inc;
      return {
        user_id: req.user.id,
        pokemon_id: pokemonId,
        kos: newKos,
        level: levelFor(newKos),
        last_ko_at: new Date().toISOString(),
      };
    });
    const { error } = await supabase
      .from("card_mastery")
      .upsert(updates, { onConflict: "user_id,pokemon_id" });
    if (error) return res.status(500).json({ error: error.message });

    const updated = {};
    for (const u of updates) {
      const before = cur.get(u.pokemon_id) || { level: 0 };
      updated[u.pokemon_id] = {
        kos: u.kos,
        level: u.level,
        leveledUp: u.level > before.level,
      };
    }
    res.json({ updated });
  });
}

module.exports = { mount, levelFor, LEVELS };
