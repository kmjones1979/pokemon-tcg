// Math Mode — Duolingo-style grade-by-grade math journey. Players pick a
// starting grade (Pre-K through 8th), answer quizzes of 10 questions each,
// and earn Pokémon cards as they accumulate correct answers. Pre-K and K
// earn common/uncommon; 1st grade onward earns rare/epic/legendary picks.
//
// State lives in KV (Redis or in-memory):
//   math:<userId> -> { grade, totalCorrect, currentStreak, bestStreak,
//                      progressToCard, cardsEarned, lastQuiz? }
//
// Card threshold = 100 correct answers (≈30 min at ~18s/question). Each
// quiz is 10 questions; finishing a perfect quiz fills 10% of the card
// bar. Players keep their progress between quizzes.
//
// Endpoints:
//   GET  /me/math/state                       → progress + unlocked grades
//   POST /me/math/start-quiz   { grade }       → 10 questions for that grade
//   POST /me/math/submit       { quizId, answers[] } → score + reward (if any)

const { randomUUID } = require("crypto");
const store = require("./state-store");
const rewards = require("./rewards");

const GRADES = [
  { id: "prek",  label: "Pre-K",     order: 0, rarities: ["common", "uncommon"], rates: { common: 0.7, uncommon: 0.3 } },
  { id: "k",     label: "Kindergarten", order: 1, rarities: ["common", "uncommon"], rates: { common: 0.55, uncommon: 0.45 } },
  { id: "g1",    label: "1st Grade", order: 2, rarities: ["rare", "epic", "legendary"], rates: { rare: 0.6, epic: 0.3, legendary: 0.1 } },
  { id: "g2",    label: "2nd Grade", order: 3, rarities: ["rare", "epic", "legendary"], rates: { rare: 0.55, epic: 0.32, legendary: 0.13 } },
  { id: "g3",    label: "3rd Grade", order: 4, rarities: ["rare", "epic", "legendary"], rates: { rare: 0.5, epic: 0.35, legendary: 0.15 } },
  { id: "g4",    label: "4th Grade", order: 5, rarities: ["rare", "epic", "legendary"], rates: { rare: 0.45, epic: 0.37, legendary: 0.18 } },
  { id: "g5",    label: "5th Grade", order: 6, rarities: ["rare", "epic", "legendary"], rates: { rare: 0.4, epic: 0.4, legendary: 0.2 } },
  { id: "g6",    label: "6th Grade", order: 7, rarities: ["rare", "epic", "legendary"], rates: { rare: 0.35, epic: 0.42, legendary: 0.23 } },
  { id: "g7",    label: "7th Grade", order: 8, rarities: ["rare", "epic", "legendary"], rates: { rare: 0.3, epic: 0.44, legendary: 0.26 } },
  { id: "g8",    label: "8th Grade", order: 9, rarities: ["rare", "epic", "legendary"], rates: { rare: 0.25, epic: 0.45, legendary: 0.30 } },
];
const GRADE_BY_ID = new Map(GRADES.map((g) => [g.id, g]));

const QUIZ_LENGTH = 10;
const CARD_THRESHOLD = 100;            // correct answers per card
const PROMOTION_THRESHOLD = 50;        // correct answers in current grade unlocks next
const STATE_TTL_SEC = 60 * 60 * 24 * 365; // 1 year
const QUIZ_SESSION_TTL_SEC = 60 * 30;     // 30 min to complete a quiz

const POKEMON_NAMES = [
  "Pikachu", "Charmander", "Bulbasaur", "Squirtle", "Eevee", "Jigglypuff",
  "Mew", "Meowth", "Snorlax", "Lapras", "Gengar", "Dragonite", "Lucario",
  "Greninja", "Sylveon", "Togepi", "Mudkip", "Treecko", "Torchic", "Piplup",
];
function pokeName(rand) { return POKEMON_NAMES[Math.floor(rand() * POKEMON_NAMES.length)]; }

// Deterministic 32-bit PRNG so a quiz can be re-derived from its seed.
// (We don't re-derive in this version — answers are stored on the session —
// but having a seeded rand makes question generation testable.)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickInt(rand, lo, hi) {
  return Math.floor(rand() * (hi - lo + 1)) + lo;
}

function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Build a 4-choice multiple-choice question from a (prompt, answer) pair.
// Distractors are picked near the answer to feel plausible — not random
// numbers that give the answer away by being absurd.
function makeMC(prompt, answer, rand, opts = {}) {
  const distractors = new Set();
  const target = String(answer);
  // If the caller supplied an explicit pool of plausible distractors,
  // walk it in shuffled order so we ALWAYS get up to 3 distinct ones
  // (no random-pick safety-limit gamble).
  if (opts.choicesFrom && opts.choicesFrom.length) {
    for (const c of shuffle(opts.choicesFrom, rand)) {
      const s = String(c);
      if (s !== target) distractors.add(s);
      if (distractors.size >= 3) break;
    }
  }
  // Fall back to nearby-number distractors for numeric answers, and
  // pad with small random ints for anything left.
  // If the target itself is negative, drop the no-negative floor so we
  // can generate plausible distractors near it (e.g., target = -9).
  const minChoice = opts.minChoice ?? (typeof answer === "number" && answer < 0 ? null : 0);
  let safety = 0;
  while (distractors.size < 3 && safety++ < 60) {
    let d;
    if (typeof answer === "number") {
      const spread = Math.max(3, Math.ceil(Math.abs(answer) * 0.4));
      const delta = pickInt(rand, -spread, spread);
      if (delta === 0) continue;
      const val = answer + delta;
      if (minChoice !== null && val < minChoice) continue;
      d = String(val);
    } else {
      d = String(pickInt(rand, 1, 10));
    }
    if (d !== target) distractors.add(d);
  }
  const choices = shuffle([target, ...distractors], rand);
  return { prompt, choices, answer: target };
}

// --- Per-grade question generators -----------------------------------------
//
// Each grade has a TOPICS array — a curriculum-aligned set of question
// types broad enough to keep a learner engaged for a full semester. The
// dispatcher (GENERATORS[gradeId]) picks one topic uniformly at random
// per question, so a 10-question quiz samples 6-8 different topics on
// average. Topics within a grade are procedurally infinite (random
// numbers, random Pokémon names) so daily play doesn't repeat verbatim.

// ---- Pre-K topics (numbers 1-5, shapes, patterns) ---------------------------
const TOPICS_PREK = [
  // Count tiny groups of Pokéballs (1-5).
  (rand) => {
    const n = pickInt(rand, 1, 5);
    const balls = "● ".repeat(n).trim();
    return { ...makeMC(`How many Pokéballs?  ${balls}`, n, rand, { minChoice: 1, choicesFrom: [1, 2, 3, 4, 5, 6] }),
      explanation: `Count each one: 1, 2, 3… There are ${n}.` };
  },
  // Count slightly bigger groups (1-10).
  (rand) => {
    const n = pickInt(rand, 4, 10);
    const balls = "● ".repeat(n).trim();
    return { ...makeMC(`Count: ${balls}`, n, rand, { minChoice: 1 }),
      explanation: `Point to each one and say a number out loud — 1, 2, 3… The answer is ${n}.` };
  },
  // Which group has more?
  (rand) => {
    let a = pickInt(rand, 1, 8), b = pickInt(rand, 1, 8);
    while (a === b) b = pickInt(rand, 1, 8);
    const A = "★ ".repeat(a).trim(), B = "◆ ".repeat(b).trim();
    const answer = a > b ? "Stars" : "Diamonds";
    return { prompt: `Which has MORE?\n${A}\n${B}`, choices: shuffle(["Stars", "Diamonds", "Same", "Neither"], rand), answer,
      explanation: `Stars: ${a}.  Diamonds: ${b}.  ${a > b ? "Stars" : "Diamonds"} has more (${Math.max(a, b)} > ${Math.min(a, b)}).` };
  },
  // Shape recognition.
  (rand) => {
    const shapes = [
      { name: "Circle",   emoji: "⬤" },
      { name: "Square",   emoji: "■" },
      { name: "Triangle", emoji: "▲" },
      { name: "Star",     emoji: "★" },
      { name: "Heart",    emoji: "♥" },
    ];
    const pick = shapes[pickInt(rand, 0, shapes.length - 1)];
    const others = shapes.filter((s) => s.name !== pick.name).map((s) => s.name);
    const choices = shuffle([pick.name, ...shuffle(others, rand).slice(0, 3)], rand);
    return { prompt: `What shape is this?  ${pick.emoji}`, choices, answer: pick.name,
      explanation: `That's a ${pick.name.toLowerCase()}!` };
  },
  // Pattern continuation: AB AB ? → A
  (rand) => {
    const pairs = [["●", "○"], ["★", "◆"], ["🔴", "🔵"], ["▲", "■"]];
    const [a, b] = pairs[pickInt(rand, 0, pairs.length - 1)];
    return { ...makeMC(`What comes next?   ${a} ${b} ${a} ${b} ${a} ?`, b, rand, { choicesFrom: [a, b, "●", "★"] }),
      explanation: `The pattern is ${a}, ${b}, ${a}, ${b}… So next is ${b}.` };
  },
  // Missing number in sequence 1-5.
  (rand) => {
    const start = pickInt(rand, 1, 3);
    const missingIdx = pickInt(rand, 1, 2);
    const seq = [start, start + 1, start + 2, start + 3];
    const answer = seq[missingIdx];
    seq[missingIdx] = "?";
    return { ...makeMC(`What's missing?   ${seq.join(", ")}`, answer, rand, { minChoice: 1 }),
      explanation: `Counting up by one each time: ${seq.map((x) => x === "?" ? answer : x).join(", ")}.` };
  },
  // Bigger or smaller number.
  (rand) => {
    let a = pickInt(rand, 1, 9), b = pickInt(rand, 1, 9);
    while (a === b) b = pickInt(rand, 1, 9);
    return { ...makeMC(`Which number is BIGGER?  ${a} or ${b}`, Math.max(a, b), rand, { choicesFrom: [a, b] }),
      explanation: `${Math.max(a, b)} comes AFTER ${Math.min(a, b)} when we count up, so it's bigger.` };
  },
  // Count backwards (Singapore-style number sense).
  (rand) => {
    const start = pickInt(rand, 4, 8);
    const seq = [start, start - 1, start - 2];
    return { ...makeMC(`What comes next?   ${seq.join(", ")}, ?`, start - 3, rand, { minChoice: 0 }),
      explanation: `Each step goes DOWN by 1: ${seq.join(", ")}, ${start - 3}.` };
  },
  // Count the same group as a number bond (Singapore CPA approach).
  (rand) => {
    const total = pickInt(rand, 3, 5);
    const a = pickInt(rand, 1, total - 1);
    const b = total - a;
    // Build 3 distinct distractors near `total` that aren't the answer.
    const distractors = new Set();
    for (const d of [total - 1, total + 1, total - 2, total + 2, a, b]) {
      if (d !== total && d > 0) distractors.add(d);
      if (distractors.size === 3) break;
    }
    return { prompt: `${"●".repeat(a)} and ${"○".repeat(b)}.  Together: ?`,
      choices: shuffle([total, ...distractors], rand).map(String),
      answer: String(total),
      explanation: `${a} filled + ${b} empty = ${total} altogether. This is a number bond!` };
  },
];

