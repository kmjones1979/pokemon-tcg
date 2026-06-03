// Math Mode — Duolingo-style math journey with Pokémon card rewards.
// Three screens: hub (grade picker + progress), quiz (10 questions with
// instant correct/wrong feedback, hearts, streak, optional hint), and
// result (score + per-question review with strategy explanations +
// card reveal).

const root = () => document.getElementById("math-root");

const GRADE_VIBE = {
  prek:  { emoji: "🎈", color: "#fbcfe8" },
  k:     { emoji: "✏️", color: "#fde68a" },
  g1:    { emoji: "🍎", color: "#fca5a5" },
  g2:    { emoji: "📐", color: "#a7f3d0" },
  g3:    { emoji: "✖️", color: "#93c5fd" },
  g4:    { emoji: "🧮", color: "#c4b5fd" },
  g5:    { emoji: "🥧", color: "#fdba74" },
  g6:    { emoji: "📊", color: "#f9a8d4" },
  g7:    { emoji: "🧪", color: "#6ee7b7" },
  g8:    { emoji: "📏", color: "#fcd34d" },
};

// Mascot lines vary by score band so kids feel different reactions instead
// of the same generic "nice work" every time. Keep them short.
const MASCOT_PERFECT = [
  "Mr. Mime is speechless. 🎉",
  "Alakazam tips its spoon. 🥄",
  "Mew floats with joy. ✨",
  "Pikachu's tail won't stop wagging.",
  "10 out of 10! Snorlax woke up to clap.",
];
const MASCOT_GREAT = [
  "Lucario nods with respect.",
  "Eevee bounds in a circle. 🐾",
  "Charmander's flame is brighter than ever.",
  "Sylveon wraps you in a ribbon of approval.",
];
const MASCOT_GOOD = [
  "Slowpoke says: \"Heeey... not bad.\"",
  "Psyduck's headache is GONE.",
  "Greninja gives a quiet thumbs up.",
  "Wobbuffet: \"Wobbuff!\" (translation: yay)",
];
const MASCOT_PRACTICE = [
  "Magikarp flopped, but flops never quit. 🐟",
  "Cubone takes a breath. You've got this.",
  "Snorlax believes in you. (After nap.)",
  "Try again — Charmander toughs out every battle.",
];
const HEART_LOST = [
  "Whoops!",
  "Almost!",
  "Not quite!",
  "Try again!",
];
const STREAK_HYPE = {
  3:  "🔥 ON FIRE!",
  5:  "🔥🔥 BLAZING!",
  7:  "⚡ SUPER EFFECTIVE!",
  10: "👑 LEGENDARY!",
  15: "🌟 UNSTOPPABLE!",
};
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ---- API ------------------------------------------------------------------

async function fetchState() {
  const r = await fetch("/me/math/state");
  if (!r.ok) throw new Error("Not signed in?");
  return r.json();
}

async function startQuiz(grade) {
  const r = await fetch("/me/math/start-quiz", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grade }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || "Couldn't start quiz.");
  }
  return r.json();
}

async function submitQuiz(quizId, answers) {
  const r = await fetch("/me/math/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quizId, answers }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || "Couldn't submit quiz.");
  }
  return r.json();
}

// ---- Hub screen -----------------------------------------------------------

