// HTTP-polling multiplayer client. Drop-in replacement for the old
// Socket.IO version with the same public surface — main.js doesn't need
// to know that the transport changed.
//
//   connect()              -> Promise<void> (no-op for compatibility)
//   findMatch(opts)
//   cancelMatch()
//   createPrivateRoom(opts)
//   joinPrivateRoom(code, opts)
//   playCard(handIndex, replaceSlot?, spellTarget?)
//   attack(fromSlot, target, abilityId)
//   endTurn()
//   concede()
//   useItem(itemId, target)
//   onStateUpdate(fn) / onAnimation(fn) / onGameOver(fn) / onError(fn)
//   onQueueWaiting(fn) / onRoomCreated(fn) / onMatchFound(fn) / onReconnected(fn)
//   disconnect()
//
// Polling cadence:
//   while in queue / waiting:   GET /api/mp/match-status  every 2s
//   while in a match:           GET /api/mp/match/:id?since=v  every 1.2s
//
// Actions are POSTed and the response carries the new view, so the active
// player sees instant updates; the opponent picks up the change on their
// next poll tick.

const listeners = {
  state: [], anim: [], over: [], err: [],
  queue: [], roomCreated: [], reconnected: [], match: [],
};

let _matchId = null;
let _version = 0;
let _animVersion = 0;
let _opts = null;
let _pollHandle = null;
let _statusHandle = null;

