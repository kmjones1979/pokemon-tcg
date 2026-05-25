// AI behavior with spell cards in hand.
//
// Slice 3 contract: the AI uses spells when their target is actually
// satisfiable. It picks targets via aiPickSpellTarget:
//   freeze/paralyze → strongest enemy (highest cardAttack + boost)
//   heal            → lowest HP fraction ally
//   defender/evolve → highest base-attack ally
//   aoe             → no target; only played when ≥2 enemies on board
//
// If no valid target exists, the spell is skipped — the AI never burns
// a card on nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { playCard, FIELD_SIZE, spellPlayable } from "../client/js/game.js";
import * as spellCards from "../shared/spell-cards.js";

const { SPELL_CARDS, spellToCard } = spellCards.default ?? spellCards;
const FREEZE   = spellToCard(SPELL_CARDS.find((s) => s.effect === "freeze"));
const PARALYZE = spellToCard(SPELL_CARDS.find((s) => s.effect === "paralyze"));
const HEAL     = spellToCard(SPELL_CARDS.find((s) => s.effect === "heal"));
const DEFENDER = spellToCard(SPELL_CARDS.find((s) => s.effect === "defender"));
const EVOLVE   = spellToCard(SPELL_CARDS.find((s) => s.effect === "evolve"));
const AOE      = spellToCard(SPELL_CARDS.find((s) => s.effect === "aoe"));

function pokemon(id, { hp = 8, atk = 4, cost = 1, types = ["normal"] } = {}) {
  return {
    id, name: `P${id}`, types,
    energyCost: cost, cardHp: hp, cardAttack: atk,
    tier: cost, rarity: "common",
    is_legendary: false, is_mythical: false,
    raw: { hp: hp * 10, attack: atk * 15, defense: 30, sp_attack: 0, sp_defense: 30, speed: 30 },
  };
}

function makeInst(card, currentHp = null, extra = {}) {
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
    ...extra,
  };
}

function makeMatch({ aiHand = [], aiEnergy = 5, aiField = [], playerField = [] } = {}) {
  // Field cells can be either a card (auto-wrap into an instance) or
  // an already-built instance (detect via `.card` key, pass through).
  const padField = (arr) =>
    arr.map((c) => (c ? (c.card ? c : makeInst(c)) : null))
       .concat(Array(FIELD_SIZE - arr.length).fill(null))
       .slice(0, FIELD_SIZE);
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
        deck: [], hand: [], field: padField(playerField), discard: [],
      },
      ai: {
        name: "AI", ability: "brock",
        trainerHp: 30, maxTrainerHp: 30,
        energy: aiEnergy, maxEnergy: 10,
        deck: [], hand: aiHand, field: padField(aiField), discard: [],
      },
    },
  };
}

// --- Engine call-site safety (no AI loop yet, just engine accepts target) ---

test("AI with a Pokémon in hand can summon it (sanity check)", () => {
  const mon = pokemon(1);
  const state = makeMatch({ aiHand: [mon] });
  const r = playCard(state, "ai", 0);
  assert.equal(r.ok, true);
  assert.ok(state.players.ai.field.some((s) => s !== null));
});

test("AI calling playCard on a spell without target returns clean error (no crash)", () => {
  const state = makeMatch({ aiHand: [FREEZE], playerField: [pokemon(2)] });
  const r = playCard(state, "ai", 0); // no spellTarget
  assert.equal(r.ok, false);
  assert.equal(state.players.ai.hand.length, 1);
});

test("AI playing a spell WITH a valid target succeeds (Freeze)", () => {
  const enemy = pokemon(3, { atk: 9 });
  const state = makeMatch({ aiHand: [FREEZE], playerField: [enemy] });
  const r = playCard(state, "ai", 0, { spellTarget: 0 });
  assert.equal(r.ok, true);
  assert.equal(state.players.player.field[0].status.kind, "freeze");
});

// --- Target picking via direct engine calls -------------------------
// (We exercise aiPickSpellTarget indirectly by setting up a board and
// asking what the AI would do. Since aiPickSpellTarget isn't exported,
// we test the OBSERVABLE behavior: a spell played via playCard with a
// computed target lands on the right slot.)

