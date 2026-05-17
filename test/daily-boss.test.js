// Tests for the Daily Boss + Daily Puzzle deterministic helpers.
// These don't hit Supabase — they exercise the pure date-keyed
// rotation + share-string formatting that the routes depend on.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  todayDateKey, dayNumberFor, bossForDay, starsForResult, POOL,
} = require("../server-modules/daily-boss");

// --- date / day-number helpers ------------------------------------------

test("todayDateKey returns YYYY-MM-DD in UTC", () => {
  const key = todayDateKey(new Date(Date.UTC(2026, 5, 17, 23, 59, 0)));
  assert.equal(key, "2026-06-17");
});

test("todayDateKey pads month and day", () => {
  assert.equal(todayDateKey(new Date(Date.UTC(2026, 0, 5))), "2026-01-05");
});

test("dayNumberFor(epoch) is 1", () => {
  // Epoch is 2026-01-01 UTC.
  assert.equal(dayNumberFor("2026-01-01"), 1);
});

test("dayNumberFor advances by one per UTC day", () => {
  assert.equal(dayNumberFor("2026-01-02"), 2);
  assert.equal(dayNumberFor("2026-01-15"), 15);
});

test("dayNumberFor floors negative pre-epoch dates to 1", () => {
  assert.equal(dayNumberFor("2025-12-31"), 1);
});

// --- boss rotation ------------------------------------------------------

test("bossForDay is deterministic per day", () => {
  const a = bossForDay(5);
  const b = bossForDay(5);
  assert.deepEqual(a, b);
});

test("bossForDay cycles through the POOL by day modulo pool size", () => {
  const first = bossForDay(1);
  const wrap = bossForDay(1 + POOL.length);
  assert.deepEqual(first, wrap);
});

test("every POOL entry has a valid shape", () => {
  for (const b of POOL) {
    assert.ok(b.id > 0, `${b.name} should have positive id`);
    assert.ok(b.name && typeof b.name === "string");
    assert.ok(Array.isArray(b.types) && b.types.length > 0);
    assert.ok(b.hp > 0, `${b.name} hp must be > 0`);
    assert.ok(b.atk > 0, `${b.name} atk must be > 0`);
    assert.ok(Array.isArray(b.rules), `${b.name} should have a rules array`);
  }
});

test("POOL is at least 14 entries so bosses don't repeat within a fortnight", () => {
  assert.ok(POOL.length >= 14, `POOL has ${POOL.length} entries`);
});

// --- star rating --------------------------------------------------------

test("starsForResult: loss → 💀", () => {
  assert.equal(starsForResult({ won: false, turns: 20, hpLeft: 0, hpMax: 30 }), "💀");
});

test("starsForResult: full HP fast win → 5 stars", () => {
  assert.equal(starsForResult({ won: true, turns: 5, hpLeft: 30, hpMax: 30 }), "★★★★★");
});

test("starsForResult: slow win loses stars", () => {
  // turns 13+ drops 1, 19+ drops another, low HP drops another, very low drops another
  const slow = starsForResult({ won: true, turns: 15, hpLeft: 30, hpMax: 30 });
  assert.equal(slow.match(/★/g).length, 4);
});

test("starsForResult: low HP drops stars", () => {
  // 5/30 = 16% HP, well below the 25% threshold, so −2 stars
  const r = starsForResult({ won: true, turns: 8, hpLeft: 5, hpMax: 30 });
  assert.ok(r.includes("★"), "should still have at least one star on a win");
  assert.ok(r.match(/★/g).length <= 3, `low HP should drop to ≤ 3 stars, got ${r}`);
});

test("starsForResult: never less than 1 star on a win", () => {
  const r = starsForResult({ won: true, turns: 99, hpLeft: 0, hpMax: 30 });
  assert.ok(r.match(/★/g).length >= 1, `should clamp to 1 star, got ${r}`);
});
