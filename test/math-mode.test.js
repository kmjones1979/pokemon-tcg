// Unit tests for the Math Mode question generator + state helpers.
// We don't boot the server here — just exercise the pure functions so
// the test suite stays fast.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  generateQuiz, GENERATORS, GRADES, QUIZ_LENGTH, CARD_THRESHOLD,
  unlockedGrades, mulberry32, TOPIC_COUNTS,
} = require("../server-modules/math-mode");

// Every quiz is exactly QUIZ_LENGTH questions.
test("each grade produces exactly QUIZ_LENGTH questions", () => {
  for (const g of GRADES) {
    const q = generateQuiz(g.id, 12345);
    assert.equal(q.length, QUIZ_LENGTH, `${g.id} returned ${q.length} questions`);
  }
});

// Every question has a prompt, 4 choices, and the correct answer is one
// of the choices.
test("every generated question is well-formed", () => {
  for (const g of GRADES) {
    const q = generateQuiz(g.id, 99);
    for (const item of q) {
      assert.ok(item.prompt && typeof item.prompt === "string", `bad prompt in ${g.id}`);
      assert.equal(item.choices.length, 4, `${g.id}: expected 4 choices`);
      assert.ok(item.choices.includes(item.answer), `${g.id}: correct answer "${item.answer}" not in choices ${JSON.stringify(item.choices)}`);
      // Choices are unique.
      assert.equal(new Set(item.choices).size, 4, `${g.id}: duplicate choices ${JSON.stringify(item.choices)}`);
    }
  }
});

// Pre-K should stay in kid-friendly territory (no arithmetic operators).
test("Pre-K never asks symbolic arithmetic (no +, ×, ÷, fractions)", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const q = generateQuiz("prek", seed);
    for (const item of q) {
      assert.ok(!/[×÷=+\-]/.test(item.prompt) || /BIGGER|MORE|missing|next/i.test(item.prompt),
        `prek shouldn't ask arithmetic: ${item.prompt}`);
    }
  }
});

test("1st-grade questions cover multiple curriculum topics", () => {
  // Aggregate over several seeds so the random topic sampler is exercised.
  const buckets = { arith: 0, word: 0, placeValue: 0, skip: 0, compare: 0, time: 0, other: 0 };
  for (let seed = 1; seed <= 20; seed++) {
    const q = generateQuiz("g1", seed);
    for (const item of q) {
      if (/tens.*ones/i.test(item.prompt))             buckets.placeValue += 1;
      else if (/skip count/i.test(item.prompt))        buckets.skip += 1;
      else if (/compare|>|</.test(item.prompt))        buckets.compare += 1;
      else if (/hour hand|clock|minute/i.test(item.prompt)) buckets.time += 1;
      else if (/caught|berries|Pokémon/i.test(item.prompt)) buckets.word += 1;
      else if (/[−\-+]/.test(item.prompt))             buckets.arith += 1;
      else                                              buckets.other += 1;
    }
  }
  // Expect at least 4 distinct topic buckets to fire over 200 questions.
  const hit = Object.values(buckets).filter((n) => n > 0).length;
  assert.ok(hit >= 4, `expected ≥4 topic buckets in g1, got ${hit}: ${JSON.stringify(buckets)}`);
});

test("3rd grade includes a multiplication or division question", () => {
  const q = generateQuiz("g3", 42);
  const hasMulOrDiv = q.some((x) => /[×÷]/.test(x.prompt));
  assert.ok(hasMulOrDiv, "expected at least one × or ÷ in g3");
});

// Grade-progression / unlock logic.
test("Pre-K and K are always unlocked, others require accumulated progress", () => {
  const fresh = { perGradeCorrect: {} };
  const unlocked = unlockedGrades(fresh);
  assert.ok(unlocked.includes("prek"));
  assert.ok(unlocked.includes("k"));
  assert.ok(!unlocked.includes("g1"), "g1 should be locked at start");
});

test("unlocking propagates as a single grade accumulates correct answers", () => {
  // 50 correct in any grade unlocks the next-order grade (g1), 100 unlocks g2, etc.
  // The unlock formula reads "best progress in any lower grade".
  const s50 = { perGradeCorrect: { prek: 50 } };
  assert.ok(unlockedGrades(s50).includes("g1"), "50 in prek should unlock g1");
  const s100 = { perGradeCorrect: { k: 100 } };
  assert.ok(unlockedGrades(s100).includes("g2"), "100 in k should unlock g2");
  assert.ok(!unlockedGrades(s100).includes("g3"), "100 should NOT yet unlock g3");
});

// mulberry32 is deterministic — same seed → same sequence.
test("mulberry32 is deterministic and uniform-ish", () => {
  const a = mulberry32(123);
  const b = mulberry32(123);
  for (let i = 0; i < 20; i++) assert.equal(a(), b(), `mismatch at step ${i}`);
  const c = mulberry32(456);
  let buckets = [0, 0, 0, 0];
  for (let i = 0; i < 4000; i++) {
    const v = c();
    buckets[Math.floor(v * 4)] += 1;
  }
  for (const n of buckets) assert.ok(n > 800 && n < 1200, `bucket imbalance: ${buckets.join(",")}`);
});

// Card threshold isn't surprising
test("CARD_THRESHOLD is the documented 100", () => {
  assert.equal(CARD_THRESHOLD, 100);
});

// Each grade should have enough topic breadth to keep a learner busy for
// a full semester. Floor is set generously — Pre-K is fine with 5+ topics
// since each topic is procedurally infinite; older grades target 10+.
test("each grade has enough topic breadth for a semester", () => {
  const min = { prek: 5, k: 7, g1: 8, g2: 8, g3: 10, g4: 10, g5: 10, g6: 10, g7: 10, g8: 10 };
  for (const [g, floor] of Object.entries(min)) {
    assert.ok(TOPIC_COUNTS[g] >= floor, `${g} has only ${TOPIC_COUNTS[g]} topics (need ≥${floor})`);
  }
});

// Stress check: across 100 quizzes per grade, every question is well-formed.
test("no malformed questions across 1000 quizzes (regression)", () => {
  for (const g of Object.keys(GENERATORS)) {
    for (let i = 0; i < 100; i++) {
      const q = generateQuiz(g, i * 31 + 7);
      assert.equal(q.length, QUIZ_LENGTH, `${g} seed ${i} returned ${q.length} questions`);
      for (const item of q) {
        assert.equal(item.choices.length, 4, `${g}: 4 choices expected; got ${JSON.stringify(item)}`);
        assert.equal(new Set(item.choices).size, 4, `${g}: duplicate choices in ${JSON.stringify(item)}`);
        assert.ok(item.choices.includes(item.answer), `${g}: answer not in choices: ${JSON.stringify(item)}`);
      }
    }
  }
});

// Pre-K & K rarities are common/uncommon only (the user-spec for kid grades).
test("grade rarity gating matches spec", () => {
  const byId = new Map(GRADES.map((g) => [g.id, g]));
  for (const id of ["prek", "k"]) {
    const g = byId.get(id);
    assert.deepEqual(g.rarities.sort(), ["common", "uncommon"], `${id} rarities`);
  }
  // 1st grade onward must include legendary as an option.
  for (const id of ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"]) {
    const g = byId.get(id);
    assert.ok(g.rarities.includes("legendary"), `${id} should be able to roll legendary`);
    assert.ok(!g.rarities.includes("common"), `${id} should NOT roll common`);
  }
});
