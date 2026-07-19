// Catalog + deck integrity and — crucially — PLAYABILITY. A prebuilt deck can
// be 60 legal cards yet still be broken if a Pokémon's only attacks need an
// Energy type the deck doesn't provide (the "Onix in the Metal deck couldn't
// attack" bug). These tests assert every Pokémon in every deck can actually
// pay for an attack with that deck's Energy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { canPayCost } from "../client/js/tcg/effects.js";
import { STARTER_DECKS } from "../client/js/tcg/decks.js";
import { POKEMON, ENERGY, TRAINERS, ALL_CARDS, cardById } from "../client/js/tcg/catalog.js";

const energyTypesOf = (deck) => {
  const t = new Set();
  for (const id of deck.cards) { const c = cardById(id); if (c.kind === "energy") t.add(c.energyType); }
  return t;
};
// A generous attached pool of every Energy type the deck provides. Colorless
// costs are always payable from leftovers, so we don't add a colorless card.
const poolFor = (types) => {
  const att = [];
  for (const t of types) for (let i = 0; i < 8; i++) att.push({ energyType: t });
  return att;
};
const payableAttacks = (card, att) => card.attacks.filter((a) => canPayCost(att, a.cost));

test("every prebuilt deck is 60 cards, ≤4 copies of any non-Energy, has Basics", () => {
  for (const d of STARTER_DECKS) {
    assert.equal(d.cards.length, 60, `${d.id} size`);
    const counts = {};
    for (const id of d.cards) counts[id] = (counts[id] || 0) + 1;
    for (const [id, n] of Object.entries(counts)) {
      if (!id.startsWith("energy-")) assert.ok(n <= 4, `${d.id}: ${id} ×${n} exceeds 4`);
      assert.doesNotThrow(() => cardById(id), `${d.id}: unknown card ${id}`);
    }
    const basics = d.cards.filter((id) => { const c = cardById(id); return c.kind === "pokemon" && c.stage === "basic"; });
    assert.ok(basics.length >= 6, `${d.id} has too few Basics (${basics.length})`);
  }
});

test("PLAYABILITY: every Pokémon in a deck can pay for ≥1 attack with the deck's Energy", () => {
  const failures = [];
  for (const d of STARTER_DECKS) {
    const att = poolFor(energyTypesOf(d));
    const seen = new Set();
    for (const id of d.cards) {
      const c = cardById(id);
      if (c.kind !== "pokemon" || seen.has(id)) continue;
      seen.add(id);
      if (payableAttacks(c, att).length === 0) {
        const costs = [...new Set(c.attacks.flatMap((a) => a.cost))].join("/");
        failures.push(`${d.id}: ${c.name} (needs ${costs})`);
      }
    }
  }
  assert.equal(failures.length, 0, `Unplayable Pokémon:\n  ${failures.join("\n  ")}`);
});

test("PLAYABILITY: every Basic that could open as Active can attack with the deck's Energy", () => {
  // setupSide promotes the highest-HP Basic to Active, so a stranded high-HP
  // Basic softlocks the opening. Assert ALL Basics (any could be promoted after
  // a KO too) have a payable attack.
  for (const d of STARTER_DECKS) {
    const att = poolFor(energyTypesOf(d));
    for (const id of new Set(d.cards)) {
      const c = cardById(id);
      if (c.kind === "pokemon" && c.stage === "basic") {
        assert.ok(payableAttacks(c, att).length > 0, `${d.id}: Basic ${c.name} cannot attack with ${[...energyTypesOf(d)]}`);
      }
    }
  }
});

test("no WRONG Energy: a typed-element deck must provide that element's Energy", () => {
  const ELEMENTS = new Set(["fire", "water", "grass", "lightning", "psychic", "fighting", "darkness", "metal", "dragon", "fairy"]);
  for (const d of STARTER_DECKS) {
    if (!ELEMENTS.has(d.type)) continue; // colorless decks may run any Energy
    assert.ok(energyTypesOf(d).has(d.type), `${d.id} is a ${d.type} deck but has no ${d.type} Energy`);
  }
});

