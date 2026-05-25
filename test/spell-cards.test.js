// Spell-card catalog + helpers. The catalog is the data layer; engine
// integration is tested separately in spell-engine.test.mjs.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  SPELL_CARDS,
  ACTIVE_EFFECTS,
  spellToCard,
  allSpellCards,
  isSpellCard,
  isActiveSpellEffect,
  spellById,
  energyCostFromPower,
  tierFromSpellCost,
  SPELL_BASE_ID,
} = require("../shared/spell-cards");

const KNOWN_RARITIES = new Set(["common", "uncommon", "rare", "epic", "legendary"]);

test("SPELL_CARDS contains all 24 designed spells (slice 1-8)", () => {
  const effects = SPELL_CARDS.map((s) => s.effect).sort();
  assert.deepEqual(effects, [
    "aoe", "bolt", "brave-strike", "burn", "burst", "cleanse", "confusion",
    "counter", "defender", "drain", "evolve", "freeze", "heal", "mass-heal",
    "paralyze", "phoenix", "power-strike", "refresh", "scout", "shield",
    "sleep-powder", "stop-time", "storm", "surge",
  ]);
});

test("every spell has the fields the engine + UI need", () => {
  const required = ["id", "kind", "name", "effect", "target", "types", "glyph",
                    "power", "rarity", "description", "flavor_text"];
  for (const s of SPELL_CARDS) {
    for (const k of required) {
      assert.ok(k in s, `${s.name || "?"} missing field "${k}"`);
    }
    assert.equal(s.kind, "spell");
    assert.ok(KNOWN_RARITIES.has(s.rarity), `${s.name} has unknown rarity ${s.rarity}`);
    assert.ok(s.id >= SPELL_BASE_ID, `${s.name} id ${s.id} collides with Pokémon ID space`);
  }
});

test("spell IDs are unique and start above the Pokémon ID range", () => {
  // Pokémon IDs are <2000. Spell IDs start at SPELL_BASE_ID (10000+) so
  // they never collide with PokeAPI ids in owned_cards / drop offers.
  const ids = new Set();
  for (const s of SPELL_CARDS) {
    assert.ok(!ids.has(s.id), `duplicate spell id ${s.id}`);
    assert.ok(s.id > 2000, `spell id ${s.id} could collide with Pokémon space`);
    ids.add(s.id);
  }
});

test("energyCostFromPower scales: power 2→1, 4→2, 6→3, 8→4", () => {
  assert.equal(energyCostFromPower(2), 1);
  assert.equal(energyCostFromPower(4), 2);
  assert.equal(energyCostFromPower(6), 3);
  assert.equal(energyCostFromPower(8), 4);
  // floor for fractional / odd values; never below 1
  assert.equal(energyCostFromPower(1), 1);
  assert.equal(energyCostFromPower(0), 1);
});

test("tierFromSpellCost clamps to the 1..5 range deck-builder expects", () => {
  assert.equal(tierFromSpellCost(1), 1);
  assert.equal(tierFromSpellCost(4), 4);
  assert.equal(tierFromSpellCost(99), 5);
  assert.equal(tierFromSpellCost(0), 1);
});

test("spellToCard inflates a spell into the same shape as a Pokémon card", () => {
  // Tests just one canonical spell — the Pokémon-card shape contract is
  // the important bit (so downstream callers don't need to branch).
  const freeze = SPELL_CARDS.find((s) => s.effect === "freeze");
  const c = spellToCard(freeze);
  // Required Pokémon-card fields the rest of the codebase reads:
  for (const k of ["id", "name", "types", "tier", "energyCost", "cardHp",
                   "cardAttack", "rarity", "is_legendary", "is_mythical"]) {
    assert.ok(k in c, `spellToCard output missing "${k}"`);
  }
  assert.equal(c.kind, "spell");
  assert.equal(c.effect, "freeze");
  assert.equal(c.cardHp, 0,    "spell cards don't have HP");
  assert.equal(c.cardAttack, 0, "spell cards don't attack");
  assert.equal(c.is_legendary, false);
  assert.equal(c.is_mythical, false);
  assert.equal(c.energyCost, energyCostFromPower(freeze.power));
});

test("isSpellCard distinguishes spells from Pokémon", () => {
  const freeze = spellToCard(SPELL_CARDS[0]);
  const pokemon = { id: 25, name: "Pikachu", tier: 2 };
  assert.equal(isSpellCard(freeze), true);
  assert.equal(isSpellCard(pokemon), false);
  // Defensive: null / undefined don't crash.
  assert.equal(isSpellCard(null), false);
  assert.equal(isSpellCard(undefined), false);
});

test("isActiveSpellEffect: all 24 designed effects are active in slice 8", () => {
  for (const e of [
    "freeze", "paralyze", "heal", "defender", "evolve", "aoe",
    "bolt", "sleep-powder", "cleanse", "surge", "scout", "phoenix",
    "burn", "shield", "mass-heal", "power-strike", "counter", "stop-time",
    "confusion", "storm", "burst", "brave-strike", "refresh", "drain",
  ]) {
    assert.equal(isActiveSpellEffect(e), true, `${e} should be active`);
  }
  // Unknown effect names still report false (not a crash).
  assert.equal(isActiveSpellEffect("unknown"), false);
});

test("allSpellCards() returns all 24 active spells", () => {
  const cards = allSpellCards();
  for (const c of cards) {
    assert.ok(ACTIVE_EFFECTS.has(c.effect), `${c.name} (${c.effect}) leaked into active spells`);
  }
  assert.equal(cards.length, 24);
});

test("rarity bands cover every player tier (slice 6 expanded the spread)", () => {
  // Drop-pool sanity: with the new commons (Cleanse, Surge), medium
  // wins can now pull common-rarity spells. With the new legendary
  // (Phoenix), hard wins can pull a legendary spell.
  const byRarity = {};
  for (const c of allSpellCards()) {
    byRarity[c.rarity] = (byRarity[c.rarity] || 0) + 1;
  }
  assert.ok((byRarity.common      || 0) >= 1, "expected ≥1 common spell");
  assert.ok((byRarity.uncommon    || 0) >= 1, "expected ≥1 uncommon spell");
  assert.ok((byRarity.rare        || 0) >= 1, "expected ≥1 rare spell");
  assert.ok((byRarity.epic        || 0) >= 1, "expected ≥1 epic spell");
  assert.ok((byRarity.legendary   || 0) >= 1, "expected ≥1 legendary spell");
});

test("spellById looks up by Pokémon-card id and returns a card-shaped object", () => {
  const freeze = SPELL_CARDS.find((s) => s.effect === "freeze");
  const c = spellById(freeze.id);
  assert.ok(c);
  assert.equal(c.effect, "freeze");
  assert.equal(c.kind, "spell");
  // Unknown id returns null.
  assert.equal(spellById(99999), null);
});

test("Freeze is uncommon and costs 1 energy (slice 1 contract)", () => {
  // Pinning the specific values the user asked for so they can't drift
  // accidentally during a future refactor.
  const freeze = SPELL_CARDS.find((s) => s.effect === "freeze");
  assert.equal(freeze.rarity, "uncommon");
  assert.equal(freeze.target, "enemyField");
  assert.equal(freeze.types[0], "ice");
  const c = spellToCard(freeze);
  assert.equal(c.energyCost, 1);
});
