// Drop-rate / rarity-classification tests.
//
// Rules under test (see server-modules/rewards.js + shared/deck-builder.js):
//   - Every Pokémon classifies into exactly one of:
//       common, uncommon, rare, epic, legendary
//     Driven by BST tier + the is_legendary / is_mythical flags.
//   - easy   + win → 0 picks   (handled at the route layer)
//   - medium + win → 1 pick from {common, uncommon, rare}
//   - hard   + win → 1 pick from {epic, legendary}
//   - any loss     → 0 picks
//   - RARITY_RATES is the single global drop-rate ladder; difficulty
//     subsets renormalise within their pool.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  rollPicks,
  rarityForCard,
  weightedRarity,
  RARITIES,
  RARITY_BY_TIER,
  RARITY_RATES,
  MEDIUM_RARITIES,
  HARD_RARITIES,
} = require("../server-modules/rewards");
const { toCard } = require("../shared/deck-builder");

// Tiny pokedex spanning all five rarities + a few flagged legendaries
// that happen to live in odd tier slots (defensive coverage: the
// legendary flag must override the tier-derived rarity).
function fixture() {
  return [
    // common (tier 1)
    { id: 1, name: "PidgeyOne",   types: ["normal"], tier: 1, energyCost: 1, cardHp: 1, cardAttack: 1, sprite_front: "" },
    { id: 2, name: "PidgeyTwo",   types: ["normal"], tier: 1, energyCost: 1, cardHp: 1, cardAttack: 1, sprite_front: "" },
    // uncommon (tier 2)
    { id: 3, name: "RattataOne",  types: ["normal"], tier: 2, energyCost: 2, cardHp: 2, cardAttack: 2, sprite_front: "" },
    { id: 4, name: "RattataTwo",  types: ["normal"], tier: 2, energyCost: 2, cardHp: 2, cardAttack: 2, sprite_front: "" },
    // rare (tier 3)
    { id: 5, name: "GyaradosOne", types: ["water"],  tier: 3, energyCost: 3, cardHp: 3, cardAttack: 3, sprite_front: "" },
    { id: 6, name: "GyaradosTwo", types: ["water"],  tier: 3, energyCost: 3, cardHp: 3, cardAttack: 3, sprite_front: "" },
    // epic (tier 4)
    { id: 7, name: "DragoniteOne",types: ["dragon"], tier: 4, energyCost: 4, cardHp: 4, cardAttack: 4, sprite_front: "" },
    { id: 8, name: "DragoniteTwo",types: ["dragon"], tier: 4, energyCost: 4, cardHp: 4, cardAttack: 4, sprite_front: "" },
    // legendary (tier 5, plus a few flag-overrides)
    { id: 9, name: "MewtwoLeg",   types: ["psychic"],tier: 5, energyCost: 5, cardHp: 5, cardAttack: 5, sprite_front: "", is_legendary: true  },
    { id:10, name: "MewMyth",     types: ["psychic"],tier: 5, energyCost: 5, cardHp: 5, cardAttack: 5, sprite_front: "", is_mythical: true   },
    { id:11, name: "ArticunoLeg", types: ["ice"],    tier: 5, energyCost: 5, cardHp: 5, cardAttack: 5, sprite_front: "", is_legendary: true  },
    // Flag-override coverage: a tier-2 card that's flagged legendary.
    // Its rarity MUST read as "legendary", not "uncommon".
    { id:12, name: "OddLeg",      types: ["fairy"],  tier: 2, energyCost: 2, cardHp: 2, cardAttack: 2, sprite_front: "", is_legendary: true  },
  ];
}

// Deterministic RNG so tests don't flake.
function seededRand(seq) {
  let i = 0;
  return () => {
    const v = seq[i % seq.length];
    i++;
    return v;
  };
}

// --- Classification ---------------------------------------------------

test("RARITIES is the five-rarity ladder in order, low → high", () => {
  assert.deepEqual(RARITIES, ["common", "uncommon", "rare", "epic", "legendary"]);
});

