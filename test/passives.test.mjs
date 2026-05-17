// Tests for Wave 21 new signatures + expanded Guardian list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isGuardian, signatureFor, SIGNATURE_ABILITIES } from "../client/js/passives.js";

function mkCard(overrides = {}) {
  return {
    id: 1, name: "Test", types: ["normal"], tier: 1,
    energyCost: 1, cardHp: 8, cardAttack: 4,
    raw: { hp: 80, attack: 60, defense: 30, sp_attack: 60, sp_defense: 30, speed: 30 },
    abilities: [],
    ...overrides,
  };
}

function mkState() {
  return {
    log: [],
    players: {
      player: { name: "P", field: [null, null, null, null, null], discard: [], energy: 5, maxEnergy: 5 },
      ai:     { name: "A", field: [null, null, null, null, null], discard: [], energy: 5, maxEnergy: 5 },
    },
  };
}

function mkInst(card) {
  const hp = card.cardHp;
  return { card, currentHp: hp, maxHp: hp, summoningSickness: false, attackedThisTurn: false };
}

// --- isGuardian expanded list -------------------------------------------

test("legendaries are Guardians", () => {
  assert.ok(isGuardian(mkCard({ is_legendary: true })));
});

test("mythicals are Guardians", () => {
  assert.ok(isGuardian(mkCard({ is_mythical: true })));
});

test("Snorlax (#143) is a Guardian", () => {
  assert.ok(isGuardian(mkCard({ id: 143, name: "Snorlax", types: ["normal"], tier: 3 })));
});

test("Lapras (#131) is a Guardian", () => {
  assert.ok(isGuardian(mkCard({ id: 131, name: "Lapras", types: ["water"], tier: 4 })));
});

test("Shuckle (#213) is a Guardian", () => {
  assert.ok(isGuardian(mkCard({ id: 213, name: "Shuckle", types: ["bug", "rock"], tier: 3 })));
});

test("Rhyperior (#464) is a Guardian", () => {
  assert.ok(isGuardian(mkCard({ id: 464, name: "Rhyperior", types: ["ground", "rock"], tier: 4 })));
});

test("low-tier non-tank is NOT a Guardian", () => {
  assert.equal(isGuardian(mkCard({ types: ["normal"], tier: 1 })), false);
});

test("tier 3 steel WITH sturdy passive is a Guardian", () => {
  const c = mkCard({ types: ["steel"], tier: 3, abilities: ["sturdy"] });
  assert.ok(isGuardian(c));
});

test("tier 3 steel WITHOUT a tank passive is NOT a Guardian", () => {
  const c = mkCard({ types: ["steel"], tier: 3, abilities: ["levitate"] });
  assert.equal(isGuardian(c), false);
});

// --- New AOE signatures --------------------------------------------------

test("Gyarados Tsunami damages every enemy on field (scaling)", () => {
  const sig = signatureFor({ id: 130, types: ["water"] });
  assert.ok(sig, "Gyarados should have a signature");
  assert.equal(sig.name, "Tsunami");
  const state = mkState();
  // Place 3 enemies with 10 HP each.
  for (let i = 0; i < 3; i++) {
    state.players.ai.field[i] = mkInst(mkCard({ id: 100 + i, name: "Enemy" + i, cardHp: 10 }));
  }
  const gyarados = mkInst(mkCard({ id: 130, name: "Gyarados", types: ["water"] }));
  sig.onSummon(state, "player", gyarados);
  // damage = 2 + 3 = 5 per enemy
  for (let i = 0; i < 3; i++) {
    assert.equal(state.players.ai.field[i].currentHp, 5);
  }
});

test("Gyarados Tsunami knocks out low-HP enemies", () => {
  const sig = signatureFor({ id: 130 });
  const state = mkState();
  state.players.ai.field[0] = mkInst(mkCard({ id: 100, cardHp: 2 }));
  state.players.ai.field[1] = mkInst(mkCard({ id: 101, cardHp: 10 }));
  const inst = mkInst(mkCard({ id: 130, types: ["water"] }));
  sig.onSummon(state, "player", inst);
  // damage = 2 + 2 = 4 per enemy; first KO'd, second at 6
  assert.equal(state.players.ai.field[0], null);
  assert.equal(state.players.ai.field[1].currentHp, 6);
  assert.equal(state.players.ai.discard.length, 1);
});

test("Politoed Rain Storm chips enemies AND heals allies", () => {
  const sig = signatureFor({ id: 186 });
  assert.ok(sig);
  const state = mkState();
  // 2 enemies on field
  state.players.ai.field[0] = mkInst(mkCard({ id: 100, cardHp: 5 }));
  state.players.ai.field[1] = mkInst(mkCard({ id: 101, cardHp: 5 }));
  // 1 ally at half HP
  const ally = mkInst(mkCard({ id: 200 }));
  ally.maxHp = 10; ally.currentHp = 5;
  state.players.player.field[0] = ally;
  const polly = mkInst(mkCard({ id: 186 }));
  sig.onSummon(state, "player", polly);
  assert.equal(state.players.ai.field[0].currentHp, 4);
  assert.equal(state.players.ai.field[1].currentHp, 4);
  assert.equal(ally.currentHp, 6, "ally healed by 1");
});

// --- Tank signatures ----------------------------------------------------

test("Snorlax Bulwark provides flat damage reduction passive", () => {
  const sig = signatureFor({ id: 143 });
  assert.ok(sig);
  assert.equal(sig.passive?.damageReduction, 2);
});

test("Shuckle Living Fortress provides 3 damage reduction", () => {
  const sig = signatureFor({ id: 213 });
  assert.ok(sig);
  assert.equal(sig.passive?.damageReduction, 3);
});

test("Rhyperior Solid Rock resists super-effective", () => {
  const sig = signatureFor({ id: 464 });
  assert.ok(sig);
  assert.equal(sig.passive?.resistSuperEffective, true);
});

test("Lapras Frozen Wall paralyzes the attacker (does not cancel)", () => {
  const sig = signatureFor({ id: 131 });
  assert.ok(sig);
  const state = mkState();
  const lapras = mkInst(mkCard({ id: 131 }));
  const attacker = mkInst(mkCard({ id: 6, name: "Charizard" }));
  const cancelled = sig.onPreHit(state, "ai", lapras, attacker);
  assert.equal(cancelled, false, "should NOT cancel — just react");
  assert.equal(attacker.status?.kind, "paralyze");
});

test("Torterra Continent heals each ally on summon", () => {
  const sig = signatureFor({ id: 389 });
  assert.ok(sig);
  const state = mkState();
  const a1 = mkInst(mkCard({ id: 200 })); a1.maxHp = 10; a1.currentHp = 5;
  const a2 = mkInst(mkCard({ id: 201 })); a2.maxHp = 10; a2.currentHp = 6;
  state.players.player.field[0] = a1;
  state.players.player.field[1] = a2;
  const torterra = mkInst(mkCard({ id: 389 }));
  state.players.player.field[2] = torterra;
  sig.onSummon(state, "player", torterra);
  assert.equal(a1.currentHp, 7);
  assert.equal(a2.currentHp, 8);
  // Self shouldn't be healed (it's full HP anyway).
  assert.equal(torterra.currentHp, torterra.maxHp);
});

// --- Sanity: signature count grew ---------------------------------------

test("signature library has at least 30 entries after Wave 21", () => {
  const count = Object.keys(SIGNATURE_ABILITIES).length;
  assert.ok(count >= 30, `expected >= 30 signatures, got ${count}`);
});
