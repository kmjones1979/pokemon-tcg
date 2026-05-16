import { test } from "node:test";
import assert from "node:assert/strict";
import { getMultiplier, describeMultiplier, TYPES, TYPE_COLORS } from "../client/js/type-chart.js";

test("18 types are defined", () => {
  assert.equal(TYPES.length, 18);
  for (const t of TYPES) {
    assert.ok(TYPE_COLORS[t], `${t} has a color`);
  }
});

test("fire 2x vs grass, fire 0.5x vs water", () => {
  assert.equal(getMultiplier("fire", ["grass"]), 2);
  assert.equal(getMultiplier("fire", ["water"]), 0.5);
});

test("ghost 0x vs normal, normal 0x vs ghost", () => {
  assert.equal(getMultiplier("ghost", ["normal"]), 0);
  assert.equal(getMultiplier("normal", ["ghost"]), 0);
});

test("ground capped at 2x vs fire/rock (we cap stacked super-effective)", () => {
  // ground is 2x vs fire AND 2x vs rock — raw 4x. We cap at 2x for fairness.
  assert.equal(getMultiplier("ground", ["fire", "rock"]), 2);
});

test("damage cap floor: stacked not-very-effective doesn't drop below 0.5x", () => {
  // fire is 0.5x vs water AND 0.5x vs rock — raw 0.25x. We floor at 0.5x.
  assert.equal(getMultiplier("fire", ["water", "rock"]), 0.5);
});

test("0x immunity still wins over the cap", () => {
  // electric is 0x vs ground, doesn't matter what the other type is.
  assert.equal(getMultiplier("electric", ["ground", "fire"]), 0);
});

test("electric 0x vs ground (immune)", () => {
  assert.equal(getMultiplier("electric", ["ground"]), 0);
});

test("dragon 0x vs fairy (Gen 6+)", () => {
  assert.equal(getMultiplier("dragon", ["fairy"]), 0);
});

test("fairy 2x vs dragon and dark", () => {
  assert.equal(getMultiplier("fairy", ["dragon"]), 2);
  assert.equal(getMultiplier("fairy", ["dark"]), 2);
});

test("unknown attacker / defender defaults to 1", () => {
  assert.equal(getMultiplier("nonsense", ["fire"]), 1);
  assert.equal(getMultiplier("fire", []), 1);
});

test("describeMultiplier verdicts", () => {
  assert.equal(describeMultiplier(0).tone, "miss");
  assert.equal(describeMultiplier(2).tone, "super");
  assert.equal(describeMultiplier(4).tone, "super");
  assert.equal(describeMultiplier(0.5).tone, "weak");
  assert.equal(describeMultiplier(1).tone, "normal");
});