test("no DEAD attacks: EVERY attack of every Pokémon in a deck is payable with the deck's Energy", () => {
  // Stronger than the ≥1-attack playability check: a deck's Energy must not
  // strand ANY printed attack (the "Sky Kings had Lightning" / "Onix's Rock
  // Throw needed Fighting in a Metal deck" class of bug).
  const dead = [];
  for (const d of STARTER_DECKS) {
    const att = poolFor(energyTypesOf(d));
    const seen = new Set();
    for (const id of d.cards) {
      const c = cardById(id);
      if (c.kind !== "pokemon" || seen.has(id)) continue;
      seen.add(id);
      for (const a of c.attacks) {
        if (!canPayCost(att, a.cost)) {
          const need = [...new Set(a.cost.filter((t) => t !== "colorless"))].join("+");
          dead.push(`${d.id}: ${c.name} — ${a.name} (needs ${need})`);
        }
      }
    }
  }
  assert.equal(dead.length, 0, `Dead attacks (wrong Energy in deck):\n  ${dead.join("\n  ")}`);
});

test("canPayCost: typed Energy must match; Colorless pays from any leftover", () => {
  assert.equal(canPayCost([], []), true, "free attack");
  assert.equal(canPayCost([{ energyType: "fighting" }], ["fighting"]), true);
  assert.equal(canPayCost([{ energyType: "metal" }], ["fighting"]), false, "metal cannot pay a Fighting cost");
  assert.equal(canPayCost([{ energyType: "metal" }], ["colorless"]), true, "any Energy pays Colorless");
  assert.equal(canPayCost([{ energyType: "fire" }, { energyType: "fire" }], ["fire", "colorless"]), true);
  assert.equal(canPayCost([{ energyType: "fire" }], ["fire", "colorless"]), false, "not enough total");
  assert.equal(canPayCost([{ energyType: "water" }, { energyType: "fire" }], ["fire", "fire"]), false, "need two Fire");
  assert.equal(canPayCost([{ energyType: "fire" }, { energyType: "water" }], ["fire", "colorless"]), true, "leftover water pays Colorless");
});

test("catalog: every non-Colorless type used by a Pokémon has a basic Energy card", () => {
  const energyTypes = new Set(ENERGY.map((e) => e.energyType));
  const used = new Set(POKEMON.map((p) => p.type).filter((t) => t !== "colorless"));
  for (const t of used) assert.ok(energyTypes.has(t), `no Energy card for type ${t}`);
});

test("catalog: unique ids; every evolvesFrom resolves to a Pokémon", () => {
  const ids = new Set();
  for (const c of ALL_CARDS) { assert.ok(!ids.has(c.id), `dup id ${c.id}`); ids.add(c.id); }
  for (const c of POKEMON) if (c.from) assert.equal(cardById(c.from).kind, "pokemon", `${c.id} bad evolvesFrom`);
});

test("catalog: Mega EX / ex cards award 2 Prizes, are Ultra, and evolve from a real Pokémon", () => {
  const megas = POKEMON.filter((p) => p.mega || p.ex);
  assert.ok(megas.length >= 8, "expected the Mega EX set");
  for (const m of megas) {
    assert.equal(m.prizeValue, 2, `${m.id} prizeValue`);
    assert.equal(m.rarity, "ultra", `${m.id} rarity`);
    if (m.mega) {
      assert.equal(m.stage, "mega", `${m.id} stage`);
      assert.equal(cardById(m.from).kind, "pokemon", `${m.id} evolvesFrom`);
    }
  }
});

test("catalog: Guest-Artist cards carry an illustrator credit and bespoke art", () => {
  const guests = POKEMON.filter((p) => p.illus);
  assert.ok(guests.length >= 11, `expected ≥11 guest cards, got ${guests.length}`);
  for (const g of guests) {
    assert.ok(g.genArt, `${g.id} guest card missing bespoke art`);
    assert.equal(g.rarity, "ultra", `${g.id} guest card should be Ultra`);
  }
});

test("catalog: Trainer effects are all interpreter-supported types", () => {
  const SUPPORTED = new Set([
    "heal", "search", "draw", "discardHandDraw", "switchOwn", "switchOpponent",
    "startTurnHeal", "attackBonus", "healAllStadium",
  ]);
  for (const t of TRAINERS) {
    assert.ok(t.effect && SUPPORTED.has(t.effect.type), `${t.id} has unsupported effect ${t.effect?.type}`);
  }
});
