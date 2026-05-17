// In-session win-streak — counts consecutive solo / champion / story
// wins by a user. Resets on any reported loss.  Hits at streak 3, 5,
// and 10 trigger bonus reward offers (+1 / +2 / +3 picks, guaranteed
// legendary at 10).
//
// State lives in shared KV (Redis when configured, in-memory map
// otherwise). 24-hour TTL — the "session" is a generous rolling
// window, not literal sit-at-the-keyboard time. Plenty long for
// "one more match" pacing without preserving streaks across days.
//
// Endpoints:
//   POST /me/winstreak/result  { result: "win" | "loss" }
//      → { streak, milestone, bonus? }
//
//   milestone:
//     "fire"       at 3   (next match feels meaningful, +1 pick)
//     "blazing"    at 5   (+2 picks)
//     "legendary"  at 10  (+3 picks + guaranteed legendary)
//
//   bonus (when milestone fires this call):
//     { offerId, picks: [...] }
//
// Anti-abuse: bonuses only roll on freshly-crossed thresholds, so a
// client spamming POSTs at a stable streak doesn't farm bonuses.

const store = require("./state-store");

const TTL_SEC = 24 * 60 * 60;
const MILESTONES = [
  { at: 3,  tag: "fire",      bonusPicks: 1, guaranteedLegendary: false, label: "🔥 ON FIRE" },
  { at: 5,  tag: "blazing",   bonusPicks: 2, guaranteedLegendary: false, label: "🔥🔥 BLAZING" },
  { at: 10, tag: "legendary", bonusPicks: 3, guaranteedLegendary: true,  label: "👑 LEGENDARY RUN" },
];

function milestoneFor(streak) {
  let hit = null;
  for (const m of MILESTONES) if (streak >= m.at) hit = m;
  return hit;
}

// Whether THIS request crossed the threshold (was below before, at-or-
// above now). Prevents replay-farm at a stable streak.
function crossedMilestone(prev, next) {
  for (const m of MILESTONES) {
    if (prev < m.at && next >= m.at) return m;
  }
  return null;
}

function mount(app, supabase, getPokedex) {
  // Late-bind rewards to avoid any future circular-require surprise.
  const rewards = require("./rewards");
  async function loadDex() {
    const v = getPokedex();
    return v && typeof v.then === "function" ? await v : v;
  }

  app.post("/me/winstreak/result", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const result = String(req.body?.result || "").toLowerCase();
    if (result !== "win" && result !== "loss") {
      return res.status(400).json({ error: "result must be 'win' or 'loss'." });
    }
    const key = `winstreak:${req.user.id}`;
    const cur = (await store.kvGet(key)) || { streak: 0, lastResult: null, milestone: null };
    const prev = cur.streak;
    const next = result === "win" ? prev + 1 : 0;
    const newMilestone = milestoneFor(next);
    const crossed = crossedMilestone(prev, next);

    let bonus = null;
    if (crossed) {
      const pokedex = await loadDex();
      if (pokedex?.length) {
        try {
          const picks = rewards.rollPicks(pokedex, crossed.bonusPicks);
          if (crossed.guaranteedLegendary && !picks.some((p) => p.is_legendary || p.is_mythical)) {
            const rares = pokedex.filter((p) => p.is_legendary || p.is_mythical);
            if (rares.length) picks[picks.length - 1] = rares[Math.floor(Math.random() * rares.length)];
          }
          const offerId = await rewards.createOffer(req.user.id, picks);
          bonus = {
            offerId,
            label: crossed.label,
            tag: crossed.tag,
            picks: picks.map((p) => ({
              id: p.id, name: p.name, types: p.types, tier: p.tier,
              energyCost: p.energyCost, cardHp: p.cardHp, cardAttack: p.cardAttack,
              sprite_front: p.sprite_front,
            })),
          };
        } catch (err) {
          console.error("[winstreak] bonus offer failed:", err);
        }
      }
    }

    await store.kvSet(key, {
      streak: next,
      lastResult: result,
      milestone: newMilestone?.tag || null,
    }, TTL_SEC);

    res.json({
      streak: next,
      previousStreak: prev,
      milestone: newMilestone?.tag || null,
      milestoneLabel: newMilestone?.label || null,
      bonus,
    });
  });

  // Light read endpoint so the home page / arena chrome can display
  // the current streak without re-posting a result.
  app.get("/me/winstreak", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const cur = (await store.kvGet(`winstreak:${req.user.id}`)) || { streak: 0, milestone: null };
    res.json({ streak: cur.streak || 0, milestone: cur.milestone || null });
  });
}

module.exports = { mount, milestoneFor, crossedMilestone, MILESTONES };
