// Tests for the evolution-chain table + the server-side stamping pass
// that bakes `evolves_to_card` onto each Pokémon at boot.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  EVOLVES_TO,
  EVOLUTION_KO_THRESHOLD,
  evolutionFor,
  hasEvolution,
  evolvingFromIds,
  evolvingToIds,
} = require("../shared/evolution-chains");

test("EVOLVES_TO maps from-id → to-id (both numeric)", () => {
  for (const [from, to] of Object.entries(EVOLVES_TO)) {
    assert.ok(/^\d+$/.test(from), `from-id ${from} should be numeric`);
    assert.ok(Number.isInteger(to) && to > 0, `to-id ${to} should be a positive integer`);
  }
});

test("no Pokémon evolves into itself (no infinite loops)", () => {
  for (const [from, to] of Object.entries(EVOLVES_TO)) {
    assert.notEqual(Number(from), to, `id ${from} evolves into itself`);
  }
});

test("no cycle in the chain (Charmander → Charmeleon → Charmander would be bad)", () => {
  // For every starting id, walk the chain; ensure we don't revisit.
  for (const start of evolvingFromIds()) {
    const seen = new Set([start]);
    let cur = EVOLVES_TO[start];
    let depth = 0;
    while (cur && depth < 10) {
      assert.ok(!seen.has(cur), `cycle detected starting at ${start} (revisits ${cur})`);
      seen.add(cur);
      cur = EVOLVES_TO[cur];
      depth++;
    }
    assert.ok(depth < 10, `chain starting at ${start} runs >10 deep — suspicious`);
  }
});

test("classic Gen-1 starter chains are present", () => {
  // The headline kid-favorites — pin them so a future refactor of the
  // chain table doesn't silently lose them.
  assert.equal(EVOLVES_TO[1],  2,   "Bulbasaur → Ivysaur");
  assert.equal(EVOLVES_TO[2],  3,   "Ivysaur → Venusaur");
  assert.equal(EVOLVES_TO[4],  5,   "Charmander → Charmeleon");
  assert.equal(EVOLVES_TO[5],  6,   "Charmeleon → Charizard");
  assert.equal(EVOLVES_TO[7],  8,   "Squirtle → Wartortle");
  assert.equal(EVOLVES_TO[8],  9,   "Wartortle → Blastoise");
  assert.equal(EVOLVES_TO[129], 130, "Magikarp → Gyarados (the iconic underdog)");
  assert.equal(EVOLVES_TO[147], 148, "Dratini → Dragonair");
  assert.equal(EVOLVES_TO[148], 149, "Dragonair → Dragonite");
});

test("final-form Pokémon return null from evolutionFor", () => {
  // Charizard, Venusaur, Blastoise — no further evolutions.
  assert.equal(evolutionFor(3),   null, "Venusaur");
  assert.equal(evolutionFor(6),   null, "Charizard");
  assert.equal(evolutionFor(9),   null, "Blastoise");
  assert.equal(evolutionFor(149), null, "Dragonite");
  assert.equal(evolutionFor(150), null, "Mewtwo (legendary, no evolution)");
});

test("hasEvolution flag matches evolutionFor", () => {
  assert.equal(hasEvolution({ id: 1 }), true,  "Bulbasaur has an evolution");
  assert.equal(hasEvolution({ id: 6 }), false, "Charizard is final form");
  assert.equal(hasEvolution(null), false, "null doesn't crash");
});

test("evolvingFromIds + evolvingToIds report the table consistently", () => {
  const froms = evolvingFromIds();
  const tos = evolvingToIds();
  // Every "from" id should appear in EVOLVES_TO as a key.
  for (const id of froms) assert.ok(EVOLVES_TO[id], `from-id ${id} missing from table`);
  // Every "to" id should be a value in EVOLVES_TO.
  const toSet = new Set(Object.values(EVOLVES_TO));
  for (const id of tos) assert.ok(toSet.has(id), `to-id ${id} not in values`);
});

test("EVOLUTION_KO_THRESHOLD is 2 (slice 9 contract)", () => {
  // Pinned because changing this re-balances every match.
  assert.equal(EVOLUTION_KO_THRESHOLD, 2);
});

test("server-side stamping: a card with an evolution chain has evolves_to_card baked", () => {
  // Mirror the boot pass server.js does. Confirms the bake produces
  // self-contained cards (so the engine doesn't need a pokedex
  // lookup at runtime).
  const { toCard } = require("../shared/deck-builder");
  function fakeRow(id, name) {
    return {
      id, name, slug: name.toLowerCase(),
      types: ["fire"], hp: 50, attack: 50, defense: 30, sp_attack: 50, sp_defense: 30, speed: 50,
      sprite_front: null, generation: 1,
    };
  }
  const dex = [toCard(fakeRow(4, "Charmander")), toCard(fakeRow(5, "Charmeleon"))];
  const byId = new Map(dex.map((c) => [c.id, c]));
  for (const c of dex) {
    const nextId = evolutionFor(c.id);
    if (nextId && byId.has(nextId)) c.evolves_to_card = byId.get(nextId);
  }
  assert.ok(dex[0].evolves_to_card, "Charmander should have evolves_to_card");
  assert.equal(dex[0].evolves_to_card.id, 5);
  assert.equal(dex[0].evolves_to_card.name, "Charmeleon");
  assert.ok(!dex[1].evolves_to_card, "Charmeleon (no Charizard in this fake dex) has no chain");
});
