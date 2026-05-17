// Tests: engine threads masteryById into createGame, applying +1 ATK
// to L3 cards. Lower levels are visible via _masteryLevel but don't
// change combat stats.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGame } from "../client/js/game.js";

function mkCard(id, cardAttack = 5) {
  return {
    id, name: "Test" + id, types: ["normal"],
    energyCost: 1, cardHp: 8, cardAttack,
    raw: { hp: 80, attack: 60, defense: 30, sp_attack: 60, sp_defense: 30, speed: 30 },
    abilities: [],
  };
}

test("L3 mastery adds +1 ATK to the player deck", () => {
  const deck = Array.from({ length: 30 }, (_, i) => mkCard(i + 1, 5));
  const state = createGame({
    playerDeck: deck,
    aiDeck: deck.slice(),
    masteryById: { 7: { level: 3 }, 9: { level: 2 }, 12: { level: 0 } },
    firstPlayer: "player",
  });
  // The player's deck (hand + remaining deck combined) reflects the bump.
  const all = state.players.player.hand.concat(state.players.player.deck);
  const c7 = all.find((c) => c.id === 7);
  const c9 = all.find((c) => c.id === 9);
  const c12 = all.find((c) => c.id === 12);
  assert.equal(c7?.cardAttack, 6, "L3 card should be 5 + 1 = 6");
  assert.equal(c9?.cardAttack, 5, "L2 should not change ATK");
  assert.equal(c12?.cardAttack, 5, "L0 should not change ATK");
});

test("mastery does not leak into the AI deck", () => {
  const deck = Array.from({ length: 30 }, (_, i) => mkCard(i + 1, 5));
  const state = createGame({
    playerDeck: deck,
    aiDeck: deck.slice(),
    masteryById: { 7: { level: 3 } },
    firstPlayer: "player",
  });
  const aiAll = state.players.ai.hand.concat(state.players.ai.deck);
  const aiC7 = aiAll.find((c) => c.id === 7);
  assert.equal(aiC7?.cardAttack, 5, "AI side should NOT receive the player's mastery bonus");
});

test("no masteryById passed → no _masteryLevel on cards", () => {
  const deck = Array.from({ length: 30 }, (_, i) => mkCard(i + 1, 5));
  const state = createGame({ playerDeck: deck, aiDeck: deck.slice(), firstPlayer: "player" });
  const c = state.players.player.hand[0];
  assert.equal(c._masteryLevel, undefined, "no mastery → no mastery tag");
});

test("L1 / L2 mastery stamps _masteryLevel without ATK change", () => {
  const deck = Array.from({ length: 30 }, (_, i) => mkCard(i + 1, 5));
  const state = createGame({
    playerDeck: deck,
    aiDeck: deck.slice(),
    masteryById: { 7: { level: 2 } },
    firstPlayer: "player",
  });
  const all = state.players.player.hand.concat(state.players.player.deck);
  const c7 = all.find((c) => c.id === 7);
  assert.equal(c7._masteryLevel, 2);
  assert.equal(c7.cardAttack, 5);
});
