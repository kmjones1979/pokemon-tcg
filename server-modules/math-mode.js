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
    return makeMC(`How many Pokéballs?  ${balls}`, n, rand, { minChoice: 1, choicesFrom: [1, 2, 3, 4, 5, 6] });
  },
  // Count slightly bigger groups (1-10).
  (rand) => {
    const n = pickInt(rand, 4, 10);
    const balls = "● ".repeat(n).trim();
    return makeMC(`Count: ${balls}`, n, rand, { minChoice: 1 });
  },
  // Which group has more?
  (rand) => {
    let a = pickInt(rand, 1, 8), b = pickInt(rand, 1, 8);
    while (a === b) b = pickInt(rand, 1, 8);
    const A = "★ ".repeat(a).trim(), B = "◆ ".repeat(b).trim();
    const answer = a > b ? "Stars" : "Diamonds";
    return { prompt: `Which has MORE?\n${A}\n${B}`, choices: shuffle(["Stars", "Diamonds", "Same"], rand).concat(["Neither"]).slice(0, 4), answer };
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
    // Always include the correct answer; pick 3 distractors from the rest.
    const others = shapes.filter((s) => s.name !== pick.name).map((s) => s.name);
    const choices = shuffle([pick.name, ...shuffle(others, rand).slice(0, 3)], rand);
    return { prompt: `What shape is this?  ${pick.emoji}`, choices, answer: pick.name };
  },
  // Pattern continuation: AB AB ? → A
  (rand) => {
    const pairs = [["●", "○"], ["★", "◆"], ["🔴", "🔵"], ["▲", "■"]];
    const [a, b] = pairs[pickInt(rand, 0, pairs.length - 1)];
    return makeMC(`What comes next?   ${a} ${b} ${a} ${b} ${a} ?`, b, rand, { choicesFrom: [a, b, "●", "★"] });
  },
  // Missing number in sequence 1-5.
  (rand) => {
    const start = pickInt(rand, 1, 3);
    const missingIdx = pickInt(rand, 1, 2);
    const seq = [start, start + 1, start + 2, start + 3];
    const answer = seq[missingIdx];
    seq[missingIdx] = "?";
    return makeMC(`What's missing?   ${seq.join(", ")}`, answer, rand, { minChoice: 1 });
  },
  // Bigger or smaller number.
  (rand) => {
    let a = pickInt(rand, 1, 9), b = pickInt(rand, 1, 9);
    while (a === b) b = pickInt(rand, 1, 9);
    return makeMC(`Which number is BIGGER?  ${a} or ${b}`, Math.max(a, b), rand, { choicesFrom: [a, b] });
  },
];

// ---- Kindergarten topics (numbers 1-20, simple add/sub within 10) ----------
const TOPICS_K = [
  // Count to 20.
  (rand) => {
    const n = pickInt(rand, 8, 20);
    return makeMC(`Count the Pokéballs:  ${"● ".repeat(n).trim()}`, n, rand, { minChoice: 1 });
  },
  // What comes after?
  (rand) => {
    const n = pickInt(rand, 1, 19);
    return makeMC(`What number comes AFTER ${n}?`, n + 1, rand, { minChoice: 1 });
  },
  // What comes before?
  (rand) => {
    const n = pickInt(rand, 2, 20);
    return makeMC(`What number comes BEFORE ${n}?`, n - 1, rand, { minChoice: 0 });
  },
  // Compare two numbers (>, <, =).
  (rand) => {
    const a = pickInt(rand, 1, 20), b = pickInt(rand, 1, 20);
    const answer = a > b ? ">" : a < b ? "<" : "=";
    return { prompt: `Fill in:   ${a}  ?  ${b}`, choices: [">", "<", "="].concat(["≥"]), answer };
  },
  // Add within 10.
  (rand) => {
    const a = pickInt(rand, 1, 5), b = pickInt(rand, 1, 5);
    return makeMC(`${a} + ${b} = ?`, a + b, rand, { minChoice: 0 });
  },
  // Subtract within 10.
  (rand) => {
    const a = pickInt(rand, 3, 10), b = pickInt(rand, 0, a);
    return makeMC(`${a} − ${b} = ?`, a - b, rand, { minChoice: 0 });
  },
  // Number bonds to 10: 5 + ? = 10.
  (rand) => {
    const total = 10, a = pickInt(rand, 0, 10);
    return makeMC(`${a} + ? = ${total}`, total - a, rand, { minChoice: 0 });
  },
  // Pokémon counting story.
  (rand) => {
    const a = pickInt(rand, 1, 5), b = pickInt(rand, 1, 5);
    const who = pokeName(rand);
    return makeMC(`${who} has ${a} Pokéballs and finds ${b} more. How many now?`, a + b, rand, { minChoice: 0 });
  },
  // Odd or even.
  (rand) => {
    const n = pickInt(rand, 1, 20);
    return { prompt: `Is ${n} even or odd?`, choices: ["Even", "Odd", "Both", "Neither"], answer: n % 2 === 0 ? "Even" : "Odd" };
  },
];

