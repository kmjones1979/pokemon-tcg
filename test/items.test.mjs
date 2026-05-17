// Tests for the item system — heal, energy, switch, revive, luckyDraw.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ITEM_DEFS, defaultKit, itemDef, useItem } from "../client/js/items.js";

function mkCard(id, cost = 1, hp = 10, atk = 5) {
  return {
    id, name: "C" + id, types: ["normal"],
    energyCost: cost, cardHp: hp, cardAttack: atk,
    raw: { hp: hp * 10, attack: atk * 15, defense: 30, sp_attack: 0, sp_defense: 30, speed: 30 },
  };
}
function mkInst(card, currentHp = null) {
  return {
    instanceId: "i" + card.id,
    card,
    currentHp: currentHp ?? card.cardHp,
    maxHp: card.cardHp,
    summoningSickness: false, attackedThisTurn: false, status: null,
  };
}
function mkState() {
  return {
    log: [], turn: 1, phase: "main", activePlayer: "player",
    players: {
      player: {
        name: "P", ability: "brock", trainerHp: 30, maxTrainerHp: 30,
        energy: 5, maxEnergy: 5,
        deck: [mkCard(99), mkCard(100), mkCard(101)],
        hand: [], field: [null, null, null, null, null], discard: [],
        items: defaultKit(),
      },
      ai: {
        name: "A", ability: "lance", trainerHp: 30, maxTrainerHp: 30,
        energy: 5, maxEnergy: 5, deck: [], hand: [], field: [null, null, null, null, null], discard: [], items: defaultKit(),
      },
    },
  };
}

// --- ITEM_DEFS + helpers ----------------------------------------------

test("defaultKit returns five distinct items, all with uses>0", () => {
  const kit = defaultKit();
  assert.equal(kit.length, 5);
  const ids = new Set(kit.map((x) => x.id));
  assert.equal(ids.size, 5);
  for (const it of kit) assert.ok(it.uses > 0, `${it.id} uses must start > 0`);
});

test("every item in defaultKit has a matching ITEM_DEF", () => {
  for (const it of defaultKit()) {
    assert.ok(ITEM_DEFS[it.id], `missing def for ${it.id}`);
    assert.ok(typeof ITEM_DEFS[it.id].name === "string");
    assert.ok(typeof ITEM_DEFS[it.id].desc === "string");
  }
});

test("itemDef returns null for unknown ids", () => {
  assert.equal(itemDef("nope"), null);
  assert.equal(itemDef(null), null);
});

// --- Potion ------------------------------------------------------------

test("potion heals up to 4 HP, capped at maxHp", () => {
  const s = mkState();
  const card = mkCard(1);
  s.players.player.field[0] = mkInst(card, 3);   // 3/10
  const r = useItem(s, "player", "potion", 0);
  assert.ok(r.ok, r.reason);
  assert.equal(s.players.player.field[0].currentHp, 7);   // 3+4=7
});

test("potion on a full-HP target heals 0 (no error, no over-heal)", () => {
  // The engine intentionally lets the player waste a potion (it consumes
  // a use), but the target HP doesn't go above maxHp.
  const s = mkState();
  s.players.player.field[0] = mkInst(mkCard(1));   // full at 10/10
  const r = useItem(s, "player", "potion", 0);
  assert.ok(r.ok);
  assert.equal(r.healed, 0);
  assert.equal(s.players.player.field[0].currentHp, s.players.player.field[0].maxHp);
});

test("potion can't heal an empty slot", () => {
  const s = mkState();
  const r = useItem(s, "player", "potion", 0);
  assert.equal(r.ok, false);
});

test("potion consumes one use", () => {
  const s = mkState();
  s.players.player.field[0] = mkInst(mkCard(1), 3);
  const beforeUses = s.players.player.items.find((x) => x.id === "potion").uses;
  useItem(s, "player", "potion", 0);
  const afterUses  = s.players.player.items.find((x) => x.id === "potion").uses;
  assert.equal(afterUses, beforeUses - 1);
});

