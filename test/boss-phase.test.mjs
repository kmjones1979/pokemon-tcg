// Tests for boss-mode phase rules + on-summon abilities (Wave 23).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGame, playCard, attack, endTurn } from "../client/js/game.js";
import { signatureFor } from "../client/js/passives.js";

function mkCard(overrides = {}) {
  return {
    id: 1, name: "Test", types: ["normal"], tier: 1,
    energyCost: 1, cardHp: 5, cardAttack: 4,
    raw: { hp: 50, attack: 60, defense: 30, sp_attack: 60, sp_defense: 30, speed: 30 },
    abilities: [],
    ...overrides,
  };
}

function mkDeck(n, override = {}) {
  return Array.from({ length: n }, (_, i) => mkCard({ id: 1000 + i, name: "C" + i, ...override }));
}

// --- Boss-mode infrastructure -------------------------------------------

test("createGame respects aiTrainerHp + aiName overrides (for boss fights)", () => {
  const state = createGame({
    playerDeck: mkDeck(30),
    aiDeck: mkDeck(30),
    aiTrainerHp: 88,
    aiName: "Mewtwo",
    firstPlayer: "player",
  });
  assert.equal(state.players.ai.trainerHp, 88);
  assert.equal(state.players.ai.maxTrainerHp, 88);
  assert.equal(state.players.ai.name, "Mewtwo");
});

test("createGame without override defaults to TRAINER_START_HP=30", () => {
  const state = createGame({
    playerDeck: mkDeck(30),
    aiDeck: mkDeck(30),
    firstPlayer: "player",
  });
  assert.equal(state.players.ai.trainerHp, 30);
  assert.equal(state.players.player.trainerHp, 30);
});

test("boss.attackBonus stacks onto AI attacks", () => {
  // Build a state where AI has a card on field ready to attack.
  const state = createGame({
    playerDeck: mkDeck(30, { cardHp: 20 }),
    aiDeck: mkDeck(30, { cardAttack: 3, cardHp: 10 }),
    aiTrainerHp: 60,
    firstPlayer: "ai",
  });
  // Manually drop an AI card onto field + clear summoning sickness.
  const aiCard = mkCard({ id: 9000, name: "Boss Card", cardAttack: 3, cardHp: 10 });
  const playerCard = mkCard({ id: 9001, name: "Tank", cardAttack: 1, cardHp: 25 });
  state.players.ai.hand = [aiCard];
  state.players.player.hand = [playerCard];
  state.players.ai.energy = 10;
  state.players.player.energy = 10;
  // Player plays a defender so the AI has to attack a card (not trainer).
  state.activePlayer = "player";
  playCard(state, "player", 0);
  state.players.player.field[0].summoningSickness = false;
  endTurn(state); // → ai turn
  // AI plays its card, but it'll have summoning sickness — bypass it.
  playCard(state, "ai", 0);
  state.players.ai.field[0].summoningSickness = false;
  // Without boss bonus first — attack as-is.
  const beforeBonus = playerCard.cardHp;
  const initialHp = state.players.player.field[0].currentHp;
  // Now slap a +5 boss attack bonus.
  state.boss = { attackBonus: 5, ignoreDefense: false, phaseRules: [], maxHp: 60 };
  const r = attack(state, "ai", 0, 0, { abilityId: "basic" });
  assert.ok(r.ok, "ai attack should succeed");
  // The +5 bonus must have flowed through to the damage.
  // baseline ai cardAttack = 3, with +5 bonus → 8 effective ATK before defense. So 7-8 damage.
  const dealt = initialHp - state.players.player.field[0].currentHp;
  assert.ok(dealt >= 5, `expected dealt >= 5, got ${dealt}`);
});

test("boss.ignoreDefense disables the defender's defense term", () => {
  const state = createGame({
    playerDeck: mkDeck(30),
    aiDeck: mkDeck(30),
    aiTrainerHp: 60,
    firstPlayer: "ai",
  });
  // Put a heavy-defense defender on the player field.
  const heavyDef = mkCard({
    id: 9100, name: "Wall", types: ["normal"], cardHp: 25,
    raw: { hp: 250, attack: 0, defense: 300, sp_defense: 300, sp_attack: 0, speed: 0 },
  });
  state.players.player.field[0] = {
    instanceId: "i1", card: heavyDef, currentHp: 25, maxHp: 25,
    summoningSickness: false, status: null,
  };
  // Stage an AI attacker on field.
  const att = mkCard({ id: 9101, name: "Hitter", cardAttack: 6 });
  state.players.ai.field[0] = {
    instanceId: "i2", card: att, currentHp: 10, maxHp: 10,
    summoningSickness: false, status: null,
  };
  state.activePlayer = "ai";
  state.phase = "main";
  state.players.ai.energy = 10;

  // Attack WITHOUT ignoreDefense — the heavy defense should soak a lot.
  const before1 = state.players.player.field[0].currentHp;
  state.boss = { attackBonus: 0, ignoreDefense: false, phaseRules: [], maxHp: 60 };
  attack(state, "ai", 0, 0, { abilityId: "basic" });
  const dmg1 = before1 - state.players.player.field[0].currentHp;
  // Restore + clear act flag for second pass.
  state.players.player.field[0].currentHp = 25;
  state.players.ai.field[0].attackedThisTurn = false;
  // Attack WITH ignoreDefense — should deal noticeably more.
  state.boss.ignoreDefense = true;
  attack(state, "ai", 0, 0, { abilityId: "basic" });
  const dmg2 = 25 - state.players.player.field[0].currentHp;
  assert.ok(dmg2 > dmg1, `ignoreDefense should boost damage: ${dmg1} → ${dmg2}`);
});