// ---- Kindergarten topics (numbers 1-20, simple add/sub within 10) ----------
const TOPICS_K = [
  (rand) => { // Count to 20
    const n = pickInt(rand, 8, 20);
    return { ...makeMC(`Count the Pokéballs:  ${"● ".repeat(n).trim()}`, n, rand, { minChoice: 1 }),
      explanation: `Count them one by one. There are ${n}.` };
  },
  (rand) => { // What comes after
    const n = pickInt(rand, 1, 19);
    return { ...makeMC(`What number comes AFTER ${n}?`, n + 1, rand, { minChoice: 1 }),
      explanation: `Add 1: ${n} + 1 = ${n + 1}.` };
  },
  (rand) => { // What comes before
    const n = pickInt(rand, 2, 20);
    return { ...makeMC(`What number comes BEFORE ${n}?`, n - 1, rand, { minChoice: 0 }),
      explanation: `Take 1 away: ${n} − 1 = ${n - 1}.` };
  },
  (rand) => { // Compare two numbers
    const a = pickInt(rand, 1, 20), b = pickInt(rand, 1, 20);
    const answer = a > b ? ">" : a < b ? "<" : "=";
    return { prompt: `Fill in:   ${a}  ?  ${b}`, choices: [">", "<", "=", "≥"], answer,
      explanation: `${a} ${answer === ">" ? "is bigger than" : answer === "<" ? "is smaller than" : "equals"} ${b}.` };
  },
  (rand) => { // Add within 10
    const a = pickInt(rand, 1, 5), b = pickInt(rand, 1, 5);
    return { ...makeMC(`${a} + ${b} = ?`, a + b, rand, { minChoice: 0 }),
      explanation: `Start at ${a}, count ${b} more: ${a + b}.` };
  },
  (rand) => { // Subtract within 10
    const a = pickInt(rand, 3, 10), b = pickInt(rand, 0, a);
    return { ...makeMC(`${a} − ${b} = ?`, a - b, rand, { minChoice: 0 }),
      explanation: `Start at ${a}, take ${b} away: ${a - b}.` };
  },
  (rand) => { // Number bond to 10 (Singapore CPA)
    const total = 10, a = pickInt(rand, 0, 10);
    return { ...makeMC(`${a} + ? = ${total}`, total - a, rand, { minChoice: 0 }),
      explanation: `Number bond! ${a} and ${total - a} make ${total} together.` };
  },
  (rand) => { // Pokémon counting story
    const a = pickInt(rand, 1, 5), b = pickInt(rand, 1, 5);
    const who = pokeName(rand);
    return { ...makeMC(`${who} has ${a} Pokéballs and finds ${b} more. How many now?`, a + b, rand, { minChoice: 0 }),
      explanation: `Started with ${a}, found ${b} more → ${a} + ${b} = ${a + b}.` };
  },
  (rand) => { // Odd or even
    const n = pickInt(rand, 1, 20);
    return { prompt: `Is ${n} even or odd?`, choices: ["Even", "Odd", "Both", "Neither"], answer: n % 2 === 0 ? "Even" : "Odd",
      explanation: n % 2 === 0 ? `${n} can be shared by 2 evenly. Even numbers end in 0, 2, 4, 6, 8.` : `${n} has one left over when you share by 2. Odd numbers end in 1, 3, 5, 7, 9.` };
  },
  // ---- Singapore math additions ----
  (rand) => { // Number bond (any total) — Singapore staple
    const total = pickInt(rand, 5, 10);
    const a = pickInt(rand, 1, total - 1);
    return { ...makeMC(`Number bond:  ${total} = ${a} + ?`, total - a, rand, { minChoice: 0 }),
      explanation: `Whole = ${total}. One part = ${a}. The other part = ${total} − ${a} = ${total - a}.` };
  },
  (rand) => { // "Part-part-whole" story
    const a = pickInt(rand, 2, 6), b = pickInt(rand, 2, 6);
    const who = pokeName(rand);
    return { ...makeMC(`${who} has ${a} red berries and ${b} blue berries. How many berries in all?`, a + b, rand, { minChoice: 0 }),
      explanation: `Two parts (${a} and ${b}) join to make the whole. Whole = ${a} + ${b} = ${a + b}.` };
  },
  (rand) => { // Comparison ("how many more")
    let a = pickInt(rand, 3, 10), b = pickInt(rand, 1, a - 1);
    const who1 = pokeName(rand), who2 = pokeName(rand);
    return { ...makeMC(`${who1} has ${a} berries. ${who2} has ${b}. How many MORE does ${who1} have?`, a - b, rand, { minChoice: 0 }),
      explanation: `Comparison bar model: ${who1}'s ${a} − ${who2}'s ${b} = ${a - b} more.` };
  },
  (rand) => { // Ten frame: how many to make 10?
    const a = pickInt(rand, 1, 9);
    return { ...makeMC(`A ten frame has ${a} filled. How many more to fill it?`, 10 - a, rand, { minChoice: 0 }),
      explanation: `Ten frame holds 10. Already filled: ${a}. Still need: 10 − ${a} = ${10 - a}.` };
  },
];

// ---- 1st grade topics (within 20, place value, time, money intro) ----------
const TOPICS_G1 = [
  (rand) => { // Add within 20
    const a = pickInt(rand, 1, 10), b = pickInt(rand, 1, 10);
    return { ...makeMC(`${a} + ${b} = ?`, a + b, rand, { minChoice: 0 }),
      explanation: `Try a number bond: ${a} + ${b} = ${a + b}.` };
  },
  (rand) => { // Subtract within 20
    const a = pickInt(rand, 5, 20), b = pickInt(rand, 1, a);
    return { ...makeMC(`${a} − ${b} = ?`, a - b, rand, { minChoice: 0 }),
      explanation: `Count backwards from ${a} by ${b}, or use a number line: ${a} − ${b} = ${a - b}.` };
  },
  (rand) => { // Word problem: addition
    const a = pickInt(rand, 1, 10), b = pickInt(rand, 1, 10);
    const who = pokeName(rand);
    return { ...makeMC(`${who} caught ${a} Pokémon, then caught ${b} more. How many in total?`, a + b, rand, { minChoice: 0 }),
      explanation: `Two parts joining: ${a} + ${b} = ${a + b}.` };
  },
  (rand) => { // Word problem: subtraction
    const a = pickInt(rand, 6, 20), b = pickInt(rand, 1, a - 1);
    const who = pokeName(rand);
    return { ...makeMC(`${who} had ${a} berries and ate ${b}. How many are left?`, a - b, rand, { minChoice: 0 }),
      explanation: `Start: ${a}. Took away: ${b}. Left: ${a} − ${b} = ${a - b}.` };
  },
  (rand) => { // Place value: tens and ones
    const tens = pickInt(rand, 1, 9), ones = pickInt(rand, 0, 9);
    return { ...makeMC(`What number is ${tens} tens and ${ones} ones?`, tens * 10 + ones, rand, { minChoice: 0 }),
      explanation: `${tens} tens = ${tens * 10}. Plus ${ones} ones = ${tens * 10 + ones}.` };
  },
  (rand) => { // Compare two-digit
    const a = pickInt(rand, 10, 99), b = pickInt(rand, 10, 99);
    const answer = a > b ? ">" : a < b ? "<" : "=";
    return { prompt: `Compare:   ${a}  ?  ${b}`, choices: [">", "<", "=", "≠"], answer,
      explanation: `Look at tens first. ${a} ${answer} ${b}.` };
  },
  (rand) => { // Skip count by 2
    const start = pickInt(rand, 2, 10) * 2;
    return { ...makeMC(`Skip counting by 2:  ${start}, ${start + 2}, ${start + 4}, ?`, start + 6, rand),
      explanation: `Each step adds 2: ${start + 4} + 2 = ${start + 6}.` };
  },
  (rand) => { // Skip count by 5
    const start = pickInt(rand, 1, 8) * 5;
    return { ...makeMC(`Skip counting by 5:  ${start}, ${start + 5}, ${start + 10}, ?`, start + 15, rand),
      explanation: `Each step adds 5: ${start + 10} + 5 = ${start + 15}.` };
  },
  (rand) => { // Number between
    const a = pickInt(rand, 1, 18);
    return { ...makeMC(`What number is between ${a} and ${a + 2}?`, a + 1, rand, { minChoice: 0 }),
      explanation: `${a}, ${a + 1}, ${a + 2}. The middle one is ${a + 1}.` };
  },
  (rand) => { // Telling time (hour)
    const h = pickInt(rand, 1, 12);
    return { ...makeMC(`The hour hand points to ${h} and the minute hand is on 12. What time is it?`, `${h}:00`, rand, { choicesFrom: [`${h}:00`, `${h}:30`, `${(h % 12) + 1}:00`, `${h - 1 || 12}:00`] }),
      explanation: `Minute hand on 12 means "o'clock". So it's ${h}:00.` };
  },
  (rand) => { // Doubles
    const a = pickInt(rand, 1, 10);
    return { ...makeMC(`Double ${a} is?`, a * 2, rand, { minChoice: 0 }),
      explanation: `Doubling means ${a} + ${a} = ${a * 2}.` };
  },
  // ---- Singapore math additions ----
  (rand) => { // Make a 10 (Singapore mental strategy)
    // a + b where b is close to 10: 8 + 5 → (8+2) + 3 = 13
    const a = pickInt(rand, 7, 9), b = pickInt(rand, 4, 9);
    return { ...makeMC(`${a} + ${b} = ?`, a + b, rand, { minChoice: 0 }),
      explanation: `"Make a 10" strategy: ${a} + ${10 - a} = 10, then add ${b - (10 - a)}. So ${a} + ${b} = ${a + b}.` };
  },
  (rand) => { // Bar model: comparison (Singapore)
    let a = pickInt(rand, 5, 18), b = pickInt(rand, 2, a - 1);
    const who1 = pokeName(rand), who2 = pokeName(rand);
    return { ...makeMC(`${who1} has ${a} cards. ${who2} has ${b}. How many MORE does ${who1} have?`, a - b, rand, { minChoice: 0 }),
      explanation: `Bar model: ${who1}'s bar (${a}) is longer than ${who2}'s (${b}) by ${a - b}.` };
  },
  (rand) => { // Bar model: part-whole, find missing part
    const total = pickInt(rand, 12, 20), part = pickInt(rand, 3, total - 3);
    return { ...makeMC(`A whole is ${total}. One part is ${part}. What is the other part?`, total - part, rand, { minChoice: 0 }),
      explanation: `Whole − part = other part. ${total} − ${part} = ${total - part}.` };
  },
  (rand) => { // Balancing equation
    const x = pickInt(rand, 2, 9), b = pickInt(rand, 1, 9);
    return { ...makeMC(`${x} + ? = ${x + b}`, b, rand, { minChoice: 0 }),
      explanation: `Both sides must match. ${x} + ${b} = ${x + b}, so ? = ${b}.` };
  },
  (rand) => { // Ten frame double
    const a = pickInt(rand, 1, 9);
    return { ...makeMC(`Two ten frames hold 20 dots. One has ${a} filled. How many empty across both?`, 20 - a, rand, { minChoice: 0 }),
      explanation: `Both ten frames = 20 dots total. ${a} filled, so ${20 - a} empty.` };
  },
];

