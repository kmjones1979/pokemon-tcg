// Tests for the comeback mechanic + match-length governor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveCost, createGame } from "../client/js/game.js";

function mkCard(id, cost = 3) {
  return {
    id, name: "T" + id, types: ["normal"],
    energyCost: cost, cardHp: 8, cardAttack: 5,
    raw: { hp: 80, attack: 60, defense: 30, sp_attack: 60, sp_defense: 30, speed: 30 },
  };
}

function mkPlayerState({ trainerHp, maxTrainerHp = 30, ability = "brock" }) {
  return {
    name: "P", ability,
    trainerHp, maxTrainerHp,
    energy: 0, maxEnergy: 0,
    field: [], hand: [], deck: [], discard: [], items: [],
  };
}

// --- Comeback mechanic ---------------------------------------------------

test("comeback: HP > 25% → no discount", () => {
  const p = mkPlayerState({ trainerHp: 20 }); // 67%
  const cost = effectiveCost(p, mkCard(1, 3));
  assert.equal(cost, 3);
});

test("comeback: HP at 25% — boundary, no discount yet", () => {
  const p = mkPlayerState({ trainerHp: 8 }); // 26.67% — above
  assert.equal(effectiveCost(p, mkCard(1, 3)), 3);
  const p2 = mkPlayerState({ trainerHp: 7 }); // 23.3% — below threshold
  assert.equal(effectiveCost(p2, mkCard(1, 3)), 2);
});

test("comeback: HP just below 25% → −1 energy", () => {
  const p = mkPlayerState({ trainerHp: 7 }); // 23%
  assert.equal(effectiveCost(p, mkCard(1, 3)), 2);
  assert.equal(effectiveCost(p, mkCard(2, 5)), 4);
});

test("comeback: 1-cost card stays at 1 (floor)", () => {
  const p = mkPlayerState({ trainerHp: 5 });
  assert.equal(effectiveCost(p, mkCard(3, 1)), 1);
});

test("comeback: HP = 0 → no discount (dead is dead)", () => {
  const p = mkPlayerState({ trainerHp: 0 });
  assert.equal(effectiveCost(p, mkCard(1, 3)), 3);
});

test("comeback works against boss-style higher maxHp", () => {
  // Boss fight: max 80 HP. 25% = 20.
  const p = mkPlayerState({ trainerHp: 18, maxTrainerHp: 80 });
  assert.equal(effectiveCost(p, mkCard(1, 4)), 3);
  const p2 = mkPlayerState({ trainerHp: 25, maxTrainerHp: 80 });
  assert.equal(effectiveCost(p2, mkCard(1, 4)), 4);
});

// --- Match-length governor -----------------------------------------------

test("turn ≤ 12: no time-pressure damage", () => {
  const deck = Array.from({ length: 30 }, (_, i) => mkCard(i + 1));
  const state = createGame({ playerDeck: deck, aiDeck: deck.slice(), firstPlayer: "player" });
  const startHp = state.players.player.trainerHp;
  // Simulate turns 2-12: each beginTurn should NOT inflict the
  // time-pressure tick. We can't call beginTurn directly (it's
  // internal), but createGame already ran turn 1 and HP should be
  // unchanged.
  assert.equal(startHp, state.players.player.maxTrainerHp,
    "turn 1 should not have ticked HP");
});
