// Story Mode (rebuilt) — runs the REGULAR 1v1 engine with a custom boss
// loaded as the AI side, just like a champion fight. The boss has more
// trainer HP, a curated themed deck, and a small set of "phase effects"
// the client applies at HP thresholds (heal, summon, attack buff, AoE).
//
// Routes:
//   GET  /api/story/chapters             — list with unlock state
//   GET  /api/story/chapter/:id/intro    — narrative lines
//   GET  /api/story/chapter/:id/deck     — boss deck + phase rules
//   POST /me/story/end                   — record clear, return reward offer
//
// Story progress lives on users.story_progress (jsonb). Code degrades
// gracefully if that column hasn't been added yet (try/catch).

const { toCard, buildDeck } = require("../shared/deck-builder");
const { CHAPTERS, getChapter, chapterMeta } = require("../shared/story-chapters");
const { rollPicks, createOffer } = require("./rewards");
const { bumpDailyStats } = require("./quests");

const STORY_CHAPTER_IDS = CHAPTERS.map((c) => c.id);

// Boss "anchor card" overrides — applied on top of the regular toCard()
// output so the chapter's centerpiece feels like a boss, not a regular
// tier-X mon. Keys are pokemon ids.
function bumpAnchorCard(card, chapter) {
  const anchor = chapter.boss.anchorPokemonId;
  if (card.id !== anchor) return card;
  return {
    ...card,
    cardHp: Math.max(card.cardHp, Math.round(chapter.boss.maxHp / 4)),
    cardAttack: Math.max(card.cardAttack, chapter.boss.attack),
    // Brand it as legendary so it gets the holo treatment regardless of
    // what the pokedex says about its rarity.
    is_legendary: true,
  };
}

async function buildBossDeck(supabase, chapter) {
  const anchor = chapter.boss.anchorPokemonId;
  // The 30-card boss deck: anchor card x2, plus thematic type-matched
  // support, plus filler.
  const typeFilter = chapter.boss.types;
  const { data: anchorRow } = await supabase.from("pokemon").select("*").eq("id", anchor).maybeSingle();
  const anchorCard = anchorRow ? bumpAnchorCard(toCard(anchorRow), chapter) : null;

  let { data: pool } = await supabase
    .from("pokemon")
    .select("*")
    .overlaps("types", typeFilter)
    .order("hp", { ascending: false })
    .limit(200);
  pool = (pool || []).map(toCard);
  // Mix in some low-tier filler so the boss has cheap turn-1 plays.
  let { data: filler } = await supabase
    .from("pokemon")
    .select("*")
    .order("hp", { ascending: true })
    .limit(60);
  filler = (filler || []).map(toCard).filter((c) => c.tier <= 2);

  const deck = [];
  if (anchorCard) { deck.push(anchorCard, anchorCard); }
  // Shuffle pool deterministically-enough.
  const shuffleInPlace = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  shuffleInPlace(pool);
  shuffleInPlace(filler);
  const seen = new Set([anchor]);
  for (const c of pool) {
    if (deck.length >= 22) break;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    deck.push(c, c);
  }
  for (const c of filler) {
    if (deck.length >= 30) break;
    deck.push(c);
  }
  // Pad with the regular deck builder if we somehow ran short.
  if (deck.length < 30) {
    const { data: anything } = await supabase.from("pokemon").select("*").limit(60);
    const extras = (anything || []).map(toCard);
    while (deck.length < 30 && extras.length) deck.push(extras.shift());
  }
  const trimmed = deck.slice(0, 30);
  // Append the standard 10-spell section so the boss can also disrupt,
  // heal, and evolve mid-fight — keeps Story Mode parity with /api/deck
  // and PvP. The boss's AI uses the same chooseHandIndex +
  // aiPickSpellTarget heuristics as multiplayer.
  const { allSpellCards } = require("../shared/spell-cards");
  const { DEFAULT_SPELL_COUNT } = require("../shared/deck-builder");
  const spellPool = allSpellCards();
  if (spellPool.length > 0) {
    for (let i = 0; i < DEFAULT_SPELL_COUNT; i++) {
      trimmed.push(spellPool[Math.floor(Math.random() * spellPool.length)]);
    }
  }
  return trimmed;
}

