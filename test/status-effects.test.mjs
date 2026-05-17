// Tests for status-effect mechanics — burn, paralyze, sleep.
// These are central to gameplay (rollStatus, tickStatus, isLockedOut)
// but had zero direct tests until now.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rollStatus, tickStatus, isLockedOut } from "../client/js/battle.js";

function mkCard(types = ["normal"]) {
  return {
    name: "C", types,
    cardAttack: 5, cardHp: 10,
    raw: { hp: 100, attack: 60, defense: 30, sp_attack: 60, sp_defense: 30 },
  };
}

function mkInst(card, opts = {}) {
  return {
    card,
    currentHp: opts.currentHp ?? card.cardHp,
    maxHp: opts.maxHp ?? card.cardHp,
    status: opts.status ?? null,
  };
}

// --- rollStatus -------------------------------------------------------

test("rollStatus: fire attacker has ~25% burn chance on contact", () => {
  // Deterministic rand always-below-threshold → always burns.
  const attacker = mkCard(["fire"]);
  const defender = mkCard(["normal"]);
  const status = rollStatus(attacker, defender, () => 0.1);
  assert.equal(status?.kind, "burn");
  assert.equal(status.turnsLeft, 2);
});

test("rollStatus: fire above threshold → no status", () => {
  const attacker = mkCard(["fire"]);
  const defender = mkCard(["normal"]);
  const status = rollStatus(attacker, defender, () => 0.9);
  assert.equal(status, null);
});

test("rollStatus: electric attacker has paralyze chance", () => {
  const attacker = mkCard(["electric"]);
  const defender = mkCard(["normal"]);
  const status = rollStatus(attacker, defender, () => 0.1);
  assert.equal(status?.kind, "paralyze");
});

test("rollStatus: psychic attacker has sleep chance", () => {
  const attacker = mkCard(["psychic"]);
  const defender = mkCard(["normal"]);
  const status = rollStatus(attacker, defender, () => 0.05);
  assert.equal(status?.kind, "sleep");
});

test("rollStatus: non-status types return null", () => {
  for (const type of ["normal", "rock", "grass", "fighting"]) {
    const attacker = mkCard([type]);
    const defender = mkCard(["normal"]);
    const status = rollStatus(attacker, defender, () => 0);
    assert.equal(status, null, `${type} should not apply status`);
  }
});

test("rollStatus: missing attacker/defender returns null safely", () => {
  assert.equal(rollStatus(null, mkCard(), () => 0), null);
  assert.equal(rollStatus(mkCard(["fire"]), null, () => 0), null);
});

// --- tickStatus -------------------------------------------------------

test("tickStatus: burn deals 2 damage, decrements turnsLeft", () => {
  const card = mkInst(mkCard(), { status: { kind: "burn", turnsLeft: 2 } });
  const r = tickStatus(card);
  assert.equal(r.damage, 2);
  assert.equal(r.expired, false);
  assert.equal(card.status?.turnsLeft, 1);
});

test("tickStatus: burn expires after its last tick", () => {
  const card = mkInst(mkCard(), { status: { kind: "burn", turnsLeft: 1 } });
  const r = tickStatus(card);
  assert.equal(r.damage, 2);
  assert.equal(r.expired, true);
  assert.equal(card.status, undefined);  // deleted from instance
});

test("tickStatus: paralyze decrements without dealing damage", () => {
  const card = mkInst(mkCard(), { status: { kind: "paralyze", turnsLeft: 2 } });
  const r = tickStatus(card);
  assert.equal(r.damage, 0);
  assert.equal(card.status?.turnsLeft, 1);
});

test("tickStatus: paralyze expires", () => {
  const card = mkInst(mkCard(), { status: { kind: "paralyze", turnsLeft: 1 } });
  const r = tickStatus(card);
  assert.equal(r.expired, true);
  assert.equal(card.status, undefined);
});

test("tickStatus: sleep decrements without damage", () => {
  const card = mkInst(mkCard(), { status: { kind: "sleep", turnsLeft: 1 } });
  const r = tickStatus(card);
  assert.equal(r.damage, 0);
  assert.equal(r.expired, true);
});

test("tickStatus: card with no status is a no-op", () => {
  const card = mkInst(mkCard());
  const r = tickStatus(card);
  assert.equal(r.damage, 0);
  assert.equal(r.expired, false);
});

// --- isLockedOut ------------------------------------------------------

test("isLockedOut: paralyze locks the card", () => {
  const card = mkInst(mkCard(), { status: { kind: "paralyze", turnsLeft: 1 } });
  assert.equal(isLockedOut(card), true);
});

test("isLockedOut: sleep locks the card", () => {
  const card = mkInst(mkCard(), { status: { kind: "sleep", turnsLeft: 1 } });
  assert.equal(isLockedOut(card), true);
});

test("isLockedOut: burn does NOT lock (you can still attack while burning)", () => {
  const card = mkInst(mkCard(), { status: { kind: "burn", turnsLeft: 2 } });
  assert.equal(isLockedOut(card), false);
});

test("isLockedOut: no status returns false", () => {
  const card = mkInst(mkCard());
  assert.equal(isLockedOut(card), false);
});
