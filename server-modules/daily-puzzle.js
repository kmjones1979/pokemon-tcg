// Daily Puzzle server endpoints — fixed board, count your moves.
//
// Flow:
//   1. GET /api/puzzle/today        → today's puzzle + your prior attempt
//   2. POST /me/puzzle/start        → issues a session id (anti-cheat)
//   3. POST /me/puzzle/end          → records moves used, returns share
//                                     string + star rating
//   4. GET /api/puzzle/leaderboard  → today's results, sorted by moves asc
//
// One attempt per UTC day, enforced at the DB layer via UNIQUE.
// Anonymous play is allowed for the GET — they just don't get a recorded
// result.

const { toCard } = require("../shared/deck-builder");
const { PUZZLES, puzzleForDay, todayDateKey, dayNumberFor } = require("../shared/daily-puzzles");

const PUZZLE_SESSIONS = new Map();
const PUZZLE_MIN_DURATION_MS = 5 * 1000; // tighter than match anti-cheat — puzzles can be quick

function starsForPuzzle({ solved, movesUsed, par }) {
  if (!solved) return "💀";
  if (movesUsed <= par) return "⭐⭐⭐⭐⭐";
  if (movesUsed === par + 1) return "⭐⭐⭐⭐☆";
  if (movesUsed === par + 2) return "⭐⭐⭐☆☆";
  if (movesUsed <= par * 2) return "⭐⭐☆☆☆";
  return "⭐☆☆☆☆";
}

async function hydratePuzzle(supabase, puzzle) {
  if (!supabase) return puzzle;
  // Fetch the pokemon rows for every unique pokemonId in the puzzle so
  // the client has sprite/type data without extra round trips.
  const ids = [...new Set([
    ...puzzle.player.map((p) => p.pokemonId),
    ...puzzle.enemy.map((e) => e.pokemonId),
  ])];
  const { data: rows } = await supabase.from("pokemon").select("*").in("id", ids);
  const byId = new Map((rows || []).map((r) => [r.id, toCard(r)]));
  return {
    ...puzzle,
    player: puzzle.player.map((p, i) => ({
      slot: i,
      card: byId.get(p.pokemonId) || { id: p.pokemonId, name: `?#${p.pokemonId}` },
      hp: p.hp, maxHp: p.hp,
      atk: p.atk,
    })),
    enemy: puzzle.enemy.map((e, i) => ({
      slot: i,
      card: byId.get(e.pokemonId) || { id: e.pokemonId, name: `?#${e.pokemonId}` },
      hp: e.hp, maxHp: e.hp,
      atk: e.atk,
    })),
  };
}

function mount(app, supabase) {
  let _cache = { dateKey: null, payload: null };

  async function getTodayPayload() {
    const dateKey = todayDateKey();
    if (_cache.dateKey === dateKey && _cache.payload) return _cache.payload;
    const dayNumber = dayNumberFor(dateKey);
    const puzzle = puzzleForDay(dayNumber);
    const hydrated = await hydratePuzzle(supabase, puzzle);
    const payload = { dayNumber, dateKey, puzzle: hydrated };
    _cache = { dateKey, payload };
    return payload;
  }

  app.get("/api/puzzle/today", async (req, res) => {
    try {
      const payload = await getTodayPayload();
      let alreadyAttempted = null;
      if (req.user && supabase) {
        const { data } = await supabase.from("daily_puzzle_results")
          .select("solved, moves_used, created_at")
          .eq("user_id", req.user.id)
          .eq("challenge_date", payload.dateKey)
          .maybeSingle();
        alreadyAttempted = data || null;
      }
      res.json({ ...payload, alreadyAttempted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/me/puzzle/start", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in to record results." });
    const dateKey = todayDateKey();
    if (supabase) {
      const { data: existing } = await supabase.from("daily_puzzle_results")
        .select("solved").eq("user_id", req.user.id).eq("challenge_date", dateKey).maybeSingle();
      if (existing) return res.status(409).json({ error: "Already attempted today." });
    }
    const sessionId = require("crypto").randomBytes(12).toString("base64url");
    PUZZLE_SESSIONS.set(sessionId, { userId: req.user.id, dateKey, startedAt: Date.now() });
    res.json({ sessionId, dateKey });
  });

  app.post("/me/puzzle/end", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const { sessionId, solved, movesUsed = 0 } = req.body || {};
    const session = PUZZLE_SESSIONS.get(sessionId);
    if (!session) return res.status(400).json({ error: "No session." });
    if (session.userId !== req.user.id) return res.status(403).json({ error: "Wrong user." });
    if (Date.now() - session.startedAt < PUZZLE_MIN_DURATION_MS) {
      return res.status(400).json({ error: "Too fast — try again." });
    }
    PUZZLE_SESSIONS.delete(sessionId);
    const dayNumber = dayNumberFor(session.dateKey);
    const puzzle = puzzleForDay(dayNumber);
    if (supabase) {
      await supabase.from("daily_puzzle_results")
        .upsert({
          user_id: req.user.id,
          challenge_date: session.dateKey,
          solved: !!solved,
          moves_used: Math.max(0, Number(movesUsed) || 0),
        }, { onConflict: "user_id,challenge_date" });
    }
    const stars = starsForPuzzle({ solved: !!solved, movesUsed, par: puzzle.par });
    const origin = (req.headers["x-forwarded-host"] && `https://${req.headers["x-forwarded-host"]}`)
                || (req.headers.host && `https://${req.headers.host}`) || "";
    const url = `${origin}/?puzzle=${dayNumber}`;
    const shareText = solved
      ? `Pokémon TCG Puzzle #${dayNumber} · "${puzzle.title}"\n${stars}  ✅ Cleared in ${movesUsed}/${puzzle.par} ${movesUsed === 1 ? "move" : "moves"}\nplay: ${url}`
      : `Pokémon TCG Puzzle #${dayNumber} · "${puzzle.title}"\n${stars}  ❌ Defeated after ${movesUsed} ${movesUsed === 1 ? "move" : "moves"}\nplay: ${url}`;
    res.json({ ok: true, dayNumber, stars, shareText, shareUrl: url, puzzleTitle: puzzle.title, par: puzzle.par });
  });

  app.get("/api/puzzle/leaderboard", async (req, res) => {
    if (!supabase) return res.json({ rows: [], dateKey: todayDateKey() });
    const dateKey = todayDateKey();
    const { data, error } = await supabase
      .from("daily_puzzle_results")
      .select("user_id, solved, moves_used, users(display_name)")
      .eq("challenge_date", dateKey)
      .order("solved", { ascending: false })
      .order("moves_used", { ascending: true })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    const rows = (data || []).map((r, i) => ({
      rank: i + 1,
      displayName: r.users?.display_name || "Trainer",
      solved: r.solved,
      movesUsed: r.moves_used,
      isYou: req.user && r.user_id === req.user.id,
    }));
    res.json({ rows, dateKey, dayNumber: dayNumberFor(dateKey) });
  });
}

module.exports = { mount };