// Translate the chapter's phase data into a compact "phase rules" payload
// the client can apply directly to its state object. We don't bring the
// full story-engine pattern over — just the most flavorful effects:
//   heal       — boss heals X HP when threshold crossed
//   buff       — all boss field cards get +X attack permanently
//   ignoreDef  — boss attacks ignore defense from this phase on
//   summon     — add specific cards to boss hand (free plays)
//   aoe        — deal X direct damage to every player field card
//   transform  — replace the boss's anchor card with a stronger version
function summarisePhaseRules(chapter) {
  const rules = [];
  for (const phase of chapter.boss.phases) {
    if (phase.fromHpFraction >= 1) continue; // skip phase 1 (always active)
    const r = { fromHpFraction: phase.fromHpFraction, effects: [] };
    if (phase.attackBonus) r.effects.push({ kind: "buff", amount: phase.attackBonus });
    if (phase.ignoreDefense) r.effects.push({ kind: "ignoreDef" });
    if (phase.summonOnEntry?.pokemonIds?.length) {
      r.effects.push({ kind: "summon", pokemonIds: phase.summonOnEntry.pokemonIds, note: phase.summonOnEntry.note });
    }
    // Surface AoE if any move in the pattern targets "all"
    const hasAoe = (phase.attackPattern || []).some((mk) => chapter.boss.moves?.[mk]?.target === "all");
    if (hasAoe) r.effects.push({ kind: "aoe", amount: 3 });
    rules.push(r);
  }
  // Mid-fight transformation (e.g. Onix → Steelix).
  if (chapter.boss.transformTo) {
    rules.push({
      fromHpFraction: chapter.boss.transformAt || 0.5,
      effects: [{
        kind: "transform",
        anchorPokemonId: chapter.boss.transformTo.anchorPokemonId,
        displayName: chapter.boss.transformTo.displayName,
        attackBonus: chapter.boss.transformTo.attackBonus || 0,
        defenseBonus: chapter.boss.transformTo.defenseBonus || 0,
        note: chapter.boss.transformTo.flavor,
      }],
    });
  }
  // Sort thresholds high → low so client matches "first crossed".
  rules.sort((a, b) => b.fromHpFraction - a.fromHpFraction);
  return rules;
}

async function getUserProgress(supabase, userId) {
  if (!supabase || !userId) return { completed: [] };
  try {
    const { data } = await supabase.from("users").select("story_progress").eq("id", userId).maybeSingle();
    return data?.story_progress || { completed: [] };
  } catch {
    return { completed: [] };
  }
}

async function recordChapterCompletion(supabase, userId, chapterId) {
  if (!supabase || !userId) return;
  try {
    const { data } = await supabase.from("users").select("story_progress").eq("id", userId).maybeSingle();
    const progress = data?.story_progress || { completed: [] };
    if (!progress.completed.includes(chapterId)) progress.completed.push(chapterId);
    progress.lastClearedAt = new Date().toISOString();
    await supabase.from("users").update({ story_progress: progress }).eq("id", userId);
  } catch (err) {
    console.warn("[story] progress write failed:", err.message);
  }
}

function chapterUnlocked(chapter, progress) {
  if (chapter.chapterNumber === 1) return true;
  const prev = CHAPTERS.find((c) => c.chapterNumber === chapter.chapterNumber - 1);
  return prev ? progress.completed.includes(prev.id) : true;
}

// Anti-cheat sessions stored in the shared KV so /me/story/end can read
// state regardless of which Vercel instance handled /me/story/start.
const store = require("./state-store");
const STORY_MIN_DURATION_MS = 30 * 1000;
const STORY_SESSION_TTL_SEC = 60 * 60;

