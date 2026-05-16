import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  playCard,
  attack,
  endTurn,
  aiTakeTurn,
  effectiveCost,
  FIELD_SIZE,
  STARTING_HAND,
  TRAINER_START_HP,
} from "../client/js/game.js";

// Mini deck factory — 30 cheap normal-type cards so deterministic tests can ignore
// energy / type-effectiveness side effects.
function deck(prefix, n = 30) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: i + 1,
      name: `${prefix}-${i}`,
      slug: `${prefix}-${i}`,
      types: ["normal"],
      cardHp: 5,
      cardAttack: 2,
      energyCost: 1,
      tier: 1,
      bst: 200,
      raw: { hp: 50, attack: 60, defense: 0, sp_attack: 0, sp_defense: 0, speed: 0 },
      sprite_front: null,
      cry_url: null,
      is_legendary: false,
      is_mythical: false,
    });
  }
  return out;
}

function fixedRng(seq = [0.1, 0.2, 0.3, 0.4, 0.5]) {
  let i = 0;
  return () => seq[i++ % seq.length];
}

test("createGame deals 5-card hands and starts player turn 1 with 1 energy", () => {
  const g = createGame({
    playerDeck: deck("p"),
    aiDeck: deck("a"),
    playerAbility: "brock",
    aiAbility: "misty",
    rand: fixedRng(),
  });
  // Starting hand of 5, plus the turn-1 draw = 6 in hand once play begins.
  assert.equal(g.players.player.hand.length, STARTING_HAND + 1);
  assert.equal(g.players.ai.hand.length, STARTING_HAND);
  assert.equal(g.turn, 1);
  assert.equal(g.activePlayer, "player");
  assert.equal(g.players.player.energy, 1);
  assert.equal(g.players.player.maxEnergy, 1);
  assert.equal(g.players.player.trainerHp, TRAINER_START_HP);
  assert.equal(g.phase, "main");
});

test("playCard moves a card from hand to field and deducts energy", () => {
  const g = createGame({ playerDeck: deck("p"), aiDeck: deck("a"), rand: fixedRng() });
  const before = g.players.player.hand.length;
  const r = playCard(g, "player", 0);
  assert.equal(r.ok, true);
  assert.equal(g.players.player.hand.length, before - 1);
  assert.ok(g.players.player.field.some((s) => s != null));
  assert.equal(g.players.player.energy, 0);
});

test("playCard rejects when not enough energy", () => {
  const g = createGame({ playerDeck: deck("p"), aiDeck: deck("a"), rand: fixedRng() });
  // First play consumes our 1 energy
  playCard(g, "player", 0);
  // Second play should fail
  const r = playCard(g, "player", 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not enough energy");
});

test("summoning sickness blocks the card from attacking the turn it's played", () => {
  const g = createGame({ playerDeck: deck("p"), aiDeck: deck("a"), rand: fixedRng() });
  playCard(g, "player", 0);
  // AI has empty field, but attack should still be blocked by sickness
  const r = attack(g, "player", 0, "trainer");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "summoning sickness");
});

test("end-turn flips activePlayer and grows max energy", () => {
  const g = createGame({ playerDeck: deck("p"), aiDeck: deck("a"), rand: fixedRng() });
  endTurn(g);
  assert.equal(g.activePlayer, "ai");
  assert.equal(g.players.ai.maxEnergy, 1);
  endTurn(g);
  assert.equal(g.activePlayer, "player");
  assert.equal(g.players.player.maxEnergy, 2);
  assert.equal(g.players.player.energy, 2);
});

test("attack against opposing trainer when their field is empty", () => {
  const g = createGame({ playerDeck: deck("p"), aiDeck: deck("a"), rand: fixedRng() });
  playCard(g, "player", 0);
  endTurn(g); // ai
  endTurn(g); // back to player turn 2 -- sickness clears
  const r = attack(g, "player", 0, "trainer");
  assert.equal(r.ok, true);
  assert.ok(g.players.ai.trainerHp < TRAINER_START_HP);
});

test("you can't attack the trainer if their field has a Pokémon", () => {
  const g = createGame({ playerDeck: deck("p"), aiDeck: deck("a"), rand: fixedRng() });
  // Manually drop an AI Pokémon onto the field
  g.players.ai.field[0] = {
    instanceId: "ai1",
    card: g.players.ai.hand[0],
    currentHp: 3,
    summoningSickness: false,
    status: null,
  };
  playCard(g, "player", 0);
  endTurn(g); // ai turn (skip)
  endTurn(g); // back to player, sickness clears
  const r = attack(g, "player", 0, "trainer");
  assert.equal(r.ok, false);
  assert.match(r.reason, /opposing/i);
});

test("winning ends the game", () => {
  const g = createGame({ playerDeck: deck("p"), aiDeck: deck("a"), rand: fixedRng() });
  g.players.ai.trainerHp = 1;
  playCard(g, "player", 0);
  endTurn(g);
  endTurn(g);
  attack(g, "player", 0, "trainer");
  assert.equal(g.winner, "player");
  assert.equal(g.phase, "over");
});

test("Misty's ability discounts water cards by 1 energy (min 1)", () => {
  const player = {
    ability: "misty",
  };
  const waterCard = { types: ["water"], energyCost: 3 };
  assert.equal(effectiveCost(player, waterCard), 2);
  const cheap = { types: ["water"], energyCost: 1 };
  assert.equal(effectiveCost(player, cheap), 1);
  const fireCard = { types: ["fire"], energyCost: 3 };
  assert.equal(effectiveCost(player, fireCard), 3);
});

test("AI takes its turn without crashing and ends the turn", () => {
  const g = createGame({ playerDeck: deck("p"), aiDeck: deck("a"), rand: fixedRng() });
  endTurn(g); // hand over to AI
  aiTakeTurn(g, { rand: fixedRng() });
  // After AI turn the active player should be the human again
  assert.equal(g.activePlayer, "player");
  assert.ok(g.turn >= 2);
});

test("AI difficulty: each difficulty completes a turn cleanly", () => {
  for (const difficulty of ["easy", "medium", "hard"]) {
    const g = createGame({ playerDeck: deck("p"), aiDeck: deck("a"), rand: fixedRng() });
    endTurn(g);
    aiTakeTurn(g, { rand: fixedRng(), difficulty });
    assert.equal(g.activePlayer, "player", `difficulty=${difficulty}`);
    assert.equal(g.phase, "main");
  }
});

test("AI difficulty: easy mode often skips actions vs hard mode", () => {
  // With deterministic RNG rolling low (=passes), Easy should summon less than Hard.
  function countSummons(difficulty) {
    let total = 0;
    for (let trial = 0; trial < 12; trial++) {
      const g = createGame({ playerDeck: deck("p"), aiDeck: deck("a"), rand: fixedRng([0.1, 0.2, 0.05, 0.4, 0.6]) });
      // Let the AI ramp through several turns.
      for (let i = 0; i < 5; i++) {
        endTurn(g);
        aiTakeTurn(g, { rand: fixedRng([0.1, 0.2, 0.05, 0.4, 0.6]), difficulty });
      }
      total += g.players.ai.field.filter(Boolean).length + g.players.ai.discard.length;
    }
    return total;
  }
  const easy = countSummons("easy");
  const hard = countSummons("hard");
  assert.ok(hard >= easy, `expected hard (${hard}) >= easy (${easy})`);
});
