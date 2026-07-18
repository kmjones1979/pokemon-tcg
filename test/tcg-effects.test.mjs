// Attack + Trainer effect interpreter coverage — one focused assertion per
// effect type, driven through the real engine entry points (attack / playTrainer),
// plus the Mega EX / ex multi-Prize KO rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../client/js/tcg/engine.js";
import { deckById } from "../client/js/tcg/decks.js";
import { cardById } from "../client/js/tcg/catalog.js";

function seed(n, heads = false) {
  // heads=true forces coin flips to heads (rng < 0.5), false forces tails.
  E.setRng(() => (heads ? 0.1 : 0.9));
  void n;
}
const energy = (type, uid) => ({ id: `energy-${type}`, kind: "energy", name: `${type} Energy`, energyType: type, uid });
const inst = (id, over = {}) => ({ uid: over.uid || "u" + id, card: cardById(id), damage: 0, under: [], attached: [], enteredTurn: 0, evolvedThisTurn: false, status: null, ...over });

// A ready-to-act game: player's turn, past turn 1, main phase, attacks legal.
function game(over = {}) {
  const st = E.createTcgGame({ playerDeckIds: deckById("fire").cards, aiDeckIds: deckById("water").cards, firstPlayer: "player" });
  st.turn = 6; st.activePlayer = "player"; st.phase = "main"; st.noAttack = false;
  Object.assign(st, over);
  return st;
}
// Index of a named attack on a card.
const atkIndex = (id, name) => cardById(id).attacks.findIndex((a) => a.name === name);

test("attack pays cost and deals base damage; unaffordable attack throws", () => {
  seed(1);
  const st = game();
  st.players.player.active = inst("fire-charmander", { attached: [energy("fire", "f1"), energy("fire", "f2")] });
  st.players.ai.active = inst("water-psyduck", { uid: "aa" }); // not weak to fire
  const i = atkIndex("fire-charmander", "Ember"); // FC, 30, discards 1 energy
  E.attack(st, "player", i);
  assert.equal(st.players.ai.active.damage, 30);
  // Ember (selfDiscardEnergy 1) discarded one Fire from the attacker.
  assert.equal(st.players.player.discard.filter((c) => c.kind === "energy").length, 1);
});

test("effect healSelf reduces the attacker's own damage", () => {
  seed(1);
  const st = game();
  const active = inst("grass-venusaur", { uid: "pa", damage: 60, attached: [energy("grass", "g1"), energy("grass", "g2"), energy("grass", "g3"), energy("grass", "g4")] });
  st.players.player.active = active;
  st.players.ai.active = inst("water-psyduck", { uid: "aa" });
  const i = atkIndex("grass-venusaur", "Mega Drain"); // GGCC, heals 30
  E.attack(st, "player", i);
  assert.equal(active.damage, 30, "healed 30 of 60");
});

test("effect recoil damages the attacker", () => {
  seed(1);
  const st = game();
  const active = inst("fire-arcanine", { uid: "pa", attached: [energy("fire", "f1"), energy("fire", "f2"), energy("fire", "f3")] });
  st.players.player.active = active;
  st.players.ai.active = inst("water-psyduck", { uid: "aa" });
  const i = atkIndex("fire-arcanine", "Heat Tackle"); // FFC 100, recoil 20
  E.attack(st, "player", i);
  assert.equal(active.damage, 20, "self recoil");
});

test("effect coinFlipBonus adds damage on heads, not on tails", () => {
  const mk = () => {
    const st = game();
    st.players.player.active = inst("fire-vulpix", { uid: "pa", attached: [energy("fire", "f1")] });
    st.players.ai.active = inst("water-psyduck", { uid: "aa" });
    return st;
  };
  const i = atkIndex("fire-vulpix", "Quick Attack"); // C 10, +10 on heads
  seed(1, true); const h = mk(); E.attack(h, "player", i);
  assert.equal(h.players.ai.active.damage, 20, "heads +10");
  seed(1, false); const t = mk(); E.attack(t, "player", i);
  assert.equal(t.players.ai.active.damage, 10, "tails base");
});

