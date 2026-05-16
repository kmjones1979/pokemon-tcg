const { test } = require("node:test");
const assert = require("node:assert/strict");
const { toCard, buildDeck, tierFromBst } = require("../shared/deck-builder");

// Build a synthetic Pokédex spanning all tiers so the deck builder always has
// enough variety to satisfy the default distribution.
function synthDex(n = 200) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    // Vary BST to spread across tiers: cycle 200..720
    const bst = 200 + ((i * 37) % 521);
    const per = Math.round(bst / 6);
    rows.push({
      id: i,
      name: `Mon${i}`,
      slug: `mon${i}`,
      types: [["fire", "water", "grass", "electric"][i % 4]],
      hp: per,
      attack: per,
      defense: per,
      sp_attack: per,
      sp_defense: per,
      speed: per,
      sprite_front: null,
      generation: 1,
      is_legendary: false,
      is_mythical: false,
    });
  }
  return rows.map(toCard);
}

test("tierFromBst boundaries", () => {
  assert.equal(tierFromBst(0).tier, 1);
  assert.equal(tierFromBst(349).tier, 1);
  assert.equal(tierFromBst(350).tier, 2);
  assert.equal(tierFromBst(449).tier, 2);
  assert.equal(tierFromBst(450).tier, 3);
  assert.equal(tierFromBst(524).tier, 3);
  assert.equal(tierFromBst(525).tier, 4);
  assert.equal(tierFromBst(599).tier, 4);
  assert.equal(tierFromBst(600).tier, 5);
  assert.equal(tierFromBst(720).tier, 5);
});

test("tier energy cost mapping", () => {
  assert.equal(tierFromBst(300).cost, 1);
  assert.equal(tierFromBst(400).cost, 2);
  assert.equal(tierFromBst(500).cost, 3);
  assert.equal(tierFromBst(580).cost, 5);
  assert.equal(tierFromBst(680).cost, 7);
});

test("toCard derives cardHp = round(hp/10) and cardAttack = round((atk+sp_atk)/30)", () => {
  const row = {
    id: 1, name: "Test", slug: "test", types: ["fire"],
    hp: 70, attack: 80, defense: 50, sp_attack: 70, sp_defense: 50, speed: 30,
    sprite_front: null, generation: 1,
  };
  const c = toCard(row);
  assert.equal(c.cardHp, Math.round(70 / 10));
  assert.equal(c.cardAttack, Math.round((80 + 70) / 30));
  assert.equal(c.bst, 70 + 80 + 50 + 70 + 50 + 30); // 350 → tier 2 boundary
  assert.equal(c.tier, 2);
  assert.equal(c.energyCost, 2);
});

test("buildDeck returns exactly 30 cards", () => {
  const dex = synthDex(300);
  const deck = buildDeck(dex, { seed: "abc" });
  assert.equal(deck.length, 30);
});

test("buildDeck respects 2-copies-max rule", () => {
  const dex = synthDex(300);
  const deck = buildDeck(dex, { seed: "abc" });
  const counts = new Map();
  for (const c of deck) counts.set(c.id, (counts.get(c.id) || 0) + 1);
  for (const [, n] of counts) {
    assert.ok(n <= 2, `no card should appear more than 2x`);
  }
});

test("buildDeck approximates the tier distribution 10/10/6/3/1", () => {
  const dex = synthDex(300);
  const deck = buildDeck(dex, { seed: "deterministic" });
  const tiers = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const c of deck) tiers[c.tier] = (tiers[c.tier] || 0) + 1;
  assert.equal(tiers[1], 10);
  assert.equal(tiers[2], 10);
  assert.equal(tiers[3], 6);
  assert.equal(tiers[4], 3);
  assert.equal(tiers[5], 1);
});

test("buildDeck is deterministic for the same seed", () => {
  const dex = synthDex(300);
  const a = buildDeck(dex, { seed: "fixed" }).map((c) => c.id);
  const b = buildDeck(dex, { seed: "fixed" }).map((c) => c.id);
  assert.deepEqual(a, b);
});

test("buildDeck differs across seeds", () => {
  const dex = synthDex(300);
  const a = buildDeck(dex, { seed: "one" }).map((c) => c.id).join(",");
  const b = buildDeck(dex, { seed: "two" }).map((c) => c.id).join(",");
  assert.notEqual(a, b);
});
