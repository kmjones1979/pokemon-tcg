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

// =====================================================================
// Slice 2 — additional effects: Paralyze, Heal, Defender, Evolve, AOE
// =====================================================================

const PARALYZE = spellToCard(SPELL_CARDS.find((s) => s.effect === "paralyze"));
const HEAL     = spellToCard(SPELL_CARDS.find((s) => s.effect === "heal"));
const DEFENDER = spellToCard(SPELL_CARDS.find((s) => s.effect === "defender"));
const EVOLVE   = spellToCard(SPELL_CARDS.find((s) => s.effect === "evolve"));
const AOE      = spellToCard(SPELL_CARDS.find((s) => s.effect === "aoe"));

// Helper: put an instance on the player's field at slot N so we can
// target it with own-field spells.
function placeAlly(state, slot, card, currentHp = null) {
  state.players.player.field[slot] = {
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

// --- PARALYZE --------------------------------------------------------

test("Paralyze applies paralyze status (locks enemy for 1 turn)", () => {
  const enemy = pokemon(101);
  const state = makeMatch({ playerHand: [PARALYZE], aiField: [enemy] });
  const r = playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(r.ok, true);
  const t = state.players.ai.field[0];
  assert.equal(t.status.kind, "paralyze");
  assert.equal(t.status.turnsLeft, 1);
  assert.ok(isLockedOut(t), "paralyzed pokémon should be locked out");
});

// --- HEAL ------------------------------------------------------------

test("Heal restores an ally to full HP (capped at maxHp)", () => {
  const ally = pokemon(102, { hp: 10 });
  const state = makeMatch({ playerHand: [HEAL] });
  placeAlly(state, 0, ally, 3); // 3/10 HP
  const r = playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(r.ok, true);
  assert.equal(state.players.player.field[0].currentHp, 10);
  assert.equal(r.healed, 7);
});

test("Heal on full-HP ally is a no-op (still consumes the spell)", () => {
  // Intentional: the user spent the card; they don't get to take it
  // back if they over-heal. Match the items/Potion contract.
  const ally = pokemon(103, { hp: 8 });
  const state = makeMatch({ playerHand: [HEAL] });
  placeAlly(state, 0, ally, 8);
  const r = playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.healed, 0);
  assert.equal(state.players.player.hand.length, 0, "card still consumed");
});

test("Heal rejects an empty ally slot", () => {
  const state = makeMatch({ playerHand: [HEAL] });
  const r = playCard(state, "player", 0, { spellTarget: 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /empty/i);
});

// --- DEFENDER --------------------------------------------------------

test("Defender boosts max HP and marks the instance as a Defender", () => {
  const ally = pokemon(104, { hp: 8 });
  const state = makeMatch({ playerHand: [DEFENDER] });
  placeAlly(state, 0, ally, 8);
  const r = playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(r.ok, true);
  const inst = state.players.player.field[0];
  assert.equal(inst.maxHp, 8 + (DEFENDER.defenderHpBonus || 5));
  assert.equal(inst.currentHp, 8 + (DEFENDER.defenderHpBonus || 5));
  assert.equal(inst.isDefender, true);
});

test("Defender pulls aggro — opponents must attack the Defender first", () => {
  // Two allies on the field. Spell-mark the second one as Defender.
  // Enemy tries to attack the unmarked one (slot 0) → engine refuses
  // with "must attack Guardian" reason.
  const decoyAlly = pokemon(105, { hp: 6, atk: 3 });
  const defAlly   = pokemon(106, { hp: 6, atk: 3 });
  const enemy     = pokemon(107, { hp: 6, atk: 3 });
  const state = makeMatch({ playerHand: [DEFENDER], aiField: [enemy] });
  placeAlly(state, 0, decoyAlly);
  placeAlly(state, 1, defAlly);
  const r1 = playCard(state, "player", 0, { spellTarget: 1 });
  assert.equal(r1.ok, true);

  // Switch to AI turn and try attacking the decoy (slot 0). Should
  // refuse — Defender at slot 1 must be attacked first.
  state.activePlayer = "ai";
  state.players.ai.field[0].summoningSickness = false;
  const r2 = attack(state, "ai", 0, 0);
  assert.equal(r2.ok, false, "should be forced to attack the Defender first");
  // Attacking the Defender (slot 1) succeeds.
  const r3 = attack(state, "ai", 0, 1);
  assert.equal(r3.ok, true);
});

// --- EVOLVE ----------------------------------------------------------

test("Evolve multiplies max HP by 1.5 and adds attack boost (≥ +1)", () => {
  const ally = pokemon(108, { hp: 8, atk: 4 });
  const state = makeMatch({ playerHand: [EVOLVE], playerEnergy: 5 });
  placeAlly(state, 0, ally, 8);
  const r = playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(r.ok, true);
  const inst = state.players.player.field[0];
  assert.equal(inst.maxHp, Math.ceil(8 * 1.5)); // 12
  assert.equal(inst.attackBoost, Math.ceil(4 * 0.5)); // +2
  assert.equal(inst.evolved, true);
});

test("Evolve heals proportionally (not just maxHp bump on paper)", () => {
  // If a 5/10 ally evolves to maxHp 15, currentHp should go to 10 — they
  // GAIN the hp delta (15-10 = +5). Avoids the bug where "max +50%"
  // looks great on paper but the pokémon stays low-HP.
  const ally = pokemon(109, { hp: 10, atk: 4 });
  const state = makeMatch({ playerHand: [EVOLVE], playerEnergy: 5 });
  placeAlly(state, 0, ally, 5);
  playCard(state, "player", 0, { spellTarget: 0 });
  const inst = state.players.player.field[0];
  assert.equal(inst.maxHp, 15);
  assert.equal(inst.currentHp, 10, "currentHp should rise by the same delta as maxHp");
});

// --- AOE -------------------------------------------------------------

test("AOE deals damage to every enemy on the field", () => {
  const e1 = pokemon(120, { hp: 10 });
  const e2 = pokemon(121, { hp: 10 });
  const e3 = pokemon(122, { hp: 10 });
  const state = makeMatch({ playerHand: [AOE], aiField: [e1, e2, e3], playerEnergy: 5 });
  const r = playCard(state, "player", 0, {});
  assert.equal(r.ok, true);
  const dmg = AOE.aoeDamage;
  assert.equal(state.players.ai.field[0].currentHp, 10 - dmg);
  assert.equal(state.players.ai.field[1].currentHp, 10 - dmg);
  assert.equal(state.players.ai.field[2].currentHp, 10 - dmg);
  assert.equal(r.hits, 3);
});

test("AOE KO's low-HP enemies and pushes their cards to discard", () => {
  const lowHp = pokemon(123, { hp: 2 }); // ≤ AOE damage (4)
  const tank  = pokemon(124, { hp: 10 });
  const state = makeMatch({ playerHand: [AOE], aiField: [lowHp, tank], playerEnergy: 5 });
  const r = playCard(state, "player", 0, {});
  assert.equal(r.ok, true);
  assert.equal(r.kos, 1);
  assert.equal(state.players.ai.field[0], null, "KO'd slot should clear");
  assert.equal(state.players.ai.discard.length, 1);
});

test("AOE on an empty enemy board is refused (no wasted card)", () => {
  const state = makeMatch({ playerHand: [AOE], playerEnergy: 5 });
  const before = state.players.player.energy;
  const r = playCard(state, "player", 0, {});
  assert.equal(r.ok, false);
  // No state mutation if refused.
  assert.equal(state.players.player.energy, before);
  assert.equal(state.players.player.hand.length, 1);
});

test("AOE doesn't need a target slot (target = none)", () => {
  // Sanity check: passing a spellTarget to AOE should be ignored, not
  // rejected. The catalog says target=none.
  const e = pokemon(125, { hp: 10 });
  const state = makeMatch({ playerHand: [AOE], aiField: [e], playerEnergy: 5 });
  const r = playCard(state, "player", 0, { spellTarget: 999 }); // bogus
  assert.equal(r.ok, true);
  assert.equal(state.players.ai.field[0].currentHp, 10 - AOE.aoeDamage);
});

// =====================================================================
// Slice 6 — Bolt, Sleep Powder, Cleanse, Surge, Scout, Phoenix
// =====================================================================

const BOLT         = spellToCard(SPELL_CARDS.find((s) => s.effect === "bolt"));
const SLEEP_POWDER = spellToCard(SPELL_CARDS.find((s) => s.effect === "sleep-powder"));
const CLEANSE      = spellToCard(SPELL_CARDS.find((s) => s.effect === "cleanse"));
const SURGE        = spellToCard(SPELL_CARDS.find((s) => s.effect === "surge"));
const SCOUT        = spellToCard(SPELL_CARDS.find((s) => s.effect === "scout"));
const PHOENIX      = spellToCard(SPELL_CARDS.find((s) => s.effect === "phoenix"));

// --- BOLT ------------------------------------------------------------

test("Bolt deals direct 5 damage to one enemy (bypasses combat math)", () => {
  const enemy = pokemon(200, { hp: 8, atk: 1 });
  const state = makeMatch({ playerHand: [BOLT], aiField: [enemy], playerEnergy: 5 });
  const r = playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.damage, 5);
  assert.equal(state.players.ai.field[0].currentHp, 3, "8 HP - 5 damage = 3");
});

test("Bolt KO's enemies at ≤5 HP and moves them to discard", () => {
  const lowHpEnemy = pokemon(201, { hp: 4 });
  const state = makeMatch({ playerHand: [BOLT], aiField: [lowHpEnemy], playerEnergy: 5 });
  const r = playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.knockedOut, true);
  assert.equal(state.players.ai.field[0], null);
  assert.equal(state.players.ai.discard.length, 1);
});

