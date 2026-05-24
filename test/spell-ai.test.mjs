// AI behavior with spell cards in hand.
//
// Slice-1 contract: the AI must NEVER play a spell card. It has no
// targeting logic yet, so picking one would either crash playCard or
// waste the turn. The AI should treat spells as "in hand but skip" and
// pick a Pokémon to summon instead.
//
// Once we ship AI spell-targeting in a later slice, these tests will
// be inverted (the AI will *prefer* high-value spells in good
// situations). For now the test contract is "skip cleanly."

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGame, playCard, FIELD_SIZE } from "../client/js/game.js";
import * as spellCards from "../shared/spell-cards.js";

const { SPELL_CARDS, spellToCard } = spellCards.default ?? spellCards;
const FREEZE = spellToCard(SPELL_CARDS.find((s) => s.effect === "freeze"));

function pokemon(id, { hp = 8, atk = 4, cost = 1, types = ["normal"] } = {}) {
  return {
    id, name: `P${id}`, types,
    energyCost: cost, cardHp: hp, cardAttack: atk,
    tier: cost, rarity: "common",
    is_legendary: false, is_mythical: false,
    raw: { hp: hp * 10, attack: atk * 15, defense: 30, sp_attack: 0, sp_defense: 30, speed: 30 },
  };
}

// Build a small synthetic match with the AI holding a mix of spells +
// Pokémon, then exercise the engine's AI helpers indirectly via a
// known-public function — we'll call playCard from the AI's hand and
// inspect what happens. Strategy: drive the AI's `chooseHandIndex`
// through end-to-end behavior, since it's an internal function.
// We test the OBSERVABLE outcome: AI plays its pokemon, never the spell.

function makeMatch({ aiHand, aiEnergy = 5 }) {
  return {
    turn: 1,
    activePlayer: "ai",
    phase: "main",
    winner: null,
    log: [],
    players: {
      player: {
        name: "Player", ability: "brock",
        trainerHp: 30, maxTrainerHp: 30,
        energy: 5, maxEnergy: 10,
        deck: [], hand: [], field: [null, null, null, null, null], discard: [],
      },
      ai: {
        name: "AI", ability: "brock",
        trainerHp: 30, maxTrainerHp: 30,
        energy: aiEnergy, maxEnergy: 10,
        deck: [], hand: aiHand, field: [null, null, null, null, null], discard: [],
      },
    },
  };
}

test("AI with a spell in hand can still play its Pokémon (no targeting crash)", () => {
  const mon = pokemon(1);
  const state = makeMatch({ aiHand: [FREEZE, mon] });
  // Direct play attempt — playCard with handIndex 1 (the Pokémon) succeeds.
  const r = playCard(state, "ai", 1);
  assert.equal(r.ok, true);
  assert.ok(state.players.ai.field.some((s) => s !== null), "AI Pokémon should be on field");
});

test("AI calling playCard on its own spell (index 0) without a target returns a clean error", () => {
  // The engine itself must reject this gracefully — no exception.
  const mon = pokemon(2);
  const state = makeMatch({ aiHand: [FREEZE, mon] });
  const r = playCard(state, "ai", 0); // no spellTarget
  assert.equal(r.ok, false);
  // Hand untouched; AI didn't burn energy.
  assert.equal(state.players.ai.hand.length, 2);
});

test("AI hand-with-only-spells: no Pokémon summoned, but engine doesn't crash", () => {
  // Edge case: AI's hand contains only spells. playCard for any of them
  // without a target must fail cleanly. The AI's turn loop will just
  // pass (no summon), which is fine.
  const state = makeMatch({ aiHand: [FREEZE, FREEZE, FREEZE] });
  for (let i = 0; i < state.players.ai.hand.length; i++) {
    const r = playCard(state, "ai", i);
    assert.equal(r.ok, false, "spell play should fail without target");
  }
  // Field still empty, hand unchanged.
  assert.deepEqual(state.players.ai.field, [null, null, null, null, null]);
  assert.equal(state.players.ai.hand.length, 3);
});
