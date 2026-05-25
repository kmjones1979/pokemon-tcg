// Engine integration: a Pokémon that scores EVOLUTION_KO_THRESHOLD
// KOs and has an evolves_to_card baked on its card auto-transforms
// into the evolved form during attack(). HP percentage carries over,
// kos resets so chained evolutions can fire again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { attack, FIELD_SIZE } from "../client/js/game.js";
import * as evoChains from "../shared/evolution-chains.js";

const { EVOLUTION_KO_THRESHOLD } = evoChains.default ?? evoChains;

function mkPokemon(id, name, { hp = 8, atk = 4, types = ["fire"] } = {}) {
  return {
    id, name, types,
    energyCost: 1, cardHp: hp, cardAttack: atk,
    tier: 2, rarity: "uncommon",
    raw: { hp: hp * 10, attack: atk * 15, defense: 30, sp_attack: 0, sp_defense: 30, speed: 30 },
  };
}

function mkInst(card, currentHp = null, kos = 0) {
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
    kos,
  };
}

function makeMatch(attackerInst, defenderInst) {
  return {
    turn: 5, activePlayer: "player", phase: "main", winner: null, log: [],
    players: {
      player: {
        name: "P", ability: "brock",
        trainerHp: 30, maxTrainerHp: 30,
        energy: 5, maxEnergy: 10,
        deck: [], hand: [],
        field: [attackerInst].concat(Array(FIELD_SIZE - 1).fill(null)),
        discard: [],
      },
      ai: {
        name: "AI", ability: "brock",
        trainerHp: 30, maxTrainerHp: 30,
        energy: 5, maxEnergy: 10,
        deck: [], hand: [],
        field: [defenderInst].concat(Array(FIELD_SIZE - 1).fill(null)),
        discard: [],
      },
    },
    recap: {
      player: { crits: 0, kos: 0, biggestHit: 0, biggestHitName: null, totalDamage: 0 },
      ai:     { crits: 0, kos: 0, biggestHit: 0, biggestHitName: null, totalDamage: 0 },
    },
  };
}

test("Pokémon evolves after KOing EVOLUTION_KO_THRESHOLD enemies", () => {
  const charmander  = mkPokemon(4, "Charmander", { atk: 6, hp: 8 });
  const charmeleon  = mkPokemon(5, "Charmeleon", { atk: 8, hp: 12 });
  charmander.evolves_to_card = charmeleon; // mimic the server's bake

  // Attacker with kos already at threshold-1 — one more KO triggers evolution.
  const attacker = mkInst(charmander, 8, EVOLUTION_KO_THRESHOLD - 1);
  const weakDefender = mkInst(mkPokemon(99, "Magikarp", { hp: 1, atk: 1 }));
  const state = makeMatch(attacker, weakDefender);

  const r = attack(state, "player", 0, 0);
  assert.equal(r.ok, true);
  assert.equal(r.knockedOut, true);
  // After the KO, evolution should have happened.
  const evolved = state.players.player.field[0];
  assert.ok(evolved, "attacker should still be on the field after KO");
  assert.equal(evolved.card.id, 5, "Charmander should have evolved into Charmeleon");
  assert.equal(evolved.card.name, "Charmeleon");
  assert.equal(evolved.kos, 0, "kos should reset on the evolved form");
  assert.ok(r.attackerEvolved, "result should report the evolution");
  assert.equal(r.attackerEvolved.toName, "Charmeleon");
});

test("Pokémon does NOT evolve on the first KO (below threshold)", () => {
  const charmander  = mkPokemon(4, "Charmander");
  charmander.evolves_to_card = mkPokemon(5, "Charmeleon");
  const attacker = mkInst(charmander, 8, 0);
  const weak = mkInst(mkPokemon(99, "Caterpie", { hp: 1, atk: 1 }));
  const state = makeMatch(attacker, weak);

  const r = attack(state, "player", 0, 0);
  assert.equal(r.ok, true);
  assert.equal(r.knockedOut, true);
  const still = state.players.player.field[0];
  assert.equal(still.card.id, 4, "Charmander stays Charmander after 1 KO");
  assert.equal(still.kos, 1, "kos incremented but below threshold");
  assert.ok(!r.attackerEvolved, "no evolution result on this KO");
});