test("RARITY_BY_TIER maps tier 1..5 → common..legendary", () => {
  assert.deepEqual(RARITY_BY_TIER, {
    1: "common", 2: "uncommon", 3: "rare", 4: "epic", 5: "legendary",
  });
});

test("rarityForCard maps tiers 1-5 to common/uncommon/rare/epic/legendary", () => {
  assert.equal(rarityForCard({ tier: 1 }), "common");
  assert.equal(rarityForCard({ tier: 2 }), "uncommon");
  assert.equal(rarityForCard({ tier: 3 }), "rare");
  assert.equal(rarityForCard({ tier: 4 }), "epic");
  assert.equal(rarityForCard({ tier: 5 }), "legendary");
  // is_legendary / is_mythical override tier — keeps the player-facing
  // ladder honest even when a flagged Pokémon sits in a low tier slot.
  assert.equal(rarityForCard({ tier: 2, is_legendary: true }), "legendary");
  assert.equal(rarityForCard({ tier: 3, is_mythical: true }), "legendary");
  // Unknown tier falls through to common rather than throwing.
  assert.equal(rarityForCard({ tier: 99 }), "common");
  // Defensive: null / undefined card doesn't crash.
  assert.equal(rarityForCard(null), "common");
  assert.equal(rarityForCard(undefined), "common");
});

test("toCard sets card.rarity to one of the five known values", () => {
  // Every Pokémon ships through toCard, which writes an explicit
  // `rarity` field. Downstream consumers (UI, drop logic) read from this.
  const lowBst = { id: 1, name: "Caterpie", hp: 45, attack: 30, defense: 35, sp_attack: 20, sp_defense: 20, speed: 45 };
  const midBst = { id: 2, name: "Dragonair", hp: 61, attack: 84, defense: 65, sp_attack: 70, sp_defense: 70, speed: 70 };
  const highBst = { id: 3, name: "Mewtwo", hp: 106, attack: 110, defense: 90, sp_attack: 154, sp_defense: 90, speed: 130, is_legendary: true };
  const c1 = toCard(lowBst);
  const c2 = toCard(midBst);
  const c3 = toCard(highBst);
  assert.equal(c1.rarity, "common", `low BST should be common, got ${c1.rarity}`);
  assert.ok(["uncommon", "rare", "epic"].includes(c2.rarity), `mid BST should be uncommon/rare/epic, got ${c2.rarity}`);
  assert.equal(c3.rarity, "legendary");
  assert.ok(RARITIES.includes(c1.rarity));
  assert.ok(RARITIES.includes(c2.rarity));
  assert.ok(RARITIES.includes(c3.rarity));
});

test("every fixture pokémon classifies into exactly one rarity", () => {
  // No "unknown" rarity leaks: every card returns one of the 5 known
  // values, never null/undefined.
  for (const p of fixture()) {
    const r = rarityForCard(p);
    assert.ok(RARITIES.includes(r), `${p.name} produced unknown rarity ${r}`);
  }
});

// --- Drop-rate table --------------------------------------------------

test("RARITY_RATES has a non-zero entry for every rarity", () => {
  for (const r of RARITIES) {
    assert.ok(RARITY_RATES[r] > 0, `${r} has no drop rate`);
  }
});

test("RARITY_RATES sum to 100 (so the ladder reads as percentages)", () => {
  const total = Object.values(RARITY_RATES).reduce((a, b) => a + b, 0);
  assert.equal(total, 100, `drop rates sum to ${total}, expected 100`);
});

test("RARITY_RATES is monotonically non-increasing common → legendary", () => {
  // Drop rate should never INCREASE as rarity goes up — common ≥ uncommon
  // ≥ rare ≥ epic ≥ legendary. Players reading the rates should see a
  // strictly intuitive ladder.
  for (let i = 1; i < RARITIES.length; i++) {
    const prev = RARITY_RATES[RARITIES[i - 1]];
    const cur  = RARITY_RATES[RARITIES[i]];
    assert.ok(prev >= cur, `${RARITIES[i - 1]} (${prev}) < ${RARITIES[i]} (${cur})`);
  }
});

