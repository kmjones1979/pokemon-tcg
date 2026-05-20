// Regression for "AI didn't drop any cards even with a full hand."
// Before the fix, passPlayChance could break the summon loop on
// iteration 0 (~6% of medium-mode turns). The new contract is that
// the AI ALWAYS attempts at least one summon when energy + a slot
// are available; passPlayChance only fires once a card has landed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGame, aiTakeTurn, endTurn } from "../client/js/game.js";

function deck(n, cost = 1) {
  return Array.from({ length: n }, (_, i) => ({
    id: 1000 + i, name: "C" + (1000 + i), types: ["normal"], tier: 1,
    energyCost: cost, cardHp: 10, cardAttack: 4,
    raw: { hp: 60, attack: 40, defense: 30, sp_attack: 40, sp_defense: 30, speed: 30 },
  }));
}

test("AI summons at least once with affordable cards (no passPlayChance early-bail)", async () => {
  // Worst-case: rand() always returns 0, which on the OLD code triggered
  // passPlayChance break immediately. The new loop must still summon.
  const s = createGame({ playerDeck: deck(30), aiDeck: deck(30, 1), firstPlayer: "ai" });
  const before = s.players.ai.field.filter(Boolean).length;
  await aiTakeTurn(s, { rand: () => 0, difficulty: "medium" });
  const after = s.players.ai.field.filter(Boolean).length;
  assert.ok(after > before, `AI should have summoned at least one card (before=${before}, after=${after})`);
});

test("AI on hard difficulty drops multiple cheap cards in one turn when energy allows", async () => {
  const s = createGame({ playerDeck: deck(30), aiDeck: deck(30, 1), firstPlayer: "ai" });
  // Give AI plenty of energy to summon multiple.
  s.players.ai.energy = 5;
  s.players.ai.maxEnergy = 5;
  // Stable rand so passPlayChance never fires (hard policy: 0 anyway).
  await aiTakeTurn(s, { rand: () => 0.5, difficulty: "hard" });
  const summoned = s.players.ai.field.filter(Boolean).length;
  assert.ok(summoned >= 2, `Hard AI with 5 energy and 1-cost cards should summon ≥2 (got ${summoned})`);
});

test("AI replaces weakest field card on smart policies when hand has a clear upgrade", async () => {
  const s = createGame({ playerDeck: deck(30), aiDeck: deck(30, 1), firstPlayer: "ai" });
  const ai = s.players.ai;
  // Fill field with a weak attacker; give AI an obviously better card in hand.
  const weak = { id: 9999, name: "WeakBoi", types: ["normal"], tier: 1,
    energyCost: 1, cardHp: 5, cardAttack: 1,
    raw: { hp: 30, attack: 10, defense: 10, sp_attack: 10, sp_defense: 10, speed: 10 } };
  const strong = { id: 9998, name: "Ace", types: ["normal"], tier: 4,
    energyCost: 3, cardHp: 30, cardAttack: 10,
    raw: { hp: 100, attack: 80, defense: 60, sp_attack: 80, sp_defense: 60, speed: 80 },
    abilities: [{ name: "Iron Defense", short: "Reduce damage" }] };
  for (let i = 0; i < ai.field.length; i++) {
    ai.field[i] = { instanceId: "w" + i, card: weak, currentHp: 5, maxHp: 5,
      summoningSickness: false, attackedThisTurn: false, status: null };
  }
  ai.hand = [strong];
  ai.energy = 5;
  ai.maxEnergy = 5;
  await aiTakeTurn(s, { rand: () => 0.5, difficulty: "hard" });
  const onField = ai.field.filter(Boolean).map((i) => i.card.name);
  assert.ok(onField.includes("Ace"), `AI should have replaced a weak slot with Ace; field=${onField.join(",")}`);
});
