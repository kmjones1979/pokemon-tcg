// Client-side multiplayer adapter. Wraps the Socket.IO transport into a
// declarative API the main.js render loop can use the same way it uses the
// single-player engine.
//
// Public:
//   connect()              -> Promise<void>  // establish socket + ensure playerId
//   findMatch(opts)        -> emits queue:join, resolves on match:found
//   cancelMatch()
//   createPrivateRoom(opts)-> Promise<{code}>
//   joinPrivateRoom(code, opts)
//   playCard(handIndex)
//   attack(fromSlot, target)
//   endTurn()
//   concede()
//   onStateUpdate(fn)
//   onAnimation(fn)
//   onGameOver(fn)
//   onError(fn)
//   onQueueWaiting(fn)
//   onRoomCreated(fn)
//   isConnected()

let socket = null;
const listeners = {
  state: [],
  anim: [],
  over: [],
  err: [],
  queue: [],
  roomCreated: [],
  reconnected: [],
  match: [],
};

function playerId() {
  let id = localStorage.getItem("pokemon-tcg-player-id");
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `g-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    localStorage.setItem("pokemon-tcg-player-id", id);
  }
  return id;
}

export async function connect() {
  if (socket && socket.connected) return socket;
  // The slop-computer base socket is already constructed inline in index.html
  // for auto-reload. We open a fresh dedicated socket here so we can pass
  // auth.playerId. Multiple sockets to the same server are fine.
  if (typeof window.io !== "function") throw new Error("socket.io client not loaded");
  socket = window.io({
    auth: { playerId: playerId() },
    autoConnect: true,
    forceNew: true,
  });
  socket.on("state:update", (s) => listeners.state.forEach((fn) => fn(s)));
  socket.on("state:animation", (a) => listeners.anim.forEach((fn) => fn(a)));
  socket.on("game:over", (g) => listeners.over.forEach((fn) => fn(g)));
  socket.on("error", (e) => listeners.err.forEach((fn) => fn(e)));
  socket.on("queue:waiting", (w) => listeners.queue.forEach((fn) => fn(w)));
  socket.on("room:created", (r) => listeners.roomCreated.forEach((fn) => fn(r)));
  socket.on("match:found", (m) => {
    // route match:found into both opponent + state listeners
    listeners.match.forEach((fn) => fn(m));
    listeners.state.forEach((fn) => fn(m.state));
    if (m.reconnected) listeners.reconnected.forEach((fn) => fn(m));
  });
  return new Promise((res) => {
    if (socket.connected) return res();
    socket.once("connect", () => res());
  });
}

export function isConnected() { return !!socket?.connected; }
export function findMatch(opts) { socket?.emit("queue:join", opts); }
export function cancelMatch() { socket?.emit("queue:cancel"); }
export function createPrivateRoom(opts) { socket?.emit("room:create", opts); }
export function joinPrivateRoom(code, opts) { socket?.emit("room:join", { code, ...opts }); }
export function playCard(handIndex) { socket?.emit("game:play-card", { handIndex }); }
export function attack(fromSlot, target, abilityId = "basic") { socket?.emit("game:attack", { fromSlot, target, abilityId }); }
export function endTurn() { socket?.emit("game:end-turn"); }
export function concede() { socket?.emit("game:concede"); }
export function useItem(itemId, target) { socket?.emit("game:use-item", { itemId, target }); }

export function onStateUpdate(fn) { listeners.state.push(fn); return () => detach("state", fn); }
export function onAnimation(fn) { listeners.anim.push(fn); return () => detach("anim", fn); }
export function onGameOver(fn) { listeners.over.push(fn); return () => detach("over", fn); }
export function onError(fn) { listeners.err.push(fn); return () => detach("err", fn); }
export function onQueueWaiting(fn) { listeners.queue.push(fn); return () => detach("queue", fn); }
export function onRoomCreated(fn) { listeners.roomCreated.push(fn); return () => detach("roomCreated", fn); }
export function onReconnected(fn) { listeners.reconnected.push(fn); return () => detach("reconnected", fn); }
export function onMatchFound(fn) { listeners.match.push(fn); return () => detach("match", fn); }

function detach(name, fn) {
  const arr = listeners[name];
  const i = arr.indexOf(fn);
  if (i >= 0) arr.splice(i, 1);
}

export function disconnect() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  for (const k of Object.keys(listeners)) listeners[k] = [];
}
