// Unit tests for the Math Mode question generator + state helpers.
// We don't boot the server here — just exercise the pure functions so
// the test suite stays fast.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  generateQuiz, GENERATORS, GRADES, QUIZ_LENGTH, CARD_THRESHOLD,
  unlockedGrades, mulberry32,
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

// Grade-specific sanity checks.
test("Pre-K asks counting questions only", () => {
  const q = generateQuiz("prek", 1);
  for (const item of q) {
    assert.ok(item.prompt.toLowerCase().includes("pokéball") || item.prompt.toLowerCase().includes("how many"),
      `prek prompt was: ${item.prompt}`);
  }
});

test("1st-grade questions are addition/subtraction word problems or arithmetic", () => {
  const q = generateQuiz("g1", 7);
  let arith = 0, word = 0;
  for (const item of q) {
    if (/[−\-+]/.test(item.prompt)) arith += 1;
    if (/caught|Pokémon/i.test(item.prompt)) word += 1;
  }
  // At least one of each over 10 questions is reasonable.
  assert.ok(arith + word === q.length, "all g1 prompts should be arithmetic or word problems");
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
