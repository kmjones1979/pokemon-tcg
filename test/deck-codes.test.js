// Tests for the deck-code encoder/decoder.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { encodeDeckIds, decodeDeckCode, DECK_SIZE, MAX_ID } = require("../shared/deck-codes");

function makeIds(fn) {
  return Array.from({ length: DECK_SIZE }, (_, i) => fn(i));
}

test("round-trip a simple incrementing deck", () => {
  const ids = makeIds((i) => i + 1); // 1..30
  const code = encodeDeckIds(ids);
  const back = decodeDeckCode(code);
  assert.deepEqual(back, ids);
});

test("round-trip a deck containing the maximum id (1025)", () => {
  const ids = makeIds((i) => 1025 - i); // 1025..996
  const back = decodeDeckCode(encodeDeckIds(ids));
  assert.deepEqual(back, ids);
});

test("round-trip preserves order (decks are lists, not sets)", () => {
  const ids = [6, 9, 3, 25, 65, 150, 144, 145, 146, 1,
                2, 4, 5, 7, 8, 10, 11, 12, 13, 14,
                15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
  const back = decodeDeckCode(encodeDeckIds(ids));
  assert.deepEqual(back, ids);
});

test("round-trip allows duplicates (≤ 2 of each is a deck rule, not an encoder rule)", () => {
  const ids = makeIds(() => 6); // all Charizard
  const back = decodeDeckCode(encodeDeckIds(ids));
  assert.deepEqual(back, ids);
});

test("encoded code is a URL-safe base64url string", () => {
  const code = encodeDeckIds(makeIds((i) => i + 1));
  assert.match(code, /^[A-Za-z0-9_-]+$/, `code "${code}" should be url-safe`);
  // No padding chars.
  assert.ok(!code.includes("="));
});

test("encoded code length is consistent (~62 chars)", () => {
  const code = encodeDeckIds(makeIds((i) => i + 1));
  // 46 bytes → ceil(46 * 4 / 3) = 62 chars without padding.
  assert.equal(code.length, 62);
});

test("rejects wrong deck size", () => {
  assert.throws(() => encodeDeckIds([1, 2, 3]), /expected 30 ids/);
  assert.throws(() => encodeDeckIds(makeIds((i) => i + 1).concat([99])), /expected 30 ids/);
});

test("rejects non-array input", () => {
  assert.throws(() => encodeDeckIds(null), /ids must be an array/);
  assert.throws(() => encodeDeckIds("nope"), /ids must be an array/);
});

test("rejects invalid id values", () => {
  const ids = makeIds((i) => i + 1);
  ids[5] = 0;
  assert.throws(() => encodeDeckIds(ids), /invalid id/);
  ids[5] = -1;
  assert.throws(() => encodeDeckIds(ids), /invalid id/);
  ids[5] = MAX_ID + 1;
  assert.throws(() => encodeDeckIds(ids), /invalid id/);
  ids[5] = 1.5;
  assert.throws(() => encodeDeckIds(ids), /invalid id/);
});

test("decodeDeckCode rejects empty / non-string input", () => {
  assert.throws(() => decodeDeckCode(""), /non-empty string/);
  assert.throws(() => decodeDeckCode(null), /non-empty string/);
  assert.throws(() => decodeDeckCode(undefined), /non-empty string/);
});

test("decodeDeckCode rejects truncated code", () => {
  const valid = encodeDeckIds(makeIds((i) => i + 1));
  assert.throws(() => decodeDeckCode(valid.slice(0, 10)), /truncated|invalid/);
});

test("decodeDeckCode rejects unsupported version byte", () => {
  // First base64 char encodes 6 bits, our version byte is 1 — flip
  // to a code whose first byte is something else.
  const valid = encodeDeckIds(makeIds((i) => i + 1));
  // Swap the first character to something that decodes to a different
  // version byte. "g" = 0x80 0x... — first byte = 0x80 → version 0x80
  const tampered = "Z" + valid.slice(1);
  assert.throws(() => decodeDeckCode(tampered), /version/i);
});

test("two encodes with same input produce same output (deterministic)", () => {
  const ids = makeIds((i) => (i * 33) % 1025 + 1);
  assert.equal(encodeDeckIds(ids), encodeDeckIds(ids));
});
