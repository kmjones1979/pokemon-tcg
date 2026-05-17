// Cross-instance state store for multiplayer.
//
// In production (Vercel Functions), the same Socket.IO event may land on
// different instances because there's no session affinity. The `rooms`,
// `queue`, and `privateRooms` Maps that multiplayer.js used to keep in
// memory have to live somewhere shared — we use Redis.
//
// Locally and in tests we fall back to in-memory if REDIS_URL isn't set.
//
// Interface (every method is async, returns Promise):
//   queuePush(seat)             -> push to FIFO queue
//   queuePopFifo()              -> pop the oldest seat (returns null if empty)
//   queueRemove(socketId)       -> remove a specific seat (cancel)
//   queueLength()               -> number of waiting seats
//
//   roomSet(roomId, room)       -> store full room object
//   roomGet(roomId)             -> { ... } or null
//   roomDelete(roomId)
//   roomExists(roomId)
//   roomWithLock(roomId, fn)    -> atomic load/mutate/save with a short
//                                  Redis SET NX lock. fn(room) may mutate
//                                  room; returned value resolves the promise.
//
//   socketRoom(socketId)        -> { roomId, side } or null
//   socketBind(socketId, ref)
//   socketUnbind(socketId)
//
//   playerLastRoom(playerId)    -> roomId or null (for reconnect)
//   playerBind(playerId, roomId)
//
//   privateRoomSet(code, seat)  -> 5min TTL host seat
//   privateRoomTake(code)       -> claim & delete

const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL;
const QUEUE_KEY = "ptcg:queue";
const ROOM_KEY = (id) => `ptcg:room:${id}`;
const ROOM_LOCK_KEY = (id) => `ptcg:room:${id}:lock`;
const SOCKET_KEY = (id) => `ptcg:socket:${id}`;
const PLAYER_KEY = (id) => `ptcg:player:${id}`;
const PRIVATE_KEY = (code) => `ptcg:priv:${code}`;

const ROOM_TTL_SEC = 60 * 60;        // 1 hour: matches die after an hour idle
const SOCKET_TTL_SEC = 60 * 60;
const PLAYER_TTL_SEC = 60 * 60;
const PRIVATE_TTL_SEC = 5 * 60;
const LOCK_TTL_MS = 4000;

let _client = null;
function client() {
  if (_client) return _client;
  if (!REDIS_URL) return null;
  const Redis = require("ioredis");
  _client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    tls: REDIS_URL.startsWith("rediss://") ? {} : undefined,
  });
  _client.on("error", (err) => console.warn("[redis]", err.message));
  return _client;
}

// --- In-memory fallback (when no REDIS_URL) -------------------------------
const _mem = {
  queue: [],
  rooms: new Map(),
  sockets: new Map(),
  players: new Map(),
  privateRooms: new Map(),
  kv: new Map(),       // generic value + expiry, used by rewards offers
};

// --- Generic KV with TTL (for reward offers etc.) ------------------------
// Stored at `ptcg:kv:<key>`. Values are JSON.stringified.
async function kvSet(key, value, ttlSec) {
  const r = client();
  const fullKey = `ptcg:kv:${key}`;
  const payload = JSON.stringify(value);
  if (r) return r.set(fullKey, payload, "EX", ttlSec);
  _mem.kv.set(fullKey, { value, expiresAt: Date.now() + ttlSec * 1000 });
}
async function kvGet(key) {
  const r = client();
  const fullKey = `ptcg:kv:${key}`;
  if (r) {
    const raw = await r.get(fullKey);
    return raw ? JSON.parse(raw) : null;
  }
  const entry = _mem.kv.get(fullKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _mem.kv.delete(fullKey); return null; }
  return entry.value;
}
// Atomic-ish "consume": fetch + delete in one round trip. We use GETDEL on
// Redis 6.2+; if the client doesn't support it we fall back to GET then
// DEL (small race window, acceptable since the value is opaque to the
// caller — the use case is one-shot offer redemption).
async function kvTake(key) {
  const r = client();
  const fullKey = `ptcg:kv:${key}`;
  if (r) {
    let raw;
    try {
      raw = await r.getdel(fullKey);
    } catch {
      raw = await r.get(fullKey);
      if (raw != null) await r.del(fullKey).catch(() => {});
    }
    return raw ? JSON.parse(raw) : null;
  }
  const entry = _mem.kv.get(fullKey);
  _mem.kv.delete(fullKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) return null;
  return entry.value;
}

// --- Helpers --------------------------------------------------------------
async function withLock(roomId, fn) {
  const r = client();
  const token = Math.random().toString(36).slice(2);
  if (r) {
    const start = Date.now();
    while (Date.now() - start < LOCK_TTL_MS) {
      const got = await r.set(ROOM_LOCK_KEY(roomId), token, "PX", LOCK_TTL_MS, "NX");
      if (got === "OK") {
        try {
          return await fn();
        } finally {
          // Best-effort release; if we time out the key auto-expires.
          const v = await r.get(ROOM_LOCK_KEY(roomId)).catch(() => null);
          if (v === token) await r.del(ROOM_LOCK_KEY(roomId)).catch(() => {});
        }
      }
      // brief jittered backoff
      await new Promise((res) => setTimeout(res, 20 + Math.random() * 60));
    }
    throw new Error(`Could not acquire room lock for ${roomId}`);
  }
  return fn();
}

// --- Queue ---------------------------------------------------------------
async function queuePush(seat) {
  const r = client();
  if (r) return r.rpush(QUEUE_KEY, JSON.stringify(seat));
  _mem.queue.push(seat);
}

async function queuePopFifo() {
  const r = client();
  if (r) {
    const v = await r.lpop(QUEUE_KEY);
    return v ? JSON.parse(v) : null;
  }
  return _mem.queue.shift() || null;
}

