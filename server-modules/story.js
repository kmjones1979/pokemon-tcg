// Co-op Story Mode — server-authoritative.
//
// Routes (mounted at /api/story/*):
//   GET    /api/story/chapters                — list chapters meta + which the user has unlocked
//   POST   /api/story/start-solo              — { chapterId, deckSource } → returns view + sessionId
//   POST   /api/story/host                    — { chapterId, deckSource } → returns code
//   POST   /api/story/join                    — { code, deckSource } → matched
//   GET    /api/story/match/:id               — ?playerId=&since=v poll
//   POST   /api/story/match/:id/action        — { playerId, action, payload }
//
// Modes:
//   solo: p1 = user, p2 = AI partner (Lucario). Only the user's actions are
//         accepted; after the user ends their turn the server auto-runs the
//         AI partner's turn and then the boss's turn before yielding back.
//   coop: p1 = host, p2 = joiner. Each player can only act on their own turn.
//         Boss turn runs after p2 ends.
//
// State for an active match lives in the shared Redis state-store under
// ptcg:story:<id>. Solo unlocks are stored on the user row
// (`story_progress` jsonb column, see migrations).

const { randomUUID } = require("crypto");
const { buildDeck, toCard } = require("../shared/deck-builder");
const { getChapter, chapterMeta, CHAPTERS } = require("../shared/story-chapters");
const { rollPicks, createOffer } = require("./rewards");
const store = require("./state-store");

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LEN = 6;
const STORY_PREFIX = "story:";

let _engine = null;
async function getEngine() {
  if (!_engine) _engine = await import("../client/js/story-engine.js");
  return _engine;
}

function randCode() {
  let s = "";
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    s += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return s;
}

// Wrap a state with player-perspective view + last animation.
function viewFor(match, viewer) {
  const s = match.state;
  // Both players see each other's hands openly in coop (you're on the same team).
  return {
    v: match.v,
    matchId: match.id,
    mode: match.mode,
    youAre: viewer,
    chapter: s.chapter,
    turn: s.turn,
    activeSide: s.activeSide,
    phase: s.phase,
    winner: s.winner,
    log: s.log.slice(-30),
    players: {
      p1: viewerSafePlayer(s.players.p1, viewer === "p1"),
      p2: viewerSafePlayer(s.players.p2, viewer === "p2"),
    },
    boss: s.boss,
    lastAnim: match.lastAnim ? { ...match.lastAnim, v: match.lastAnimV } : null,
    rewardOffer: viewer === "p1" ? match.rewardP1 : match.rewardP2,
  };
}

function viewerSafePlayer(p, isSelf) {
  // In coop we still hide the partner's deck contents but show hand (open hands
  // help coop coordination).
  return {
    ...p,
    deck: [],
    hand: p.hand,
  };
}

async function loadDeckForUser(supabase, userId, deckSource, dex) {
  if (deckSource === "active" && userId && supabase) {
    try {
      const { data: deck } = await supabase
        .from("decks")
        .select("*")
        .eq("user_id", userId)
        .eq("is_active", true)
        .maybeSingle();
      if (deck?.card_ids?.length === 30) {
        const ids = [...new Set(deck.card_ids)];
        const { data: rows } = await supabase.from("pokemon").select("*").in("id", ids);
        const byId = new Map((rows || []).map((r) => [r.id, toCard(r)]));
        const cards = deck.card_ids.map((id) => byId.get(id)).filter(Boolean);
        if (cards.length === 30) return cards;
      }
    } catch (err) {
      console.warn("[story] active-deck fetch failed:", err.message);
    }
  }
  return buildDeck(dex);
}

async function buildMinionPokedex(supabase, chapter) {
  const ids = new Set();
  for (const phase of chapter.boss.phases) {
    for (const id of phase.summonOnEntry?.pokemonIds || []) ids.add(id);
  }
  if (!ids.size || !supabase) return new Map();
  const { data: rows } = await supabase.from("pokemon").select("*").in("id", [...ids]);
  return new Map((rows || []).map((r) => [r.id, r]));
}