test("legendary is the rarest single rarity", () => {
  const min = Math.min(...Object.values(RARITY_RATES));
  assert.equal(RARITY_RATES.legendary, min);
});

// --- Difficulty pool gates --------------------------------------------

test("MEDIUM_RARITIES is exactly {common, uncommon, rare}", () => {
  assert.deepEqual(new Set(MEDIUM_RARITIES), new Set(["common", "uncommon", "rare"]));
});

test("HARD_RARITIES is exactly {epic, legendary}", () => {
  assert.deepEqual(new Set(HARD_RARITIES), new Set(["epic", "legendary"]));
});

test("medium and hard rarity pools are disjoint (no overlap)", () => {
  // Players were promised a clear difficulty ladder: rares are medium-only,
  // epics+legendaries are hard-only. Overlap would muddy the contract.
  const med = new Set(MEDIUM_RARITIES);
  for (const r of HARD_RARITIES) {
    assert.ok(!med.has(r), `${r} appears in both medium and hard pools`);
  }
});

// --- Rolling ----------------------------------------------------------

test("medium roll only returns common/uncommon/rare — never epic/legendary", () => {
  const dex = fixture();
  for (let trial = 0; trial < 200; trial++) {
    const picks = rollPicks(dex, 1, Math.random, {
      allowedRarities: MEDIUM_RARITIES,
      themeBias: 0,
      themeType: null,
    });
    assert.equal(picks.length, 1);
    const r = rarityForCard(picks[0]);
    assert.ok(MEDIUM_RARITIES.includes(r), `medium roll yielded ${r} (${picks[0].name})`);
    assert.ok(!picks[0].is_legendary, `legendary ${picks[0].name} leaked into medium pool`);
    assert.ok(!picks[0].is_mythical,  `mythical ${picks[0].name} leaked into medium pool`);
  }
});

test("medium roll DOES reach rare (the new top-of-medium ceiling)", () => {
  // Regression: rare used to live in the hard pool. Confirm it's now
  // reachable on medium.
  const dex = fixture();
  let sawRare = 0;
  for (let trial = 0; trial < 500; trial++) {
    const picks = rollPicks(dex, 1, Math.random, {
      allowedRarities: MEDIUM_RARITIES,
      themeBias: 0,
      themeType: null,
    });
    if (rarityForCard(picks[0]) === "rare") sawRare++;
  }
  assert.ok(sawRare >= 5, `expected ≥5 rare pulls in 500 medium rolls, got ${sawRare}`);
});

test("medium roll excludes a flagged-legendary card even if its tier is in range", () => {
  // Build a pool that contains ONLY a single tier-2 legendary. The
  // legendary flag override means rarityForCard returns "legendary",
  // which isn't in MEDIUM_RARITIES — so the pool is empty and we return
  // 0 picks (the safety bail).
  const dex = [
    { id: 99, name: "OnlyLeg", types: ["fairy"], tier: 2, energyCost: 2, cardHp: 2, cardAttack: 2, sprite_front: "", is_legendary: true },
  ];
  const picks = rollPicks(dex, 1, Math.random, {
    allowedRarities: MEDIUM_RARITIES,
    themeType: null,
    themeBias: 0,
  });
  assert.equal(picks.length, 0);
});

test("hard roll only returns epic or legendary — never common/uncommon/rare", () => {
  const dex = fixture();
  for (let trial = 0; trial < 200; trial++) {
    const picks = rollPicks(dex, 1, Math.random, {
      allowedRarities: HARD_RARITIES,
      themeBias: 0,
      themeType: null,
    });
    assert.equal(picks.length, 1);
    const r = rarityForCard(picks[0]);
    assert.ok(HARD_RARITIES.includes(r), `hard roll yielded ${r} (${picks[0].name})`);
  }
});

