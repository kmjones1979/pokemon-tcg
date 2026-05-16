// Unit tests for the PokeAPI → Supabase row mapper.
// Run with: node --test
//
// Uses real cached PokeAPI responses checked into test/fixtures/ so the test
// suite is fully offline and deterministic.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { mapPokemon, pickFlavor, generationFromUrl } = require("../scraper/pokeapi");

function load(id) {
  const dir = path.join(__dirname, "fixtures", "pokeapi");
  return {
    p: JSON.parse(fs.readFileSync(path.join(dir, `pokemon-${id}.json`), "utf8")),
    s: JSON.parse(fs.readFileSync(path.join(dir, `species-${id}.json`), "utf8")),
  };
}

test("maps Pikachu (#25) correctly", () => {
  const { p, s } = load(25);
  const row = mapPokemon(p, s);

  assert.equal(row.id, 25);
  assert.equal(row.name, "Pikachu");
  assert.equal(row.slug, "pikachu");
  assert.deepEqual(row.types, ["electric"]);
  assert.equal(row.hp, 35);
  assert.equal(row.attack, 55);
  assert.equal(row.defense, 40);
  assert.equal(row.sp_attack, 50);
  assert.equal(row.sp_defense, 50);
  assert.equal(row.speed, 90);
  assert.equal(row.height_m, 0.4);
  assert.equal(row.weight_kg, 6);
  assert.equal(row.generation, 1);
  assert.equal(row.is_legendary, false);
  assert.equal(row.is_mythical, false);
  assert.ok(row.abilities.includes("static"), "abilities should include static");
  assert.ok(
    row.sprite_front && row.sprite_front.startsWith("https://"),
    "sprite_front should be an https URL",
  );
  assert.ok(row.cry_url && row.cry_url.endsWith(".ogg"), "cry_url should be an .ogg URL");
  assert.equal(typeof row.flavor_text, "string");
  assert.ok(row.flavor_text.length > 0);
});

test("maps Mewtwo (#150) as legendary", () => {
  const { p, s } = load(150);
  const row = mapPokemon(p, s);

  assert.equal(row.id, 150);
  assert.equal(row.name, "Mewtwo");
  assert.deepEqual(row.types, ["psychic"]);
  assert.equal(row.is_legendary, true);
  assert.equal(row.is_mythical, false);
  assert.equal(row.generation, 1);
});

test("types are ordered by slot (primary first)", () => {
  const { p, s } = load(25);
  // synthesize a second type in the wrong slot order to verify sorting
  const fake = {
    ...p,
    types: [
      { slot: 2, type: { name: "flying" } },
      { slot: 1, type: { name: "electric" } },
    ],
  };
  const row = mapPokemon(fake, s);
  assert.deepEqual(row.types, ["electric", "flying"]);
});

test("missing stats default to 0", () => {
  const fake = {
    id: 1,
    name: "x",
    height: 0,
    weight: 0,
    stats: [],
    types: [],
    abilities: [],
    sprites: {},
    cries: {},
  };
  const s = { names: [], flavor_text_entries: [], generation: { url: "" } };
  const row = mapPokemon(fake, s);
  assert.equal(row.hp, 0);
  assert.equal(row.attack, 0);
  assert.equal(row.defense, 0);
});

test("generationFromUrl parses generation index", () => {
  assert.equal(generationFromUrl("https://pokeapi.co/api/v2/generation/3/"), 3);
  assert.equal(generationFromUrl(""), null);
  assert.equal(generationFromUrl("garbage"), null);
});

test("pickFlavor strips whitespace and prefers modern English entry", () => {
  const entries = [
    { language: { name: "ja" }, version: { name: "red" }, flavor_text: "ピカチュウ" },
    {
      language: { name: "en" },
      version: { name: "red" },
      flavor_text: "When several of\nthese POKéMON gather,\ftheir electricity",
    },
    {
      language: { name: "en" },
      version: { name: "scarlet" },
      flavor_text: "Modern flavor   text",
    },
  ];
  const out = pickFlavor(entries);
  assert.equal(out, "Modern flavor text"); // scarlet preferred, whitespace collapsed
});

test("pickFlavor returns null for no entries", () => {
  assert.equal(pickFlavor([]), null);
  assert.equal(pickFlavor(null), null);
});
