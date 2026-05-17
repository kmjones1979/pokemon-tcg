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

const XP_THRESHOLDS = [
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

function levelFromXp(xp) {
  let lvl = 1;
  for (let i = 0; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]) lvl = i + 1;
  }
  return Math.min(10, lvl);
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
      .select("trainer_xp")
      .eq("id", req.user.id)
      .maybeSingle();
    const before = cur?.trainer_xp || 0;
    const after = before + gained;
    const prevLevel = levelFromXp(before);
    const newLevel = levelFromXp(after);
    await supabase
      .from("users")
      .update({ trainer_xp: after })
      .eq("id", req.user.id);

    res.json({
      gained,
      xp: after,
      level: newLevel,
      leveledUp: newLevel > prevLevel,
    });
  });
}

module.exports = { mount, levelFromXp, nextLevelAt };