test("hard roll DOES reach legendary eventually", () => {
  // legendary is 1/(4+1) = 20% within the hard band after renormalisation.
  // Expect at least 10 in 200 trials.
  const dex = fixture();
  let sawLegendary = 0;
  for (let trial = 0; trial < 200; trial++) {
    const picks = rollPicks(dex, 1, Math.random, {
      allowedRarities: HARD_RARITIES,
      themeBias: 0,
      themeType: null,
    });
    if (rarityForCard(picks[0]) === "legendary") sawLegendary++;
  }
  assert.ok(sawLegendary >= 10, `expected ≥10 legendary pulls in 200 hard rolls, got ${sawLegendary}`);
});

test("rollPicks fallback walks ONLY the allowed rarities (no bleed across pools)", () => {
  // Force the weighted rarity to land on an empty bucket so the fallback
  // kicks in. The fallback must still respect allowedRarities.
  const dex = [
    // Only commons + an epic. Medium roll should never return the epic
    // even when its weighted pick lands on a rarity with no cards.
    { id: 1, name: "T1a", tier: 1, types: ["normal"], energyCost: 1, cardHp: 1, cardAttack: 1, sprite_front: "" },
    { id: 7, name: "T4a", tier: 4, types: ["normal"], energyCost: 4, cardHp: 4, cardAttack: 4, sprite_front: "" },
  ];
  for (let trial = 0; trial < 50; trial++) {
    const picks = rollPicks(dex, 1, Math.random, {
      allowedRarities: MEDIUM_RARITIES,
      themeType: null,
      themeBias: 0,
    });
    assert.equal(picks.length, 1);
    assert.equal(rarityForCard(picks[0]), "common", `fallback leaked to ${rarityForCard(picks[0])}`);
  }
});

test("default rollPicks (multiplayer / unrestricted) can return any rarity", () => {
  const dex = fixture();
  const seen = new Set();
  for (let trial = 0; trial < 1000 && seen.size < RARITIES.length; trial++) {
    const picks = rollPicks(dex, 1, Math.random, {
      themeBias: 0,
      themeType: null,
    });
    if (picks.length) seen.add(rarityForCard(picks[0]));
  }
  // Across 1000 trials we should see every rarity at least once.
  for (const r of RARITIES) {
    assert.ok(seen.has(r), `default roll never produced ${r}`);
  }
});

test("weightedRarity respects subset weighting (medium subset renormalises)", () => {
  // Within MEDIUM_RARITIES, common (50) + uncommon (30) + rare (15) = 95.
  // common should be ~50/95 ≈ 52.6% of medium rolls.
  let common = 0;
  const N = 5000;
  for (let i = 0; i < N; i++) {
    if (weightedRarity(Math.random, MEDIUM_RARITIES) === "common") common++;
  }
  const pct = common / N;
  assert.ok(pct > 0.42 && pct < 0.62, `expected common to be ~52% of medium rolls, got ${(pct * 100).toFixed(1)}%`);
});

test("weightedRarity is deterministic with a seeded RNG", () => {
  // Sanity check: the sampler reads from the RNG in order; same seed →
  // same sequence.
  const seq = [0.05, 0.4, 0.8, 0.97];
  const a = seededRand(seq);
  const b = seededRand(seq);
  for (let i = 0; i < seq.length; i++) {
    assert.equal(weightedRarity(a), weightedRarity(b));
  }
});

// --- toPickPayload sanity --------------------------------------------

test("toPickPayload includes rarity + flags on every output", () => {
  const { toPickPayload } = require("../server-modules/rewards");
  for (const p of fixture()) {
    const out = toPickPayload(p);
    assert.ok(RARITIES.includes(out.rarity), `payload has bad rarity ${out.rarity}`);
    assert.equal(typeof out.is_legendary, "boolean");
    assert.equal(typeof out.is_mythical, "boolean");
  }
});
