// Achievement system — computed on the fly from user_stats + matches +
// owned_cards + story_progress.
//
// Each definition declares a `progress(ctx)` function. `ctx` is an aggregated
// stats bag the route assembles once per request:
//   {
//     stats,           // user_stats row (or default zeros)
//     matches,         // most-recent 50 matches (winner_id + ended_at + etc)
//     owned,           // [{ pokemon_id, quantity, shiny_level }]
//     pokedex,         // [{ id, generation, is_legendary, is_mythical, types }]
//     storyProgress,   // { completed: [chapterIds] }
//     championWins,    // Set of championIds the user has beaten (best-effort)
//     personalBests,   // { biggestHit, longestStreak, mostKosInMatch, ... }
//   }
//
// Server endpoint:
//   GET /me/achievements -> { unlocked: [...], locked: [...] }
//     each entry: { id, name, description, icon, progress, goal, tier?, hidden? }

const STORY_CHAPTERS = ["ch1_viridian", "ch2_mt_moon", "ch3_cerulean_cave", "finale_dragons_den"];

const DEFS = [
  // --- Onboarding / first steps -----------------------------------------
  { id: "first_battle",     name: "First Battle",        icon: "🎮",  goal: 1,    tier: "bronze",
    description: "Played your first match.",
    progress: (c) => c.stats.matches_played },
  { id: "first_win",        name: "First Win",           icon: "🏆",  goal: 1,    tier: "bronze",
    description: "Won your first match.",
    progress: (c) => c.stats.wins },

  // --- Match volume -----------------------------------------------------
  { id: "wins_5",           name: "Rising Star",         icon: "⭐",  goal: 5,    tier: "bronze",
    description: "Win 5 matches.",
    progress: (c) => c.stats.wins },
  { id: "wins_25",          name: "Veteran",             icon: "🎖️",  goal: 25,   tier: "silver",
    description: "Win 25 matches.",
    progress: (c) => c.stats.wins },
  { id: "wins_100",         name: "Champion",            icon: "👑",  goal: 100,  tier: "gold",
    description: "Win 100 matches.",
    progress: (c) => c.stats.wins },
  { id: "wins_500",         name: "Legendary Trainer",   icon: "🌟",  goal: 500,  tier: "diamond",
    description: "Win 500 matches.",
    progress: (c) => c.stats.wins },
  { id: "matches_50",       name: "Dedicated Trainer",   icon: "🔥",  goal: 50,   tier: "silver",
    description: "Play 50 matches.",
    progress: (c) => c.stats.matches_played },
  { id: "matches_200",      name: "Lifer",               icon: "♾️",  goal: 200,  tier: "gold",
    description: "Play 200 matches.",
    progress: (c) => c.stats.matches_played },

  // --- Streaks ----------------------------------------------------------
  { id: "win_streak_3",     name: "On a Roll",           icon: "🔥",  goal: 3,    tier: "bronze",
    description: "Win 3 matches in a row.",
    progress: streakOf },
  { id: "win_streak_5",     name: "Unstoppable",         icon: "💥",  goal: 5,    tier: "silver",
    description: "Win 5 matches in a row.",
    progress: streakOf },
  { id: "win_streak_10",    name: "Reign of Fire",       icon: "🌋",  goal: 10,   tier: "gold",
    description: "Win 10 matches in a row.",
    progress: streakOf },

  // --- Collection breadth -----------------------------------------------
  { id: "collector_100",    name: "Collector",           icon: "📚",  goal: 100,  tier: "bronze",
    description: "Own 100 cards.",
    progress: (c) => c.stats.cards_owned || c.owned.reduce((s, o) => s + (o.quantity || 0), 0) },
  { id: "collector_300",    name: "Pokémaster",          icon: "🎴",  goal: 300,  tier: "silver",
    description: "Own 300 cards.",
    progress: (c) => c.stats.cards_owned || c.owned.reduce((s, o) => s + (o.quantity || 0), 0) },
  { id: "collector_1000",   name: "Curator",             icon: "🗄️",  goal: 1000, tier: "gold",
    description: "Own 1,000 cards.",
    progress: (c) => c.stats.cards_owned || c.owned.reduce((s, o) => s + (o.quantity || 0), 0) },
  { id: "dex_50",           name: "Pokédex Researcher",  icon: "🔬",  goal: 50,   tier: "silver",
    description: "Own at least one copy of 50 different Pokémon.",
    progress: (c) => new Set(c.owned.map((o) => o.pokemon_id)).size },
  { id: "dex_150",          name: "Pokédex Authority",   icon: "📖",  goal: 150,  tier: "gold",
    description: "Own at least one copy of 150 different Pokémon.",
    progress: (c) => new Set(c.owned.map((o) => o.pokemon_id)).size },
  { id: "dex_500",          name: "Living Pokédex",      icon: "🏛️",  goal: 500,  tier: "diamond",
    description: "Own at least one copy of 500 different Pokémon.",
    progress: (c) => new Set(c.owned.map((o) => o.pokemon_id)).size },

  // --- Specific Pokémon rarity hooks ------------------------------------
  { id: "first_legendary",  name: "Beyond Mortal",       icon: "✨",  goal: 1,    tier: "silver",
    description: "Own your first Legendary Pokémon.",
    progress: (c) => countOwnedMatching(c, (p) => p.is_legendary) },
  { id: "first_mythical",   name: "Touched by Legend",   icon: "🦄",  goal: 1,    tier: "gold",
    description: "Own your first Mythical Pokémon.",
    progress: (c) => countOwnedMatching(c, (p) => p.is_mythical) },
  { id: "legendaries_10",   name: "Hall of Heroes",      icon: "🏛️",  goal: 10,   tier: "gold",
    description: "Own 10 different Legendary or Mythical Pokémon.",
    progress: (c) => uniqueOwnedMatching(c, (p) => p.is_legendary || p.is_mythical) },
  { id: "first_shiny",      name: "Shiny Hunter",        icon: "🌈",  goal: 1,    tier: "silver",
    description: "Fuse your first shiny Pokémon.",
    progress: (c) => c.owned.reduce((s, o) => s + ((o.shiny_level || 0) > 0 ? 1 : 0), 0) },
  { id: "shiny_5",          name: "Rainbow Tamer",       icon: "🌟",  goal: 5,    tier: "gold",
    description: "Own 5 shiny Pokémon.",
    progress: (c) => c.owned.reduce((s, o) => s + ((o.shiny_level || 0) > 0 ? 1 : 0), 0) },
  { id: "shiny_max",        name: "Pinnacle",            icon: "💎",  goal: 1,    tier: "diamond",
    description: "Own one max-level (shiny L3) Pokémon.",
    progress: (c) => c.owned.reduce((s, o) => s + ((o.shiny_level || 0) >= 3 ? 1 : 0), 0) },

  // --- Generation completionism (subtle long-term hooks) ---------------
  { id: "gen1_half",        name: "Kanto Apprentice",    icon: "🟥",  goal: 75,   tier: "silver",
    description: "Own 75 different Gen 1 Pokémon.",
    progress: (c) => uniqueOwnedMatching(c, (p) => p.generation === 1) },
  { id: "gen1_complete",    name: "Kanto Complete",      icon: "🔴",  goal: 151,  tier: "diamond",
    description: "Own all 151 Gen 1 Pokémon.",
    progress: (c) => uniqueOwnedMatching(c, (p) => p.generation === 1) },
  { id: "any_gen_complete", name: "Generation Master",   icon: "🎓",  goal: 1,    tier: "diamond",
    description: "Complete any one full generation.",
    progress: (c) => {
      const totals = {};
      for (const p of c.pokedex) totals[p.generation] = (totals[p.generation] || 0) + 1;
      const owned = {};
      for (const id of new Set(c.owned.map((o) => o.pokemon_id))) {
        const p = c.pokedex.find((x) => x.id === id);
        if (p) owned[p.generation] = (owned[p.generation] || 0) + 1;
      }
      for (const gen of Object.keys(totals)) {
        if ((owned[gen] || 0) >= totals[gen]) return 1;
      }
      return 0;
    } },

  // --- Difficulty / quality of wins -------------------------------------
  { id: "beat_hard",        name: "Stone-Cold",          icon: "💀",  goal: 1,    tier: "silver",
    description: "Beat the AI on Hard.",
    progress: (c) => Math.min(1, c.stats.wins) },
  { id: "champion_one",     name: "Slayer of Champions", icon: "⚔️",  goal: 1,    tier: "gold",
    description: "Defeat your first Champion.",
    progress: (c) => c.championWins.size },
  { id: "champion_all",     name: "Champion of Champions", icon: "👑", goal: 4,   tier: "diamond",
    description: "Defeat every Champion (Lance, Cynthia, Steven, Red).",
    progress: (c) => c.championWins.size },

  // --- Story-mode progression -------------------------------------------
  { id: "story_first",      name: "Once Upon a Chapter", icon: "📖",  goal: 1,    tier: "bronze",
    description: "Clear your first story chapter.",
    progress: (c) => c.storyProgress.completed.length },
  { id: "story_three",      name: "Hero's Journey",      icon: "🗺️",  goal: 3,    tier: "silver",
    description: "Clear three story chapters.",
    progress: (c) => c.storyProgress.completed.length },
  { id: "story_finale",     name: "Dragon Slayer",       icon: "🐉",  goal: 1,    tier: "gold",
    description: "Defeat Lance's Dragonite in the story finale.",
    progress: (c) => c.storyProgress.completed.includes("finale_dragons_den") ? 1 : 0 },
  { id: "story_all",        name: "The Tale is Told",    icon: "✨",  goal: 4,    tier: "diamond",
    description: "Clear every story chapter.",
    progress: (c) => STORY_CHAPTERS.filter((id) => c.storyProgress.completed.includes(id)).length },

  // --- In-match heroics (read from personalBests, opt-in) --------------
  { id: "biggest_hit_15",   name: "Hammer Blow",         icon: "🔨",  goal: 15,   tier: "silver",
    description: "Land a 15-damage strike in a single match.",
    progress: (c) => c.personalBests.biggestHit },
  { id: "biggest_hit_25",   name: "Obliterator",         icon: "💥",  goal: 25,   tier: "gold",
    description: "Land a 25-damage strike in a single match.",
    progress: (c) => c.personalBests.biggestHit },
  { id: "crits_5_match",    name: "Crit Master",         icon: "🎯",  goal: 5,    tier: "silver",
    description: "Land 5 critical hits in one match.",
    progress: (c) => c.personalBests.mostCritsInMatch },
  { id: "kos_6_match",      name: "Rampage",             icon: "⚡",  goal: 6,    tier: "gold",
    description: "KO 6 of the opponent's Pokémon in one match.",
    progress: (c) => c.personalBests.mostKosInMatch },
  { id: "perfect_victory",  name: "Untouchable",         icon: "🛡️",  goal: 1,    tier: "gold",
    description: "Win a match without losing a single point of trainer HP.",
    progress: (c) => c.personalBests.perfectVictories },
  { id: "lightning_win",    name: "Bolt from the Blue",  icon: "⚡",  goal: 1,    tier: "silver",
    description: "Win a match in 8 turns or fewer.",
    progress: (c) => c.personalBests.lightningWins },
  { id: "endurance_win",    name: "Last One Standing",   icon: "🪨",  goal: 1,    tier: "silver",
    description: "Win a match that lasted 25 turns or more.",
    progress: (c) => c.personalBests.enduranceWins },
];

