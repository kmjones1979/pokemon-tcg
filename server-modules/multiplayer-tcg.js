// HTTP-polling multiplayer for the TCG card-game mode. Mirrors
// multiplayer-http.js (main battler) but drives the pure TCG engine
// (client/js/tcg/engine.js) and uses a separate matchmaking pool so the two
// modes never cross-pair. Server-authoritative: the engine state lives in the
// shared state-store (Redis when configured, in-memory otherwise) and every
// action is validated by the engine before the new view is returned.
//
// Routes (mounted at /api/mp/tcg/*):
//   POST   /api/mp/tcg/queue            -> enter matchmaking OR pair instantly
//   DELETE /api/mp/tcg/queue            -> leave queue
//   POST   /api/mp/tcg/host             -> create private room, returns code
//   POST   /api/mp/tcg/join             -> join private room with a code
//   GET    /api/mp/tcg/match-status     -> ?playerId= — poll for pairing
//   GET    /api/mp/tcg/match/:id        -> ?playerId=&since=v — state view
//   POST   /api/mp/tcg/match/:id/action -> { playerId, action, payload }

const { randomUUID } = require("crypto");
const store = require("./state-store");

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LEN = 4;

let _engine = null;
async function getEngine() {
  if (!_engine) _engine = await import("../client/js/tcg/engine.js");
  return _engine;
}
let _decks = null;
async function getDecks() {
  if (!_decks) _decks = await import("../client/js/tcg/decks.js");
  return _decks;
}

function randCode() {
  let s = "";
  for (let i = 0; i < ROOM_CODE_LEN; i++) s += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  return s;
}

function readSeat(req) {
  const seat = {
    playerId: String(req.body?.playerId || "").slice(0, 64),
    displayName: String(req.body?.displayName || "Trainer").slice(0, 32),
    deckId: req.body?.deckId ? String(req.body.deckId).slice(0, 32) : null,
  };
  if (!seat.playerId) return null;
  return seat;
}

// Hide a side's private info (hand contents, deck, face-down Prizes) from a
// recipient who isn't its owner — and, for Prizes, from everyone (they're
// face-down until claimed). Preserves array lengths so the client renders the
// right number of face-down cards.
function scrubSide(side, isOwn) {
  const hide = (arr) => arr.map(() => ({ hidden: true }));
  return {
    ...side,
    // Keep array LENGTHS accurate (deck/prize pile counts and the opponent's
    // hand size are public) but hide the card contents from everyone who
    // shouldn't see them. Prizes are face-down even to their owner.
    deck: isOwn ? side.deck : hide(side.deck),
    hand: isOwn ? side.hand : hide(side.hand),
    prizes: hide(side.prizes),
  };
}

// Produce a per-recipient view where the recipient is always "player" and the
// opponent is always "ai" — the client renders from a fixed POV, exactly like
// the single-player board.
function viewFor(match, mySide) {
  const oppSide = mySide === "player" ? "ai" : "player";
  const s = match.state;
  const flip = (sd) => (sd == null ? sd : sd === mySide ? "player" : "ai");
  let stadium = null;
  if (s.stadium) stadium = { card: s.stadium.card, owner: flip(s.stadium.owner) };
  return {
    v: match.v,
    matchId: match.id,
    turn: s.turn,
    phase: s.phase,
    activePlayer: flip(s.activePlayer),
    winner: flip(s.winner),
    noAttack: s.noAttack,
    firstPlayer: flip(s.firstPlayer),
    stadium,
    log: s.log.slice(-40),
    players: {
      player: scrubSide(s.players[mySide], true),
      ai: scrubSide(s.players[oppSide], false),
    },
    youAre: "player",
    opponent: { displayName: match.players[oppSide].displayName },
  };
}

function sideForPlayer(match, playerId) {
  if (match.players.player.playerId === playerId) return "player";
  if (match.players.ai.playerId === playerId) return "ai";
  return null;
}