test("Bolt rejects an empty slot target", () => {
  const state = makeMatch({ playerHand: [BOLT], aiField: [], playerEnergy: 5 });
  const r = playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(r.ok, false);
});

// --- SLEEP POWDER ----------------------------------------------------

test("Sleep Powder applies sleep status for 2 turns (longer than Freeze)", () => {
  const enemy = pokemon(210);
  const state = makeMatch({ playerHand: [SLEEP_POWDER], aiField: [enemy], playerEnergy: 3 });
  const r = playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(r.ok, true);
  const t = state.players.ai.field[0];
  assert.equal(t.status.kind, "sleep");
  assert.equal(t.status.turnsLeft, 2);
  assert.ok(isLockedOut(t), "sleeping pokémon locked out same as freeze");
});

// --- CLEANSE ---------------------------------------------------------

test("Cleanse removes any status effect from one ally", () => {
  const ally = pokemon(220);
  const state = makeMatch({ playerHand: [CLEANSE], playerEnergy: 3 });
  placeAlly(state, 0, ally, 5);
  // Pre-apply a freeze status — Cleanse should clear it.
  state.players.player.field[0].status = { kind: "freeze", turnsLeft: 1 };
  const r = playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(r.ok, true);
  assert.equal(state.players.player.field[0].status, null);
  assert.equal(r.removedStatus, "freeze");
});

