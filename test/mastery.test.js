// Tests for Card Mastery level curve.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { levelFor, LEVELS } = require("../server-modules/mastery");

test("zero KOs → level 0", () => {
  assert.equal(levelFor(0), 0);
});

test("1-4 KOs → level 1", () => {
  for (let n = 1; n <= 4; n++) assert.equal(levelFor(n), 1, `KO ${n} → L1`);
});

test("5-14 KOs → level 2", () => {
  for (const n of [5, 7, 10, 14]) assert.equal(levelFor(n), 2, `KO ${n} → L2`);
});

test("15+ KOs → level 3 (cap)", () => {
  for (const n of [15, 30, 200, 9999]) assert.equal(levelFor(n), 3, `KO ${n} → L3`);
});

test("LEVELS table is monotonic increasing on threshold", () => {
  for (let i = 1; i < LEVELS.length; i++) {
    assert.ok(LEVELS[i].threshold > LEVELS[i - 1].threshold, `thresholds must increase`);
  }
});

test("LEVELS table caps at level 3", () => {
  const maxLvl = LEVELS.reduce((m, x) => Math.max(m, x.level), 0);
  assert.equal(maxLvl, 3);
});
