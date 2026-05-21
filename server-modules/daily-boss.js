// Daily Boss — Wordle-style viral mechanic.
//
// One boss per UTC day, identical for every player. Each player gets ONE
// attempt per day. After the match the client builds a small spoiler-free
// share string ("Daily #142 Mewtwo · ✅ Won · 11 turns · ★★★★☆") that
// they can paste anywhere with a link back to today's challenge.
//
// Endpoints:
//   GET  /api/daily/today                 — { dayNumber, dateKey, boss, deck, phaseRules, summonCards, alreadyPlayed }
//   POST /me/daily/start                  — issues a session id (anti-cheat)
//   POST /me/daily/end                    — { sessionId, won, turns, hpLeft, kos } → records result, returns share string
//   GET  /api/daily/leaderboard           — top results today
//   GET  /api/daily/stats                 — { todayPlayed, todayWon, totalAttempts } public counters
//
// Daily boss generation is deterministic from the date key, so it doesn't
// matter which Lambda instance the request lands on — everyone gets the
// same fight.

const { toCard, buildDeck } = require("../shared/deck-builder");
const { bumpDailyStats } = require("./quests");

// Curated daily-boss pool. The day index modulo POOL_SIZE picks the boss.
// Each entry is a high-tier or iconic Pokémon with a phase-rule kit. We
// keep the pool large enough that one boss recurs at most weekly.
const POOL = [
  { id: 150, name: "Mewtwo",     types: ["psychic"],        hp: 80, atk: 11, ability: "sabrina", rules: ["buff", "ignoreDef"] },
  { id: 149, name: "Dragonite",  types: ["dragon", "flying"], hp: 75, atk: 10, ability: "lance",   rules: ["buff", "aoe"] },
  { id: 6,   name: "Charizard",  types: ["fire", "flying"], hp: 65, atk: 10, ability: "pikachu", rules: ["buff", "aoe"] },
  { id: 248, name: "Tyranitar",  types: ["rock", "dark"],   hp: 80, atk: 9,  ability: "brock",   rules: ["buff", "ignoreDef"] },
  { id: 445, name: "Garchomp",   types: ["dragon", "ground"], hp: 75, atk: 11, ability: "lance",   rules: ["buff", "ignoreDef"] },
  { id: 144, name: "Articuno",   types: ["ice", "flying"],  hp: 65, atk: 9,  ability: "misty",   rules: ["buff", "aoe"] },
  { id: 145, name: "Zapdos",     types: ["electric", "flying"], hp: 65, atk: 9, ability: "pikachu", rules: ["buff"] },
  { id: 146, name: "Moltres",    types: ["fire", "flying"], hp: 65, atk: 10, ability: "pikachu", rules: ["buff", "aoe"] },
  { id: 376, name: "Metagross",  types: ["steel", "psychic"], hp: 80, atk: 9, ability: "steven",  rules: ["buff"] },
  { id: 282, name: "Gardevoir",  types: ["psychic", "fairy"], hp: 60, atk: 10, ability: "sabrina", rules: ["buff"] },
  { id: 643, name: "Reshiram",   types: ["dragon", "fire"], hp: 78, atk: 10, ability: "lance",   rules: ["buff", "ignoreDef"] },
  { id: 644, name: "Zekrom",     types: ["dragon", "electric"], hp: 78, atk: 10, ability: "pikachu", rules: ["buff", "ignoreDef"] },
  { id: 716, name: "Xerneas",    types: ["fairy"],          hp: 70, atk: 9,  ability: "sabrina", rules: ["buff"] },
  { id: 384, name: "Rayquaza",   types: ["dragon", "flying"], hp: 80, atk: 11, ability: "lance",  rules: ["buff", "ignoreDef"] },
  { id: 130, name: "Gyarados",   types: ["water", "flying"], hp: 70, atk: 10, ability: "misty",  rules: ["buff", "aoe"] },
  { id: 65,  name: "Alakazam",   types: ["psychic"],        hp: 55, atk: 11, ability: "sabrina", rules: ["buff"] },
  { id: 487, name: "Giratina",   types: ["ghost", "dragon"], hp: 80, atk: 10, ability: "sabrina", rules: ["buff", "ignoreDef"] },
  { id: 658, name: "Greninja",   types: ["water", "dark"],  hp: 60, atk: 11, ability: "misty",   rules: ["buff"] },
  { id: 887, name: "Dragapult",  types: ["dragon", "ghost"], hp: 65, atk: 11, ability: "lance",  rules: ["buff", "aoe"] },
  { id: 493, name: "Arceus",     types: ["normal"],         hp: 88, atk: 11, ability: "lance",   rules: ["buff", "ignoreDef", "aoe"] },
];