// --- New on-summon signatures (Wave 23) ---------------------------------

function emptyState() {
  return {
    log: [], turn: 1,
    players: {
      player: { name: "P", field: [null, null, null, null, null], discard: [], energy: 5, maxEnergy: 5, hand: [], deck: [] },
      ai:     { name: "A", field: [null, null, null, null, null], discard: [], energy: 5, maxEnergy: 5, hand: [], deck: [] },
    },
  };
}
function mkInst(card) { return { card, currentHp: card.cardHp, maxHp: card.cardHp, summoningSickness: false }; }

test("Chansey Soft-Boiled fully heals weakest ally", () => {
  const sig = signatureFor({ id: 113 });
  assert.ok(sig);
  const s = emptyState();
  const weak = mkInst(mkCard({ id: 1 })); weak.maxHp = 10; weak.currentHp = 2;
  const ok   = mkInst(mkCard({ id: 2 })); ok.maxHp = 10;  ok.currentHp = 8;
  s.players.player.field[0] = weak;
  s.players.player.field[1] = ok;
  const chansey = mkInst(mkCard({ id: 113 }));
  s.players.player.field[2] = chansey;
  sig.onSummon(s, "player", chansey);
  assert.equal(weak.currentHp, 10, "weakest fully healed");
  assert.equal(ok.currentHp, 8, "other ally untouched");
});

test("Clefable Moonlight heals every ally for 2", () => {
  const sig = signatureFor({ id: 36 });
  assert.ok(sig);
  const s = emptyState();
  const a = mkInst(mkCard({ id: 1 })); a.maxHp = 10; a.currentHp = 5;
  const b = mkInst(mkCard({ id: 2 })); b.maxHp = 10; b.currentHp = 6;
  s.players.player.field[0] = a;
  s.players.player.field[1] = b;
  const clef = mkInst(mkCard({ id: 36 }));
  s.players.player.field[2] = clef;
  sig.onSummon(s, "player", clef);
  assert.equal(a.currentHp, 7);
  assert.equal(b.currentHp, 8);
});

test("Alakazam Psychic targets highest-HP enemy", () => {
  const sig = signatureFor({ id: 65 });
  const s = emptyState();
  const tank = mkInst(mkCard({ id: 1, cardHp: 20 })); tank.currentHp = 18;
  const chip = mkInst(mkCard({ id: 2, cardHp: 5 }));
  s.players.ai.field[0] = tank;
  s.players.ai.field[1] = chip;
  const alak = mkInst(mkCard({ id: 65 }));
  sig.onSummon(s, "player", alak);
  assert.equal(tank.currentHp, 14, "tank took 4 (was highest)");
  assert.equal(chip.currentHp, 5, "chip untouched");
});

test("Jynx Lovely Kiss applies sleep status", () => {
  const sig = signatureFor({ id: 124 });
  const s = emptyState();
  s.players.ai.field[0] = mkInst(mkCard({ id: 1 }));
  const jynx = mkInst(mkCard({ id: 124 }));
  sig.onSummon(s, "player", jynx);
  assert.equal(s.players.ai.field[0].status?.kind, "sleep");
});

test("Rapidash Flame Charge grants +2 ATK to a random ally", () => {
  const sig = signatureFor({ id: 78 });
  const s = emptyState();
  const ally = mkInst(mkCard({ id: 1 }));
  s.players.player.field[0] = ally;
  const rapid = mkInst(mkCard({ id: 78 }));
  s.players.player.field[1] = rapid;
  sig.onSummon(s, "player", rapid);
  assert.equal(ally.attackBoost, 2);
});

test("Gengar Hex applies a 2-turn curse (burn-style tick)", () => {
  const sig = signatureFor({ id: 94 });
  const s = emptyState();
  s.players.ai.field[0] = mkInst(mkCard({ id: 1 }));
  const gengar = mkInst(mkCard({ id: 94 }));
  sig.onSummon(s, "player", gengar);
  assert.equal(s.players.ai.field[0].status?.kind, "burn");
  assert.equal(s.players.ai.field[0].status?.turnsLeft, 2);
});
