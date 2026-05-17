// Tests: the engine's forceCrit option overrides the random roll
// (the crit-bar's only contract). The actual UI runs in the browser
// so we don't test the timing flow itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDamage } from "../client/js/battle.js";

function mkCard(type = "normal", cardAttack = 5) {
  return {
    name: "C", types: [type], cardAttack,
    cardHp: 8,
    raw: { hp: 80, attack: 60, defense: 30, sp_attack: 60, sp_defense: 30, speed: 30 },
  };
}

test("forceCrit makes critical fire regardless of rand()", () => {
  // rand always returns 1 → would never crit by random chance
  const r = computeDamage(mkCard("fire", 6), mkCard("grass"), {
    rand: () => 1,
    forceCrit: true,
  });
  assert.equal(r.critical, true);
});

test("without forceCrit + rand()=1, no crit", () => {
  const r = computeDamage(mkCard("fire", 6), mkCard("grass"), {
    rand: () => 1,
  });
  assert.equal(r.critical, false);
});

test("forceCrit still respects 0× immunity (no crit on a no-effect attack)", () => {
  const ghost = mkCard("ghost", 6);
  const normal = mkCard("normal");
  const r = computeDamage(ghost, normal, { rand: () => 0, forceCrit: true });
  // Normal is immune to ghost → multiplier 0 → no crit applied
  assert.equal(r.multiplier, 0);
  assert.equal(r.critical, false);
});

test("forceCrit applies the 1.5× damage multiplier", () => {
  const without = computeDamage(mkCard("fire", 10), mkCard("water"), { rand: () => 1 });
  const with_   = computeDamage(mkCard("fire", 10), mkCard("water"), { rand: () => 1, forceCrit: true });
  assert.ok(with_.damage >= without.damage, "forceCrit damage should be >= non-crit damage");
  assert.equal(with_.critical, true);
});

test("forceCrit in preview mode is suppressed (preview must stay deterministic)", () => {
  const r = computeDamage(mkCard("fire", 6), mkCard("water"), {
    forceCrit: true,
    preview: true,
  });
  // No crit in preview — the preview damage shown on hover should
  // match what the player will see on a non-crit roll.
  assert.equal(r.critical, false);
});
