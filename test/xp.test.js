// Tests for trainer XP curve.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { levelFromXp, nextLevelAt, MAX_LEVEL, XP_THRESHOLDS } = require("../server-modules/xp");

// --- levelFromXp -----------------------------------------------------

test("0 XP → level 1", () => {
  assert.equal(levelFromXp(0), 1);
});

test("just-below-100 XP → level 1", () => {
  assert.equal(levelFromXp(99), 1);
});

test("100 XP → level 2 (boundary)", () => {
  assert.equal(levelFromXp(100), 2);
});

test("XP at each documented threshold → corresponding level", () => {
  const thresholds = [
    [0, 1],
    [100, 2],
    [300, 3],
    [600, 4],
    [1000, 5],
    [1500, 6],
    [2200, 7],
    [3000, 8],
    [4000, 9],
    [5200, 10],
  ];
  for (const [xp, expected] of thresholds) {
    assert.equal(levelFromXp(xp), expected, `${xp} → L${expected}`);
  }
});

test("MAX_LEVEL is 99 (regression: was 10)", () => {
  assert.equal(MAX_LEVEL, 99);
});

test("level caps at 99 at very high XP", () => {
  // Past the L99 threshold should report 99, not higher.
  assert.equal(levelFromXp(Number.MAX_SAFE_INTEGER), 99);
});

test("XP curve preserves the original L1-L10 thresholds (backwards compat)", () => {
  // Every account at L1-L10 should still be at the same level on the
  // new curve — we extend the curve, never rewrite its head.
  const head = [0, 100, 300, 600, 1000, 1500, 2200, 3000, 4000, 5200];
  for (let i = 0; i < head.length; i++) {
    assert.equal(XP_THRESHOLDS[i], head[i], `L${i + 1} threshold must stay ${head[i]}`);
  }
});

test("XP curve has 99 entries (one per level)", () => {
  assert.equal(XP_THRESHOLDS.length, MAX_LEVEL);
});

test("XP curve is strictly increasing", () => {
  // No flat or backsliding levels — every climb costs something.
  for (let i = 1; i < XP_THRESHOLDS.length; i++) {
    assert.ok(
      XP_THRESHOLDS[i] > XP_THRESHOLDS[i - 1],
      `L${i + 1} (${XP_THRESHOLDS[i]}) must require more XP than L${i} (${XP_THRESHOLDS[i - 1]})`,
    );
  }
});

test("L99 threshold is a reasonable long-haul target (not trivially reachable)", () => {
  // Sanity: L99 should require well over 100k XP (a couple thousand
  // matches) so reaching the cap feels earned. Cap the upper bound at
  // 5 million to keep climbing eventually possible.
  const l99 = XP_THRESHOLDS[MAX_LEVEL - 1];
  assert.ok(l99 > 100_000, `L99 should require >100k XP; got ${l99}`);
  assert.ok(l99 < 5_000_000, `L99 shouldn't require >5M XP; got ${l99}`);
});

test("L50 is somewhere between L10 and L99 (curve doesn't spike)", () => {
  // Halfway through the levels should be a long way from done — well
  // under 50% of total XP. Confirms the curve scales upward.
  const l10 = XP_THRESHOLDS[9];
  const l50 = XP_THRESHOLDS[49];
  const l99 = XP_THRESHOLDS[MAX_LEVEL - 1];
  assert.ok(l50 > l10 * 5, `L50 should be much higher than L10 * 5`);
  assert.ok(l50 < l99 * 0.5, `L50 shouldn't already be halfway to L99`);
});

test("negative XP → level 1", () => {
  // Engine never grants negative but be defensive
  assert.equal(levelFromXp(-50), 1);
});

// --- nextLevelAt -----------------------------------------------------

test("nextLevelAt at 0 → 100 (the L2 threshold)", () => {
  assert.equal(nextLevelAt(0), 100);
});

test("nextLevelAt mid-tier returns the next threshold", () => {
  assert.equal(nextLevelAt(150), 300);  // L2 player → L3 at 300
  assert.equal(nextLevelAt(800), 1000); // L4 → L5 at 1000
  assert.equal(nextLevelAt(3500), 4000); // L8 → L9 at 4000
});

test("nextLevelAt past L10 returns the next threshold (not capped at 5200)", () => {
  // After extending to L99, a player at L10+ should see the next
  // level threshold, not the old L10 cap.
  const l11 = XP_THRESHOLDS[10];
  const l12 = XP_THRESHOLDS[11];
  assert.equal(nextLevelAt(5200), l11);
  assert.equal(nextLevelAt(l11), l12);
});

test("nextLevelAt at the L99 cap stays at the last threshold", () => {
  // At/past L99 there's no higher level — return the L99 threshold
  // so client progress bars don't break on max-level display.
  const l99 = XP_THRESHOLDS[MAX_LEVEL - 1];
  assert.equal(nextLevelAt(l99), l99);
  assert.equal(nextLevelAt(l99 * 10), l99);
});
