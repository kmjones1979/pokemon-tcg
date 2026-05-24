// Reading Mode — kid-friendly read-along UI for the Pokémon stories
// in shared/reading-stories.js. Distinct from the battle-based Story
// Mode (server-modules/story.js). Shows one section at a time with a
// big readable font and Next/Back controls. The "Read aloud" button
// is rendered when a section has an audioUrl (slice 5b wires that up).
//
// Entry points:
//   openReadingMode(rootEl)          — mounts the picker UI in rootEl
//   destroyReadingMode()             — tears down (call on route change)
//
// Pure DOM module — no global state mutation outside its mounted root.

import {
  tokenizeTextForWordClicks,
  attachWordClickListener,
  wordTtsAvailable,
} from "./word-click-tts.js";

let _rootEl = null;
let _state = {
  view: "picker",     // "picker" | "story"
  storyId: null,
  story: null,
  sectionIdx: 0,
};
let _audioEl = null;
let _detachWordClicks = null;

const SPRITE_URL = (id) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`;

// Speaker → Pokédex ID. Used to fetch a portrait sprite next to each
// section so kids can pair "who's talking" with the dialog.
const SPEAKER_TO_POKEMON_ID = {
  narrator:    null,
  pikachu:     25,
  squirtle:     7,
  bulbasaur:    1,
  charmander:   4,
  caterpie:    10,
  pidgey:      16,
  weedle:      13,
  snorlax:    143,
  jigglypuff: 39,
  clefairy:   35,
};

export async function openReadingMode(rootEl) {
  _rootEl = rootEl;
  await render();
}

export function destroyReadingMode() {
  if (_audioEl) { _audioEl.pause(); _audioEl = null; }
  if (_detachWordClicks) { _detachWordClicks(); _detachWordClicks = null; }
  try { window.speechSynthesis?.cancel(); } catch {}
  if (_rootEl) _rootEl.innerHTML = "";
  _rootEl = null;
  _state = { view: "picker", storyId: null, story: null, sectionIdx: 0 };
}

async function render() {
  if (!_rootEl) return;
  if (_state.view === "picker") {
    return renderPicker();
  } else if (_state.view === "story") {
    return renderStory();
  }
}

async function renderPicker() {
  _rootEl.innerHTML = `
    <div class="reading-mode">
      <header class="reading-header">
        <h1>Story Time</h1>
        <p class="reading-tagline">Pick a story. Read it. Then press the button to hear it!</p>
      </header>
      <div class="reading-list" aria-busy="true">Loading stories…</div>
    </div>
  `;
  const list = _rootEl.querySelector(".reading-list");
  try {
    const res = await fetch("/api/reading/stories");
    if (!res.ok) throw new Error("could not load stories");
    const data = await res.json();
    list.removeAttribute("aria-busy");
    if (!data.stories?.length) {
      list.innerHTML = `<p class="reading-empty">No stories yet — check back soon!</p>`;
      return;
    }
    list.innerHTML = data.stories.map(storyCardHtml).join("");
    list.querySelectorAll("[data-story-id]").forEach((card) => {
      card.addEventListener("click", () => openStory(card.dataset.storyId));
    });
  } catch (err) {
    list.removeAttribute("aria-busy");
    list.innerHTML = `<p class="reading-error">Couldn't load stories: ${escapeHtml(err.message)}</p>`;
  }
}

function storyCardHtml(s) {
  const sprite = s.cover?.pokemonId ? SPRITE_URL(s.cover.pokemonId) : null;
  const glyph = s.cover?.glyph || "📖";
  const themeType = s.cover?.themeType || "normal";
  return `
    <button class="reading-card type-${escapeHtml(themeType)}" data-story-id="${escapeHtml(s.id)}">
      <div class="reading-card-art">
        ${sprite
          ? `<img src="${escapeHtml(sprite)}" alt="" loading="lazy">`
          : `<div class="reading-card-glyph">${glyph}</div>`}
      </div>
      <div class="reading-card-meta">
        <h3>${escapeHtml(s.title)}</h3>
        <p>${escapeHtml(s.summary || "")}</p>
        <div class="reading-card-stats">
          <span>📖 ${s.sectionCount} pages</span>
          <span>⏱ ${s.estimatedMinutes} min</span>
          <span>📚 Level ${escapeHtml(s.readingLevel || "K-1")}</span>
        </div>
      </div>
    </button>
  `;
}