function playerId() {
  let id = localStorage.getItem("pokemon-tcg-player-id");
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `g-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    localStorage.setItem("pokemon-tcg-player-id", id);
  }
  return id;
}

function emit(name, payload) {
  for (const fn of listeners[name]) {
    try { fn(payload); } catch (e) { console.error("[mp]", name, e); }
  }
}

function on(name) {
  return (fn) => {
    listeners[name].push(fn);
    return () => {
      const i = listeners[name].indexOf(fn);
      if (i >= 0) listeners[name].splice(i, 1);
    };
  };
}

export const onStateUpdate = on("state");
export const onAnimation = on("anim");
export const onGameOver = on("over");
export const onError = on("err");
export const onQueueWaiting = on("queue");
export const onRoomCreated = on("roomCreated");
export const onReconnected = on("reconnected");
export const onMatchFound = on("match");

// Polling helpers
function stopStatusPoll() {
  if (_statusHandle) { clearInterval(_statusHandle); _statusHandle = null; }
}
function stopMatchPoll() {
  if (_pollHandle) { clearInterval(_pollHandle); _pollHandle = null; }
}

async function startMatchPoll() {
  stopMatchPoll();
  stopStatusPoll();
  _pollHandle = setInterval(pollMatchOnce, 1200);
}

function deliverView(view) {
  if (!view) return;
  _version = view.v;
  // Fire an anim event if there's a fresh action attached to this view.
  if (view.lastAnim && view.lastAnim.v && view.lastAnim.v > _animVersion) {
    _animVersion = view.lastAnim.v;
    emit("anim", view.lastAnim);
  }
  emit("state", view);
  if (view.winner) stopMatchPoll();
}

async function pollMatchOnce() {
  if (!_matchId) return;
  try {
    const r = await fetch(`/api/mp/match/${_matchId}?playerId=${encodeURIComponent(playerId())}&since=${_version}`);
    if (r.status === 204) return;
    if (!r.ok) return;
    const data = await r.json();
    deliverView(data.view);
  } catch {}
}

async function startStatusPoll() {
  stopStatusPoll();
  _statusHandle = setInterval(async () => {
    try {
      const r = await fetch(`/api/mp/match-status?playerId=${encodeURIComponent(playerId())}`);
      if (!r.ok) return;
      const data = await r.json();
      if (data.state === "matched" && data.view) {
        _matchId = data.view.matchId;
        _version = data.view.v;
        emit("match", {
          roomId: _matchId,
          opponent: data.view.opponent,
          state: data.view,
        });
        emit("state", data.view);
        startMatchPoll();
      }
    } catch {}
  }, 2000);
}

// ---- Public API ----------------------------------------------------------
export async function connect() { /* no-op for compat */ }
export function isConnected() { return true; }

export async function findMatch(opts) {
  _opts = opts;
  emit("queue", { position: 1 });
  try {
    const r = await fetch("/api/mp/queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...opts, playerId: playerId() }),
    });
    const data = await r.json();
    if (!r.ok) return emit("err", { error: data.error || "queue failed" });
    if (data.state === "matched" && data.view) {
      _matchId = data.view.matchId;
      emit("match", { roomId: _matchId, opponent: data.view.opponent, state: data.view });
      deliverView(data.view);
      startMatchPoll();
    } else {
      // Waiting — start status polling.
      startStatusPoll();
    }
  } catch (err) {
    emit("err", { error: err.message || "queue failed" });
  }
}

export async function cancelMatch() {
  stopStatusPoll();
  try {
    await fetch(`/api/mp/queue?playerId=${encodeURIComponent(playerId())}`, { method: "DELETE" });
  } catch {}
}

export async function createPrivateRoom(opts) {
  _opts = opts;
  try {
    const r = await fetch("/api/mp/host", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...opts, playerId: playerId() }),
    });
    const data = await r.json();
    if (!r.ok) return emit("err", { error: data.error || "host failed" });
    emit("roomCreated", { code: data.code });
    // Start polling status — when the joiner connects, we'll see the match.
    startStatusPoll();
  } catch (err) {
    emit("err", { error: err.message || "host failed" });
  }
}

export async function joinPrivateRoom(code, opts) {
  _opts = opts;
  try {
    const r = await fetch("/api/mp/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...opts, code, playerId: playerId() }),
    });
    const data = await r.json();
    if (!r.ok) return emit("err", { error: data.error || "join failed" });
    _matchId = data.view.matchId;
    emit("match", { roomId: _matchId, opponent: data.view.opponent, state: data.view });
    deliverView(data.view);
    startMatchPoll();
  } catch (err) {
    emit("err", { error: err.message || "join failed" });
  }
}

// Defensive JSON parser. iOS Safari throws "The string did not match the
// expected pattern." and Chrome/Firefox throw "Unexpected Token" when
// you JSON.parse an HTML 500 page. Catch the parse failure and replace
// it with a useful message that names the status code instead.
async function safeJson(r, label) {
  try {
    return await r.json();
  } catch {
    throw new Error(`${label}: server returned non-JSON (status ${r.status})`);
  }
}

async function postAction(action, payload) {
  if (!_matchId) return;
  try {
    const r = await fetch(`/api/mp/match/${_matchId}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId: playerId(), action, payload }),
    });
    const data = await safeJson(r, action);
    if (!r.ok) {
      emit("err", { error: data.error || `${action} rejected` });
      return;
    }
    if (data.view) deliverView(data.view);
    if (data.gameOver) {
      emit("over", {
        winner: data.view?.winner,
        youWin: data.view?.winner === "player",
        reward: data.reward || null,
      });
      stopMatchPoll();
    }
  } catch (err) {
    emit("err", { error: err.message || "network error" });
  }
}

export function playCard(handIndex, replaceSlot = null, spellTarget = null) {
  // replaceSlot — only meaningful for Pokémon plays when the field is
  //   full (the slot to sacrifice).
  // spellTarget — only meaningful for spell cards (the slot to target
  //   on the enemy or own field). The server forwards both to the
  //   engine; the engine ignores irrelevant ones per card kind.
  postAction("play-card", { handIndex, replaceSlot, spellTarget });
}
export function attack(fromSlot, target, abilityId = "basic") {
  postAction("attack", { fromSlot, target, abilityId });
}
export function endTurn()       { postAction("end-turn"); }
export function concede()       { postAction("concede"); }
export function useItem(itemId, target) { postAction("use-item", { itemId, target }); }

export function disconnect() {
  stopMatchPoll();
  stopStatusPoll();
  _matchId = null;
  _version = 0;
  for (const k of Object.keys(listeners)) listeners[k] = [];
}
