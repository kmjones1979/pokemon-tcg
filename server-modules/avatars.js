// Trainer-avatar roster + unlock logic.
//
// Players pick an avatar that represents them across the leaderboard,
// account drawer, battle screen, and Math Mode header. The starter pair
// is available from L1; new pairs unlock every 10 trainer levels.
//
// Sprite source: play.pokemonshowdown.com hot-link. Showdown has been
// a stable community CDN for 15+ years and actively hosts trainer
// sprites at /sprites/trainers/<slug>.png. If that source ever breaks,
// we can mirror to Supabase Storage and rewrite the `sprite` field
// without changing the route shape.
//
// Routes (mounted from server.js inside the auth block):
//   GET  /me/avatars            → { selected, unlocked: [...], roster: [...] }
//   POST /me/avatars/select     body { key } → { ok, selected }
//
// State columns on users (added by 20260622000000_trainer_avatars.sql):
//   selected_avatar    text         (defaults to 'red')
//   unlocked_avatars   text[]       (avatar keys the user has unlocked)

const SPRITE_BASE = "https://play.pokemonshowdown.com/sprites/trainers";

// 10 tiers × 2 trainers = 20 avatars. Chronological release order;
// every 10 levels brings a new region's protagonist pair. Gen 9
// (Florian/Juliana) is intentionally omitted — Showdown hasn't added
// their sprites yet. When they appear we can append an L95 bonus tier
// without disturbing existing user selections.
//
// Naming note: Showdown serves the most-recent canonical depiction at
// /trainers/<name>.png. Where multiple gens share a name (Red appears
// in RBY, FRLG, SM, etc.) the bare slug points at the latest design;
// "<name>-gen3" etc. selects an earlier sprite. The Leaf design we
// want for the L1 starter pair lives at leaf-gen3.
const ROSTER = [
  // L1 — starters. Iconic Gen 1, available from day one.
  { key: "red",     name: "Red",     levelRequired: 1,  game: "FireRed / LeafGreen",       gen: 1, sprite: `${SPRITE_BASE}/red.png` },
  { key: "leaf",    name: "Leaf",    levelRequired: 1,  game: "FireRed / LeafGreen",       gen: 1, sprite: `${SPRITE_BASE}/leaf-gen3.png` },
  // L10 — Johto
  { key: "ethan",   name: "Ethan",   levelRequired: 10, game: "HeartGold / SoulSilver",    gen: 2, sprite: `${SPRITE_BASE}/ethan.png` },
  { key: "lyra",    name: "Lyra",    levelRequired: 10, game: "HeartGold / SoulSilver",    gen: 2, sprite: `${SPRITE_BASE}/lyra.png` },
  // L20 — Hoenn
  { key: "brendan", name: "Brendan", levelRequired: 20, game: "Ruby / Sapphire / Emerald", gen: 3, sprite: `${SPRITE_BASE}/brendan.png` },
  { key: "may",     name: "May",     levelRequired: 20, game: "Ruby / Sapphire / Emerald", gen: 3, sprite: `${SPRITE_BASE}/may.png` },
  // L30 — Sinnoh
  { key: "lucas",   name: "Lucas",   levelRequired: 30, game: "Diamond / Pearl",           gen: 4, sprite: `${SPRITE_BASE}/lucas.png` },
  { key: "dawn",    name: "Dawn",    levelRequired: 30, game: "Diamond / Pearl",           gen: 4, sprite: `${SPRITE_BASE}/dawn.png` },
  // L40 — Unova
  { key: "hilbert", name: "Hilbert", levelRequired: 40, game: "Black / White",             gen: 5, sprite: `${SPRITE_BASE}/hilbert.png` },
  { key: "hilda",   name: "Hilda",   levelRequired: 40, game: "Black / White",             gen: 5, sprite: `${SPRITE_BASE}/hilda.png` },
  // L50 — Unova 2
  { key: "nate",    name: "Nate",    levelRequired: 50, game: "Black 2 / White 2",         gen: 5, sprite: `${SPRITE_BASE}/nate.png` },
  { key: "rosa",    name: "Rosa",    levelRequired: 50, game: "Black 2 / White 2",         gen: 5, sprite: `${SPRITE_BASE}/rosa.png` },
  // L60 — Kalos
  { key: "calem",   name: "Calem",   levelRequired: 60, game: "X / Y",                     gen: 6, sprite: `${SPRITE_BASE}/calem.png` },
  { key: "serena",  name: "Serena",  levelRequired: 60, game: "X / Y",                     gen: 6, sprite: `${SPRITE_BASE}/serena.png` },
  // L70 — Alola
  { key: "elio",    name: "Elio",    levelRequired: 70, game: "Sun / Moon",                gen: 7, sprite: `${SPRITE_BASE}/elio.png` },
  { key: "selene",  name: "Selene",  levelRequired: 70, game: "Sun / Moon",                gen: 7, sprite: `${SPRITE_BASE}/selene.png` },
  // L80 — Galar
  { key: "victor",  name: "Victor",  levelRequired: 80, game: "Sword / Shield",            gen: 8, sprite: `${SPRITE_BASE}/victor.png` },
  { key: "gloria",  name: "Gloria",  levelRequired: 80, game: "Sword / Shield",            gen: 8, sprite: `${SPRITE_BASE}/gloria.png` },
  // L90 — Hisui (top tier — endgame grind reward)
  { key: "rei",     name: "Rei",     levelRequired: 90, game: "Legends: Arceus",           gen: 8, sprite: `${SPRITE_BASE}/rei.png` },
  { key: "akari",   name: "Akari",   levelRequired: 90, game: "Legends: Arceus",           gen: 8, sprite: `${SPRITE_BASE}/akari.png` },
];

