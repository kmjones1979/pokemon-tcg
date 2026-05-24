// Reward drop-rule tests.
//
// New difficulty-gated rarity rules (see server-modules/rewards.js):
//   easy   + win → 0 picks   (handled at the route layer)
//   medium + win → 1 pick from common/uncommon (T1+T2), no legendaries
//   hard   + win → 1 pick from rare/epic/legendary (T3-T5)
//   any loss     → 0 picks
//
// These tests cover the pure-function layer (rollPicks + rarityForCard).
// Route-level wiring is covered by the existing server-boot smoke tests.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  rollPicks,
  rarityForCard,
  MEDIUM_WEIGHTS,
  HARD_WEIGHTS,
  RARITY_BY_TIER,
} = require("../server-modules/rewards");

// Tiny pokedex spanning all five tiers + a few flagged legendaries that
// happen to live in odd tier slots (defensive coverage for the medium-tier
// rarityFilter).
function fixture() {
  return [
    // T1 — common
    { id: 1, name: "PidgeyOne",   types: ["normal"], tier: 1, energyCost: 1, cardHp: 1, cardAttack: 1, sprite_front: "" },
    { id: 2, name: "PidgeyTwo",   types: ["normal"], tier: 1, energyCost: 1, cardHp: 1, cardAttack: 1, sprite_front: "" },
    // T2 — uncommon
    { id: 3, name: "RattataOne",  types: ["normal"], tier: 2, energyCost: 2, cardHp: 2, cardAttack: 2, sprite_front: "" },
    { id: 4, name: "RattataTwo",  types: ["normal"], tier: 2, energyCost: 2, cardHp: 2, cardAttack: 2, sprite_front: "" },
    // T3 — rare
    { id: 5, name: "GyaradosOne", types: ["water"],  tier: 3, energyCost: 3, cardHp: 3, cardAttack: 3, sprite_front: "" },
    { id: 6, name: "GyaradosTwo", types: ["water"],  tier: 3, energyCost: 3, cardHp: 3, cardAttack: 3, sprite_front: "" },
    // T4 — epic
    { id: 7, name: "DragoniteOne",types: ["dragon"], tier: 4, energyCost: 4, cardHp: 4, cardAttack: 4, sprite_front: "" },
    { id: 8, name: "DragoniteTwo",types: ["dragon"], tier: 4, energyCost: 4, cardHp: 4, cardAttack: 4, sprite_front: "" },
    // T5 — legendary tier (some flagged, some not)
    { id: 9, name: "MewtwoLeg",   types: ["psychic"],tier: 5, energyCost: 5, cardHp: 5, cardAttack: 5, sprite_front: "", is_legendary: true  },
    { id:10, name: "MewMyth",     types: ["psychic"],tier: 5, energyCost: 5, cardHp: 5, cardAttack: 5, sprite_front: "", is_mythical: true   },
    { id:11, name: "ArticunoLeg", types: ["ice"],    tier: 5, energyCost: 5, cardHp: 5, cardAttack: 5, sprite_front: "", is_legendary: true  },
    // Defensive: a flagged legendary that mis-tags as T2 (shouldn't ever
    // happen in the live dex, but the medium filter must still exclude it).
    { id:12, name: "OddLeg",      types: ["fairy"],  tier: 2, energyCost: 2, cardHp: 2, cardAttack: 2, sprite_front: "", is_legendary: true  },
  ];
}

// Deterministic RNG so tests don't flake. Cycles a fixed sequence of
// floats in [0,1).
function seededRand(seq) {
  let i = 0;
  return () => {
    const v = seq[i % seq.length];
    i++;
    return v;
  };
}

test("rarityForCard maps tiers 1-5 to common/uncommon/rare/epic/legendary", () => {
  assert.equal(rarityForCard({ tier: 1 }), "common");
  assert.equal(rarityForCard({ tier: 2 }), "uncommon");
  assert.equal(rarityForCard({ tier: 3 }), "rare");
  assert.equal(rarityForCard({ tier: 4 }), "epic");
  assert.equal(rarityForCard({ tier: 5 }), "legendary");
  // is_legendary / is_mythical override tier — keeps the player-facing
  // ladder honest even if a flagged Pokémon sits in a low tier slot.
  assert.equal(rarityForCard({ tier: 2, is_legendary: true }), "legendary");
  assert.equal(rarityForCard({ tier: 3, is_mythical: true }), "legendary");
  // Unknown tier falls through to common rather than throwing.
  assert.equal(rarityForCard({ tier: 99 }), "common");
});

