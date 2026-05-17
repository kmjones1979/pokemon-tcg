// Socket.IO multiplayer. Server-authoritative.
//
// Cross-instance state (rooms, queue, privateRooms, socket↔room binding,
// player↔room reconnect) lives in `state-store.js` (Redis in prod, in-memory
// fallback locally). Each event handler:
//   1. resolves the room id from the socket binding
//   2. loads + mutates + saves the room with a short Redis lock
//   3. broadcasts the resulting view via Socket.IO (the Redis adapter
//      ensures other instances forward the event to their connected client)

const { randomUUID } = require("crypto");
const { buildDeck, toCard } = require("../shared/deck-builder");
const { offerForOutcome } = require("./rewards");
const store = require("./state-store");

const RECONNECT_GRACE_MS = 60_000;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const ROOM_CODE_LEN = 6;

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

// Build a state view from a given recipient's POV. Normalises labels so the
// recipient always appears as "player" and the opponent as "ai" — same shape
// for both single-player and either multiplayer seat. Opponent hand contents
// are replaced with placeholders.
function viewFor(state, mySide) {
  const oppSide = mySide === "player" ? "ai" : "player";
  return {
    turn: state.turn,
    activePlayer: state.activePlayer === mySide ? "player" : "ai",
    phase: state.phase,
    winner:
      state.winner == null ? null : state.winner === mySide ? "player" : "ai",
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

function toPov(realSide, mySide) {
  return realSide === mySide ? "player" : "ai";
}

function attach(io, supabase, pokedexOrGetter) {
  const getPokedex = typeof pokedexOrGetter === "function"
    ? pokedexOrGetter
    : () => pokedexOrGetter;

  // Wire the Redis adapter so io.emit / io.to(roomId).emit fans out across
  // function instances. No-op when REDIS_URL isn't set.
  store.makeSocketIoAdapter(io);

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
    let matchId = null;
    if (supabase) {
      try {
        const { data } = await supabase
          .from("matches")
          .insert({
            p1_user_id: p1Seat.userId || null,
            p2_user_id: p2Seat.userId || null,
            started_at: new Date().toISOString(),
          })
          .select("id")
          .single();
        matchId = data?.id || null;
      } catch (err) {
        console.warn("[mp] match insert failed:", err.message);
      }
    }
    const room = {
      id: roomId,
      isPrivate: !!p1Seat.code,
      matchId,
      players: {
        player: { ...p1Seat, side: "player" },
        ai:     { ...p2Seat, side: "ai" },
      },
      state,
    };
    await store.roomSet(roomId, room);
    await Promise.all([
      store.socketBind(p1Seat.socketId, { roomId, side: "player" }),
      store.socketBind(p2Seat.socketId, { roomId, side: "ai" }),
      store.playerBind(p1Seat.playerId, roomId),
      store.playerBind(p2Seat.playerId, roomId),
    ]);
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

  function emitToSocket(socketId, event, payload) {
    if (!socketId) return;
    const sock = io.sockets.sockets.get(socketId);
    if (sock) {
      sock.emit(event, payload);
      return;
    }
    // Socket lives on a different instance — the Redis adapter ensures the
    // event reaches it when we emit to a room. We use the socketId as a
    // 1-member room for this purpose.
    io.to(socketId).emit(event, payload);
  }

  function broadcast(room) {
    emitToSocket(room.players.player.socketId, "state:update", viewFor(room.state, "player"));
    emitToSocket(room.players.ai.socketId, "state:update", viewFor(room.state, "ai"));
  }

  async function announceWinner(room, reason) {
    if (!room.state.winner) return;
    const winnerSide = room.state.winner;
    const winnerSeat = room.players[winnerSide];

    if (supabase && room.matchId) {
      supabase
        .from("matches")
        .update({
          winner_id: winnerSeat.userId || null,
          reason: reason || "ko",
          turns: room.state.turn,
          ended_at: new Date().toISOString(),
        })
        .eq("id", room.matchId)
        .then(() => {}, (err) => console.warn("[mp] match update failed:", err.message));
    }

    let pOffer = null;
    let aOffer = null;
    const dex = getPokedex();
    if (dex.length > 0) {
      if (room.players.player.userId) {
        pOffer = await offerForOutcome(room.players.player.userId, dex, winnerSide === "player");
      }
      if (room.players.ai.userId) {
        aOffer = await offerForOutcome(room.players.ai.userId, dex, winnerSide === "ai");
      }
    }

    emitToSocket(room.players.player.socketId, "game:over", {
      winner: winnerSide,
      youWin: winnerSide === "player",
      reason,
      reward: pOffer,
    });
    emitToSocket(room.players.ai.socketId, "game:over", {
      winner: winnerSide,
      youWin: winnerSide === "ai",
      reason,
      reward: aOffer,
    });
  }

  io.on("connection", async (socket) => {
    const playerId = String(socket.handshake.auth?.playerId || socket.id);
    socket.data.playerId = playerId;
    // Each socket joins a 1-member room named for itself, so other instances
    // can target this socket via the Redis adapter.
    socket.join(socket.id);

    socket.on("queue:join", async (opts = {}) => {
      const seat = {
        socketId: socket.id,
        playerId,
        userId: opts.userId || null,
        displayName: String(opts.displayName || "Trainer").slice(0, 32),
        ability: opts.ability || "brock",
        deckSource: opts.deckSource || "random",
      };
      // Pop the head of the queue; if it's a valid (still connected) peer,
      // pair them. Otherwise enqueue ourselves.
      const peer = await store.queuePopFifo();
      if (peer) {
        await startMatch(peer, seat);
        return;
      }
      await store.queuePush(seat);
      socket.emit("queue:waiting", { position: await store.queueLength() });
    });

    socket.on("queue:cancel", async () => {
      await store.queueRemove(socket.id);
    });

    socket.on("room:create", async (opts = {}) => {
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
      await store.privateRoomSet(code, seat);
      socket.emit("room:created", { code });
    });

    socket.on("room:join", async (opts = {}) => {
      const code = String(opts.code || "").toUpperCase().trim();
      const host = await store.privateRoomTake(code);
      if (!host) return socket.emit("error", { error: "Room not found." });
      if (host.socketId === socket.id) return socket.emit("error", { error: "Can't join your own room." });
      const joiner = {
        socketId: socket.id,
        playerId,
        userId: opts.userId || null,
        displayName: String(opts.displayName || "Trainer").slice(0, 32),
        ability: opts.ability || "brock",
        deckSource: opts.deckSource || "random",
      };
      await startMatch(host, joiner);
    });

    // Higher-order: load room, run fn, save, broadcast. fn returns optional
    // animation payloads to emit per-recipient.
    async function inRoom(fn) {
      const ref = await store.socketRoom(socket.id);
      if (!ref) { socket.emit("error", { error: "Not in a match." }); return; }
      let result;
      await store.roomWithLock(ref.roomId, async (room) => {
        if (!room) { socket.emit("error", { error: "Room not found." }); return; }
        if (room.state.winner) { socket.emit("error", { error: "Match is over." }); return; }
        try {
          result = await fn(room, ref.side);
        } catch (err) {
          console.error("[mp]", err);
          socket.emit("error", { error: err.message });
        }
      });
      return result;
    }

    socket.on("game:play-card", async ({ handIndex, replaceSlot } = {}) => {
      const out = await inRoom(async (room, side) => {
        const engine = await getEngine();
        const r = engine.playCard(room.state, side, handIndex, { replaceSlot });
        if (!r.ok) { socket.emit("error", { error: r.reason }); return null; }
        broadcast(room);
        return { ok: true };
      });
      return out;
    });

    socket.on("game:attack", async ({ fromSlot, target, abilityId } = {}) => {
      await inRoom(async (room, side) => {
        const engine = await getEngine();
        const r = engine.attack(room.state, side, fromSlot, target, { abilityId });
        if (!r.ok) { socket.emit("error", { error: r.reason }); return; }
        for (const recvSide of ["player", "ai"]) {
          emitToSocket(room.players[recvSide].socketId, "state:animation", {
            kind: "attack",
            fromSide: toPov(side, recvSide),
            fromSlot,
            target,
            damage: r.damage,
            multiplier: r.multiplier,
            verdict: r.verdict,
            knockedOut: !!r.knockedOut,
            critical: !!r.critical,
          });
        }
        broadcast(room);
        if (room.state.winner) await announceWinner(room, "ko");
      });
    });

    socket.on("game:use-item", async ({ itemId, target } = {}) => {
      await inRoom(async (room, side) => {
        const engine = await getEngine();
        const r = engine.useItem(room.state, side, itemId, target);
        if (!r.ok) { socket.emit("error", { error: r.reason }); return; }
        broadcast(room);
      });
    });

    socket.on("game:end-turn", async () => {
      await inRoom(async (room, side) => {
        if (room.state.activePlayer !== side) { socket.emit("error", { error: "Not your turn." }); return; }
        const engine = await getEngine();
        engine.endTurn(room.state);
        broadcast(room);
        if (room.state.winner) await announceWinner(room, "ko");
      });
    });

    socket.on("game:concede", async () => {
      await inRoom(async (room, side) => {
        const other = side === "player" ? "ai" : "player";
        room.state.winner = other;
        room.state.phase = "over";
        room.state.log.push({
          id: room.state.log.length + 1,
          text: `${room.players[side].displayName} conceded.`,
          kind: "win",
        });
        broadcast(room);
        await announceWinner(room, "concede");
      });
    });

    socket.on("disconnect", async () => {
      await store.queueRemove(socket.id);
      await store.privateRoomRemoveBySocket(socket.id);

      const ref = await store.socketRoom(socket.id);
      await store.socketUnbind(socket.id);
      if (!ref) return;

      // Notify opponent + start a 60s grace window.
      await store.roomWithLock(ref.roomId, async (room) => {
        if (!room || room.state.winner) return;
        const otherSide = ref.side === "player" ? "ai" : "player";
        emitToSocket(room.players[otherSide].socketId, "state:animation", {
          kind: "opponent-disconnected",
          graceMs: RECONNECT_GRACE_MS,
        });
        room.players[ref.side].socketId = null;
        room.players[ref.side].disconnectedAt = Date.now();
      });

      // Schedule forfeit if no reconnect.
      setTimeout(async () => {
        await store.roomWithLock(ref.roomId, async (room) => {
          if (!room || room.state.winner) return;
          const seat = room.players[ref.side];
          if (seat?.socketId) return; // they reconnected
          const otherSide = ref.side === "player" ? "ai" : "player";
          room.state.winner = otherSide;
          room.state.phase = "over";
          room.state.log.push({
            id: room.state.log.length + 1,
            text: `${seat.displayName} disconnected — opponent wins.`,
            kind: "warn",
          });
          broadcast(room);
          await announceWinner(room, "disconnect");
        });
      }, RECONNECT_GRACE_MS).unref?.();
    });

    // Reconnect — if this playerId has an active room, re-bind.
    try {
      const roomId = await store.playerLastRoom(playerId);
      if (!roomId) return;
      await store.roomWithLock(roomId, async (room) => {
        if (!room || room.state.winner) return;
        for (const side of ["player", "ai"]) {
          if (room.players[side].playerId === playerId && !room.players[side].socketId) {
            room.players[side].socketId = socket.id;
            delete room.players[side].disconnectedAt;
            await store.socketBind(socket.id, { roomId, side });
            socket.join(roomId);
            const opp = side === "player" ? "ai" : "player";
            socket.emit("match:found", {
              roomId,
              opponent: {
                displayName: room.players[opp].displayName,
                ability: room.players[opp].ability,
              },
              state: viewFor(room.state, side),
              reconnected: true,
            });
            break;
          }
        }
      });
    } catch (err) {
      console.warn("[mp] reconnect lookup failed:", err.message);
    }
  });
}

module.exports = { attach, viewFor };