const KEY_INDEX = new Map(ROSTER.map((a) => [a.key, a]));
const DEFAULT_KEY = "red";

// Sorted list of distinct unlock levels — used by the level-up hook
// to figure out which tier(s) a player just crossed.
const TIERS = [...new Set(ROSTER.map((a) => a.levelRequired))].sort((a, b) => a - b);

function getAvatar(key) { return KEY_INDEX.get(key) || null; }
function isValidKey(key) { return KEY_INDEX.has(key); }

// All avatar keys a player at `level` should have access to.
function unlockedForLevel(level) {
  const lvl = Math.max(1, Number(level) || 1);
  return ROSTER.filter((a) => a.levelRequired <= lvl).map((a) => a.key);
}

// Avatar keys whose tier is in (fromLevel, toLevel] — the ones a
// player just crossed into. Used by the XP grant route to surface
// "🎉 New avatar unlocked: Ethan & Lyra!" toasts.
function newlyUnlocked(fromLevel, toLevel) {
  const from = Math.max(0, Number(fromLevel) || 0);
  const to   = Math.max(0, Number(toLevel)   || 0);
  if (to <= from) return [];
  return ROSTER
    .filter((a) => a.levelRequired > from && a.levelRequired <= to)
    .map((a) => a.key);
}

function mount(app, supabase) {
  if (!supabase) return;

  // GET /me/avatars — returns the user's current pick, unlocked set,
  // and the full roster (so the client can render the picker without
  // a second round-trip). Auto-backfills `unlocked_avatars` on first
  // call so legacy users see everything they've earned.
  app.get("/me/avatars", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    let row;
    try {
      const { data } = await supabase
        .from("users")
        .select("selected_avatar, unlocked_avatars, trainer_xp")
        .eq("id", req.user.id)
        .maybeSingle();
      row = data || {};
    } catch (err) {
      return res.status(500).json({ error: `Profile read failed: ${err.message || "unknown"}` });
    }

    // Derive level from trainer_xp using the xp module's curve so we
    // don't drift if the curve ever changes.
    const { levelFromXp } = require("./xp");
    const level = levelFromXp(row.trainer_xp || 0);

    // Backfill — if unlocked_avatars is null/empty, compute from level
    // and persist so subsequent reads are cheap.
    let unlocked = Array.isArray(row.unlocked_avatars) ? row.unlocked_avatars.slice() : [];
    const shouldHave = unlockedForLevel(level);
    const missing = shouldHave.filter((k) => !unlocked.includes(k));
    if (missing.length) {
      unlocked = [...new Set([...unlocked, ...missing])];
      try {
        await supabase.from("users").update({ unlocked_avatars: unlocked }).eq("id", req.user.id);
      } catch (err) {
        console.warn("[avatars] backfill update failed:", err.message);
      }
    }

    const selected = row.selected_avatar || DEFAULT_KEY;

    res.json({
      selected,
      unlocked,
      level,
      roster: ROSTER.map((a) => ({
        ...a,
        unlocked: unlocked.includes(a.key),
      })),
    });
  });

  // POST /me/avatars/select — switch active avatar. Validates the key
  // exists in the roster AND that the user has unlocked it.
  app.post("/me/avatars/select", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const key = String(req.body?.key || "");
    if (!isValidKey(key)) return res.status(400).json({ error: "Unknown avatar." });

    let row;
    try {
      const { data } = await supabase
        .from("users")
        .select("unlocked_avatars, trainer_xp")
        .eq("id", req.user.id)
        .maybeSingle();
      row = data || {};
    } catch (err) {
      return res.status(500).json({ error: `Profile read failed: ${err.message || "unknown"}` });
    }

    // Compute the canonical unlocked set from level so we don't refuse
    // an avatar the player has earned but never persisted (e.g. a user
    // who hasn't hit the /me/avatars endpoint yet to trigger backfill).
    const { levelFromXp } = require("./xp");
    const level = levelFromXp(row.trainer_xp || 0);
    const allowed = new Set([...(row.unlocked_avatars || []), ...unlockedForLevel(level)]);
    if (!allowed.has(key)) {
      const a = getAvatar(key);
      return res.status(403).json({ error: `Reach trainer level ${a.levelRequired} to unlock ${a.name}.` });
    }

    try {
      await supabase
        .from("users")
        .update({ selected_avatar: key, unlocked_avatars: [...allowed] })
        .eq("id", req.user.id);
    } catch (err) {
      return res.status(500).json({ error: `Save failed: ${err.message || "unknown"}` });
    }

    res.json({ ok: true, selected: key });
  });
}

module.exports = {
  ROSTER, TIERS, DEFAULT_KEY,
  getAvatar, isValidKey, unlockedForLevel, newlyUnlocked,
  mount,
};
