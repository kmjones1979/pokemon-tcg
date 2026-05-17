// Tests for the in-memory fallback path of state-store.js.
// Redis is hit when REDIS_URL is set; without it we use a Map. These
// tests exercise the Map path to cover the offer / queue / room
// pipelines used by the reward, multiplayer, and trade endpoints.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// Force the in-memory branch by clearing REDIS_URL before require.
delete process.env.REDIS_URL;
delete process.env.KV_URL;
const store = require("../server-modules/state-store");

// --- KV (generic value + TTL — used by reward offers) -----------------

test("kvSet → kvGet round-trips a JSON-serialisable value", async () => {
  const value = { userId: "u1", picks: [{ id: 6, name: "Charizard" }] };
  await store.kvSet("test-offer-1", value, 60);
  const got = await store.kvGet("test-offer-1");
  assert.deepEqual(got, value);
});

test("kvTake returns the value AND removes it (one-shot redemption)", async () => {
  await store.kvSet("test-once", { foo: "bar" }, 60);
  const first = await store.kvTake("test-once");
  assert.deepEqual(first, { foo: "bar" });
  const second = await store.kvTake("test-once");
  assert.equal(second, null, "second take should be null");
});

test("kvGet returns null for missing keys", async () => {
  const got = await store.kvGet("never-set");
  assert.equal(got, null);
});

test("kvGet honors TTL — expired values are not returned", async () => {
  await store.kvSet("ttl-test", { x: 1 }, 0); // 0s TTL → already expired
  // Allow the millisecond to roll over so the Date.now check fires.
  await new Promise((r) => setTimeout(r, 5));
  const got = await store.kvGet("ttl-test");
  assert.equal(got, null);
});

// --- Queue (FIFO matchmaking) -----------------------------------------

test("queuePush + queuePopFifo are first-in-first-out", async () => {
  // The queue is process-global so clear it first.
  while (await store.queuePopFifo()) {}
  await store.queuePush({ playerId: "p1", displayName: "A" });
  await store.queuePush({ playerId: "p2", displayName: "B" });
  await store.queuePush({ playerId: "p3", displayName: "C" });
  const first = await store.queuePopFifo();
  const second = await store.queuePopFifo();
  const third  = await store.queuePopFifo();
  const fourth = await store.queuePopFifo();
  assert.equal(first?.playerId,  "p1");
  assert.equal(second?.playerId, "p2");
  assert.equal(third?.playerId,  "p3");
  assert.equal(fourth, null, "empty queue returns null");
});

test("queueLength reflects current size", async () => {
  while (await store.queuePopFifo()) {}
  assert.equal(await store.queueLength(), 0);
  await store.queuePush({ playerId: "p1" });
  await store.queuePush({ playerId: "p2" });
  assert.equal(await store.queueLength(), 2);
  await store.queuePopFifo();
  assert.equal(await store.queueLength(), 1);
});

test("queueRemove targets a specific player id", async () => {
  while (await store.queuePopFifo()) {}
  await store.queuePush({ playerId: "alpha" });
  await store.queuePush({ playerId: "beta" });
  await store.queuePush({ playerId: "gamma" });
  await store.queueRemove("beta");
  const a = await store.queuePopFifo();
  const c = await store.queuePopFifo();
  assert.equal(a?.playerId, "alpha");
  assert.equal(c?.playerId, "gamma");
});

// --- Rooms (match state across instances) -----------------------------

test("roomSet + roomGet round-trips a match snapshot", async () => {
  const match = {
    id: "m1",
    v: 0,
    state: { turn: 1, activePlayer: "player" },
    players: { player: { displayName: "P1" }, ai: { displayName: "P2" } },
  };
  await store.roomSet("m1", match);
  const got = await store.roomGet("m1");
  assert.equal(got?.id, "m1");
  assert.equal(got?.state?.turn, 1);
});

test("roomDelete removes a room (subsequent get returns null)", async () => {
  await store.roomSet("m-del", { id: "m-del" });
  await store.roomDelete("m-del");
  const got = await store.roomGet("m-del");
  assert.equal(got, null);
});

test("roomExists returns true for set rooms, false otherwise", async () => {
  await store.roomSet("m-exists", { id: "m-exists" });
  assert.equal(await store.roomExists("m-exists"), true);
  assert.equal(await store.roomExists("m-nope"), false);
});

// --- Player binding (which match is this player in) -------------------

test("playerBind + playerLastRoom round-trip", async () => {
  await store.playerBind("player-x", "match-x");
  const got = await store.playerLastRoom("player-x");
  assert.equal(got, "match-x");
});

test("playerLastRoom returns null for unknown players", async () => {
  const got = await store.playerLastRoom("ghost");
  assert.equal(got, null);
});

// --- Private rooms (6-char invite codes) ------------------------------

test("privateRoomSet + privateRoomTake (one-shot)", async () => {
  const seat = { playerId: "host-1", displayName: "Host" };
  await store.privateRoomSet("ABC123", seat);
  const first = await store.privateRoomTake("ABC123");
  assert.equal(first?.playerId, "host-1");
  const second = await store.privateRoomTake("ABC123");
  assert.equal(second, null, "code is consumed after take");
});
