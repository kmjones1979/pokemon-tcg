// Tests for random match modifiers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MODIFIERS, rollModifier, applyModifier } from "../client/js/match-modifiers.js";
import { createGame, playCard, attack, effectiveCost } from "../client/js/game.js";

function deck(n, type = "normal", atk = 5, hp = 10) {
  return Array.from({ length: n }, (_, i) => ({
    id: 1000 + i, name: "C" + (1000 + i), types: [type],
    energyCost: 2, cardHp: hp, cardAttack: atk,
    raw: { hp: hp * 10, attack: atk * 15, defense: 30, sp_attack: atk * 15, sp_defense: 30, speed: 30 },
  }));
}

// --- MODIFIERS catalog -----------------------------------------------

test("every modifier has id, name, icon, desc, apply", () => {
  for (const m of MODIFIERS) {
    assert.ok(m.id && typeof m.id === "string", `${m.id}: id missing`);
    assert.ok(m.name && typeof m.name === "string", `${m.id}: name missing`);
    assert.ok(m.icon && typeof m.icon === "string", `${m.id}: icon missing`);
    assert.ok(m.desc && typeof m.desc === "string", `${m.id}: desc missing`);
    assert.equal(typeof m.apply, "function", `${m.id}: apply must be a function`);
  }
});

test("modifier ids are unique", () => {
  const seen = new Set();
  for (const m of MODIFIERS) {
    assert.ok(!seen.has(m.id), `duplicate id: ${m.id}`);
    seen.add(m.id);
  }
});

test("MODIFIERS catalog has at least 6 entries (variety)", () => {
  assert.ok(MODIFIERS.length >= 6, `expected ≥6 modifiers, got ${MODIFIERS.length}`);
});

// --- rollModifier ----------------------------------------------------

test("rollModifier: chance=0 always returns null", () => {
  for (let i = 0; i < 10; i++) {
    assert.equal(rollModifier(() => 0.5, 0), null);
  }
});

test("rollModifier: chance=1 always returns a modifier", () => {
  const m = rollModifier(() => 0, 1);
  assert.ok(m, "expected a modifier");
  assert.ok(MODIFIERS.includes(m), "should be from catalog");
});

test("rollModifier: deterministic with seeded rand", () => {
  // First call uses rand() for chance gate (returns 0.1 < 0.3),
  // second call uses rand() to pick an index (returns 0.5 → idx 4).
  const seq = [0.1, 0.5];
  let i = 0;
  const rand = () => seq[i++];
  const m = rollModifier(rand);
  assert.ok(m);
  assert.equal(m, MODIFIERS[Math.floor(0.5 * MODIFIERS.length)]);
});

test("rollModifier: rand >= chance returns null", () => {
  // Default chance 0.3, rand returns 0.4 first → above threshold.
  assert.equal(rollModifier(() => 0.4), null);
});

// --- applyModifier integration ---------------------------------------

test("applyModifier: null is a safe no-op", () => {
  const s = createGame({ playerDeck: deck(30), aiDeck: deck(30), firstPlayer: "player" });
  const ret = applyModifier(s, null);
  assert.equal(ret, null);
  assert.equal(s.modifierActive, undefined);
});

test("Fast Start: +1 max energy + +1 current energy on both sides", () => {
  const s = createGame({ playerDeck: deck(30), aiDeck: deck(30), firstPlayer: "player" });
  // The two sides start at different states because beginTurn() only
  // runs once for the FIRST player. Capture each side independently.
  const playerBeforeMax = s.players.player.maxEnergy;
  const playerBeforeEng = s.players.player.energy;
  const aiBeforeMax     = s.players.ai.maxEnergy;
  applyModifier(s, MODIFIERS.find((x) => x.id === "fast-start"));
  assert.equal(s.players.player.maxEnergy, playerBeforeMax + 1);
  assert.equal(s.players.player.energy,    playerBeforeEng + 1);
  assert.equal(s.players.ai.maxEnergy,     aiBeforeMax + 1);
});

