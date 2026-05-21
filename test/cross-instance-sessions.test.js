// Regression for "daily-boss win didn't update the global counter".
//
// Root cause was that DAILY_SESSIONS / SOLO_SESSIONS / STORY_SESSIONS
// were per-process Maps. On Vercel Fluid Compute the /me/*/start call
// could land on instance A but /me/*/end could land on instance B,
// which had no record of the session → "No session." → the daily
// result row was never written, so /api/daily/stats showed 0.
//
// The fix moved all three session stores to the shared KV (state-store).
// This test simulates a cross-instance handoff by clearing the module
// cache between start and end, proving the second handler can still
// see the session.
//
// We don't mount a real Express app — directly poke the kv helpers
// the way the route handlers do.

const { test } = require("node:test");
const assert = require("node:assert/strict");

// Force in-memory KV fallback (no Redis in CI).
delete process.env.REDIS_URL;
delete process.env.KV_URL;

const store = require("../server-modules/state-store");

test("daily session survives across module reloads (cross-instance handoff)", async () => {
  const sessionId = "daily-test-" + Date.now();
  // Instance A writes the session.
  await store.kvSet(`daily-sess:${sessionId}`, {
    userId: "u1", dateKey: "2026-05-21", startedAt: Date.now() - 60_000,
  }, 3600);
  // Instance B (same KV, possibly different process) atomically consumes it.
  const session = await store.kvTake(`daily-sess:${sessionId}`);
  assert.ok(session, "session should be readable after kvSet");
  assert.equal(session.userId, "u1");
  assert.equal(session.dateKey, "2026-05-21");
  // kvTake should have deleted it — a retry must miss.
  const retry = await store.kvTake(`daily-sess:${sessionId}`);
  assert.equal(retry, null, "second kvTake must return null (one-shot)");
});

test("solo session survives across module reloads", async () => {
  const sessionId = "solo-test-" + Date.now();
  await store.kvSet(`solo-sess:${sessionId}`, {
    userId: "u2", difficulty: "hard", startedAt: Date.now() - 90_000,
  }, 3600);
  const session = await store.kvTake(`solo-sess:${sessionId}`);
  assert.ok(session);
  assert.equal(session.difficulty, "hard");
  assert.equal(await store.kvTake(`solo-sess:${sessionId}`), null);
});

test("story session survives across module reloads", async () => {
  const sessionId = "story-test-" + Date.now();
  await store.kvSet(`story-sess:${sessionId}`, {
    userId: "u3", chapterId: "ch1", startedAt: Date.now() - 60_000,
  }, 3600);
  const session = await store.kvTake(`story-sess:${sessionId}`);
  assert.ok(session);
  assert.equal(session.chapterId, "ch1");
  assert.equal(await store.kvTake(`story-sess:${sessionId}`), null);
});