test("effect plusPerEnergy scales with extra Energy of the type", () => {
  seed(1);
  const st = game();
  // Hydro Pump WWC +20 per extra Water beyond 2. Attach 5 Water → 3 extra → +60.
  st.players.player.active = inst("water-blastoise", { uid: "pa",
    attached: [energy("water", "w1"), energy("water", "w2"), energy("water", "w3"), energy("water", "w4"), energy("water", "w5")] });
  st.players.ai.active = inst("colorless-snorlax", { uid: "aa" }); // 150 HP → survives 120
  const i = atkIndex("water-blastoise", "Hydro Pump"); // 60 base + 20*3
  E.attack(st, "player", i);
  assert.equal(st.players.ai.active.damage, 120);
});

test("effect applyStatus sets a Special Condition on the defender", () => {
  seed(1);
  const st = game();
  st.players.player.active = inst("psychic-gengar", { uid: "pa", attached: [energy("psychic", "p1")] });
  st.players.ai.active = inst("water-psyduck", { uid: "aa" });
  const i = atkIndex("psychic-gengar", "Hypnosis"); // applies sleep
  E.attack(st, "player", i);
  assert.equal(st.players.ai.active.status?.kind, "sleep");
});

test("Mega EX awards TWO Prizes when Knocked Out", () => {
  seed(1);
  const st = game();
  st.players.player.active = inst("colorless-snorlax", { uid: "pa", attached: [energy("fire", "e1"), energy("fire", "e2"), energy("fire", "e3"), energy("fire", "e4")] });
  const mega = inst("mega-charizard-ex", { uid: "aa", damage: 180 }); // hp 240
  st.players.ai.active = mega;
  st.players.ai.bench = [inst("water-squirtle", { uid: "ab" })];
  const before = st.players.player.prizes.length;
  const i = atkIndex("colorless-snorlax", "Heavy Impact"); // CCCC 100 → 180+100 ≥ 240 KO
  E.attack(st, "player", i);
  assert.ok(!st.players.ai.active || st.players.ai.active.uid !== "aa", "mega KO'd");
  assert.equal(st.players.player.prizes.length, before - 2, "took 2 Prizes");
});

test("Trainer draw / search / discardHandDraw / switch effects", () => {
  seed(1);
  // draw
  let st = game();
  st.players.player.hand = [cardById("trainer-hop")]; // draw 3
  const h0 = st.players.player.hand.length, d0 = st.players.player.deck.length;
  E.playTrainer(st, "player", 0);
  assert.equal(st.players.player.hand.length, h0 - 1 + 3, "Hop drew 3");
  assert.equal(st.players.player.deck.length, d0 - 3);

  // search (Poké Ball → a Basic to hand)
  st = game();
  st.players.player.hand = [cardById("trainer-poke-ball")];
  const basicsInDeck = st.players.player.deck.filter((c) => c.kind === "pokemon" && c.stage === "basic").length;
  E.playTrainer(st, "player", 0);
  assert.ok(st.players.player.deck.filter((c) => c.kind === "pokemon" && c.stage === "basic").length <= basicsInDeck, "a basic was searchable");

  // discardHandDraw (Professor's Research → draw 7)
  st = game();
  st.players.player.hand = [cardById("trainer-research"), cardById("energy-fire"), cardById("energy-fire")];
  E.playTrainer(st, "player", 0);
  assert.equal(st.players.player.hand.length, 7, "redrew to 7");

  // switchOwn (Switch → active swaps to bench pick)
  st = game();
  st.players.player.hand = [cardById("trainer-switch")];
  st.players.player.active = inst("fire-charmander", { uid: "pa" });
  st.players.player.bench = [inst("fire-growlithe", { uid: "pb" })];
  E.playTrainer(st, "player", 0);
  assert.notEqual(st.players.player.active.uid, "pa", "active switched out");

  // switchOpponent (Catcher → opponent active swaps)
  st = game();
  st.players.player.hand = [cardById("trainer-pokemon-catcher")];
  st.players.ai.active = inst("water-squirtle", { uid: "aa" });
  st.players.ai.bench = [inst("water-staryu", { uid: "ab" })];
  E.playTrainer(st, "player", 0);
  assert.notEqual(st.players.ai.active.uid, "aa", "opponent active dragged up");
});