async function startSession({ chapter, p1, p2, mode, supabase }) {
  const engine = await getEngine();
  const state = engine.createStory({ chapter, p1, p2 });
  // Inject minion pokedex so engine summons work.
  state.minionPokedex = await buildMinionPokedex(supabase, chapter);
  // Re-apply phase 0 with the populated pokedex (engine called applyPhase once already).
  const match = {
    id: randomUUID(),
    mode,
    chapterId: chapter.id,
    v: 0,
    state,
    lastAnim: null,
    lastAnimV: 0,
    players: {
      p1: { playerId: p1.playerId, userId: p1.userId, displayName: p1.displayName, ability: p1.ability },
      p2: { playerId: p2.playerId, userId: p2.userId, displayName: p2.displayName, ability: p2.ability },
    },
    createdAt: Date.now(),
  };
  await store.roomSet(STORY_PREFIX + match.id, match);
  if (p1.playerId) await store.playerBind(p1.playerId, STORY_PREFIX + match.id);
  if (p2.playerId && !p2.isAi) await store.playerBind(p2.playerId, STORY_PREFIX + match.id);
  return match;
}

function viewerOf(match, playerId) {
  if (match.players.p1.playerId === playerId) return "p1";
  if (match.players.p2.playerId === playerId) return "p2";
  return null;
}

async function rollChapterReward(supabase, userId, chapter, getDex) {
  if (!userId) return null;
  const dex = await getDex();
  if (!dex?.length) return null;
  const reward = chapter.reward || { picks: 3 };
  let picks = rollPicks(dex, reward.picks || 3, Math.random, { themeType: reward.themeType, themeBias: 0.5 });
  if (reward.guaranteedLegendary && !picks.some((p) => p.is_legendary || p.is_mythical)) {
    const rares = dex.filter((p) => p.is_legendary || p.is_mythical);
    if (rares.length) picks[picks.length - 1] = rares[Math.floor(Math.random() * rares.length)];
  }
  const offerId = createOffer(userId, picks);
  return {
    offerId,
    picks: picks.map((p) => ({
      id: p.id, name: p.name, types: p.types, tier: p.tier,
      energyCost: p.energyCost, cardHp: p.cardHp, cardAttack: p.cardAttack,
      sprite_front: p.sprite_front,
    })),
  };
}

// Persist a chapter as "completed" on the user's story_progress column.
async function recordChapterCompletion(supabase, userId, chapterId) {
  if (!supabase || !userId) return;
  try {
    const { data: u } = await supabase
      .from("users")
      .select("story_progress")
      .eq("id", userId)
      .maybeSingle();
    const progress = u?.story_progress || { completed: [] };
    if (!progress.completed.includes(chapterId)) progress.completed.push(chapterId);
    progress.lastClearedAt = new Date().toISOString();
    await supabase.from("users").update({ story_progress: progress }).eq("id", userId);
  } catch (err) {
    console.warn("[story] progress write failed:", err.message);
  }
}

async function getUserProgress(supabase, userId) {
  if (!supabase || !userId) return { completed: [] };
  try {
    const { data: u } = await supabase
      .from("users")
      .select("story_progress")
      .eq("id", userId)
      .maybeSingle();
    return u?.story_progress || { completed: [] };
  } catch {
    return { completed: [] };
  }
}

function chapterUnlocked(chapter, progress) {
  if (chapter.chapterNumber === 1) return true;
  // Each chapter unlocks when the previous is completed.
  const prev = CHAPTERS.find((c) => c.chapterNumber === chapter.chapterNumber - 1);
  return prev ? progress.completed.includes(prev.id) : true;
}

