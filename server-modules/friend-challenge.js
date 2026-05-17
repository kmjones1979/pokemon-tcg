// Friend Challenge result loop. Server-side state for the "share my
// deck and see who beat it" loop.
//
// Routes:
//   POST /me/shared-decks         { code, cardIds } — register ownership
//                                  (idempotent; first user wins if two
//                                  people independently build the same
//                                  exact deck).
//   GET  /me/shared-decks         — your own decks + result summaries
//   POST /api/deck-code/:code/result
//                                  { won, turns, hpLeft, kos } — anonymous
//                                  OK; we capture the anon-id if available
//   GET  /api/deck-code/:code/owner — light public lookup so the /v/
//                                     battle flow can show "Challenging
//                                     <name>" before the match starts.
//   GET  /me/challenges/recent    — newest results across all your
//                                  shared decks (inbox for the loop).

const { decodeDeckCode } = require("../shared/deck-codes");

function mount(app, supabase) {
  if (!supabase) return;

  // Register / re-register ownership of a deck code.
  app.post("/me/shared-decks", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const code = String(req.body?.code || "").trim();
    let ids;
    try { ids = decodeDeckCode(code); }
    catch (err) { return res.status(400).json({ error: err.message }); }

    // First registration of this exact code wins. If the row exists and
    // belongs to someone else, we just no-op (still 200, just don't
    // overwrite the owner).
    const { data: existing } = await supabase
      .from("shared_decks")
      .select("creator_user_id")
      .eq("code", code)
      .maybeSingle();
    if (existing && existing.creator_user_id !== req.user.id) {
      return res.json({ ok: true, alreadyClaimed: true });
    }
    await supabase.from("shared_decks").upsert({
      code,
      creator_user_id: req.user.id,
      card_ids: ids,
    });
    res.json({ ok: true, alreadyClaimed: false });
  });

  app.get("/me/shared-decks", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const { data, error } = await supabase
      .from("shared_decks")
      .select("code, created_at, challenges_count, wins_against, losses_against")
      .eq("creator_user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ decks: data || [] });
  });

  // Public — anyone hitting /v/<code> can see who owns it. Display
  // name only.
  app.get("/api/deck-code/:code/owner", async (req, res) => {
    const code = req.params.code;
    const { data } = await supabase
      .from("shared_decks")
      .select("creator_user_id, users(display_name)")
      .eq("code", code)
      .maybeSingle();
    if (!data) return res.json({ owner: null });
    res.json({ owner: { displayName: data.users?.display_name || "Trainer" } });
  });

  // Anonymous-friendly: record a result against a shared deck. If the
  // deck isn't registered yet, we still 200 but skip the bookkeeping
  // (challenge counts only move once an owner has claimed the code).
  app.post("/api/deck-code/:code/result", async (req, res) => {
    const code = req.params.code;
    const won = !!req.body?.won;            // did the challenger win?
    const turns = Math.max(0, Math.min(200, Number(req.body?.turns) || 0));
    const hpLeft = Math.max(0, Math.min(200, Number(req.body?.hpLeft) || 0));
    const anonId = typeof req.body?.anonId === "string" ? req.body.anonId.slice(0, 64) : null;
    const challengerName = req.user?.display_name
      || (typeof req.body?.challengerName === "string"
          ? req.body.challengerName.slice(0, 32)
          : "Anonymous Trainer");

    const { data: deck } = await supabase
      .from("shared_decks")
      .select("code, creator_user_id")
      .eq("code", code)
      .maybeSingle();
    if (!deck) return res.json({ ok: true, recorded: false, reason: "deck-not-registered" });
    if (deck.creator_user_id === req.user?.id) {
      return res.json({ ok: true, recorded: false, reason: "cant-challenge-own-deck" });
    }

    const { error } = await supabase.from("shared_deck_results").insert({
      deck_code: code,
      challenger_user_id: req.user?.id || null,
      challenger_anon_id: anonId,
      challenger_name: challengerName,
      won,
      turns,
      hp_left: hpLeft,
    });
    if (error) return res.status(500).json({ error: error.message });

    // Bump the aggregate counters on the deck row. Done as a separate
    // update rather than a trigger so the schema stays portable.
    const inc = won
      ? { losses_against: 1 }    // creator's deck lost
      : { wins_against: 1 };     // creator's deck won
    const { data: cur } = await supabase
      .from("shared_decks")
      .select("challenges_count, wins_against, losses_against")
      .eq("code", code)
      .maybeSingle();
    if (cur) {
      await supabase.from("shared_decks")
        .update({
          challenges_count: (cur.challenges_count || 0) + 1,
          wins_against:     (cur.wins_against     || 0) + (inc.wins_against     || 0),
          losses_against:   (cur.losses_against   || 0) + (inc.losses_against   || 0),
        })
        .eq("code", code);
    }
    res.json({ ok: true, recorded: true });
  });

  // The "your inbox" view — recent results across every deck the user
  // has shared. Newest first, paginated to 30.
  app.get("/me/challenges/recent", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const { data: decks } = await supabase
      .from("shared_decks")
      .select("code")
      .eq("creator_user_id", req.user.id);
    const codes = (decks || []).map((d) => d.code);
    if (!codes.length) return res.json({ results: [] });
    const { data: rows, error } = await supabase
      .from("shared_deck_results")
      .select("id, deck_code, challenger_name, won, turns, hp_left, played_at")
      .in("deck_code", codes)
      .order("played_at", { ascending: false })
      .limit(30);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ results: rows || [] });
  });
}

module.exports = { mount };