// ---- 2nd grade topics (within 100, money, time, arrays) --------------------
const TOPICS_G2 = [
  (rand) => { // Add within 100
    const a = pickInt(rand, 10, 50), b = pickInt(rand, 10, 50);
    return { ...makeMC(`${a} + ${b} = ?`, a + b, rand, { minChoice: 0 }),
      explanation: `Add tens first, then ones: ${Math.floor(a/10)*10} + ${Math.floor(b/10)*10} = ${Math.floor(a/10)*10 + Math.floor(b/10)*10}, plus ${a%10} + ${b%10} = ${a%10 + b%10}. Total: ${a + b}.` };
  },
  (rand) => { // Subtract within 100
    const a = pickInt(rand, 30, 99), b = pickInt(rand, 1, a - 1);
    return { ...makeMC(`${a} − ${b} = ?`, a - b, rand, { minChoice: 0 }),
      explanation: `${a} − ${b} = ${a - b}. Try counting up from ${b} to ${a} if subtracting feels hard.` };
  },
  (rand) => { // Two-step word problem
    const a = pickInt(rand, 20, 40), b = pickInt(rand, 1, 15), c = pickInt(rand, 1, 10);
    const safeA = Math.max(a, b);
    const who = pokeName(rand);
    return { ...makeMC(`${who} had ${safeA} Pokéballs, lost ${b}, then found ${c}. How many now?`, safeA - b + c, rand, { minChoice: 0 }),
      explanation: `Step 1: ${safeA} − ${b} = ${safeA - b}. Step 2: ${safeA - b} + ${c} = ${safeA - b + c}.` };
  },
  (rand) => { // Skip counting (2/5/10/100)
    const start = pickInt(rand, 2, 10);
    const step = [2, 5, 10, 100][pickInt(rand, 0, 3)];
    return { ...makeMC(`Skip count by ${step}: ${start}, ${start + step}, ${start + 2 * step}, ?`, start + 3 * step, rand),
      explanation: `Each step adds ${step}: ${start + 2 * step} + ${step} = ${start + 3 * step}.` };
  },
  (rand) => { // Place value to 1000
    const h = pickInt(rand, 1, 9), t = pickInt(rand, 0, 9), o = pickInt(rand, 0, 9);
    return { ...makeMC(`What number has ${h} hundreds, ${t} tens, and ${o} ones?`, h * 100 + t * 10 + o, rand),
      explanation: `${h} × 100 + ${t} × 10 + ${o} = ${h * 100 + t * 10 + o}.` };
  },
  (rand) => { // Coin value
    const coins = [
      { name: "1 penny", val: 1 },
      { name: "1 nickel", val: 5 },
      { name: "1 dime", val: 10 },
      { name: "1 quarter", val: 25 },
    ];
    const k = pickInt(rand, 1, 4);
    const coin = coins[pickInt(rand, 0, coins.length - 1)];
    return { ...makeMC(`How many cents are ${k} ${coin.name}${k > 1 ? "s" : ""}?`, k * coin.val, rand, { minChoice: 0 }),
      explanation: `${coin.name.replace("1 ", "")} = ${coin.val}¢. ${k} of them = ${k} × ${coin.val} = ${k * coin.val}¢.` };
  },
  (rand) => { // Telling time (5-min)
    const h = pickInt(rand, 1, 12);
    const m = pickInt(rand, 1, 11) * 5;
    return { ...makeMC(`Time is ${h} o'clock plus ${m} minutes. What time?`, `${h}:${String(m).padStart(2, "0")}`, rand, { choicesFrom: [`${h}:${String(m).padStart(2,"0")}`, `${h}:${String((m+5)%60).padStart(2,"0")}`, `${h+1}:00`, `${h}:${String(Math.max(0,m-5)).padStart(2,"0")}`] }),
      explanation: `Add ${m} minutes to ${h}:00 → ${h}:${String(m).padStart(2, "0")}.` };
  },
  (rand) => { // Array (rep. addition)
    const rows = pickInt(rand, 2, 5), cols = pickInt(rand, 2, 5);
    return { ...makeMC(`${rows} rows of ${cols} Pokéballs. How many total?`, rows * cols, rand),
      explanation: `${rows} groups of ${cols} = ${rows} × ${cols} = ${rows * cols}. (Repeated addition: ${Array(rows).fill(cols).join(" + ")}.)` };
  },
  (rand) => { // Doubling within 50
    const a = pickInt(rand, 11, 25);
    return { ...makeMC(`Double ${a} is?`, a * 2, rand),
      explanation: `Double = ${a} + ${a} = ${a * 2}.` };
  },
  (rand) => { // Half
    const a = pickInt(rand, 1, 25) * 2;
    return { ...makeMC(`Half of ${a} is?`, a / 2, rand, { minChoice: 0 }),
      explanation: `Split ${a} into 2 equal groups: each has ${a / 2}.` };
  },
  (rand) => { // Even/odd
    const n = pickInt(rand, 10, 99);
    return { prompt: `Is ${n} even or odd?`, choices: ["Even", "Odd", "Prime", "Composite"], answer: n % 2 === 0 ? "Even" : "Odd",
      explanation: `Look at the ones digit (${n % 10}). Even digits: 0, 2, 4, 6, 8. So ${n} is ${n % 2 === 0 ? "even" : "odd"}.` };
  },
  // ---- Singapore math additions ----
  (rand) => { // Bar model: part-whole missing (Singapore)
    const total = pickInt(rand, 30, 80), p1 = pickInt(rand, 10, total - 10);
    const who1 = pokeName(rand), who2 = pokeName(rand);
    return { ...makeMC(`${who1} and ${who2} have ${total} cards together. ${who1} has ${p1}. How many does ${who2} have?`, total - p1, rand, { minChoice: 0 }),
      explanation: `Bar model: whole = ${total}, one part = ${p1}, other part = ${total} − ${p1} = ${total - p1}.` };
  },
  (rand) => { // Bar model: comparison (how many more)
    let a = pickInt(rand, 20, 80), b = pickInt(rand, 5, a - 5);
    const who1 = pokeName(rand), who2 = pokeName(rand);
    return { ...makeMC(`${who1} caught ${a} Pokémon. ${who2} caught ${b}. How many MORE did ${who1} catch?`, a - b, rand, { minChoice: 0 }),
      explanation: `Comparison bar: ${who1}'s ${a} vs ${who2}'s ${b}. Difference = ${a} − ${b} = ${a - b}.` };
  },
  (rand) => { // "Equal sharing" (intro to division)
    const groups = pickInt(rand, 2, 5), per = pickInt(rand, 3, 8);
    const total = groups * per;
    return { ...makeMC(`Share ${total} berries equally among ${groups} friends. How many each?`, per, rand, { minChoice: 1 }),
      explanation: `Equal groups: ${total} ÷ ${groups} = ${per} each.` };
  },
  (rand) => { // Time interval (Singapore: model time on a number line)
    const h1 = pickInt(rand, 1, 8), h2 = h1 + pickInt(rand, 1, 4);
    return { ...makeMC(`A movie starts at ${h1}:00 and ends at ${h2}:00. How long is it?`, h2 - h1, rand, { minChoice: 1 }),
      explanation: `End − start: ${h2} − ${h1} = ${h2 - h1} hours.` };
  },
  (rand) => { // 3-addend sum (Singapore CPA chaining)
    const a = pickInt(rand, 5, 20), b = pickInt(rand, 5, 20), c = pickInt(rand, 5, 20);
    return { ...makeMC(`${a} + ${b} + ${c} = ?`, a + b + c, rand, { minChoice: 0 }),
      explanation: `Add in steps: ${a} + ${b} = ${a + b}; then ${a + b} + ${c} = ${a + b + c}.` };
  },
];

// ---- 3rd grade topics (multiplication, division, fractions, area) ----------
const TOPICS_G3 = [
  (rand) => { // Times tables 0-10
    const a = pickInt(rand, 2, 10), b = pickInt(rand, 2, 10);
    return { ...makeMC(`${a} × ${b} = ?`, a * b, rand, { minChoice: 0 }),
      explanation: `${a} groups of ${b} = ${a * b}. (You can also think ${b} groups of ${a}.)` };
  },
  (rand) => { // Division
    const b = pickInt(rand, 2, 10), q = pickInt(rand, 2, 10);
    return { ...makeMC(`${b * q} ÷ ${b} = ?`, q, rand, { minChoice: 1 }),
      explanation: `Think: ${b} × ? = ${b * q}. Answer: ${q}.` };
  },
  (rand) => { // Fraction of a set
    const denom = [2, 3, 4][pickInt(rand, 0, 2)];
    const whole = denom * pickInt(rand, 2, 8);
    return { ...makeMC(`1/${denom} of ${whole} = ?`, whole / denom, rand, { minChoice: 0 }),
      explanation: `Split ${whole} into ${denom} equal groups: ${whole} ÷ ${denom} = ${whole / denom}.` };
  },
  (rand) => { // Equivalent fractions
    const num = pickInt(rand, 1, 4), denom = pickInt(rand, num + 1, 6);
    const k = pickInt(rand, 2, 4);
    return { ...makeMC(`Which is equivalent to ${num}/${denom}?`, `${num * k}/${denom * k}`, rand, {
        choicesFrom: [`${num * k}/${denom * k}`, `${num + 1}/${denom}`, `${num}/${denom + k}`, `${num * 2}/${denom + 1}`],
      }),
      explanation: `Multiply top and bottom by the same number: ${num}×${k} / ${denom}×${k} = ${num * k}/${denom * k}.` };
  },
  (rand) => { // Area
    const l = pickInt(rand, 2, 12), w = pickInt(rand, 2, 12);
    return { ...makeMC(`Rectangle with length ${l} and width ${w}.  Area = ?`, l * w, rand),
      explanation: `Area = length × width = ${l} × ${w} = ${l * w}.` };
  },
  (rand) => { // Perimeter
    const l = pickInt(rand, 2, 12), w = pickInt(rand, 2, 12);
    return { ...makeMC(`Rectangle with sides ${l} and ${w}. Perimeter = ?`, 2 * (l + w), rand),
      explanation: `Perimeter = 2 × (length + width) = 2 × (${l} + ${w}) = ${2 * (l + w)}.` };
  },
  (rand) => { // Round to nearest 10
    const n = pickInt(rand, 11, 99);
    return { ...makeMC(`Round ${n} to the nearest 10.`, Math.round(n / 10) * 10, rand),
      explanation: `Ones digit (${n % 10}) is ${n % 10 >= 5 ? "5 or more — round UP" : "less than 5 — round DOWN"}: ${Math.round(n / 10) * 10}.` };
  },
  (rand) => { // Round to nearest 100
    const n = pickInt(rand, 101, 999);
    return { ...makeMC(`Round ${n} to the nearest 100.`, Math.round(n / 100) * 100, rand),
      explanation: `Tens digit (${Math.floor(n / 10) % 10}) decides. ${n} → ${Math.round(n / 100) * 100}.` };
  },
  (rand) => { // Word problem: multiplication
    const a = pickInt(rand, 3, 8), b = pickInt(rand, 2, 6);
    const who = pokeName(rand);
    return { ...makeMC(`${who} has ${a} packs of cards with ${b} cards each. Total cards?`, a * b, rand),
      explanation: `${a} packs × ${b} per pack = ${a * b} cards.` };
  },
  (rand) => { // Word problem: division
    const b = pickInt(rand, 2, 8), q = pickInt(rand, 3, 9);
    const who = pokeName(rand);
    return { ...makeMC(`${who} shares ${b * q} berries equally with ${b} friends. Each friend gets?`, q, rand, { minChoice: 1 }),
      explanation: `${b * q} ÷ ${b} = ${q}. Equal sharing makes ${q} per friend.` };
  },
  (rand) => { // Time elapsed
    const h1 = pickInt(rand, 1, 8), h2 = h1 + pickInt(rand, 1, 4);
    return { ...makeMC(`From ${h1}:00 to ${h2}:00 — how many hours?`, h2 - h1, rand, { minChoice: 1 }),
      explanation: `End − start: ${h2} − ${h1} = ${h2 - h1} hours.` };
  },
  (rand) => { // Multiples
    const n = pickInt(rand, 2, 9);
    const correct = n * pickInt(rand, 2, 4);
    const choices = [n * 2, n * 3, n * 4, n * 2 + 1].includes(correct) ? [n * 2, n * 3, n * 4, n * 2 + 1] : [correct, correct + 1, correct - 1, correct + n - 1];
    return { ...makeMC(`Which is a multiple of ${n}?`, correct, rand, { choicesFrom: choices }),
      explanation: `${correct} ÷ ${n} = ${correct / n} with no remainder, so ${correct} is a multiple of ${n}.` };
  },
  // ---- Singapore math additions ----
  (rand) => { // Bar model multiplicative comparison (Singapore)
    const x = pickInt(rand, 3, 7), k = pickInt(rand, 2, 4);
    return { ...makeMC(`Pikachu has ${x} berries. Charmander has ${k} times as many. How many does Charmander have?`, x * k, rand, { minChoice: 1 }),
      explanation: `${k} units of ${x}: ${k} × ${x} = ${x * k}.` };
  },
  (rand) => { // Bar model: equal groups, find total
    const groups = pickInt(rand, 3, 6), per = pickInt(rand, 4, 8);
    return { ...makeMC(`${groups} Pokémon each have ${per} berries. Total berries?`, groups * per, rand, { minChoice: 1 }),
      explanation: `${groups} equal groups of ${per}: ${groups} × ${per} = ${groups * per}.` };
  },
  (rand) => { // Compare fractions same numerator
    const num = pickInt(rand, 1, 3);
    let d1 = pickInt(rand, 3, 8), d2 = pickInt(rand, 3, 8);
    while (d1 === d2) d2 = pickInt(rand, 3, 8);
    return { prompt: `Compare:  ${num}/${d1}  ?  ${num}/${d2}`, choices: [">", "<", "=", "≠"], answer: d1 < d2 ? ">" : "<",
      explanation: `Same numerator (${num}). Smaller denominator = bigger fraction. So ${num}/${Math.min(d1, d2)} > ${num}/${Math.max(d1, d2)}.` };
  },
  (rand) => { // Multi-step bar model
    const start = pickInt(rand, 30, 60), gave = pickInt(rand, 5, 15), got = pickInt(rand, 5, 15);
    const who = pokeName(rand);
    return { ...makeMC(`${who} had ${start} cards. Gave ${gave} away, then got ${got} more. How many now?`, start - gave + got, rand, { minChoice: 0 }),
      explanation: `Step 1: ${start} − ${gave} = ${start - gave}. Step 2: ${start - gave} + ${got} = ${start - gave + got}.` };
  },
  (rand) => { // Money word problem (Singapore-flavored)
    const each = pickInt(rand, 2, 9), count = pickInt(rand, 3, 8);
    return { ...makeMC(`A Poké-snack costs $${each}. How much for ${count} snacks?`, each * count, rand, { minChoice: 1 }),
      explanation: `${count} × $${each} = $${each * count}.` };
  },
];

