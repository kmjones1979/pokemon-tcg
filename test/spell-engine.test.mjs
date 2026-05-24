// Engine integration: playCard dispatches on kind="spell", Freeze applies
// the freeze status, frozen Pokémon can't attack, status ticks down.

import { test } from "node:test";
import assert from "node:assert/strict";
import { playCard, attack, FIELD_SIZE } from "../client/js/game.js";
import { isLockedOut, tickStatus } from "../client/js/battle.js";
import * as spellCards from "../shared/spell-cards.js";

const { SPELL_CARDS, spellToCard } = spellCards.default ?? spellCards;

const FREEZE = spellToCard(SPELL_CARDS.find((s) => s.effect === "freeze"));

// Tiny test-card factory — mirrors the shape buildDeck produces.
function pokemon(id, { hp = 8, atk = 4, cost = 1, types = ["normal"] } = {}) {
  return {
    id, name: `P${id}`, kind: undefined, // explicitly NOT a spell
    types, energyCost: cost, cardHp: hp, cardAttack: atk,
    tier: cost, rarity: "common",
    is_legendary: false, is_mythical: false,
    raw: { hp: hp * 10, attack: atk * 15, defense: 30, sp_attack: 0, sp_defense: 30, speed: 30 },
  };
}

function makeInst(card, currentHp = null) {
  return {
    instanceId: "i" + card.id,
    card,
    currentHp: currentHp ?? card.cardHp,
    maxHp: card.cardHp,
    summoningSickness: false,
    attackedThisTurn: false,
    status: null,
    attackBoost: 0,
    level: 0,
  };
}

// Match state with both sides populated. `playerHand` is the cards in
// our hand we'll play; `aiField` are the targets for spells.
function makeMatch({ playerHand = [], aiField = [], playerEnergy = 5 } = {}) {
  return {
    turn: 1,
    activePlayer: "player",
    phase: "main",
    winner: null,
    log: [],
    players: {
      player: {
        name: "Player", ability: "brock",
        trainerHp: 30, maxTrainerHp: 30,
        energy: playerEnergy, maxEnergy: 10,
        deck: [], hand: playerHand,
        field: [null, null, null, null, null],
        discard: [],
      },
      ai: {
        name: "AI", ability: "brock",
        trainerHp: 30, maxTrainerHp: 30,
        energy: 5, maxEnergy: 10,
        deck: [], hand: [],
        field: aiField.map((c, i) => i < FIELD_SIZE && c ? makeInst(c) : null)
          .concat(Array(Math.max(0, FIELD_SIZE - aiField.length)).fill(null))
          .slice(0, FIELD_SIZE),
        discard: [],
      },
    },
  };
}

// --- Catalog sanity ---------------------------------------------------

test("Freeze card has the shape playCard expects (kind=spell, effect=freeze)", () => {
  assert.equal(FREEZE.kind, "spell");
  assert.equal(FREEZE.effect, "freeze");
  assert.equal(FREEZE.energyCost, 1);
});

// --- playCard dispatch -----------------------------------------------

test("playing Freeze applies the freeze status to the targeted enemy", () => {
  const enemy = pokemon(50);
  const state = makeMatch({ playerHand: [FREEZE], aiField: [enemy] });
  const result = playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.effect, "freeze");
  const target = state.players.ai.field[0];
  assert.ok(target.status, "expected target to have a status set");
  assert.equal(target.status.kind, "freeze");
  assert.equal(target.status.turnsLeft, 1);
});

test("Freeze pays its energy cost AND removes the card from hand", () => {
  const enemy = pokemon(51);
  const state = makeMatch({ playerHand: [FREEZE], aiField: [enemy], playerEnergy: 3 });
  const before = state.players.player.energy;
  const result = playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(result.ok, true);
  assert.equal(state.players.player.energy, before - FREEZE.energyCost);
  assert.equal(state.players.player.hand.length, 0, "spell should leave hand");
  assert.equal(state.players.player.discard.length, 1, "spell should land in discard");
  assert.equal(state.players.player.discard[0].effect, "freeze");
});

test("Freeze without a target slot returns a useful error (no crash, no consumption)", () => {
  const enemy = pokemon(52);
  const state = makeMatch({ playerHand: [FREEZE], aiField: [enemy] });
  const before = state.players.player.energy;
  const result = playCard(state, "player", 0, { /* no spellTarget */ });
  assert.equal(result.ok, false);
  assert.match(result.reason, /pick.*enemy/i);
  // Energy + hand untouched on rejection.
  assert.equal(state.players.player.energy, before);
  assert.equal(state.players.player.hand.length, 1);
});

test("Freeze on an empty slot is rejected", () => {
  const enemy = pokemon(53);
  // aiField slot 0 has an enemy; slot 1 is empty.
  const state = makeMatch({ playerHand: [FREEZE], aiField: [enemy] });
  const result = playCard(state, "player", 0, { spellTarget: 1 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty/i);
});

test("Freeze rejects out-of-range target indices", () => {
  const enemy = pokemon(54);
  const state = makeMatch({ playerHand: [FREEZE], aiField: [enemy] });
  const result = playCard(state, "player", 0, { spellTarget: 99 });
  assert.equal(result.ok, false);
});

test("Freeze still respects the energy gate (insufficient energy = no play)", () => {
  const enemy = pokemon(55);
  const state = makeMatch({ playerHand: [FREEZE], aiField: [enemy], playerEnergy: 0 });
  const result = playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /energy/i);
  // No status applied.
  assert.equal(state.players.ai.field[0].status, null);
});

// --- Freeze gates the enemy's attack ---------------------------------

test("a frozen Pokémon is locked out (battle.isLockedOut returns true)", () => {
  const frozen = { card: pokemon(60), status: { kind: "freeze", turnsLeft: 1 } };
  assert.equal(isLockedOut(frozen), true);
});

test("freeze decrements via tickStatus and expires when turnsLeft hits 0", () => {
  const target = { name: "F", status: { kind: "freeze", turnsLeft: 1 } };
  const tick1 = tickStatus(target);
  assert.equal(tick1.damage, 0, "freeze deals no damage");
  assert.equal(tick1.expired, true);
  assert.equal(target.status, undefined, "expired status should be removed");
});

// --- Integration: full play loop -------------------------------------

test("Freeze → enemy attack attempt fails (engine refuses to attack while locked)", () => {
  // Set up: ai has a Pokémon on field, we freeze it, then end-turn-ish
  // and try to have AI attack — should be refused.
  const aiAtk = pokemon(70, { hp: 10, atk: 5 });
  const playerDef = pokemon(71, { hp: 10, atk: 5 });
  const state = makeMatch({ playerHand: [FREEZE], aiField: [aiAtk] });
  state.players.player.field[0] = makeInst(playerDef);

  // Freeze the AI's slot 0.
  const r = playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(r.ok, true);
  assert.equal(state.players.ai.field[0].status.kind, "freeze");

  // Hand it to the AI to attack — switch active player, clear sickness.
  state.activePlayer = "ai";
  state.players.ai.field[0].summoningSickness = false;
  state.players.ai.field[0].attackedThisTurn = false;

  const atk = attack(state, "ai", 0, 0);
  assert.equal(atk.ok, false, "frozen attacker shouldn't be allowed to attack");
});
