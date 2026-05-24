// Tests for the pure search helpers used by the Pokédex overlay and
// the deck list. Covers tokenisation edge cases + the AND-across-
// tokens, OR-across-fields semantics.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeQuery,
  matchesAllTokens,
  filterPokedexEntries,
  filterDecks,
} from "../client/js/search-utils.js";

// --- normalizeQuery --------------------------------------------------

test("normalizeQuery lowercases and splits on whitespace + delimiters", () => {
  assert.deepEqual(normalizeQuery("Char Fire"), ["char", "fire"]);
  assert.deepEqual(normalizeQuery("water/ice"), ["water", "ice"]);
  assert.deepEqual(normalizeQuery("rock-solid"), ["rock", "solid"]);
});

test("normalizeQuery strips punctuation inside tokens", () => {
  assert.deepEqual(normalizeQuery("char."), ["char"]);
  assert.deepEqual(normalizeQuery("#025"), ["025"]);
});

test("normalizeQuery handles empty / null / whitespace-only", () => {
  assert.deepEqual(normalizeQuery(""), []);
  assert.deepEqual(normalizeQuery(null), []);
  assert.deepEqual(normalizeQuery("   "), []);
});

// --- matchesAllTokens (AND across tokens, OR across haystacks) ------

test("matchesAllTokens with no tokens passes everything (empty-query case)", () => {
  assert.equal(matchesAllTokens([], ["anything"]), true);
});

test("matchesAllTokens: each token must hit at least one haystack", () => {
  assert.equal(matchesAllTokens(["fire"], ["Charmander", "fire"]), true);
  assert.equal(matchesAllTokens(["fire", "char"], ["Charmander", "fire"]), true);
  assert.equal(matchesAllTokens(["water"], ["Charmander", "fire"]), false);
});

test("matchesAllTokens ignores null / undefined haystacks (no crash)", () => {
  assert.equal(matchesAllTokens(["abc"], [null, undefined, "abcde"]), true);
});

// --- filterPokedexEntries -------------------------------------------

const POKEDEX_FIXTURE = [
  { id: 1,   name: "Bulbasaur",  types: ["grass", "poison"], generation: 1, quantity: 0 },
  { id: 4,   name: "Charmander", types: ["fire"],            generation: 1, quantity: 3 },
  { id: 6,   name: "Charizard",  types: ["fire", "flying"],  generation: 1, quantity: 0 },
  { id: 25,  name: "Pikachu",    types: ["electric"],        generation: 1, quantity: 1 },
  { id: 144, name: "Articuno",   types: ["ice", "flying"],   generation: 1, quantity: 0 },
  { id: 252, name: "Treecko",    types: ["grass"],           generation: 3, quantity: 0 },
];

test("empty query returns all entries (no filter)", () => {
  assert.equal(filterPokedexEntries(POKEDEX_FIXTURE, "").length, POKEDEX_FIXTURE.length);
  assert.equal(filterPokedexEntries(POKEDEX_FIXTURE, "  ").length, POKEDEX_FIXTURE.length);
});

test("substring name match (case-insensitive)", () => {
  const r = filterPokedexEntries(POKEDEX_FIXTURE, "char");
  assert.deepEqual(r.map((x) => x.name).sort(), ["Charizard", "Charmander"]);
});

test("type match (single token)", () => {
  const r = filterPokedexEntries(POKEDEX_FIXTURE, "ice");
  assert.deepEqual(r.map((x) => x.name), ["Articuno"]);
});

test("padded dex ID match (#025 → Pikachu)", () => {
  const r = filterPokedexEntries(POKEDEX_FIXTURE, "025");
  assert.deepEqual(r.map((x) => x.name), ["Pikachu"]);
});

test("multi-token AND: 'fire flying' finds only dual-type", () => {
  const r = filterPokedexEntries(POKEDEX_FIXTURE, "fire flying");
  assert.deepEqual(r.map((x) => x.name), ["Charizard"]);
});

test("multi-token AND with name + type: 'char fire'", () => {
  const r = filterPokedexEntries(POKEDEX_FIXTURE, "char fire");
  // Charmander + Charizard both have "char" AND "fire"
  assert.deepEqual(r.map((x) => x.name).sort(), ["Charizard", "Charmander"]);
});

test("no match returns empty array", () => {
  assert.deepEqual(filterPokedexEntries(POKEDEX_FIXTURE, "dragonzord"), []);
});

test("generation match: 'gen3' finds gen-3 Pokémon", () => {
  const r = filterPokedexEntries(POKEDEX_FIXTURE, "gen3");
  assert.deepEqual(r.map((x) => x.name), ["Treecko"]);
});

// --- filterDecks ----------------------------------------------------

const DEX_BY_ID = new Map(POKEDEX_FIXTURE.map((p) => [p.id, p]));

const DECKS_FIXTURE = [
  { id: "d1", name: "My Fire Squad",     card_ids: [4, 6, 25] },
  { id: "d2", name: "Grass Starter",     card_ids: [1, 252] },
  { id: "d3", name: "Random Mix",        card_ids: [144, 25] },
];

test("empty query returns all decks", () => {
  assert.equal(filterDecks(DECKS_FIXTURE, DEX_BY_ID, "").length, 3);
});

test("filter decks by deck name substring", () => {
  const r = filterDecks(DECKS_FIXTURE, DEX_BY_ID, "fire");
  // Two decks should match: "My Fire Squad" (name) AND "Random Mix"
  // contains Articuno + Pikachu, neither of which is fire, so it
  // shouldn't appear. "Grass Starter" has no fire either. So only d1.
  assert.deepEqual(r.map((d) => d.id), ["d1"]);
});

test("filter decks by contained Pokémon name", () => {
  const r = filterDecks(DECKS_FIXTURE, DEX_BY_ID, "pikachu");
  // d1 has Pikachu (id 25). d3 has Pikachu too.
  assert.deepEqual(r.map((d) => d.id).sort(), ["d1", "d3"]);
});

test("filter decks by contained Pokémon TYPE", () => {
  const r = filterDecks(DECKS_FIXTURE, DEX_BY_ID, "grass");
  // d2 has Bulbasaur (grass/poison) + Treecko (grass).
  assert.deepEqual(r.map((d) => d.id), ["d2"]);
});

test("filter decks: multi-token AND across name + contained pokémon", () => {
  // "fire pikachu" → only d1 (name has "fire", contains Pikachu)
  const r = filterDecks(DECKS_FIXTURE, DEX_BY_ID, "fire pikachu");
  assert.deepEqual(r.map((d) => d.id), ["d1"]);
});

test("filter decks gracefully handles missing pokedex entries", () => {
  // A card_id with no matching pokedex entry shouldn't crash — just
  // skip it for the haystack. Deck name still searchable.
  const r = filterDecks(
    [{ id: "x", name: "OldDeck", card_ids: [99999, 25] }],
    DEX_BY_ID,
    "olddeck",
  );
  assert.equal(r.length, 1);
});

test("filter decks: no match returns empty array", () => {
  assert.deepEqual(filterDecks(DECKS_FIXTURE, DEX_BY_ID, "wartortle"), []);
});

test("filter decks: null / missing card_ids handled (e.g. malformed row)", () => {
  const r = filterDecks(
    [{ id: "broken", name: "BrokenDeck" /* no card_ids */ }],
    DEX_BY_ID,
    "broken",
  );
  assert.equal(r.length, 1);
});
