// Tests for daily-streak pure helpers: day math + tier curve.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { daysBetween, tierBoostForStreak } = require("../server-modules/daily-streak");

const DAY = 24 * 60 * 60 * 1000;

// --- daysBetween -----------------------------------------------------

test("daysBetween same timestamp → 0", () => {
  const t = Date.UTC(2026, 4, 17);
  assert.equal(daysBetween(t, t), 0);
});

test("daysBetween 1 calendar day → 1", () => {
  const t = Date.UTC(2026, 4, 17);
  assert.equal(daysBetween(t, t + DAY), 1);
});

test("daysBetween 24h-1ms → 0 (floors)", () => {
  const t = Date.UTC(2026, 4, 17);
  assert.equal(daysBetween(t, t + DAY - 1), 0);
});

test("daysBetween multi-day jump", () => {
  const t = Date.UTC(2026, 4, 17);
  assert.equal(daysBetween(t, t + 7 * DAY), 7);
});

// --- tierBoostForStreak ----------------------------------------------

test("tierBoostForStreak: streak 0 → 1 pick, tier 1+", () => {
  assert.deepEqual(tierBoostForStreak(0), { count: 1, minTier: 1 });
});

test("tierBoostForStreak: streak 1, 2 → still baseline", () => {
  assert.deepEqual(tierBoostForStreak(1), { count: 1, minTier: 1 });
  assert.deepEqual(tierBoostForStreak(2), { count: 1, minTier: 1 });
});

test("tierBoostForStreak: streak 3 → tier 2+ bump", () => {
  assert.deepEqual(tierBoostForStreak(3), { count: 1, minTier: 2 });
});

test("tierBoostForStreak: streak 7 → 2 picks, tier 2+", () => {
  assert.deepEqual(tierBoostForStreak(7), { count: 2, minTier: 2 });
});

test("tierBoostForStreak: streak 14 → top tier", () => {
  assert.deepEqual(tierBoostForStreak(14), { count: 2, minTier: 3 });
});

test("tierBoostForStreak: streak >=14 stays at top tier", () => {
  assert.deepEqual(tierBoostForStreak(30), { count: 2, minTier: 3 });
  assert.deepEqual(tierBoostForStreak(365), { count: 2, minTier: 3 });
});

test("tierBoostForStreak: thresholds are monotonic", () => {
  // count never goes down, minTier never goes down as streak grows.
  let prevCount = 1, prevTier = 1;
  for (let s = 0; s <= 30; s++) {
    const r = tierBoostForStreak(s);
    assert.ok(r.count    >= prevCount, `count regressed at streak ${s}`);
    assert.ok(r.minTier  >= prevTier,  `minTier regressed at streak ${s}`);
    prevCount = r.count;
    prevTier = r.minTier;
  }
});
