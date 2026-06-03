// Math Mode — Duolingo-style math journey with Pokémon-themed quizzes.
// Players pick a grade (Pre-K → 8th), answer 10 multiple-choice questions,
// build a correct-answer streak, and earn Pokémon cards as they go.
// The whole UI lives in one `<div id="math-root">`; openMathMode swaps
// between three screens: hub, quiz, results.

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

// Pokémon mascot lines — small bit of personality, rotated through.
const ENCOURAGE = [
  "Mr. Mime says: \"Nice form!\"",
  "Alakazam approves of that reasoning.",
  "Psyduck got a headache trying — you got it!",
  "Slowpoke says: \"Hey... that was fast.\"",
  "Pikachu charges up. ⚡⚡",
  "Eevee wags its tail.",
  "Mew is impressed.",
];
const COMMISERATE = [
  "Magikarp flops. Try again!",
  "Almost! Snorlax barely stirred.",
  "Psyduck is confused too. Take another shot.",
  "Wobbuffet says: \"Wobbuf...\" Don't give up.",
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ---- API wrappers ---------------------------------------------------------

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
      <p class="math-subtitle">Earn cards by solving quizzes. Stack streaks. Climb grades.</p>

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
          Next card: <strong>${state.progressToCard} / ${state.cardThreshold}</strong> correct
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

function renderQuiz(quiz) {
  const el = root();
  if (!el) return;
  const state = {
    quiz,
    idx: 0,
    answers: new Array(quiz.questions.length).fill(null),
    streak: 0,
    locked: false, // disable choices once one is picked
  };

  function draw() {
    const q = quiz.questions[state.idx];
    const total = quiz.questions.length;
    const pct = Math.round((state.idx / total) * 100);
    el.innerHTML = `
      <div class="math-quiz">
        <div class="math-quiz-top">
          <button class="math-quit" id="math-quit-btn">← Back</button>
          <div class="math-progress-track">
            <div class="math-progress-fill" style="width: ${pct}%"></div>
          </div>
          <div class="math-streak">⚡ ${state.streak}</div>
        </div>
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
        </div>
      </div>
    `;
    el.querySelector("#math-quit-btn").addEventListener("click", () => {
      if (confirm("Leave the quiz? Your progress on this quiz won't count.")) renderHub();
    });
    el.querySelectorAll(".math-choice").forEach((btn) => {
      btn.addEventListener("click", () => onChoose(btn));
    });
  }

  function onChoose(btn) {
    if (state.locked) return;
    state.locked = true;
    const val = btn.dataset.val;
    state.answers[state.idx] = val;
    // We don't know correctness client-side — only the server does — so
    // we show optimistic "answered" styling and reveal correctness after
    // we submit and get the per-question correctness array back.
    btn.classList.add("chosen");
    el.querySelectorAll(".math-choice").forEach((b) => b.classList.add("answered"));
    setTimeout(() => {
      state.idx += 1;
      state.locked = false;
      if (state.idx >= quiz.questions.length) submitAndShow();
      else draw();
    }, 250);
  }

  async function submitAndShow() {
    el.innerHTML = `<div class="math-loading">Grading your quiz…</div>`;
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

// ---- Result screen --------------------------------------------------------

function renderResult(quiz, playerAnswers, result) {
  const el = root();
  if (!el) return;
  const pct = Math.round((result.correct / result.total) * 100);
  const verdict = pct === 100 ? "🏆 PERFECT QUIZ!"
                 : pct >= 80   ? "⭐ Great Work!"
                 : pct >= 50   ? "👍 Not Bad!"
                               : "💪 Keep Practising!";
  const mascot = pct >= 70 ? pick(ENCOURAGE) : pick(COMMISERATE);
  const cardPct = Math.min(100, Math.round((result.progressToCard / result.cardThreshold) * 100));

  el.innerHTML = `
    <div class="math-result">
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
          return `
            <div class="math-review-row ${ok ? "ok" : "bad"}">
              <div class="math-review-icon">${ok ? "✓" : "✗"}</div>
              <div class="math-review-body">
                <div class="math-review-prompt">${escape(q.prompt)}</div>
                <div class="math-review-meta">
                  Your answer: <strong>${escape(String(yours ?? "—"))}</strong>
                  ${ok ? "" : `&nbsp;·&nbsp; Correct: <strong>${escape(String(correct))}</strong>`}
                </div>
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

// Public entrypoint — main.js calls this after creating the overlay shell.
export async function openMathMode(targetEl) {
  if (targetEl) targetEl.id = "math-root";
  await renderHub();
}
