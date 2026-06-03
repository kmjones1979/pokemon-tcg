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

const GENERATORS = {
  // Pre-K — count tiny groups of Pokéballs.
  prek(rand) {
    const n = pickInt(rand, 1, 5);
    const balls = "● ".repeat(n).trim();
    return makeMC(`How many Pokéballs?  ${balls}`, n, rand, { minChoice: 1, choicesFrom: [1, 2, 3, 4, 5, 6] });
  },
  // Kindergarten — counting up to 10, "what comes next".
  k(rand) {
    if (rand() < 0.5) {
      const n = pickInt(rand, 1, 9);
      return makeMC(`What number comes after ${n}?`, n + 1, rand, { minChoice: 1, choicesFrom: [n - 1, n, n + 1, n + 2, n + 3].filter((x) => x >= 1) });
    } else {
      const n = pickInt(rand, 1, 10);
      const dots = "● ".repeat(n).trim();
      return makeMC(`Count the Pokéballs:  ${dots}`, n, rand, { minChoice: 1 });
    }
  },
  // 1st — addition / subtraction within 20.
  g1(rand) {
    if (rand() < 0.5) {
      const a = pickInt(rand, 1, 10);
      const b = pickInt(rand, 1, 10);
      const who = pokeName(rand);
      return makeMC(`${who} caught ${a} Pokémon, then caught ${b} more. How many in total?`, a + b, rand, { minChoice: 0 });
    } else {
      const a = pickInt(rand, 5, 20);
      const b = pickInt(rand, 1, a);
      return makeMC(`${a} − ${b} = ?`, a - b, rand, { minChoice: 0 });
    }
  },
  // 2nd — add/sub within 100, skip-counting.
  g2(rand) {
    const r = rand();
    if (r < 0.4) {
      const a = pickInt(rand, 10, 50);
      const b = pickInt(rand, 10, 50);
      return makeMC(`${a} + ${b} = ?`, a + b, rand, { minChoice: 0 });
    } else if (r < 0.8) {
      const a = pickInt(rand, 30, 99);
      const b = pickInt(rand, 1, a - 1);
      return makeMC(`${a} − ${b} = ?`, a - b, rand, { minChoice: 0 });
    } else {
      const start = pickInt(rand, 2, 10);
      const step = [2, 5, 10][pickInt(rand, 0, 2)];
      return makeMC(`Skip counting by ${step}: ${start}, ${start + step}, ${start + 2 * step}, …  What's next?`, start + 3 * step, rand);
    }
  },
  // 3rd — times tables 0-10 and basic division.
  g3(rand) {
    if (rand() < 0.5) {
      const a = pickInt(rand, 2, 10);
      const b = pickInt(rand, 2, 10);
      return makeMC(`${a} × ${b} = ?`, a * b, rand, { minChoice: 0 });
    } else {
      const b = pickInt(rand, 2, 10);
      const q = pickInt(rand, 2, 10);
      const a = b * q;
      return makeMC(`${a} ÷ ${b} = ?`, q, rand, { minChoice: 1 });
    }
  },
  // 4th — 2-digit × 1-digit, simple fractions intro.
  g4(rand) {
    const r = rand();
    if (r < 0.5) {
      const a = pickInt(rand, 11, 30);
      const b = pickInt(rand, 2, 9);
      return makeMC(`${a} × ${b} = ?`, a * b, rand, { minChoice: 0 });
    } else if (r < 0.8) {
      const b = pickInt(rand, 2, 12);
      const q = pickInt(rand, 4, 15);
      const r2 = pickInt(rand, 0, b - 1);
      const a = b * q + r2;
      return makeMC(`${a} ÷ ${b} has remainder?`, r2, rand, { minChoice: 0 });
    } else {
      // Fraction-of-set: "1/2 of 8 = ?"
      const denom = [2, 3, 4, 5][pickInt(rand, 0, 3)];
      const whole = denom * pickInt(rand, 2, 8);
      return makeMC(`1/${denom} of ${whole} = ?`, whole / denom, rand, { minChoice: 0 });
    }
  },
  // 5th — fraction add/sub same denom, decimals.
  g5(rand) {
    const r = rand();
    if (r < 0.4) {
      const denom = [4, 5, 6, 8, 10][pickInt(rand, 0, 4)];
      const a = pickInt(rand, 1, denom - 1);
      const b = pickInt(rand, 1, denom - a);
      return makeMC(`${a}/${denom} + ${b}/${denom} = ?  (give the numerator)`, a + b, rand, { minChoice: 0 });
    } else if (r < 0.75) {
      const a = pickInt(rand, 10, 99) / 10;
      const b = pickInt(rand, 10, 99) / 10;
      return makeMC(`${a.toFixed(1)} + ${b.toFixed(1)} = ?`, (a + b).toFixed(1), rand, { choicesFrom: [a + b - 0.1, a + b + 0.1, a + b - 1, a + b + 1].map((x) => x.toFixed(1)) });
    } else {
      const a = pickInt(rand, 11, 99);
      const b = pickInt(rand, 2, 12);
      return makeMC(`${a} × ${b} = ?`, a * b, rand, { minChoice: 0 });
    }
  },
  // 6th — percentages, ratios, negative numbers.
  g6(rand) {
    const r = rand();
    if (r < 0.4) {
      const pct = [10, 20, 25, 50, 75][pickInt(rand, 0, 4)];
      const whole = pickInt(rand, 4, 20) * 5;
      return makeMC(`${pct}% of ${whole} = ?`, (pct / 100) * whole, rand, { minChoice: 0 });
    } else if (r < 0.7) {
      const a = pickInt(rand, -15, -1);
      const b = pickInt(rand, 1, 15);
      return makeMC(`${a} + ${b} = ?`, a + b, rand);
    } else {
      // Simple ratio: pick a small simplified ratio a:b, scale by k.
      const ratios = [[1, 2], [1, 3], [1, 4], [2, 3], [3, 4], [2, 5]];
      const [a, b] = ratios[pickInt(rand, 0, ratios.length - 1)];
      const k = pickInt(rand, 2, 5);
      const answer = `${a}:${b}`;
      const choices = new Set([answer]);
      while (choices.size < 4) {
        const [da, db] = ratios[pickInt(rand, 0, ratios.length - 1)];
        choices.add(`${da}:${db}`);
      }
      return { prompt: `Simplify the ratio ${a * k} : ${b * k}.`, choices: shuffle([...choices], rand), answer };
    }
  },
  // 7th — pre-algebra, one-step / two-step equations.
  g7(rand) {
    const r = rand();
    if (r < 0.5) {
      const x = pickInt(rand, 2, 12);
      const m = pickInt(rand, 2, 9);
      const b = pickInt(rand, 1, 15);
      return makeMC(`Solve for x:  ${m}x + ${b} = ${m * x + b}`, x, rand, { minChoice: 0 });
    } else if (r < 0.8) {
      const a = pickInt(rand, -10, 10);
      const b = pickInt(rand, -10, 10);
      return makeMC(`${a} × ${b} = ?`, a * b, rand);
    } else {
      const x = pickInt(rand, 2, 12);
      const m = pickInt(rand, 2, 9);
      return makeMC(`Solve for x:  ${m}x = ${m * x}`, x, rand, { minChoice: 1 });
    }
  },
  // 8th — exponents, square roots, simple Pythagorean.
  g8(rand) {
    const r = rand();
    if (r < 0.4) {
      const n = pickInt(rand, 2, 12);
      return makeMC(`What is ${n}²?`, n * n, rand, { minChoice: 1 });
    } else if (r < 0.7) {
      const n = [4, 9, 16, 25, 36, 49, 64, 81, 100, 121, 144][pickInt(rand, 0, 10)];
      return makeMC(`√${n} = ?`, Math.sqrt(n), rand, { minChoice: 1 });
    } else {
      // Pythagorean: a=3 b=4 → c=5; a=5 b=12 → c=13; a=8 b=15 → c=17
      const triples = [[3, 4, 5], [5, 12, 13], [8, 15, 17], [7, 24, 25], [6, 8, 10], [9, 12, 15]];
      const [a, b, c] = triples[pickInt(rand, 0, triples.length - 1)];
      return makeMC(`Right triangle with legs ${a} and ${b}.  What's the hypotenuse?`, c, rand, { minChoice: 1 });
    }
  },
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
  unlockedGrades, mulberry32,
};
