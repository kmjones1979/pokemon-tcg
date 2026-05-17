// End-to-end scripted-match tests. These exercise the engine's public
// API the same way main.js does in production — createGame, playCard,
// attack, endTurn, mulliganHand — and assert the macro behaviors that
// matter for player experience: turns advance, energy refills, KOs
// register, recap counters move, win conditions fire.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGame, playCard, attack, endTurn, mulliganHand, FIELD_SIZE, TRAINER_START_HP } from "../client/js/game.js";

function deck(n, ofType = "normal", baseAttack = 5, baseHp = 10) {
  return Array.from({ length: n }, (_, i) => ({
    id: 1000 + i, name: "C" + (1000 + i), types: [ofType],
    energyCost: 1, cardHp: baseHp, cardAttack: baseAttack,
    raw: { hp: baseHp * 10, attack: baseAttack * 15, defense: 30, sp_attack: baseAttack * 15, sp_defense: 30, speed: 30 },
  }));
}

test("createGame returns a state with two sides + initial recap counters", () => {
  const s = createGame({ playerDeck: deck(30), aiDeck: deck(30), firstPlayer: "player" });
  assert.equal(s.activePlayer, "player");
  assert.equal(s.players.player.trainerHp, TRAINER_START_HP);
  assert.equal(s.players.ai.trainerHp, TRAINER_START_HP);
  assert.equal(s.players.player.field.length, FIELD_SIZE);
  assert.deepEqual(s.recap.player, { crits: 0, kos: 0, biggestHit: 0, biggestHitName: null, totalDamage: 0 });
});

test("playCard moves a card from hand → field, decrements energy", () => {
  const s = createGame({ playerDeck: deck(30, "normal", 5, 10), aiDeck: deck(30), firstPlayer: "player" });
  s.players.player.energy = 5; // skip the natural ramp for the test
  const before = s.players.player.hand.length;
  const r = playCard(s, "player", 0);
  assert.ok(r.ok, r.reason);
  assert.equal(s.players.player.hand.length, before - 1);
  assert.ok(s.players.player.field[r.slot], "card landed on field");
  assert.ok(s.players.player.energy < 5, "energy decremented");
});

test("playCard rejects if energy insufficient", () => {
  const s = createGame({ playerDeck: deck(30), aiDeck: deck(30), firstPlayer: "player" });
  s.players.player.energy = 0;
  const r = playCard(s, "player", 0);
  assert.equal(r.ok, false);
});

test("attack with no defenders targets trainer + drops HP", () => {
  const s = createGame({ playerDeck: deck(30, "fire", 8, 10), aiDeck: deck(30, "grass"), firstPlayer: "player" });
  s.players.player.energy = 10;
  playCard(s, "player", 0);
  // Clear summoning sickness so the new card can attack this turn
  s.players.player.field.forEach((i) => { if (i) i.summoningSickness = false; });
  const before = s.players.ai.trainerHp;
  const r = attack(s, "player", 0, "trainer", { abilityId: "basic" });
  assert.ok(r.ok, r.reason);
  assert.ok(s.players.ai.trainerHp < before, "ai trainer hp decreased");
  assert.equal(r.target, "trainer");
});

// Helper: drop an instance directly onto the AI side's field bypassing
// turn order. The engine only lets the active side call playCard; for
// integration tests we just set up the board state.
function placeAi(s, slot, card, currentHp = null) {
  const inst = {
    instanceId: "test-" + slot,
    card,
    currentHp: currentHp ?? card.cardHp,
    maxHp: card.cardHp,
    summoningSickness: false,
    attackedThisTurn: false,
    status: null,
  };
  s.players.ai.field[slot] = inst;
  return inst;
}

test("attack against a defender deals damage scaled by type chart", () => {
  const s = createGame({ playerDeck: deck(30, "fire", 8, 10), aiDeck: deck(30, "grass", 1, 10), firstPlayer: "player" });
  s.players.player.energy = 10;
  playCard(s, "player", 0);
  s.players.player.field.forEach((i) => { if (i) i.summoningSickness = false; });
  // Place a defender directly so we don't have to advance turn order.
  placeAi(s, 0, deck(1, "grass", 1, 10)[0]);
  const before = s.players.ai.field[0].currentHp;
  const r = attack(s, "player", 0, 0, { abilityId: "basic" });
  assert.ok(r.ok, r.reason);
  assert.equal(r.multiplier, 2, "fire vs grass = 2×");
  assert.ok(s.players.ai.field[0]?.currentHp < before || s.players.ai.field[0] === null,
    "defender hp dropped or KO'd");
});

test("KO'd defender moves to opponent's discard pile + clears field slot", () => {
  const s = createGame({ playerDeck: deck(30, "fire", 15, 10), aiDeck: deck(30), firstPlayer: "player" });
  s.players.player.energy = 10;
  playCard(s, "player", 0);
  s.players.player.field.forEach((i) => { if (i) i.summoningSickness = false; });
  placeAi(s, 0, deck(1, "grass", 1, 1)[0]);
  const r = attack(s, "player", 0, 0, { abilityId: "basic" });
  assert.ok(r.ok);
  assert.equal(s.players.ai.field[0], null, "slot cleared on KO");
  assert.equal(s.players.ai.discard.length, 1, "card moved to discard");
  assert.equal(s.recap.player.kos, 1, "recap kos counter incremented");
});

