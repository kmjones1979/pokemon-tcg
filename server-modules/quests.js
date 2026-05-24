// Daily quests — 2 random quests per user per UTC day, generated
// deterministically from (user_id, date) so the same user sees the same
// quests all day. Progress is computed from the matches + owned_cards
// tables in real time; claim state lives in the quest_claims table.
//
// Endpoints:
//   GET  /me/quests        -> { date, quests: [{ id, label, target, progress, reward, claimed }] }
//   POST /me/quests/:id/claim -> { reward } if eligible

// Live reference (not destructured) to break the circular dep with
// rewards.js. rewards.js requires this module for bumpDailyStats, so
// destructuring `createOffer` / `rollPicks` at top of file gives us
// `undefined` because rewards.js hasn't finished evaluating yet when
// the require resolves. Accessing through `rewards.<fn>` at call time
// always reads the now-fully-populated exports.
const rewards = require("./rewards");
const { createHash } = require("crypto");

const QUEST_POOL = [
  { id: "play3",     label: "Play 3 matches today",         target: 3,  metric: "matches",  rewardCount: 1, minTier: 1 },
  { id: "win2",      label: "Win 2 matches today",          target: 2,  metric: "wins",     rewardCount: 1, minTier: 2 },
  { id: "ko10",      label: "Score 10 KOs today",           target: 10, metric: "kos",      rewardCount: 1, minTier: 2 },
  { id: "win5",      label: "Win 5 matches (marathon)",     target: 5,  metric: "wins",     rewardCount: 2, minTier: 3 },
  { id: "collect5",  label: "Earn 5 new cards today",       target: 5,  metric: "newCards", rewardCount: 1, minTier: 1 },
  { id: "win3",      label: "Win 3 matches today",          target: 3,  metric: "wins",     rewardCount: 1, minTier: 3 },
];

