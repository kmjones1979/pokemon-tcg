// Tests for the trainer-avatar roster + unlock logic.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  ROSTER, TIERS, DEFAULT_KEY,
  getAvatar, isValidKey, unlockedForLevel, newlyUnlocked,
} = require("../server-modules/avatars");

test("roster has the expected shape", () => {
  assert.ok(Array.isArray(ROSTER) && ROSTER.length >= 20, `roster too small: ${ROSTER.length}`);
  for (const a of ROSTER) {
    assert.ok(typeof a.key === "string" && a.key.length, "every entry has a key");
    assert.ok(typeof a.name === "string" && a.name.length, "every entry has a name");
    assert.ok(typeof a.sprite === "string" && /^https?:\/\//.test(a.sprite), `${a.key} has a URL sprite`);
    assert.ok(Number.isInteger(a.levelRequired) && a.levelRequired >= 1, `${a.key} has a positive levelRequired`);
  }
});

test("roster keys are unique", () => {
  const keys = ROSTER.map((a) => a.key);
  assert.equal(new Set(keys).size, keys.length, "no dup keys");
});

test("default avatar exists in the roster and is free at L1", () => {
  const def = getAvatar(DEFAULT_KEY);
  assert.ok(def, "default key resolves");
  assert.equal(def.levelRequired, 1, "default is L1");
});

test("tiers list is sorted and starts at 1", () => {
  assert.equal(TIERS[0], 1, "first tier is L1");
  for (let i = 1; i < TIERS.length; i++) {
    assert.ok(TIERS[i] > TIERS[i - 1], `tiers monotonically increasing: ${TIERS.join(",")}`);
  }
});

test("every tier has at least two trainers (male + female pair)", () => {
  for (const tier of TIERS) {
    const here = ROSTER.filter((a) => a.levelRequired === tier);
    assert.ok(here.length >= 2, `tier L${tier} has ${here.length} entries`);
  }
});

test("isValidKey accepts roster keys, rejects others", () => {
  assert.equal(isValidKey(ROSTER[0].key), true);
  assert.equal(isValidKey("not-a-trainer"), false);
  assert.equal(isValidKey(""), false);
  assert.equal(isValidKey(null), false);
});

test("unlockedForLevel(1) returns only the L1 starters", () => {
  const u = unlockedForLevel(1);
  const startersInRoster = ROSTER.filter((a) => a.levelRequired === 1).map((a) => a.key);
  assert.deepEqual(u.sort(), startersInRoster.sort(), "L1 set matches starter pair");
});

test("unlockedForLevel grows monotonically as level increases", () => {
  let prev = unlockedForLevel(1).length;
  for (let lvl = 2; lvl <= 99; lvl++) {
    const here = unlockedForLevel(lvl).length;
    assert.ok(here >= prev, `unlocked count drops between L${lvl - 1} and L${lvl}`);
    prev = here;
  }
});

test("unlockedForLevel(99) returns the full roster", () => {
  assert.equal(unlockedForLevel(99).length, ROSTER.length, "L99 unlocks everything");
});

test("unlockedForLevel handles invalid inputs as L1", () => {
  assert.deepEqual(unlockedForLevel(0).sort(),    unlockedForLevel(1).sort());
  assert.deepEqual(unlockedForLevel(-5).sort(),   unlockedForLevel(1).sort());
  assert.deepEqual(unlockedForLevel(null).sort(), unlockedForLevel(1).sort());
});

test("newlyUnlocked returns the trainers in (from, to]", () => {
  // Crossing from L9 to L10 unlocks the L10 tier (and nothing else).
  const tier10 = ROSTER.filter((a) => a.levelRequired === 10).map((a) => a.key);
  assert.deepEqual(newlyUnlocked(9, 10).sort(), tier10.sort());
});

test("newlyUnlocked returns multiple tiers if jumped across", () => {
  // Big jump (e.g. admin XP airdrop) from L1 to L25 should grant
  // both the L10 and L20 tiers in one go.
  const want = ROSTER
    .filter((a) => a.levelRequired > 1 && a.levelRequired <= 25)
    .map((a) => a.key);
  assert.deepEqual(newlyUnlocked(1, 25).sort(), want.sort());
});

test("newlyUnlocked returns nothing if no tier was crossed", () => {
  assert.deepEqual(newlyUnlocked(10, 10), []);
  assert.deepEqual(newlyUnlocked(11, 19), []);
  assert.deepEqual(newlyUnlocked(99, 99), []);
});

test("newlyUnlocked returns nothing on a downward / zero step", () => {
  // Defensive — XP should only go up but make sure we don't crash.
  assert.deepEqual(newlyUnlocked(20, 10), []);
  assert.deepEqual(newlyUnlocked(0, 0), []);
});