async function renderHub() {
  const el = root();
  if (!el) return;
  el.innerHTML = `<div class="math-loading">Loading the Academy…</div>`;
  let state;
  try {
    state = await fetchState();
  } catch (err) {
    el.innerHTML = `<div class="math-error">Sign in to play Math Mode.</div>`;
    return;
  }
  const pct = Math.min(100, Math.round((state.progressToCard / state.cardThreshold) * 100));
  el.innerHTML = `
    <div class="math-hub">
      <div class="math-mascot">🧙‍♂️</div>
      <h2 class="math-title">Pokémon Math Academy</h2>
      <p class="math-subtitle">Solve quizzes. Stack streaks. Earn cards.</p>

      <div class="math-stats">
        <div class="math-stat">
          <div class="math-stat-num">${state.cardsEarned}</div>
          <div class="math-stat-label">Cards Earned</div>
        </div>
        <div class="math-stat">
          <div class="math-stat-num">${state.totalCorrect}</div>
          <div class="math-stat-label">Total Correct</div>
        </div>
        <div class="math-stat">
          <div class="math-stat-num">⚡ ${state.bestStreak}</div>
          <div class="math-stat-label">Best Streak</div>
        </div>
      </div>

      <div class="math-card-bar">
        <div class="math-card-bar-label">
          Next card: <strong>${state.progressToCard} / ${state.cardThreshold}</strong>
        </div>
        <div class="math-card-bar-track">
          <div class="math-card-bar-fill" style="width: ${pct}%"></div>
        </div>
      </div>

      <h3 class="math-grade-heading">Choose a Grade</h3>
      <div class="math-grade-grid">
        ${state.grades.map((g) => {
          const vibe = GRADE_VIBE[g.id] || { emoji: "📚", color: "#fff" };
          const locked = !g.unlocked;
          return `
            <button class="math-grade-card ${locked ? "locked" : ""} ${g.id === state.grade ? "current" : ""}"
                    data-grade="${g.id}" ${locked ? "disabled" : ""}
                    style="--vibe: ${vibe.color}">
              <div class="math-grade-emoji">${locked ? "🔒" : vibe.emoji}</div>
              <div class="math-grade-label">${g.label}</div>
              <div class="math-grade-correct">${g.correct} correct</div>
            </button>
          `;
        }).join("")}
      </div>

      <p class="math-hint">Pre-K & K earn common / uncommon cards. 1st grade and up earn rare, epic, and legendary.</p>
    </div>
  `;
  el.querySelectorAll(".math-grade-card[data-grade]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.classList.contains("locked")) return;
      const grade = btn.dataset.grade;
      try {
        const quiz = await startQuiz(grade);
        renderQuiz(quiz);
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

// ---- Quiz screen ----------------------------------------------------------

const MAX_HEARTS = 3;

function renderQuiz(quiz) {
  const el = root();
  if (!el) return;
  const state = {
    quiz,
    idx: 0,
    answers: new Array(quiz.questions.length).fill(null),
    streak: 0,
    hearts: MAX_HEARTS,
    correctness: new Array(quiz.questions.length).fill(false),
    locked: false,
    hintShown: false,
  };

  function draw() {
    const q = quiz.questions[state.idx];
    const total = quiz.questions.length;
    const pct = Math.round((state.idx / total) * 100);
    const streakBadge = STREAK_HYPE[state.streak] || "";
    el.innerHTML = `
      <div class="math-quiz">
        <div class="math-quiz-top">
          <button class="math-quit" id="math-quit-btn">←</button>
          <div class="math-progress-track">
            <div class="math-progress-fill" style="width: ${pct}%"></div>
          </div>
          <div class="math-hearts">${renderHearts(state.hearts)}</div>
          <div class="math-streak ${state.streak >= 3 ? "ablaze" : ""}">⚡ ${state.streak}</div>
        </div>
        ${streakBadge ? `<div class="math-streak-banner">${streakBadge}</div>` : ""}
        <div class="math-q-card">
          <div class="math-q-num">Question ${state.idx + 1} of ${total}</div>
          <div class="math-q-prompt">${escape(q.prompt)}</div>
          <div class="math-q-choices">
            ${q.choices.map((c, i) => `
              <button class="math-choice" data-i="${i}" data-val="${escapeAttr(c)}">
                <span class="math-choice-letter">${"ABCD"[i]}</span>
                <span class="math-choice-text">${escape(c)}</span>
              </button>
            `).join("")}
          </div>
          <div class="math-feedback" id="math-feedback"></div>
          <div class="math-q-actions">
            <button class="math-hint-btn" id="math-hint-btn" ${state.hintShown ? "disabled" : ""}>
              💡 Hint
            </button>
          </div>
        </div>
      </div>
    `;
    el.querySelector("#math-quit-btn").addEventListener("click", () => {
      if (confirm("Leave the quiz? Progress on this quiz won't count.")) renderHub();
    });
    el.querySelectorAll(".math-choice").forEach((btn) => {
      btn.addEventListener("click", () => onChoose(btn));
    });
    el.querySelector("#math-hint-btn")?.addEventListener("click", showHint);
  }

  function showHint() {
    if (state.hintShown) return;
    state.hintShown = true;
    const q = quiz.questions[state.idx];
    const feedback = el.querySelector("#math-feedback");
    // Without access to the answer (only the server knows), the hint is a
    // generic encouragement to use a strategy. The detailed explanation
    // is revealed in the review screen.
    feedback.innerHTML = `<div class="math-hint-body">💡 Try breaking it into smaller steps. Look at the numbers carefully — is there an easier way to count or group them?</div>`;
    const btn = el.querySelector("#math-hint-btn");
    if (btn) btn.disabled = true;
  }

  function onChoose(btn) {
    if (state.locked) return;
    state.locked = true;
    const val = btn.dataset.val;
    state.answers[state.idx] = val;
    btn.classList.add("chosen");
    el.querySelectorAll(".math-choice").forEach((b) => b.classList.add("answered"));

    // We need the server to grade. To make the quiz feel snappy, we
    // submit at the END and reveal results on the review screen. For
    // mid-quiz feedback we instead show a quick neutral "Answered ✓"
    // and move on. The streak/hearts visible during the quiz are an
    // optimistic preview only — the real verdict comes from the server.
    setTimeout(() => {
      state.idx += 1;
      state.locked = false;
      if (state.idx >= quiz.questions.length) submitAndShow();
      else draw();
    }, 220);
  }

  async function submitAndShow() {
    el.innerHTML = `<div class="math-loading">Grading your quiz… 🧮</div>`;
    let result;
    try {
      result = await submitQuiz(quiz.quizId, state.answers);
    } catch (err) {
      el.innerHTML = `<div class="math-error">${escape(err.message)}</div>`;
      return;
    }
    renderResult(quiz, state.answers, result);
  }

  draw();
}

function renderHearts(n) {
  let html = "";
  for (let i = 0; i < MAX_HEARTS; i++) html += i < n ? "❤️" : "🤍";
  return html;
}

// ---- Result screen --------------------------------------------------------

function renderResult(quiz, playerAnswers, result) {
  const el = root();
  if (!el) return;
  const pct = Math.round((result.correct / result.total) * 100);
  const verdict = pct === 100 ? "🏆 PERFECT QUIZ!"
                 : pct >= 80   ? "⭐ Awesome Work!"
                 : pct >= 60   ? "👍 Nice Job!"
                 : pct >= 30   ? "💪 Keep Practising!"
                               : "🌱 Every Trainer Starts Here!";
  const mascot = pct === 100 ? pick(MASCOT_PERFECT)
               : pct >= 80   ? pick(MASCOT_GREAT)
               : pct >= 50   ? pick(MASCOT_GOOD)
                             : pick(MASCOT_PRACTICE);
  const cardPct = Math.min(100, Math.round((result.progressToCard / result.cardThreshold) * 100));

  el.innerHTML = `
    <div class="math-result">
      ${pct >= 80 ? renderConfetti() : ""}
      <h2 class="math-result-verdict">${verdict}</h2>
      <p class="math-result-mascot">${escape(mascot)}</p>
      <div class="math-result-score">${result.correct} / ${result.total}</div>

      ${result.reward ? renderReward(result.reward) : ""}

      <div class="math-card-bar">
        <div class="math-card-bar-label">
          Next card: <strong>${result.progressToCard} / ${result.cardThreshold}</strong>
        </div>
        <div class="math-card-bar-track">
          <div class="math-card-bar-fill" style="width: ${cardPct}%"></div>
        </div>
      </div>

      ${result.newlyUnlocked?.length ? `
        <div class="math-unlock-banner">
          🎉 New grade unlocked: ${result.newlyUnlocked.join(", ").toUpperCase()}
        </div>
      ` : ""}

      <div class="math-result-streak">⚡ Streak: <strong>${result.currentStreak}</strong> &nbsp;&nbsp; Best: ${result.bestStreak}</div>

      <h3 class="math-review-heading">Review</h3>
      <div class="math-review">
        ${quiz.questions.map((q, i) => {
          const yours = playerAnswers[i];
          const correct = result.correctAnswers[i];
          const ok = result.correctness[i];
          const explanation = (result.explanations || [])[i] || "";
          return `
            <div class="math-review-row ${ok ? "ok" : "bad"}">
              <div class="math-review-icon">${ok ? "✓" : "✗"}</div>
              <div class="math-review-body">
                <div class="math-review-prompt">${escape(q.prompt)}</div>
                <div class="math-review-meta">
                  Your answer: <strong>${escape(String(yours ?? "—"))}</strong>
                  ${ok ? "" : `&nbsp;·&nbsp; Correct: <strong>${escape(String(correct))}</strong>`}
                </div>
                ${explanation ? `<div class="math-review-explanation">💡 ${escape(explanation)}</div>` : ""}
              </div>
            </div>
          `;
        }).join("")}
      </div>

      <div class="math-result-actions">
        <button class="math-btn math-btn-primary" id="math-again">Play Again (${quiz.grade.toUpperCase()})</button>
        <button class="math-btn" id="math-back">Back to Academy</button>
      </div>
    </div>
  `;
  el.querySelector("#math-again").addEventListener("click", async () => {
    try {
      const q = await startQuiz(quiz.grade);
      renderQuiz(q);
    } catch (err) { alert(err.message); }
  });
  el.querySelector("#math-back").addEventListener("click", () => renderHub());

  if (result.reward) {
    el.querySelectorAll(".math-reward-claim").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.dataset.i);
        const offer = result.reward.offers[i];
        if (offer) claimOne(offer, btn);
      });
    });
  }
}