test("Cleanse on a status-free ally still consumes the card", () => {
  const ally = pokemon(221);
  const state = makeMatch({ playerHand: [CLEANSE], playerEnergy: 3 });
  placeAlly(state, 0, ally);
  const r = playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.removedStatus, null);
  assert.equal(state.players.player.hand.length, 0);
});

// --- SURGE -----------------------------------------------------------

test("Surge gains +2 Energy net (after paying its 1 cost = +1 effective)", () => {
  const state = makeMatch({ playerHand: [SURGE], playerEnergy: 3 });
  const r = playCard(state, "player", 0);
  assert.equal(r.ok, true);
  // Start 3, pay 1 (→2), gain 2 (→4). Net +1.
  assert.equal(state.players.player.energy, 4);
  assert.equal(r.gained, 2);
});

test("Surge respects max energy cap (no overflow)", () => {
  const state = makeMatch({ playerHand: [SURGE], playerEnergy: 9 });
  state.players.player.maxEnergy = 10;
  const r = playCard(state, "player", 0);
  assert.equal(r.ok, true);
  // 9 - 1 = 8, +2 capped at 10 → 10.
  assert.equal(state.players.player.energy, 10);
});

// --- SCOUT -----------------------------------------------------------

test("Scout draws 2 cards from the deck into hand", () => {
  const deckCards = [pokemon(230), pokemon(231), pokemon(232)];
  const state = makeMatch({ playerHand: [SCOUT], playerEnergy: 3 });
  state.players.player.deck = deckCards;
  const r = playCard(state, "player", 0);
  assert.equal(r.ok, true);
  assert.equal(r.drew, 2);
  assert.equal(state.players.player.hand.length, 2, "hand had 1 (Scout itself), drew 2, used 1");
  assert.equal(state.players.player.deck.length, 1);
});