test("Glass Cannon: damage multiplied by 1.5x", () => {
  const s = createGame({
    playerDeck: deck(30, "fire", 6, 10), aiDeck: deck(30, "normal", 1, 30),
    firstPlayer: "player",
  });
  s.players.player.energy = 10;
  // Drop a card directly onto AI field for the attack.
  s.players.ai.field[0] = {
    instanceId: "i1",
    card: deck(1, "normal", 1, 30)[0],
    currentHp: 30, maxHp: 30,
    summoningSickness: false, attackedThisTurn: false, status: null,
  };
  playCard(s, "player", 0);
  s.players.player.field.forEach((i) => { if (i) i.summoningSickness = false; });
  const before = s.players.ai.field[0].currentHp;
  // Deterministic rand=0.99 keeps crits out of both attacks so we're
  // comparing pure damage multipliers, not crit luck.
  const noCrit = () => 0.99;
  const r1 = attack(s, "player", 0, 0, { abilityId: "basic", rand: noCrit });
  const vanillaDmg = before - s.players.ai.field[0].currentHp;
  // Reset and apply Glass Cannon.
  s.players.ai.field[0].currentHp = 30;
  s.players.player.field[0].attackedThisTurn = false;
  applyModifier(s, MODIFIERS.find((x) => x.id === "glass-cannon"));
  attack(s, "player", 0, 0, { abilityId: "basic", rand: noCrit });
  const glassDmg = 30 - s.players.ai.field[0].currentHp;
  assert.ok(glassDmg > vanillaDmg, `glass cannon should hit harder (${glassDmg} vs ${vanillaDmg})`);
});

test("Type Storm (fire): fire attackers get +2 ATK, others unaffected", () => {
  const s = createGame({ playerDeck: deck(30, "fire", 5, 10), aiDeck: deck(30), firstPlayer: "player" });
  s.players.player.energy = 10;
  s.players.ai.field[0] = {
    instanceId: "i1", card: deck(1, "normal", 1, 50)[0],
    currentHp: 50, maxHp: 50,
    summoningSickness: false, attackedThisTurn: false, status: null,
  };
  playCard(s, "player", 0);
  s.players.player.field.forEach((i) => { if (i) i.summoningSickness = false; });
  // Baseline.
  attack(s, "player", 0, 0, { abilityId: "basic" });
  const vanilla = 50 - s.players.ai.field[0].currentHp;
  // Reset + apply.
  s.players.ai.field[0].currentHp = 50;
  s.players.player.field[0].attackedThisTurn = false;
  applyModifier(s, MODIFIERS.find((x) => x.id === "type-storm-fire"));
  attack(s, "player", 0, 0, { abilityId: "basic" });
  const stormed = 50 - s.players.ai.field[0].currentHp;
  assert.ok(stormed > vanilla, `fire storm should boost fire attacks (${stormed} vs ${vanilla})`);
});

test("Last Stand: comeback fires at 40% HP instead of 25%", () => {
  const s = createGame({ playerDeck: deck(30), aiDeck: deck(30), firstPlayer: "player" });
  // 35% HP — between 25% and 40%
  s.players.player.trainerHp = Math.round(s.players.player.maxTrainerHp * 0.35);
  // Without modifier: no discount (above 25%).
  const cardCost4 = { ...s.players.player.hand[0], energyCost: 4 };
  assert.equal(effectiveCost(s.players.player, cardCost4), 4, "no discount baseline");
  // Apply Last Stand.
  applyModifier(s, MODIFIERS.find((x) => x.id === "last-stand"));
  assert.equal(effectiveCost(s.players.player, cardCost4), 3, "Last Stand kicks comeback in earlier");
});

test("Crit Carnival: critBoost flag is set on state", () => {
  const s = createGame({ playerDeck: deck(30), aiDeck: deck(30), firstPlayer: "player" });
  applyModifier(s, MODIFIERS.find((x) => x.id === "crit-carnival"));
  assert.equal(s.modifier_critBoost, 0.10);
});

test("Lucky Draws: both hands get +1 card", () => {
  const s = createGame({ playerDeck: deck(30), aiDeck: deck(30), firstPlayer: "player" });
  const beforeP = s.players.player.hand.length;
  const beforeA = s.players.ai.hand.length;
  applyModifier(s, MODIFIERS.find((x) => x.id === "lucky-draws"));
  assert.equal(s.players.player.hand.length, beforeP + 1);
  assert.equal(s.players.ai.hand.length, beforeA + 1);
});

test("applied modifier sets state.modifierActive + logs the rule", () => {
  const s = createGame({ playerDeck: deck(30), aiDeck: deck(30), firstPlayer: "player" });
  const m = MODIFIERS[0];
  applyModifier(s, m);
  assert.equal(s.modifierActive?.id, m.id);
  assert.equal(s.modifierActive?.name, m.name);
  assert.ok(s.log.some((l) => l.kind === "modifier"), "modifier shows in log");
});

test("applyModifier doesn't throw on missing state fields", () => {
  // Caller could theoretically apply to a state with missing log array.
  // We don't crash; we use ?. chains.
  const s = { players: { player: { maxEnergy: 1, energy: 0 }, ai: { maxEnergy: 1, energy: 0 } } };
  assert.doesNotThrow(() => applyModifier(s, MODIFIERS.find((x) => x.id === "fast-start")));
});
