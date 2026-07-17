// Client transport for TCG multiplayer. Talks to the server-authoritative
// /api/mp/tcg/* routes over HTTP polling (same shape as the main battler's
// multiplayer client). The board treats this as a "driver": it awaits the
// returned view for its own actions and receives the opponent's moves through
// the onState callback fired by the match poll.
//
//   findMatch({ deckId, displayName })   — quick match / matchmaking
//   cancelMatch()
//   createRoom({ deckId, displayName })  — private room, resolves to a code
//   joinRoom(code, { deckId, displayName })
//   attachEnergy / playBasic / evolve / playTrainer / retreat / attack /
//   endTurn / concede  — each POSTs and resolves to { ok, view, error }
//   onState(fn) / onMatchFound(fn) / onWaiting(fn) / onGameOver(fn) / onError(fn)
//   disconnect()

const BASE = "/api/mp/tcg";
const MATCH_POLL_MS = 1200;
const STATUS_POLL_MS = 2000;

const listeners = { state: [], match: [], waiting: [], over: [], err: [] };
let _matchId = null;
let _version = 0;
let _opts = null;
let _matchTimer = null;
let _statusTimer = null;

function playerId() {
  let id = localStorage.getItem("tcg-mp-player-id");
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `g-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    localStorage.setItem("tcg-mp-player-id", id);
  }
  return id;
}

function emit(name, payload) {
  for (const fn of listeners[name]) { try { fn(payload); } catch (e) { console.error("[tcg-net]", name, e); } }
}
const on = (name) => (fn) => { listeners[name].push(fn); return () => { const i = listeners[name].indexOf(fn); if (i >= 0) listeners[name].splice(i, 1); }; };

export const onState = on("state");
export const onMatchFound = on("match");
export const onWaiting = on("waiting");
export const onGameOver = on("over");
export const onError = on("err");

function post(path, body) {
  return fetch(BASE + path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, playerId: playerId() }),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
}

function stopMatchPoll() { if (_matchTimer) { clearInterval(_matchTimer); _matchTimer = null; } }
function stopStatusPoll() { if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; } }

function deliver(view, { over = false } = {}) {
  if (!view) return;
  _version = view.v;
  emit("state", view);
  if (view.winner || over) { emit("over", view); stopMatchPoll(); }
}

async function pollMatchOnce() {
  if (!_matchId) return;
  try {
    const r = await fetch(`${BASE}/match/${_matchId}?playerId=${encodeURIComponent(playerId())}&since=${_version}`);
    if (r.status === 204 || !r.ok) return;
    const data = await r.json();
    deliver(data.view);
  } catch {}
}

function startMatchPoll() {
  stopMatchPoll(); stopStatusPoll();
  _matchTimer = setInterval(pollMatchOnce, MATCH_POLL_MS);
}

function startStatusPoll() {
  stopStatusPoll();
  _statusTimer = setInterval(async () => {
    try {
      const r = await fetch(`${BASE}/match-status?playerId=${encodeURIComponent(playerId())}`);
      if (!r.ok) return;
      const data = await r.json();
      if (data.state === "matched" && data.view) {
        _matchId = data.view.matchId;
        _version = data.view.v;
        stopStatusPoll();
        emit("match", data.view);
        emit("state", data.view);
        startMatchPoll();
      }
    } catch {}
  }, STATUS_POLL_MS);
}

// ---- matchmaking ----------------------------------------------------------
export async function findMatch(opts) {
  _opts = opts;
  const { status, data } = await post("/queue", opts);
  if (status >= 400) { emit("err", data.error || "Matchmaking failed."); return; }
  if (data.state === "matched" && data.view) {
    _matchId = data.view.matchId; _version = data.view.v;
    emit("match", data.view); deliver(data.view); startMatchPoll();
  } else {
    emit("waiting");
    startStatusPoll();
  }
}

export async function cancelMatch() {
  stopStatusPoll();
  try { await fetch(`${BASE}/queue?playerId=${encodeURIComponent(playerId())}`, { method: "DELETE" }); } catch {}
}

export async function createRoom(opts) {
  _opts = opts;
  const { status, data } = await post("/host", opts);
  if (status >= 400) { emit("err", data.error || "Could not create room."); return null; }
  startStatusPoll();
  return data.code;
}

export async function joinRoom(code, opts) {
  _opts = opts;
  const { status, data } = await post("/join", { ...opts, code });
  if (status >= 400) { emit("err", data.error || "Could not join room."); return false; }
  _matchId = data.view.matchId; _version = data.view.v;
  emit("match", data.view); deliver(data.view); startMatchPoll();
  return true;
}

// ---- actions --------------------------------------------------------------
async function action(name, payload = {}) {
  if (!_matchId) return { ok: false, error: "No match." };
  const { status, data } = await post(`/match/${_matchId}/action`, { action: name, payload });
  if (status >= 400 || data.error) return { ok: false, error: data.error || "Move rejected." };
  deliver(data.view, { over: !!data.gameOver });
  return { ok: true, view: data.view };
}

export const attachEnergy = (handIndex, targetUid) => action("attach-energy", { handIndex, targetUid });
export const playBasic    = (handIndex) => action("play-basic", { handIndex });
export const evolve       = (handIndex, targetUid) => action("evolve", { handIndex, targetUid });
export const playTrainer  = (handIndex, targetUid) => action("play-trainer", { handIndex, targetUid });
export const retreat      = (benchIndex) => action("retreat", { benchIndex });
export const attack       = (attackIndex) => action("attack", { attackIndex });
export const endTurn      = () => action("end-turn");
export const concede      = () => action("concede");

export function disconnect() {
  stopMatchPoll(); stopStatusPoll();
  _matchId = null; _version = 0;
  for (const k of Object.keys(listeners)) listeners[k] = [];
}

export function isActive() { return !!_matchId; }