function todayKey(now = new Date()) {
  // UTC-day boundary so quests roll over at midnight UTC for all players.
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function pickTwoQuests(userId, dayKey) {
  // Deterministic pair per user-day. Hash to integer, then pick 2 distinct.
  const h = createHash("sha256").update(`${userId}|${dayKey}`).digest();
  const a = h.readUInt32BE(0) % QUEST_POOL.length;
  let b = h.readUInt32BE(4) % QUEST_POOL.length;
  if (b === a) b = (a + 1) % QUEST_POOL.length;
  return [QUEST_POOL[a], QUEST_POOL[b]];
}

// Per-user daily tallies — kept on users.quest_progress (jsonb) keyed by
// the UTC date string. Bumped from anywhere that finishes a match (solo,
// story, multiplayer). The matches table only covers multiplayer, so we
// can't rely on it alone — most quest progress comes from here.
async function bumpDailyStats(supabase, userId, delta = {}) {
  if (!supabase || !userId) return;
  try {
    const { data } = await supabase
      .from("users").select("quest_progress").eq("id", userId).maybeSingle();
    const progress = data?.quest_progress || {};
    const dayKey = todayKey();
    const today = progress[dayKey] || { matches: 0, wins: 0, kos: 0 };
    today.matches += delta.matches || 0;
    today.wins    += delta.wins    || 0;
    today.kos     += delta.kos     || 0;
    progress[dayKey] = today;
    // Garbage-collect: only keep the last 14 days so the column doesn't
    // grow unbounded.
    const cutoff = Date.now() - 14 * 86_400_000;
    for (const k of Object.keys(progress)) {
      if (new Date(k + "T00:00:00Z").getTime() < cutoff) delete progress[k];
    }
    await supabase.from("users").update({ quest_progress: progress }).eq("id", userId);
  } catch (err) {
    console.warn("[quests] bumpDailyStats failed:", err.message);
  }
}

async function computeProgress(supabase, userId, dayKey) {
  // Multiplayer matches (rows in the `matches` table).
  const { data: matches } = await supabase
    .from("matches")
    .select("p1_user_id, p2_user_id, winner_id, started_at")
    .or(`p1_user_id.eq.${userId},p2_user_id.eq.${userId}`)
    .gte("started_at", `${dayKey}T00:00:00.000Z`)
    .lt("started_at", `${dayKey}T23:59:59.999Z`);
  const mpMatches = matches || [];
  const mpPlay = mpMatches.length;
  const mpWin  = mpMatches.filter((m) => m.winner_id === userId).length;

  // Solo + story tallies stored on the user row's quest_progress JSONB.
  let soloDay = { matches: 0, wins: 0, kos: 0 };
  try {
    const { data: u } = await supabase
      .from("users").select("quest_progress").eq("id", userId).maybeSingle();
    soloDay = (u?.quest_progress?.[dayKey]) || soloDay;
  } catch {
    // Column may not exist yet — degrade silently.
  }

  // newCards today: count owned_cards rows acquired today.
  const { count: newCardsCount } = await supabase
    .from("owned_cards")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("acquired_at", `${dayKey}T00:00:00.000Z`)
    .lt("acquired_at", `${dayKey}T23:59:59.999Z`);

  return {
    matches: mpPlay + (soloDay.matches || 0),
    wins:    mpWin  + (soloDay.wins    || 0),
    kos:     (soloDay.kos || 0) + (mpWin * 3 + (mpPlay - mpWin)),
    newCards: newCardsCount || 0,
  };
}

function mount(app, supabase, getPokedex) {
  async function loadDex() {
    const v = getPokedex();
    return v && typeof v.then === "function" ? await v : v;
  }

  app.get("/me/quests", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const dayKey = todayKey();
    const quests = pickTwoQuests(req.user.id, dayKey);
    const progress = await computeProgress(supabase, req.user.id, dayKey);
    const { data: claims } = await supabase
      .from("quest_claims")
      .select("quest_id")
      .eq("user_id", req.user.id)
      .eq("claim_date", dayKey);
    const claimedSet = new Set((claims || []).map((c) => c.quest_id));

    const out = quests.map((q) => ({
      id: q.id,
      label: q.label,
      target: q.target,
      progress: Math.min(q.target, progress[q.metric] || 0),
      reward: { count: q.rewardCount, minTier: q.minTier },
      claimed: claimedSet.has(q.id),
      canClaim: !claimedSet.has(q.id) && (progress[q.metric] || 0) >= q.target,
    }));
    res.json({ date: dayKey, quests: out });
  });

  app.post("/me/quests/:id/claim", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    let pokedex;
    try {
      pokedex = await loadDex();
    } catch (err) {
      console.error("[quests] loadDex failed:", err);
      return res.status(503).json({ error: `Pokédex unavailable: ${err.message || "unknown"}` });
    }
    if (!pokedex?.length) return res.status(503).json({ error: "Pokédex not loaded." });
    const dayKey = todayKey();
    const quests = pickTwoQuests(req.user.id, dayKey);
    const q = quests.find((x) => x.id === req.params.id);
    if (!q) return res.status(404).json({ error: "Quest not active today." });

    // Already claimed? supabase-js returns {data, error} on REST errors
    // but CAN throw on network/auth refresh failures — catch both shapes
    // so the client always gets JSON instead of Express's HTML 500 page.
    let existing, lookupErr;
    try {
      ({ data: existing, error: lookupErr } = await supabase
        .from("quest_claims")
        .select("quest_id")
        .eq("user_id", req.user.id)
        .eq("quest_id", q.id)
        .eq("claim_date", dayKey)
        .maybeSingle());
    } catch (err) {
      console.error("[quests] claim lookup threw:", err);
      return res.status(500).json({ error: `Couldn't check claim status: ${err.message || "network error"}` });
    }
    if (lookupErr) {
      console.error("[quests] claim lookup failed:", lookupErr);
      return res.status(500).json({ error: `Couldn't check claim status: ${lookupErr.message}` });
    }
    if (existing) return res.status(409).json({ error: "Already claimed today." });

    // Progress check
    let progress;
    try {
      progress = await computeProgress(supabase, req.user.id, dayKey);
    } catch (err) {
      console.error("[quests] computeProgress threw:", err);
      return res.status(500).json({ error: `Couldn't compute progress: ${err.message || "network error"}` });
    }
    if ((progress[q.metric] || 0) < q.target) {
      return res.status(400).json({ error: "Quest not yet complete." });
    }

    // Roll picks and create an offer.
    let picks;
    try {
      const eligible = pokedex.filter((c) => c.tier >= q.minTier);
      picks = rewards.rollPicks(eligible.length >= q.rewardCount ? eligible : pokedex, q.rewardCount);
    } catch (err) {
      console.error("[quests] rollPicks threw:", err);
      return res.status(500).json({ error: "Couldn't roll a reward — try again." });
    }
    if (!picks?.length) {
      return res.status(500).json({ error: "Couldn't roll a reward — try again." });
    }
    let offerId;
    try {
      offerId = await rewards.createOffer(req.user.id, picks);
    } catch (err) {
      console.error("[quests] createOffer failed:", err);
      return res.status(500).json({ error: "Reward offer couldn't be stashed. Please retry." });
    }

    // Persist the claim AFTER the offer is durable. Surface the real
    // Postgres error if the insert fails so we can diagnose instead of
    // returning a silently-half-claimed reward.
    let claimErr;
    try {
      ({ error: claimErr } = await supabase.from("quest_claims").insert({
        user_id: req.user.id,
        quest_id: q.id,
        claim_date: dayKey,
      }));
    } catch (err) {
      console.error("[quests] claim insert threw:", err);
      return res.status(500).json({ error: `Couldn't record claim (network): ${err.message || "unknown"}` });
    }
    if (claimErr) {
      console.error("[quests] claim insert failed:", claimErr);
      // Duplicate key = the user already claimed (race / double-tap).
      if (claimErr.code === "23505") {
        return res.status(409).json({ error: "Already claimed today." });
      }
      return res.status(500).json({ error: `Couldn't record claim: ${claimErr.message}` });
    }

    res.json({
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

module.exports = { mount, bumpDailyStats };