// ---- 1st grade topics (within 20, place value, time, money intro) ----------
const TOPICS_G1 = [
  (rand) => { // Add within 20
    const a = pickInt(rand, 1, 10), b = pickInt(rand, 1, 10);
    return makeMC(`${a} + ${b} = ?`, a + b, rand, { minChoice: 0 });
  },
  (rand) => { // Subtract within 20
    const a = pickInt(rand, 5, 20), b = pickInt(rand, 1, a);
    return makeMC(`${a} − ${b} = ?`, a - b, rand, { minChoice: 0 });
  },
  (rand) => { // Word problem: addition
    const a = pickInt(rand, 1, 10), b = pickInt(rand, 1, 10);
    const who = pokeName(rand);
    return makeMC(`${who} caught ${a} Pokémon, then caught ${b} more. How many in total?`, a + b, rand, { minChoice: 0 });
  },
  (rand) => { // Word problem: subtraction
    const a = pickInt(rand, 6, 20), b = pickInt(rand, 1, a - 1);
    const who = pokeName(rand);
    return makeMC(`${who} had ${a} berries and ate ${b}. How many are left?`, a - b, rand, { minChoice: 0 });
  },
  (rand) => { // Place value: tens and ones
    const tens = pickInt(rand, 1, 9), ones = pickInt(rand, 0, 9);
    return makeMC(`What number is ${tens} tens and ${ones} ones?`, tens * 10 + ones, rand, { minChoice: 0 });
  },
  (rand) => { // Compare two-digit
    const a = pickInt(rand, 10, 99), b = pickInt(rand, 10, 99);
    const answer = a > b ? ">" : a < b ? "<" : "=";
    return { prompt: `Compare:   ${a}  ?  ${b}`, choices: [">", "<", "=", "≠"], answer };
  },
  (rand) => { // Skip count by 2
    const start = pickInt(rand, 2, 10) * 2;
    return makeMC(`Skip counting by 2:  ${start}, ${start + 2}, ${start + 4}, ?`, start + 6, rand);
  },
  (rand) => { // Skip count by 5
    const start = pickInt(rand, 1, 8) * 5;
    return makeMC(`Skip counting by 5:  ${start}, ${start + 5}, ${start + 10}, ?`, start + 15, rand);
  },
  (rand) => { // Number between
    const a = pickInt(rand, 1, 18);
    return makeMC(`What number is between ${a} and ${a + 2}?`, a + 1, rand, { minChoice: 0 });
  },
  (rand) => { // Telling time (hour)
    const h = pickInt(rand, 1, 12);
    return makeMC(`The hour hand points to ${h} and the minute hand is on 12. What time is it?`, `${h}:00`, rand, { choicesFrom: [`${h}:00`, `${h}:30`, `${(h % 12) + 1}:00`, `${h - 1 || 12}:00`] });
  },
  (rand) => { // Doubles
    const a = pickInt(rand, 1, 10);
    return makeMC(`Double ${a} is?`, a * 2, rand, { minChoice: 0 });
  },
];

