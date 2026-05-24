// Story Mode (v2) — uses the regular 1v1 game engine + arena UI. The hub
// picks a chapter, an intro cutscene plays, then the standard game flow
// runs with the boss loaded as the AI side (chunky HP + custom deck +
// phase rules that trigger at HP thresholds).
//
// Main.js owns the actual gameplay. This module just orchestrates: load,
// narrate, hand off, then handle the post-match story-reward roll.

import { TYPE_COLORS } from "./type-chart.js";
import * as rewards from "./rewards.js";
import { flashVerdict } from "./animations.js";
import {
  tokenizeTextForWordClicks,
  attachWordClickListener,
  wordTtsAvailable,
} from "./word-click-tts.js";

let _stage = null;

export const story = {
  // Caller hooks supplied by main.js: how to start a fight (createGame +
  // arena reveal) and what to do on cancel.
  hooks: null,
};

export function setHooks(hooks) { story.hooks = hooks; }

function ensureStage() {
  if (_stage) return _stage;
  _stage = document.createElement("section");
  _stage.id = "story-stage";
  document.body.appendChild(_stage);
  return _stage;
}

function closeOverlay() {
  document.body.classList.remove("in-story");
  if (_stage) _stage.remove();
  _stage = null;
}

function escape(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
}

// ----- Public entry -------------------------------------------------------

export async function openStoryHub({ currentUser } = {}) {
  ensureStage();
  document.body.classList.add("in-story");
  if (!currentUser) {
    _stage.innerHTML = `
      <div class="story-hub">
        <button class="story-back" data-action="close">✕ Back</button>
        <h1 class="story-title">Story Mode</h1>
        <p class="story-empty">Sign in to play Story Mode and save your progress.</p>
      </div>`;
    _stage.querySelector("[data-action=close]").addEventListener("click", closeOverlay);
    return;
  }
  _stage.innerHTML = `<div class="story-loading">Loading story…</div>`;
  try {
    const r = await fetch("/api/story/chapters");
    const { chapters, progress } = await r.json();
    renderHub(chapters, progress);
  } catch (err) {
    _stage.innerHTML = `<div class="story-error">Couldn't load story: ${escape(err.message)}</div>`;
  }
}

function renderHub(chapters, progress) {
  const cards = chapters.map((c) => {
    const typeColor = TYPE_COLORS[c.bossTypes?.[0]] || "#999";
    return `
      <div class="chapter-card ${c.unlocked ? "" : "locked"} ${c.completed ? "completed" : ""}" data-chapter="${c.id}" style="--type:${typeColor}">
        <div class="chapter-num">Chapter ${c.chapterNumber}${c.isFinale ? " · FINALE" : ""}</div>
        <div class="chapter-name">${escape(c.name)}</div>
        <div class="chapter-locale">${escape(c.locale)}</div>
        <div class="chapter-flavor">${escape(c.flavor)}</div>
        <div class="chapter-boss">
          <span class="boss-label">Boss:</span>
          <span class="boss-name">${escape(c.bossDisplayName)}</span>
          <span class="boss-hp">${c.bossMaxHp} HP</span>
        </div>
        <div class="chapter-actions">
          ${c.completed ? `<span class="chapter-tag">✓ Cleared</span>` : ""}
          ${c.unlocked
            ? `<button class="primary" data-act="fight" data-chapter="${c.id}">${c.completed ? "Replay ▸" : "Begin ▸"}</button>`
            : `<span class="chapter-tag locked-tag">🔒 Complete chapter ${c.chapterNumber - 1} first</span>`}
        </div>
      </div>`;
  }).join("");
  _stage.innerHTML = `
    <div class="story-hub">
      <button class="story-back" data-action="close">✕ Close</button>
      <h1 class="story-title">Story Mode</h1>
      <p class="story-sub">Four chapters. Same card game you know — fight a boss instead of a rival. Win to unlock the next.</p>
      <div class="chapter-grid">${cards}</div>
    </div>`;
  _stage.querySelector("[data-action=close]").addEventListener("click", closeOverlay);
  _stage.querySelectorAll("[data-act=fight]").forEach((b) =>
    b.addEventListener("click", () => startChapter(b.dataset.chapter)));
}

