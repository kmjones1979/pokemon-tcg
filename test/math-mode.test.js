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

// Every question has a prompt + answer + inputMode. MC adds a 4-choice
// list including the answer. Input / TF skip the choices array.
test("every generated question is well-formed", () => {
  for (const g of GRADES) {
    const q = generateQuiz(g.id, 99);
    for (const item of q) {
      assert.ok(item.prompt && typeof item.prompt === "string", `bad prompt in ${g.id}`);
      assert.ok(["mc", "input", "tf"].includes(item.inputMode), `${g.id}: bad inputMode ${item.inputMode}`);
      assert.ok(item.answer != null && String(item.answer).length > 0, `${g.id}: missing answer`);
      if (item.inputMode === "mc") {
        assert.equal(item.choices.length, 4, `${g.id}: expected 4 choices`);
        assert.ok(item.choices.includes(item.answer), `${g.id}: correct answer "${item.answer}" not in choices ${JSON.stringify(item.choices)}`);
        assert.equal(new Set(item.choices).size, 4, `${g.id}: duplicate choices ${JSON.stringify(item.choices)}`);
      } else if (item.inputMode === "tf") {
        assert.ok(["true", "false"].includes(item.answer), `${g.id}: TF answer must be true/false, got ${item.answer}`);
      }
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

test("3rd grade includes multiplication or division across seeds", () => {
  // Now that g3 has 17 topics, any single quiz may skip × / ÷. Aggregate
  // over multiple seeds — over 100 questions we expect at least a few.
  let count = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const q = generateQuiz("g3", seed);
    for (const item of q) if (/[×÷]/.test(item.prompt)) count += 1;
  }
  assert.ok(count > 0, "expected some × or ÷ questions in 100 g3 questions");
});

// All grades are unlocked — let the kid (or parent) pick whatever level
// fits, no gating.
test("every grade is unlocked from the start", () => {
  const fresh = { perGradeCorrect: {} };
  const unlocked = unlockedGrades(fresh);
  for (const id of ["prek", "k", "g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"]) {
    assert.ok(unlocked.includes(id), `${id} should be unlocked`);
  }
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

// Each grade has Singapore-style topics on top of the standard ones —
// numbers below are floor counts including bar models, number bonds, etc.
test("each grade has enough topic breadth for a semester", () => {
  // Bumped after adding input/TF variants on top of the standard MC pool.
  const min = { prek: 8, k: 14, g1: 19, g2: 19, g3: 20, g4: 20, g5: 20, g6: 20, g7: 20, g8: 20 };
  for (const [g, floor] of Object.entries(min)) {
    assert.ok(TOPIC_COUNTS[g] >= floor, `${g} has only ${TOPIC_COUNTS[g]} topics (need ≥${floor})`);
  }
});

test("G1+ grades include input-mode AND true/false topics", () => {
  // K and Pre-K stay tap-only (kids can't type yet) — they get tf only
  // starting in K. Validate the mix for G1-G8.
  for (const g of Object.keys(GENERATORS)) {
    if (g === "prek" || g === "k") continue;
    let mc = 0, input = 0, tf = 0;
    for (let seed = 1; seed <= 30; seed++) {
      for (const item of generateQuiz(g, seed)) {
        if (item.inputMode === "input") input += 1;
        else if (item.inputMode === "tf") tf += 1;
        else mc += 1;
      }
    }
    assert.ok(input > 0, `${g} never produced an input-mode question in 300 samples`);
    assert.ok(tf > 0, `${g} never produced a true/false question in 300 samples`);
    assert.ok(mc > 0, `${g} sanity: should still have MC questions`);
  }
});

test("Kindergarten has true/false topics (tap-only, no typing)", () => {
  let tf = 0;
  for (let seed = 1; seed <= 30; seed++) {
    for (const item of generateQuiz("k", seed)) {
      if (item.inputMode === "tf") tf += 1;
    }
  }
  assert.ok(tf > 0, "K should produce true/false questions");
});

test("every generated question has an explanation", () => {
  for (const g of Object.keys(GENERATORS)) {
    for (let seed = 1; seed <= 10; seed++) {
      const q = generateQuiz(g, seed);
      for (const item of q) {
        assert.ok(
          typeof item.explanation === "string" && item.explanation.length > 0,
          `${g} produced a question with no explanation: ${JSON.stringify(item)}`,
        );
      }
    }
  }
});

// Stress check: across 100 quizzes per grade, every question is well-formed.
// Now grades have a mix of MC/input/TF — only validate MC's choice array.
test("no malformed questions across 1000 quizzes (regression)", () => {
  for (const g of Object.keys(GENERATORS)) {
    for (let i = 0; i < 100; i++) {
      const q = generateQuiz(g, i * 31 + 7);
      assert.equal(q.length, QUIZ_LENGTH, `${g} seed ${i} returned ${q.length} questions`);
      for (const item of q) {
        assert.ok(["mc", "input", "tf"].includes(item.inputMode), `${g}: bad inputMode`);
        if (item.inputMode === "mc") {
          assert.equal(item.choices.length, 4, `${g}: 4 choices expected; got ${JSON.stringify(item)}`);
          assert.equal(new Set(item.choices).size, 4, `${g}: duplicate choices in ${JSON.stringify(item)}`);
          assert.ok(item.choices.includes(item.answer), `${g}: answer not in choices: ${JSON.stringify(item)}`);
        }
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