test("RARITY_BY_TIER ladder is the five rarities in order", () => {
  assert.deepEqual(RARITY_BY_TIER, {
    1: "common", 2: "uncommon", 3: "rare", 4: "epic", 5: "legendary",
  });
});

test("medium-difficulty roll only returns common/uncommon (T1+T2) and no legendaries", () => {
  const dex = fixture();
  // Roll a bunch of picks to exercise the weighting path. The fixture has
  // 4 non-legendary T1+T2 cards; after picking all 4 the seen-set
  // saturates and rollPicks will stop (safety cap).
  const picks = rollPicks(dex, 4, Math.random, {
    weights: MEDIUM_WEIGHTS,
    rarityFilter: (c) => !c.is_legendary && !c.is_mythical,
    themeBias: 0, // turn off theme bonus so the test is deterministic-ish
    themeType: null,
  });
  assert.equal(picks.length, 4);
  for (const p of picks) {
    assert.ok([1, 2].includes(p.tier), `pick tier ${p.tier} leaked out of medium pool`);
    assert.ok(!p.is_legendary, `legendary ${p.name} leaked into medium pool`);
    assert.ok(!p.is_mythical,  `mythical ${p.name} leaked into medium pool`);
  }
});

test("medium-difficulty rarityFilter excludes a flagged-legendary card even if its tier is in range", () => {
  // Build a pool that contains ONLY a single tier-2 legendary. With the
  // filter active, rollPicks should refuse to draw it and return [].
  const dex = [
    { id: 99, name: "OnlyLeg", types: ["fairy"], tier: 2, energyCost: 2, cardHp: 2, cardAttack: 2, sprite_front: "", is_legendary: true },
  ];
  const picks = rollPicks(dex, 1, Math.random, {
    weights: MEDIUM_WEIGHTS,
    rarityFilter: (c) => !c.is_legendary && !c.is_mythical,
    themeType: null,
    themeBias: 0,
  });
  assert.equal(picks.length, 0);
});

test("hard-difficulty roll only returns rare/epic/legendary (T3-T5)", () => {
  const dex = fixture();
  // 100 trials, fresh rand each time, every pick must land in T3-T5.
  for (let trial = 0; trial < 100; trial++) {
    const picks = rollPicks(dex, 1, Math.random, {
      weights: HARD_WEIGHTS,
      themeType: null,
      themeBias: 0,
    });
    assert.equal(picks.length, 1);
    const t = picks[0].tier;
    assert.ok([3, 4, 5].includes(t), `hard pull yielded tier ${t} (${picks[0].name})`);
  }
});

test("hard-difficulty roll DOES reach legendary (T5) eventually", () => {
  // Sanity check: HARD_WEIGHTS includes T5 with 10% weight, so across
  // many trials we expect at least one legendary. Tolerance is loose.
  const dex = fixture();
  let sawT5 = 0;
  for (let trial = 0; trial < 200; trial++) {
    const picks = rollPicks(dex, 1, Math.random, {
      weights: HARD_WEIGHTS,
      themeType: null,
      themeBias: 0,
    });
    if (picks[0]?.tier === 5) sawT5++;
  }
  assert.ok(sawT5 >= 5, `expected ≥5 legendary pulls in 200 trials, got ${sawT5}`);
});

test("rollPicks fallback walks ONLY allowed tiers (regression: don't bleed across rarities)", () => {
  // Force the weighted tier to land on an empty bucket so the fallback
  // kicks in. Pool only has T1+T2 cards. With weights={1:60,2:40} and
  // rarityFilter excluding legendaries, the fallback must NEVER return a
  // T3+ card even if it existed in the dex.
  const dex = [
    { id: 1, name: "T1a", tier: 1, types: ["normal"], energyCost: 1, cardHp: 1, cardAttack: 1, sprite_front: "" },
    { id: 5, name: "T3a", tier: 3, types: ["normal"], energyCost: 3, cardHp: 3, cardAttack: 3, sprite_front: "" },
    { id: 7, name: "T4a", tier: 4, types: ["normal"], energyCost: 4, cardHp: 4, cardAttack: 4, sprite_front: "" },
  ];
  // Seed forces the tier roll to "2" (which has no cards), exercising the
  // fallback path. The fallback should still only pick from {1,2}.
  const rand = seededRand([0.7, 0.5, 0.5, 0.5]);
  const picks = rollPicks(dex, 1, rand, {
    weights: { 1: 1, 2: 99 },  // overwhelmingly favors empty T2 bucket
    themeType: null,
    themeBias: 0,
  });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].tier, 1, "fallback leaked to a disallowed tier");
});