function mount(app) {
  async function deckIdsFor(seat) {
    const { deckById, STARTER_DECKS } = await getDecks();
    const chosen = (seat.deckId && deckById(seat.deckId)) ||
      STARTER_DECKS[Math.floor(Math.random() * STARTER_DECKS.length)];
    return chosen.cards;
  }

  async function startMatch(p1, p2) {
    const engine = await getEngine();
    const [p1Deck, p2Deck] = await Promise.all([deckIdsFor(p1), deckIdsFor(p2)]);
    const state = engine.createTcgGame({
      playerDeckIds: p1Deck, aiDeckIds: p2Deck,
      playerName: p1.displayName, aiName: p2.displayName,
    });
    const match = {
      id: randomUUID(),
      v: 1,
      players: { player: { ...p1, side: "player" }, ai: { ...p2, side: "ai" } },
      state,
    };
    await store.roomSet(match.id, match);
    await Promise.all([store.playerBind(p1.playerId, match.id), store.playerBind(p2.playerId, match.id)]);
    return match;
  }

  // ----- matchmaking ------------------------------------------------------

  app.post("/api/mp/tcg/queue", async (req, res) => {
    const seat = readSeat(req);
    if (!seat) return res.status(400).json({ error: "playerId required" });

    try {
      // Serialize the whole reconnect/pop/push critical section. Without this,
      // two players clicking Quick Match at nearly the same time each pop an
      // empty queue (the pop and push are separate Redis round-trips) and both
      // get stuck "waiting" forever — the reason Quick Match worked on a single
      // LAN process but not over the internet.
      const result = await store.withNamedLock("tcg", async () => {
        // Already in a live match? Return it (reconnect).
        const existing = await store.playerLastRoom(seat.playerId);
        if (existing) {
          const m = await store.roomGet(existing);
          if (m && m.state && !m.state.winner) {
            const side = sideForPlayer(m, seat.playerId);
            if (side) return { state: "matched", view: viewFor(m, side) };
          }
        }

        for (let safety = 0; safety < 5; safety++) {
          const peer = await store.tcgQueuePopFifo();
          if (!peer) break;
          if (peer.playerId === seat.playerId) continue;
          const match = await startMatch(peer, seat);
          return { state: "matched", view: viewFor(match, sideForPlayer(match, seat.playerId)) };
        }
        // Not paired — (re)queue exactly once so a re-click can't leave a
        // duplicate "ghost" seat that pairs someone against an absent player.
        await store.tcgQueueRemove(seat.playerId);
        await store.tcgQueuePush(seat);
        return { state: "waiting" };
      });
      res.json(result);
    } catch (err) {
      console.error("[mp-tcg] queue:", err);
      res.status(503).json({ error: "Matchmaking busy — try again." });
    }
  });

  app.delete("/api/mp/tcg/queue", async (req, res) => {
    const playerId = String(req.query.playerId || req.body?.playerId || "");
    if (!playerId) return res.status(400).json({ error: "playerId required" });
    await store.tcgQueueRemove(playerId);
    res.json({ ok: true });
  });

  app.post("/api/mp/tcg/host", async (req, res) => {
    const seat = readSeat(req);
    if (!seat) return res.status(400).json({ error: "playerId required" });
    const code = randCode();
    await store.tcgPrivateRoomSet(code, seat);
    res.json({ code });
  });

  app.post("/api/mp/tcg/join", async (req, res) => {
    const seat = readSeat(req);
    if (!seat) return res.status(400).json({ error: "playerId required" });
    const code = String(req.body?.code || "").toUpperCase().trim();
    if (!code) return res.status(400).json({ error: "code required" });
    const host = await store.tcgPrivateRoomTake(code);
    if (!host) return res.status(404).json({ error: "Room not found." });
    if (host.playerId === seat.playerId) {
      await store.tcgPrivateRoomSet(code, host);
      return res.status(400).json({ error: "Can't join your own room." });
    }
    const match = await startMatch(host, seat);
    res.json({ state: "matched", view: viewFor(match, sideForPlayer(match, seat.playerId)) });
  });

  app.get("/api/mp/tcg/match-status", async (req, res) => {
    const playerId = String(req.query.playerId || "");
    if (!playerId) return res.status(400).json({ error: "playerId required" });
    const matchId = await store.playerLastRoom(playerId);
    if (!matchId) return res.json({ state: "waiting" });
    const m = await store.roomGet(matchId);
    if (!m || !m.state) return res.json({ state: "waiting" });
    const side = sideForPlayer(m, playerId);
    if (!side) return res.json({ state: "waiting" });
    res.json({ state: "matched", view: viewFor(m, side) });
  });

  app.get("/api/mp/tcg/match/:id", async (req, res) => {
    const playerId = String(req.query.playerId || "");
    const since = Number(req.query.since || 0);
    if (!playerId) return res.status(400).json({ error: "playerId required" });
    const m = await store.roomGet(req.params.id);
    if (!m) return res.status(404).json({ error: "Match not found." });
    const side = sideForPlayer(m, playerId);
    if (!side) return res.status(403).json({ error: "Not in this match." });
    if (m.v <= since) return res.status(204).end();
    res.json({ view: viewFor(m, side) });
  });

  // ----- actions ----------------------------------------------------------

  // Map a client action to an engine call. The engine THROWS on any illegal
  // move (wrong turn, bad target, rule violation), which we surface as a
  // rejection. Read-side is hidden per-recipient by viewFor, so a client can
  // only ever act on its own seat via `side`.
  function applyAction(engine, state, side, action, payload) {
    switch (action) {
      case "attach-energy": return engine.attachEnergy(state, side, payload.handIndex, payload.targetUid);
      case "play-basic":    return engine.playBasic(state, side, payload.handIndex);
      case "evolve":        return engine.evolve(state, side, payload.handIndex, payload.targetUid);
      case "play-trainer":  return engine.playTrainer(state, side, payload.handIndex, { targetUid: payload.targetUid });
      case "retreat":       return engine.retreat(state, side, payload.benchIndex);
      case "attack":        return engine.attack(state, side, payload.attackIndex);
      case "end-turn":      return engine.endTurn(state, side);
      case "concede": {
        state.winner = engine.opponentOf(side);
        state.phase = "over";
        state.log.push({ text: `${state.players[side].name} conceded.` });
        return true;
      }
      default: throw new Error("Unknown action.");
    }
  }

  app.post("/api/mp/tcg/match/:id/action", async (req, res) => {
    try {
      const matchId = req.params.id;
      const playerId = String(req.body?.playerId || "");
      const action = String(req.body?.action || "");
      const payload = req.body?.payload || {};
      if (!playerId) return res.status(400).json({ error: "playerId required" });

      const engine = await getEngine();
      let outErr = null;
      await store.roomWithLock(matchId, async (m) => {
        if (!m || !m.state) { outErr = "Match not found."; return; }
        const side = sideForPlayer(m, playerId);
        if (!side) { outErr = "Not in this match."; return; }
        if (m.state.winner) { outErr = "Match is over."; return; }
        // Turn guard (concede is always allowed). Most engine calls also
        // assert this, but end-turn silently no-ops out of turn — reject it
        // here so a stale/racing client gets a clean error instead of a
        // phantom version bump.
        if (action !== "concede" && m.state.activePlayer !== side) { outErr = "Not your turn."; return; }
        try {
          applyAction(engine, m.state, side, action, payload);
        } catch (err) {
          outErr = err && err.message ? err.message : "Illegal move.";
          return;
        }
        m.v += 1;
      });
      if (outErr) return res.status(400).json({ error: outErr });

      const m = await store.roomGet(matchId);
      if (!m) return res.status(404).json({ error: "Match vanished." });
      const side = sideForPlayer(m, playerId);
      const out = { view: viewFor(m, side) };
      if (m.state.winner) out.gameOver = true;
      res.json(out);
    } catch (err) {
      console.error("[mp-tcg] action threw:", err);
      if (!res.headersSent) res.status(500).json({ error: `Action failed: ${err?.message || "unknown"}` });
    }
  });
}

module.exports = { mount, viewFor };