function mount(app, supabase, getPokedex) {
  async function loadDex() {
    const v = getPokedex();
    return v && typeof v.then === "function" ? await v : v;
  }

  app.get("/api/story/chapters", async (req, res) => {
    const progress = await getUserProgress(supabase, req.user?.id);
    const list = chapterMeta().map((c) => ({
      ...c,
      unlocked: chapterUnlocked(c, progress),
      completed: progress.completed.includes(c.id),
    }));
    res.json({ chapters: list, progress });
  });

  app.get("/api/story/chapter/:id/intro", (req, res) => {
    const chapter = getChapter(req.params.id);
    if (!chapter) return res.status(404).json({ error: "Unknown chapter." });
    // Hydrate readAlong sections with audioUrls from the TTS manifest
    // (same pattern as Reading Mode). Sections without audio still
    // surface with audioUrl=null so the UI can show "Audio coming
    // soon" gracefully.
    let readAlong = null;
    if (Array.isArray(chapter.readAlong)) {
      const { loadManifest } = require("./reading-mode");
      const manifest = loadManifest();
      readAlong = chapter.readAlong.map((sec) => {
        const entry = manifest[`chapter-intro/${chapter.id}/${sec.id}`];
        return entry?.audioUrl
          ? { ...sec, audioUrl: entry.audioUrl }
          : { ...sec, audioUrl: null };
      });
    }
    res.json({
      // Kid-friendly read-along (slice 5d). Pre-existing
      // `intro_v1` is also returned as `intro` for backwards
      // compatibility — old clients still see the auto-timed lines.
      readAlong,
      intro: chapter.intro_v1 || chapter.intro || [],
      flavor: chapter.flavor,
      locale: chapter.locale,
      enemyTrainerName: chapter.enemyTrainerName,
      bossName: chapter.boss.displayName,
      bossSpriteId: chapter.boss.anchorPokemonId,
    });
  });

  app.get("/api/story/chapter/:id/deck", async (req, res) => {
    const chapter = getChapter(req.params.id);
    if (!chapter) return res.status(404).json({ error: "Unknown chapter." });
    if (!supabase) return res.status(503).json({ error: "DB unavailable." });
    const progress = await getUserProgress(supabase, req.user?.id);
    if (!chapterUnlocked(chapter, progress)) return res.status(403).json({ error: "Chapter locked." });
    try {
      const deck = await buildBossDeck(supabase, chapter);
      // Pre-fetch any pokémon the boss can summon during phases so the
      // client doesn't have to round-trip mid-fight.
      const summonIds = new Set();
      for (const phase of chapter.boss.phases) {
        for (const id of phase.summonOnEntry?.pokemonIds || []) summonIds.add(id);
      }
      if (chapter.boss.transformTo?.anchorPokemonId) summonIds.add(chapter.boss.transformTo.anchorPokemonId);
      let summonCards = {};
      if (summonIds.size) {
        const { data: rows } = await supabase.from("pokemon").select("*").in("id", [...summonIds]);
        for (const r of rows || []) summonCards[r.id] = toCard(r);
      }
      // Hydrate readAlong sections with audioUrl from the TTS manifest
      // so the client doesn't need a second round-trip to /intro.
      let readAlong = null;
      if (Array.isArray(chapter.readAlong)) {
        const { loadManifest } = require("./reading-mode");
        const manifest = loadManifest();
        readAlong = chapter.readAlong.map((sec) => {
          const entry = manifest[`chapter-intro/${chapter.id}/${sec.id}`];
          return entry?.audioUrl
            ? { ...sec, audioUrl: entry.audioUrl }
            : { ...sec, audioUrl: null };
        });
      }
      res.json({
        chapter: {
          id: chapter.id, name: chapter.name, locale: chapter.locale,
          isFinale: !!chapter.isFinale,
          // intro: legacy dramatic lines (intro_v1) for backwards
          //        compat with older client builds.
          // readAlong: kid-friendly section-by-section read-along
          //        (slice 5d). Client prefers this when present.
          intro: chapter.intro_v1 || chapter.intro || [],
          readAlong,
          enemyTrainerName: chapter.enemyTrainerName,
          enemyAbility: chapter.enemyAbility || "lance",
        },
        boss: {
          displayName: chapter.boss.displayName,
          maxHp: chapter.boss.maxHp,
          types: chapter.boss.types,
          anchorPokemonId: chapter.boss.anchorPokemonId,
        },
        deck,
        phaseRules: summarisePhaseRules(chapter),
        summonCards,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/me/story/start", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const chapterId = String(req.body?.chapterId || "");
    const chapter = getChapter(chapterId);
    if (!chapter) return res.status(404).json({ error: "Unknown chapter." });
    const sessionId = require("crypto").randomBytes(12).toString("base64url");
    await store.kvSet(`story-sess:${sessionId}`, {
      userId: req.user.id, chapterId, startedAt: Date.now(),
    }, STORY_SESSION_TTL_SEC);
    res.json({ sessionId });
  });

  app.post("/me/story/end", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const { sessionId, won } = req.body || {};
    // kvTake atomically consumes the session so a retry can't double-claim.
    const session = await store.kvTake(`story-sess:${sessionId}`);
    if (!session) return res.json({ reward: null, reason: "no_session" });
    if (session.userId !== req.user.id) return res.status(403).json({ error: "Wrong user." });
    if (Date.now() - session.startedAt < STORY_MIN_DURATION_MS) {
      return res.json({ reward: null, reason: "too_short" });
    }
    // Daily quest tracking — story matches count as a played match.
    const koCount = Number(req.body?.kos) || 0;
    await bumpDailyStats(supabase, req.user.id, { matches: 1, wins: won ? 1 : 0, kos: koCount });
    if (!won) return res.json({ reward: null, reason: "lost" });

    const chapter = getChapter(session.chapterId);
    if (!chapter) return res.json({ reward: null, reason: "bad_chapter" });
    const pokedex = await loadDex();
    if (!pokedex?.length) return res.status(503).json({ error: "Pokédex not loaded." });

    const cfg = chapter.reward || { picks: 3 };
    let picks = rollPicks(pokedex, cfg.picks || 3, Math.random, { themeType: cfg.themeType, themeBias: 0.5 });
    if (cfg.guaranteedLegendary && !picks.some((p) => p.is_legendary || p.is_mythical)) {
      const rares = pokedex.filter((p) => p.is_legendary || p.is_mythical);
      if (rares.length) picks[picks.length - 1] = rares[Math.floor(Math.random() * rares.length)];
    }
    const offerId = await createOffer(req.user.id, picks);
    await recordChapterCompletion(supabase, req.user.id, session.chapterId);
    res.json({
      reward: {
        offerId,
        picks: picks.map((p) => ({
          id: p.id, name: p.name, types: p.types, tier: p.tier,
          energyCost: p.energyCost, cardHp: p.cardHp, cardAttack: p.cardAttack,
          sprite_front: p.sprite_front,
        })),
      },
      chapterId: session.chapterId,
    });
  });
}

module.exports = { mount, buildBossDeck, summarisePhaseRules };