// ---- 4th grade topics ------------------------------------------------------
const TOPICS_G4 = [
  (rand) => { // 2-digit × 1-digit
    const a = pickInt(rand, 11, 30), b = pickInt(rand, 2, 9);
    return { ...makeMC(`${a} × ${b} = ?`, a * b, rand),
      explanation: `Split: (${Math.floor(a/10)*10} × ${b}) + (${a % 10} × ${b}) = ${Math.floor(a/10)*10 * b} + ${(a % 10) * b} = ${a * b}.` };
  },
  (rand) => { // 3-digit × 1-digit
    const a = pickInt(rand, 101, 250), b = pickInt(rand, 2, 6);
    return { ...makeMC(`${a} × ${b} = ?`, a * b, rand),
      explanation: `Multiply each place: ${a} × ${b} = ${a * b}.` };
  },
  (rand) => { // Long division with remainder
    const b = pickInt(rand, 2, 12), q = pickInt(rand, 4, 15), r = pickInt(rand, 0, b - 1);
    return { ...makeMC(`${b * q + r} ÷ ${b} has remainder?`, r, rand, { minChoice: 0 }),
      explanation: `${b} × ${q} = ${b * q}, and ${b * q + r} − ${b * q} = ${r}, so remainder = ${r}.` };
  },
  (rand) => { // Add fractions same denom
    const denom = [3, 4, 5, 6, 8, 10][pickInt(rand, 0, 5)];
    const a = pickInt(rand, 1, denom - 1), b = pickInt(rand, 1, denom - a);
    return { ...makeMC(`${a}/${denom} + ${b}/${denom} = ?  (numerator)`, a + b, rand, { minChoice: 0 }),
      explanation: `Same denominator — just add the numerators: ${a} + ${b} = ${a + b}. Answer: ${a + b}/${denom}.` };
  },
  (rand) => { // Subtract fractions same denom
    const denom = [3, 4, 5, 6, 8, 10][pickInt(rand, 0, 5)];
    const a = pickInt(rand, 2, denom - 1), b = pickInt(rand, 1, a - 1);
    return { ...makeMC(`${a}/${denom} − ${b}/${denom} = ?  (numerator)`, a - b, rand, { minChoice: 0 }),
      explanation: `Same denominator — subtract numerators: ${a} − ${b} = ${a - b}.` };
  },
  (rand) => { // Compare decimals
    const a = pickInt(rand, 1, 99) / 10, b = pickInt(rand, 1, 99) / 10;
    const answer = a > b ? ">" : a < b ? "<" : "=";
    return { prompt: `Compare:  ${a.toFixed(1)}  ?  ${b.toFixed(1)}`, choices: [">", "<", "=", "≠"], answer,
      explanation: `Compare digit by digit, left to right. ${a.toFixed(1)} ${answer} ${b.toFixed(1)}.` };
  },
  (rand) => { // Factors
    const n = [12, 18, 20, 24, 30, 36][pickInt(rand, 0, 5)];
    const facts = listFactors(n).filter((x) => x > 1 && x < n);
    const correct = facts[Math.floor(rand() * facts.length)];
    const nonFactors = [];
    for (let i = 2; i <= n; i++) if (n % i !== 0) nonFactors.push(i);
    const distractors = shuffle(nonFactors, rand).slice(0, 3);
    return { prompt: `Which is a factor of ${n}?`, choices: shuffle([correct, ...distractors], rand).map(String), answer: String(correct),
      explanation: `${correct} divides ${n} evenly (${n} ÷ ${correct} = ${n / correct}), so ${correct} is a factor.` };
  },
  (rand) => { // Multiples
    const n = pickInt(rand, 3, 9);
    const correct = n * pickInt(rand, 4, 9);
    const distractors = [correct + 1, correct - 1, correct + n - 1, correct - n + 1];
    return { ...makeMC(`Which is a multiple of ${n}?`, correct, rand, { choicesFrom: [correct, ...distractors] }),
      explanation: `${correct} = ${n} × ${correct / n}, so it's a multiple of ${n}.` };
  },
  (rand) => { // Convert mixed → improper
    const whole = pickInt(rand, 1, 4), num = pickInt(rand, 1, 5), denom = num + pickInt(rand, 1, 4);
    const answer = `${whole * denom + num}/${denom}`;
    const candidates = [
      `${whole * denom + num}/${denom}`, `${whole + num}/${denom}`, `${whole * denom - num}/${denom}`,
      `${num * denom + whole}/${denom}`, `${(whole + 1) * denom + num}/${denom}`, `${whole * denom + num + 1}/${denom}`,
    ];
    const distinct = [];
    for (const c of candidates) if (c !== answer && !distinct.includes(c) && distinct.length < 3) distinct.push(c);
    return { prompt: `Convert ${whole} ${num}/${denom} to an improper fraction.`, choices: shuffle([answer, ...distinct], rand), answer,
      explanation: `${whole} × ${denom} = ${whole * denom}, plus ${num} = ${whole * denom + num}. Over ${denom}: ${answer}.` };
  },
  (rand) => { // Fraction of a set
    const denom = [3, 4, 5, 6][pickInt(rand, 0, 3)];
    const num = pickInt(rand, 1, denom - 1);
    const whole = denom * pickInt(rand, 3, 10);
    return { ...makeMC(`${num}/${denom} of ${whole} = ?`, (num * whole) / denom, rand, { minChoice: 0 }),
      explanation: `Each ${1}/${denom} = ${whole / denom}. So ${num} of them = ${num} × ${whole / denom} = ${(num * whole) / denom}.` };
  },
  (rand) => { // Word: multi-step
    const a = pickInt(rand, 15, 50), b = pickInt(rand, 3, 8);
    const who = pokeName(rand);
    return { ...makeMC(`${who} earns ${b} berries per match and played ${a} matches. Total berries?`, a * b, rand),
      explanation: `${a} matches × ${b} per match = ${a * b} berries.` };
  },
  (rand) => { // Decimal place value
    const d = pickInt(rand, 10, 99);
    const a = d / 100;
    return { ...makeMC(`What is the tens digit of ${a.toFixed(2)}?`, 0, rand, { choicesFrom: [0, Math.floor(d / 10), d % 10, 1] }),
      explanation: `${a.toFixed(2)} has 0 in the tens place (it's less than 10).` };
  },
  // ---- Singapore math additions ----
  (rand) => { // Bar model: 2-step (Singapore staple)
    const part1 = pickInt(rand, 20, 40), part2 = pickInt(rand, 10, 30);
    // Guarantee a non-negative remainder so the answer makes story sense.
    const total = part1 + part2 + pickInt(rand, 10, 50);
    return { ...makeMC(`A trainer has ${total} cards. Gives ${part1} to a friend and ${part2} to a sibling. How many cards left?`, total - part1 - part2, rand, { minChoice: 0 }),
      explanation: `Total given away: ${part1} + ${part2} = ${part1 + part2}. Left: ${total} − ${part1 + part2} = ${total - part1 - part2}.` };
  },
  (rand) => { // Bar model: multiplicative comparison
    const small = pickInt(rand, 6, 14), times = pickInt(rand, 3, 5);
    return { ...makeMC(`A small bar is ${small}. The large bar is ${times} times as long. What's the large bar?`, small * times, rand, { minChoice: 1 }),
      explanation: `${times} times the small bar: ${times} × ${small} = ${small * times}.` };
  },
  (rand) => { // Bar model: find one unit
    const units = pickInt(rand, 3, 6), total = units * pickInt(rand, 5, 12);
    return { ...makeMC(`${units} equal bars together total ${total}. What's one bar?`, total / units, rand, { minChoice: 1 }),
      explanation: `Total ÷ number of equal parts = ${total} ÷ ${units} = ${total / units}.` };
  },
  (rand) => { // Equivalent fractions: find the missing numerator
    const num = pickInt(rand, 1, 4), denom = pickInt(rand, num + 1, 8);
    const k = pickInt(rand, 2, 4);
    return { ...makeMC(`${num}/${denom} = ?/${denom * k}`, num * k, rand, { minChoice: 1 }),
      explanation: `Multiply both top and bottom by ${k}: ${num}×${k}/${denom}×${k} = ${num * k}/${denom * k}.` };
  },
  (rand) => { // Place value (decimal)
    const tenths = pickInt(rand, 1, 9), hundredths = pickInt(rand, 1, 9);
    const val = tenths * 0.1 + hundredths * 0.01;
    return { ...makeMC(`What is the hundredths digit of ${val.toFixed(2)}?`, hundredths, rand, { choicesFrom: [hundredths, tenths, 0, hundredths + 1] }),
      explanation: `${val.toFixed(2)} → tenths = ${tenths}, hundredths = ${hundredths}.` };
  },
];