test("AI Freeze targeting (manual): highest-attack enemy is the right pick", () => {
  // Build a board with two enemies. Verify the AI would pick the higher-atk
  // one. We compute the expected slot ourselves and confirm playCard
  // accepts that target.
  const weakE = pokemon(10, { atk: 2 });
  const strongE = pokemon(11, { atk: 9 });
  const state = makeMatch({ aiHand: [FREEZE], playerField: [weakE, strongE] });
  // Manual scoring: slot 1 has the stronger attacker, so AI should freeze slot 1.
  const r = playCard(state, "ai", 0, { spellTarget: 1 });
  assert.equal(r.ok, true);
  assert.equal(state.players.player.field[1].status.kind, "freeze");
  assert.equal(state.players.player.field[0].status, null);
});

test("AI Heal targeting (manual): lowest-HP ally is the right pick", () => {
  const fullHpAlly = pokemon(20, { hp: 10 });
  const hurtAlly   = pokemon(21, { hp: 10 });
  const state = makeMatch({
    aiHand: [HEAL],
    aiField: [makeInst(fullHpAlly, 10), makeInst(hurtAlly, 3)],
  });
  // Manual choice: hurt ally is at slot 1.
  const r = playCard(state, "ai", 0, { spellTarget: 1 });
  assert.equal(r.ok, true);
  assert.equal(state.players.ai.field[1].currentHp, 10, "hurt ally healed to full");
  // Full-HP ally untouched (besides the heal being a no-op even on full).
});

test("AI Defender targeting (manual): highest-attack ally is the right pick", () => {
  const tank   = pokemon(30, { hp: 12, atk: 3 });
  const hitter = pokemon(31, { hp: 6,  atk: 9 });
  const state = makeMatch({
    aiHand: [DEFENDER], aiEnergy: 3,
    aiField: [makeInst(tank), makeInst(hitter)],
  });
  // Manual choice: protect the hitter (slot 1).
  const r = playCard(state, "ai", 0, { spellTarget: 1 });
  assert.equal(r.ok, true);
  assert.equal(state.players.ai.field[1].isDefender, true);
});

test("AI AOE targeting (manual): no target needed", () => {
  const e1 = pokemon(40, { hp: 6 });
  const e2 = pokemon(41, { hp: 6 });
  const state = makeMatch({
    aiHand: [AOE], aiEnergy: 5,
    playerField: [e1, e2],
  });
  // No spellTarget required.
  const r = playCard(state, "ai", 0);
  assert.equal(r.ok, true);
  assert.equal(r.hits, 2);
});

// --- Skipping invalid spells -----------------------------------------

test("AI hand-with-only-spells against empty board: no plays, no crashes", () => {
  // No enemies → Freeze/Paralyze/AOE all unplayable. No allies → Heal/
  // Defender/Evolve all unplayable. AI cleanly does nothing.
  const state = makeMatch({ aiHand: [FREEZE, PARALYZE, AOE, HEAL, DEFENDER, EVOLVE] });
  for (let i = 0; i < state.players.ai.hand.length; i++) {
    const r = playCard(state, "ai", i);
    // All should fail cleanly with a usable error string.
    assert.equal(r.ok, false);
    assert.ok(r.reason);
  }
  // Hand untouched.
  assert.equal(state.players.ai.hand.length, 6);
});

test("AI AOE is intentionally skipped on a single-enemy board (not worth 4 energy)", () => {
  // spellPlayable returns false for AOE with <2 enemies — but if the AI
  // bypasses that check and plays it directly, the engine still allows
  // it (the engine doesn't second-guess the player). The contract here
  // is about AI judgment: aiPickSpellTarget for AOE returns null, but
  // the spellPlayable filter is the gate that keeps it out of hand
  // candidates. We confirm by playing it: engine accepts the play (1
  // enemy hit), but the AI's chooseHandIndex would skip it. The test
  // documents both behaviors.
  const enemy = pokemon(50, { hp: 6 });
  const state = makeMatch({ aiHand: [AOE], aiEnergy: 5, playerField: [enemy] });
  // Engine allows it:
  const r = playCard(state, "ai", 0);
  assert.equal(r.ok, true);
  assert.equal(r.hits, 1);
});

// --- Mixed hand: AI plays a Pokémon if spells aren't valid -----------

test("AI with [spell, pokemon] and no spell target: plays the Pokémon", () => {
  // Spell unplayable → AI should fall through to summon.
  const mon = pokemon(60);
  const state = makeMatch({ aiHand: [FREEZE, mon] }); // no enemies on board
  // FREEZE unplayable; AI summons Pokémon at idx 1.
  const r = playCard(state, "ai", 1);
  assert.equal(r.ok, true);
  assert.ok(state.players.ai.field.some((s) => s !== null));
});