// ---- 2nd grade topics (within 100, money, time, arrays) --------------------
const TOPICS_G2 = [
  (rand) => { // Add within 100
    const a = pickInt(rand, 10, 50), b = pickInt(rand, 10, 50);
    return makeMC(`${a} + ${b} = ?`, a + b, rand, { minChoice: 0 });
  },
  (rand) => { // Subtract within 100
    const a = pickInt(rand, 30, 99), b = pickInt(rand, 1, a - 1);
    return makeMC(`${a} − ${b} = ?`, a - b, rand, { minChoice: 0 });
  },
  (rand) => { // Two-step word problem
    const a = pickInt(rand, 20, 40), b = pickInt(rand, 1, 15), c = pickInt(rand, 1, 10);
    // Guarantee a non-negative final answer (Pokémon don't owe Pokéballs).
    const safeA = Math.max(a, b);
    const who = pokeName(rand);
    return makeMC(`${who} had ${safeA} Pokéballs, lost ${b}, then found ${c}. How many now?`, safeA - b + c, rand, { minChoice: 0 });
  },
  (rand) => { // Skip counting (2/5/10/100)
    const start = pickInt(rand, 2, 10);
    const step = [2, 5, 10, 100][pickInt(rand, 0, 3)];
    return makeMC(`Skip count by ${step}: ${start}, ${start + step}, ${start + 2 * step}, ?`, start + 3 * step, rand);
  },
  (rand) => { // Place value to 1000
    const h = pickInt(rand, 1, 9), t = pickInt(rand, 0, 9), o = pickInt(rand, 0, 9);
    return makeMC(`What number has ${h} hundreds, ${t} tens, and ${o} ones?`, h * 100 + t * 10 + o, rand);
  },
  (rand) => { // Coin value (cents)
    const coins = [
      { name: "1 penny",    val: 1 },
      { name: "1 nickel",   val: 5 },
      { name: "1 dime",     val: 10 },
      { name: "1 quarter",  val: 25 },
    ];
    const k = pickInt(rand, 1, 4);
    const coin = coins[pickInt(rand, 0, coins.length - 1)];
    return makeMC(`How many cents are ${k} ${coin.name}${k > 1 ? "s" : ""}?`, k * coin.val, rand, { minChoice: 0 });
  },
  (rand) => { // Telling time (5-min)
    const h = pickInt(rand, 1, 12);
    const m = pickInt(rand, 1, 11) * 5;
    return makeMC(`Time is ${h} o'clock plus ${m} minutes. What time?`, `${h}:${String(m).padStart(2, "0")}`, rand, { choicesFrom: [`${h}:${String(m).padStart(2,"0")}`, `${h}:${String((m+5)%60).padStart(2,"0")}`, `${h+1}:00`, `${h}:${String(Math.max(0,m-5)).padStart(2,"0")}`] });
  },
  (rand) => { // Array (repeated addition → multiplication intro)
    const rows = pickInt(rand, 2, 5), cols = pickInt(rand, 2, 5);
    return makeMC(`${rows} rows of ${cols} Pokéballs. How many total?`, rows * cols, rand);
  },
  (rand) => { // Doubling within 50
    const a = pickInt(rand, 11, 25);
    return makeMC(`Double ${a} is?`, a * 2, rand);
  },
  (rand) => { // Half (intro to division)
    const a = pickInt(rand, 1, 25) * 2;
    return makeMC(`Half of ${a} is?`, a / 2, rand, { minChoice: 0 });
  },
  (rand) => { // Even/odd
    const n = pickInt(rand, 10, 99);
    return { prompt: `Is ${n} even or odd?`, choices: ["Even", "Odd", "Prime", "Composite"], answer: n % 2 === 0 ? "Even" : "Odd" };
  },
];

// ---- 3rd grade topics (multiplication, division, fractions, area) ----------
const TOPICS_G3 = [
  (rand) => { // Times tables 0-10
    const a = pickInt(rand, 2, 10), b = pickInt(rand, 2, 10);
    return makeMC(`${a} × ${b} = ?`, a * b, rand, { minChoice: 0 });
  },
  (rand) => { // Division
    const b = pickInt(rand, 2, 10), q = pickInt(rand, 2, 10);
    return makeMC(`${b * q} ÷ ${b} = ?`, q, rand, { minChoice: 1 });
  },
  (rand) => { // Fraction of a set
    const denom = [2, 3, 4][pickInt(rand, 0, 2)];
    const whole = denom * pickInt(rand, 2, 8);
    return makeMC(`1/${denom} of ${whole} = ?`, whole / denom, rand, { minChoice: 0 });
  },
  (rand) => { // Equivalent fractions
    const num = pickInt(rand, 1, 4), denom = pickInt(rand, num + 1, 6);
    const k = pickInt(rand, 2, 4);
    return makeMC(`Which is equivalent to ${num}/${denom}?`, `${num * k}/${denom * k}`, rand, {
      choicesFrom: [`${num * k}/${denom * k}`, `${num + 1}/${denom}`, `${num}/${denom + k}`, `${num * 2}/${denom + 1}`],
    });
  },
  (rand) => { // Area (length × width)
    const l = pickInt(rand, 2, 12), w = pickInt(rand, 2, 12);
    return makeMC(`Rectangle with length ${l} and width ${w}.  Area = ?`, l * w, rand);
  },
  (rand) => { // Perimeter
    const l = pickInt(rand, 2, 12), w = pickInt(rand, 2, 12);
    return makeMC(`Rectangle with sides ${l} and ${w}. Perimeter = ?`, 2 * (l + w), rand);
  },
  (rand) => { // Round to nearest 10
    const n = pickInt(rand, 11, 99);
    return makeMC(`Round ${n} to the nearest 10.`, Math.round(n / 10) * 10, rand);
  },
  (rand) => { // Round to nearest 100
    const n = pickInt(rand, 101, 999);
    return makeMC(`Round ${n} to the nearest 100.`, Math.round(n / 100) * 100, rand);
  },
  (rand) => { // Word problem: multiplication
    const a = pickInt(rand, 3, 8), b = pickInt(rand, 2, 6);
    const who = pokeName(rand);
    return makeMC(`${who} has ${a} packs of cards with ${b} cards each. Total cards?`, a * b, rand);
  },
  (rand) => { // Word problem: division
    const b = pickInt(rand, 2, 8), q = pickInt(rand, 3, 9);
    const who = pokeName(rand);
    return makeMC(`${who} shares ${b * q} berries equally with ${b} friends. Each friend gets?`, q, rand, { minChoice: 1 });
  },
  (rand) => { // Time elapsed
    const h1 = pickInt(rand, 1, 8), h2 = h1 + pickInt(rand, 1, 4);
    return makeMC(`From ${h1}:00 to ${h2}:00 — how many hours?`, h2 - h1, rand, { minChoice: 1 });
  },
  (rand) => { // Multiples of N
    const n = pickInt(rand, 2, 9);
    const choices = [n * 2, n * 3, n * 4, n * 2 + 1];
    return makeMC(`Which is a multiple of ${n}?`, n * pickInt(rand, 2, 4), rand, { choicesFrom: choices });
  },
];