test("endTurn flips activePlayer + refills energy on next turn", () => {
  const s = createGame({ playerDeck: deck(30), aiDeck: deck(30), firstPlayer: "player" });
  const startTurn = s.turn;
  endTurn(s);
  assert.equal(s.activePlayer, "ai");
  endTurn(s);
  assert.equal(s.activePlayer, "player");
  assert.ok(s.turn > startTurn, "turn counter advanced");
  assert.ok(s.players.player.maxEnergy > 0, "energy ramps each round");
});

test("trainer HP at 0 sets winner + over phase", () => {
  const s = createGame({ playerDeck: deck(30, "fire", 30, 10), aiDeck: deck(30), firstPlayer: "player" });
  s.players.player.energy = 10;
  playCard(s, "player", 0);
  s.players.player.field.forEach((i) => { if (i) i.summoningSickness = false; });
  // Smash the AI trainer.
  s.players.ai.trainerHp = 1;
  attack(s, "player", 0, "trainer", { abilityId: "basic" });
  assert.equal(s.winner, "player");
  assert.equal(s.phase, "over");
});

test("recap.biggestHit + biggestHitName track the largest single hit", () => {
  const s = createGame({ playerDeck: deck(30, "fire", 12, 10), aiDeck: deck(30), firstPlayer: "player" });
  s.players.player.energy = 10;
  playCard(s, "player", 0);
  s.players.player.field.forEach((i) => { if (i) i.summoningSickness = false; });
  placeAi(s, 0, deck(1, "grass", 1, 25)[0]);
  attack(s, "player", 0, 0, { abilityId: "basic" });
  assert.ok(s.recap.player.biggestHit > 0, `biggestHit was ${s.recap.player.biggestHit}`);
  assert.equal(s.recap.player.biggestHitName, s.players.player.field[0].card.name);
});

test("mulliganHand replaces specified indices, total hand size unchanged", () => {
  const s = createGame({ playerDeck: deck(30, "fire", 6, 10), aiDeck: deck(30), firstPlayer: "player" });
  const beforeHand = [...s.players.player.hand];
  const beforeIds = beforeHand.map((c) => c.id);
  mulliganHand(s, "player", [0, 1]);
  // Hand size preserved.
  assert.equal(s.players.player.hand.length, beforeHand.length);
  // First two cards should NOT match the originals (they were swapped).
  // With a 30-card deck this is overwhelmingly likely; we test for at
  // least one of the two swapped positions to differ.
  const afterIds = s.players.player.hand.map((c) => c.id);
  const someChanged = afterIds[0] !== beforeIds[0] || afterIds[1] !== beforeIds[1];
  assert.ok(someChanged, "at least one of the mulligan'd cards should have changed");
});

test("mulliganHand with empty indices is a no-op", () => {
  const s = createGame({ playerDeck: deck(30), aiDeck: deck(30), firstPlayer: "player" });
  const beforeIds = s.players.player.hand.map((c) => c.id);
  mulliganHand(s, "player", []);
  const afterIds = s.players.player.hand.map((c) => c.id);
  assert.deepEqual(afterIds, beforeIds);
});

test("attack on summoning-sick card is rejected", () => {
  const s = createGame({ playerDeck: deck(30), aiDeck: deck(30), firstPlayer: "player" });
  s.players.player.energy = 10;
  playCard(s, "player", 0);
  // summoningSickness is true by default for non-flying types
  const r = attack(s, "player", 0, "trainer", { abilityId: "basic" });
  assert.equal(r.ok, false);
  assert.match(r.reason || "", /sick/i);
});

test("playCard rejects with no such hand index", () => {
  const s = createGame({ playerDeck: deck(30), aiDeck: deck(30), firstPlayer: "player" });
  s.players.player.energy = 10;
  const r = playCard(s, "player", 999);
  assert.equal(r.ok, false);
});

test("can't act after the match is over", () => {
  const s = createGame({ playerDeck: deck(30), aiDeck: deck(30), firstPlayer: "player" });
  s.winner = "player"; s.phase = "over";
  const r = playCard(s, "player", 0);
  assert.equal(r.ok, false);
  assert.match(r.reason || "", /over/i);
});

test("comeback mechanic kicks in once player drops below 25% HP", () => {
  // Re-uses pure effectiveCost from comeback-fatigue.test.mjs but
  // verified here via the playCard path: a 5-cost card at 5 energy
  // is unplayable normally but playable with the comeback discount.
  const s = createGame({ playerDeck: deck(30), aiDeck: deck(30), firstPlayer: "player" });
  s.players.player.energy = 4;
  s.players.player.hand[0] = { ...s.players.player.hand[0], energyCost: 5 };
  // First: at full HP, energy 4 < cost 5 → rejected.
  let r = playCard(s, "player", 0);
  assert.equal(r.ok, false);
  // Drop HP to trigger comeback (< 25% of max).
  s.players.player.trainerHp = 5; // < 7.5
  r = playCard(s, "player", 0);
  assert.ok(r.ok, `comeback should make 5-cost playable at 4 energy: ${r.reason}`);
});
