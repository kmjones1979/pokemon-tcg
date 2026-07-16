// TCG engine rules + invariants. Pure, deterministic (seeded RNG), no I/O.
// Covers setup, the per-turn action legality, evolution timing, Weakness ×2,
// KO/Prize/promotion, retreat, deck-out, all-Prizes win, plus a 200-game
// self-play fuzz asserting card conservation and termination.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../client/js/tcg/engine.js";
import { STARTER_DECKS, deckById } from "../client/js/tcg/decks.js";
import { ALL_CARDS, cardById } from "../client/js/tcg/catalog.js";

// Deterministic RNG (mulberry32) so every test is reproducible.
function seed(n) {
  let a = n >>> 0;
  E.setRng(() => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
}

// Every physical card a side controls must always total 60.
function countCards(s) {
  let n = s.deck.length + s.hand.length + s.discard.length + s.prizes.length;
  for (const i of (s.active ? [s.active, ...s.bench] : s.bench)) n += 1 + i.under.length + i.attached.length;
  return n;
}
const energy = (type, uid) => ({ id: `energy-${type}`, kind: "energy", name: `${type} Energy`, energyType: type, uid });
const inst = (id, over = {}) => ({ uid: over.uid || "u" + id, card: cardById(id), damage: 0, under: [], attached: [], enteredTurn: 0, evolvedThisTurn: false, status: null, ...over });

test("catalog: unique ids and every evolvesFrom resolves", () => {
  const ids = new Set();
  for (const c of ALL_CARDS) { assert.ok(!ids.has(c.id), `dup id ${c.id}`); ids.add(c.id); }
  for (const c of ALL_CARDS) {
    if (c.kind === "pokemon" && c.from) assert.equal(cardById(c.from).kind, "pokemon", `${c.id} evolvesFrom`);
  }
});

test("decks: 60 cards, ≤4 copies of non-Energy, ≥8 Basics", () => {
  for (const d of STARTER_DECKS) {
    assert.equal(d.cards.length, 60, `${d.name} size`);
    const counts = {};
    for (const id of d.cards) counts[id] = (counts[id] || 0) + 1;
    let basics = 0;
    for (const [id, n] of Object.entries(counts)) {
      const c = cardById(id);
      if (c.kind !== "energy") assert.ok(n <= 4, `${d.name}: ${id} ×${n} > 4`);
      if (c.kind === "pokemon" && c.stage === "basic") basics += n;
    }
    assert.ok(basics >= 8, `${d.name}: only ${basics} Basics`);
  }
});

test("setup: Actives placed, 6 Prizes each, conservation, turn 1 main", () => {
  seed(12345);
  const st = E.createTcgGame({ playerDeckIds: deckById("fire").cards, aiDeckIds: deckById("water").cards, firstPlayer: "player" });
  assert.ok(st.players.player.active && st.players.ai.active);
  assert.equal(st.players.player.active.card.stage, "basic");
  assert.equal(st.players.player.prizes.length, 6);
  assert.equal(st.players.ai.prizes.length, 6);
  assert.equal(countCards(st.players.player), 60);
  assert.equal(countCards(st.players.ai), 60);
  assert.equal(st.turn, 1);
  assert.equal(st.activePlayer, "player");
  assert.equal(st.phase, "main");
});

test("first player cannot attack on turn 1", () => {
  seed(7);
  const st = E.createTcgGame({ playerDeckIds: deckById("fire").cards, aiDeckIds: deckById("water").cards, firstPlayer: "player" });
  st.players.player.active.attached.push(energy("fire", "x1"));
  assert.throws(() => E.attack(st, "player", 0));
});

test("only one Energy attach per turn", () => {
  seed(3);
  const st = E.createTcgGame({ playerDeckIds: deckById("water").cards, aiDeckIds: deckById("fire").cards, firstPlayer: "player" });
  const s = st.players.player;
  s.hand.unshift(energy("water", "e1"), energy("water", "e2"));
  E.attachEnergy(st, "player", 0, s.active.uid);
  assert.throws(() => E.attachEnergy(st, "player", 0, s.active.uid));
});

test("evolution: not the turn it entered, then allowed; pre-evo kept underneath", () => {
  seed(99);
  const st = E.createTcgGame({ playerDeckIds: deckById("fire").cards, aiDeckIds: deckById("water").cards, firstPlayer: "player" });
  st.turn = 3;
  const s = st.players.player;
  s.hand.unshift({ ...cardById("fire-charmander"), uid: "b1" });
  E.playBasic(st, "player", 0);
  const just = s.bench[s.bench.length - 1];
  s.hand.unshift({ ...cardById("fire-charmeleon"), uid: "e1" });
  assert.throws(() => E.evolve(st, "player", 0, just.uid), /Illegal/);
  just.enteredTurn = 1;
  E.evolve(st, "player", 0, just.uid);
  assert.equal(just.card.id, "fire-charmeleon");
  assert.deepEqual(just.under.map((c) => c.id), ["fire-charmander"]);
});

test("Weakness ×2, KO awards exactly one Prize, Bench auto-promotes", () => {
  seed(1);
  const st = E.createTcgGame({ playerDeckIds: deckById("water").cards, aiDeckIds: deckById("fire").cards, firstPlayer: "player" });
  st.turn = 5; st.noAttack = false; st.activePlayer = "player"; st.phase = "main";
  const p = st.players.player, a = st.players.ai;
  p.active = inst("water-squirtle", { uid: "pa", attached: [energy("water", "w1"), energy("water", "w2")] });
  a.active = inst("fire-charmander", { uid: "aa" });
  a.bench = [inst("fire-growlithe", { uid: "ab" })];
  const before = p.prizes.length;
  E.attack(st, "player", 1); // Bubble 20 ×2 weakness = 40
  assert.equal(a.active.damage, 40);
  st.turn = 7; st.activePlayer = "player"; st.phase = "main"; st.noAttack = false;
  E.attack(st, "player", 1); // 80 ≥ 60 → KO
  assert.equal(a.active.card.id, "fire-growlithe");
  assert.equal(p.prizes.length, before - 1);
});

test("retreat requires enough Energy and discards it", () => {
  seed(2);
  const st = E.createTcgGame({ playerDeckIds: deckById("fire").cards, aiDeckIds: deckById("grass").cards, firstPlayer: "player" });
  st.turn = 4; st.activePlayer = "player"; st.phase = "main";
  const p = st.players.player;
  p.active = inst("fire-charizard", { uid: "pa", attached: [energy("fire", "f1")] }); // retreat cost 3
  p.bench = [inst("fire-vulpix", { uid: "pb" })];
  assert.throws(() => E.retreat(st, "player", 0));
  p.active.attached.push(energy("fire", "f2"), energy("fire", "f3"));
  E.retreat(st, "player", 0);
  assert.equal(p.active.card.id, "fire-vulpix");
  assert.equal(p.discard.filter((c) => c.kind === "energy").length, 3);
});

test("deck-out: a player who cannot draw loses", () => {
  seed(4);
  const st = E.createTcgGame({ playerDeckIds: deckById("fire").cards, aiDeckIds: deckById("water").cards, firstPlayer: "player" });
  st.players.ai.deck = [];
  st.activePlayer = "player"; st.phase = "main"; st.noAttack = false;
  E.endTurn(st, "player");
  assert.equal(st.winner, "player");
});

test("taking the last Prize wins", () => {
  seed(6);
  const st = E.createTcgGame({ playerDeckIds: deckById("water").cards, aiDeckIds: deckById("fire").cards, firstPlayer: "player" });
  st.turn = 9; st.activePlayer = "player"; st.phase = "main"; st.noAttack = false;
  const p = st.players.player, a = st.players.ai;
  p.prizes = [energy("water", "lastprize")];
  p.active = inst("water-squirtle", { uid: "pa", attached: [energy("water", "w1"), energy("water", "w2")] });
  a.active = inst("fire-charmander", { uid: "aa", damage: 55 });
  a.bench = [];
  E.attack(st, "player", 1);
  assert.equal(st.winner, "player");
});

test("200-game self-play: conservation holds every ply, all terminate", () => {
  const decks = STARTER_DECKS.map((d) => d.cards);
  let games = 0, longest = 0;
  for (let g = 0; g < 200; g++) {
    seed(1000 + g);
    const st = E.createTcgGame({ playerDeckIds: decks[g % 3], aiDeckIds: decks[(g + 1) % 3], firstPlayer: g % 2 ? "player" : "ai" });
    let guard = 0;
    while (!st.winner && guard++ < 400) {
      greedyTurn(st, st.activePlayer);
      assert.equal(countCards(st.players.player), 60, `player conservation game ${g}`);
      assert.equal(countCards(st.players.ai), 60, `ai conservation game ${g}`);
    }
    assert.ok(st.winner === "player" || st.winner === "ai", `game ${g} produced a winner`);
    longest = Math.max(longest, st.turn);
    games++;
  }
  assert.equal(games, 200);
  assert.ok(longest < 400, `longest game ${longest} turns`);
});

// A simple greedy turn used only by the fuzz test above.
function greedyTurn(st, side) {
  const s = st.players[side];
  const eIdx = s.hand.findIndex((c) => c.kind === "energy");
  if (eIdx >= 0 && !s.energyAttachedThisTurn && s.active) { try { E.attachEnergy(st, side, eIdx, s.active.uid); } catch {} }
  for (let g = 0; g < 3; g++) {
    const bIdx = s.hand.findIndex((c) => c.kind === "pokemon" && c.stage === "basic");
    if (bIdx < 0 || s.bench.length >= 5) break;
    try { E.playBasic(st, side, bIdx); } catch { break; }
  }
  for (const i of (s.active ? [s.active, ...s.bench] : [...s.bench])) {
    const hi = s.hand.findIndex((c) => E.canEvolve(st, side, c, i));
    if (hi >= 0) { try { E.evolve(st, side, hi, i.uid); } catch {} }
  }
  const atks = st.noAttack || !s.active ? [] : E.affordableAttacks(s.active).map((a) => s.active.card.attacks.indexOf(a));
  if (atks.length) E.attack(st, side, atks[atks.length - 1]);
  else if (!st.winner) E.endTurn(st, side);
}