// ---- 4th grade topics ------------------------------------------------------
const TOPICS_G4 = [
  (rand) => { // 2-digit × 1-digit
    const a = pickInt(rand, 11, 30), b = pickInt(rand, 2, 9);
    return makeMC(`${a} × ${b} = ?`, a * b, rand);
  },
  (rand) => { // 3-digit × 1-digit
    const a = pickInt(rand, 101, 250), b = pickInt(rand, 2, 6);
    return makeMC(`${a} × ${b} = ?`, a * b, rand);
  },
  (rand) => { // Long division with remainder
    const b = pickInt(rand, 2, 12), q = pickInt(rand, 4, 15), r = pickInt(rand, 0, b - 1);
    return makeMC(`${b * q + r} ÷ ${b} has remainder?`, r, rand, { minChoice: 0 });
  },
  (rand) => { // Add fractions same denom
    const denom = [3, 4, 5, 6, 8, 10][pickInt(rand, 0, 5)];
    const a = pickInt(rand, 1, denom - 1), b = pickInt(rand, 1, denom - a);
    return makeMC(`${a}/${denom} + ${b}/${denom} = ?  (numerator)`, a + b, rand, { minChoice: 0 });
  },
  (rand) => { // Subtract fractions same denom
    const denom = [3, 4, 5, 6, 8, 10][pickInt(rand, 0, 5)];
    const a = pickInt(rand, 2, denom - 1), b = pickInt(rand, 1, a - 1);
    return makeMC(`${a}/${denom} − ${b}/${denom} = ?  (numerator)`, a - b, rand, { minChoice: 0 });
  },
  (rand) => { // Compare decimals
    const a = pickInt(rand, 1, 99) / 10, b = pickInt(rand, 1, 99) / 10;
    const answer = a > b ? ">" : a < b ? "<" : "=";
    return { prompt: `Compare:  ${a.toFixed(1)}  ?  ${b.toFixed(1)}`, choices: [">", "<", "=", "≠"], answer };
  },
  (rand) => { // Factors
    const n = [12, 18, 20, 24, 30, 36][pickInt(rand, 0, 5)];
    const facts = listFactors(n).filter((x) => x > 1 && x < n);
    const correct = facts[Math.floor(rand() * facts.length)];
    // Non-factors near the answer make plausible distractors.
    const nonFactors = [];
    for (let i = 2; i <= n; i++) if (n % i !== 0) nonFactors.push(i);
    const distractors = shuffle(nonFactors, rand).slice(0, 3);
    return { prompt: `Which is a factor of ${n}?`, choices: shuffle([correct, ...distractors], rand).map(String), answer: String(correct) };
  },
  (rand) => { // Multiples
    const n = pickInt(rand, 3, 9);
    const correct = n * pickInt(rand, 4, 9);
    const distractors = [correct + 1, correct - 1, correct + n - 1, correct - n + 1];
    return makeMC(`Which is a multiple of ${n}?`, correct, rand, { choicesFrom: [correct, ...distractors] });
  },
  (rand) => { // Convert mixed → improper
    const whole = pickInt(rand, 1, 4), num = pickInt(rand, 1, 5), denom = num + pickInt(rand, 1, 4);
    const answer = `${whole * denom + num}/${denom}`;
    const candidates = [
      `${whole * denom + num}/${denom}`,
      `${whole + num}/${denom}`,
      `${whole * denom - num}/${denom}`,
      `${num * denom + whole}/${denom}`,
      `${(whole + 1) * denom + num}/${denom}`,
      `${whole * denom + num + 1}/${denom}`,
    ];
    const distinct = [];
    for (const c of candidates) if (c !== answer && !distinct.includes(c) && distinct.length < 3) distinct.push(c);
    return { prompt: `Convert ${whole} ${num}/${denom} to an improper fraction.`, choices: shuffle([answer, ...distinct], rand), answer };
  },
  (rand) => { // Fraction of a set, larger
    const denom = [3, 4, 5, 6][pickInt(rand, 0, 3)];
    const num = pickInt(rand, 1, denom - 1);
    const whole = denom * pickInt(rand, 3, 10);
    return makeMC(`${num}/${denom} of ${whole} = ?`, (num * whole) / denom, rand, { minChoice: 0 });
  },
  (rand) => { // Word: multi-step
    const a = pickInt(rand, 15, 50), b = pickInt(rand, 3, 8);
    const who = pokeName(rand);
    return makeMC(`${who} earns ${b} berries per match and played ${a} matches. Total berries?`, a * b, rand);
  },
  (rand) => { // Decimal place value
    const d = pickInt(rand, 10, 99);
    const a = d / 100;
    return makeMC(`What is the tens digit of ${a.toFixed(2)}?`, 0, rand, { choicesFrom: [0, Math.floor(d / 10), d % 10, 1] });
  },
];

