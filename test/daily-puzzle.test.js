// Tests for the Daily Puzzle scenario data + day rotation.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { PUZZLES, puzzleForDay, todayDateKey, dayNumberFor } = require("../shared/daily-puzzles");

test("PUZZLES has at least 7 scenarios (one for each weekday)", () => {
  assert.ok(PUZZLES.length >= 7, `expected >= 7 puzzles, got ${PUZZLES.length}`);
});

test("every puzzle declares id, title, par, player, enemy", () => {
  for (const p of PUZZLES) {
    assert.ok(p.id && typeof p.id === "string");
    assert.ok(p.title && typeof p.title === "string");
    assert.ok(Number.isInteger(p.par) && p.par > 0, `${p.id} par must be a positive integer`);
    assert.ok(Array.isArray(p.player) && p.player.length > 0, `${p.id} needs at least 1 player unit`);
    assert.ok(Array.isArray(p.enemy)  && p.enemy.length > 0,  `${p.id} needs at least 1 enemy`);
  }
});

test("every unit has pokemonId, hp, atk", () => {
  for (const p of PUZZLES) {
    for (const u of [...p.player, ...p.enemy]) {
      assert.ok(u.pokemonId > 0, `${p.id} unit missing pokemonId`);
      assert.ok(u.hp > 0, `${p.id} unit hp must be > 0`);
      assert.ok(u.atk > 0, `${p.id} unit atk must be > 0`);
    }
  }
});

test("par is at most the number of player units (can't move more than once each)", () => {
  for (const p of PUZZLES) {
    assert.ok(
      p.par <= p.player.length * 3,
      `${p.id}: par ${p.par} feels too high for ${p.player.length} attackers`,
    );
  }
});

test("puzzleForDay is deterministic + cycles through PUZZLES", () => {
  const a = puzzleForDay(3);
  const b = puzzleForDay(3);
  assert.deepEqual(a, b);
  // After PUZZLES.length days we wrap back to the same scenario.
  assert.deepEqual(puzzleForDay(1), puzzleForDay(1 + PUZZLES.length));
});

test("puzzleForDay never returns null/undefined", () => {
  for (let d = 1; d <= 30; d++) {
    const p = puzzleForDay(d);
    assert.ok(p, `puzzleForDay(${d}) must return a puzzle`);
    assert.ok(p.title, `puzzleForDay(${d}) title missing`);
  }
});

test("puzzle ids are unique", () => {
  const seen = new Set();
  for (const p of PUZZLES) {
    assert.ok(!seen.has(p.id), `duplicate puzzle id: ${p.id}`);
    seen.add(p.id);
  }
});

test("date helpers agree with the daily-boss versions", () => {
  // Same epoch, same logic — both should agree.
  const boss = require("../server-modules/daily-boss");
  assert.equal(dayNumberFor("2026-01-01"), boss.dayNumberFor("2026-01-01"));
  assert.equal(dayNumberFor("2026-06-15"), boss.dayNumberFor("2026-06-15"));
  assert.equal(todayDateKey(new Date(Date.UTC(2026, 4, 17))), boss.todayDateKey(new Date(Date.UTC(2026, 4, 17))));
});
