// HTTP-polling multiplayer. Works on Vercel without Socket.IO.
//
// State lives in Redis (via state-store.js) so it's shared across function
// instances:
//   queue        — Redis list of waiting seats
//   private:<code> — host seat (TTL 5min)
//   match:<id>   — full game state with a monotonic `v` version
//   player:<pid> — currently-active matchId (for reconnect / status poll)
//
// Routes (mounted at /api/mp/*):
//   POST   /api/mp/queue              -> enter matchmaking queue OR pair
//   DELETE /api/mp/queue              -> leave queue
//   POST   /api/mp/host               -> create private room, returns code
//   POST   /api/mp/join               -> join private room with code
//   GET    /api/mp/match-status       -> ?playerId=... — poll for pairing
//   GET    /api/mp/match/:id          -> ?playerId=...&since=v — state view
//   POST   /api/mp/match/:id/action   -> { playerId, action, payload }

const { randomUUID } = require("crypto");
const { buildDeck, toCard } = require("../shared/deck-builder");
const { offerForOutcome } = require("./rewards");
const store = require("./state-store");

const RECONNECT_GRACE_MS = 60_000;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LEN = 6;
const MATCH_TTL_SEC = 60 * 60;

let _engine = null;
async function getEngine() {
  if (!_engine) _engine = await import("../client/js/game.js");
  return _engine;
}

function randCode() {
  let s = "";
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    s += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return s;
}

// Scrub state for a recipient — normalise sides so player is always us,
// opponent is always ai, hide opponent hand contents.
function viewFor(match, mySide) {
  const oppSide = mySide === "player" ? "ai" : "player";
  const s = match.state;
  // Translate match.lastAnim's `side` into recipient POV so client-side
  // animation code can treat "player" as "us" and "ai" as the opponent.
  let lastAnim = null;
  if (match.lastAnim) {
    const a = match.lastAnim;
    const flip = (sd) => sd === mySide ? "player" : "ai";
    lastAnim = { ...a, side: flip(a.side), v: match.lastAnimV };
  }
  return {
    v: match.v,
    matchId: match.id,
    turn: s.turn,
    activePlayer: s.activePlayer === mySide ? "player" : "ai",
    phase: s.phase,
    winner: s.winner == null ? null : s.winner === mySide ? "player" : "ai",
    log: s.log.slice(-30),
    players: {
      player: s.players[mySide],
      ai: {
        ...s.players[oppSide],
        hand: s.players[oppSide].hand.map(() => ({ hidden: true })),
        deck: [],
      },
    },
    youAre: "player",
    opponent: {
      displayName: match.players[oppSide].displayName,
      ability: match.players[oppSide].ability,
    },
    lastAnim,
  };
}

function readSeat(req) {
  // We trust the playerId — accounts use the session cookie if signed in.
  const seat = {
    playerId: String(req.body?.playerId || "").slice(0, 64),
    displayName: String(req.body?.displayName || "Trainer").slice(0, 32),
    ability: req.body?.ability || "brock",
    deckSource: req.body?.deckSource || "random",
    userId: req.user?.id || null,
  };
  if (!seat.playerId) return null;
  return seat;
}

