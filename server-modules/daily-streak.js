// Daily login streak system.
//
//   GET  /me/streak        -> { current, longest, lastClaimedAt, canClaim, nextRewardTier }
//   POST /me/streak/claim  -> if canClaim, rolls a reward (1 card, biased by
//                             streak length), increments streak, returns offer.
//
// "Day" is computed as the user's local-day boundary derived from the server's
// UTC + a small grace window. The streak resets if more than 36 hours elapse
// between claims (so flexible across timezones), increments if claimed within
// the same UTC date or the next, and stays the same if claimed twice in one
// day (no-op).

const { rollPicks, createOffer } = require("./rewards");

const DAY_MS = 24 * 60 * 60 * 1000;
const STREAK_RESET_MS = 36 * 60 * 60 * 1000; // 1.5 days lenient

function daysBetween(a, b) {
  return Math.floor((b - a) / DAY_MS);
}

function tierBoostForStreak(streak) {
  // Reward quality scales with streak. Picks count + biased tier.
  if (streak >= 14) return { count: 2, minTier: 3 };
  if (streak >= 7)  return { count: 2, minTier: 2 };
  if (streak >= 3)  return { count: 1, minTier: 2 };
  return { count: 1, minTier: 1 };
}

function mount(app, supabase, getPokedex) {
  // getPokedex may return either the array directly or a Promise<Array>
  // (async ensure-loaded variant). Always await it before checking.
  async function loadDex() {
    const v = getPokedex();
    return v && typeof v.then === "function" ? await v : v;
  }

  app.get("/me/streak", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const { data: u } = await supabase
      .from("users")
      .select("daily_streak, streak_longest, last_daily_claim")
      .eq("id", req.user.id)
      .maybeSingle();
    const last = u?.last_daily_claim ? new Date(u.last_daily_claim) : null;
    const now = new Date();
    let canClaim = true;
    if (last) {
      // Block if claimed within last 20 hours.
      if (now - last < 20 * 60 * 60 * 1000) canClaim = false;
    }
    const next = tierBoostForStreak((u?.daily_streak || 0) + (canClaim ? 1 : 0));
    res.json({
      current: u?.daily_streak || 0,
      longest: u?.streak_longest || 0,
      lastClaimedAt: u?.last_daily_claim || null,
      canClaim,
      nextRewardTier: next,
    });
  });

  app.post("/me/streak/claim", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const pokedex = await loadDex();
    if (!pokedex || pokedex.length === 0) {
      return res.status(503).json({ error: "Pokédex not loaded yet." });
    }
    const { data: u, error } = await supabase
      .from("users")
      .select("daily_streak, streak_longest, last_daily_claim")
      .eq("id", req.user.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });

    const now = new Date();
    const last = u?.last_daily_claim ? new Date(u.last_daily_claim) : null;
    if (last && now - last < 20 * 60 * 60 * 1000) {
      return res.status(429).json({ error: "Already claimed today." });
    }
    // Continue or reset.
    let newStreak = (u?.daily_streak || 0) + 1;
    if (last && now - last > STREAK_RESET_MS) newStreak = 1;
    const longest = Math.max(u?.streak_longest || 0, newStreak);

    const { count, minTier } = tierBoostForStreak(newStreak);
    // rollPicks doesn't natively bias by tier, so we filter.
    const eligible = pokedex.filter((c) => c.tier >= minTier);
    const picks = rollPicks(eligible.length >= count ? eligible : pokedex, count);
    // createOffer is async (writes to Redis); must await so the JSON
    // response carries the resolved id, not a Promise that serializes
    // to "{}" and breaks the client's claim flow.
    const offerId = await createOffer(req.user.id, picks);

    await supabase
      .from("users")
      .update({
        daily_streak: newStreak,
        streak_longest: longest,
        last_daily_claim: now.toISOString(),
      })
      .eq("id", req.user.id);

    res.json({
      streak: { current: newStreak, longest },
      reward: {
        offerId,
        picks: picks.map((p) => ({
          id: p.id, name: p.name, types: p.types, tier: p.tier,
          energyCost: p.energyCost, cardHp: p.cardHp, cardAttack: p.cardAttack,
          sprite_front: p.sprite_front,
        })),
      },
    });
  });
}

module.exports = { mount, daysBetween, tierBoostForStreak };
