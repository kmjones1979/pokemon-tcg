// Tests for the guest-state sanitizer + cap logic.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { sanitize, PER_CARD_CAP, TOTAL_GRANT_CAP } = require("../server-modules/guest-migrate");

test("empty body produces empty entries", () => {
  const r = sanitize({});
  assert.equal(r.entries.length, 0);
  assert.equal(r.storyProgress.length, 0);
  assert.equal(r.championWins.length, 0);
});

test("normal ownedCards object passes through", () => {
  const r = sanitize({ ownedCards: { 6: 1, 25: 2 } });
  assert.equal(r.entries.length, 2);
  assert.deepEqual(
    r.entries.sort((a, b) => a.pokemonId - b.pokemonId),
    [{ pokemonId: 6, quantity: 1 }, { pokemonId: 25, quantity: 2 }],
  );
});

test("quantity > PER_CARD_CAP is clamped", () => {
  const r = sanitize({ ownedCards: { 1: 99 } });
  assert.equal(r.entries[0].quantity, PER_CARD_CAP);
});

test("total grant respects TOTAL_GRANT_CAP", () => {
  // 20 different pokemon at PER_CARD_CAP (5 each) = 100 — exceeds cap.
  const owned = {};
  for (let i = 1; i <= 20; i++) owned[i] = PER_CARD_CAP;
  const r = sanitize({ ownedCards: owned });
  const total = r.entries.reduce((s, e) => s + e.quantity, 0);
  assert.ok(total <= TOTAL_GRANT_CAP, `total ${total} should be <= ${TOTAL_GRANT_CAP}`);
});

test("invalid pokemon ids are dropped", () => {
  const r = sanitize({ ownedCards: { "abc": 1, "0": 2, "-1": 3, "6": 1 } });
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].pokemonId, 6);
});

test("quantity <= 0 is dropped", () => {
  const r = sanitize({ ownedCards: { 6: 0, 7: -1, 8: 1 } });
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].pokemonId, 8);
});

test("non-array storyProgress becomes empty", () => {
  assert.deepEqual(sanitize({ storyProgress: "not-an-array" }).storyProgress, []);
  assert.deepEqual(sanitize({ storyProgress: null }).storyProgress, []);
  assert.deepEqual(sanitize({ storyProgress: { 0: "ch1" } }).storyProgress, []);
});

test("storyProgress array passes through (server-side dedupes later)", () => {
  const r = sanitize({ storyProgress: ["ch1_viridian", "ch2_mt_moon"] });
  assert.deepEqual(r.storyProgress, ["ch1_viridian", "ch2_mt_moon"]);
});

test("championWins array passes through", () => {
  const r = sanitize({ championWins: ["lance", "red"] });
  assert.deepEqual(r.championWins, ["lance", "red"]);
});

test("absurdly large owned map gets entry-capped at 100", () => {
  const owned = {};
  for (let i = 1; i <= 500; i++) owned[i] = 1;
  const r = sanitize({ ownedCards: owned });
  assert.ok(r.entries.length <= 100, `expected ≤ 100 entries, got ${r.entries.length}`);
});