// ---- 5th grade topics ------------------------------------------------------
const TOPICS_G5 = [
  (rand) => { // Add fractions different denom
    const setups = [
      { a: [1, 2], b: [1, 4], sum: [3, 4] }, { a: [1, 2], b: [1, 3], sum: [5, 6] },
      { a: [1, 4], b: [1, 8], sum: [3, 8] }, { a: [1, 3], b: [1, 6], sum: [3, 6] },
      { a: [1, 5], b: [1, 10], sum: [3, 10] }, { a: [2, 3], b: [1, 6], sum: [5, 6] },
    ];
    const s = setups[pickInt(rand, 0, setups.length - 1)];
    const answer = `${s.sum[0]}/${s.sum[1]}`;
    return { prompt: `${s.a[0]}/${s.a[1]} + ${s.b[0]}/${s.b[1]} = ?`, choices: shuffle([answer, `${s.a[0]+s.b[0]}/${s.a[1]+s.b[1]}`, `${s.sum[0]+1}/${s.sum[1]}`, `${s.sum[0]}/${s.sum[1]+1}`], rand), answer,
      explanation: `Find a common denominator (${s.sum[1]}). Convert ${s.a[0]}/${s.a[1]} and ${s.b[0]}/${s.b[1]}, then add. Answer: ${answer}.` };
  },
  (rand) => { // Multiply fractions
    const setups = [
      { a: [1, 2], b: [1, 3], prod: [1, 6] }, { a: [2, 3], b: [3, 4], prod: [6, 12] },
      { a: [1, 4], b: [2, 5], prod: [2, 20] }, { a: [3, 5], b: [2, 3], prod: [6, 15] },
    ];
    const s = setups[pickInt(rand, 0, setups.length - 1)];
    const answer = `${s.prod[0]}/${s.prod[1]}`;
    return { prompt: `${s.a[0]}/${s.a[1]} × ${s.b[0]}/${s.b[1]} = ?`, choices: shuffle([answer, `${s.a[0]+s.b[0]}/${s.a[1]+s.b[1]}`, `${s.a[0]*s.b[0]+1}/${s.a[1]*s.b[1]}`, `${s.prod[0]}/${s.prod[1]+1}`], rand), answer,
      explanation: `Multiply tops, multiply bottoms: ${s.a[0]}×${s.b[0]}/${s.a[1]}×${s.b[1]} = ${answer}.` };
  },
  (rand) => { // Decimal addition
    const a = pickInt(rand, 10, 99) / 10, b = pickInt(rand, 10, 99) / 10;
    return { ...makeMC(`${a.toFixed(1)} + ${b.toFixed(1)} = ?`, (a + b).toFixed(1), rand, { choicesFrom: [(a+b).toFixed(1), (a+b-0.1).toFixed(1), (a+b+0.1).toFixed(1), (a+b+1).toFixed(1)] }),
      explanation: `Line up the decimal points and add: ${(a + b).toFixed(1)}.` };
  },
  (rand) => { // Decimal subtraction
    const a = pickInt(rand, 50, 99) / 10, b = pickInt(rand, 10, 49) / 10;
    return { ...makeMC(`${a.toFixed(1)} − ${b.toFixed(1)} = ?`, (a - b).toFixed(1), rand, { choicesFrom: [(a-b).toFixed(1), (a-b-0.1).toFixed(1), (a-b+0.1).toFixed(1), (a-b+1).toFixed(1)] }),
      explanation: `Line up decimal points, subtract: ${(a - b).toFixed(1)}.` };
  },
  (rand) => { // Decimal × whole
    const a = pickInt(rand, 11, 99) / 10, b = pickInt(rand, 2, 9);
    return { ...makeMC(`${a.toFixed(1)} × ${b} = ?`, (a * b).toFixed(1), rand, { choicesFrom: [(a*b).toFixed(1), (a*b-1).toFixed(1), (a*b+1).toFixed(1), (a*b+0.1).toFixed(1)] }),
      explanation: `Multiply as if no decimal (${Math.round(a * 10)} × ${b} = ${Math.round(a * 10) * b}), then place the decimal: ${(a * b).toFixed(1)}.` };
  },
  (rand) => { // Order of operations
    const a = pickInt(rand, 2, 9), b = pickInt(rand, 2, 9), c = pickInt(rand, 2, 9);
    return { ...makeMC(`${a} + ${b} × ${c} = ?`, a + b * c, rand),
      explanation: `PEMDAS: do × first (${b} × ${c} = ${b * c}), then + (${a} + ${b * c} = ${a + b * c}).` };
  },
  (rand) => { // Volume
    const l = pickInt(rand, 2, 8), w = pickInt(rand, 2, 8), h = pickInt(rand, 2, 8);
    return { ...makeMC(`Volume of a ${l} × ${w} × ${h} box?`, l * w * h, rand),
      explanation: `Volume = length × width × height = ${l} × ${w} × ${h} = ${l * w * h}.` };
  },
  (rand) => { // Compare fractions (LCD)
    const setups = [
      { a: [1, 2], b: [3, 5], cmp: "<" }, { a: [2, 3], b: [3, 4], cmp: "<" }, { a: [5, 6], b: [3, 4], cmp: ">" },
      { a: [1, 3], b: [2, 5], cmp: "<" }, { a: [4, 5], b: [3, 4], cmp: ">" },
    ];
    const s = setups[pickInt(rand, 0, setups.length - 1)];
    return { prompt: `Compare:  ${s.a[0]}/${s.a[1]}  ?  ${s.b[0]}/${s.b[1]}`, choices: [">", "<", "=", "≠"], answer: s.cmp,
      explanation: `Find a common denominator. ${s.a[0]}/${s.a[1]} ${s.cmp} ${s.b[0]}/${s.b[1]}.` };
  },
  (rand) => { // Fraction → decimal
    const setups = [["1/2","0.5"],["1/4","0.25"],["3/4","0.75"],["1/5","0.2"],["2/5","0.4"],["1/10","0.1"],["3/10","0.3"],["3/5","0.6"]];
    const s = setups[pickInt(rand, 0, setups.length - 1)];
    const pool = ["0.5","0.25","0.75","0.2","0.4","0.1","0.3","0.6","0.05","0.15","0.35"];
    const distractors = shuffle(pool.filter((v) => v !== s[1]), rand).slice(0, 3);
    return { prompt: `Convert ${s[0]} to a decimal.`, choices: shuffle([s[1], ...distractors], rand), answer: s[1],
      explanation: `${s[0]} as a division: top ÷ bottom = ${s[1]}.` };
  },
  (rand) => { // Coordinate plane
    const x = pickInt(rand, 1, 6), y = pickInt(rand, 1, 6);
    return { ...makeMC(`What quadrant is the point (${x}, ${y}) in?  (positive x, positive y)`, "I", rand, { choicesFrom: ["I", "II", "III", "IV"] }),
      explanation: `Both x and y are positive → top-right → Quadrant I.` };
  },
  (rand) => { // Word: fraction word
    const denom = [4, 5, 6][pickInt(rand, 0, 2)];
    const num = pickInt(rand, 1, denom - 1);
    const whole = denom * pickInt(rand, 3, 8);
    return { ...makeMC(`${num}/${denom} of ${whole} cards. How many?`, (num * whole) / denom, rand),
      explanation: `${whole} ÷ ${denom} = ${whole / denom} per unit. ${num} units = ${num} × ${whole / denom} = ${(num * whole) / denom}.` };
  },
  // ---- Singapore math additions ----
  (rand) => { // Bar model with fractions (Singapore staple)
    const denom = [4, 5, 6][pickInt(rand, 0, 2)];
    const num = pickInt(rand, 1, denom - 1);
    const whole = denom * pickInt(rand, 4, 10);
    return { ...makeMC(`${num}/${denom} of a trainer's ${whole} cards are Fire-type. How many are NOT Fire?`, whole - (num * whole) / denom, rand, { minChoice: 0 }),
      explanation: `Fire: ${num}/${denom} × ${whole} = ${(num * whole) / denom}. Not Fire: ${whole} − ${(num * whole) / denom} = ${whole - (num * whole) / denom}.` };
  },
  (rand) => { // Multiply mixed by whole (Singapore CPA)
    const whole = pickInt(rand, 1, 3), num = pickInt(rand, 1, 3), denom = pickInt(rand, 2, 5);
    const k = pickInt(rand, 2, 4);
    const total = (whole * denom + num) * k;
    return { ...makeMC(`${whole} ${num}/${denom} × ${k} = ?  (give the answer as an improper fraction over ${denom})`, total, rand, { minChoice: 1 }),
      explanation: `Convert ${whole} ${num}/${denom} = ${whole * denom + num}/${denom}. Times ${k} = ${total}/${denom}.` };
  },
  (rand) => { // Bar model: "before and after"
    const before = pickInt(rand, 20, 50), gain = pickInt(rand, 5, 15);
    const after = before + gain;
    return { ...makeMC(`A trainer had $${before} and earned more, ending with $${after}. How much earned?`, gain, rand, { minChoice: 1 }),
      explanation: `After − before = earned: ${after} − ${before} = ${gain}.` };
  },
  (rand) => { // Long division (whole quotient)
    const b = pickInt(rand, 3, 9), q = pickInt(rand, 6, 12);
    return { ...makeMC(`${b * q} ÷ ${b} = ?`, q, rand, { minChoice: 1 }),
      explanation: `${b} × ${q} = ${b * q}, so ${b * q} ÷ ${b} = ${q}.` };
  },
  (rand) => { // Average (mean intro)
    const nums = Array.from({ length: 4 }, () => pickInt(rand, 5, 25));
    const sum = nums.reduce((s, n) => s + n, 0);
    if (sum % 4 !== 0) nums[0] += 4 - (sum % 4);
    const total = nums.reduce((s, n) => s + n, 0);
    return { ...makeMC(`Average of ${nums.join(", ")} = ?`, total / 4, rand, { minChoice: 0 }),
      explanation: `Sum = ${total}. Divide by count (4): ${total} ÷ 4 = ${total / 4}.` };
  },
  (rand) => { // Percent of a number (intro)
    const pct = [10, 25, 50][pickInt(rand, 0, 2)];
    const whole = pickInt(rand, 4, 20) * 4;
    return { ...makeMC(`${pct}% of ${whole} = ?`, (pct * whole) / 100, rand, { minChoice: 0 }),
      explanation: `${pct}% = ${pct}/100. So ${pct}/100 × ${whole} = ${(pct * whole) / 100}.` };
  },
];