function mount(app, supabase, getPokedex) {
  async function loadDex() {
    const v = getPokedex();
    return v && typeof v.then === "function" ? await v : v;
  }

  async function ensureDeck(seat) {
    if (seat.deckSource === "active" && seat.userId && supabase) {
      try {
        const { data: deck } = await supabase
          .from("decks")
          .select("*")
          .eq("user_id", seat.userId)
          .eq("is_active", true)
          .maybeSingle();
        if (deck?.card_ids?.length === 30) {
          const ids = [...new Set(deck.card_ids)];
          const [{ data: rows }, { data: shinies }] = await Promise.all([
            supabase.from("pokemon").select("*").in("id", ids),
            supabase.from("owned_cards").select("pokemon_id, shiny_level")
              .eq("user_id", seat.userId).in("pokemon_id", ids),
          ]);
          const shinyMap = new Map((shinies || []).map((s) => [s.pokemon_id, s.shiny_level || 0]));
          const byId = new Map((rows || []).map((r) => [r.id, toCard(r)]));
          const cards = deck.card_ids.map((id) => {
            const c = byId.get(id);
            if (!c) return null;
            return { ...c, shinyLevel: shinyMap.get(id) || 0 };
          }).filter(Boolean);
          if (cards.length === 30) {
            // Append the standard 10-spell section so PvP active-deck
            // matches have parity with random / Story Mode decks.
            const { allSpellCards } = require("../shared/spell-cards");
            const { DEFAULT_SPELL_COUNT } = require("../shared/deck-builder");
            const spellPool = allSpellCards();
            if (spellPool.length > 0) {
              for (let i = 0; i < DEFAULT_SPELL_COUNT; i++) {
                cards.push(spellPool[Math.floor(Math.random() * spellPool.length)]);
              }
            }
            return cards;
          }
        }
      } catch (err) {
        console.warn("[mp-http] active-deck fetch failed:", err.message);
      }
    }
    const dex = await loadDex();
    return buildDeck(dex);
  }

  async function startMatch(p1, p2) {
    const engine = await getEngine();
    const [p1Deck, p2Deck] = await Promise.all([ensureDeck(p1), ensureDeck(p2)]);
    const state = engine.createGame({
      playerDeck: p1Deck,
      aiDeck: p2Deck,
      playerAbility: p1.ability || "brock",
      aiAbility: p2.ability || "pikachu",
    });
    const matchId = randomUUID();
    let dbMatchId = null;
    if (supabase) {
      try {
        const { data } = await supabase.from("matches").insert({
          p1_user_id: p1.userId || null,
          p2_user_id: p2.userId || null,
          started_at: new Date().toISOString(),
        }).select("id").single();
        dbMatchId = data?.id || null;
      } catch (err) {
        console.warn("[mp-http] match insert failed:", err.message);
      }
    }
    const match = {
      id: matchId,
      v: 0,
      dbMatchId,
      players: {
        player: { ...p1, side: "player" },
        ai: { ...p2, side: "ai" },
      },
      state,
    };
    await store.roomSet(matchId, match);
    await Promise.all([
      store.playerBind(p1.playerId, matchId),
      store.playerBind(p2.playerId, matchId),
    ]);
    return match;
  }

  function sideForPlayer(match, playerId) {
    if (match.players.player.playerId === playerId) return "player";
    if (match.players.ai.playerId === playerId) return "ai";
    return null;
  }

  // ----- routes -----------------------------------------------------------

  app.post("/api/mp/queue", async (req, res) => {
    const seat = readSeat(req);
    if (!seat) return res.status(400).json({ error: "playerId required" });

    // Already in a match? Just return it.
    const existingMatchId = await store.playerLastRoom(seat.playerId);
    if (existingMatchId) {
      const m = await store.roomGet(existingMatchId);
      if (m && !m.state.winner) {
        const side = sideForPlayer(m, seat.playerId);
        if (side) return res.json({ state: "matched", view: viewFor(m, side) });
      }
    }

    // Try to pop the head of the queue and pair.
    for (let safety = 0; safety < 5; safety++) {
      const peer = await store.queuePopFifo();
      if (!peer) break;
      if (peer.playerId === seat.playerId) continue; // skip ourselves
      // Pair
      const match = await startMatch(peer, seat);
      const side = sideForPlayer(match, seat.playerId);
      return res.json({ state: "matched", view: viewFor(match, side) });
    }

    // Nobody waiting — enqueue.
    await store.queuePush(seat);
    res.json({ state: "waiting" });
  });

  app.delete("/api/mp/queue", async (req, res) => {
    const playerId = String(req.query.playerId || req.body?.playerId || "");
    if (!playerId) return res.status(400).json({ error: "playerId required" });
    await store.queueRemove(playerId);
    res.json({ ok: true });
  });

  app.post("/api/mp/host", async (req, res) => {
    const seat = readSeat(req);
    if (!seat) return res.status(400).json({ error: "playerId required" });
    const code = randCode();
    await store.privateRoomSet(code, seat);
    res.json({ code });
  });

  app.post("/api/mp/join", async (req, res) => {
    const seat = readSeat(req);
    if (!seat) return res.status(400).json({ error: "playerId required" });
    const code = String(req.body?.code || "").toUpperCase().trim();
    if (!code) return res.status(400).json({ error: "code required" });
    const host = await store.privateRoomTake(code);
    if (!host) return res.status(404).json({ error: "Room not found." });
    if (host.playerId === seat.playerId) {
      // Restore the host since they can't join themselves.
      await store.privateRoomSet(code, host);
      return res.status(400).json({ error: "Can't join your own room." });
    }
    const match = await startMatch(host, seat);
    const side = sideForPlayer(match, seat.playerId);
    res.json({ state: "matched", view: viewFor(match, side) });
  });

  // Poll endpoint while in queue or waiting for a private-room peer.
  app.get("/api/mp/match-status", async (req, res) => {
    const playerId = String(req.query.playerId || "");
    if (!playerId) return res.status(400).json({ error: "playerId required" });
    const matchId = await store.playerLastRoom(playerId);
    if (!matchId) return res.json({ state: "waiting" });
    const m = await store.roomGet(matchId);
    if (!m) return res.json({ state: "waiting" });
    const side = sideForPlayer(m, playerId);
    if (!side) return res.json({ state: "waiting" });
    res.json({ state: "matched", view: viewFor(m, side) });
  });

  app.get("/api/mp/match/:id", async (req, res) => {
    const matchId = req.params.id;
    const playerId = String(req.query.playerId || "");
    const since = Number(req.query.since || 0);
    if (!playerId) return res.status(400).json({ error: "playerId required" });
    const m = await store.roomGet(matchId);
    if (!m) return res.status(404).json({ error: "Match not found." });
    const side = sideForPlayer(m, playerId);
    if (!side) return res.status(403).json({ error: "Not in this match." });
    if (m.v <= since) return res.status(204).end();
    res.json({ view: viewFor(m, side) });
  });

  // Spectator endpoint — returns a view of any active match with BOTH hands
  // hidden. No auth required; anyone with the match id can watch.
  app.get("/api/mp/spectate/:id", async (req, res) => {
    const matchId = req.params.id;
    const since = Number(req.query.since || 0);
    const m = await store.roomGet(matchId);
    if (!m) return res.status(404).json({ error: "Match not found." });
    if (m.v <= since) return res.status(204).end();
    const s = m.state;
    res.json({
      view: {
        v: m.v,
        matchId: m.id,
        turn: s.turn,
        activePlayer: s.activePlayer,
        phase: s.phase,
        winner: s.winner,
        log: s.log.slice(-30),
        players: {
          player: {
            ...s.players.player,
            hand: s.players.player.hand.map(() => ({ hidden: true })),
            deck: [],
          },
          ai: {
            ...s.players.ai,
            hand: s.players.ai.hand.map(() => ({ hidden: true })),
            deck: [],
          },
        },
        opponents: {
          player: { displayName: m.players.player.displayName, ability: m.players.player.ability },
          ai: { displayName: m.players.ai.displayName, ability: m.players.ai.ability },
        },
        youAre: "spectator",
      },
    });
  });

  app.post("/api/mp/match/:id/action", async (req, res) => {
    try {
      await runMatchAction(req, res);
    } catch (err) {
      // Any throw from the engine / store / supabase that isn't already
      // handled below MUST come back as JSON, not Express's HTML 500.
      // The MP client does `await r.json()` and the resulting parse error
      // surfaces in iOS Safari as "The string did not match the expected
      // pattern." and in Chrome as "Unexpected Token <" — both useless to
      // a player. Wrap once at the top so every action stays JSON-safe.
      console.error("[mp] action handler threw:", err);
      if (!res.headersSent) {
        res.status(500).json({
          error: `Action failed: ${err && err.message ? err.message : "unknown error"}`,
        });
      }
    }
  });

  async function runMatchAction(req, res) {
    const matchId = req.params.id;
    const playerId = String(req.body?.playerId || "");
    const action = String(req.body?.action || "");
    const payload = req.body?.payload || {};
    if (!playerId) return res.status(400).json({ error: "playerId required" });

    let outErr = null;
    let outOver = false;
    await store.roomWithLock(matchId, async (m) => {
      if (!m) { outErr = "Match not found."; return; }
      const side = sideForPlayer(m, playerId);
      if (!side) { outErr = "Not in this match."; return; }
      if (m.state.winner) { outErr = "Match is over."; return; }

      const engine = await getEngine();
      let r;
      switch (action) {
        case "play-card":
          // spellTarget is only meaningful for spell cards; the engine
          // ignores it for Pokémon plays. Forwarding it unconditionally
          // keeps the MP server thin — the client decides which fields
          // are relevant per card kind.
          r = engine.playCard(m.state, side, payload.handIndex, {
            replaceSlot: payload.replaceSlot,
            spellTarget: payload.spellTarget,
          });
          if (r?.ok) m.lastAnim = { kind: "summon", side, slot: r.slot, cardName: r.instance?.card?.name, type: r.instance?.card?.types?.[0] };
          break;
        case "attack":
          r = engine.attack(m.state, side, payload.fromSlot, payload.target, { abilityId: payload.abilityId });
          if (r?.ok) m.lastAnim = {
            kind: "attack",
            side,
            fromSlot: payload.fromSlot,
            target: payload.target,
            damage: r.damage,
            multiplier: r.multiplier,
            verdict: r.verdict,
            critical: !!r.critical,
            knockedOut: !!r.knockedOut,
            attackerLeveled: r.attackerLeveled || 0,
            attackerType: m.state.players[side].field[payload.fromSlot]?.card?.types?.[0]
              || (m.state.discard?.[m.state.discard.length-1]?.types?.[0])
              || "normal",
          };
          break;
        case "end-turn":
          if (m.state.activePlayer !== side) { outErr = "Not your turn."; return; }
          engine.endTurn(m.state);
          r = { ok: true };
          m.lastAnim = { kind: "end-turn", side };
          break;
        case "use-item":
          r = engine.useItem(m.state, side, payload.itemId, payload.target);
          if (r?.ok) m.lastAnim = { kind: "item", side, itemId: payload.itemId, slot: payload.target };
          break;
        case "concede": {
          const other = side === "player" ? "ai" : "player";
          m.state.winner = other;
          m.state.phase = "over";
          m.state.log.push({
            id: m.state.log.length + 1,
            text: `${m.players[side].displayName} conceded.`,
            kind: "win",
          });
          r = { ok: true };
          break;
        }
        default:
          outErr = "Unknown action.";
          return;
      }
      if (!r || !r.ok) {
        outErr = r?.reason || "Action rejected.";
        return;
      }
      m.lastAnimV = m.v + 1;
      m.v += 1;
      if (m.state.winner) {
        outOver = true;
        // Persist match record + offer rewards. EVERY downstream op here
        // is best-effort: a thrown supabase/Redis call must NOT abort
        // this lock callback, because doing so would skip the trailing
        // `roomSet` in roomWithLock — losing the winner mutation and
        // leaving the player stuck in a "live" match they thought they
        // ended. (Regression: concede used to wedge the user when
        // offerForOutcome failed.)
        if (supabase && m.dbMatchId) {
          const winnerSide = m.state.winner;
          const winnerSeat = m.players[winnerSide];
          supabase.from("matches").update({
            winner_id: winnerSeat.userId || null,
            reason: action === "concede" ? "concede" : "ko",
            turns: m.state.turn,
            ended_at: new Date().toISOString(),
          }).eq("id", m.dbMatchId).then(() => {}, () => {});
        }
        // Stash rewards on the match so the next state-fetch can deliver
        // them. If the pokédex isn't loaded yet or createOffer fails,
        // skip the reward — the match still ends.
        let dex = null;
        try {
          dex = await loadDex();
        } catch (err) {
          console.error("[mp] loadDex during match end failed:", err);
        }
        const winnerSide = m.state.winner;
        if (dex?.length) {
          if (m.players.player.userId) {
            try {
              m.rewardForPlayer = await offerForOutcome(m.players.player.userId, dex, winnerSide === "player");
            } catch (err) {
              console.error("[mp] offerForOutcome(player) failed:", err);
            }
          }
          if (m.players.ai.userId) {
            try {
              m.rewardForAi = await offerForOutcome(m.players.ai.userId, dex, winnerSide === "ai");
            } catch (err) {
              console.error("[mp] offerForOutcome(ai) failed:", err);
            }
          }
        }
      }
    });
    if (outErr) return res.status(400).json({ error: outErr });
    const m = await store.roomGet(matchId);
    if (!m) return res.status(404).json({ error: "Match vanished." });
    const side = sideForPlayer(m, playerId);
    const out = { view: viewFor(m, side) };
    if (outOver) {
      // Surface this player's reward in the response.
      out.reward = side === "player" ? m.rewardForPlayer : m.rewardForAi;
      out.gameOver = true;
    }
    res.json(out);
  }
}

module.exports = { mount, viewFor };
