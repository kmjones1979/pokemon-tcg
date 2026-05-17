// Exhaustive signature-ability coverage. We assert every signature in
// the catalog has a coherent shape (name + desc + at least one hook),
// and exercise the recently-added ones end-to-end through their hook
// surface.
//
// Note: signatures that mutate engine state are covered via the
// existing test/passives.test.mjs + test/boss-phase.test.mjs. This
// file fills coverage gaps for the rest of the catalog.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SIGNATURE_ABILITIES, signatureFor, isGuardian } from "../client/js/passives.js";

const ENTRIES = Object.entries(SIGNATURE_ABILITIES);

function mkCard(id, types = ["normal"]) {
  return {
    id, name: "C" + id, types,
    cardHp: 8, cardAttack: 5,
    raw: { hp: 80, attack: 60, defense: 30, sp_attack: 60, sp_defense: 30, speed: 30 },
    abilities: [],
  };
}
function mkInst(card) {
  return {
    card, currentHp: card.cardHp, maxHp: card.cardHp,
    summoningSickness: false, attackedThisTurn: false, status: null,
  };
}
function mkState() {
  return {
    log: [], turn: 1,
    players: {
      player: { name: "P", field: [null, null, null, null, null], discard: [], energy: 5, maxEnergy: 5, hand: [], deck: [] },
      ai:     { name: "A", field: [null, null, null, null, null], discard: [], energy: 5, maxEnergy: 5, hand: [], deck: [] },
    },
  };
}

// --- Catalog shape ---------------------------------------------------

test("every signature has a name + desc", () => {
  for (const [id, sig] of ENTRIES) {
    assert.ok(typeof sig.name === "string" && sig.name.length, `#${id} name`);
    assert.ok(typeof sig.desc === "string" && sig.desc.length, `#${id} desc`);
  }
});

test("every signature exposes at least one hook or passive/aura", () => {
  for (const [id, sig] of ENTRIES) {
    const hookKeys = ["onSummon", "onTurnStart", "onKO", "onKill", "onPreHit", "passive", "fieldAura"];
    const hasOne = hookKeys.some((k) => sig[k] != null);
    assert.ok(hasOne, `#${id} (${sig.name}) must declare at least one hook`);
  }
});

test("hook fns (onSummon/onTurnStart/onKill/onKO/onPreHit) are functions when present", () => {
  for (const [id, sig] of ENTRIES) {
    for (const k of ["onSummon", "onTurnStart", "onKill", "onKO", "onPreHit"]) {
      if (sig[k] != null) {
        assert.equal(typeof sig[k], "function", `#${id}.${k} should be a function`);
      }
    }
  }
});

test("passive descriptors have known keys", () => {
  const allowed = new Set([
    "damageReduction", "multiscale", "critBonus",
    "ignoreDefense", "ignoreDefenseSpecial", "resistSuperEffective",
  ]);
  for (const [id, sig] of ENTRIES) {
    if (!sig.passive) continue;
    for (const k of Object.keys(sig.passive)) {
      assert.ok(allowed.has(k), `#${id}.passive has unknown key '${k}'`);
    }
  }
});

test("fieldAura descriptors have known keys", () => {
  const allowed = new Set([
    "type", "attackBonus", "statusOnHit",
    "enemyType", "attackPenalty",
    "specialCostMod",
  ]);
  for (const [id, sig] of ENTRIES) {
    if (!sig.fieldAura) continue;
    for (const k of Object.keys(sig.fieldAura)) {
      assert.ok(allowed.has(k), `#${id}.fieldAura has unknown key '${k}'`);
    }
  }
});

// --- Recently added (Wave 30d) coverage -----------------------------

test("#149 Dragonite Outrage bumps attackBoost +1 on turn start", () => {
  const sig = signatureFor({ id: 149 });
  assert.ok(sig);
  const inst = mkInst(mkCard(149));
  sig.onTurnStart(mkState(), "player", inst);
  assert.equal(inst.attackBoost, 1);
  sig.onTurnStart(mkState(), "player", inst);
  assert.equal(inst.attackBoost, 2, "should stack each turn");
});

test("#208 Steelix passive damage reduction is exactly 1", () => {
  const sig = signatureFor({ id: 208 });
  assert.equal(sig?.passive?.damageReduction, 1);
});

test("#254 Sceptile field aura buffs Grass type with burn-on-hit", () => {
  const sig = signatureFor({ id: 254 });
  assert.equal(sig?.fieldAura?.type, "grass");
  assert.equal(sig?.fieldAura?.attackBonus, 1);
  assert.equal(sig?.fieldAura?.statusOnHit, "burn");
});

test("#468 Togekiss Fairy Wind heals Fairy/Flying/Normal allies, not others", () => {
  const sig = signatureFor({ id: 468 });
  assert.ok(sig);
  const s = mkState();
  const fairy  = mkInst(mkCard(700, ["fairy"]));   fairy.maxHp = 10; fairy.currentHp = 5;
  const flying = mkInst(mkCard(701, ["flying"]));  flying.maxHp = 10; flying.currentHp = 5;
  const normal = mkInst(mkCard(702, ["normal"]));  normal.maxHp = 10; normal.currentHp = 5;
  const water  = mkInst(mkCard(703, ["water"]));   water.maxHp = 10;  water.currentHp = 5;
  s.players.player.field[0] = fairy;
  s.players.player.field[1] = flying;
  s.players.player.field[2] = normal;
  s.players.player.field[3] = water;
  const togekiss = mkInst(mkCard(468));
  s.players.player.field[4] = togekiss;
  sig.onSummon(s, "player", togekiss);
  assert.equal(fairy.currentHp,  8, "fairy ally healed +3");
  assert.equal(flying.currentHp, 8, "flying ally healed +3");
  assert.equal(normal.currentHp, 8, "normal ally healed +3");
  assert.equal(water.currentHp,  5, "water NOT healed by Fairy Wind");
});

test("#571 Zoroark Illusion absorbs ~1/3 of strongest enemy's ATK", () => {
  const sig = signatureFor({ id: 571 });
  assert.ok(sig);
  const s = mkState();
  s.players.ai.field[0] = mkInst({ ...mkCard(1), cardAttack: 9 });
  s.players.ai.field[1] = mkInst({ ...mkCard(2), cardAttack: 6 });
  const zoroark = mkInst(mkCard(571));
  sig.onSummon(s, "player", zoroark);
  // round(9/3) = 3 → +3 ATK
  assert.equal(zoroark.attackBoost, 3);
});

test("#609 Chandelure Soul Drain heals + buffs strongest ally on KO", () => {
  const sig = signatureFor({ id: 609 });
  assert.ok(sig);
  const s = mkState();
  const chandelure = mkInst(mkCard(609));
  chandelure.currentHp = 4; chandelure.maxHp = 10;
  const a1 = mkInst({ ...mkCard(50), cardAttack: 4 });
  const a2 = mkInst({ ...mkCard(51), cardAttack: 8 }); // strongest
  s.players.player.field[0] = chandelure;
  s.players.player.field[1] = a1;
  s.players.player.field[2] = a2;
  sig.onKill(s, "player", chandelure);
  assert.equal(chandelure.currentHp, 7, "Chandelure heals 3 HP");
  assert.equal(a2.attackBoost, 1, "strongest ally gets +1 ATK");
  assert.equal(a1.attackBoost ?? 0, 0, "weaker ally untouched");
});

// --- isGuardian sanity (regressed before, doubly tested) -------------

test("isGuardian on null/undefined returns false (no crash)", () => {
  assert.equal(isGuardian(null), false);
  assert.equal(isGuardian(undefined), false);
});
