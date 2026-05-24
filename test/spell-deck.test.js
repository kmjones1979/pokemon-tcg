// Deck-mixing tests for spell cards.
//
// Contract: every deck = 30 Pokémon + 10 spell cards (= 40 total).
// Spells are appended after the Pokémon section, so the 30-card
// tier-distribution shape is preserved. If the pokedex has no spells
// in it (e.g. tests using a synth dex) the deck stays at 30 cards.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { toCard, buildDeck, DEFAULT_SPELL_COUNT } = require("../shared/deck-builder");
const { allSpellCards, isSpellCard } = require("../shared/spell-cards");

function synthPokemon(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    const bst = 200 + ((i * 37) % 521);
    const per = Math.round(bst / 6);
    rows.push({
      id: i, name: `Mon${i}`, slug: `mon${i}`,
      types: [["fire", "water", "grass", "electric"][i % 4]],
      hp: per, attack: per, defense: per,
      sp_attack: per, sp_defense: per, speed: per,
      sprite_front: null, generation: 1,
      is_legendary: false, is_mythical: false,
    });
  }
  return rows.map(toCard);
}

test("default spell count is 10 (constant pinned)", () => {
  // If this changes, decks ship a different number of spells. Worth
  // forcing a deliberate code change rather than a silent drift.
  assert.equal(DEFAULT_SPELL_COUNT, 10);
});

test("deck built from a Pokémon-only pokedex stays at 30 cards (no spells available)", () => {
  // Tests using synthPokemon don't carry spells. buildDeck should not
  // crash and should not pad with placeholder cards.
  const dex = synthPokemon(300);
  const deck = buildDeck(dex, { seed: "no-spells" });
  assert.equal(deck.length, 30, "no spells in dex → no spells in deck");
});

test("deck built from a mixed pokedex = 30 Pokémon + 10 spells = 40 total", () => {
  const dex = [...synthPokemon(300), ...allSpellCards()];
  const deck = buildDeck(dex, { seed: "mixed" });
  assert.equal(deck.length, 40, "expected 30 Pokémon + 10 spells = 40 total");
  const pokemons = deck.filter((c) => !isSpellCard(c));
  const spells   = deck.filter((c) =>  isSpellCard(c));
  assert.equal(pokemons.length, 30);
  assert.equal(spells.length, 10);
});

test("the 30-Pokémon section still respects the tier distribution", () => {
  // Regression: previously buildDeck used the WHOLE pokedex for the
  // tier-bucketed section. Now it filters to Pokémon first — confirm
  // the tier distribution (10/10/6/3/1) still holds with spells in the
  // dex.
  const dex = [...synthPokemon(300), ...allSpellCards()];
  const deck = buildDeck(dex, { seed: "tier-pinned" });
  const tiers = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const c of deck) {
    if (isSpellCard(c)) continue;
    tiers[c.tier] = (tiers[c.tier] || 0) + 1;
  }
  assert.equal(tiers[1], 10);
  assert.equal(tiers[2], 10);
  assert.equal(tiers[3], 6);
  assert.equal(tiers[4], 3);
  assert.equal(tiers[5], 1);
});

test("the 2-copies-max rule still applies to Pokémon (not to spells)", () => {
  // Pokémon: each id can appear at most twice. Spells: slice 1 ships
  // only Freeze so all 10 spell slots must be Freeze → spells SKIP the
  // 2-copies rule by design (it's sampled with replacement).
  const dex = [...synthPokemon(300), ...allSpellCards()];
  const deck = buildDeck(dex, { seed: "two-max" });
  const counts = new Map();
  for (const c of deck) {
    if (isSpellCard(c)) continue;
    counts.set(c.id, (counts.get(c.id) || 0) + 1);
  }
  for (const [, n] of counts) {
    assert.ok(n <= 2, `Pokémon should never appear more than 2x; got ${n}`);
  }
});

test("buildDeck is deterministic with the same seed (Pokémon + spell sections)", () => {
  const dex = [...synthPokemon(300), ...allSpellCards()];
  const a = buildDeck(dex, { seed: "fixed" }).map((c) => c.id);
  const b = buildDeck(dex, { seed: "fixed" }).map((c) => c.id);
  assert.deepEqual(a, b);
});

test("a player can override spellCount (e.g. 0 disables spells for a draft mode)", () => {
  const dex = [...synthPokemon(300), ...allSpellCards()];
  const deck = buildDeck(dex, { seed: "no-spell-override", spellCount: 0 });
  assert.equal(deck.length, 30);
  assert.equal(deck.filter(isSpellCard).length, 0);
});

test("with all six spells active, decks include a mix (not just Freeze)", () => {
  // Slice 2 contract: any of the six effects can appear in a deck.
  // Across 30 trials we should see at least 3 distinct effects.
  const dex = [...synthPokemon(100), ...allSpellCards()];
  const seenEffects = new Set();
  for (let i = 0; i < 30 && seenEffects.size < 6; i++) {
    const deck = buildDeck(dex, { seed: `mix-${i}` });
    for (const s of deck.filter(isSpellCard)) seenEffects.add(s.effect);
  }
  assert.ok(seenEffects.size >= 3, `expected ≥3 distinct spell effects across 30 decks, got ${seenEffects.size}: ${[...seenEffects].join(", ")}`);
});