// ---- 5th grade topics ------------------------------------------------------
const TOPICS_G5 = [
  (rand) => { // Add fractions different denom (simple)
    // Use friendly pairs: 1/2 + 1/4, 1/3 + 1/6, etc.
    const setups = [
      { a: [1, 2], b: [1, 4], sum: [3, 4] },
      { a: [1, 2], b: [1, 3], sum: [5, 6] },
      { a: [1, 4], b: [1, 8], sum: [3, 8] },
      { a: [1, 3], b: [1, 6], sum: [3, 6] },
      { a: [1, 5], b: [1, 10], sum: [3, 10] },
      { a: [2, 3], b: [1, 6], sum: [5, 6] },
    ];
    const s = setups[pickInt(rand, 0, setups.length - 1)];
    const answer = `${s.sum[0]}/${s.sum[1]}`;
    return { prompt: `${s.a[0]}/${s.a[1]} + ${s.b[0]}/${s.b[1]} = ?`, choices: shuffle([answer, `${s.a[0]+s.b[0]}/${s.a[1]+s.b[1]}`, `${s.sum[0]+1}/${s.sum[1]}`, `${s.sum[0]}/${s.sum[1]+1}`], rand), answer };
  },
  (rand) => { // Multiply fractions
    const setups = [
      { a: [1, 2], b: [1, 3], prod: [1, 6] },
      { a: [2, 3], b: [3, 4], prod: [6, 12] },
      { a: [1, 4], b: [2, 5], prod: [2, 20] },
      { a: [3, 5], b: [2, 3], prod: [6, 15] },
    ];
    const s = setups[pickInt(rand, 0, setups.length - 1)];
    const answer = `${s.prod[0]}/${s.prod[1]}`;
    return { prompt: `${s.a[0]}/${s.a[1]} × ${s.b[0]}/${s.b[1]} = ?`, choices: shuffle([answer, `${s.a[0]+s.b[0]}/${s.a[1]+s.b[1]}`, `${s.a[0]*s.b[0]+1}/${s.a[1]*s.b[1]}`, `${s.prod[0]}/${s.prod[1]+1}`], rand), answer };
  },
  (rand) => { // Decimal addition
    const a = pickInt(rand, 10, 99) / 10, b = pickInt(rand, 10, 99) / 10;
    return makeMC(`${a.toFixed(1)} + ${b.toFixed(1)} = ?`, (a + b).toFixed(1), rand, { choicesFrom: [(a+b).toFixed(1), (a+b-0.1).toFixed(1), (a+b+0.1).toFixed(1), (a+b+1).toFixed(1)] });
  },
  (rand) => { // Decimal subtraction
    const a = pickInt(rand, 50, 99) / 10, b = pickInt(rand, 10, 49) / 10;
    return makeMC(`${a.toFixed(1)} − ${b.toFixed(1)} = ?`, (a - b).toFixed(1), rand, { choicesFrom: [(a-b).toFixed(1), (a-b-0.1).toFixed(1), (a-b+0.1).toFixed(1), (a-b+1).toFixed(1)] });
  },
  (rand) => { // Decimal × whole
    const a = pickInt(rand, 11, 99) / 10, b = pickInt(rand, 2, 9);
    return makeMC(`${a.toFixed(1)} × ${b} = ?`, (a * b).toFixed(1), rand, { choicesFrom: [(a*b).toFixed(1), (a*b-1).toFixed(1), (a*b+1).toFixed(1), (a*b+0.1).toFixed(1)] });
  },
  (rand) => { // Order of operations
    const a = pickInt(rand, 2, 9), b = pickInt(rand, 2, 9), c = pickInt(rand, 2, 9);
    return makeMC(`${a} + ${b} × ${c} = ?`, a + b * c, rand);
  },
  (rand) => { // Volume
    const l = pickInt(rand, 2, 8), w = pickInt(rand, 2, 8), h = pickInt(rand, 2, 8);
    return makeMC(`Volume of a ${l} × ${w} × ${h} box?`, l * w * h, rand);
  },
  (rand) => { // Compare fractions (LCD)
    const setups = [
      { a: [1, 2], b: [3, 5], cmp: "<" },
      { a: [2, 3], b: [3, 4], cmp: "<" },
      { a: [5, 6], b: [3, 4], cmp: ">" },
      { a: [1, 3], b: [2, 5], cmp: "<" },
      { a: [4, 5], b: [3, 4], cmp: ">" },
    ];
    const s = setups[pickInt(rand, 0, setups.length - 1)];
    return { prompt: `Compare:  ${s.a[0]}/${s.a[1]}  ?  ${s.b[0]}/${s.b[1]}`, choices: [">", "<", "=", "≠"], answer: s.cmp };
  },
  (rand) => { // Fraction → decimal
    const setups = [["1/2","0.5"],["1/4","0.25"],["3/4","0.75"],["1/5","0.2"],["2/5","0.4"],["1/10","0.1"],["3/10","0.3"],["3/5","0.6"]];
    const s = setups[pickInt(rand, 0, setups.length - 1)];
    const pool = ["0.5","0.25","0.75","0.2","0.4","0.1","0.3","0.6","0.05","0.15","0.35"];
    const distractors = shuffle(pool.filter((v) => v !== s[1]), rand).slice(0, 3);
    return { prompt: `Convert ${s[0]} to a decimal.`, choices: shuffle([s[1], ...distractors], rand), answer: s[1] };
  },
  (rand) => { // Coordinate plane
    const x = pickInt(rand, 1, 6), y = pickInt(rand, 1, 6);
    return makeMC(`What quadrant is the point (${x}, ${y}) in?  (positive x, positive y)`, "I", rand, { choicesFrom: ["I", "II", "III", "IV"] });
  },
  (rand) => { // Word: fraction word
    const denom = [4, 5, 6][pickInt(rand, 0, 2)];
    const num = pickInt(rand, 1, denom - 1);
    const whole = denom * pickInt(rand, 3, 8);
    return makeMC(`${num}/${denom} of ${whole} cards. How many?`, (num * whole) / denom, rand);
  },
];