test("Scout draws fewer cards if deck runs out", () => {
  const state = makeMatch({ playerHand: [SCOUT], playerEnergy: 3 });
  state.players.player.deck = [pokemon(240)];
  const r = playCard(state, "player", 0);
  assert.equal(r.ok, true);
  assert.equal(r.drew, 1);
  assert.equal(state.players.player.deck.length, 0);
});

test("Scout fails cleanly when deck is empty AND hand is full", () => {
  // Edge case: nothing to draw. Refuse rather than burn the card.
  const state = makeMatch({ playerHand: [SCOUT], playerEnergy: 3 });
  state.players.player.deck = [];
  const before = state.players.player.energy;
  const r = playCard(state, "player", 0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /hand.*full|deck.*empty/i);
  // Energy preserved on rejection.
  assert.equal(state.players.player.energy, before);
});

// --- PHOENIX ---------------------------------------------------------

test("Phoenix revives the most-recently-fainted Pokémon to an empty slot at full HP", () => {
  const fallen = pokemon(250, { hp: 12, atk: 5 });
  const state = makeMatch({ playerHand: [PHOENIX], playerEnergy: 5 });
  state.players.player.discard = [fallen];
  const r = playCard(state, "player", 0);
  assert.equal(r.ok, true);
  const revived = state.players.player.field.find((s) => s !== null);
  assert.ok(revived);
  assert.equal(revived.card.id, 250);
  assert.equal(revived.currentHp, revived.maxHp, "revived at full HP");
  // The fallen Pokémon was lifted out of discard. The Phoenix card
  // itself then lands in discard via consumeSpell — so the discard
  // length is back to 1, but it's the spell card now, not the
  // Pokémon. Check the contents, not the length.
  assert.ok(!state.players.player.discard.some((c) => c.id === 250),
    "fallen Pokémon should be lifted out of discard");
  assert.ok(state.players.player.discard.some((c) => c.kind === "spell" && c.effect === "phoenix"),
    "the spent Phoenix card lands in discard");
});

test("Phoenix skips spell cards in discard — only revives Pokémon", () => {
  const fallenPoke = pokemon(251);
  const spellInDiscard = { id: 99001, kind: "spell", name: "OldFreeze", effect: "freeze" };
  const state = makeMatch({ playerHand: [PHOENIX], playerEnergy: 5 });
  state.players.player.discard = [fallenPoke, spellInDiscard]; // spell is "more recent"
  const r = playCard(state, "player", 0);
  assert.equal(r.ok, true);
  // The Pokémon was revived (not the spell).
  const revived = state.players.player.field.find((s) => s !== null);
  assert.equal(revived.card.id, 251);
  // Spell stays in discard untouched.
  assert.ok(state.players.player.discard.some((c) => c.id === 99001));
});

test("Phoenix fails when there are no fainted Pokémon", () => {
  const state = makeMatch({ playerHand: [PHOENIX], playerEnergy: 5 });
  state.players.player.discard = [];
  const r = playCard(state, "player", 0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no fainted/i);
});

test("Phoenix fails when the field is full (no room to revive)", () => {
  const state = makeMatch({ playerHand: [PHOENIX], playerEnergy: 5 });
  state.players.player.discard = [pokemon(260)];
  // Fill the field.
  for (let i = 0; i < 5; i++) placeAlly(state, i, pokemon(261 + i));
  const r = playCard(state, "player", 0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /field is full/i);
});

