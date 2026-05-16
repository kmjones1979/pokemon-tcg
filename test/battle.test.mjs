import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDamage, rollStatus, tickStatus, isLockedOut, effectiveDefense } from "../client/js/battle.js";

function mkCard({ name = "x", types = ["normal"], cardAttack = 4, hp = 100, defense = 60, sp_defense = 60, sp_attack = 60 } = {}) {
  return {
    name,
    types,
    cardAttack,
    cardHp: Math.round(hp / 10),
    raw: { hp, attack: cardAttack * 30, defense, sp_defense, sp_attack },
  };
}

test("damage = max(1, atk*mult - def/2) [normal vs normal]", () => {
  const a = mkCard({ types: ["normal"], cardAttack: 6, defense: 30, sp_defense: 30 });
  const d = mkCard({ types: ["normal"], defense: 60, sp_defense: 60 });
  const { damage, multiplier } = computeDamage(a, d);
  assert.equal(multiplier, 1);
  // d effective def = round((60+60)/30) = 4; raw = 6*1 - 4/2 = 4
  assert.equal(damage, 4);
});

test("super effective doubles damage before defense subtraction", () => {
  const fire = mkCard({ types: ["fire"], cardAttack: 5, defense: 60, sp_defense: 60 });
  const grass = mkCard({ types: ["grass"], defense: 60, sp_defense: 60 });
  const { damage, multiplier } = computeDamage(fire, grass);
  assert.equal(multiplier, 2);
  // 5*2 - 4/2 = 8
  assert.equal(damage, 8);
});

test("immune defender = 0 damage", () => {
  const ghost = mkCard({ types: ["ghost"], cardAttack: 6 });
  const normal = mkCard({ types: ["normal"] });
  const { damage, multiplier } = computeDamage(normal, ghost);
  assert.equal(multiplier, 0);
  assert.equal(damage, 0);
});

test("minimum damage is 1 against non-immune defenders", () => {
  const weak = mkCard({ types: ["bug"], cardAttack: 1, defense: 0, sp_defense: 0 });
  const steel = mkCard({ types: ["steel"], defense: 200, sp_defense: 200 });
  const { damage, multiplier } = computeDamage(weak, steel);
  assert.equal(multiplier, 0.5);
  assert.ok(damage >= 1, "damage floor of 1 against non-immune");
});

test("ability bonus adds before multiplier", () => {
  const a = mkCard({ types: ["electric"], cardAttack: 3, defense: 0, sp_defense: 0 });
  const d = mkCard({ types: ["water"], defense: 0, sp_defense: 0 });
  const { damage } = computeDamage(a, d, { abilityBonus: 1 });
  // (3+1) * 2 - 0 = 8
  assert.equal(damage, 8);
});

test("rollStatus(fire) applies burn ~25% of the time", () => {
  const fire = mkCard({ types: ["fire"] });
  const target = mkCard();
  // Force the RNG to always roll < 0.25
  const status = rollStatus(fire, target, () => 0.1);
  assert.equal(status.kind, "burn");
  assert.equal(status.turnsLeft, 2);
});

test("rollStatus(fire) returns null when roll exceeds threshold", () => {
  const fire = mkCard({ types: ["fire"] });
  const target = mkCard();
  assert.equal(rollStatus(fire, target, () => 0.99), null);
});

test("rollStatus(electric) applies paralyze", () => {
  const elec = mkCard({ types: ["electric"] });
  const status = rollStatus(elec, mkCard(), () => 0.01);
  assert.equal(status.kind, "paralyze");
});

test("rollStatus(psychic) applies sleep", () => {
  const psy = mkCard({ types: ["psychic"] });
  const status = rollStatus(psy, mkCard(), () => 0.01);
  assert.equal(status.kind, "sleep");
});

test("rollStatus(grass) yields nothing", () => {
  assert.equal(rollStatus(mkCard({ types: ["grass"] }), mkCard(), () => 0.01), null);
});

test("burn ticks 2 damage per turn and expires after 2", () => {
  const c = mkCard();
  c.status = { kind: "burn", turnsLeft: 2 };
  let r = tickStatus(c);
  assert.equal(r.damage, 2);
  assert.equal(r.expired, false);
  assert.ok(c.status, "still burning after one tick");
  r = tickStatus(c);
  assert.equal(r.damage, 2);
  assert.equal(r.expired, true);
  assert.equal(c.status, undefined);
});

test("paralyze locks out attacks, then expires", () => {
  const c = mkCard();
  c.status = { kind: "paralyze", turnsLeft: 1 };
  assert.equal(isLockedOut(c), true);
  const r = tickStatus(c);
  assert.equal(r.expired, true);
  assert.equal(c.status, undefined);
  assert.equal(isLockedOut(c), false);
});

test("effectiveDefense", () => {
  const c = mkCard({ defense: 90, sp_defense: 60 });
  assert.equal(effectiveDefense(c), 5); // round(150/30)
});