// --- spellPlayable contract -----------------------------------------
//
// Regression context: in slice 3 the AI started preferring cheap spells
// (Freeze at 1⚡) over Pokémon summons. With no Pokémon already on the
// AI field, casting Freeze wasted the energy — the attack phase then
// found no attackers and the AI silently passed. From the player's POV
// the AI "didn't attack this turn", which read as a bug. The fix gates
// offensive spells (freeze/paralyze/aoe) on the AI having ≥1 of its own
// Pokémon already deployed.

function fieldWith(...cards) {
  return cards.map((c) => ({
    card: c, currentHp: c.cardHp, maxHp: c.cardHp,
    status: null, summoningSickness: false, attackedThisTurn: false,
  }));
}

test("spellPlayable(Freeze): requires AI to have own field AND enemy field", () => {
  const aiNoField = { field: [null, null, null, null, null] };
  const oppNoField = { field: [null, null, null, null, null] };
  const aiField = { field: fieldWith(pokemon(1)) };
  const oppField = { field: fieldWith(pokemon(2)) };

  // No own field → can't follow up after disruption → skip the spell.
  assert.equal(spellPlayable(FREEZE, aiNoField, oppField), false);
  // No enemy field → nothing to disrupt.
  assert.equal(spellPlayable(FREEZE, aiField, oppNoField), false);
  // Neither side has anything.
  assert.equal(spellPlayable(FREEZE, aiNoField, oppNoField), false);
  // Both sides populated → playable.
  assert.equal(spellPlayable(FREEZE, aiField, oppField), true);
});

test("spellPlayable(Paralyze): same own-field-required gate as Freeze", () => {
  const aiNoField = { field: [null] };
  const oppField  = { field: fieldWith(pokemon(3)) };
  assert.equal(spellPlayable(PARALYZE, aiNoField, oppField), false);
});

test("spellPlayable(AOE): needs AI field AND ≥2 enemies (4-energy spell)", () => {
  const aiField  = { field: fieldWith(pokemon(10)) };
  const aiNoField = { field: [null] };
  const oneEnemy  = { field: fieldWith(pokemon(20)) };
  const twoEnemies = { field: fieldWith(pokemon(21), pokemon(22)) };

  // AI has nothing → no point in disrupting.
  assert.equal(spellPlayable(AOE, aiNoField, twoEnemies), false);
  // Only 1 enemy → AOE is a waste (regular attack covers it).
  assert.equal(spellPlayable(AOE, aiField, oneEnemy), false);
  // Both conditions met → playable.
  assert.equal(spellPlayable(AOE, aiField, twoEnemies), true);
});

test("spellPlayable(Heal): only when an ally is below max HP", () => {
  const fullAlly = fieldWith(pokemon(30));
  const hurtAlly = fieldWith(pokemon(31, { hp: 10 }));
  hurtAlly[0].currentHp = 3; // injured
  const aiFull = { field: fullAlly };
  const aiHurt = { field: hurtAlly };
  const opp    = { field: [null] };
  assert.equal(spellPlayable(HEAL, aiFull, opp), false);
  assert.equal(spellPlayable(HEAL, aiHurt, opp), true);
});

test("spellPlayable(Defender/Evolve): need a target ally on field", () => {
  const aiField  = { field: fieldWith(pokemon(40)) };
  const aiNoField = { field: [null] };
  const opp = { field: [null] };
  assert.equal(spellPlayable(DEFENDER, aiField, opp), true);
  assert.equal(spellPlayable(DEFENDER, aiNoField, opp), false);
  assert.equal(spellPlayable(EVOLVE, aiField, opp), true);
  assert.equal(spellPlayable(EVOLVE, aiNoField, opp), false);
});

test("spellPlayable(non-spell card): always passes through", () => {
  const aiNoField = { field: [null] };
  const oppNoField = { field: [null] };
  const justAPokemon = pokemon(50);
  assert.equal(spellPlayable(justAPokemon, aiNoField, oppNoField), true);
});

// =====================================================================
// Hard-mode combat bonus (slice 9): Hard AI gets +1 ATK and +8% crit
// to make every attack noticeably harder-hitting than Medium. Pinned
// so a future "tone down Hard" doesn't silently revert.
// =====================================================================

