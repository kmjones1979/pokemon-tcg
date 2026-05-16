// Socket.IO multiplayer. The server is authoritative — clients send intents,
// server validates against the engine, broadcasts new state.
//
// State organization:
//   rooms : Map<roomId, Room>
//   queue : array of waiting Seat objects (FIFO)
//   bySocket : Map<socketId, { roomId, side }>
//
// A Seat is: { playerId, displayName, ability, deckSource, socketId }
//   playerId: stable identifier (user.id if signed-in, guest-id otherwise)
//   deckSource: "active" (use saved active deck) or "random"
//
// A Room is: { id, code?, players: { player: SeatWithSide, ai: SeatWithSide },
//   state: GameState, disconnects: { player?: timeoutId, ai?: timeoutId } }
//
// Event names match the Phase 3 spec:
//   client → server: queue:join, queue:cancel, room:create, room:join,
//                    game:play-card, game:attack, game:end-turn, game:concede
//   server → client: queue:waiting, match:found, room:created, state:update,
//                    state:animation, game:over, error

const { randomUUID } = require("crypto");
const { buildDeck, toCard } = require("../shared/deck-builder");
const { offerForOutcome } = require("./rewards");

const RECONNECT_GRACE_MS = 60_000;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const ROOM_CODE_LEN = 6;

let _engine = null; // lazily-imported ESM engine (client/js/game.js)

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

// Build a state view from a given recipient's POV. Crucially, this NORMALIZES
// the side labels so the recipient always appears as the "player" side, and
// the opponent always appears as the "ai" side. That lets the same renderer
// code handle both single-player and either multiplayer seat. The opponent's
// hand contents are replaced with placeholders so card identity is never
// leaked over the wire.
function viewFor(state, mySide) {
  const oppSide = mySide === "player" ? "ai" : "player";
  return {
    turn: state.turn,
    activePlayer: state.activePlayer === mySide ? "player" : "ai",
    phase: state.phase,
    winner:
      state.winner == null
        ? null
        : state.winner === mySide
          ? "player"
          : "ai",
    log: state.log.slice(-20),
    players: {
      player: state.players[mySide],
      ai: {
        ...state.players[oppSide],
        hand: state.players[oppSide].hand.map(() => ({ hidden: true })),
        deck: [],
      },
    },
    youAre: "player",
  };
}

// Translate a side label out of a recipient's POV back to the real side on
// the server's engine state. Used so animation broadcasts come out correct
// per-recipient.
function fromPov(label, mySide) {
  if (label === "player") return mySide;
  if (label === "ai") return mySide === "player" ? "ai" : "player";
  return label;
}
function toPov(realSide, mySide) {
  return realSide === mySide ? "player" : "ai";
}