// ---- 6th grade topics ------------------------------------------------------
const TOPICS_G6 = [
  (rand) => { // Percentages of a number
    const pct = [10, 20, 25, 50, 75][pickInt(rand, 0, 4)];
    const whole = pickInt(rand, 4, 20) * 5;
    return makeMC(`${pct}% of ${whole} = ?`, (pct / 100) * whole, rand);
  },
  (rand) => { // Convert fraction → percent
    const setups = [["1/2","50%"],["1/4","25%"],["3/4","75%"],["1/5","20%"],["1/10","10%"],["2/5","40%"],["3/5","60%"],["3/10","30%"]];
    const s = setups[pickInt(rand, 0, setups.length - 1)];
    const pool = ["50%","25%","75%","20%","10%","40%","60%","30%","5%","15%","35%"];
    const distractors = shuffle(pool.filter((v) => v !== s[1]), rand).slice(0, 3);
    return { prompt: `Convert ${s[0]} to a percent.`, choices: shuffle([s[1], ...distractors], rand), answer: s[1] };
  },
  (rand) => { // Add negative + positive
    const a = pickInt(rand, -15, -1), b = pickInt(rand, 1, 15);
    return makeMC(`${a} + ${b} = ?`, a + b, rand);
  },
  (rand) => { // Subtract integers
    const a = pickInt(rand, -10, 10), b = pickInt(rand, -10, 10);
    return makeMC(`${a} − ${b} = ?`, a - b, rand);
  },
  (rand) => { // Multiply integers (signed)
    const a = pickInt(rand, -10, 10), b = pickInt(rand, -10, 10);
    if (a === 0 || b === 0) return makeMC(`${a || 1} × ${b || 1} = ?`, (a || 1) * (b || 1), rand);
    return makeMC(`${a} × ${b} = ?`, a * b, rand);
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
    return { prompt: `Simplify the ratio ${a * k} : ${b * k}.`, choices: shuffle([...choices], rand), answer: `${a}:${b}` };
  },
  (rand) => { // Evaluate expression
    const x = pickInt(rand, 2, 9), m = pickInt(rand, 2, 6), b = pickInt(rand, 1, 10);
    return makeMC(`If x = ${x}, what is ${m}x + ${b}?`, m * x + b, rand);
  },
  (rand) => { // One-step equation
    const x = pickInt(rand, 2, 12), b = pickInt(rand, 1, 20);
    return makeMC(`Solve:  x + ${b} = ${x + b}`, x, rand, { minChoice: 0 });
  },
  (rand) => { // Mean of a small list
    const nums = Array.from({ length: 4 }, () => pickInt(rand, 2, 12));
    const sum = nums.reduce((s, n) => s + n, 0);
    if (sum % 4 !== 0) nums[0] += 4 - (sum % 4);
    const total = nums.reduce((s, n) => s + n, 0);
    return makeMC(`Mean of ${nums.join(", ")} = ?`, total / 4, rand);
  },
  (rand) => { // GCF
    const setups = [[12, 18, 6], [20, 30, 10], [16, 24, 8], [9, 12, 3], [15, 25, 5], [14, 21, 7]];
    const s = setups[pickInt(rand, 0, setups.length - 1)];
    return makeMC(`GCF of ${s[0]} and ${s[1]}?`, s[2], rand, { minChoice: 1 });
  },
  (rand) => { // Area of triangle
    const b = pickInt(rand, 2, 12) * 2, h = pickInt(rand, 3, 10);
    return makeMC(`Triangle with base ${b} and height ${h}.  Area = ?`, (b * h) / 2, rand);
  },
  (rand) => { // Percent word
    const items = pickInt(rand, 4, 20) * 5;
    const pct = [10, 20, 25, 50][pickInt(rand, 0, 3)];
    return makeMC(`${pct}% of ${items} Pokémon are Water type. How many?`, (pct * items) / 100, rand);
  },
];