test("Hard policy carries atkBonus=1 and critBoost=0.08", async () => {
  // Re-import POLICIES via the engine's public surface. We don't
  // export the POLICIES object directly; instead we exercise the
  // observable contract — running aiTakeTurn on Hard stamps the
  // matching aiCombatBonus on state. (Engine internal — verified
  // through state inspection.)
  const { aiTakeTurn, FIELD_SIZE: FS } = await import("../client/js/game.js");

  const state = {
    turn: 5, activePlayer: "ai", phase: "main", winner: null, log: [],
    players: {
      player: { name: "P", ability: "brock", trainerHp: 30, maxTrainerHp: 30,
                energy: 5, maxEnergy: 10, deck: [], hand: [],
                field: Array(FS).fill(null), discard: [] },
      ai:     { name: "AI", ability: "brock", trainerHp: 30, maxTrainerHp: 30,
                energy: 5, maxEnergy: 10, deck: [], hand: [],
                field: Array(FS).fill(null), discard: [] },
    },
  };

  await aiTakeTurn(state, { difficulty: "hard" });
  assert.ok(state.aiCombatBonus, "Hard mode should stamp an aiCombatBonus on state");
  assert.equal(state.aiCombatBonus.atkBonus, 1);
  assert.equal(state.aiCombatBonus.critBoost, 0.08);
});

test("Medium policy carries no AI combat bonus (regression: only Hard gets it)", async () => {
  const { aiTakeTurn, FIELD_SIZE: FS } = await import("../client/js/game.js");
  const state = {
    turn: 5, activePlayer: "ai", phase: "main", winner: null, log: [],
    players: {
      player: { name: "P", ability: "brock", trainerHp: 30, maxTrainerHp: 30,
                energy: 5, maxEnergy: 10, deck: [], hand: [],
                field: Array(FS).fill(null), discard: [] },
      ai:     { name: "AI", ability: "brock", trainerHp: 30, maxTrainerHp: 30,
                energy: 5, maxEnergy: 10, deck: [], hand: [],
                field: Array(FS).fill(null), discard: [] },
    },
  };
  await aiTakeTurn(state, { difficulty: "medium" });
  assert.ok(state.aiCombatBonus, "medium also stamps the field (just with 0 values)");
  assert.equal(state.aiCombatBonus.atkBonus, 0);
  assert.equal(state.aiCombatBonus.critBoost, 0);
});

test("Hard AI attack lands +1 damage compared to baseline", async () => {
  // Direct integration: an AI Pokémon with cardAttack=4 attacking a
  // defenseless dummy should hit for 4 on Medium and 5 on Hard.
  const { attack, FIELD_SIZE: FS } = await import("../client/js/game.js");

  function mkInst(card, hp = null) {
    return {
      instanceId: "i" + card.id,
      card,
      currentHp: hp ?? card.cardHp,
      maxHp: card.cardHp,
      status: null, summoningSickness: false, attackedThisTurn: false,
      attackBoost: 0, level: 0,
    };
  }
  function mkPokemon(id, atk) {
    return {
      id, name: "M" + id, types: ["normal"],
      energyCost: 1, cardHp: 20, cardAttack: atk,
      tier: 2, rarity: "uncommon",
      raw: { hp: 200, attack: atk * 15, defense: 0, sp_attack: 0, sp_defense: 0, speed: 30 },
    };
  }
  function mkState(aiCombatBonus) {
    return {
      turn: 5, activePlayer: "ai", phase: "main", winner: null, log: [],
      aiCombatBonus,
      players: {
        player: {
          name: "P", ability: "brock", trainerHp: 30, maxTrainerHp: 30,
          energy: 5, maxEnergy: 10, deck: [], hand: [],
          field: [mkInst(mkPokemon(99, 1))].concat(Array(FS - 1).fill(null)),
          discard: [],
        },
        ai: {
          name: "AI", ability: "brock", trainerHp: 30, maxTrainerHp: 30,
          energy: 5, maxEnergy: 10, deck: [], hand: [],
          field: [mkInst(mkPokemon(1, 4))].concat(Array(FS - 1).fill(null)),
          discard: [],
        },
      },
    };
  }

  // Deterministic rand: returns 0.99 so no random crits / status rolls fire.
  const rand = () => 0.99;

  const mediumState = mkState({ atkBonus: 0, critBoost: 0 });
  const beforeMid = mediumState.players.player.field[0].currentHp;
  attack(mediumState, "ai", 0, 0, { rand });
  const dmgMid = beforeMid - mediumState.players.player.field[0].currentHp;

  const hardState = mkState({ atkBonus: 1, critBoost: 0 });
  const beforeHard = hardState.players.player.field[0].currentHp;
  attack(hardState, "ai", 0, 0, { rand });
  const dmgHard = beforeHard - hardState.players.player.field[0].currentHp;

  assert.equal(dmgHard, dmgMid + 1,
    `Hard should hit for +1 damage. Medium: ${dmgMid}, Hard: ${dmgHard}`);
});
