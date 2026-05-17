// Daily quests — 2 random quests per user per UTC day, generated
// deterministically from (user_id, date) so the same user sees the same
// quests all day. Progress is computed from the matches + owned_cards
// tables in real time; claim state lives in the quest_claims table.
//
// Endpoints:
//   GET  /me/quests        -> { date, quests: [{ id, label, target, progress, reward, claimed }] }
//   POST /me/quests/:id/claim -> { reward } if eligible

const { createOffer, rollPicks } = require("./rewards");
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

async function computeProgress(supabase, userId, dayKey) {
  // Today's matches in UTC.
  const { data: matches } = await supabase
    .from("matches")
    .select("p1_user_id, p2_user_id, winner_id, started_at, ended_at, turns")
    .or(`p1_user_id.eq.${userId},p2_user_id.eq.${userId}`)
    .gte("started_at", `${dayKey}T00:00:00.000Z`)
    .lt("started_at", `${dayKey}T23:59:59.999Z`);

  const myMatches = matches || [];
  const playCount = myMatches.length;
  const winCount = myMatches.filter((m) => m.winner_id === userId).length;

  // KOs are not directly stored per match; approximate from turns of wins (rough).
  // For an MVP we use turns as a stand-in. Better attribution can come later.
  const kos = winCount * 3 + (playCount - winCount) * 1;

  // newCards today: count owned_cards rows acquired today.
  const { count: newCardsCount } = await supabase
    .from("owned_cards")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("acquired_at", `${dayKey}T00:00:00.000Z`)
    .lt("acquired_at", `${dayKey}T23:59:59.999Z`);

  return { matches: playCount, wins: winCount, kos, newCards: newCardsCount || 0 };
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
    const pokedex = await loadDex();
    if (!pokedex?.length) return res.status(503).json({ error: "Pokédex not loaded." });
    const dayKey = todayKey();
    const quests = pickTwoQuests(req.user.id, dayKey);
    const q = quests.find((x) => x.id === req.params.id);
    if (!q) return res.status(404).json({ error: "Quest not active today." });

    // Already claimed?
    const { data: existing } = await supabase
      .from("quest_claims")
      .select("quest_id")
      .eq("user_id", req.user.id)
      .eq("quest_id", q.id)
      .eq("claim_date", dayKey)
      .maybeSingle();
    if (existing) return res.status(409).json({ error: "Already claimed today." });

    // Progress check
    const progress = await computeProgress(supabase, req.user.id, dayKey);
    if ((progress[q.metric] || 0) < q.target) {
      return res.status(400).json({ error: "Quest not yet complete." });
    }

    // Roll picks and create an offer.
    const eligible = pokedex.filter((c) => c.tier >= q.minTier);
    const picks = rollPicks(eligible.length >= q.rewardCount ? eligible : pokedex, q.rewardCount);
    const offerId = createOffer(req.user.id, picks);

    await supabase.from("quest_claims").insert({
      user_id: req.user.id,
      quest_id: q.id,
      claim_date: dayKey,
    });

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

module.exports = { mount };