// ---- 7th grade topics ------------------------------------------------------
const TOPICS_G7 = [
  (rand) => { // Two-step equation
    const x = pickInt(rand, 2, 12), m = pickInt(rand, 2, 9), b = pickInt(rand, 1, 15);
    return makeMC(`Solve for x:  ${m}x + ${b} = ${m * x + b}`, x, rand, { minChoice: 0 });
  },
  (rand) => { // One-step (subtraction)
    const x = pickInt(rand, 2, 12), m = pickInt(rand, 2, 9);
    return makeMC(`Solve for x:  ${m}x = ${m * x}`, x, rand, { minChoice: 1 });
  },
  (rand) => { // Proportion
    const ratio = [pickInt(rand, 2, 5), pickInt(rand, 2, 5)];
    const k = pickInt(rand, 2, 6);
    return makeMC(`If ${ratio[0]} / ${ratio[1]} = x / ${ratio[1] * k}, what is x?`, ratio[0] * k, rand);
  },
  (rand) => { // Signed multiplication
    const a = pickInt(rand, -10, 10), b = pickInt(rand, -10, 10);
    if (a === 0 || b === 0) return makeMC(`${a || 1} × ${b || 1} = ?`, (a || 1) * (b || 1), rand);
    return makeMC(`${a} × ${b} = ?`, a * b, rand);
  },
  (rand) => { // Signed division
    const a = pickInt(rand, -10, 10), b = pickInt(rand, 2, 9);
    if (a === 0) return makeMC(`-${b * 2} ÷ ${b} = ?`, -2, rand);
    return makeMC(`${a * b} ÷ ${b} = ?`, a, rand);
  },
  (rand) => { // Tax / tip / discount
    const price = pickInt(rand, 10, 50) * 2;
    const pct = [10, 15, 20, 25][pickInt(rand, 0, 3)];
    return makeMC(`A $${price} item is on sale for ${pct}% off. How much do you save?`, (pct * price) / 100, rand);
  },
  (rand) => { // Probability (single event)
    const total = pickInt(rand, 4, 10), wanted = pickInt(rand, 1, total - 1);
    // Express as a simplified fraction with the obvious form first.
    return makeMC(`A bag has ${total} balls — ${wanted} red, the rest blue. Probability of red?`, `${wanted}/${total}`, rand, {
      choicesFrom: [`${wanted}/${total}`, `${total - wanted}/${total}`, `${wanted}/${total - wanted}`, `${total}/${wanted}`],
    });
  },
  (rand) => { // Simplify expression
    const a = pickInt(rand, 2, 6), b = pickInt(rand, 1, 5);
    return makeMC(`Simplify:  ${a}x + ${b}x`, `${a + b}x`, rand, { choicesFrom: [`${a + b}x`, `${a * b}x`, `${a - b}x`, `${a + b}`] });
  },
  (rand) => { // Square roots (perfect)
    const n = [4, 9, 16, 25, 36, 49, 64, 81, 100][pickInt(rand, 0, 8)];
    return makeMC(`√${n} = ?`, Math.sqrt(n), rand, { minChoice: 1 });
  },
  (rand) => { // Percent of change
    const before = pickInt(rand, 20, 80);
    const after = before + pickInt(rand, 5, 20);
    const change = Math.round((100 * (after - before)) / before);
    return makeMC(`A price went from $${before} to $${after}. Percent increase (rounded)?`, change, rand, { minChoice: 0 });
  },
  (rand) => { // Inequality solve
    const x = pickInt(rand, 2, 10), b = pickInt(rand, 1, 10);
    return makeMC(`Solve:  x + ${b} > ${x + b - 1}  →  x > ?`, x - 1, rand, { minChoice: 0 });
  },
  (rand) => { // Unit rate
    const items = pickInt(rand, 2, 8), price = items * pickInt(rand, 2, 5);
    return makeMC(`${items} Pokéballs cost $${price}. Cost per Pokéball?`, price / items, rand, { minChoice: 1 });
  },
];

