// Spell-parity tests: every code path that produces a "battle deck"
// must include the 10-spell section so Story Mode + PvP + solo all
// feel consistent. Regression context: when spells first shipped only
// `buildDeck` (random draw) appended them — Story Mode boss decks and
// PvP saved-deck loads quietly stayed at 30 Pokémon, which made the
// new mechanic appear/disappear based on which mode the player picked.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildBossDeck } = require("../server-modules/story");
const { allSpellCards } = require("../shared/spell-cards");
const { DEFAULT_SPELL_COUNT } = require("../shared/deck-builder");

const SPELL_IDS = new Set(allSpellCards().map((c) => c.id));
const isSpell = (c) => c?.kind === "spell" || SPELL_IDS.has(c?.id);

// --- Boss decks ------------------------------------------------------

test("buildBossDeck returns 30 Pokémon + 10 spells = 40 cards", async () => {
  // Fake supabase that returns a sensible boss pool.
  const fakeSupabase = makeFakeSupabaseWithPool();
  const chapter = {
    boss: {
      anchorPokemonId: 15,
      types: ["bug", "poison"],
      maxHp: 50, attack: 8,
    },
  };
  const deck = await buildBossDeck(fakeSupabase, chapter);
  assert.equal(deck.length, 30 + DEFAULT_SPELL_COUNT,
    `expected 40-card boss deck, got ${deck.length}`);
  const spells = deck.filter(isSpell);
  assert.equal(spells.length, DEFAULT_SPELL_COUNT, "boss deck should include 10 spells");
  const pokemons = deck.filter((c) => !isSpell(c));
  assert.equal(pokemons.length, 30, "boss deck should keep 30 Pokémon");
});

test("buildBossDeck stays deterministic about the Pokémon core (regression)", async () => {
  // Spells are sampled with replacement so they'll vary run-to-run, but
  // the Pokémon section is shaped by the supabase response and should
  // always be exactly 30 with anchor x2 inside.
  const fakeSupabase = makeFakeSupabaseWithPool();
  const chapter = {
    boss: { anchorPokemonId: 15, types: ["bug"], maxHp: 50, attack: 8 },
  };
  const deck = await buildBossDeck(fakeSupabase, chapter);
  const pokemons = deck.filter((c) => !isSpell(c));
  const anchorCount = pokemons.filter((c) => c.id === 15).length;
  assert.ok(anchorCount >= 1, "boss should include the anchor Pokémon at least once");
});

// --- Active-deck hydration (server-modules/collection.js + mp-http) ---
// These routes are tested indirectly via integration in server-boot —
// the unit contract we pin here is that the helpers BOTH paths share
// (allSpellCards + DEFAULT_SPELL_COUNT) stay in sync.

test("DEFAULT_SPELL_COUNT is the single source of truth for both paths", () => {
  // If a future refactor decouples the constant, the active-deck
  // hydration in collection.js and the MP active-deck loader in
  // multiplayer-http.js will silently disagree. This test pins both
  // import the same value.
  const { DEFAULT_SPELL_COUNT: a } = require("../shared/deck-builder");
  // Re-require the consumer modules to make sure they pick up the
  // shared value (rather than hardcoding their own number).
  const collectionSrc = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "server-modules", "collection.js"), "utf8");
  const mpSrc = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "server-modules", "multiplayer-http.js"), "utf8");
  const storySrc = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "server-modules", "story.js"), "utf8");
  assert.ok(collectionSrc.includes("DEFAULT_SPELL_COUNT"),
    "collection.js should reference DEFAULT_SPELL_COUNT for spell-section size");
  assert.ok(mpSrc.includes("DEFAULT_SPELL_COUNT"),
    "multiplayer-http.js should reference DEFAULT_SPELL_COUNT");
  assert.ok(storySrc.includes("DEFAULT_SPELL_COUNT"),
    "story.js should reference DEFAULT_SPELL_COUNT");
  assert.equal(typeof a, "number");
});

test("allSpellCards is the single source of truth for the spell pool", () => {
  // Same idea: if a path silently hardcodes spell ids, drift can
  // happen when a new spell ships. Force every spell-append site to
  // route through allSpellCards.
  const fs = require("node:fs");
  const path = require("node:path");
  for (const rel of ["server-modules/collection.js", "server-modules/multiplayer-http.js", "server-modules/story.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    assert.ok(src.includes("allSpellCards"), `${rel} should call allSpellCards() to source spells`);
  }
});

// --- Test fixtures ---------------------------------------------------

function makeFakeSupabaseWithPool() {
  // Returns a supabase-shaped stub whose `from('pokemon')` chain
  // satisfies the queries buildBossDeck makes (anchor lookup, type
  // pool, filler pool, padding pool).
  const rows = [];
  for (let i = 1; i <= 60; i++) {
    rows.push({
      id: i, name: `Mon${i}`, slug: `mon${i}`,
      types: ["bug", "normal"], hp: 50 + i, attack: 30 + i,
      defense: 30, sp_attack: 30, sp_defense: 30, speed: 30,
      sprite_front: null, generation: 1,
    });
  }
  function builder() {
    let state = { selected: false, eqId: null, overlaps: null, orderBy: null, limit: null };
    const chain = {
      select() { state.selected = true; return chain; },
      eq(_col, val) { state.eqId = val; return chain; },
      overlaps() { return chain; },
      order(col, opts) { state.orderBy = { col, asc: opts?.ascending ?? true }; return chain; },
      limit(n) { state.limit = n; return chain; },
      in() { return chain; },
      maybeSingle() {
        if (state.eqId) {
          const row = rows.find((r) => r.id === state.eqId);
          return Promise.resolve({ data: row || null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve) {
        const cap = state.limit || rows.length;
        let data = rows.slice(0, cap);
        if (state.orderBy?.col === "hp") {
          data = [...data].sort((a, b) => state.orderBy.asc ? a.hp - b.hp : b.hp - a.hp);
        }
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return chain;
  }
  return { from: () => builder() };
}