test("HP percentage carries over on evolution", () => {
  // Attacker at 50% HP (4/8) KOs and evolves. The evolved form should
  // be at ~50% of its new maxHp.
  const charmander  = mkPokemon(4, "Charmander", { hp: 8 });
  const charmeleon  = mkPokemon(5, "Charmeleon", { hp: 12 });
  charmander.evolves_to_card = charmeleon;
  const attacker = mkInst(charmander, 4, EVOLUTION_KO_THRESHOLD - 1); // half HP
  const weak = mkInst(mkPokemon(99, "Caterpie", { hp: 1, atk: 1 }));
  const state = makeMatch(attacker, weak);
  attack(state, "player", 0, 0);
  const evolved = state.players.player.field[0];
  assert.equal(evolved.card.id, 5);
  // 50% of 13 (cardHp 12 + 1 level bonus from KO) = 6 or 7
  assert.ok(evolved.currentHp >= 4 && evolved.currentHp <= 8,
    `expected ~50% of new max HP, got ${evolved.currentHp}/${evolved.maxHp}`);
  assert.ok(evolved.maxHp > 8, "max HP grew on evolution");
});

test("Pokémon without evolves_to_card never evolves (regression: no-data → no-op)", () => {
  // Mewtwo / final forms have no chain. Multiple KOs should not crash.
  const mewtwo = mkPokemon(150, "Mewtwo", { atk: 10, hp: 12 });
  // NO evolves_to_card.
  const attacker = mkInst(mewtwo, 12, EVOLUTION_KO_THRESHOLD - 1);
  const weak = mkInst(mkPokemon(99, "Caterpie", { hp: 1, atk: 1 }));
  const state = makeMatch(attacker, weak);
  const r = attack(state, "player", 0, 0);
  assert.equal(r.ok, true);
  assert.equal(r.knockedOut, true);
  // Mewtwo stays Mewtwo, kos increments, no crash.
  const still = state.players.player.field[0];
  assert.equal(still.card.id, 150);
  assert.equal(still.kos, EVOLUTION_KO_THRESHOLD);
  assert.ok(!r.attackerEvolved);
});

test("Chained evolution: a Pokémon with TWO chain steps can evolve twice in one match", () => {
  // Charmander → Charmeleon → Charizard. After the first evolution,
  // kos resets and Charmeleon must also have evolves_to_card so the
  // second chain step works.
  const charizard   = mkPokemon(6, "Charizard", { hp: 18, atk: 12 });
  const charmeleon  = mkPokemon(5, "Charmeleon", { hp: 12, atk: 8 });
  charmeleon.evolves_to_card = charizard;
  const charmander  = mkPokemon(4, "Charmander", { hp: 8, atk: 6 });
  charmander.evolves_to_card = charmeleon;

  // Start as Charmander with 1 KO under his belt. KO an enemy →
  // becomes Charmeleon. kos resets to 0.
  const attacker = mkInst(charmander, 8, EVOLUTION_KO_THRESHOLD - 1);
  let state = makeMatch(attacker, mkInst(mkPokemon(99, "W", { hp: 1, atk: 1 })));
  attack(state, "player", 0, 0);
  let attackerNow = state.players.player.field[0];
  assert.equal(attackerNow.card.id, 5, "evolved to Charmeleon");
  assert.equal(attackerNow.kos, 0);

  // Now KO another → kos=1. No evolution yet (threshold is 2).
  state.players.ai.field[0] = mkInst(mkPokemon(98, "W2", { hp: 1, atk: 1 }));
  attackerNow.attackedThisTurn = false; // allow another attack
  attack(state, "player", 0, 0);
  attackerNow = state.players.player.field[0];
  assert.equal(attackerNow.card.id, 5, "still Charmeleon after one KO post-evolution");
  assert.equal(attackerNow.kos, 1);

  // KO one more — should evolve into Charizard.
  state.players.ai.field[0] = mkInst(mkPokemon(97, "W3", { hp: 1, atk: 1 }));
  attackerNow.attackedThisTurn = false;
  attack(state, "player", 0, 0);
  attackerNow = state.players.player.field[0];
  assert.equal(attackerNow.card.id, 6, "Charmeleon evolved into Charizard");
});
