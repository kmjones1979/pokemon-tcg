// Achievement system — computed on the fly from user_stats + matches.
// No new schema. Each definition declares a `check(stats, matches)` function
// that returns the truthy `unlock_value` (counter / boolean) once earned.
//
// Server endpoint:
//   GET /me/achievements -> { unlocked: [...], locked: [...] }
//     where each entry is { id, name, description, icon, progress, goal? }

const DEFS = [
  {
    id: "first_battle",
    name: "First Battle",
    description: "Played your first match.",
    icon: "🎮",
    goal: 1,
    progress: (stats) => stats.matches_played,
  },
  {
    id: "first_win",
    name: "First Win",
    description: "Won your first match.",
    icon: "🏆",
    goal: 1,
    progress: (stats) => stats.wins,
  },
  {
    id: "wins_5",
    name: "Rising Star",
    description: "Win 5 matches.",
    icon: "⭐",
    goal: 5,
    progress: (stats) => stats.wins,
  },
  {
    id: "wins_25",
    name: "Veteran",
    description: "Win 25 matches.",
    icon: "🎖️",
    goal: 25,
    progress: (stats) => stats.wins,
  },
  {
    id: "wins_100",
    name: "Champion",
    description: "Win 100 matches.",
    icon: "👑",
    goal: 100,
    progress: (stats) => stats.wins,
  },
  {
    id: "matches_50",
    name: "Dedicated Trainer",
    description: "Play 50 matches.",
    icon: "🔥",
    goal: 50,
    progress: (stats) => stats.matches_played,
  },
  {
    id: "collector_100",
    name: "Collector",
    description: "Own 100 cards.",
    icon: "📚",
    goal: 100,
    progress: (stats) => stats.cards_owned,
  },
  {
    id: "collector_300",
    name: "Pokémaster",
    description: "Own 300 cards.",
    icon: "🌟",
    goal: 300,
    progress: (stats) => stats.cards_owned,
  },
  {
    id: "win_streak_3",
    name: "On a Roll",
    description: "Win 3 matches in a row.",
    icon: "🔥",
    goal: 3,
    progress: (stats, matches) => {
      // Count consecutive wins at the END of the user's match history (most recent first)
      let s = 0;
      for (const m of matches) {
        if (m.winner_id === stats.user_id) s += 1;
        else break;
      }
      return s;
    },
  },
  {
    id: "beat_hard",
    name: "Stone-Cold",
    description: "Beat the AI on Hard.",
    icon: "💀",
    goal: 1,
    // We don't track difficulty in matches table; approximate by "win without
    // signed-in p1+p2" (i.e. vs-AI win). For now, any signed-in win counts —
    // we'll wire a proper difficulty column later.
    progress: (stats) => Math.min(1, stats.wins),
  },
];

async function computeFor(supabase, userId) {
  if (!supabase) return { unlocked: [], locked: DEFS };
  const { data: stats } = await supabase
    .from("user_stats")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  const safeStats = stats || {
    user_id: userId, matches_played: 0, wins: 0, losses: 0, win_pct: 0, cards_owned: 0,
  };
  const { data: matches } = await supabase
    .from("matches")
    .select("p1_user_id, p2_user_id, winner_id, ended_at")
    .or(`p1_user_id.eq.${userId},p2_user_id.eq.${userId}`)
    .order("ended_at", { ascending: false, nullsFirst: false })
    .limit(30);

  const out = { unlocked: [], locked: [] };
  for (const def of DEFS) {
    const progress = Number(def.progress(safeStats, matches || []) || 0);
    const entry = {
      id: def.id,
      name: def.name,
      description: def.description,
      icon: def.icon,
      progress,
      goal: def.goal,
    };
    if (progress >= def.goal) out.unlocked.push(entry);
    else out.locked.push(entry);
  }
  return out;
}

function mount(app, supabase) {
  app.get("/me/achievements", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    try {
      res.json(await computeFor(supabase, req.user.id));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { mount, computeFor, DEFS };
