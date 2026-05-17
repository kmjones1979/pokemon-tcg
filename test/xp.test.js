// Tests for trainer XP curve.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { levelFromXp, nextLevelAt } = require("../server-modules/xp");

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

test("level caps at 10 even at very high XP", () => {
  assert.equal(levelFromXp(50_000), 10);
  assert.equal(levelFromXp(Number.MAX_SAFE_INTEGER), 10);
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

test("nextLevelAt at the cap stays at the last threshold", () => {
  // No further levels — nextLevelAt returns the last threshold
  // so client UIs don't break on max-level display.
  assert.equal(nextLevelAt(5200), 5200);
  assert.equal(nextLevelAt(10_000), 5200);
});