function mount(app, supabase, getPokedex) {
  async function loadDex() {
    const v = getPokedex();
    return v && typeof v.then === "function" ? await v : v;
  }

  app.get("/api/story/chapter/:id/intro", (req, res) => {
    const chapter = getChapter(req.params.id);
    if (!chapter) return res.status(404).json({ error: "Unknown chapter." });
    res.json({ intro: chapter.intro, flavor: chapter.flavor, locale: chapter.locale });
  });

  app.get("/api/story/match-status", async (req, res) => {
    const playerId = String(req.query.playerId || req.user?.id || "");
    if (!playerId) return res.json({ state: "waiting" });
    const matchId = await store.playerLastRoom(playerId);
    if (!matchId || !matchId.startsWith(STORY_PREFIX)) return res.json({ state: "waiting" });
    const m = await store.roomGet(matchId);
    if (!m) return res.json({ state: "waiting" });
    const viewer = viewerOf(m, playerId);
    if (!viewer) return res.json({ state: "waiting" });
    res.json({ state: "matched", view: viewFor(m, viewer) });
  });

  app.get("/api/story/chapters", async (req, res) => {
    const progress = await getUserProgress(supabase, req.user?.id);
    const list = chapterMeta().map((c) => ({
      ...c,
      unlocked: chapterUnlocked(c, progress),
      completed: progress.completed.includes(c.id),
    }));
    res.json({ chapters: list, progress });
  });

  app.post("/api/story/start-solo", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in to play story mode." });
    const chapterId = String(req.body?.chapterId || "");
    const chapter = getChapter(chapterId);
    if (!chapter) return res.status(404).json({ error: "Unknown chapter." });
    const progress = await getUserProgress(supabase, req.user.id);
    if (!chapterUnlocked(chapter, progress)) return res.status(403).json({ error: "Chapter locked. Complete the previous chapter first." });

    const dex = await loadDex();
    if (!dex?.length) return res.status(503).json({ error: "Pokédex not loaded." });
    const deckSource = String(req.body?.deckSource || "active");
    const p1Deck = await loadDeckForUser(supabase, req.user.id, deckSource, dex);
    const p2Deck = await loadDeckForUser(supabase, null, "random", dex);

    const p1 = {
      playerId: req.user.id,
      userId: req.user.id,
      displayName: req.body?.displayName || req.user.display_name || "You",
      ability: req.body?.ability || "brock",
      deck: p1Deck,
      isAi: false,
    };
    const p2 = {
      playerId: `ai-partner-${randomUUID().slice(0, 8)}`,
      userId: null,
      displayName: "Lucario (AI Partner)",
      ability: "lance",
      deck: p2Deck,
      isAi: true,
    };
    const match = await startSession({ chapter, p1, p2, mode: "solo", supabase });
    res.json({ view: viewFor(match, "p1"), playerId: p1.playerId });
  });

  app.post("/api/story/host", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in to host a co-op run." });
    const chapterId = String(req.body?.chapterId || "");
    const chapter = getChapter(chapterId);
    if (!chapter) return res.status(404).json({ error: "Unknown chapter." });
    const progress = await getUserProgress(supabase, req.user.id);
    if (!chapterUnlocked(chapter, progress)) return res.status(403).json({ error: "Chapter locked." });
    const code = randCode();
    await store.privateRoomSet(`story-${code}`, {
      playerId: req.user.id,
      userId: req.user.id,
      displayName: req.body?.displayName || req.user.display_name || "Host",
      ability: req.body?.ability || "brock",
      deckSource: req.body?.deckSource || "active",
      chapterId,
    });
    res.json({ code });
  });

  app.post("/api/story/join", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in to join a co-op run." });
    const code = String(req.body?.code || "").toUpperCase().trim();
    if (!code) return res.status(400).json({ error: "Code required." });
    const host = await store.privateRoomTake(`story-${code}`);
    if (!host) return res.status(404).json({ error: "Room not found or expired." });
    if (host.playerId === req.user.id) {
      await store.privateRoomSet(`story-${code}`, host);
      return res.status(400).json({ error: "Can't join your own room." });
    }
    const chapter = getChapter(host.chapterId);
    if (!chapter) return res.status(404).json({ error: "Chapter no longer available." });
    const dex = await loadDex();
    const p1Deck = await loadDeckForUser(supabase, host.userId, host.deckSource, dex);
    const p2Deck = await loadDeckForUser(supabase, req.user.id, req.body?.deckSource || "active", dex);
    const p1 = { ...host, deck: p1Deck, isAi: false };
    const p2 = {
      playerId: req.user.id, userId: req.user.id,
      displayName: req.body?.displayName || req.user.display_name || "Partner",
      ability: req.body?.ability || "erika",
      deck: p2Deck, isAi: false,
    };
    const match = await startSession({ chapter, p1, p2, mode: "coop", supabase });
    res.json({ view: viewFor(match, "p2"), playerId: req.user.id });
  });

  app.get("/api/story/match/:id", async (req, res) => {
    const playerId = String(req.query.playerId || req.user?.id || "");
    const since = Number(req.query.since || 0);
    const m = await store.roomGet(STORY_PREFIX + req.params.id);
    if (!m) return res.status(404).json({ error: "Match not found." });
    const viewer = viewerOf(m, playerId);
    if (!viewer) return res.status(403).json({ error: "Not in this match." });
    if (m.v <= since) return res.status(204).end();
    res.json({ view: viewFor(m, viewer) });
  });

  app.post("/api/story/match/:id/action", async (req, res) => {
    const playerId = String(req.body?.playerId || req.user?.id || "");
    const action = String(req.body?.action || "");
    const payload = req.body?.payload || {};
    const matchKey = STORY_PREFIX + req.params.id;

    let outErr = null;
    let outOver = false;
    let outViewer = null;

    await store.roomWithLock(matchKey, async (m) => {
      if (!m) { outErr = "Match not found."; return; }
      const viewer = viewerOf(m, playerId);
      outViewer = viewer;
      if (!viewer) { outErr = "Not in this match."; return; }
      if (m.state.winner) { outErr = "Match is over."; return; }

      const engine = await getEngine();
      const chapter = getChapter(m.chapterId);
      let r;
      switch (action) {
        case "play-card":
          r = engine.playCard(m.state, viewer, payload.handIndex, { replaceSlot: payload.replaceSlot });
          if (r?.ok) m.lastAnim = { kind: "play", side: viewer, slot: r.slot, cardName: r.instance?.card?.name };
          break;
        case "attack":
          r = engine.attack(m.state, viewer, payload.fromSlot, payload.target || { kind: "boss" });
          if (r?.ok) m.lastAnim = { kind: "attack", side: viewer, fromSlot: payload.fromSlot, target: payload.target, damage: r.damage, critical: !!r.critical };
          break;
        case "end-turn": {
          if (m.state.activeSide !== viewer) { outErr = "Not your turn."; return; }
          // p1 → p2 transition.
          engine.endTurn(m.state, viewer, chapter);
          m.lastAnim = { kind: "end-turn", side: viewer };
          // Solo: auto-run AI partner's turn + boss turn until back to p1.
          if (m.mode === "solo") {
            // After p1 ends turn, state.activeSide = "p2". Run AI partner.
            if (m.state.activeSide === "p2" && !m.state.winner) {
              const aiActs = engine.aiPartnerTurn(m.state, chapter, "p2");
              m.partnerActions = aiActs;
            }
          }
          r = { ok: true };
          break;
        }
        case "concede": {
          m.state.winner = "boss";
          m.state.phase = "over";
          m.state.log.push({ id: m.state.log.length + 1, text: `${m.players[viewer].displayName} conceded.`, kind: "loss" });
          r = { ok: true };
          break;
        }
        default:
          outErr = "Unknown action.";
          return;
      }
      if (!r || !r.ok) { outErr = r?.reason || "Action rejected."; return; }
      m.v += 1;
      m.lastAnimV = m.v;

      // Handle chapter-completion rewards on the action that ended it.
      if (m.state.winner && !m.rewardsRolled) {
        m.rewardsRolled = true;
        outOver = true;
        const chapterDone = m.state.winner === "team";
        if (chapterDone) {
          if (m.players.p1.userId) {
            m.rewardP1 = await rollChapterReward(supabase, m.players.p1.userId, chapter, loadDex);
            await recordChapterCompletion(supabase, m.players.p1.userId, chapter.id);
          }
          if (m.players.p2.userId) {
            m.rewardP2 = await rollChapterReward(supabase, m.players.p2.userId, chapter, loadDex);
            await recordChapterCompletion(supabase, m.players.p2.userId, chapter.id);
          }
        }
      }
    });
    if (outErr) return res.status(400).json({ error: outErr });
    const m = await store.roomGet(matchKey);
    if (!m) return res.status(404).json({ error: "Match vanished." });
    res.json({
      view: viewFor(m, outViewer),
      gameOver: outOver || !!m.state.winner,
      partnerActions: m.partnerActions || null,
    });
  });
}

module.exports = { mount };