function todayDateKey(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Epoch: 2026-01-01 = Daily #1. Each subsequent UTC day increments.
const EPOCH = new Date(Date.UTC(2026, 0, 1)).getTime();
function dayNumberFor(dateKey) {
  const t = new Date(dateKey + "T00:00:00Z").getTime();
  return Math.max(1, Math.floor((t - EPOCH) / 86_400_000) + 1);
}

function bossForDay(dayNumber) {
  return POOL[(dayNumber - 1) % POOL.length];
}

async function buildDailyDeck(supabase, boss, dayNumber) {
  // Deterministic-ish boss deck: 2x anchor (bumped) + thematic type
  // supports + tier-1 filler. Boss anchor is flagged legendary so it gets
  // holo treatment.
  const { data: anchorRow } = await supabase.from("pokemon").select("*").eq("id", boss.id).maybeSingle();
  if (!anchorRow) throw new Error(`Pokemon ${boss.id} missing`);
  const anchor = { ...toCard(anchorRow), cardHp: Math.max(toCard(anchorRow).cardHp, Math.round(boss.hp / 4)), cardAttack: Math.max(toCard(anchorRow).cardAttack, boss.atk), is_legendary: true };
  let { data: pool } = await supabase.from("pokemon")
    .select("*").overlaps("types", boss.types).order("hp", { ascending: false }).limit(150);
  pool = (pool || []).map(toCard).filter((c) => c.id !== boss.id);
  // Seeded shuffle so the boss's supporting deck stays consistent across
  // every player's match today.  Hashing day+id into a 32-bit seed.
  const seed = (dayNumber * 2654435761) >>> 0;
  let rng = seed;
  const next = () => { rng = (rng * 16807 + 17) >>> 0; return rng / 0xffffffff; };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const deck = [anchor, anchor];
  const seen = new Set([boss.id]);
  for (const c of pool) {
    if (deck.length >= 22) break;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    deck.push(c, c);
  }
  // Fill with low-tier filler.
  const { data: filler } = await supabase.from("pokemon").select("*").lte("hp", 50).limit(40);
  const fillerCards = (filler || []).map(toCard).filter((c) => !seen.has(c.id));
  while (deck.length < 30 && fillerCards.length) deck.push(fillerCards.shift());
  return deck.slice(0, 30);
}

function rulesToPhaseEffects(rules, boss) {
  // The boss has two phases: 100% HP and 50% HP. Phase 2 fires the rules.
  const effects = [];
  if (rules.includes("buff"))      effects.push({ kind: "buff", amount: 3 });
  if (rules.includes("ignoreDef")) effects.push({ kind: "ignoreDef" });
  if (rules.includes("aoe"))       effects.push({ kind: "aoe", amount: 3 });
  return [{ fromHpFraction: 0.5, effects }];
}

// Build a small block of unicode squares for the share string. Players can
// glance at a result and compare quickly.
function starsForResult({ won, turns, hpLeft, hpMax }) {
  if (!won) return "💀";
  // Star out of 5 — turns/speed + HP remaining.
  let stars = 5;
  if (turns > 12) stars -= 1;
  if (turns > 18) stars -= 1;
  if ((hpLeft / hpMax) < 0.5) stars -= 1;
  if ((hpLeft / hpMax) < 0.25) stars -= 1;
  stars = Math.max(1, stars);
  return "★".repeat(stars) + "☆".repeat(5 - stars);
}

// Sessions were a per-process Map, which broke on Vercel Fluid Compute:
// /me/daily/start would land on instance A but /me/daily/end could route
// to instance B, which had no record of the session → "No session." Now
// stored in the shared KV (Redis or in-memory fallback) keyed by id.
const store = require("./state-store");
const DAILY_MIN_DURATION_MS = 30 * 1000;
const DAILY_SESSION_TTL_SEC = 60 * 60; // 1 hour — same as the in-memory GC

function mount(app, supabase, getPokedex) {
  async function loadDex() {
    const v = getPokedex();
    return v && typeof v.then === "function" ? await v : v;
  }

  // Cache today's deck + phase rules per process so repeated requests don't
  // re-hit Supabase. Refreshes when the date rolls over.
  let _cache = { dateKey: null, payload: null };
  async function getTodayPayload() {
    const dateKey = todayDateKey();
    if (_cache.dateKey === dateKey && _cache.payload) return _cache.payload;
    if (!supabase) throw new Error("Supabase not available");
    const dayNumber = dayNumberFor(dateKey);
    const boss = bossForDay(dayNumber);
    const deck = await buildDailyDeck(supabase, boss, dayNumber);
    const phaseRules = rulesToPhaseEffects(boss.rules, boss);
    const payload = {
      dayNumber,
      dateKey,
      boss: {
        displayName: boss.name,
        maxHp: boss.hp,
        types: boss.types,
        anchorPokemonId: boss.id,
        ability: boss.ability,
      },
      deck,
      phaseRules,
      summonCards: {},
    };
    _cache = { dateKey, payload };
    return payload;
  }

  app.get("/api/daily/today", async (req, res) => {
    try {
      const payload = await getTodayPayload();
      let alreadyPlayed = null;
      if (req.user && supabase) {
        const { data } = await supabase.from("daily_results")
          .select("won, turns, hp_left, kos")
          .eq("user_id", req.user.id)
          .eq("challenge_date", payload.dateKey)
          .maybeSingle();
        alreadyPlayed = data || null;
      }
      res.json({ ...payload, alreadyPlayed });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/me/daily/start", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const dateKey = todayDateKey();
    // Already played today?
    if (supabase) {
      const { data } = await supabase.from("daily_results")
        .select("won")
        .eq("user_id", req.user.id)
        .eq("challenge_date", dateKey)
        .maybeSingle();
      if (data) return res.status(409).json({ error: "Already played today. Come back tomorrow." });
    }
    const sessionId = require("crypto").randomBytes(12).toString("base64url");
    await store.kvSet(`daily-sess:${sessionId}`, {
      userId: req.user.id, dateKey, startedAt: Date.now(),
    }, DAILY_SESSION_TTL_SEC);
    res.json({ sessionId, dateKey });
  });

  app.post("/me/daily/end", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const { sessionId, won, turns = 0, hpLeft = 0, kos = 0 } = req.body || {};
    // kvTake = atomic get+delete so a retry can't double-count.
    const session = await store.kvTake(`daily-sess:${sessionId}`);
    if (!session) return res.status(400).json({ error: "No session." });
    if (session.userId !== req.user.id) return res.status(403).json({ error: "Wrong user." });
    if (Date.now() - session.startedAt < DAILY_MIN_DURATION_MS) {
      return res.status(400).json({ error: "Match too short." });
    }
    const dayNumber = dayNumberFor(session.dateKey);
    const boss = bossForDay(dayNumber);
    if (supabase) {
      // Upsert with onConflict so a network retry doesn't 500.
      await supabase.from("daily_results")
        .upsert({
          user_id: req.user.id,
          challenge_date: session.dateKey,
          won: !!won,
          turns: Math.max(0, Number(turns) || 0),
          hp_left: Math.max(0, Number(hpLeft) || 0),
          kos: Math.max(0, Number(kos) || 0),
        }, { onConflict: "user_id,challenge_date" });
      // Daily boss counts toward the per-day quest counters — without
      // this, "Win N matches today" never ticked for daily-boss players.
      await bumpDailyStats(supabase, req.user.id, {
        matches: 1,
        wins: won ? 1 : 0,
        kos: Math.max(0, Number(kos) || 0),
      });
    }
    const stars = starsForResult({ won: !!won, turns, hpLeft, hpMax: 30 });
    // Build the share string + URL — kept short and spoiler-free.
    const origin = (req.headers["x-forwarded-host"] && `https://${req.headers["x-forwarded-host"]}`) || (req.headers.host && `https://${req.headers.host}`) || "";
    const url = `${origin}/?d=${dayNumber}`;
    const shareText = won
      ? `Pokémon TCG Daily #${dayNumber} · ${boss.name}\n${stars}  ✅ ${turns} turn${turns === 1 ? "" : "s"} · ${hpLeft} HP left\nplay: ${url}`
      : `Pokémon TCG Daily #${dayNumber} · ${boss.name}\n${stars}  ❌ Survived ${turns} turns\nplay: ${url}`;
    res.json({ ok: true, dayNumber, dateKey: session.dateKey, stars, shareText, shareUrl: url, bossName: boss.name });
  });

  app.get("/api/daily/leaderboard", async (req, res) => {
    if (!supabase) return res.json({ rows: [], dateKey: todayDateKey() });
    const dateKey = todayDateKey();
    // Top: winners first, fewer turns better, more HP better.
    const { data, error } = await supabase
      .from("daily_results")
      .select("user_id, won, turns, hp_left, kos, users(display_name)")
      .eq("challenge_date", dateKey)
      .order("won", { ascending: false })
      .order("turns", { ascending: true })
      .order("hp_left", { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    const rows = (data || []).map((r, i) => ({
      rank: i + 1,
      displayName: r.users?.display_name || "Trainer",
      won: r.won, turns: r.turns, hpLeft: r.hp_left, kos: r.kos,
      isYou: req.user && r.user_id === req.user.id,
    }));
    res.json({ rows, dateKey, dayNumber: dayNumberFor(dateKey) });
  });

  // Public stats — for the home page's "X players have played today" hook.
  app.get("/api/daily/stats", async (req, res) => {
    if (!supabase) return res.json({ todayPlayed: 0, todayWon: 0 });
    const dateKey = todayDateKey();
    const [{ count: played }, { count: won }] = await Promise.all([
      supabase.from("daily_results").select("*", { count: "exact", head: true }).eq("challenge_date", dateKey),
      supabase.from("daily_results").select("*", { count: "exact", head: true }).eq("challenge_date", dateKey).eq("won", true),
    ]);
    res.json({ todayPlayed: played || 0, todayWon: won || 0, dateKey, dayNumber: dayNumberFor(dateKey) });
  });
}

module.exports = { mount, todayDateKey, dayNumberFor, bossForDay, starsForResult, POOL };