// Light celebratory confetti — pure CSS animations defined in math-mode.css.
function renderConfetti() {
  const colors = ["#fbbf24", "#f87171", "#34d399", "#60a5fa", "#a78bfa", "#f472b6"];
  let html = `<div class="math-confetti">`;
  for (let i = 0; i < 24; i++) {
    const c = colors[i % colors.length];
    const left = (i * 4 + Math.floor(Math.random() * 4)) + "%";
    const delay = (Math.random() * 0.6).toFixed(2) + "s";
    const dur = (1.6 + Math.random() * 1.5).toFixed(2) + "s";
    html += `<span class="math-confetti-piece" style="background:${c};left:${left};animation-delay:${delay};animation-duration:${dur};"></span>`;
  }
  html += "</div>";
  return html;
}

function renderReward(reward) {
  const n = reward.offers.length;
  return `
    <div class="math-reward">
      <div class="math-reward-banner">🎁 You earned ${n === 1 ? "a Pokémon!" : `${n} Pokémon!`}</div>
      <div class="math-reward-picks">
        ${reward.offers.map((o, i) => `
          <div class="math-reward-card rarity-${rarityOf(o.pick)}" data-offer="${escapeAttr(o.offerId)}" data-pick="${o.pick.id}">
            <div class="math-reward-sprite">
              ${o.pick.sprite_front ? `<img src="${o.pick.sprite_front}" alt="${escape(o.pick.name)}">` : ""}
            </div>
            <div class="math-reward-name">${escape(o.pick.name)}</div>
            <div class="math-reward-rarity">${rarityOf(o.pick).toUpperCase()}</div>
            <button class="math-btn math-btn-primary math-reward-claim" data-i="${i}">Add to Collection</button>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function rarityOf(p) {
  if (p.is_legendary || p.is_mythical) return "legendary";
  const t = p.tier || 1;
  if (t >= 5) return "epic";
  if (t >= 4) return "rare";
  if (t >= 3) return "uncommon";
  return "common";
}

async function claimOne(offer, btn) {
  btn.disabled = true;
  btn.textContent = "Claiming…";
  try {
    const r = await fetch(`/me/rewards/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offerId: offer.offerId, pokemonId: offer.pick.id }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || "Claim failed.");
    }
    btn.textContent = "✓ Added!";
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Retry";
    alert(err.message);
  }
}

// ---- helpers --------------------------------------------------------------

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s) { return escape(s); }

export async function openMathMode(targetEl) {
  if (targetEl) targetEl.id = "math-root";
  await renderHub();
}