async function openStory(storyId) {
  _rootEl.innerHTML = `<div class="reading-mode"><div class="reading-loading">Loading…</div></div>`;
  try {
    const res = await fetch(`/api/reading/stories/${encodeURIComponent(storyId)}`);
    if (!res.ok) throw new Error("story not found");
    const data = await res.json();
    _state.view = "story";
    _state.story = data.story;
    _state.storyId = data.story.id;
    _state.sectionIdx = 0;
    await render();
  } catch (err) {
    _rootEl.innerHTML = `<div class="reading-mode"><p class="reading-error">${escapeHtml(err.message)}</p></div>`;
  }
}

function renderStory() {
  const story = _state.story;
  if (!story) return;
  const total = story.sections.length;
  const i = Math.max(0, Math.min(_state.sectionIdx, total - 1));
  const sec = story.sections[i];
  const speaker = sec.speaker || "narrator";
  const speakerId = SPEAKER_TO_POKEMON_ID[speaker];
  const speakerSprite = speakerId ? SPRITE_URL(speakerId) : null;
  const speakerName = speaker === "narrator"
    ? "Story"
    : speaker.charAt(0).toUpperCase() + speaker.slice(1);

  const hasAudio = !!sec.audioUrl;
  const audioBtn = hasAudio
    ? `<button class="reading-audio-btn" data-audio="${escapeHtml(sec.audioUrl)}">▶ Read aloud</button>`
    : `<button class="reading-audio-btn disabled" disabled title="Audio coming soon">🔇 Audio coming soon</button>`;

  _rootEl.innerHTML = `
    <div class="reading-mode">
      <header class="reading-header reading-header-active">
        <button class="reading-back">← Back to stories</button>
        <h1>${escapeHtml(story.title)}</h1>
      </header>
      <div class="reading-progress">
        <div class="reading-progress-bar" style="width: ${Math.round(((i + 1) / total) * 100)}%"></div>
        <span class="reading-progress-label">Page ${i + 1} of ${total}</span>
      </div>
      <article class="reading-section type-${escapeHtml(_state.story.cover?.themeType || "normal")}">
        <div class="reading-speaker">
          ${speakerSprite
            ? `<img class="reading-speaker-portrait" src="${escapeHtml(speakerSprite)}" alt="">`
            : `<div class="reading-speaker-glyph">📖</div>`}
          <div class="reading-speaker-name">${escapeHtml(speakerName)}</div>
        </div>
        <p class="reading-text">${tokenizeTextForWordClicks(sec.text)}</p>
        <div class="reading-prompt">${wordTtsAvailable()
          ? "Tap any word to hear it. Read the page, then press the button to hear the whole story."
          : "Read the words above out loud. When you're ready, press the button."}</div>
        <div class="reading-controls">
          ${audioBtn}
        </div>
      </article>
      <nav class="reading-nav">
        <button class="reading-prev" ${i === 0 ? "disabled" : ""}>◀ Previous</button>
        <button class="reading-next" ${i === total - 1 ? "disabled" : ""}>${i === total - 1 ? "Finish ✓" : "Next ▶"}</button>
      </nav>
    </div>
  `;

  _rootEl.querySelector(".reading-back").addEventListener("click", () => {
    if (_audioEl) { _audioEl.pause(); _audioEl = null; }
    _state.view = "picker";
    _state.storyId = null;
    _state.story = null;
    _state.sectionIdx = 0;
    render();
  });
  _rootEl.querySelector(".reading-prev").addEventListener("click", () => {
    if (_audioEl) { _audioEl.pause(); _audioEl = null; }
    _state.sectionIdx = Math.max(0, _state.sectionIdx - 1);
    render();
  });
  _rootEl.querySelector(".reading-next").addEventListener("click", () => {
    if (_audioEl) { _audioEl.pause(); _audioEl = null; }
    if (_state.sectionIdx >= total - 1) {
      // Finish — return to picker.
      _state.view = "picker";
      _state.storyId = null;
      _state.story = null;
      _state.sectionIdx = 0;
      render();
      return;
    }
    _state.sectionIdx += 1;
    render();
  });
  const audioBtnEl = _rootEl.querySelector(".reading-audio-btn:not([disabled])");
  if (audioBtnEl) {
    audioBtnEl.addEventListener("click", () => {
      const url = audioBtnEl.dataset.audio;
      if (!url) return;
      if (_audioEl) { _audioEl.pause(); _audioEl = null; }
      _audioEl = new Audio(url);
      _audioEl.play().catch((err) => {
        console.warn("[reading] audio play failed:", err);
      });
    });
  }
  // Tap-to-hear: each rendered section gets a fresh delegated listener
  // (cheap; we re-render the section on every nav). Detaches the old
  // one first so we don't accumulate listeners across pages.
  if (_detachWordClicks) { _detachWordClicks(); _detachWordClicks = null; }
  const sectionEl = _rootEl.querySelector(".reading-text");
  if (sectionEl) {
    _detachWordClicks = attachWordClickListener(sectionEl);
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