// ---- 8th grade topics ------------------------------------------------------
const TOPICS_G8 = [
  (rand) => { // Squares
    const n = pickInt(rand, 2, 15);
    return makeMC(`What is ${n}²?`, n * n, rand, { minChoice: 1 });
  },
  (rand) => { // Cubes
    const n = pickInt(rand, 2, 8);
    return makeMC(`What is ${n}³?`, n * n * n, rand, { minChoice: 1 });
  },
  (rand) => { // Square roots
    const n = [4, 9, 16, 25, 36, 49, 64, 81, 100, 121, 144, 169, 196, 225][pickInt(rand, 0, 13)];
    return makeMC(`√${n} = ?`, Math.sqrt(n), rand, { minChoice: 1 });
  },
  (rand) => { // Cube roots
    const setups = [[8, 2], [27, 3], [64, 4], [125, 5], [216, 6], [343, 7]];
    const s = setups[pickInt(rand, 0, setups.length - 1)];
    return makeMC(`∛${s[0]} = ?`, s[1], rand, { minChoice: 1 });
  },
  (rand) => { // Pythagorean
    const triples = [[3, 4, 5], [5, 12, 13], [8, 15, 17], [7, 24, 25], [6, 8, 10], [9, 12, 15], [20, 21, 29]];
    const [a, b, c] = triples[pickInt(rand, 0, triples.length - 1)];
    return makeMC(`Right triangle with legs ${a} and ${b}.  Hypotenuse?`, c, rand, { minChoice: 1 });
  },
  (rand) => { // Slope between points
    const x1 = 0, y1 = pickInt(rand, -5, 5), x2 = pickInt(rand, 1, 5), y2 = y1 + pickInt(rand, -8, 8);
    const slope = (y2 - y1) / (x2 - x1);
    if (!Number.isInteger(slope)) {
      // Re-roll to keep slope an integer (simpler for MC).
      const adj = y1 + slope * x2 > y2 ? -1 : 1;
      const newY2 = y1 + Math.round(slope) * x2;
      return makeMC(`Slope of the line through (${x1}, ${y1}) and (${x2}, ${newY2})?`, Math.round(slope), rand);
    }
    return makeMC(`Slope of the line through (${x1}, ${y1}) and (${x2}, ${y2})?`, slope, rand);
  },
  (rand) => { // Evaluate linear function
    const m = pickInt(rand, 2, 5), b = pickInt(rand, -5, 5), x = pickInt(rand, 1, 6);
    return makeMC(`If f(x) = ${m}x ${b >= 0 ? "+" : "−"} ${Math.abs(b)}, what is f(${x})?`, m * x + b, rand);
  },
  (rand) => { // Exponent multiplication rule
    const a = pickInt(rand, 2, 5), b = pickInt(rand, 2, 5);
    return makeMC(`Simplify:  x^${a} · x^${b}`, `x^${a + b}`, rand, { choicesFrom: [`x^${a+b}`, `x^${a*b}`, `x^${a-b}`, `${a+b}x`] });
  },
  (rand) => { // Exponent power rule
    const a = pickInt(rand, 2, 4), b = pickInt(rand, 2, 4);
    return makeMC(`Simplify:  (x^${a})^${b}`, `x^${a * b}`, rand, { choicesFrom: [`x^${a*b}`, `x^${a+b}`, `x^${a-b}`, `${a*b}x`] });
  },
  (rand) => { // Scientific notation
    const a = pickInt(rand, 1, 9), e = pickInt(rand, 2, 5);
    const val = a * Math.pow(10, e);
    return makeMC(`Write ${val.toLocaleString()} in scientific notation.`, `${a} × 10^${e}`, rand, {
      choicesFrom: [`${a} × 10^${e}`, `${a} × 10^${e+1}`, `${a} × 10^${e-1}`, `${val} × 10^0`],
    });
  },
  (rand) => { // System of equations (parallel-line style: pick small int solutions)
    const x = pickInt(rand, 1, 5), y = pickInt(rand, 1, 5);
    // x + y = sum, x - y = diff
    return makeMC(`Solve:  x + y = ${x + y},  x − y = ${x - y}.  What's x?`, x, rand, { minChoice: 0 });
  },
  (rand) => { // Volume cylinder (use π ≈ 3.14)
    const r = pickInt(rand, 2, 6), h = pickInt(rand, 2, 8);
    const v = Math.round(3.14 * r * r * h);
    return makeMC(`Volume of a cylinder with r=${r}, h=${h} (use π ≈ 3.14, round)?`, v, rand);
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

// Which grades has the player unlocked? Starts with prek+k always
// available; each grade past K requires PROMOTION_THRESHOLD correct
// answers cumulatively in any single lower grade to unlock.
function unlockedGrades(state) {
  const out = new Set(["prek", "k"]);
  // Track best progress in any unlocked grade — once that exceeds the
  // threshold, the next grade in order unlocks.
  let bestSoFar = 0;
  for (const g of GRADES) {
    const c = Number(state.perGradeCorrect?.[g.id] || 0);
    bestSoFar = Math.max(bestSoFar, c);
    if (g.order <= 1) continue; // prek + k always unlocked
    if (bestSoFar >= PROMOTION_THRESHOLD * (g.order - 1)) out.add(g.id);
  }
  return [...out];
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
