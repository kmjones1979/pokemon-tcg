// Trainer XP — meta progression across matches.
//
// Endpoints:
//   GET  /me/xp        -> { xp, level, nextLevelAt, progress }
//   POST /me/xp/grant  -> body { won, kos, crits, abandoned } -> { gained, xp, level, leveledUp }
//
// XP rules:
//   - Win:     +100
//   - Loss:    +40 (still earn something for trying)
//   - Per KO:  +20
//   - Per crit:+10 (small bonus for crit-KOs)
//   - Concede / disconnect (abandoned): +10 only
//   - Daily-streak claim (separate flow) doesn't grant XP.
//
// Rate-limit-by-cooldown isn't strictly needed because the server is the
// only sane source of `won/kos/crits` — solo trusts the client (anti-cheat
// is the daily-streak session check), multiplayer is server-authoritative.

const MAX_LEVEL = 99;

// XP curve: hand-tuned thresholds for L1-L10 (preserves the existing
// early-game pacing every current account is on), then a deterministic
// formula extends the curve to L99. The formula picks a delta that
// continues the trend of the L1-L10 deltas (each level adds another
// +200 to the per-level XP requirement, starting from the L9→L10
// delta of 1200). Climbing from L10 → L99 is intentionally a long
// journey — the cap shouldn't feel reachable in a single sprint.
const XP_THRESHOLDS_HEAD = [
  /* lvl 1 */ 0,
  /* lvl 2 */ 100,
  /* lvl 3 */ 300,
  /* lvl 4 */ 600,
  /* lvl 5 */ 1000,
  /* lvl 6 */ 1500,
  /* lvl 7 */ 2200,
  /* lvl 8 */ 3000,
  /* lvl 9 */ 4000,
  /* lvl10 */ 5200,
];
const XP_THRESHOLDS = (() => {
  const out = XP_THRESHOLDS_HEAD.slice();
  // L11..L99 — formula-based. Delta grows linearly: L(n) - L(n-1) =
  // 1200 + (n - 10) * 200. So L11→L12 = 1400, L12→L13 = 1600, etc.
  // Total XP to reach L99 ends up ~1,000,000 — long-haul.
  for (let n = 11; n <= MAX_LEVEL; n++) {
    const prev = out[n - 2]; // out is 0-indexed; out[n-2] is threshold to reach level (n-1)
    const delta = 1200 + (n - 10) * 200;
    out.push(prev + delta);
  }
  return out;
})();

function levelFromXp(xp) {
  let lvl = 1;
  for (let i = 0; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]) lvl = i + 1;
  }
  return Math.min(MAX_LEVEL, lvl);
}

function nextLevelAt(xp) {
  for (const t of XP_THRESHOLDS) if (t > xp) return t;
  return XP_THRESHOLDS[XP_THRESHOLDS.length - 1];
}

function mount(app, supabase) {
  app.get("/me/xp", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const { data } = await supabase
      .from("users")
      .select("trainer_xp")
      .eq("id", req.user.id)
      .maybeSingle();
    const xp = data?.trainer_xp || 0;
    const level = levelFromXp(xp);
    const nextAt = nextLevelAt(xp);
    const prevAt = XP_THRESHOLDS[level - 1] || 0;
    const span = Math.max(1, nextAt - prevAt);
    res.json({
      xp, level,
      nextLevelAt: nextAt,
      progressInLevel: xp - prevAt,
      spanForLevel: span,
    });
  });

  app.post("/me/xp/grant", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const { won = false, kos = 0, crits = 0, abandoned = false } = req.body || {};
    let gained = 0;
    if (abandoned) gained = 10;
    else if (won) gained = 100;
    else gained = 40;
    gained += Math.max(0, Math.min(20, Number(kos) || 0)) * 20;
    gained += Math.max(0, Math.min(20, Number(crits) || 0)) * 10;

    const { data: cur } = await supabase
      .from("users")
      .select("trainer_xp, match_win_streak, match_win_streak_best")
      .eq("id", req.user.id)
      .maybeSingle();
    const before = cur?.trainer_xp || 0;
    let newStreak = cur?.match_win_streak || 0;
    let bestStreak = cur?.match_win_streak_best || 0;
    if (won) {
      newStreak += 1;
      if (newStreak > bestStreak) bestStreak = newStreak;
    } else if (!abandoned) {
      newStreak = 0;
    }
    // Streak milestone bonus XP: +50 at 3, +100 at 5, +250 at 10.
    let streakBonus = 0;
    let streakMilestone = null;
    if (won) {
      if (newStreak === 3)  { streakBonus = 50;  streakMilestone = "3-streak!"; }
      if (newStreak === 5)  { streakBonus = 100; streakMilestone = "5-streak!"; }
      if (newStreak === 10) { streakBonus = 250; streakMilestone = "10-streak!"; }
    }
    const after = before + gained + streakBonus;
    const prevLevel = levelFromXp(before);
    const newLevel = levelFromXp(after);
    await supabase
      .from("users")
      .update({
        trainer_xp: after,
        match_win_streak: newStreak,
        match_win_streak_best: bestStreak,
      })
      .eq("id", req.user.id);

    res.json({
      gained: gained + streakBonus,
      xp: after,
      level: newLevel,
      leveledUp: newLevel > prevLevel,
      winStreak: newStreak,
      bestStreak,
      streakBonus,
      streakMilestone,
    });
  });
}

module.exports = { mount, levelFromXp, nextLevelAt, MAX_LEVEL, XP_THRESHOLDS };