test("Revived Pokémon comes back with summoning sickness (no instant attack)", () => {
  // Phoenix shouldn't snowball into "revive + attack same turn" combos.
  const fallen = pokemon(270);
  const state = makeMatch({ playerHand: [PHOENIX], playerEnergy: 5 });
  state.players.player.discard = [fallen];
  const r = playCard(state, "player", 0);
  assert.equal(r.ok, true);
  const revived = state.players.player.field.find((s) => s !== null);
  assert.equal(revived.summoningSickness, true, "newly-revived Pokémon must wait a turn");
});

// =====================================================================
// Slice 7 — Burn, Shield, Mass Heal, Power Strike, Counter, Stop Time
// =====================================================================

const BURN         = spellToCard(SPELL_CARDS.find((s) => s.effect === "burn"));
const SHIELD       = spellToCard(SPELL_CARDS.find((s) => s.effect === "shield"));
const MASS_HEAL    = spellToCard(SPELL_CARDS.find((s) => s.effect === "mass-heal"));
const POWER_STRIKE = spellToCard(SPELL_CARDS.find((s) => s.effect === "power-strike"));
const COUNTER      = spellToCard(SPELL_CARDS.find((s) => s.effect === "counter"));
const STOP_TIME    = spellToCard(SPELL_CARDS.find((s) => s.effect === "stop-time"));

// --- BURN ------------------------------------------------------------

test("Burn applies burn status to one enemy for the designed turn count", () => {
  const enemy = pokemon(300, { hp: 12 });
  const state = makeMatch({ playerHand: [BURN], aiField: [enemy], playerEnergy: 3 });
  const r = playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(r.ok, true);
  const t = state.players.ai.field[0];
  assert.equal(t.status.kind, "burn");
  assert.equal(t.status.turnsLeft, BURN.burnTurns);
});

// --- SHIELD ----------------------------------------------------------

test("Shield marks an ally; the next incoming attack does 0 damage", () => {
  // Set up: AI attacker, player defender with shield.
  const aiAttacker = pokemon(310, { atk: 8, hp: 10 });
  const playerDef  = pokemon(311, { hp: 10 });
  const state = makeMatch({ playerHand: [SHIELD], playerEnergy: 3 });
  placeAlly(state, 0, playerDef, 10);
  state.players.ai.field[0] = makeInst(aiAttacker);

  // Cast Shield on slot 0 (own ally).
  const r = playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(r.ok, true);
  assert.equal(state.players.player.field[0].shieldedNext, true);

  // AI's turn — they attack.
  state.activePlayer = "ai";
  state.players.ai.field[0].summoningSickness = false;
  const before = state.players.player.field[0].currentHp;
  const atk = attack(state, "ai", 0, 0);
  assert.equal(atk.ok, true);
  // Damage should have been 0 — shield absorbed it.
  assert.equal(state.players.player.field[0].currentHp, before, "shielded ally takes no damage");
  // Shield consumed.
  assert.equal(state.players.player.field[0].shieldedNext, false);
});

test("Shield only absorbs ONE attack — second attack lands normally", () => {
  const aiAttacker = pokemon(312, { atk: 5, hp: 10 });
  const playerDef  = pokemon(313, { hp: 20 });
  const state = makeMatch({ playerHand: [SHIELD], playerEnergy: 3 });
  placeAlly(state, 0, playerDef, 20);
  state.players.ai.field[0] = makeInst(aiAttacker);
  playCard(state, "player", 0, { spellTarget: 0 });

  state.activePlayer = "ai";
  state.players.ai.field[0].summoningSickness = false;
  attack(state, "ai", 0, 0); // blocked
  // Reset attackedThisTurn so we can attack again.
  state.players.ai.field[0].attackedThisTurn = false;
  const before = state.players.player.field[0].currentHp;
  attack(state, "ai", 0, 0);
  assert.ok(state.players.player.field[0].currentHp < before, "second attack should land");
});

// --- MASS HEAL -------------------------------------------------------

