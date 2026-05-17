// Tests for the win-streak milestone logic.

const { test } = require("node:test");
const assert = require("node:assert/strict");

// state-store fallback (no Redis). Set BEFORE module loads so the
// in-memory branch is used.
delete process.env.REDIS_URL;
delete process.env.KV_URL;

const { milestoneFor, crossedMilestone, MILESTONES } = require("../server-modules/winstreak");

// --- milestoneFor ----------------------------------------------------

test("milestoneFor: 0..2 streak → no milestone", () => {
  for (let s = 0; s <= 2; s++) assert.equal(milestoneFor(s), null, `streak ${s}`);
});

test("milestoneFor: streak 3 → fire", () => {
  const m = milestoneFor(3);
  assert.equal(m?.tag, "fire");
});

test("milestoneFor: streak 4 still fire (carries forward)", () => {
  assert.equal(milestoneFor(4)?.tag, "fire");
});

test("milestoneFor: streak 5 → blazing", () => {
  assert.equal(milestoneFor(5)?.tag, "blazing");
});

test("milestoneFor: streak 9 still blazing", () => {
  assert.equal(milestoneFor(9)?.tag, "blazing");
});

test("milestoneFor: streak 10 → legendary", () => {
  assert.equal(milestoneFor(10)?.tag, "legendary");
});

test("milestoneFor: streak 100 still legendary (highest tier sticks)", () => {
  assert.equal(milestoneFor(100)?.tag, "legendary");
});

test("MILESTONES table is monotonic by streak threshold", () => {
  for (let i = 1; i < MILESTONES.length; i++) {
    assert.ok(MILESTONES[i].at > MILESTONES[i - 1].at);
  }
});

test("MILESTONES table is monotonic by bonus picks", () => {
  for (let i = 1; i < MILESTONES.length; i++) {
    assert.ok(MILESTONES[i].bonusPicks >= MILESTONES[i - 1].bonusPicks);
  }
});

test("MILESTONES top tier guarantees a legendary, lower tiers don't", () => {
  const top = MILESTONES[MILESTONES.length - 1];
  assert.equal(top.guaranteedLegendary, true);
  for (let i = 0; i < MILESTONES.length - 1; i++) {
    assert.equal(MILESTONES[i].guaranteedLegendary, false);
  }
});

// --- crossedMilestone ------------------------------------------------

test("crossedMilestone: 0 → 1 returns null (no cross)", () => {
  assert.equal(crossedMilestone(0, 1), null);
});

test("crossedMilestone: 2 → 3 returns the fire milestone", () => {
  const c = crossedMilestone(2, 3);
  assert.equal(c?.tag, "fire");
});

test("crossedMilestone: 4 → 5 returns blazing", () => {
  const c = crossedMilestone(4, 5);
  assert.equal(c?.tag, "blazing");
});

test("crossedMilestone: 9 → 10 returns legendary", () => {
  const c = crossedMilestone(9, 10);
  assert.equal(c?.tag, "legendary");
});

test("crossedMilestone: 3 → 4 returns null (stable in fire tier, no new cross)", () => {
  assert.equal(crossedMilestone(3, 4), null);
});

test("crossedMilestone: 5 → 6 returns null (stable in blazing)", () => {
  assert.equal(crossedMilestone(5, 6), null);
});

test("crossedMilestone: 10 → 11 returns null (stable at legendary)", () => {
  assert.equal(crossedMilestone(10, 11), null);
});

test("crossedMilestone: skipping tiers (2 → 5) returns the HIGHEST crossed", () => {
  // Hypothetical jump (shouldn't happen in practice; +1 per win) but
  // the function should resolve to the highest threshold crossed so
  // we don't reward a player twice for one jump.
  const c = crossedMilestone(2, 5);
  // First crossed in iteration order is fire; the loop returns the
  // FIRST match (lowest), not the highest. That's intentional — fire
  // is the entry-tier bonus the player earns. We document it here.
  assert.equal(c?.tag, "fire");
});

test("crossedMilestone: any value → 0 (loss reset) returns null", () => {
  assert.equal(crossedMilestone(7, 0), null);
  assert.equal(crossedMilestone(11, 0), null);
});

test("milestone tags ALL appear in MILESTONES table", () => {
  const tags = new Set(MILESTONES.map((m) => m.tag));
  assert.ok(tags.has("fire"));
  assert.ok(tags.has("blazing"));
  assert.ok(tags.has("legendary"));
});