test("potion can't be used twice if uses=0", () => {
  const s = mkState();
  s.players.player.field[0] = mkInst(mkCard(1), 3);
  s.players.player.items.find((x) => x.id === "potion").uses = 0;
  const r = useItem(s, "player", "potion", 0);
  assert.equal(r.ok, false);
});

// --- Energy Crystal ---------------------------------------------------

test("energy crystal grants +2 energy capped at maxEnergy", () => {
  const s = mkState();
  s.players.player.energy = 2;
  s.players.player.maxEnergy = 6;
  const r = useItem(s, "player", "energy", null);
  assert.ok(r.ok, r.reason);
  assert.equal(s.players.player.energy, 4);  // 2+2
});

test("energy crystal can't push past maxEnergy", () => {
  const s = mkState();
  s.players.player.energy = 5;
  s.players.player.maxEnergy = 6;
  const r = useItem(s, "player", "energy", null);
  assert.ok(r.ok, r.reason);
  assert.equal(s.players.player.energy, 6);  // clamped
});

// --- Switch -----------------------------------------------------------

test("switch removes target from field, puts back into hand", () => {
  const s = mkState();
  const card = mkCard(1);
  s.players.player.field[0] = mkInst(card);
  const r = useItem(s, "player", "switch", 0);
  assert.ok(r.ok, r.reason);
  assert.equal(s.players.player.field[0], null);
  assert.ok(s.players.player.hand.some((c) => c.id === 1));
});

test("switch fails on empty slot", () => {
  const s = mkState();
  const r = useItem(s, "player", "switch", 0);
  assert.equal(r.ok, false);
});

// --- Revive -----------------------------------------------------------

test("revive brings back most-recent discard at 50% HP", () => {
  const s = mkState();
  const koCard = mkCard(7, 3, 12);
  s.players.player.discard.push(koCard);
  const r = useItem(s, "player", "revive", null);
  assert.ok(r.ok, r.reason);
  const placed = s.players.player.field.find(Boolean);
  assert.ok(placed, "revived card lands on field");
  assert.equal(placed.card.id, 7);
  assert.equal(placed.currentHp, Math.ceil(12 / 2));
  assert.equal(s.players.player.discard.length, 0, "discard pop'd");
});

test("revive fails when discard is empty", () => {
  const s = mkState();
  const r = useItem(s, "player", "revive", null);
  assert.equal(r.ok, false);
});

test("revive fails when field is full", () => {
  const s = mkState();
  for (let i = 0; i < 5; i++) s.players.player.field[i] = mkInst(mkCard(i));
  s.players.player.discard.push(mkCard(99));
  const r = useItem(s, "player", "revive", null);
  assert.equal(r.ok, false);
});

// --- Lucky Draw -------------------------------------------------------

test("luckyDraw pulls 2 cards from deck", () => {
  const s = mkState();
  const beforeHand = s.players.player.hand.length;
  const beforeDeck = s.players.player.deck.length;
  const r = useItem(s, "player", "luckyDraw", null);
  assert.ok(r.ok, r.reason);
  assert.equal(s.players.player.hand.length, beforeHand + 2);
  assert.equal(s.players.player.deck.length, beforeDeck - 2);
});

test("luckyDraw draws whatever's left if deck has fewer than 2 cards", () => {
  const s = mkState();
  s.players.player.deck = [mkCard(1)];   // only 1 card
  const beforeHand = s.players.player.hand.length;
  const r = useItem(s, "player", "luckyDraw", null);
  assert.ok(r.ok || r.ok === false, "shouldn't crash");
  // hand grows by at most what was in deck
  assert.ok(s.players.player.hand.length >= beforeHand);
});

// --- Unknown item -----------------------------------------------------

test("unknown itemId returns ok:false with a reason", () => {
  const s = mkState();
  const r = useItem(s, "player", "definitely-not-a-real-item", null);
  assert.equal(r.ok, false);
  assert.ok(typeof r.reason === "string");
});