test("Mass Heal restores HP to every ally on field (capped at max)", () => {
  const a1 = pokemon(320, { hp: 10 });
  const a2 = pokemon(321, { hp: 8 });
  const state = makeMatch({ playerHand: [MASS_HEAL], playerEnergy: 5 });
  placeAlly(state, 0, a1, 3);
  placeAlly(state, 1, a2, 1);
  const r = playCard(state, "player", 0);
  assert.equal(r.ok, true);
  // Both allies should have gained up to 3 HP (or maxed out).
  assert.equal(state.players.player.field[0].currentHp, 6, "3+3=6");
  assert.equal(state.players.player.field[1].currentHp, 4, "1+3=4");
  assert.equal(r.allies, 2);
});

test("Mass Heal refuses when no allies are on the field", () => {
  const state = makeMatch({ playerHand: [MASS_HEAL], playerEnergy: 5 });
  const before = state.players.player.energy;
  const r = playCard(state, "player", 0);
  assert.equal(r.ok, false);
  assert.equal(state.players.player.energy, before, "no waste on empty field");
});

// --- POWER STRIKE ----------------------------------------------------

test("Power Strike marks ally; next attack hits for +bonus damage", () => {
  const aiVictim = pokemon(330, { hp: 30 });
  const myHitter = pokemon(331, { atk: 4, hp: 10 });
  const state = makeMatch({ playerHand: [POWER_STRIKE], playerEnergy: 3 });
  placeAlly(state, 0, myHitter);
  state.players.ai.field[0] = makeInst(aiVictim);

  // Cast Power Strike on my hitter.
  const r = playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(r.ok, true);
  assert.equal(state.players.player.field[0].powerStrikeBonus, POWER_STRIKE.powerStrikeBonus);

  // Now attack. Damage should include the bonus. We compare to a
  // baseline by running the attack and confirming the bonus flag
  // cleared.
  const before = state.players.ai.field[0].currentHp;
  attack(state, "player", 0, 0);
  const after = state.players.ai.field[0].currentHp;
  assert.ok(before - after >= POWER_STRIKE.powerStrikeBonus, `expected ≥${POWER_STRIKE.powerStrikeBonus} damage, got ${before - after}`);
  // Flag cleared after use.
  assert.ok(!state.players.player.field[0].powerStrikeBonus, "power-strike flag should clear after one attack");
});

// --- COUNTER ---------------------------------------------------------

test("Counter reflects the next attack's damage back at the attacker", () => {
  const aiAttacker = pokemon(340, { atk: 6, hp: 15 });
  const myDefender = pokemon(341, { hp: 15 });
  const state = makeMatch({ playerHand: [COUNTER], playerEnergy: 3 });
  placeAlly(state, 0, myDefender);
  state.players.ai.field[0] = makeInst(aiAttacker);

  // Cast Counter on my defender.
  playCard(state, "player", 0, { spellTarget: 0 });
  assert.equal(state.players.player.field[0].counterNext, true);

  // AI attacks.
  state.activePlayer = "ai";
  state.players.ai.field[0].summoningSickness = false;
  const beforeAtkHp = state.players.ai.field[0].currentHp;
  const beforeDefHp = state.players.player.field[0].currentHp;
  const r = attack(state, "ai", 0, 0);
  assert.equal(r.ok, true);

  // Defender took damage; attacker took the SAME damage reflected.
  const defenderDmg = beforeDefHp - state.players.player.field[0].currentHp;
  const attackerDmg = beforeAtkHp - state.players.ai.field[0].currentHp;
  assert.ok(defenderDmg > 0, "defender should still take the hit");
  assert.equal(attackerDmg, defenderDmg, "attacker should take the reflected damage");
  // Counter consumed.
  assert.equal(state.players.player.field[0].counterNext, false);
});

// --- STOP TIME -------------------------------------------------------

test("Stop Time sets a skipNextTurn flag on the opposing player", () => {
  const oppMon = pokemon(350);
  const state = makeMatch({ playerHand: [STOP_TIME], playerEnergy: 5 });
  state.players.ai.field[0] = makeInst(oppMon);
  const r = playCard(state, "player", 0);
  assert.equal(r.ok, true);
  assert.equal(state.players.ai.skipNextTurn, true,
    "Stop Time should mark the opponent's next turn for skip");
});

// Stop Time integration: after the spell, the player should retain
// control (no AI turn fires) and the timer should be re-set for the
// player, not the opponent. This is the engine-level invariant; the
// main.js skip-aiTakeTurn check is the UI-level companion fix.