// ---- 6th grade topics ------------------------------------------------------
const TOPICS_G6 = [
  (rand) => { // Percentages of a number
    const pct = [10, 20, 25, 50, 75][pickInt(rand, 0, 4)];
    const whole = pickInt(rand, 4, 20) * 5;
    return { ...makeMC(`${pct}% of ${whole} = ?`, (pct / 100) * whole, rand),
      explanation: `${pct}% = ${pct}/100. So ${pct}/100 × ${whole} = ${(pct / 100) * whole}.` };
  },
  (rand) => { // Convert fraction → percent
    const setups = [["1/2","50%"],["1/4","25%"],["3/4","75%"],["1/5","20%"],["1/10","10%"],["2/5","40%"],["3/5","60%"],["3/10","30%"]];
    const s = setups[pickInt(rand, 0, setups.length - 1)];
    const pool = ["50%","25%","75%","20%","10%","40%","60%","30%","5%","15%","35%"];
    const distractors = shuffle(pool.filter((v) => v !== s[1]), rand).slice(0, 3);
    return { prompt: `Convert ${s[0]} to a percent.`, choices: shuffle([s[1], ...distractors], rand), answer: s[1],
      explanation: `${s[0]} = decimal × 100% = ${s[1]}.` };
  },
  (rand) => { // Add neg + pos
    const a = pickInt(rand, -15, -1), b = pickInt(rand, 1, 15);
    return { ...makeMC(`${a} + ${b} = ?`, a + b, rand),
      explanation: `On a number line, start at ${a} and move ${b} to the right → ${a + b}.` };
  },
  (rand) => { // Subtract integers
    const a = pickInt(rand, -10, 10), b = pickInt(rand, -10, 10);
    return { ...makeMC(`${a} − ${b} = ?`, a - b, rand),
      explanation: `Subtracting is adding the opposite: ${a} + (${-b}) = ${a - b}.` };
  },
  (rand) => { // Multiply signed
    const a = pickInt(rand, -10, 10), b = pickInt(rand, -10, 10);
    if (a === 0 || b === 0) {
      const aa = a || 1, bb = b || 1;
      return { ...makeMC(`${aa} × ${bb} = ?`, aa * bb, rand),
        explanation: `Same signs → +, different signs → −. Answer: ${aa * bb}.` };
    }
    return { ...makeMC(`${a} × ${b} = ?`, a * b, rand),
      explanation: `Signs: ${a < 0 ? "−" : "+"} × ${b < 0 ? "−" : "+"} = ${a * b < 0 ? "−" : "+"}. Magnitude: ${Math.abs(a)} × ${Math.abs(b)} = ${Math.abs(a * b)}.` };
  },
  (rand) => { // Simplify ratio
    const ratios = [[1, 2], [1, 3], [1, 4], [2, 3], [3, 4], [2, 5], [3, 5]];
    const [a, b] = ratios[pickInt(rand, 0, ratios.length - 1)];
    const k = pickInt(rand, 2, 5);
    const choices = new Set([`${a}:${b}`]);
    while (choices.size < 4) {
      const [da, db] = ratios[pickInt(rand, 0, ratios.length - 1)];
      choices.add(`${da}:${db}`);
    }
    return { prompt: `Simplify the ratio ${a * k} : ${b * k}.`, choices: shuffle([...choices], rand), answer: `${a}:${b}`,
      explanation: `Divide both sides by their common factor (${k}): ${a * k}÷${k} : ${b * k}÷${k} = ${a}:${b}.` };
  },
  (rand) => { // Evaluate expression
    const x = pickInt(rand, 2, 9), m = pickInt(rand, 2, 6), b = pickInt(rand, 1, 10);
    return { ...makeMC(`If x = ${x}, what is ${m}x + ${b}?`, m * x + b, rand),
      explanation: `Substitute x = ${x}: ${m} × ${x} + ${b} = ${m * x} + ${b} = ${m * x + b}.` };
  },
  (rand) => { // One-step equation
    const x = pickInt(rand, 2, 12), b = pickInt(rand, 1, 20);
    return { ...makeMC(`Solve:  x + ${b} = ${x + b}`, x, rand, { minChoice: 0 }),
      explanation: `Subtract ${b} from both sides: x = ${x + b} − ${b} = ${x}.` };
  },
  (rand) => { // Mean
    const nums = Array.from({ length: 4 }, () => pickInt(rand, 2, 12));
    const sum = nums.reduce((s, n) => s + n, 0);
    if (sum % 4 !== 0) nums[0] += 4 - (sum % 4);
    const total = nums.reduce((s, n) => s + n, 0);
    return { ...makeMC(`Mean of ${nums.join(", ")} = ?`, total / 4, rand),
      explanation: `Mean = sum ÷ count = ${total} ÷ 4 = ${total / 4}.` };
  },
  (rand) => { // GCF
    const setups = [[12, 18, 6], [20, 30, 10], [16, 24, 8], [9, 12, 3], [15, 25, 5], [14, 21, 7]];
    const s = setups[pickInt(rand, 0, setups.length - 1)];
    return { ...makeMC(`GCF of ${s[0]} and ${s[1]}?`, s[2], rand, { minChoice: 1 }),
      explanation: `The largest number that divides both ${s[0]} and ${s[1]} evenly is ${s[2]}.` };
  },
  (rand) => { // Area of triangle
    const b = pickInt(rand, 2, 12) * 2, h = pickInt(rand, 3, 10);
    return { ...makeMC(`Triangle with base ${b} and height ${h}.  Area = ?`, (b * h) / 2, rand),
      explanation: `Triangle area = ½ × base × height = ½ × ${b} × ${h} = ${(b * h) / 2}.` };
  },
  (rand) => { // Percent word
    const items = pickInt(rand, 4, 20) * 5;
    const pct = [10, 20, 25, 50][pickInt(rand, 0, 3)];
    return { ...makeMC(`${pct}% of ${items} Pokémon are Water type. How many?`, (pct * items) / 100, rand),
      explanation: `${pct}% = ${pct}/100. ${pct}/100 × ${items} = ${(pct * items) / 100}.` };
  },
  // ---- Singapore math additions ----
  (rand) => { // Ratio bar model (Singapore staple)
    const r1 = pickInt(rand, 2, 5), r2 = pickInt(rand, 2, 5);
    const k = pickInt(rand, 3, 6);
    return { ...makeMC(`The ratio of Fire to Water Pokémon is ${r1}:${r2}. If there are ${r1 * k} Fire, how many Water?`, r2 * k, rand, { minChoice: 1 }),
      explanation: `One "unit" = ${r1 * k} ÷ ${r1} = ${k}. Water has ${r2} units = ${r2 * k}.` };
  },
  (rand) => { // 3-part ratio (Singapore)
    const r1 = 2, r2 = 3, r3 = 5;
    const k = pickInt(rand, 3, 7);
    const total = (r1 + r2 + r3) * k;
    return { ...makeMC(`Three trainers share berries in the ratio 2:3:5. Total berries: ${total}. How many does the LARGEST share?`, r3 * k, rand, { minChoice: 1 }),
      explanation: `Total units = 2 + 3 + 5 = 10. One unit = ${total} ÷ 10 = ${k}. Largest = 5 × ${k} = ${r3 * k}.` };
  },
  (rand) => { // Percent → original (Singapore "model method")
    const part = pickInt(rand, 3, 12) * 5;
    const pct = [10, 20, 25, 50][pickInt(rand, 0, 3)];
    const whole = (part * 100) / pct;
    return { ...makeMC(`${pct}% of a number is ${part}. What is the number?`, whole, rand, { minChoice: 1 }),
      explanation: `If ${pct}% = ${part}, then 100% = ${part} × (100 ÷ ${pct}) = ${whole}.` };
  },
  (rand) => { // Unit rate / better buy
    const items1 = pickInt(rand, 3, 6), cost1 = items1 * pickInt(rand, 2, 4);
    const items2 = items1 + 2, cost2 = items2 * pickInt(rand, 2, 4);
    const r1 = cost1 / items1, r2 = cost2 / items2;
    const answer = r1 < r2 ? "Pack A" : "Pack B";
    return { prompt: `Pack A: ${items1} for $${cost1}. Pack B: ${items2} for $${cost2}. Which is the better buy?`,
      choices: ["Pack A", "Pack B", "Same", "Cannot tell"], answer,
      explanation: `Unit price: A = $${r1.toFixed(2)}/item, B = $${r2.toFixed(2)}/item. ${answer} is cheaper per item.` };
  },
  (rand) => { // Multi-step word with units
    const before = pickInt(rand, 60, 120), pct = [25, 50][pickInt(rand, 0, 1)];
    const spent = (before * pct) / 100;
    return { ...makeMC(`A trainer had $${before} and spent ${pct}% on Pokéballs. How much is left?`, before - spent, rand, { minChoice: 0 }),
      explanation: `Spent: ${pct}% × ${before} = ${spent}. Left: ${before} − ${spent} = ${before - spent}.` };
  },
];