// Speaker → Pokédex ID for portraits. Mirrors the map in reading-mode.js
// — kept separate so each module has zero cross-import for what's a
// tiny static table.
const INTRO_SPEAKER_TO_POKEMON_ID = {
  narrator: null,
  pikachu: 25, squirtle: 7, bulbasaur: 1, charmander: 4,
  caterpie: 10, pidgey: 16, weedle: 13,
  snorlax: 143, jigglypuff: 39, clefairy: 35,
  beedrill: 15, mewtwo: 150, onix: 95,
  lance: null, // human trainer — show a generic glyph instead
};
const POKEMON_SPRITE_URL = (id) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`;

// Read-along chapter intro: section-by-section with Read Aloud TTS.
// Kid-friendly fallback to the legacy line-by-line `intro` array if no
// `readAlong` field is present on the chapter payload.
async function playIntro(chapter) {
  if (Array.isArray(chapter.readAlong) && chapter.readAlong.length > 0) {
    return playReadAlong(chapter);
  }
  return playLegacyIntro(chapter);
}

function playReadAlong(chapter) {
  return new Promise((resolve) => {
    const sections = chapter.readAlong;
    let idx = 0;
    let audioEl = null;
    let detachWords = null;
    const total = sections.length;

    const stopAudio = () => { if (audioEl) { try { audioEl.pause(); } catch {} audioEl = null; } };
    const stopWordTts = () => {
      if (detachWords) { detachWords(); detachWords = null; }
      try { window.speechSynthesis?.cancel(); } catch {}
    };

    const renderSection = () => {
      const sec = sections[idx];
      const speaker = sec.speaker || "narrator";
      const pokeId = INTRO_SPEAKER_TO_POKEMON_ID[speaker];
      const sprite = pokeId ? POKEMON_SPRITE_URL(pokeId) : null;
      const speakerName = speaker === "narrator" ? "Story" : speaker.charAt(0).toUpperCase() + speaker.slice(1);
      const hasAudio = !!sec.audioUrl;
      const audioBtnHtml = hasAudio
        ? `<button class="reading-audio-btn" id="story-intro-audio">▶ Read aloud</button>`
        : `<button class="reading-audio-btn disabled" disabled>🔇 Audio coming soon</button>`;
      const nextLabel = idx === total - 1 ? "Begin battle ▸" : "Next ▶";

      _stage.innerHTML = `
        <div class="reading-mode story-intro-readalong">
          <header class="reading-header reading-header-active">
            <div class="intro-locale">${escape(chapter.locale)}</div>
          </header>
          <div class="reading-progress">
            <div class="reading-progress-bar" style="width: ${Math.round(((idx + 1) / total) * 100)}%"></div>
            <span class="reading-progress-label">Page ${idx + 1} of ${total}</span>
          </div>
          <article class="reading-section">
            <div class="reading-speaker">
              ${sprite ? `<img class="reading-speaker-portrait" src="${escape(sprite)}" alt="">`
                       : `<div class="reading-speaker-glyph">📖</div>`}
              <div class="reading-speaker-name">${escape(speakerName)}</div>
            </div>
            <p class="reading-text">${tokenizeTextForWordClicks(sec.text)}</p>
            <div class="reading-prompt">${wordTtsAvailable()
              ? "Tap any word to hear it. Then press the button to hear the whole page."
              : "Read the words above out loud. Then press the button to hear them."}</div>
            <div class="reading-controls">${audioBtnHtml}</div>
          </article>
          <nav class="reading-nav">
            <button class="reading-prev" ${idx === 0 ? "disabled" : ""}>◀ Previous</button>
            <button class="reading-next">${nextLabel}</button>
          </nav>
        </div>
      `;

      const audioBtn = _stage.querySelector("#story-intro-audio");
      if (audioBtn) {
        audioBtn.addEventListener("click", () => {
          if (!sec.audioUrl) return;
          stopAudio();
          audioEl = new Audio(sec.audioUrl);
          audioEl.volume = 0.85;
          audioEl.play().catch(() => {});
        });
      }
      _stage.querySelector(".reading-prev").addEventListener("click", () => {
        if (idx === 0) return;
        stopAudio();
        stopWordTts();
        idx -= 1;
        renderSection();
      });
      _stage.querySelector(".reading-next").addEventListener("click", () => {
        stopAudio();
        stopWordTts();
        if (idx >= total - 1) { resolve(); return; }
        idx += 1;
        renderSection();
      });
      // Per-word tap-to-hear listener (refreshed every section).
      stopWordTts();
      const textEl = _stage.querySelector(".reading-text");
      if (textEl) detachWords = attachWordClickListener(textEl);
    };

    renderSection();
  });
}

// Legacy auto-timed intro — fallback for chapters without readAlong.
// Kept so newer chapter writers can ship dramatic-tone variants if
// needed without breaking the contract.
function playLegacyIntro(chapter) {
  return new Promise((resolve) => {
    const lines = chapter.intro || [];
    _stage.innerHTML = `
      <div class="story-intro">
        <div class="intro-locale">${escape(chapter.locale)}</div>
        <div class="intro-lines"></div>
        <button class="primary intro-skip">Skip ▸</button>
      </div>`;
    const out = _stage.querySelector(".intro-lines");
    const skip = _stage.querySelector(".intro-skip");
    let cancelled = false;
    let i = 0;
    const advance = () => {
      if (cancelled) return;
      if (i >= lines.length) {
        skip.textContent = "Begin battle ▸";
        skip.classList.add("ready");
        return;
      }
      const el = document.createElement("div");
      el.className = "intro-line";
      el.textContent = lines[i];
      out.appendChild(el);
      i++;
      setTimeout(advance, 1100);
    };
    advance();
    skip.addEventListener("click", () => { cancelled = true; resolve(); });
  });
}

async function startChapter(chapterId) {
  if (!story.hooks?.startBossFight) {
    flashVerdict("Story hooks not initialised", "weak");
    return;
  }
  _stage.innerHTML = `<div class="story-loading">Loading chapter…</div>`;
  let payload;
  try {
    const r = await fetch(`/api/story/chapter/${chapterId}/deck`);
    payload = await r.json();
    if (!r.ok) throw new Error(payload.error || "Couldn't load chapter.");
  } catch (err) {
    _stage.innerHTML = `<div class="story-error">${escape(err.message)}</div>`;
    return;
  }
  // Intro cutscene before handing off.
  await playIntro(payload.chapter);
  // Keep the story overlay visible with a "Entering battle…" message so the
  // user never sees a flash of the home menu in between intro and arena.
  _stage.innerHTML = `<div class="story-loading">Entering battle…</div>`;
  let sessionId = null;
  try {
    const r = await fetch("/me/story/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chapterId }),
    });
    if (r.ok) sessionId = (await r.json()).sessionId || null;
  } catch {}
  // Set up the arena FIRST, then tear down the story overlay.
  try {
    await story.hooks.startBossFight({
      chapterId,
      sessionId,
      chapter: payload.chapter,
      boss: payload.boss,
      deck: payload.deck,
      phaseRules: payload.phaseRules,
      summonCards: payload.summonCards,
    });
    closeOverlay();
  } catch (err) {
    _stage.innerHTML = `
      <div class="story-error">
        <p>Couldn't start battle: ${escape(err.message || "unknown")}</p>
        <button class="primary" data-action="hub">Back</button>
      </div>`;
    _stage.querySelector("[data-action=hub]")?.addEventListener("click", () => openStoryHub({ currentUser: { id: "anon" } }));
  }
}

// Called from main.js on game-over of a story fight.
export async function finishChapter({ sessionId, won, chapterId, kos = 0 }) {
  if (!sessionId) return null;
  try {
    const r = await fetch("/me/story/end", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, won, chapterId, kos }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.reward || null;
  } catch {
    return null;
  }
}