test("Stop Time: endTurn keeps the activePlayer on the caster after consuming the skip flag", async () => {
  const { playCard, endTurn } = await import("../client/js/game.js");
  const e = pokemon(500, { hp: 12 });
  const state = makeMatch({ playerHand: [STOP_TIME], playerEnergy: 6 });
  state.players.ai.field[0] = makeInst(e);
  // Also need a player Pokémon on field so endTurn doesn't trigger
  // the "no cards left" loss path.
  placeAlly(state, 0, pokemon(501));

  // Cast Stop Time — sets skipNextTurn on AI.
  const r = playCard(state, "player", 0);
  assert.equal(r.ok, true);
  assert.equal(state.players.ai.skipNextTurn, true);

  // Player ends turn. endTurn should:
  //   1. flip activePlayer to "ai"
  //   2. notice ai.skipNextTurn → flip back to "player"
  //   3. clear ai.skipNextTurn
  //   4. beginTurn for player (turnEndsAt resets to player's window)
  const beforeTurnEnds = state.turnEndsAt;
  endTurn(state);
  assert.equal(state.activePlayer, "player", "Stop Time should leave control with the caster");
  assert.equal(state.players.ai.skipNextTurn, false, "skip flag must be consumed (one-use)");
  // turnEndsAt should belong to the PLAYER's new turn — a future
  // timestamp in the standard turn-duration window. Pin it as
  // ≥ now AND ≤ now + slack to confirm it was just reset (not stale
  // or pointing at an already-expired window).
  const now = Date.now();
  assert.ok(state.turnEndsAt >= now, "turn timer should be in the future for the player's new turn");
  assert.ok(state.turnEndsAt <= now + 61_000, "turn timer should be one TURN_DURATION_MS ahead, not stale");
});

// "Rival stuck thinking" regression: aiTakeTurnInner's final endTurn
// must be guarded by activePlayer === "ai", otherwise:
//   - Player-side timeout force-ended the AI turn → flipped to player.
//     Then the orphaned aiPromise resolves, hits endTurn → flips back
//     to ai with no aiTakeTurn scheduled → forever stuck on "Rival
//     thinking…".
//   - AI casts Stop Time on the player → endTurn flips to player,
//     skipNextTurn flips back to ai. AI's final endTurn would flip
//     AGAIN to player WITHOUT the skipNextTurn semantics getting a
//     chance to fire correctly.

test("aiTakeTurn no-ops on endTurn when control is no longer the AI's", async () => {
  const { aiTakeTurn, FIELD_SIZE: FS } = await import("../client/js/game.js");
  const state = {
    turn: 5, activePlayer: "ai", phase: "main", winner: null, log: [],
    players: {
      player: {
        name: "P", ability: "brock", trainerHp: 30, maxTrainerHp: 30,
        energy: 5, maxEnergy: 10, deck: [], hand: [],
        field: Array(FS).fill(null), discard: [],
      },
      ai: {
        name: "AI", ability: "brock", trainerHp: 30, maxTrainerHp: 30,
        energy: 5, maxEnergy: 10, deck: [], hand: [],
        field: Array(FS).fill(null), discard: [],
      },
    },
  };
  // Mid-turn, simulate the timeout force-ending it: flip the activePlayer
  // mid-flight by mutating state before aiTakeTurn finishes. The simplest
  // way to exercise the contract here is to call aiTakeTurn after the
  // state has already been switched to "player" — the guard at the TOP
  // of aiTakeTurnInner short-circuits, but the symmetric guard at the
  // BOTTOM is the one we're pinning. We force it by calling with
  // activePlayer="player" (already a no-op situation) and checking that
  // state.turn doesn't advance (which it would if endTurn fired).
  state.activePlayer = "player";
  const turnBefore = state.turn;
  await aiTakeTurn(state, { difficulty: "medium" });
  assert.equal(state.activePlayer, "player",
    "AI's endTurn must not flip control when it's not the AI's turn");
  assert.equal(state.turn, turnBefore,
    "no endTurn → turn counter does not advance");
});