// ---- 7th grade topics ------------------------------------------------------
const TOPICS_G7 = [
  (rand) => { // Two-step equation
    const x = pickInt(rand, 2, 12), m = pickInt(rand, 2, 9), b = pickInt(rand, 1, 15);
    return { ...makeMC(`Solve for x:  ${m}x + ${b} = ${m * x + b}`, x, rand, { minChoice: 0 }),
      explanation: `Subtract ${b}: ${m}x = ${m * x}. Divide by ${m}: x = ${x}.` };
  },
  (rand) => { // One-step
    const x = pickInt(rand, 2, 12), m = pickInt(rand, 2, 9);
    return { ...makeMC(`Solve for x:  ${m}x = ${m * x}`, x, rand, { minChoice: 1 }),
      explanation: `Divide both sides by ${m}: x = ${m * x} ÷ ${m} = ${x}.` };
  },
  (rand) => { // Proportion
    const ratio = [pickInt(rand, 2, 5), pickInt(rand, 2, 5)];
    const k = pickInt(rand, 2, 6);
    return { ...makeMC(`If ${ratio[0]} / ${ratio[1]} = x / ${ratio[1] * k}, what is x?`, ratio[0] * k, rand),
      explanation: `Cross multiply: ${ratio[0]} × ${ratio[1] * k} = ${ratio[1]} × x → x = ${ratio[0] * k}.` };
  },
  (rand) => { // Signed multiplication
    const a = pickInt(rand, -10, 10), b = pickInt(rand, -10, 10);
    if (a === 0 || b === 0) {
      const aa = a || 1, bb = b || 1;
      return { ...makeMC(`${aa} × ${bb} = ?`, aa * bb, rand),
        explanation: `Same signs → positive, different signs → negative.` };
    }
    return { ...makeMC(`${a} × ${b} = ?`, a * b, rand),
      explanation: `Same signs → +, different → −. Magnitude: ${Math.abs(a)} × ${Math.abs(b)} = ${Math.abs(a * b)}.` };
  },
  (rand) => { // Signed division
    const a = pickInt(rand, -10, 10), b = pickInt(rand, 2, 9);
    if (a === 0) return { ...makeMC(`-${b * 2} ÷ ${b} = ?`, -2, rand), explanation: `Same rules as multiplication: negative ÷ positive = negative.` };
    return { ...makeMC(`${a * b} ÷ ${b} = ?`, a, rand),
      explanation: `${a * b} ÷ ${b} = ${a}.` };
  },
  (rand) => { // Discount
    const price = pickInt(rand, 10, 50) * 2;
    const pct = [10, 15, 20, 25][pickInt(rand, 0, 3)];
    return { ...makeMC(`A $${price} item is on sale for ${pct}% off. How much do you save?`, (pct * price) / 100, rand),
      explanation: `Savings = ${pct}% × $${price} = ${pct}/100 × ${price} = $${(pct * price) / 100}.` };
  },
  (rand) => { // Probability
    const total = pickInt(rand, 4, 10), wanted = pickInt(rand, 1, total - 1);
    return { ...makeMC(`A bag has ${total} balls — ${wanted} red, the rest blue. Probability of red?`, `${wanted}/${total}`, rand, {
        choicesFrom: [`${wanted}/${total}`, `${total - wanted}/${total}`, `${wanted}/${total - wanted}`, `${total}/${wanted}`],
      }),
      explanation: `P(red) = favorable ÷ total = ${wanted}/${total}.` };
  },
  (rand) => { // Simplify expression
    const a = pickInt(rand, 2, 6), b = pickInt(rand, 1, 5);
    return { ...makeMC(`Simplify:  ${a}x + ${b}x`, `${a + b}x`, rand, { choicesFrom: [`${a + b}x`, `${a * b}x`, `${a - b}x`, `${a + b}`] }),
      explanation: `Like terms — add coefficients: (${a} + ${b})x = ${a + b}x.` };
  },
  (rand) => { // Square roots
    const n = [4, 9, 16, 25, 36, 49, 64, 81, 100][pickInt(rand, 0, 8)];
    return { ...makeMC(`√${n} = ?`, Math.sqrt(n), rand, { minChoice: 1 }),
      explanation: `${Math.sqrt(n)} × ${Math.sqrt(n)} = ${n}, so √${n} = ${Math.sqrt(n)}.` };
  },
  (rand) => { // Percent change
    const before = pickInt(rand, 20, 80);
    const after = before + pickInt(rand, 5, 20);
    const change = Math.round((100 * (after - before)) / before);
    return { ...makeMC(`A price went from $${before} to $${after}. Percent increase (rounded)?`, change, rand, { minChoice: 0 }),
      explanation: `% change = (new − old) / old × 100 = (${after} − ${before}) / ${before} × 100 ≈ ${change}%.` };
  },
  (rand) => { // Inequality
    const x = pickInt(rand, 2, 10), b = pickInt(rand, 1, 10);
    return { ...makeMC(`Solve:  x + ${b} > ${x + b - 1}  →  x > ?`, x - 1, rand, { minChoice: 0 }),
      explanation: `Subtract ${b}: x > ${x + b - 1} − ${b} = ${x - 1}.` };
  },
  (rand) => { // Unit rate
    const items = pickInt(rand, 2, 8), price = items * pickInt(rand, 2, 5);
    return { ...makeMC(`${items} Pokéballs cost $${price}. Cost per Pokéball?`, price / items, rand, { minChoice: 1 }),
      explanation: `Total ÷ count = unit rate: $${price} ÷ ${items} = $${price / items}.` };
  },
  // ---- Singapore math additions ----
  (rand) => { // Algebraic bar model
    const x = pickInt(rand, 3, 10), more = pickInt(rand, 2, 8);
    const total = x + (x + more);
    return { ...makeMC(`Two trainers have ${total} cards. One has ${more} more than the other. How many does the smaller-share trainer have?`, x, rand, { minChoice: 0 }),
      explanation: `Let smaller = x. Larger = x + ${more}. Then x + (x + ${more}) = ${total} → 2x = ${total - more} → x = ${x}.` };
  },
  (rand) => { // "Before-after" with units (Singapore signature)
    const before = pickInt(rand, 20, 40);
    const k = [3, 4][pickInt(rand, 0, 1)];
    const after = before * k;
    return { ...makeMC(`A trainer had ${before} cards. Now they have ${k} times as many. How many more cards now?`, after - before, rand, { minChoice: 1 }),
      explanation: `Now: ${k} × ${before} = ${after}. More: ${after} − ${before} = ${after - before}.` };
  },
  (rand) => { // Speed = distance ÷ time
    const speed = pickInt(rand, 20, 60), time = pickInt(rand, 2, 5);
    return { ...makeMC(`A trainer walks at ${speed} m/min for ${time} minutes. Total distance?`, speed * time, rand),
      explanation: `Distance = speed × time = ${speed} × ${time} = ${speed * time} m.` };
  },
  (rand) => { // Distributive property
    const a = pickInt(rand, 2, 5), b = pickInt(rand, 2, 8), c = pickInt(rand, 2, 8);
    return { ...makeMC(`Expand:  ${a}(x + ${b})`, `${a}x + ${a * b}`, rand, {
        choicesFrom: [`${a}x + ${a * b}`, `${a}x + ${b}`, `${a + b}x`, `${a * b}x`],
      }),
      explanation: `Distribute: ${a} × x + ${a} × ${b} = ${a}x + ${a * b}.` };
  },
  (rand) => { // Simple interest
    const p = pickInt(rand, 100, 500), r = [5, 10][pickInt(rand, 0, 1)], t = pickInt(rand, 1, 3);
    return { ...makeMC(`Simple interest on $${p} at ${r}% for ${t} year(s)?`, (p * r * t) / 100, rand),
      explanation: `I = P × R × T / 100 = ${p} × ${r} × ${t} / 100 = $${(p * r * t) / 100}.` };
  },
];

// ---- 8th grade topics ------------------------------------------------------
const TOPICS_G8 = [
  (rand) => { // Squares
    const n = pickInt(rand, 2, 15);
    return { ...makeMC(`What is ${n}²?`, n * n, rand, { minChoice: 1 }),
      explanation: `${n}² = ${n} × ${n} = ${n * n}.` };
  },
  (rand) => { // Cubes
    const n = pickInt(rand, 2, 8);
    return { ...makeMC(`What is ${n}³?`, n * n * n, rand, { minChoice: 1 }),
      explanation: `${n}³ = ${n} × ${n} × ${n} = ${n * n * n}.` };
  },
  (rand) => { // Square roots
    const n = [4, 9, 16, 25, 36, 49, 64, 81, 100, 121, 144, 169, 196, 225][pickInt(rand, 0, 13)];
    return { ...makeMC(`√${n} = ?`, Math.sqrt(n), rand, { minChoice: 1 }),
      explanation: `${Math.sqrt(n)}² = ${n}.` };
  },
  (rand) => { // Cube roots
    const setups = [[8, 2], [27, 3], [64, 4], [125, 5], [216, 6], [343, 7]];
    const s = setups[pickInt(rand, 0, setups.length - 1)];
    return { ...makeMC(`∛${s[0]} = ?`, s[1], rand, { minChoice: 1 }),
      explanation: `${s[1]}³ = ${s[0]}.` };
  },
  (rand) => { // Pythagorean
    const triples = [[3, 4, 5], [5, 12, 13], [8, 15, 17], [7, 24, 25], [6, 8, 10], [9, 12, 15], [20, 21, 29]];
    const [a, b, c] = triples[pickInt(rand, 0, triples.length - 1)];
    return { ...makeMC(`Right triangle with legs ${a} and ${b}.  Hypotenuse?`, c, rand, { minChoice: 1 }),
      explanation: `a² + b² = c²: ${a * a} + ${b * b} = ${a * a + b * b} = ${c}².` };
  },
  (rand) => { // Slope between points
    const x1 = 0, y1 = pickInt(rand, -5, 5), x2 = pickInt(rand, 1, 5), y2 = y1 + pickInt(rand, -8, 8);
    const slope = (y2 - y1) / (x2 - x1);
    if (!Number.isInteger(slope)) {
      const newY2 = y1 + Math.round(slope) * x2;
      return { ...makeMC(`Slope of the line through (${x1}, ${y1}) and (${x2}, ${newY2})?`, Math.round(slope), rand),
        explanation: `Slope = (y₂ − y₁) / (x₂ − x₁) = (${newY2} − ${y1}) / (${x2} − ${x1}) = ${Math.round(slope)}.` };
    }
    return { ...makeMC(`Slope of the line through (${x1}, ${y1}) and (${x2}, ${y2})?`, slope, rand),
      explanation: `Slope = (${y2} − ${y1}) / (${x2} − ${x1}) = ${slope}.` };
  },
  (rand) => { // Evaluate linear function
    const m = pickInt(rand, 2, 5), b = pickInt(rand, -5, 5), x = pickInt(rand, 1, 6);
    return { ...makeMC(`If f(x) = ${m}x ${b >= 0 ? "+" : "−"} ${Math.abs(b)}, what is f(${x})?`, m * x + b, rand),
      explanation: `Substitute: ${m} × ${x} ${b >= 0 ? "+" : "−"} ${Math.abs(b)} = ${m * x + b}.` };
  },
  (rand) => { // Exponent multiplication
    const a = pickInt(rand, 2, 5), b = pickInt(rand, 2, 5);
    return { ...makeMC(`Simplify:  x^${a} · x^${b}`, `x^${a + b}`, rand, { choicesFrom: [`x^${a+b}`, `x^${a*b}`, `x^${a-b}`, `${a+b}x`] }),
      explanation: `Same base — add exponents: x^${a} · x^${b} = x^${a + b}.` };
  },
  (rand) => { // Exponent power
    const a = pickInt(rand, 2, 4), b = pickInt(rand, 2, 4);
    return { ...makeMC(`Simplify:  (x^${a})^${b}`, `x^${a * b}`, rand, { choicesFrom: [`x^${a*b}`, `x^${a+b}`, `x^${a-b}`, `${a*b}x`] }),
      explanation: `Power of a power — multiply exponents: (x^${a})^${b} = x^${a * b}.` };
  },
  (rand) => { // Scientific notation
    const a = pickInt(rand, 1, 9), e = pickInt(rand, 2, 5);
    const val = a * Math.pow(10, e);
    return { ...makeMC(`Write ${val.toLocaleString()} in scientific notation.`, `${a} × 10^${e}`, rand, {
        choicesFrom: [`${a} × 10^${e}`, `${a} × 10^${e+1}`, `${a} × 10^${e-1}`, `${val} × 10^0`],
      }),
      explanation: `Move the decimal ${e} places left: ${a}.0 × 10^${e}.` };
  },
  (rand) => { // System of equations
    const x = pickInt(rand, 1, 5), y = pickInt(rand, 1, 5);
    return { ...makeMC(`Solve:  x + y = ${x + y},  x − y = ${x - y}.  What's x?`, x, rand, { minChoice: 0 }),
      explanation: `Add equations: 2x = ${(x + y) + (x - y)} = ${2 * x}, so x = ${x}.` };
  },
  (rand) => { // Volume cylinder
    const r = pickInt(rand, 2, 6), h = pickInt(rand, 2, 8);
    const v = Math.round(3.14 * r * r * h);
    return { ...makeMC(`Volume of a cylinder with r=${r}, h=${h} (use π ≈ 3.14, round)?`, v, rand),
      explanation: `V = πr²h = 3.14 × ${r * r} × ${h} ≈ ${v}.` };
  },
  // ---- Singapore math additions ----
  (rand) => { // Algebraic bar model with 3 unknowns
    const x = pickInt(rand, 5, 12);
    const sum = 4 * x;
    return { ...makeMC(`Four equal bars total ${sum}. What's one bar?`, x, rand, { minChoice: 1 }),
      explanation: `4 equal bars = ${sum}, so each bar = ${sum} ÷ 4 = ${x}.` };
  },
  (rand) => { // Work / rate
    const r1 = pickInt(rand, 3, 6), r2 = pickInt(rand, 2, 4);
    const items = r1 * r2 * pickInt(rand, 2, 4);
    const time = items / (r1 + r2);
    return { ...makeMC(`Trainer A catches ${r1}/min, Trainer B catches ${r2}/min. Together, how long to catch ${items}?`, time, rand, { minChoice: 1 }),
      explanation: `Combined rate = ${r1 + r2}/min. Time = ${items} ÷ ${r1 + r2} = ${time} min.` };
  },
  (rand) => { // Slope-intercept y-int
    const m = pickInt(rand, 2, 5), b = pickInt(rand, -5, 5);
    return { ...makeMC(`What's the y-intercept of y = ${m}x ${b >= 0 ? "+" : "−"} ${Math.abs(b)}?`, b, rand),
      explanation: `In y = mx + b, the y-intercept is b = ${b}.` };
  },
  (rand) => { // Pythagorean (find leg)
    const triples = [[3, 4, 5], [5, 12, 13], [8, 15, 17], [6, 8, 10]];
    const [a, b, c] = triples[pickInt(rand, 0, triples.length - 1)];
    return { ...makeMC(`Right triangle: hypotenuse = ${c}, one leg = ${a}. Find the other leg.`, b, rand, { minChoice: 1 }),
      explanation: `b² = c² − a² = ${c * c} − ${a * a} = ${c * c - a * a} = ${b}².` };
  },
  (rand) => { // Ratio with 3 unknowns (Singapore)
    const r1 = 1, r2 = 2, r3 = 3;
    const k = pickInt(rand, 3, 8);
    const total = (r1 + r2 + r3) * k;
    return { ...makeMC(`Three quantities are in the ratio 1:2:3. Total: ${total}. What's the middle one?`, r2 * k, rand, { minChoice: 1 }),
      explanation: `Total units = 1+2+3 = 6. One unit = ${total} ÷ 6 = ${k}. Middle = 2 × ${k} = ${r2 * k}.` };
  },
];