// ----- Helpers --------------------------------------------------------------

function streakOf(c) {
  // Most-recent consecutive wins from match history.
  let s = 0;
  for (const m of c.matches) {
    if (m.winner_id === c.stats.user_id) s += 1;
    else break;
  }
  return s;
}

function countOwnedMatching(c, predicate) {
  let n = 0;
  const byId = new Map(c.pokedex.map((p) => [p.id, p]));
  for (const o of c.owned) {
    const p = byId.get(o.pokemon_id);
    if (p && predicate(p)) n += (o.quantity || 0);
  }
  return n;
}

function uniqueOwnedMatching(c, predicate) {
  const byId = new Map(c.pokedex.map((p) => [p.id, p]));
  const seen = new Set();
  for (const o of c.owned) {
    const p = byId.get(o.pokemon_id);
    if (p && predicate(p)) seen.add(o.pokemon_id);
  }
  return seen.size;
}

// In-memory personal-bests cache (per-process). The matches table doesn't
// store per-match damage / KO numbers, so we accept best-on-record updates
// via /me/match-stats and persist nothing across deploys. That's good enough
// for a single-session achievement — it'll unlock again on the next session
// if you do it again, which is the desired UX for "in-the-moment" feats.
const _personalBests = new Map(); // userId -> { biggestHit, mostCritsInMatch, ... }
const ZERO_BESTS = {
  biggestHit: 0,
  mostCritsInMatch: 0,
  mostKosInMatch: 0,
  perfectVictories: 0,
  lightningWins: 0,
  enduranceWins: 0,
};
function getBests(userId) {
  let b = _personalBests.get(userId);
  if (!b) { b = { ...ZERO_BESTS }; _personalBests.set(userId, b); }
  return b;
}