// Remove from queue by socketId OR playerId (whichever matches).
async function queueRemove(id) {
  const matches = (s) => {
    try {
      const v = JSON.parse(s);
      return v.socketId === id || v.playerId === id;
    } catch { return false; }
  };
  const r = client();
  if (r) {
    const all = await r.lrange(QUEUE_KEY, 0, -1);
    const keep = all.filter((s) => !matches(s));
    const pipeline = r.multi().del(QUEUE_KEY);
    for (const s of keep) pipeline.rpush(QUEUE_KEY, s);
    await pipeline.exec();
    return;
  }
  const i = _mem.queue.findIndex((s) => s.socketId === id || s.playerId === id);
  if (i >= 0) _mem.queue.splice(i, 1);
}

async function queueLength() {
  const r = client();
  if (r) return r.llen(QUEUE_KEY);
  return _mem.queue.length;
}

// --- Rooms ---------------------------------------------------------------
async function roomSet(roomId, room) {
  const r = client();
  if (r) return r.set(ROOM_KEY(roomId), JSON.stringify(room), "EX", ROOM_TTL_SEC);
  _mem.rooms.set(roomId, room);
}

async function roomGet(roomId) {
  const r = client();
  if (r) {
    const v = await r.get(ROOM_KEY(roomId));
    return v ? JSON.parse(v) : null;
  }
  return _mem.rooms.get(roomId) || null;
}

async function roomDelete(roomId) {
  const r = client();
  if (r) return r.del(ROOM_KEY(roomId));
  _mem.rooms.delete(roomId);
}

async function roomExists(roomId) {
  return (await roomGet(roomId)) != null;
}

async function roomWithLock(roomId, fn) {
  return withLock(roomId, async () => {
    const room = await roomGet(roomId);
    if (!room) return fn(null);
    const result = await fn(room);
    await roomSet(roomId, room);
    return result;
  });
}

// --- Socket / player binding ---------------------------------------------
async function socketBind(socketId, ref) {
  const r = client();
  if (r) return r.set(SOCKET_KEY(socketId), JSON.stringify(ref), "EX", SOCKET_TTL_SEC);
  _mem.sockets.set(socketId, ref);
}

async function socketRoom(socketId) {
  const r = client();
  if (r) {
    const v = await r.get(SOCKET_KEY(socketId));
    return v ? JSON.parse(v) : null;
  }
  return _mem.sockets.get(socketId) || null;
}

async function socketUnbind(socketId) {
  const r = client();
  if (r) return r.del(SOCKET_KEY(socketId));
  _mem.sockets.delete(socketId);
}

async function playerBind(playerId, roomId) {
  const r = client();
  if (r) return r.set(PLAYER_KEY(playerId), roomId, "EX", PLAYER_TTL_SEC);
  _mem.players.set(playerId, roomId);
}

async function playerLastRoom(playerId) {
  const r = client();
  if (r) return r.get(PLAYER_KEY(playerId));
  return _mem.players.get(playerId) || null;
}

async function playerUnbind(playerId) {
  const r = client();
  if (r) return r.del(PLAYER_KEY(playerId));
  _mem.players.delete(playerId);
}

// --- Private rooms -------------------------------------------------------
async function privateRoomSet(code, seat) {
  const r = client();
  if (r) return r.set(PRIVATE_KEY(code), JSON.stringify(seat), "EX", PRIVATE_TTL_SEC);
  _mem.privateRooms.set(code, seat);
}

async function privateRoomTake(code) {
  const r = client();
  if (r) {
    const v = await r.get(PRIVATE_KEY(code));
    if (!v) return null;
    await r.del(PRIVATE_KEY(code));
    return JSON.parse(v);
  }
  const seat = _mem.privateRooms.get(code);
  if (!seat) return null;
  _mem.privateRooms.delete(code);
  return seat;
}

async function privateRoomRemoveBySocket(socketId) {
  const r = client();
  if (r) {
    // SCAN keys is fine for low cardinality
    let cursor = "0";
    do {
      const [next, keys] = await r.scan(cursor, "MATCH", "ptcg:priv:*", "COUNT", 100);
      cursor = next;
      for (const k of keys) {
        const v = await r.get(k);
        if (!v) continue;
        try {
          if (JSON.parse(v).socketId === socketId) await r.del(k);
        } catch {}
      }
    } while (cursor !== "0");
    return;
  }
  for (const [code, host] of _mem.privateRooms) {
    if (host.socketId === socketId) _mem.privateRooms.delete(code);
  }
}

function isRedis() {
  return !!REDIS_URL;
}

// Build pub/sub clients for the Socket.IO adapter.
function makeSocketIoAdapter(io) {
  if (!REDIS_URL) return null;
  const Redis = require("ioredis");
  const opts = { tls: REDIS_URL.startsWith("rediss://") ? {} : undefined };
  const pub = new Redis(REDIS_URL, opts);
  const sub = new Redis(REDIS_URL, opts);
  pub.on("error", (e) => console.warn("[redis pub]", e.message));
  sub.on("error", (e) => console.warn("[redis sub]", e.message));
  const { createAdapter } = require("@socket.io/redis-adapter");
  io.adapter(createAdapter(pub, sub));
  return { pub, sub };
}

module.exports = {
  isRedis,
  queuePush, queuePopFifo, queueRemove, queueLength,
  roomSet, roomGet, roomDelete, roomExists, roomWithLock,
  socketBind, socketRoom, socketUnbind,
  playerBind, playerLastRoom, playerUnbind,
  privateRoomSet, privateRoomTake, privateRoomRemoveBySocket,
  makeSocketIoAdapter,
  kvSet, kvGet, kvTake,
};