// Helpers used by some topics above.
function listFactors(n) {
  const f = [];
  for (let i = 1; i <= n; i++) if (n % i === 0) f.push(i);
  return f;
}
function pickFactor(n, rand) {
  const fs = listFactors(n).filter((x) => x > 1 && x < n);
  return fs[Math.floor(rand() * fs.length)] || 1;
}

const GENERATORS = {
  prek: (rand) => TOPICS_PREK[Math.floor(rand() * TOPICS_PREK.length)](rand),
  k:    (rand) => TOPICS_K[Math.floor(rand() * TOPICS_K.length)](rand),
  g1:   (rand) => TOPICS_G1[Math.floor(rand() * TOPICS_G1.length)](rand),
  g2:   (rand) => TOPICS_G2[Math.floor(rand() * TOPICS_G2.length)](rand),
  g3:   (rand) => TOPICS_G3[Math.floor(rand() * TOPICS_G3.length)](rand),
  g4:   (rand) => TOPICS_G4[Math.floor(rand() * TOPICS_G4.length)](rand),
  g5:   (rand) => TOPICS_G5[Math.floor(rand() * TOPICS_G5.length)](rand),
  g6:   (rand) => TOPICS_G6[Math.floor(rand() * TOPICS_G6.length)](rand),
  g7:   (rand) => TOPICS_G7[Math.floor(rand() * TOPICS_G7.length)](rand),
  g8:   (rand) => TOPICS_G8[Math.floor(rand() * TOPICS_G8.length)](rand),
};

const TOPIC_COUNTS = {
  prek: TOPICS_PREK.length, k: TOPICS_K.length,
  g1: TOPICS_G1.length, g2: TOPICS_G2.length, g3: TOPICS_G3.length,
  g4: TOPICS_G4.length, g5: TOPICS_G5.length, g6: TOPICS_G6.length,
  g7: TOPICS_G7.length, g8: TOPICS_G8.length,
};

function generateQuiz(gradeId, seed) {
  const rand = mulberry32(seed);
  const gen = GENERATORS[gradeId];
  if (!gen) throw new Error(`Unknown grade: ${gradeId}`);
  const questions = [];
  // Soft dedup: avoid the SAME prompt appearing back-to-back. We allow
  // repetition across the quiz so small-question-space grades (Pre-K,
  // Kindergarten) can still fill 10 slots without becoming exotic.
  let lastPrompt = null;
  let safety = 0;
  while (questions.length < QUIZ_LENGTH && safety++ < 200) {
    const q = gen(rand);
    if (q.prompt === lastPrompt) continue;
    lastPrompt = q.prompt;
    questions.push(q);
  }
  return questions;
}

// ---- State helpers --------------------------------------------------------

function defaultState() {
  return {
    grade: "prek",
    totalCorrect: 0,
    currentStreak: 0,
    bestStreak: 0,
    progressToCard: 0,
    cardsEarned: 0,
    perGradeCorrect: {}, // gradeId → count, used to gate promotion
  };
}

async function loadState(userId) {
  const v = await store.kvGet(`math:${userId}`);
  return v ? { ...defaultState(), ...v } : defaultState();
}
async function saveState(userId, s) {
  await store.kvSet(`math:${userId}`, s, STATE_TTL_SEC);
}

// All grades are always unlocked — pick whichever level fits the learner.
// The PROMOTION_THRESHOLD constant is kept for tests/back-compat but the
// gate is open.
function unlockedGrades(_state) {
  return GRADES.map((g) => g.id);
}

// ---- Routes ---------------------------------------------------------------

function mount(app, supabase, getPokedex) {
  async function loadDex() {
    const v = getPokedex();
    return v && typeof v.then === "function" ? await v : v;
  }

  app.get("/me/math/state", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const s = await loadState(req.user.id);
    res.json({
      grade: s.grade,
      grades: GRADES.map((g) => ({
        id: g.id, label: g.label, order: g.order,
        unlocked: unlockedGrades(s).includes(g.id),
        correct: Number(s.perGradeCorrect?.[g.id] || 0),
      })),
      totalCorrect: s.totalCorrect,
      currentStreak: s.currentStreak,
      bestStreak: s.bestStreak,
      progressToCard: s.progressToCard,
      cardThreshold: CARD_THRESHOLD,
      cardsEarned: s.cardsEarned,
      quizLength: QUIZ_LENGTH,
    });
  });

  app.post("/me/math/start-quiz", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const grade = String(req.body?.grade || "").trim();
    const def = GRADE_BY_ID.get(grade);
    if (!def) return res.status(400).json({ error: "Unknown grade." });
    const s = await loadState(req.user.id);
    if (!unlockedGrades(s).includes(grade)) {
      return res.status(403).json({ error: "Grade locked. Keep practising to unlock it!" });
    }

    // Generate questions server-side. We send (prompt, choices) to the
    // client and stash the correct answers in KV under a quizId, so the
    // client can't fish for the answer by inspecting the response.
    const seed = (Date.now() ^ Math.floor(Math.random() * 0xFFFFFFFF)) >>> 0;
    const full = generateQuiz(grade, seed);
    const quizId = randomUUID();
    await store.kvSet(`math-quiz:${quizId}`, {
      userId: req.user.id,
      grade,
      answers: full.map((q) => q.answer),
      explanations: full.map((q) => q.explanation || ""),
      startedAt: Date.now(),
    }, QUIZ_SESSION_TTL_SEC);

    // Update current grade to the one the player chose so /state reflects
    // the active selection.
    if (s.grade !== grade) {
      s.grade = grade;
      await saveState(req.user.id, s);
    }

    res.json({
      quizId,
      grade,
      questions: full.map((q) => ({ prompt: q.prompt, choices: q.choices })),
    });
  });

  app.post("/me/math/submit", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const { quizId, answers } = req.body || {};
    if (!quizId || !Array.isArray(answers)) {
      return res.status(400).json({ error: "Missing quizId or answers." });
    }
    const session = await store.kvTake(`math-quiz:${quizId}`);
    if (!session) return res.status(404).json({ error: "Quiz expired or already submitted." });
    if (session.userId !== req.user.id) return res.status(403).json({ error: "Not your quiz." });

    const correctness = session.answers.map((a, i) => String(answers[i] ?? "") === String(a));
    const correct = correctness.filter(Boolean).length;
    const total = session.answers.length;

    const s = await loadState(req.user.id);
    s.totalCorrect = (s.totalCorrect || 0) + correct;
    s.perGradeCorrect = s.perGradeCorrect || {};
    s.perGradeCorrect[session.grade] = (s.perGradeCorrect[session.grade] || 0) + correct;
    // Streak counts consecutive correct answers across quizzes — any wrong
    // resets it.
    for (const ok of correctness) {
      if (ok) {
        s.currentStreak = (s.currentStreak || 0) + 1;
        if (s.currentStreak > (s.bestStreak || 0)) s.bestStreak = s.currentStreak;
      } else {
        s.currentStreak = 0;
      }
    }
    s.progressToCard = (s.progressToCard || 0) + correct;
    s.grade = session.grade;

    // Issue a card when the threshold is hit. We roll using the grade's
    // rarity rates so Pre-K/K stay at common/uncommon and 1st+ get the
    // rare/epic/legendary pool the user asked for.
    let reward = null;
    let cardsEarnedThisSubmit = 0;
    while (s.progressToCard >= CARD_THRESHOLD) {
      s.progressToCard -= CARD_THRESHOLD;
      s.cardsEarned = (s.cardsEarned || 0) + 1;
      cardsEarnedThisSubmit += 1;
    }
    // One offer per earned card so each can be claimed independently
    // (the rewards/claim endpoint consumes the whole offer on first call).
    const earnedOffers = [];
    if (cardsEarnedThisSubmit > 0) {
      const pokedex = await loadDex();
      if (pokedex?.length) {
        const def = GRADE_BY_ID.get(session.grade) || GRADE_BY_ID.get("prek");
        for (let i = 0; i < cardsEarnedThisSubmit; i++) {
          const picks = rewards.rollPicks(pokedex, 1, Math.random, {
            allowedRarities: def.rarities,
            rates: def.rates,
          });
          if (!picks.length) continue;
          const offerId = await rewards.createOffer(req.user.id, picks);
          const p = picks[0];
          earnedOffers.push({
            offerId,
            pick: {
              id: p.id, name: p.name, types: p.types, tier: p.tier,
              energyCost: p.energyCost, cardHp: p.cardHp, cardAttack: p.cardAttack,
              sprite_front: p.sprite_front,
              is_legendary: !!p.is_legendary, is_mythical: !!p.is_mythical,
            },
          });
        }
      }
    }
    if (earnedOffers.length) {
      reward = { offers: earnedOffers };
    }

    // Did the player just unlock a new grade? Compare before/after.
    const before = unlockedGrades({ ...s, perGradeCorrect: { ...s.perGradeCorrect, [session.grade]: (s.perGradeCorrect[session.grade] || 0) - correct } });
    const after = unlockedGrades(s);
    const newlyUnlocked = after.filter((g) => !before.includes(g));

    await saveState(req.user.id, s);
    res.json({
      correct,
      total,
      correctness,
      correctAnswers: session.answers,
      explanations: session.explanations || [],
      grade: session.grade,
      progressToCard: s.progressToCard,
      cardThreshold: CARD_THRESHOLD,
      cardsEarned: s.cardsEarned,
      currentStreak: s.currentStreak,
      bestStreak: s.bestStreak,
      reward,
      newlyUnlocked,
    });
  });
}

module.exports = {
  mount,
  // exported for tests
  generateQuiz, GENERATORS, GRADES, QUIZ_LENGTH, CARD_THRESHOLD,
  unlockedGrades, mulberry32, TOPIC_COUNTS,
};