function attach(io, supabase, pokedexOrGetter) {
  const rooms = new Map();
  const queue = [];
  const bySocket = new Map();
  const getPokedex = typeof pokedexOrGetter === "function"
    ? pokedexOrGetter
    : () => pokedexOrGetter;

  async function ensureDeck(seat) {
    if (seat.deckSource === "active" && seat.userId) {
      try {
        const { data: deck } = await supabase
          .from("decks")
          .select("*")
          .eq("user_id", seat.userId)
          .eq("is_active", true)
          .maybeSingle();
        if (deck?.card_ids?.length === 30) {
          const ids = [...new Set(deck.card_ids)];
          const { data: rows } = await supabase
            .from("pokemon")
            .select("*")
            .in("id", ids);
          const byId = new Map((rows || []).map((r) => [r.id, toCard(r)]));
          const cards = deck.card_ids.map((id) => byId.get(id)).filter(Boolean);
          if (cards.length === 30) return cards;
        }
      } catch (err) {
        console.warn("[mp] active-deck fetch failed:", err.message);
      }
    }
    return buildDeck(getPokedex());
  }

  async function startMatch(p1Seat, p2Seat) {
    const engine = await getEngine();
    const [p1Deck, p2Deck] = await Promise.all([ensureDeck(p1Seat), ensureDeck(p2Seat)]);
    const state = engine.createGame({
      playerDeck: p1Deck,
      aiDeck: p2Deck,
      playerAbility: p1Seat.ability || "brock",
      aiAbility: p2Seat.ability || "pikachu",
    });
    const roomId = randomUUID();
    const room = {
      id: roomId,
      code: p1Seat.code || null,
      isPrivate: !!p1Seat.code,
      players: {
        player: { ...p1Seat, side: "player" },
        ai:     { ...p2Seat, side: "ai" },
      },
      state,
      disconnects: {},
      // Match record for persistence on game-over
      matchInsertPromise: insertMatchRecord(supabase, p1Seat, p2Seat),
    };
    rooms.set(roomId, room);
    bySocket.set(p1Seat.socketId, { roomId, side: "player" });
    bySocket.set(p2Seat.socketId, { roomId, side: "ai" });
    const s1 = io.sockets.sockets.get(p1Seat.socketId);
    const s2 = io.sockets.sockets.get(p2Seat.socketId);
    s1?.join(roomId);
    s2?.join(roomId);
    s1?.emit("match:found", {
      roomId,
      opponent: { displayName: p2Seat.displayName, ability: p2Seat.ability },
      state: viewFor(state, "player"),
    });
    s2?.emit("match:found", {
      roomId,
      opponent: { displayName: p1Seat.displayName, ability: p1Seat.ability },
      state: viewFor(state, "ai"),
    });
  }

  async function insertMatchRecord(supabase, p1, p2) {
    if (!supabase) return null;
    const { data, error } = await supabase
      .from("matches")
      .insert({
        p1_user_id: p1.userId || null,
        p2_user_id: p2.userId || null,
        started_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error) {
      console.warn("[mp] match insert failed:", error.message);
      return null;
    }
    return data.id;
  }

  function broadcast(room) {
    const ps = io.sockets.sockets.get(room.players.player.socketId);
    const as = io.sockets.sockets.get(room.players.ai.socketId);
    ps?.emit("state:update", viewFor(room.state, "player"));
    as?.emit("state:update", viewFor(room.state, "ai"));
  }

  function announceWinner(room, reason) {
    if (!room.state.winner) return;
    const winnerSide = room.state.winner;
    const winnerSeat = room.players[winnerSide];
    const loserSeat = room.players[winnerSide === "player" ? "ai" : "player"];

    // Persist outcome (don't await — fire-and-forget)
    (async () => {
      try {
        const matchId = await room.matchInsertPromise;
        if (matchId && supabase) {
          await supabase
            .from("matches")
            .update({
              winner_id: winnerSeat.userId || null,
              reason: reason || "ko",
              turns: room.state.turn,
              ended_at: new Date().toISOString(),
            })
            .eq("id", matchId);
        }
      } catch (err) {
        console.warn("[mp] match update failed:", err.message);
      }
    })();

    const pSock = io.sockets.sockets.get(room.players.player.socketId);
    const aSock = io.sockets.sockets.get(room.players.ai.socketId);

    // Roll reward offers for signed-in players (guests get none).
    let pOffer = null;
    let aOffer = null;
    const dex = getPokedex();
    if (dex.length > 0) {
      if (room.players.player.userId) {
        pOffer = offerForOutcome(room.players.player.userId, dex, winnerSide === "player");
      }
      if (room.players.ai.userId) {
        aOffer = offerForOutcome(room.players.ai.userId, dex, winnerSide === "ai");
      }
    }

    pSock?.emit("game:over", {
      winner: winnerSide,
      youWin: winnerSide === "player",
      reason,
      reward: pOffer,
    });
    aSock?.emit("game:over", {
      winner: winnerSide,
      youWin: winnerSide === "ai",
      reason,
      reward: aOffer,
    });
  }

  io.on("connection", (socket) => {
    // Each socket also carries a playerId set by the client at handshake time.
    // For signed-in users we'll later cross-check this against the session
    // cookie on the upgrade; for now we trust it for matchmaking only.
    const playerId = String(socket.handshake.auth?.playerId || socket.id);
    socket.data.playerId = playerId;

    socket.on("queue:join", async (opts = {}) => {
      const seat = {
        socketId: socket.id,
        playerId,
        userId: opts.userId || null,
        displayName: String(opts.displayName || "Trainer").slice(0, 32),
        ability: opts.ability || "brock",
        deckSource: opts.deckSource || "random",
      };
      // If there's already a waiting opponent, pair up.
      while (queue.length > 0) {
        const peer = queue.shift();
        const peerSocket = io.sockets.sockets.get(peer.socketId);
        if (!peerSocket) continue; // peer dropped
        await startMatch(peer, seat);
        return;
      }
      queue.push(seat);
      socket.emit("queue:waiting", { position: queue.length });
    });

    socket.on("queue:cancel", () => {
      const i = queue.findIndex((s) => s.socketId === socket.id);
      if (i >= 0) queue.splice(i, 1);
    });

    socket.on("room:create", (opts = {}) => {
      const code = randCode();
      const seat = {
        socketId: socket.id,
        playerId,
        userId: opts.userId || null,
        displayName: String(opts.displayName || "Trainer").slice(0, 32),
        ability: opts.ability || "brock",
        deckSource: opts.deckSource || "random",
        code,
      };
      // Stash in a side-map of waiting private rooms.
      privateRooms.set(code, seat);
      socket.emit("room:created", { code });
    });

    socket.on("room:join", async (opts = {}) => {
      const code = String(opts.code || "").toUpperCase().trim();
      const host = privateRooms.get(code);
      if (!host) return socket.emit("error", { error: "Room not found." });
      if (host.socketId === socket.id) return socket.emit("error", { error: "Can't join your own room." });
      privateRooms.delete(code);
      const joinerSeat = {
        socketId: socket.id,
        playerId,
        userId: opts.userId || null,
        displayName: String(opts.displayName || "Trainer").slice(0, 32),
        ability: opts.ability || "brock",
        deckSource: opts.deckSource || "random",
      };
      await startMatch(host, joinerSeat);
    });

    function withRoom(fn) {
      const ref = bySocket.get(socket.id);
      if (!ref) return socket.emit("error", { error: "Not in a match." });
      const room = rooms.get(ref.roomId);
      if (!room) return socket.emit("error", { error: "Room not found." });
      if (room.state.winner) return socket.emit("error", { error: "Match is over." });
      try { fn(room, ref.side); } catch (err) {
        console.error("[mp]", err);
        socket.emit("error", { error: err.message });
      }
    }

    socket.on("game:play-card", async ({ handIndex } = {}) => {
      withRoom(async (room, side) => {
        const engine = await getEngine();
        const r = engine.playCard(room.state, side, handIndex);
        if (!r.ok) return socket.emit("error", { error: r.reason });
        broadcast(room);
      });
    });

    socket.on("game:attack", async ({ fromSlot, target } = {}) => {
      withRoom(async (room, side) => {
        const engine = await getEngine();
        const r = engine.attack(room.state, side, fromSlot, target);
        if (!r.ok) return socket.emit("error", { error: r.reason });
        // Emit an animation hint per-recipient with normalized side labels.
        for (const recvSide of ["player", "ai"]) {
          const sock = io.sockets.sockets.get(room.players[recvSide].socketId);
          sock?.emit("state:animation", {
            kind: "attack",
            fromSide: toPov(side, recvSide),
            fromSlot,
            target,
            damage: r.damage,
            multiplier: r.multiplier,
            verdict: r.verdict,
            knockedOut: !!r.knockedOut,
          });
        }
        broadcast(room);
        if (room.state.winner) announceWinner(room, "ko");
      });
    });

    socket.on("game:end-turn", async () => {
      withRoom(async (room, side) => {
        if (room.state.activePlayer !== side) return socket.emit("error", { error: "Not your turn." });
        const engine = await getEngine();
        engine.endTurn(room.state);
        broadcast(room);
        if (room.state.winner) announceWinner(room, "ko");
      });
    });

    socket.on("game:concede", () => {
      withRoom((room, side) => {
        const other = side === "player" ? "ai" : "player";
        room.state.winner = other;
        room.state.phase = "over";
        room.state.log.push({ id: room.state.log.length + 1, text: `${room.players[side].displayName} conceded.`, kind: "win" });
        broadcast(room);
        announceWinner(room, "concede");
      });
    });

    socket.on("disconnect", () => {
      // Remove from queue if we were waiting.
      const i = queue.findIndex((s) => s.socketId === socket.id);
      if (i >= 0) queue.splice(i, 1);

      // Remove waiting private room.
      for (const [code, host] of privateRooms) {
        if (host.socketId === socket.id) privateRooms.delete(code);
      }

      const ref = bySocket.get(socket.id);
      if (!ref) return;
      bySocket.delete(socket.id);
      const room = rooms.get(ref.roomId);
      if (!room || room.state.winner) return;

      // Start a 60s grace window. If the player reconnects (same playerId),
      // we'll cancel it inside the connection handler.
      const otherSide = ref.side === "player" ? "ai" : "player";
      const otherSocket = io.sockets.sockets.get(room.players[otherSide].socketId);
      otherSocket?.emit("state:animation", {
        kind: "opponent-disconnected",
        graceMs: RECONNECT_GRACE_MS,
      });
      room.disconnects[ref.side] = setTimeout(() => {
        if (room.state.winner) return;
        room.state.winner = otherSide;
        room.state.phase = "over";
        room.state.log.push({
          id: room.state.log.length + 1,
          text: `${room.players[ref.side].displayName} disconnected — opponent wins.`,
          kind: "warn",
        });
        broadcast(room);
        announceWinner(room, "disconnect");
      }, RECONNECT_GRACE_MS);
      room.players[ref.side].socketId = null;
    });

    // Reconnect: client provides playerId at handshake. Look for a room where
    // someone with that playerId went missing.
    for (const room of rooms.values()) {
      for (const side of ["player", "ai"]) {
        const seat = room.players[side];
        if (seat.playerId === playerId && !seat.socketId) {
          seat.socketId = socket.id;
          bySocket.set(socket.id, { roomId: room.id, side });
          socket.join(room.id);
          if (room.disconnects[side]) {
            clearTimeout(room.disconnects[side]);
            delete room.disconnects[side];
          }
          socket.emit("match:found", {
            roomId: room.id,
            opponent: {
              displayName: room.players[side === "player" ? "ai" : "player"].displayName,
              ability: room.players[side === "player" ? "ai" : "player"].ability,
            },
            state: viewFor(room.state, side),
            reconnected: true,
          });
          break;
        }
      }
    }
  });

  return { rooms, queue, privateRooms };
}

// Module-level so the closure inside attach() can reference it.
const privateRooms = new Map(); // code → seat (host waiting)

module.exports = { attach, viewFor };