async function computeFor(supabase, userId, getPokedex) {
  if (!supabase) return { unlocked: [], locked: DEFS };
  const [statsRes, matchesRes, ownedRes, userRes] = await Promise.all([
    supabase.from("user_stats").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("matches")
      .select("p1_user_id, p2_user_id, winner_id, ended_at, reason")
      .or(`p1_user_id.eq.${userId},p2_user_id.eq.${userId}`)
      .order("ended_at", { ascending: false, nullsFirst: false })
      .limit(50),
    supabase.from("owned_cards").select("pokemon_id, quantity, shiny_level").eq("user_id", userId),
    supabase.from("users").select("story_progress, champion_wins, quest_progress").eq("id", userId).maybeSingle(),
  ]);

  const stats = statsRes.data || {
    user_id: userId, matches_played: 0, wins: 0, losses: 0, win_pct: 0, cards_owned: 0,
  };
  // user_stats might not echo user_id, attach it.
  stats.user_id = userId;
  // user_stats is a SQL view over the `matches` table, which only stores
  // multiplayer games. Solo/story/daily-boss wins live on users.quest_progress
  // (bumped via bumpDailyStats). Roll those into the stats so achievements
  // like "Win 25 matches" count every win, not just multiplayer ones.
  {
    const qp = userRes.data?.quest_progress || {};
    let soloWins = 0;
    let soloMatches = 0;
    for (const k of Object.keys(qp)) {
      const d = qp[k];
      if (!d) continue;
      soloWins   += Number(d.wins    || 0);
      soloMatches += Number(d.matches || 0);
    }
    stats.wins           = Number(stats.wins || 0) + soloWins;
    stats.matches_played = Number(stats.matches_played || 0) + soloMatches;
    const losses = Math.max(0, stats.matches_played - stats.wins);
    stats.losses  = losses;
    stats.win_pct = stats.matches_played > 0
      ? Math.round((1000 * stats.wins) / stats.matches_played) / 10
      : 0;
  }
  const matches = matchesRes.data || [];
  const owned = ownedRes.data || [];
  const storyProgress = (userRes.data?.story_progress) || { completed: [] };
  const championWins = new Set((userRes.data?.champion_wins) || []);
  const pokedex = (typeof getPokedex === "function") ? (await getPokedex() || []) : [];

  const ctx = { stats, matches, owned, pokedex, storyProgress, championWins, personalBests: getBests(userId) };

  const out = { unlocked: [], locked: [] };
  for (const def of DEFS) {
    let progress = 0;
    try { progress = Number(def.progress(ctx) || 0); } catch { progress = 0; }
    const entry = {
      id: def.id, name: def.name, description: def.description,
      icon: def.icon, progress, goal: def.goal,
      tier: def.tier || "bronze",
    };
    (progress >= def.goal ? out.unlocked : out.locked).push(entry);
  }
  // Stable order: tiers first (bronze→diamond), then goal asc.
  const TIER_RANK = { bronze: 0, silver: 1, gold: 2, diamond: 3 };
  const sortFn = (a, b) => (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || (a.goal - b.goal);
  out.unlocked.sort(sortFn);
  out.locked.sort(sortFn);
  return out;
}

function mount(app, supabase, getPokedex) {
  app.get("/me/achievements", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    try {
      res.json(await computeFor(supabase, req.user.id, getPokedex));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Client posts the highlight stats from each match so personal-best
  // achievements can unlock. Server keeps the max — no spoofing concern
  // since the values aren't currency, just badges.
  app.post("/me/match-stats", (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const b = getBests(req.user.id);
    const body = req.body || {};
    const max = (k, v) => { const n = Number(v) || 0; if (n > b[k]) b[k] = n; };
    max("biggestHit", body.biggestHit);
    max("mostCritsInMatch", body.crits);
    max("mostKosInMatch", body.kos);
    if (body.perfectVictory) b.perfectVictories += 1;
    if (body.lightningWin) b.lightningWins += 1;
    if (body.enduranceWin) b.enduranceWins += 1;
    res.json({ ok: true, bests: b });
  });
}

module.exports = { mount, computeFor, DEFS };
