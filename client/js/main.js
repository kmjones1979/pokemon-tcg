// Top-level UI orchestrator. Owns DOM rendering, click handlers, and the
// "select → target" interaction model. Defers all game rules to game.js.

import {
  createGame,
  fetchDeck,
  playCard,
  attack,
  endTurn,
  aiTakeTurn,
  effectiveCost,
  mulliganHand,
  TRAINERS,
  FIELD_SIZE,
  TRAINER_START_HP,
  trainerMascotUrl,
} from "./game.js";
import { renderCard } from "./cards.js";
import { fireAttackTrail, floatDamage, knockOut, flashVerdict, shakeHit } from "./animations.js";
import {
  playCry, setMuted, isMuted,
  sfxAttack, sfxHit, sfxKO, sfxVictory, sfxDefeat, sfxCardPlay, sfxCrit, sfxYourTurn,
} from "./audio.js";
import {
  playEmote, attackResultToEvents, spellResultToEvent,
} from "./battle-emotes.js";
import {
  startBGM, stopBGM,
} from "./audio.js";
import { TYPE_COLORS } from "./type-chart.js";
import { computeDamage } from "./battle.js";
import { abilitiesFor, abilityById, basicAbility } from "./abilities.js";
import { attachPreviewHandlers } from "./card-preview.js";
import { ITEM_DEFS, useItem } from "./items.js";
import { rollModifier, applyModifier } from "./match-modifiers.js";
import * as passkey from "./passkey.js";
import * as deckBuilder from "./deck-builder.js";
import * as mp from "./multiplayer.js";
import * as rewards from "./rewards.js";
import * as leaderboard from "./leaderboard.js";
import * as achievements from "./achievements.js";
import * as pokedex from "./pokedex.js";
import * as story from "./story.js";
import * as trading from "./trading.js";
import * as daily from "./daily.js";
import * as puzzle from "./puzzle.js";
import { trackEvent } from "./analytics.js";
import { init as initI18n } from "./i18n.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let state = null; // current game state
let selectedAttacker = null; // { slot: number } when player has clicked one of their field cards
let aiDifficulty = localStorage.getItem("pokemon-tcg-difficulty") || "easy";
let currentUser = null;     // populated after passkey login/register or /auth/me probe
let gameMode = "solo";      // "solo" | "mp"
let mpOpponent = null;      // { displayName, ability } in multiplayer
let chosenTrainer = null;   // remember during multiplayer matchmaking
let soloSessionId = null;   // server-tracked anti-cheat session for solo matches
let chosenAbilityId = "basic"; // ability the player will use on their next attack
let pendingItem = null;        // when set, next slot click targets this item
let pendingReplace = null;     // { handIndex } — next own-field click sacrifices that slot to summon this card
let pendingSpell = null;       // { handIndex, target } — next field click resolves this spell ("enemyField" | "ownField")
let currentTheme = null;       // { type, endsAt } — theme of the week
let aiPersonality = null;      // chosen at match start so it stays consistent
let _prevHps = { player: null, ai: null }; // tracks trainer HPs between renders for the flash
let _prevEnergy = null; // tracks your energy across renders so we can pip-refill the new ones
let _prevActivePlayer = null; // tracks active player so we can fire a turn-start cue
// Whether the player has explicitly lifted their hand to full view. Persists
// across renders + game sessions so mobile users don't have to re-toggle
// every turn.
let _handLifted = false;
try { _handLifted = localStorage.getItem("pokemon-tcg-hand-lifted") === "1"; } catch {}
// Touch devices get a "tap-to-peek, tap-again-to-play" affordance so users
// can read a card's abilities before committing. Desktop one-click play
// stays unchanged.
const _isTouch = typeof matchMedia === "function" && matchMedia("(hover: none) and (pointer: coarse)").matches;
let _peekedHandIdx = null;
// Local "have I played a match before?" flag — used for first-match
// auto-tuning + juiced first-win. Stored in localStorage so anonymous
// users get the same first-match treatment even without an account.
// Big-deal moment for the player's first-ever win. A burst of confetti
// + a "WELCOME, TRAINER" banner that sits above the regular game-over
// recap.  Cleans up after 4 seconds.
// Big-deal momentum banner for win-streak milestones (3 / 5 / 10).
// Intensity drives the glow + particle count. Stays on-screen ~2.4s
// before fading; respects prefers-reduced-motion via CSS.
function flashStreakBanner(label, streakCount, intensity = "fire") {
  document.querySelectorAll(".streak-banner").forEach((b) => b.remove());
  const banner = document.createElement("div");
  banner.className = `streak-banner intensity-${intensity}`;
  banner.innerHTML = `
    <div class="sb-tag">${label}</div>
    <div class="sb-msg">${streakCount} WINS IN A ROW</div>`;
  document.body.appendChild(banner);
  requestAnimationFrame(() => banner.classList.add("show"));
  setTimeout(() => {
    banner.classList.remove("show");
    setTimeout(() => banner.remove(), 400);
  }, 2400);
  // Legendary tier gets a particle burst layered behind the banner.
  if (intensity === "legendary") {
    const layer = document.createElement("div");
    layer.className = "streak-particles";
    const colors = ["#ffd166", "#ef476f", "#06d6a0", "#118ab2", "#b388ff"];
    for (let i = 0; i < 40; i++) {
      const p = document.createElement("span");
      p.style.left = (Math.random() * 100) + "vw";
      p.style.background = colors[Math.floor(Math.random() * colors.length)];
      p.style.animationDelay = (Math.random() * 1.2) + "s";
      p.style.animationDuration = (2.2 + Math.random() * 1.4) + "s";
      layer.appendChild(p);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 4500);
  }
}

function celebrateFirstWin() {
  // Banner.
  const banner = document.createElement("div");
  banner.className = "first-win-banner";
  banner.innerHTML = `
    <div class="fwb-tag">FIRST VICTORY</div>
    <div class="fwb-msg">You did it. Welcome, Trainer.</div>`;
  document.body.appendChild(banner);
  requestAnimationFrame(() => banner.classList.add("show"));
  setTimeout(() => {
    banner.classList.remove("show");
    setTimeout(() => banner.remove(), 400);
  }, 3500);
  // Confetti — 80 small div particles falling with random horizontal
  // drift. Pure CSS animation so we don't lock the main thread.
  const layer = document.createElement("div");
  layer.className = "confetti-layer";
  const colors = ["#ffd166", "#ef476f", "#06d6a0", "#118ab2", "#b388ff", "#ff8a3d"];
  for (let i = 0; i < 80; i++) {
    const p = document.createElement("span");
    p.className = "confetti-piece";
    p.style.left = (Math.random() * 100) + "vw";
    p.style.background = colors[Math.floor(Math.random() * colors.length)];
    p.style.animationDelay = (Math.random() * 1.5) + "s";
    p.style.animationDuration = (2.5 + Math.random() * 2) + "s";
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    layer.appendChild(p);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 6000);
}

function hasPlayedBefore() {
  try { return localStorage.getItem("pokemon-tcg-played-once") === "1"; } catch { return false; }
}
function markHasPlayed() {
  try { localStorage.setItem("pokemon-tcg-played-once", "1"); } catch {}
}
function hasWonBefore() {
  try { return localStorage.getItem("pokemon-tcg-won-once") === "1"; } catch { return false; }
}
function markHasWon() {
  try { localStorage.setItem("pokemon-tcg-won-once", "1"); } catch {}
}

function refreshHandPeek() {
  document.querySelectorAll(".hand .card.peeked").forEach((c) => c.classList.remove("peeked"));
  if (_peekedHandIdx == null) return;
  const el = document.querySelector(`.hand .card[data-hand-index="${_peekedHandIdx}"]`);
  if (el) el.classList.add("peeked");
}
function clearHandPeek() { _peekedHandIdx = null; refreshHandPeek(); }
// Tapping outside the hand cancels the peek so it doesn't get stuck.
document.addEventListener("click", (e) => {
  if (_peekedHandIdx == null) return;
  if (e.target.closest(".hand .card")) return;
  clearHandPeek();
});

// --- Boot ------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", async () => {
  // Boot i18n shell in parallel with user + theme so localized copy is
  // ready by first render. Failure is silent — strings degrade to keys.
  initI18n().catch(() => {});
  try {
    const [user, themeRes] = await Promise.all([
      passkey.me(),
      fetch("/api/theme").then((r) => r.ok ? r.json() : null).catch(() => null),
    ]);
    currentUser = user;
    currentTheme = themeRes;
  } catch {
    currentUser = null;
  }
  // Wire story + daily-boss hooks — both hand off to the regular arena.
  story.setHooks({ startBossFight });
  daily.setHooks({ startBossFight: startDailyBossFight });
  renderMenu();
  $("#mute-toggle").addEventListener("click", () => {
    setMuted(!isMuted());
    refreshMuteIcon();
    if (!isMuted() && state && !state.winner) startBGM();
  });
  refreshMuteIcon();

  // QR / deep-link: ?code=XXXXXX auto-joins a private room.
  const urlParams = new URLSearchParams(location.search);
  const incomingCode = urlParams.get("code");
  if (incomingCode) {
    flashVerdict(`Tap a trainer, then join ${incomingCode.toUpperCase()}`, "super");
    window.__incomingRoomCode = incomingCode.toUpperCase();
  }
  // Spectator deep-link: ?spectate=<matchId> opens watch mode.
  const spectateId = urlParams.get("spectate");
  if (spectateId) {
    startSpectator(spectateId);
  }
  // Deck-code deep-link: ?d=<code> opens the deck-builder pre-loaded
  // with the shared deck; ?v=<code> queues a Friend Battle against
  // that deck (AI pilots it).
  const sharedDeck = urlParams.get("d");
  const versusDeck = urlParams.get("v");
  if (sharedDeck) {
    setTimeout(async () => {
      try {
        const db = await import("./deck-builder.js");
        await db.openWithCode?.(sharedDeck);
        flashVerdict("Shared deck loaded — save it to your library.", "super");
      } catch {
        flashVerdict("Couldn't open shared deck.", "weak");
      }
    }, 300);
    history.replaceState({}, "", location.pathname);
  } else if (versusDeck) {
    setTimeout(async () => {
      try {
        const r = await fetch(`/api/deck-code/${encodeURIComponent(versusDeck)}`);
        const { cards } = await r.json();
        if (!r.ok || !cards) throw new Error("bad code");
        window.__versusDeck = cards;
        window.__versusCode = versusDeck;
        // Best-effort: who owns this code? Used for the "Challenging X"
        // VS cinematic subtitle.
        fetch(`/api/deck-code/${encodeURIComponent(versusDeck)}/owner`).then((r) => r.ok ? r.json() : null)
          .then((data) => { if (data?.owner) window.__versusOwner = data.owner.displayName; })
          .catch(() => {});
        flashVerdict("Tap a trainer to battle the shared deck.", "super");
      } catch {
        flashVerdict("Couldn't load battle deck.", "weak");
      }
    }, 300);
    history.replaceState({}, "", location.pathname);
  }
});

function refreshMuteIcon() {
  const btn = $("#mute-toggle");
  btn.textContent = isMuted() ? "🔇" : "🔊";
  btn.setAttribute("aria-label", isMuted() ? "Unmute" : "Mute");
}

// --- Main menu -------------------------------------------------------------
function renderMenu() {
  const menu = $("#menu");
  const arena = $("#arena");
  arena.classList.add("hidden");
  menu.classList.remove("hidden");
  document.body.classList.remove("in-arena");

  const trainerEls = Object.values(TRAINERS).map((t) => {
    const c = TYPE_COLORS[t.portrait] || "#888";
    const art = trainerMascotUrl(t.id);
    return `
      <button class="trainer-card" data-trainer="${t.id}" style="--accent:${c}">
        <div class="trainer-portrait" style="background:linear-gradient(160deg, ${c}, #0c0d1a)">
          ${art ? `<img src="${art}" alt="${escape(t.name)}" loading="lazy">` : ""}
        </div>
        <div class="trainer-name">${t.name}</div>
        <div class="trainer-bio">${t.bio}</div>
      </button>`;
  });

  const difficulties = [
    { id: "easy",   label: "Easy",   bio: "AI plays the cheapest card, sometimes passes, attacks randomly." },
    { id: "medium", label: "Medium", bio: "AI picks a random affordable card and aims for low-HP enemies." },
    { id: "hard",   label: "Hard",   bio: "AI ramps to its biggest card and chases guaranteed KOs." },
  ];
  const difficultyEls = difficulties.map((d) => `
    <button class="diff-card ${d.id === aiDifficulty ? "selected" : ""}" data-difficulty="${d.id}">
      <div class="diff-label">${d.label}</div>
      <div class="diff-bio">${d.bio}</div>
    </button>
  `);

  menu.innerHTML = `
    ${renderAccountPanel()}
    <div class="menu-stage">
      <h1 class="game-title">Pokémon TCG</h1>
      <div class="menu-tagline">Build a 30-card deck. Wield Legendary signature moves. Out-strategize your rival.</div>
      ${renderFeatureStrip()}
      <div id="daily-card-slot"></div>
      <div id="challenges-inbox"></div>
      ${currentTheme?.type ? `
        <div class="theme-banner" style="--theme:${TYPE_COLORS[currentTheme.type] || '#888'}">
          <span class="theme-pill">Theme week</span>
          <span class="theme-text"><strong>${currentTheme.type}</strong> Pokémon get +1 ATK and appear more often in reward drops</span>
        </div>
      ` : ""}
      <div id="daily-streak-banner"></div>
      <div id="daily-quests-panel"></div>
      <div class="trainer-grid">${trainerEls.join("")}</div>
      <div class="section-label">Solo vs. AI difficulty</div>
      <div class="difficulty-grid">${difficultyEls.join("")}</div>
      <div class="menu-foot">
        <button class="start-btn" id="start-btn" disabled>Choose a trainer to begin</button>
        <div class="play-modes">
          <button class="mode-btn" id="mode-mp-match" disabled>Find online match</button>
          <button class="mode-btn" id="mode-mp-friend" disabled>Play vs friend (code)</button>
          <button class="mode-btn" id="mode-champion" disabled>Fight a Champion</button>
          <button class="mode-btn story-launch" id="mode-story" disabled title="${currentUser ? "Pick a trainer to begin Story Mode" : "Sign in to unlock Story Mode"}">📖 Story Mode</button>
          <button class="mode-btn" id="mode-trade" ${currentUser ? "" : "disabled"} title="${currentUser ? "Trade cards with other trainers" : "Sign in to trade"}">🔄 Trade Cards</button>
          <button class="mode-btn puzzle-launch" id="mode-puzzle" title="Today's chess-style card puzzle">🧩 Daily Puzzle</button>
          <button class="mode-btn" id="mode-reading" title="Read along with Pokémon friends">📚 Story Time</button>
          <button class="mode-btn" id="mode-explore" title="Browse every Pokémon in the Pokédex">🔍 Explore</button>
          <button class="mode-btn" id="how-to-play-btn">How to play</button>
        </div>
      </div>
    </div>
  `;
  wireAccountPanel();

  let chosen = chosenTrainer;
  if (chosen) {
    $$(".trainer-card", menu).forEach((el) => {
      if (el.dataset.trainer === chosen) el.classList.add("selected");
    });
    const btn = $("#start-btn");
    btn.disabled = false;
    btn.textContent = `Battle as ${TRAINERS[chosen].name} ▸`;
    $("#mode-mp-match").disabled = false;
    $("#mode-mp-friend").disabled = false;
    $("#mode-champion").disabled = false;
    if (currentUser) $("#mode-story").disabled = false;
  }
  $$(".trainer-card", menu).forEach((el) => {
    el.addEventListener("click", () => {
      $$(".trainer-card", menu).forEach((b) => b.classList.remove("selected"));
      el.classList.add("selected");
      chosen = el.dataset.trainer;
      chosenTrainer = chosen;
      const btn = $("#start-btn");
      btn.disabled = false;
      btn.textContent = `Battle as ${TRAINERS[chosen].name} ▸`;
      $("#mode-mp-match").disabled = false;
      $("#mode-mp-friend").disabled = false;
      $("#mode-champion").disabled = false;
      if (currentUser) $("#mode-story").disabled = false;

      // QR auto-join: if we landed here via ?code=XXXXX, jump straight to
      // the friend-join flow now that a trainer is picked.
      if (window.__incomingRoomCode) {
        const code = window.__incomingRoomCode;
        delete window.__incomingRoomCode;
        // history clean-up so a refresh doesn't re-trigger.
        history.replaceState({}, "", location.pathname);
        startMultiplayer({ mode: "friend" }).then(() => {
          document.body.dispatchEvent(new CustomEvent("mpFriendJoin", { detail: { code } }));
        });
      }
    });
  });

  $$(".diff-card", menu).forEach((el) => {
    el.addEventListener("click", () => {
      $$(".diff-card", menu).forEach((b) => b.classList.remove("selected"));
      el.classList.add("selected");
      aiDifficulty = el.dataset.difficulty;
      localStorage.setItem("pokemon-tcg-difficulty", aiDifficulty);
    });
  });

  $("#start-btn").addEventListener("click", async () => {
    if (!chosen) return;
    const btn = $("#start-btn");
    btn.disabled = true;
    btn.textContent = "Shuffling decks…";
    try {
      gameMode = "solo";
      const trainerIds = Object.keys(TRAINERS);
      const otherTrainers = trainerIds.filter((id) => id !== chosen);
      const aiTrainer = otherTrainers[Math.floor(Math.random() * otherTrainers.length)];
      // If the visitor arrived via a /?v=<code> Friend Battle link, the
      // AI plays that deck instead of a random roll.
      let [playerDeck, aiDeck] = await Promise.all([
        loadPlayerDeck(),
        window.__versusDeck ? Promise.resolve(window.__versusDeck) : fetchDeck(),
      ]);
      const isVersusShared = !!window.__versusDeck;
      let versusCode = null;
      if (isVersusShared) {
        versusCode = window.__versusCode || null;
        trackEvent("versus_deck_loaded", { code: versusCode });
        window.__versusDeck = null;
        window.__versusCode = null;
      }
      // Load the user's Card Mastery snapshot so L3 cards get +1 ATK
      // baked into createGame. Best-effort: missing or 401 is just no
      // mastery (vanilla match).
      let masteryById = null;
      if (currentUser) {
        try {
          const mr = await fetch("/me/mastery");
          if (mr.ok) masteryById = (await mr.json()).mastery || null;
        } catch {}
      }
      _gameOverFired = false;
      state = createGame({
        playerDeck,
        aiDeck,
        playerAbility: chosen,
        aiAbility: aiTrainer,
        firstPlayer: "player",
        masteryById,
      });
      if (currentTheme?.type) state.themeType = currentTheme.type;
      // Roll a random match modifier (~30% of matches). When one fires
      // a fanfare banner pops on turn-1 + the VS subtitle shows the name.
      const _mod = applyModifier(state, rollModifier());
      if (_mod) trackEvent("modifier_rolled", { id: _mod.id });
      // Friend-challenge attribution — when this is a /v/<code> battle,
      // attach the deck-code to state so onGameOver can post the result
      // back to the deck owner's inbox.
      if (versusCode) state._versusCode = versusCode;
      _prevHps = { player: null, ai: null };
      _prevEnergy = null;
      // Auto-tune the first-ever match so brand-new players win in 60-90s
      // and feel clever, not coddled. Detect "never finished a match" via
      // localStorage. Difficulty drops to Easy + AI gets a passive "newbie"
      // personality regardless of what the user picked.
      const isFirstMatch = !hasPlayedBefore();
      if (isFirstMatch) {
        aiDifficulty = "easy";
        aiPersonality = "balanced";
      } else {
        // Pick the AI personality once for this match so it stays consistent.
        aiPersonality = ["aggressive", "balanced", "tactical"][Math.floor(Math.random() * 3)];
      }
      state._isFirstMatch = isFirstMatch;
      trackEvent(isFirstMatch ? "first_match_started" : "match_started", { difficulty: aiDifficulty });
      // Anti-cheat: register the solo session with the server.
      // The reward issued at game-over will require this id and a min duration.
      soloSessionId = null;
      if (currentUser) {
        try {
          const r = await fetch("/me/solo/start", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ difficulty: aiDifficulty }),
          });
          if (r.ok) {
            const d = await r.json();
            soloSessionId = d.sessionId || null;
          }
        } catch {}
      }
      menu.classList.add("hidden");
      $("#arena").classList.remove("hidden");
      document.body.classList.add("in-arena");
      startBGM();
      await playVsCinematic({
        playerName: TRAINERS[chosen].name,
        playerSprite: trainerMascotUrl(chosen),
        playerColor: TYPE_COLORS[TRAINERS[chosen].portrait] || "#888",
        aiName: TRAINERS[aiTrainer].name,
        aiSprite: trainerMascotUrl(aiTrainer),
        aiColor: TYPE_COLORS[TRAINERS[aiTrainer].portrait] || "#888",
        subtitle: state.modifierActive
          ? `${state.modifierActive.icon} ${state.modifierActive.name}`
          : (isFirstMatch ? "Your first rival" : `${({ aggressive: "Aggressive", balanced: "Balanced", tactical: "Tactical" })[aiPersonality]} Rival`),
      });
      // Modifier flash on turn 1 so the player sees the rule clearly.
      if (state.modifierActive) {
        setTimeout(() => flashVerdict(`${state.modifierActive.icon} ${state.modifierActive.name}`, "super"), 900);
      }
      // First-match auto-skip: brand-new players don't yet know what
      // mulligan IS, and the 15s decision adds friction without
      // benefit.  Skip it on match #1 only — they keep their dealt hand.
      if (!isFirstMatch) await openMulliganModal();
      render();
      if (isFirstMatch) {
        setTimeout(() => flashVerdict("Welcome! Tap a card to play it.", "super"), 500);
      } else {
        // Reveal the rival's personality.
        const mood = ({ aggressive: "AGGRESSIVE 🔥", balanced: "BALANCED ⚖", tactical: "TACTICAL 🧠" })[aiPersonality];
        setTimeout(() => flashVerdict(`Rival is feeling ${mood}`, "weak"), 600);
      }
    } catch (err) {
      console.error(err);
      btn.textContent = "Failed to load deck. Retry";
      btn.disabled = false;
    }
  });

  $("#mode-mp-match").addEventListener("click", () => startMultiplayer({ mode: "queue" }));
  $("#mode-mp-friend").addEventListener("click", () => startMultiplayer({ mode: "friend" }));
  $("#mode-champion").addEventListener("click", () => openChampionPicker());
  $("#mode-story")?.addEventListener("click", () => story.openStoryHub({ currentUser }));
  $("#mode-trade")?.addEventListener("click", () => trading.openTradeMarket({ currentUser }));
  $("#mode-puzzle")?.addEventListener("click", () => puzzle.openPuzzle({ currentUser }));
  $("#mode-reading")?.addEventListener("click", openReadingMode);
  $("#mode-explore")?.addEventListener("click", openExplore);
  $("#how-to-play-btn").addEventListener("click", showHowToPlay);

  // Daily streak banner + trainer level chip + daily quests (signed-in only).
  if (currentUser) {
    loadAndRenderStreak();
    loadAndRenderTrainerLevel();
    loadAndRenderQuests();
  }
  // Daily boss landing card — shown to everyone (anonymous users see the
  // "sign in to play" CTA).  Lazy-rendered so it doesn't block first paint.
  daily.renderDailyCard($("#daily-card-slot"), { currentUser }).catch(() => {});
  if (currentUser) loadAndRenderChallenges();

  // First-time helper: nudge new visitors who haven't started a game yet.
  if (!localStorage.getItem("pokemon-tcg-seen-howto")) {
    setTimeout(() => {
      if (document.body.contains($("#how-to-play-btn"))) {
        $("#how-to-play-btn").classList.add("can-act");
      }
    }, 800);
  }
}

// "People played your shared deck" inbox — surfaces every time the
// home screen renders, so the loop closes from share → battle →
// notification on the original sharer's next visit.
async function loadAndRenderChallenges() {
  const panel = $("#challenges-inbox");
  if (!panel) return;
  try {
    const r = await fetch("/me/challenges/recent");
    if (!r.ok) return;
    const { results } = await r.json();
    if (!results?.length) return;
    const wins = results.filter((x) => !x.won).length;     // creator's deck won
    const losses = results.filter((x) => x.won).length;
    const recent = results.slice(0, 4);
    panel.innerHTML = `
      <div class="challenges-inbox">
        <div class="ci-head">
          <span class="ci-tag">📬 Your shared decks</span>
          <span class="ci-tot">${results.length} ${results.length === 1 ? "challenger" : "challengers"}
            · 🏆 ${wins} · 💀 ${losses}</span>
        </div>
        <ul class="ci-list">
          ${recent.map((r) => `
            <li class="ci-row ${r.won ? "lost" : "won"}">
              <span class="ci-who">${escape(r.challenger_name || "Anonymous Trainer")}</span>
              <span class="ci-verdict">${r.won ? "beat your deck" : "lost to your deck"}</span>
              <span class="ci-meta">${r.turns}t · ${r.hp_left}HP</span>
            </li>`).join("")}
        </ul>
      </div>`;
  } catch {}
}

async function loadAndRenderQuests() {
  const panel = $("#daily-quests-panel");
  if (!panel) return;
  try {
    const r = await fetch("/me/quests");
    if (!r.ok) return;
    const { quests } = await r.json();
    if (!quests?.length) return;
    panel.innerHTML = `
      <div class="quests-panel">
        <div class="quests-title">Daily quests</div>
        <div class="quests-list">
          ${quests.map((q) => {
            const pct = Math.min(100, Math.round((q.progress / q.target) * 100));
            return `
              <div class="quest-row ${q.claimed ? "claimed" : q.canClaim ? "ready" : ""}">
                <div class="quest-label">${escape(q.label)}</div>
                <div class="quest-bar"><div class="quest-bar-fill" style="width:${pct}%"></div></div>
                <div class="quest-prog">${q.progress}/${q.target}</div>
                ${q.claimed
                  ? `<span class="quest-status">✓ Claimed</span>`
                  : q.canClaim
                    ? `<button class="quest-claim primary" data-quest="${q.id}">Claim ${q.reward.count} card${q.reward.count > 1 ? "s" : ""}</button>`
                    : `<span class="quest-status">+${q.reward.count} card${q.reward.count > 1 ? "s" : ""}</span>`}
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
    panel.querySelectorAll(".quest-claim").forEach((btn) => {
      btn.addEventListener("click", () => claimQuest(btn.dataset.quest));
    });
  } catch {}
}

async function claimQuest(id) {
  try {
    const r = await fetch(`/me/quests/${id}/claim`, { method: "POST" });
    // Defensive JSON parse — if the server returned HTML (e.g. a 502
    // from an edge layer) we want a useful error, not a SyntaxError.
    let data = {};
    try { data = await r.json(); }
    catch (parseErr) {
      throw new Error(`server returned non-JSON (status ${r.status})`);
    }
    if (!r.ok) throw new Error(data.error || `claim failed (status ${r.status})`);
    rewards.showOffer(data.reward, {
      didWin: true,
      onClaim: (card) => {
        if (card) flashVerdict(`+${card.name}!`, "super");
        loadAndRenderQuests();
      },
    });
  } catch (err) {
    // Capture the error name + message so iOS Safari's
    // "The string did not match the expected pattern." gives us
    // a diagnostic hint instead of just a vague string.
    console.error("[claimQuest] failed:", err);
    const tag = err?.name && err.name !== "Error" ? `[${err.name}] ` : "";
    alert(`Couldn't claim: ${tag}${err?.message || "unknown error"}`);
    // Best-effort report to server logs so we can diagnose without
    // waiting for the user to paste back.
    try {
      trackEvent("claim_error", {
        kind: "quest",
        name: err?.name || "Error",
        message: (err?.message || "").slice(0, 200),
      });
    } catch {}
  }
}

async function loadAndRenderTrainerLevel() {
  const chip = $("#trainer-level-chip");
  if (!chip) return;
  try {
    const r = await fetch("/me/xp");
    if (!r.ok) return;
    const x = await r.json();
    const pct = Math.min(100, Math.round((x.progressInLevel / x.spanForLevel) * 100));
    chip.innerHTML = `
      <span class="tl-level">L${x.level}</span>
      <span class="tl-bar"><span class="tl-bar-fill" style="width:${pct}%"></span></span>
      <span class="tl-xp">${x.xp} XP</span>
    `;
  } catch {}
}

async function grantXp({ won, kos, crits }) {
  try {
    const res = await fetch("/me/xp/grant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ won, kos, crits }),
    });
    if (!res.ok) return;
    const data = await res.json();
    setTimeout(() => {
      flashVerdict(`+${data.gained} XP`, "super");
      if (data.streakMilestone) {
        setTimeout(() => flashVerdict(`🔥 ${data.streakMilestone} +${data.streakBonus} bonus XP`, "super"), 700);
      } else if (won && data.winStreak >= 2) {
        setTimeout(() => flashVerdict(`Win streak: ${data.winStreak}`, "super"), 600);
      }
      if (data.leveledUp) {
        setTimeout(() => flashVerdict(`Trainer Level ${data.level}!`, "super"), 1300);
      }
    }, 600);
  } catch {}
}

async function loadAndRenderStreak() {
  const slot = $("#daily-streak-banner");
  if (!slot) return;
  try {
    const r = await fetch("/me/streak");
    if (!r.ok) return;
    const s = await r.json();
    const next = s.nextRewardTier || { count: 1, minTier: 1 };
    slot.innerHTML = `
      <div class="streak-banner ${s.canClaim ? "ready" : "locked"}">
        <div class="streak-flame">${s.canClaim ? "🔥" : "💤"}</div>
        <div class="streak-text">
          <div class="streak-current">
            Day ${s.canClaim ? s.current + 1 : s.current} streak
          </div>
          <div class="streak-sub">
            ${s.canClaim
              ? `Claim today's bonus — ${next.count} card${next.count > 1 ? "s" : ""}${next.minTier > 1 ? `, tier ${next.minTier}+` : ""}`
              : `Come back tomorrow for day ${s.current + 1}`}
          </div>
        </div>
        ${s.canClaim
          ? `<button class="streak-claim primary">Claim</button>`
          : `<div class="streak-longest">Best: ${s.longest}</div>`}
      </div>
    `;
    if (s.canClaim) {
      slot.querySelector(".streak-claim").addEventListener("click", claimStreak);
    }
  } catch {}
}

async function claimStreak() {
  const btn = document.querySelector(".streak-claim");
  if (btn) { btn.disabled = true; btn.textContent = "Claiming…"; }
  try {
    const r = await fetch("/me/streak/claim", { method: "POST" });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "claim failed");
    rewards.showOffer(data.reward, {
      didWin: true,
      onClaim: (card) => {
        if (card) flashVerdict(`+${card.name}!`, "super");
        loadAndRenderStreak();
      },
    });
  } catch (err) {
    alert("Couldn't claim: " + (err.message || "unknown"));
    if (btn) { btn.disabled = false; btn.textContent = "Claim"; }
  }
}

// Champion picker — fetches the 4 champions from the server and lets the
// user pick one. Selecting starts a solo match with the champion's deck
// as the AI, difficulty Hard, and a "championId" flag that the reward
// endpoint reads to grant a beefier offer on win.
let _championId = null;
async function openChampionPicker() {
  if (!chosenTrainer) { flashVerdict("Pick a trainer first", "weak"); return; }
  let overlay = document.querySelector(".champ-overlay");
  if (overlay) overlay.remove();
  overlay = document.createElement("div");
  overlay.className = "champ-overlay";
  overlay.innerHTML = `<div class="champ-card"><div class="champ-loading">Loading champions…</div></div>`;
  document.body.appendChild(overlay);
  try {
    const r = await fetch("/api/champion/list");
    const { champions } = await r.json();
    overlay.querySelector(".champ-card").innerHTML = `
      <div class="champ-title">Challenge a Champion</div>
      <div class="champ-sub">Curated legendary deck. Hard AI. Double reward on win.</div>
      <div class="champ-list">
        ${champions.map((c) => `
          <button class="champ-row" data-id="${c.id}">
            <img class="champ-art" src="https://play.pokemonshowdown.com/sprites/trainers/${c.portrait}.png" alt="${escape(c.name)}" loading="lazy">
            <div class="champ-body">
              <div class="champ-name">${escape(c.name)}</div>
              <div class="champ-titletag">${escape(c.title)}</div>
              <div class="champ-bio">${escape(c.bio)}</div>
            </div>
            <div class="champ-go">Fight ▸</div>
          </button>
        `).join("")}
      </div>
      <button class="champ-cancel">Cancel</button>
    `;
    overlay.querySelector(".champ-cancel").addEventListener("click", () => overlay.remove());
    overlay.querySelectorAll(".champ-row").forEach((row) => {
      row.addEventListener("click", async () => {
        const id = row.dataset.id;
        overlay.remove();
        await startChampionFight(id);
      });
    });
  } catch (err) {
    overlay.querySelector(".champ-card").innerHTML = `<div class="champ-err">Couldn't load: ${err.message}</div>`;
  }
}

let _storyContext = null; // { chapterId, sessionId, chapter } during a story fight

// Daily Boss wrapper around the regular boss-fight path. Same engine,
// same arena — finishDaily replaces finishChapter on game-over.
async function startDailyBossFight({ sessionId, chapter, boss, deck, phaseRules, summonCards }) {
  if (!chosenTrainer) chosenTrainer = currentUser?.trainer_ability || Object.keys(TRAINERS)[0];
  await startBossFight({
    chapterId: chapter.id,
    sessionId,
    chapter,
    boss,
    deck,
    phaseRules,
    summonCards,
  });
  // Tag the context so onGameOver routes to the daily flow.
  if (_storyContext) _storyContext.daily = true;
  trackEvent("daily_started", { day: chapter.id });
}

async function startBossFight({ chapterId, sessionId, chapter, boss, deck, phaseRules, summonCards }) {
  // Story can be launched from a chapter card directly — be lenient about
  // trainer pick. Default to the user's saved trainer ability or the first
  // trainer in the registry so we never silently bounce back to the menu.
  if (!chosenTrainer) {
    chosenTrainer = currentUser?.trainer_ability || Object.keys(TRAINERS)[0];
  }
  flashVerdict(`${chapter.enemyTrainerName} blocks your path!`, "super");
  const playerDeck = await loadPlayerDeck();
  gameMode = "story";
  _storyContext = { chapterId, sessionId, chapter };
  _gameOverFired = false;
  state = createGame({
    playerDeck,
    aiDeck: deck,
    playerAbility: chosenTrainer,
    aiAbility: chapter.enemyAbility || "lance",
    firstPlayer: "player",
    aiTrainerHp: boss.maxHp,
    aiName: chapter.enemyTrainerName || boss.displayName,
  });
  if (currentTheme?.type) state.themeType = currentTheme.type;
  state.boss = {
    chapterId,
    displayName: boss.displayName,
    maxHp: boss.maxHp,
    anchorPokemonId: boss.anchorPokemonId,
    types: boss.types || [],
    phaseRules: (phaseRules || []).map((r) => ({ ...r, applied: false })),
    summonCards: summonCards || {},
    attackBonus: 0,
    ignoreDefense: false,
  };
  _prevHps = { player: null, ai: null };
  _prevEnergy = null;
  aiPersonality = "tactical";
  aiDifficulty = "hard";
  $("#menu").classList.add("hidden");
  $("#arena").classList.remove("hidden");
  document.body.classList.add("in-arena");
  startBGM();
  await openMulliganModal();
  render();
  setTimeout(() => flashVerdict(`${boss.displayName} appears!`, "super"), 600);
}

async function startChampionFight(championId) {
  if (!chosenTrainer) return;
  flashVerdict("Engaging Champion…", "super");
  try {
    const r = await fetch(`/api/champion/${championId}/deck`);
    const { champion, deck: aiDeck } = await r.json();
    const playerDeck = await loadPlayerDeck();
    gameMode = "solo";
    _championId = championId;
    _gameOverFired = false;
    state = createGame({
      playerDeck,
      aiDeck,
      playerAbility: chosenTrainer,
      aiAbility: "lance", // generic so the AI trainer has SOMETHING; flavor only
      firstPlayer: "player",
    });
    if (currentTheme?.type) state.themeType = currentTheme.type;
    _prevHps = { player: null, ai: null };
    _prevEnergy = null;
    aiPersonality = "tactical"; // champions are smart
    // Champion match → soloSession not registered (anti-cheat path bypassed);
    // server will accept the championId on /me/solo/end.
    soloSessionId = null;
    if (currentUser) {
      try {
        const r = await fetch("/me/solo/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ difficulty: "hard" }),
        });
        if (r.ok) { soloSessionId = (await r.json()).sessionId || null; }
      } catch {}
    }
    aiDifficulty = "hard";
    $("#menu").classList.add("hidden");
    $("#arena").classList.remove("hidden");
    document.body.classList.add("in-arena");
    startBGM();
    await openMulliganModal();
    render();
    setTimeout(() => flashVerdict(`${champion.name} accepts your challenge!`, "super"), 600);
  } catch (err) {
    alert("Couldn't start: " + (err.message || "unknown"));
  }
}

// Opens the Pokédex Explore overlay. Lazy-loads so the ~6KB module +
// CSS only ship when the player actually clicks Explore.
async function openExplore() {
  const mod = await import("./explore.js");
  await mod.open();
}

// Opens the kid-friendly read-along Reading Mode as an overlay. The
// reading-mode module owns its own DOM lifecycle — we just give it a
// rooted container and clean up when the close button fires.
async function openReadingMode() {
  // Lazy-load to keep the initial bundle lean. Reading Mode isn't on
  // the critical battle path; defer its 8KB until the user opens it.
  const mod = await import("./reading-mode.js");
  document.querySelector(".reading-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "reading-overlay howto-overlay"; // reuse the dim/blur shell
  overlay.innerHTML = `
    <div class="howto-card" style="max-width: 800px; padding: 0; overflow: hidden;">
      <div class="reading-overlay-close-wrap" style="display: flex; justify-content: flex-end; padding: 10px;">
        <button class="howto-close" id="reading-close">✕ Close</button>
      </div>
      <div id="reading-root"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#reading-close").addEventListener("click", () => {
    mod.destroyReadingMode();
    overlay.remove();
  });
  await mod.openReadingMode(overlay.querySelector("#reading-root"));
}

function showHowToPlay() {
  localStorage.setItem("pokemon-tcg-seen-howto", "1");
  document.querySelector(".howto-overlay")?.remove();
  const o = document.createElement("div");
  o.className = "howto-overlay";
  o.innerHTML = `
    <div class="howto-card">
      <h2>How to Play</h2>
      <div class="howto-step">
        <div class="howto-num">1</div>
        <div>
          <strong>Each turn</strong> you draw a card and your max Energy ⚡ grows
          by 1 (up to 10). Play Pokémon from your hand by clicking them — they
          cost Energy based on their tier.
        </div>
      </div>
      <div class="howto-step">
        <div class="howto-num">2</div>
        <div>
          <strong>To attack</strong>, tap one of your Pokémon to select it, then
          choose its <em>Basic</em> attack (free) or its <em>Special</em> attack
          (costs extra Energy, more damage, often inflicts a status).
        </div>
      </div>
      <div class="howto-step">
        <div class="howto-num">3</div>
        <div>
          <strong>Then tap a target</strong> — an enemy Pokémon, or the opposing
          trainer's portrait when their field is empty. Reduce their trainer's
          HP from 30 to 0 to win.
        </div>
      </div>
      <div class="howto-step">
        <div class="howto-num">4</div>
        <div>
          <strong>Types matter.</strong> Fire beats Grass, Water beats Fire, etc.
          Hover an enemy with your attacker selected to preview damage.
        </div>
      </div>
      <div class="howto-step">
        <div class="howto-num">5</div>
        <div>
          <strong>Earn cards</strong> by winning matches. Sign in to save your
          collection, build custom decks, and climb the leaderboard.
        </div>
      </div>
      <button class="howto-close">Got it ✓</button>
    </div>
  `;
  document.body.appendChild(o);
  o.querySelector(".howto-close").addEventListener("click", () => o.remove());
  o.addEventListener("click", (e) => {
    if (e.target === o) o.remove();
  });
}

// --- Arena rendering -------------------------------------------------------
function render() {
  if (!state) return;
  const arena = $("#arena");
  arena.innerHTML = `
    <div class="arena-bg"></div>
    <div class="trainer-row top">
      <div class="trainer-block ai${state.activePlayer === "ai" && !state.winner ? " is-turn" : ""}">
        <div class="trainer-avatar" data-ability="${state.players.ai.ability}">
          ${trainerMascotUrl(state.players.ai.ability) ? `<img src="${trainerMascotUrl(state.players.ai.ability)}" alt="${escape(TRAINERS[state.players.ai.ability]?.name || "")}" loading="lazy">` : ""}
        </div>
        <div class="trainer-meta">
          <div class="trainer-label">${escape(opponentLabel())} (${TRAINERS[state.players.ai.ability]?.name || state.players.ai.ability})</div>
          ${hpBar(state.players.ai.trainerHp, state.players.ai.maxTrainerHp)}
          <div class="trainer-resources">
            <span>✋ ${state.players.ai.hand.length}</span>
            <span>📚 ${state.players.ai.deck.length}</span>
          </div>
        </div>
      </div>
      <div class="turn-banner">
        <div class="turn-label">Turn ${state.turn}</div>
        <div class="turn-active">${state.activePlayer === "player" ? "Your move" : "Rival is thinking…"}</div>
        <div class="turn-timer" id="turn-timer"></div>
        <div class="turn-hint">${escape(turnHint())}</div>
      </div>
    </div>

    <div class="opp-hand-row" id="opp-hand">${renderOpponentHand(state.players.ai.hand.length)}</div>

    <div class="field ai-field" id="ai-field"></div>
    <div class="field player-field" id="player-field"></div>

    <div class="trainer-row bottom">
      <div class="trainer-block player${state.activePlayer === "player" && !state.winner ? " is-turn" : ""}">
        <div class="trainer-avatar" data-ability="${state.players.player.ability}">
          ${trainerMascotUrl(state.players.player.ability) ? `<img src="${trainerMascotUrl(state.players.player.ability)}" alt="${escape(TRAINERS[state.players.player.ability]?.name || "")}" loading="lazy">` : ""}
        </div>
        <div class="trainer-meta">
          <div class="trainer-label">${escape(youLabel())} (${TRAINERS[state.players.player.ability]?.name || state.players.player.ability})</div>
          ${hpBar(state.players.player.trainerHp, state.players.player.maxTrainerHp)}
          <div class="trainer-resources">
            <div class="energy-pips" title="Energy ${state.players.player.energy}/${state.players.player.maxEnergy}">
              ${renderEnergyPips(state.players.player.energy, state.players.player.maxEnergy)}
            </div>
            <span>📚 ${state.players.player.deck.length}</span>
            <span>🗑 ${state.players.player.discard.length}</span>
          </div>
          ${renderItemBar(state.players.player)}
          ${renderComboTags(state.players.player)}
        </div>
      </div>
      <div class="action-bar">
        <button id="hand-toggle-btn" class="hand-toggle ${_handLifted ? "is-lifted" : ""}"
                title="Lift / lower your hand (tap to see full cards)">
          ${_handLifted ? "▼ Lower hand" : "▲ Show hand"}
        </button>
        <button id="end-turn-btn" ${state.activePlayer !== "player" || state.winner ? "disabled" : ""}>End turn ▸</button>
        <button id="concede-btn">Concede</button>
      </div>
    </div>

    <div class="hand" id="hand"></div>

    <aside class="log-panel" id="log-panel"></aside>
  `;

  renderFields();
  renderHand();
  renderLog();

  $("#end-turn-btn").addEventListener("click", onEndTurn);
  $("#hand-toggle-btn")?.addEventListener("click", toggleHandLift);
  // Apply hand-lift class. We honor the user's persisted preference, BUT
  // auto-suppress it when there's nothing playable in hand — no reason to
  // keep the fan covering the field once energy can't afford anything.
  applyHandLiftState();
  $("#concede-btn").addEventListener("click", () => {
    if (!confirm("Concede this match?")) return;
    if (gameMode === "mp") {
      mp.concede();
      return; // server will emit game:over and the regular flow takes over
    }
    state.winner = "ai";
    state.phase = "over";
    onGameOver();
  });

  bindTrainerAttackTarget();
  bindItemBar();
  bindDragAttack();
  startTurnTimer();

  // Long-hover preview anywhere a card is rendered in-arena.
  attachPreviewHandlers($("#arena"), cardLookup);

  // Turn-start cue: when the active player flips to "player" (and it's a
  // real turn, not the initial render or a spectator view), pop the
  // "Your turn" banner + ping.
  if (
    state.youAre !== "spectator" &&
    !state.winner &&
    _prevActivePlayer != null &&
    _prevActivePlayer !== state.activePlayer &&
    state.activePlayer === "player"
  ) {
    showYourTurnBanner();
  }
  _prevActivePlayer = state.activePlayer;

  // Trainer HP flash: if either side's HP dropped vs the previous render,
  // run the damage animation on that bar. When the PLAYER's HP drops
  // also fire a full-screen red vignette + scream the damage as a
  // big floating number on the trainer block — without this, time-
  // pressure ticks and trainer-targeted attacks were easy to miss.
  for (const side of ["player", "ai"]) {
    const cur = state.players[side].trainerHp;
    const prev = _prevHps[side];
    if (prev != null && cur < prev) {
      const bar = $(`.trainer-block.${side} .hp-bar`);
      if (bar) {
        bar.classList.remove("damaged");
        // eslint-disable-next-line no-unused-expressions
        bar.offsetHeight;
        bar.classList.add("damaged");
      }
      if (side === "player") {
        const lost = prev - cur;
        const block = $(".trainer-block.player");
        if (block) {
          floatDamage(block, `-${lost}`, { kind: lost >= 6 ? "crit" : "hit" });
          shakeHit(block);
        }
        triggerPlayerHitVignette(lost >= 6);
      }
    }
    _prevHps[side] = cur;
  }

  if (state.winner) onGameOver();
}

// Coach the player about what to do next. Reads state to figure out which
// action is the most useful nudge.
// Three featured legendaries above the trainer grid — rotates each page-load
// from a small curated pool of icons with custom signatures.
const FEATURED_POOL = [
  { id: 150, name: "Mewtwo",   tag: "Recover",        desc: "Heals 3 HP every turn it survives" },
  { id: 384, name: "Rayquaza", tag: "Dragon Ascent",  desc: "+1 ATK each turn, up to +5" },
  { id: 250, name: "Ho-Oh",    tag: "Phoenix Down",   desc: "Survives the first KO at 50% HP" },
  { id: 249, name: "Lugia",    tag: "Aeroblast",      desc: "Every attack ignores defense" },
  { id: 145, name: "Zapdos",   tag: "Thunderstorm",   desc: "Doubles your crit chance" },
  { id: 493, name: "Arceus",   tag: "Judgment",       desc: "Heals your whole field on summon" },
  { id: 382, name: "Kyogre",   tag: "Drizzle",        desc: "Your Water Pokémon strike for +1" },
  { id: 384, name: "Rayquaza", tag: "Dragon Ascent",  desc: "+1 ATK each turn, up to +5" },
];
function renderFeatureStrip() {
  // Pick 3 distinct random entries.
  const pool = [...FEATURED_POOL];
  const picks = [];
  while (picks.length < 3 && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length);
    const c = pool.splice(idx, 1)[0];
    if (!picks.some((p) => p.id === c.id)) picks.push(c);
  }
  return `
    <div class="feature-strip">
      ${picks.map((c) => `
        <div class="feature-card">
          <div class="feature-art" style="background-image:url('https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${c.id}.png')"></div>
          <div class="feature-body">
            <div class="feature-name">${escape(c.name)}</div>
            <div class="feature-ability">⭐ ${escape(c.tag)}</div>
            <div class="feature-desc">${escape(c.desc)}</div>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

// Drag-to-attack — players can grab one of their ready attackers and drop
// it on an enemy card or the opposing trainer block. Uses native HTML5
// drag-and-drop; click-to-attack stays as fallback for touch and for the
// ability-popover path.
let _dragSlot = null;
function bindDragAttack() {
  // Source — player field cards with draggable="true".
  document.querySelectorAll('.player-field .card[draggable="true"]').forEach((el) => {
    el.addEventListener("dragstart", (e) => {
      _dragSlot = Number(el.dataset.dragSlot);
      el.classList.add("being-dragged");
      try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(_dragSlot)); } catch {}
      document.body.classList.add("dragging-attack");
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("being-dragged");
      document.body.classList.remove("dragging-attack");
      document.querySelectorAll(".drop-hover").forEach((x) => x.classList.remove("drop-hover"));
      _dragSlot = null;
    });
  });

  // Target highlighting for enemy field slots.
  document.querySelectorAll(".ai-field .field-slot").forEach((slotEl) => {
    slotEl.addEventListener("dragover", (e) => {
      if (_dragSlot == null) return;
      e.preventDefault();
      slotEl.classList.add("drop-hover");
    });
    slotEl.addEventListener("dragleave", () => slotEl.classList.remove("drop-hover"));
    slotEl.addEventListener("drop", (e) => {
      e.preventDefault();
      slotEl.classList.remove("drop-hover");
      if (_dragSlot == null) return;
      const targetSlot = Number(slotEl.dataset.slot);
      const fromSlot = _dragSlot;
      _dragSlot = null;
      performAttackFromDrag(fromSlot, targetSlot);
    });
  });

  // Trainer block as a drop target when their field is empty.
  const trainerBlock = $(".trainer-row.top .trainer-block.ai");
  if (trainerBlock) {
    trainerBlock.addEventListener("dragover", (e) => {
      if (_dragSlot == null) return;
      e.preventDefault();
      trainerBlock.classList.add("drop-hover");
    });
    trainerBlock.addEventListener("dragleave", () => trainerBlock.classList.remove("drop-hover"));
    trainerBlock.addEventListener("drop", (e) => {
      e.preventDefault();
      trainerBlock.classList.remove("drop-hover");
      if (_dragSlot == null) return;
      const fromSlot = _dragSlot;
      _dragSlot = null;
      performAttackFromDrag(fromSlot, "trainer");
    });
  }
}

function performAttackFromDrag(fromSlot, target) {
  // Drag uses the basic attack — popover flow still available via click.
  selectedAttacker = null;
  chosenAbilityId = "basic";
  hideAbilityPopover();
  if (gameMode === "mp") {
    mp.attack(fromSlot, target, "basic");
    return;
  }
  const attackerEl = $(`.player-field .field-slot[data-slot="${fromSlot}"] .card`);
  const defenderEl = target === "trainer"
    ? $(".trainer-block.ai")
    : $(`.ai-field .field-slot[data-slot="${target}"] .card`);
  const attackerInst = state.players.player.field[fromSlot];
  const result = attack(state, "player", fromSlot, target, { abilityId: "basic" });
  if (!result.ok) {
    flashVerdict(result.reason, "weak");
    return;
  }
  // Fire-and-forget battle emote(s) for this attack. Events are
  // classified by attackResultToEvents (super/weak/hit + maybe ko).
  for (const ev of attackResultToEvents(result)) playEmote(ev);
  animateHit(attackerEl, defenderEl, attackerInst, result, () => render());
}

function renderComboTags(p) {
  // Group by primary type; show a chip if any group ≥ 2.
  const counts = new Map();
  for (const inst of p.field) {
    if (!inst) continue;
    const t = inst.card.types?.[0];
    if (!t) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const active = [...counts.entries()].filter(([, n]) => n >= 2);
  if (!active.length) return "";
  return `
    <div class="combo-tags">
      ${active.map(([t, n]) => {
        const bonus = Math.min(3, n - 1);
        return `<span class="combo-tag" style="background:${TYPE_COLORS[t] || "#888"}">${t} ×${n} +${bonus} ATK</span>`;
      }).join("")}
    </div>
  `;
}

function renderItemBar(p) {
  if (!p.items?.length) return "";
  return `
    <div class="item-bar">
      ${p.items.map((it) => {
        const def = ITEM_DEFS[it.id] || {};
        const disabled = it.uses <= 0 || p.energy < (def.cost || 0);
        const active = pendingItem === it.id;
        return `
          <button class="item-btn ${disabled ? "disabled" : ""} ${active ? "active" : ""}"
                  data-item="${it.id}"
                  title="${escape(def.name)} — ${escape(def.desc || "")}${def.cost ? ` (⚡${def.cost})` : ""}">
            <span class="item-icon">${def.icon || "?"}</span>
            <span class="item-uses">${it.uses}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function bindItemBar() {
  document.querySelectorAll(".item-bar .item-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("disabled")) {
        flashVerdict("Item unavailable", "weak");
        return;
      }
      if (state.activePlayer !== "player" || state.winner) {
        flashVerdict("Wait for your turn", "weak");
        return;
      }
      const id = btn.dataset.item;
      const def = ITEM_DEFS[id];
      if (def.target === "none") {
        applyItem(id, null);
      } else {
        // Need a target — enter targeting mode.
        pendingItem = id;
        selectedAttacker = null;
        hideAbilityPopover();
        chosenAbilityId = "basic";
        flashVerdict(`${def.name}: tap one of your Pokémon`, "super");
        render();
      }
    });
  });
}

function applyItem(itemId, target) {
  if (gameMode === "mp") {
    mp.useItem(itemId, target);
    pendingItem = null;
    return;
  }
  const r = useItem(state, "player", itemId, target);
  if (!r.ok) {
    flashVerdict(r.reason || "Item failed", "weak");
    return;
  }
  pendingItem = null;
  if (r.itemId === "potion") flashVerdict(`+${r.healed} HP`, "super");
  if (r.itemId === "energy") flashVerdict(`+${r.gained} ⚡`, "super");
  render();
}

function renderEnergyPips(have, max) {
  const total = Math.max(max, 1);
  // Pips index 0..total-1. Mark "refill" on pips that are newly lit since
  // the previous render so they pop in.
  const prev = _prevEnergy ?? have;
  let html = "";
  for (let i = 0; i < total; i++) {
    const lit = i < have;
    const newlyLit = lit && i >= prev;
    const cls = lit ? `lit${newlyLit ? " refill" : ""}` : "dim";
    html += `<span class="ep-pip ${cls}">⚡</span>`;
  }
  _prevEnergy = have;
  return html;
}

function turnHint() {
  if (!state) return "";
  if (state.winner) return "";
  if (state.activePlayer !== "player") return "Wait for your opponent…";
  const p = state.players.player;
  const me = p.field.filter(Boolean);
  const oppField = state.players.ai.field.filter(Boolean);

  if (pendingReplace != null) {
    return "Tap one of your Pokémon to sacrifice (it will be discarded)";
  }
  if (pendingItem != null) {
    return "Tap one of your Pokémon to use the item on";
  }
  if (selectedAttacker != null) {
    if (oppField.length > 0) return "Pick an attack, then tap your target";
    return "Pick an attack, then tap the opposing trainer";
  }

  // Are any of our Pokémon ready to attack?
  const readyAttackers = p.field.filter(
    (s) => s && !s.summoningSickness && !s.attackedThisTurn,
  );
  if (readyAttackers.length > 0) {
    return `Tap one of your ${readyAttackers.length === 1 ? "Pokémon" : `${readyAttackers.length} Pokémon`} to attack`;
  }

  // Otherwise prompt summoning or end-turn.
  const playable = p.hand.filter((c) => effectiveCost(p, c) <= p.energy);
  if (playable.length > 0 && p.field.includes(null)) {
    return `Tap a card from your hand to summon (${playable.length} affordable)`;
  }
  return "Click End Turn ▸";
}

function opponentLabel() {
  if (gameMode === "mp" && mpOpponent?.displayName) return mpOpponent.displayName;
  return state?.players?.ai?.name || "Rival";
}
function youLabel() {
  if (gameMode === "mp") return currentUser?.display_name || "You";
  return state?.players?.player?.name || "You";
}

function hpBar(hp, max) {
  const cap = max || TRAINER_START_HP;
  const pct = Math.max(0, Math.min(100, (hp / cap) * 100));
  const tone = pct > 60 ? "good" : pct > 30 ? "mid" : "bad";
  return `
    <div class="hp-row">
      <div class="hp-bar tone-${tone}"><div class="hp-fill" style="width:${pct}%"></div></div>
      <div class="hp-text">${hp}/${cap}</div>
    </div>
  `;
}

function renderFields() {
  // Are we currently picking a target for a staged spell? If so, the
  // relevant side's occupied slots glow as valid targets.
  const spellExpectsEnemy = pendingSpell?.target === "enemyField";
  const spellExpectsOwn   = pendingSpell?.target === "ownField";
  for (const side of ["player", "ai"]) {
    const root = $(side === "player" ? "#player-field" : "#ai-field");
    root.innerHTML = "";
    const p = state.players[side];
    for (let i = 0; i < FIELD_SIZE; i++) {
      const slot = document.createElement("div");
      slot.className = `field-slot ${side}`;
      slot.dataset.side = side;
      slot.dataset.slot = String(i);
      // Spell-targeting glow: only on occupied slots of the right side.
      const isCorrectTargetSide =
        (spellExpectsEnemy && side === "ai") ||
        (spellExpectsOwn   && side === "player");
      if (isCorrectTargetSide && p.field[i]) {
        slot.classList.add("spell-target");
      }
      const inst = p.field[i];
      if (inst) {
        const card = renderCard(inst.card, { instance: inst });
        if (inst.summoningSickness) card.classList.add("summoning");
        if (inst.attackedThisTurn) card.classList.add("spent");
        if (selectedAttacker && side === "player" && selectedAttacker.slot === i) card.classList.add("selected");
        if (pendingReplace && side === "player") card.classList.add("sacrifice-target");
        if (inst.card?.is_legendary) card.classList.add("is-legendary");
        else if (inst.card?.is_mythical) card.classList.add("is-mythical");
        // Drag-to-attack — only on the player's own ready attackers.
        if (
          side === "player" &&
          state.activePlayer === "player" &&
          !state.winner &&
          !inst.summoningSickness &&
          !inst.attackedThisTurn &&
          state.youAre !== "spectator"
        ) {
          card.setAttribute("draggable", "true");
          card.dataset.dragSlot = String(i);
        }
        // Pulse our ready attackers when it's our turn (cue: "tap me!").
        const canActNow =
          side === "player" &&
          state.activePlayer === "player" &&
          !state.winner &&
          !inst.summoningSickness &&
          !inst.attackedThisTurn &&
          !selectedAttacker;
        if (canActNow) card.classList.add("can-act");
        slot.appendChild(card);
        // Damage preview: when an attacker is selected, show predicted -dmg
        // and matchup verdict on EVERY enemy target so the player can
        // compare options without hovering each one (touch-friendly).
        if (side === "ai" && selectedAttacker) {
          showDamagePreview(slot, inst, { sticky: true });
          // Desktop hover still gets a slight emphasis so it's clear which
          // target is currently focused.
          slot.addEventListener("mouseenter", () => slot.classList.add("hover-target"));
          slot.addEventListener("mouseleave", () => slot.classList.remove("hover-target"));
        }
      } else {
        slot.innerHTML = `<div class="slot-empty">empty</div>`;
      }
      slot.addEventListener("click", () => onSlotClick(side, i));
      root.appendChild(slot);
    }
  }
}

// Resolve a card id to the full card definition (looks in hand, field, decks).
function cardLookup(id) {
  if (!state) return null;
  for (const side of ["player", "ai"]) {
    const p = state.players[side];
    for (const c of p.hand) if (c && c.id === id) return c;
    for (const inst of p.field) if (inst?.card?.id === id) return inst.card;
  }
  return null;
}

// Document-level click-away handler — kept around so we can remove it when
// the popover is hidden.
let _popoverDismissHandler = null;

function showAbilityPopover(attackerInst) {
  hideAbilityPopover();
  const abilities = abilitiesFor(attackerInst.card);
  const p = state.players.player;

  const slot = $(`.player-field .field-slot[data-slot="${state.players.player.field.indexOf(attackerInst)}"]`);
  const root = $("#arena");
  const pop = document.createElement("div");
  pop.className = "ability-popover";
  pop.innerHTML = `
    <div class="ap-title">${escape(attackerInst.card.name)} — choose attack</div>
    <div class="ap-list">
      ${abilities.map((ab) => {
        const affordable = p.energy >= ab.energyCost;
        const isSelected = ab.id === chosenAbilityId;
        return `
          <button class="ap-row ${affordable ? "" : "disabled"} ${isSelected ? "selected" : ""}"
                  data-ability="${ab.id}" ${affordable ? "" : "disabled"}>
            <span class="ap-name">${escape(ab.name)}</span>
            <span class="ap-cost">${ab.energyCost > 0 ? `⚡${ab.energyCost}` : "free"}</span>
            <span class="ap-mult">×${(ab.damageMult || 1).toFixed(2).replace(/\.00$/, "")}</span>
            ${ab.status ? `<span class="ap-status">${ab.status}</span>` : ""}
            <span class="ap-desc">${escape(ab.desc)}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;
  document.body.appendChild(pop);

  // Position to the right of the attacker card.
  if (slot) {
    const r = slot.getBoundingClientRect();
    pop.style.left = `${r.right + 14}px`;
    pop.style.top = `${r.top - 6}px`;
    if (r.right + 14 + 280 > window.innerWidth) {
      // overflow — flip to the left side
      pop.style.left = `${r.left - 14 - 280}px`;
    }
  }

  pop.querySelectorAll(".ap-row").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.classList.contains("disabled")) return;
      chosenAbilityId = btn.dataset.ability;
      pop.querySelectorAll(".ap-row").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
    });
  });
  // Click anywhere else cancels the attack + closes the popover.
  // Defer one frame so the click that opened the popover doesn't dismiss it.
  setTimeout(() => {
    _popoverDismissHandler = (e) => {
      // Allow clicks inside the popover itself or on the selected attacker.
      if (pop.contains(e.target)) return;
      const onAttacker = e.target.closest(".player-field .field-slot .selected");
      if (onAttacker) return;
      // Allow clicks on attack targets (enemy cards / opposing trainer block).
      const onEnemyField = e.target.closest(".ai-field .field-slot");
      const onOpponentTrainer = e.target.closest(".trainer-block.ai");
      if (onEnemyField || onOpponentTrainer) return;
      // Otherwise cancel: drop the selection and close the popover.
      selectedAttacker = null;
      chosenAbilityId = "basic";
      hideAbilityPopover();
      render();
    };
    document.addEventListener("click", _popoverDismissHandler, true);
  }, 0);
}

function hideAbilityPopover() {
  document.querySelector(".ability-popover")?.remove();
  if (_popoverDismissHandler) {
    document.removeEventListener("click", _popoverDismissHandler, true);
    _popoverDismissHandler = null;
  }
}

function showDamagePreview(slotEl, defenderInst, { sticky = false } = {}) {
  if (!selectedAttacker) return;
  // Don't double-render if we already have a sticky preview here.
  if (slotEl.querySelector(".dmg-preview")) return;
  const attackerInst = state.players.player.field[selectedAttacker.slot];
  if (!attackerInst) return;
  const ability = abilityById(attackerInst.card, chosenAbilityId);
  const result = computeDamage(attackerInst.card, defenderInst.card, { ability, preview: true });
  const el = document.createElement("div");
  el.className = `dmg-preview tone-${result.verdict?.tone || "normal"}${sticky ? " sticky" : ""}`;
  const willKO = result.multiplier > 0 && result.damage >= defenderInst.currentHp;
  el.innerHTML = result.multiplier === 0
    ? `<span class="dmg-num">MISS</span>`
    : `<span class="dmg-num">-${result.damage}</span>${result.verdict?.text ? `<span class="dmg-verdict">${escape(result.verdict.text)}</span>` : ""}${willKO ? `<span class="dmg-ko">KO</span>` : ""}`;
  slotEl.appendChild(el);
}
function clearDamagePreview(slotEl) {
  const el = slotEl.querySelector(".dmg-preview");
  if (el) el.remove();
}

function renderHand() {
  const hand = $("#hand");
  hand.innerHTML = "";
  const p = state.players.player;
  const n = p.hand.length;
  hand.dataset.size = String(n);
  // Spectator: hand contents aren't visible, just show a placeholder count.
  if (state.youAre === "spectator") {
    hand.innerHTML = `<div class="spectator-handcount">Player hand: ${n}</div>`;
    return;
  }
  p.hand.forEach((card, idx) => {
    const cardEl = renderCard(card);
    const cost = effectiveCost(p, card);
    cardEl.dataset.handIndex = String(idx);
    // Spells don't need a field slot — they go from hand → discard.
    // Pokémon need an empty slot OR the user must pick one to replace.
    const isSpell = card.kind === "spell";
    const playable = state.activePlayer === "player"
      && p.energy >= cost
      && (isSpell || state.players.player.field.includes(null));
    if (!playable) cardEl.classList.add("unplayable");
    // Highlight a spell card that's currently staged (pendingSpell).
    if (pendingSpell && pendingSpell.handIndex === idx) {
      cardEl.classList.add("spell-staged");
    }
    // Pulse playable cards only when we have no other clearer action.
    const hasReadyAttackers = p.field.some(
      (s) => s && !s.summoningSickness && !s.attackedThisTurn,
    );
    if (playable && !hasReadyAttackers && !selectedAttacker) {
      cardEl.classList.add("can-act");
    }
    // Fan layout — gentler curve for big hands so the central cards don't tower.
    const mid = (n - 1) / 2;
    const rel = idx - mid;
    const rotPer = n > 8 ? 2.4 : 3.5;
    const yScale = n > 8 ? 3.5 : 6;
    cardEl.style.setProperty("--fan-rot", `${rel * rotPer}deg`);
    cardEl.style.setProperty("--fan-y", `${Math.abs(rel) * yScale}px`);
    cardEl.style.setProperty("--fan-x", `${rel * 3.2}px`);
    cardEl.addEventListener("click", () => onHandCardClick(idx));
    hand.appendChild(cardEl);
  });
}

function renderLog() {
  const panel = $("#log-panel");
  if (!panel) return;
  // Keep the user's scroll position if they've manually scrolled up to
  // read earlier turns — otherwise auto-pin to the bottom so the most
  // recent line is always visible. "stickiness" tolerance is 24px.
  const scrollEl = panel;
  const wasNearBottom =
    scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 24;
  // Render up to the last 200 lines so very long matches don't explode
  // the DOM but the player can scroll back through plenty of history.
  panel.innerHTML = `<div class="log-title">Combat Log</div>` +
    state.log
      .slice(-200)
      .map((e) => `<div class="log-line tone-${e.kind}">${escape(e.text)}</div>`)
      .join("");
  if (wasNearBottom) {
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }
}

function escape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- Interaction -----------------------------------------------------------
function onHandCardClick(handIndex) {
  if (state.youAre === "spectator") return;
  if (state.activePlayer !== "player" || state.winner) {
    flashVerdict("Wait for your turn", "weak");
    return;
  }
  // Clicking a new hand card cancels any staged spell — otherwise a
  // user staging Freeze and then changing their mind to summon a
  // Pokémon would leave the spell intent dangling.
  if (pendingSpell) pendingSpell = null;
  // Touch-device peek: first tap shows the full card big so abilities are
  // legible; a second tap on the SAME card commits to playing it. Tapping
  // outside the hand cancels. Skipped on desktop.
  if (_isTouch && _peekedHandIdx !== handIndex) {
    _peekedHandIdx = handIndex;
    refreshHandPeek();
    return;
  }
  _peekedHandIdx = null;
  refreshHandPeek();
  const p = state.players.player;
  const card = p.hand[handIndex];
  if (!card) return;
  const cost = effectiveCost(p, card);
  if (p.energy < cost) {
    flashVerdict(`Need ${cost} ⚡`, "weak");
    return;
  }

  // Spell cards branch BEFORE the field-full / replace flow — they
  // don't summon, they need a target slot picked next. Stash the play
  // intent in pendingSpell and let onSlotClick resolve it.
  if (card.kind === "spell") {
    pendingSpell = { handIndex, target: card.target, name: card.name, effect: card.effect };
    selectedAttacker = null;
    chosenAbilityId = "basic";
    hideAbilityPopover();
    const prompt = card.target === "enemyField"
      ? `🎯 Tap an enemy Pokémon to ${card.effect} them`
      : card.target === "ownField"
        ? `🎯 Tap one of your Pokémon to ${card.effect} them`
        : `✨ Cast ${card.name}!`;
    flashVerdict(prompt, "super");
    // For "no target" spells (Surge, Scout, Phoenix, AOE), resolve
    // immediately — no second click needed.
    if (card.target === "none") {
      pendingSpell = null;
      if (gameMode === "mp") {
        sfxCardPlay();
        mp.playCard(handIndex, null, null);
        return;
      }
      const r = playCard(state, "player", handIndex);
      if (!r.ok) {
        flashVerdict(r.reason, "weak");
        render();
        return;
      }
      sfxCardPlay();
      const spellEv2 = spellResultToEvent(r);
      if (spellEv2) playEmote(spellEv2);
      render();
      return;
    }
    render();
    return;
  }

  if (!p.field.includes(null)) {
    // Field is full — prompt user to sacrifice one of their Pokémon.
    pendingReplace = { handIndex };
    selectedAttacker = null;
    chosenAbilityId = "basic";
    hideAbilityPopover();
    flashVerdict(`Field full — tap a Pokémon to sacrifice for ${card.name}`, "weak");
    render();
    return;
  }

  if (gameMode === "mp") {
    // Optimistic cry, server will broadcast the canonical state.
    sfxCardPlay();
    playCry(card.cry_url).catch(() => {});
    mp.playCard(handIndex);
    return;
  }

  const result = playCard(state, "player", handIndex);
  if (!result.ok) {
    flashVerdict(result.reason, "weak");
    return;
  }
  sfxCardPlay();
  playCry(card.cry_url).catch(() => {});
  render();
}

async function onSlotClick(side, slot) {
  if (state.youAre === "spectator") return;
  if (state.winner) return;
  if (state.activePlayer !== "player") {
    flashVerdict("Wait for your turn", "weak");
    return;
  }

  // Spell targeting takes priority over everything else — once a spell
  // is staged in pendingSpell, the next slot click resolves it.
  if (pendingSpell) {
    const expectsEnemy = pendingSpell.target === "enemyField";
    const expectsOwn   = pendingSpell.target === "ownField";
    if (expectsEnemy && side !== "ai") {
      flashVerdict("Tap an ENEMY Pokémon", "weak");
      return;
    }
    if (expectsOwn && side !== "player") {
      flashVerdict("Tap one of YOUR Pokémon", "weak");
      return;
    }
    const targetField = expectsEnemy ? state.players.ai.field : state.players.player.field;
    if (!targetField[slot]) {
      flashVerdict("Pick an occupied slot", "weak");
      return;
    }
    const { handIndex } = pendingSpell;
    pendingSpell = null;
    if (gameMode === "mp") {
      // Server resolves the play and broadcasts the canonical state.
      // We pass slot as spellTarget; replaceSlot stays null (spells
      // never replace a field slot).
      sfxCardPlay();
      mp.playCard(handIndex, null, slot);
      return;
    }
    const r = playCard(state, "player", handIndex, { spellTarget: slot });
    if (!r.ok) {
      flashVerdict(r.reason, "weak");
      render();
      return;
    }
    sfxCardPlay();
    const spellEv = spellResultToEvent(r);
    if (spellEv) playEmote(spellEv);
    flashVerdict(`${r.spell?.name || "Spell"} cast on ${r.targetName || "target"}!`, "super");
    render();
    return;
  }

  // Item targeting takes priority over attack targeting.
  if (pendingItem) {
    if (side !== "player") {
      flashVerdict("Tap one of YOUR Pokémon", "weak");
      return;
    }
    const inst = state.players.player.field[slot];
    if (!inst) {
      flashVerdict("Tap an occupied slot", "weak");
      return;
    }
    applyItem(pendingItem, slot);
    return;
  }

  // Replace targeting: user picked a hand card while field was full,
  // now they're choosing which Pokémon to sacrifice.
  if (pendingReplace) {
    if (side !== "player") {
      flashVerdict("Tap one of YOUR Pokémon to sacrifice", "weak");
      return;
    }
    const inst = state.players.player.field[slot];
    if (!inst) {
      flashVerdict("Tap an occupied slot to sacrifice", "weak");
      return;
    }
    const handIndex = pendingReplace.handIndex;
    pendingReplace = null;
    if (gameMode === "mp") {
      sfxCardPlay();
      mp.playCard(handIndex, slot);
      return;
    }
    const r = playCard(state, "player", handIndex, { replaceSlot: slot });
    if (!r.ok) {
      flashVerdict(r.reason, "weak");
      render();
      return;
    }
    sfxCardPlay();
    playCry(r.instance?.card?.cry_url).catch(() => {});
    render();
    return;
  }

  if (side === "player") {
    const inst = state.players.player.field[slot];
    if (!inst) return;
    if (inst.summoningSickness) {
      flashVerdict("Summoning sickness — wait a turn", "weak");
      return;
    }
    if (inst.attackedThisTurn) {
      flashVerdict("Already attacked", "weak");
      return;
    }
    selectedAttacker = { slot };
    chosenAbilityId = "basic"; // reset to basic each time you pick an attacker
    render();
    showAbilityPopover(inst);
    return;
  }

  // Clicked an enemy slot — only valid if we have a selected attacker.
  if (!selectedAttacker) return;
  const fromSlot = selectedAttacker.slot;
  const defenderInst = state.players.ai.field[slot];
  if (!defenderInst) return; // can't attack empty slot directly (use trainer button)

  if (gameMode === "mp") {
    selectedAttacker = null;
    hideAbilityPopover();
    mp.attack(fromSlot, slot, chosenAbilityId);
    chosenAbilityId = "basic";
    return;
  }

  const attackerEl = $(`.player-field .field-slot[data-slot="${fromSlot}"] .card`);
  const defenderEl = $(`.ai-field .field-slot[data-slot="${slot}"] .card`);
  const attackerInst = state.players.player.field[fromSlot];

  // Crit-timing micro-game: only on Special attacks. Tap the sweet
  // spot → forceCrit. Skipped if reduced-motion is on.
  let forceCrit = false;
  if (chosenAbilityId === "special") {
    try {
      const { runCritBar } = await import("./crit-bar.js");
      const typeColor = TYPE_COLORS[attackerInst?.card?.types?.[0]] || "#ffd166";
      const r = await runCritBar({ themeColor: typeColor });
      forceCrit = !!r?.crit;
      trackEvent("crit_bar", { crit: forceCrit });
    } catch {}
  }
  const result = attack(state, "player", fromSlot, slot, { abilityId: chosenAbilityId, forceCrit });
  if (!result.ok) {
    flashVerdict(result.reason, "weak");
    selectedAttacker = null;
    renderFields();
    return;
  }
  selectedAttacker = null;
  hideAbilityPopover();
  chosenAbilityId = "basic";
  animateHit(attackerEl, defenderEl, attackerInst, result, () => {
    render();
    if (state.winner) return;
  });
}

// Trainer face is a click target when the opposing field is empty.
function bindTrainerAttackTarget() {
  const block = $(".trainer-row.top .trainer-block.ai");
  if (!block) return;
  block.addEventListener("click", () => {
    if (state.activePlayer !== "player" || state.winner) return;
    if (!selectedAttacker) return;
    const fromSlot = selectedAttacker.slot;
    if (gameMode === "mp") {
      selectedAttacker = null;
      hideAbilityPopover();
      mp.attack(fromSlot, "trainer", chosenAbilityId);
      chosenAbilityId = "basic";
      return;
    }
    const attackerEl = $(`.player-field .field-slot[data-slot="${fromSlot}"] .card`);
    const result = attack(state, "player", fromSlot, "trainer", { abilityId: chosenAbilityId });
    if (!result.ok) {
      flashVerdict(result.reason, "weak");
      selectedAttacker = null;
      renderFields();
      return;
    }
    selectedAttacker = null;
    floatDamage(block, `-${result.damage}`, { kind: "hit" });
    fireAttackTrail(attackerEl, block, state.players.player.field[fromSlot]?.card?.types?.[0]);
    setTimeout(() => render(), 600);
  });
}

function animateHit(attackerEl, defenderEl, attackerInst, result, done) {
  const t = attackerInst?.card?.types?.[0] || "normal";
  fireAttackTrail(attackerEl, defenderEl, t);
  sfxAttack();
  setTimeout(() => {
    floatDamage(defenderEl, result.multiplier === 0 ? "MISS" : `-${result.damage}`, {
      kind: result.critical ? "crit" : result.multiplier >= 2 ? "super" : result.multiplier < 1 ? "weak" : "hit",
    });
    if (result.multiplier !== 0) {
      shakeHit(defenderEl);
      sfxHit({ supereffective: result.multiplier >= 2 });
    }
    if (result.critical) {
      sfxCrit();
      flashVerdict("CRITICAL HIT!", "super");
      if (defenderEl) defenderEl.classList.add("crit-flash");
      setTimeout(() => defenderEl?.classList.remove("crit-flash"), 700);
    } else if (result.verdict?.text) {
      flashVerdict(result.verdict.text, result.verdict.tone);
    }
    if (result.knockedOut) {
      sfxKO();
      knockOut(defenderEl).then(() => {
        if (result.attackerLeveled && attackerEl) {
          attackerEl.classList.add("leveled-up");
          setTimeout(() => attackerEl.classList.remove("leveled-up"), 850);
        }
        // Species evolution (slice 9): bigger fanfare than the
        // L-up bump because the card itself changed.
        if (result.attackerEvolved && attackerEl) {
          attackerEl.classList.add("evolving");
          const { fromName, toName } = result.attackerEvolved;
          flashVerdict(`${fromName} → ${toName}!`, "super");
          setTimeout(() => attackerEl.classList.remove("evolving"), 1400);
        } else if (result.attackerLeveled) {
          flashVerdict(`+1 HP, +1 ATK!`, "super");
        }
        done && done();
      });
    } else {
      setTimeout(() => done && done(), 350);
    }
  }, 450);
}

async function onEndTurn() {
  if (state.activePlayer !== "player" || state.winner) return;
  if (gameMode === "mp") {
    mp.endTurn();
    return;
  }
  endTurn(state);
  render();
  if (state.winner) return;
  // Stop Time consumed the AI's turn via the skipNextTurn flag inside
  // engine.endTurn — control snapped right back to the player. Don't
  // trigger aiTakeTurn in that case; otherwise the AI runs through its
  // phases (no-ops via the activePlayer guard), then ends its "turn",
  // which immediately flips control AND starts a fresh AI countdown
  // timer — exactly what Stop Time was supposed to prevent.
  if (state.activePlayer === "player") {
    flashVerdict("⏸ Opponent's turn skipped!", "super");
    return;
  }
  // Brief pause for the turn shift before the AI starts acting visibly.
  await sleep(500);
  // Drive AI turns until control returns to the player. Stop Time and
  // similar "skip the opponent's turn" effects can stack consecutive
  // AI turns — without this loop the engine would re-flip control to
  // the AI but no one would call aiTakeTurn for the new turn, leaving
  // the UI sitting on "Rival thinking…" forever. Safety cap at 4
  // consecutive AI turns so a runaway Stop Time chain can't hang the
  // tab either.
  let aiTurnsTaken = 0;
  while (
    state && state.activePlayer === "ai" && !state.winner
    && aiTurnsTaken < 4
  ) {
    await runOneAiTurn();
    aiTurnsTaken += 1;
    // If we're going around for another rep, give the player a brief
    // verdict so they understand what happened.
    if (state.activePlayer === "ai" && !state.winner && aiTurnsTaken === 1) {
      flashVerdict("Rival takes another turn!", "weak");
      await sleep(400);
    }
  }
  if (aiTurnsTaken >= 4 && state.activePlayer === "ai" && !state.winner) {
    // Catastrophic — should never happen but better to force the
    // player a turn than leave them stuck.
    console.warn("[main] AI consecutive-turn safety cap hit; force-ending");
    try { endTurn(state); } catch {}
  }
  render();
  // After AI's turn ends, control is back to us — render() picks up the
  // activePlayer flip and fires the banner via the _prevActivePlayer hook.
}

// Run a single AI turn under a 25-second hard timeout. Returns when
// either aiTakeTurn resolves OR the timeout fires + we force-end the
// turn so the player isn't locked out by a hung animation.
async function runOneAiTurn() {
  const aiPromise = aiTakeTurn(state, {
    difficulty: aiDifficulty,
    personality: aiPersonality,
    onAction: handleAiAction,
  });
  const TURN_HARD_TIMEOUT_MS = 25_000;
  const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve("__timeout__"), TURN_HARD_TIMEOUT_MS));
  try {
    const result = await Promise.race([aiPromise, timeoutPromise]);
    if (result === "__timeout__") {
      console.warn("[main] AI turn hit 25s timeout — force-ending");
      flashVerdict(gameMode === "story" ? "Boss thinking too long — your turn" : "Rival timed out", "weak");
      if (state && state.activePlayer === "ai" && !state.winner) {
        try { endTurn(state); } catch (e) { console.error("[main] timeout endTurn failed:", e); }
      }
    }
  } catch (err) {
    console.error("[main] AI turn errored:", err);
    flashVerdict("Rival fumbled — your turn", "weak");
    if (state && state.activePlayer === "ai" && !state.winner) {
      try { endTurn(state); } catch (e2) { console.error("[main] endTurn fallback failed:", e2); }
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function toggleHandLift() {
  _handLifted = !_handLifted;
  try { localStorage.setItem("pokemon-tcg-hand-lifted", _handLifted ? "1" : "0"); } catch {}
  applyHandLiftState();
}

// Honor the user's lift preference UNLESS the player can't afford any card
// in their hand right now — in which case the hand lowers automatically so
// the field stays visible. State is refreshed every render() + after each
// successful card play.
function applyHandLiftState() {
  const hand = $("#hand");
  const btn = $("#hand-toggle-btn");
  if (!hand || !state || !state.players?.player) return;
  const p = state.players.player;
  const noPlayable = p.hand.length === 0 || !p.hand.some((c) => effectiveCost(p, c) <= p.energy);
  const shouldLift = _handLifted && !noPlayable;
  hand.classList.toggle("lifted", shouldLift);
  if (btn) {
    // The label reflects the user's *preference*, not the auto-suppress
    // state — tapping it still toggles the intent.
    btn.textContent = _handLifted ? "▼ Lower hand" : "▲ Show hand";
    btn.classList.toggle("is-lifted", _handLifted);
    btn.classList.toggle("auto-lowered", _handLifted && noPlayable);
    btn.title = _handLifted && noPlayable
      ? "Hand auto-lowered — no card you can afford with current energy"
      : "Lift / lower your hand (tap to see full cards)";
  }
}

// Render N face-down "card-back" cards so the player can SEE how many cards
// the opponent is holding without being able to read them. Pokéball logo in
// the center, fanned slightly so >5 cards still fit.
function renderOpponentHand(count) {
  const n = Math.max(0, Math.min(count, 12));
  if (n === 0) return `<div class="opp-hand-empty">Rival is out of cards</div>`;
  const cards = [];
  for (let i = 0; i < n; i++) {
    // Tiny per-card variance so they don't all wobble in unison.
    const delay = (i * 0.18).toFixed(2);
    cards.push(`<div class="opp-card-back" style="animation-delay:${delay}s"></div>`);
  }
  return cards.join("");
}

// VS cinematic: two trainer portraits slam in from opposite sides, "VS"
// flashes between them, then fade out. ~2s total, async so callers can
// await before showing the mulligan modal.
async function playVsCinematic({ playerName, playerSprite, playerColor, aiName, aiSprite, aiColor, subtitle }) {
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "vs-cinematic";
    el.innerHTML = `
      <div class="vs-half left" style="--accent:${playerColor}">
        <div class="vs-portrait">${playerSprite ? `<img src="${playerSprite}" alt="">` : ""}</div>
        <div class="vs-name">${escape(playerName)}</div>
      </div>
      <div class="vs-half right" style="--accent:${aiColor}">
        <div class="vs-portrait">${aiSprite ? `<img src="${aiSprite}" alt="">` : ""}</div>
        <div class="vs-name">${escape(aiName)}</div>
        ${subtitle ? `<div class="vs-sub">${escape(subtitle)}</div>` : ""}
      </div>
      <div class="vs-logo">VS</div>
    `;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.add("fade-out");
      setTimeout(() => { el.remove(); resolve(); }, 400);
    }, 1900);
  });
}

// Rival quip system. Each AI turn has a chance to pop a short text bubble
// near the rival's avatar, themed to their personality. Lightweight — just
// flavor; no gameplay effect.
const RIVAL_TAUNTS = {
  aggressive: ["Crush them!", "More damage!", "Hesitation is defeat.", "Burn it all down."],
  balanced:   ["Calculated.", "A measured response.", "Let's see…", "Patience wins fights."],
  tactical:   ["Predictable.", "I planned for this.", "Three moves ahead.", "Your tempo is off."],
  victorious: ["Was that all?", "You played well — but not well enough.", "GG."],
  losing:     ["Not yet!", "Lucky shot.", "I won't fall here.", "Recovering…"],
};
let _lastTauntTurn = -10;
function maybeShowRivalTaunt() {
  if (!state || state.winner) return;
  if (state.turn - _lastTauntTurn < 3) return;
  if (Math.random() < 0.35) return; // don't spam
  _lastTauntTurn = state.turn;
  let bank = aiPersonality && RIVAL_TAUNTS[aiPersonality] || RIVAL_TAUNTS.balanced;
  const aiHp = state.players.ai.trainerHp;
  const playerHp = state.players.player.trainerHp;
  if (aiHp > 0 && playerHp / Math.max(1, aiHp) < 0.5) bank = RIVAL_TAUNTS.victorious;
  else if (aiHp / Math.max(1, playerHp) < 0.4) bank = RIVAL_TAUNTS.losing;
  const line = bank[Math.floor(Math.random() * bank.length)];
  showRivalBubble(line);
}
function showRivalBubble(text) {
  const anchor = document.querySelector(".trainer-row.top .trainer-block.ai")
              || document.querySelector(".trainer-row.top .trainer-block")
              || document.querySelector(".ai-field");
  document.querySelectorAll(".rival-bubble").forEach((b) => b.remove());
  const el = document.createElement("div");
  el.className = "rival-bubble";
  el.textContent = text;
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    el.style.top = `${rect.bottom + 8}px`;
    el.style.left = `${rect.left + rect.width / 2}px`;
    el.style.transform = `translateX(-50%)`;
  } else {
    el.style.top = "80px"; el.style.left = "50%"; el.style.transform = "translateX(-50%)";
  }
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 350);
  }, 1800);
}

async function handleAiAction(action) {
  try {
    await handleAiActionInner(action);
  } catch (err) {
    // Animation errors must never escape into aiTakeTurn — otherwise the AI
    // turn aborts without calling endTurn(). Swallow + log + keep going.
    console.error("[handleAiAction] animation error (recovered):", err);
  }
}
async function handleAiActionInner(action) {
  if (state.winner) return;
  // Surface a personality quip occasionally — once per turn at most.
  if (action.kind === "summon" || action.kind === "attack") maybeShowRivalTaunt();
  if (action.kind === "item") {
    render();
    const icon = ({ potion: "🧪", energy: "💎", switch: "🔄", revive: "✨", luckyDraw: "🎴" })[action.itemId] || "🎁";
    flashVerdict(`Rival used ${icon}`, "weak");
    await sleep(700);
    return;
  }
  if (action.kind === "summon") {
    render();
    // Flash the freshly-summoned slot + play the cry so it feels like a move
    // by a real opponent, not just state appearing.
    const slot = $(`.ai-field .field-slot[data-slot="${action.slot}"] .card`);
    if (slot) {
      slot.classList.add("ai-just-summoned");
      setTimeout(() => slot.classList.remove("ai-just-summoned"), 900);
    }
    sfxCardPlay();
    if (action.instance?.card?.cry_url) playCry(action.instance.card.cry_url).catch(() => {});
    await sleep(800);
    return;
  }
  if (action.kind === "attack") {
    render();
    const r = action.result;
    if (!r?.ok) { await sleep(200); return; }
    const attackerEl = $(`.ai-field .field-slot[data-slot="${action.fromSlot}"] .card`);
    let defenderEl;
    if (action.target === "trainer") {
      defenderEl = $(".trainer-row.bottom .trainer-block.player") || $(".trainer-row.bottom .trainer-block");
    } else {
      defenderEl = $(`.player-field .field-slot[data-slot="${action.target}"] .card`);
    }
    const aType = action.attackerCard?.types?.[0] || "normal";
    fireAttackTrail(attackerEl, defenderEl, aType);
    sfxAttack();
    await sleep(450);
    if (defenderEl) {
      floatDamage(defenderEl, r.multiplier === 0 ? "MISS" : `-${r.damage}`, {
        kind: r.critical ? "crit" : r.multiplier >= 2 ? "super" : r.multiplier < 1 ? "weak" : "hit",
      });
      if (r.multiplier !== 0) {
        shakeHit(defenderEl);
        sfxHit({ supereffective: r.multiplier >= 2 });
      }
      if (r.critical) {
        sfxCrit();
        flashVerdict("CRITICAL!", "super");
        defenderEl.classList.add("crit-flash");
        setTimeout(() => defenderEl.classList.remove("crit-flash"), 700);
      } else if (r.verdict?.text) {
        flashVerdict(r.verdict.text, r.verdict.tone);
      }
    }
    if (r.knockedOut) {
      sfxKO();
      await knockOut(defenderEl);
      if (r.attackerLeveled && attackerEl) {
        attackerEl.classList.add("leveled-up");
        flashVerdict(`Rival's ${action.attackerCard?.name || "Pokémon"} evolved!`, "weak");
        await sleep(800);
        attackerEl.classList.remove("leveled-up");
      }
    } else {
      await sleep(500);
    }
    return;
  }
}

// Resolve the player's deck:
//   - signed in with an active saved deck → use it
//   - otherwise → random 30-card draft from /api/deck
async function loadPlayerDeck() {
  if (!currentUser) return fetchDeck();
  try {
    const res = await fetch("/me/decks/active");
    if (!res.ok) return fetchDeck();
    const { deck } = await res.json();
    if (!deck) return fetchDeck();
    const hres = await fetch(`/me/decks/${deck.id}/hydrate`);
    if (!hres.ok) return fetchDeck();
    const { deck: hydrated } = await hres.json();
    if (!hydrated?.cards?.length) return fetchDeck();
    return hydrated.cards;
  } catch {
    return fetchDeck();
  }
}

// --- Account panel ---------------------------------------------------------
function renderAccountPanel() {
  if (currentUser) {
    return `
      <div class="account-panel signed-in">
        <div class="account-id">
          <span class="account-greeting">Signed in as</span>
          <strong>${escape(currentUser.display_name)}</strong>
          <div class="trainer-level-chip" id="trainer-level-chip"></div>
        </div>
        <div class="account-actions">
          <button id="account-collection-btn">Collection</button>
          <button id="account-pokedex-btn">Pokédex</button>
          <button id="account-achievements-btn">Achievements</button>
          <button id="account-matches-btn">History</button>
          <button id="account-leaderboard-btn">Leaderboard</button>
          <button id="account-logout-btn">Sign out</button>
        </div>
      </div>
    `;
  }
  return `
    <div class="account-panel signed-out">
      <div class="account-id">
        <span class="account-greeting">Playing as guest</span>
        <span class="account-sub">Sign in to save stats and earn cards</span>
      </div>
      <div class="account-actions">
        <button id="account-leaderboard-btn">Leaderboard</button>
        <button id="account-signin-btn">Sign in</button>
        <button id="account-register-btn" class="primary">Create account</button>
      </div>
    </div>
  `;
}

function wireAccountPanel() {
  const $signin = $("#account-signin-btn");
  if ($signin) $signin.addEventListener("click", onSignIn);
  const $register = $("#account-register-btn");
  if ($register) $register.addEventListener("click", onRegister);
  const $logout = $("#account-logout-btn");
  if ($logout) $logout.addEventListener("click", onLogout);
  const $collection = $("#account-collection-btn");
  if ($collection) $collection.addEventListener("click", () => {
    deckBuilder.open({ onClose: () => {} });
  });
  const $leaderboard = $("#account-leaderboard-btn");
  if ($leaderboard) $leaderboard.addEventListener("click", () => {
    leaderboard.open({ onClose: () => {} });
  });
  const $ach = $("#account-achievements-btn");
  if ($ach) $ach.addEventListener("click", () => {
    achievements.openAchievements({ onClose: () => {} });
  });
  const $mh = $("#account-matches-btn");
  if ($mh) $mh.addEventListener("click", () => {
    achievements.openMatchHistory({ onClose: () => {} });
  });
  const $pdx = $("#account-pokedex-btn");
  if ($pdx) $pdx.addEventListener("click", () => pokedex.open());
}

function onRegister() {
  if (!passkey.isSupported()) {
    alert("Passkeys aren't supported on this browser. Try Safari, Chrome, or Edge.");
    return;
  }
  // Use a custom modal instead of prompt() — on mobile, prompt() can break
  // the user-gesture chain that WebAuthn requires for credentials.create(),
  // producing "document not focused" / NotAllowedError. The modal's submit
  // button is the gesture that triggers the WebAuthn ceremony.
  showAuthModal({
    title: "Create account",
    submitLabel: "Create",
    placeholder: "Trainer name (2-32 chars)",
    onSubmit: async (name) => {
      const displayName = name.trim();
      if (displayName.length < 2) return "Name must be at least 2 chars.";
      try {
        const user = await passkey.register(displayName);
        currentUser = user;
        flashVerdict(`Welcome, ${user.display_name}!`, "super");
        renderMenu();
        return null;
      } catch (err) {
        return err.message || "Sign up failed.";
      }
    },
  });
}

function onSignIn() {
  if (!passkey.isSupported()) {
    alert("Passkeys aren't supported on this browser.");
    return;
  }
  showAuthModal({
    title: "Sign in",
    submitLabel: "Continue",
    placeholder: "Trainer name (optional)",
    helpText: "Leave blank to use any passkey saved on this device.",
    optional: true,
    onSubmit: async (name) => {
      try {
        const user = await passkey.login(name?.trim() || "");
        currentUser = user;
        flashVerdict(`Welcome back, ${user.display_name}`, "super");
        renderMenu();
        return null;
      } catch (err) {
        return err.message || "Sign-in failed.";
      }
    },
  });
}

function showAuthModal({ title, submitLabel, placeholder, helpText, optional, onSubmit }) {
  // Tear down any prior auth modal.
  document.querySelector(".auth-modal")?.remove();
  const m = document.createElement("div");
  m.className = "auth-modal";
  m.innerHTML = `
    <div class="auth-card">
      <div class="auth-title">${escape(title)}</div>
      <input class="auth-input" type="text" autocomplete="username webauthn"
             maxlength="32" placeholder="${escape(placeholder || "")}" />
      ${helpText ? `<div class="auth-help">${escape(helpText)}</div>` : ""}
      <div class="auth-err" style="display:none"></div>
      <div class="auth-row">
        <button class="auth-cancel">Cancel</button>
        <button class="auth-submit primary">${escape(submitLabel)}</button>
      </div>
    </div>
  `;
  document.body.appendChild(m);
  const input = m.querySelector(".auth-input");
  const errEl = m.querySelector(".auth-err");
  const submit = m.querySelector(".auth-submit");
  const cancel = m.querySelector(".auth-cancel");
  setTimeout(() => input.focus(), 30);

  // Test-only fast path: if Playwright/an automation tool sets
  // window.__autoFillName, auto-fill and submit so the existing scripts that
  // used window.prompt = () => name still work end-to-end.
  if (typeof window.__autoFillName === "string") {
    input.value = window.__autoFillName;
    setTimeout(() => submit.click(), 50);
  }

  async function go() {
    const val = input.value;
    if (!optional && !val.trim()) {
      errEl.style.display = "block";
      errEl.textContent = "Please enter a name.";
      return;
    }
    submit.disabled = true;
    submit.textContent = "Working…";
    const err = await onSubmit(val);
    if (err) {
      errEl.style.display = "block";
      errEl.textContent = err;
      submit.disabled = false;
      submit.textContent = submitLabel;
    } else {
      m.remove();
    }
  }

  submit.addEventListener("click", go);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  cancel.addEventListener("click", () => m.remove());
}

async function onLogout() {
  await passkey.logout();
  currentUser = null;
  renderMenu();
}

// --- Multiplayer entry ------------------------------------------------------

let mpUnsubs = [];
function teardownMpListeners() {
  for (const off of mpUnsubs) try { off(); } catch {}
  mpUnsubs = [];
}

// Mulligan modal — opens at the start of a solo match. Lets the player pick
// up to 3 starting-hand cards to swap back into the deck. Returns a promise
// that resolves when the user confirms.
function openMulliganModal() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "mulligan-overlay";
    const hand = state.players.player.hand;
    overlay.innerHTML = `
      <div class="mulligan-card">
        <div class="mulligan-title">Mulligan</div>
        <div class="mulligan-sub">Tap up to 3 cards to swap back into the deck. They'll be replaced with random draws.</div>
        <div class="mulligan-hand"></div>
        <div class="mulligan-row">
          <span class="mulligan-count">0 / 3 selected</span>
          <button class="mulligan-confirm primary">Keep this hand</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const handEl = overlay.querySelector(".mulligan-hand");
    const countEl = overlay.querySelector(".mulligan-count");
    const confirm = overlay.querySelector(".mulligan-confirm");
    const selected = new Set();
    hand.forEach((card, idx) => {
      const wrap = document.createElement("div");
      wrap.className = "mulligan-pick";
      const cardEl = renderCard(card);
      wrap.appendChild(cardEl);
      const cross = document.createElement("div");
      cross.className = "mulligan-x";
      cross.textContent = "✕";
      wrap.appendChild(cross);
      wrap.addEventListener("click", () => {
        if (selected.has(idx)) {
          selected.delete(idx);
          wrap.classList.remove("selected");
        } else {
          if (selected.size >= 3) {
            flashVerdict("Max 3 swaps", "weak");
            return;
          }
          selected.add(idx);
          wrap.classList.add("selected");
        }
        countEl.textContent = `${selected.size} / 3 selected`;
        confirm.textContent = selected.size === 0 ? "Keep this hand" : `Swap ${selected.size} and play`;
      });
      handEl.appendChild(wrap);
    });
    confirm.addEventListener("click", () => {
      if (selected.size > 0) mulliganHand(state, "player", [...selected]);
      overlay.remove();
      resolve();
    });
  });
}

// Spectator mode — read-only watch of any match by id. Polls /api/mp/spectate.
let _spectatorTimer = null;
let _spectatorVersion = 0;
async function startSpectator(matchId) {
  gameMode = "spectator";
  state = null;
  $("#menu").classList.add("hidden");
  $("#arena").classList.remove("hidden");
  document.body.classList.add("in-arena");
  startBGM();
  flashVerdict("Spectating — read-only", "super");
  const poll = async () => {
    try {
      const r = await fetch(`/api/mp/spectate/${matchId}?since=${_spectatorVersion}`);
      if (r.status === 204) return;
      if (!r.ok) {
        stopSpectator();
        alert("Match ended or not found.");
        renderMenu();
        return;
      }
      const data = await r.json();
      if (!data.view) return;
      _spectatorVersion = data.view.v;
      state = data.view;
      // Render reuses the existing path. Player side is fixed to the player
      // half of the field; AI side to the AI half. Hands hidden both ways.
      render();
      if (state.winner) {
        stopSpectator();
      }
    } catch {}
  };
  await poll();
  _spectatorTimer = setInterval(poll, 1500);
}
function stopSpectator() {
  if (_spectatorTimer) clearInterval(_spectatorTimer);
  _spectatorTimer = null;
  _spectatorVersion = 0;
}

async function startMultiplayer({ mode }) {
  if (!chosenTrainer) {
    flashVerdict("Pick a trainer first", "weak");
    return;
  }
  // Render the spinner immediately so the UI shows activity while we
  // connect (the socket handshake can take a beat on serverless hosts).
  if (mode === "queue") showMatchmakingModal({ kind: "queue" });
  else if (mode === "friend") showMatchmakingModal({ kind: "friend-choose" });

  try {
    await mp.connect();
  } catch (err) {
    closeMatchmakingModal();
    alert("Couldn't reach the match server: " + (err.message || "unknown"));
    return;
  }
  teardownMpListeners();
  mpUnsubs.push(mp.onStateUpdate(handleMpState));
  mpUnsubs.push(mp.onAnimation(handleMpAnim));
  mpUnsubs.push(mp.onGameOver(handleMpGameOver));
  mpUnsubs.push(mp.onMatchFound((m) => { mpOpponent = m.opponent || null; }));
  mpUnsubs.push(mp.onError((e) => flashVerdict(e.error || "error", "weak")));
  mpUnsubs.push(mp.onQueueWaiting(() => showMatchmakingModal({ kind: "queue" })));
  mpUnsubs.push(mp.onRoomCreated((r) => showMatchmakingModal({ kind: "host", code: r.code })));

  const opts = {
    userId: currentUser?.id || null,
    displayName: currentUser?.display_name || `Guest-${Math.random().toString(36).slice(2, 6)}`,
    ability: chosenTrainer,
    deckSource: currentUser ? "active" : "random",
  };

  if (mode === "queue") {
    mp.findMatch(opts);
  } else if (mode === "friend") {
    // The modal lets the user choose host or join, then triggers
    // mp.createPrivateRoom or mp.joinPrivateRoom with `opts`.
    document.body.addEventListener("mpFriendHost", () => mp.createPrivateRoom(opts), { once: true });
    document.body.addEventListener("mpFriendJoin", (e) => mp.joinPrivateRoom(e.detail.code, opts), { once: true });
  }
}

function showMatchmakingModal({ kind, code }) {
  let modal = document.querySelector(".mm-overlay");
  if (!modal) {
    modal = document.createElement("div");
    modal.className = "mm-overlay";
    document.body.appendChild(modal);
  }
  let body = "";
  if (kind === "queue") {
    body = `
      <div class="mm-title">Searching for opponent…</div>
      <div class="mm-spinner"></div>
      <div class="mm-hint">Tell a friend to also click "Find online match" and you'll be paired.</div>
      <button class="mm-cancel">Cancel</button>
    `;
  } else if (kind === "host") {
    const joinUrl = `${location.origin}/?code=${encodeURIComponent(code)}`;
    body = `
      <div class="mm-title">Share this with a friend</div>
      <div class="mm-code">${code}</div>
      <div class="mm-qr" id="mm-qr"></div>
      <div class="mm-hint">
        Have them tap <strong>Play vs friend → Join</strong> and enter this code,<br>
        or scan the QR with their phone camera.
      </div>
      <div class="mm-share">
        <button class="mm-copy" data-text="${escape(code)}">Copy code</button>
        <button class="mm-copy" data-text="${escape(joinUrl)}">Copy link</button>
      </div>
      <button class="mm-cancel">Cancel</button>
    `;
  } else if (kind === "friend-choose") {
    body = `
      <div class="mm-title">Play vs friend</div>
      <div class="mm-row">
        <button class="mm-action" id="mm-host-btn">Host (get a code)</button>
        <div class="mm-or">— or —</div>
        <div class="mm-join">
          <input type="text" id="mm-code-input" placeholder="A2X4F9" maxlength="6">
          <button class="mm-action" id="mm-join-btn">Join</button>
        </div>
      </div>
      <button class="mm-cancel">Cancel</button>
    `;
  }
  modal.innerHTML = `<div class="mm-card">${body}</div>`;

  // QR code for the host modal (built using the qrcode-generator script
  // already bundled in index.html as `window.qrcode`).
  if (kind === "host" && typeof window.qrcode === "function") {
    const joinUrl = `${location.origin}/?code=${encodeURIComponent(code)}`;
    const qr = window.qrcode(0, "M");
    qr.addData(joinUrl);
    qr.make();
    const wrap = modal.querySelector("#mm-qr");
    if (wrap) {
      wrap.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 });
      const svg = wrap.querySelector("svg");
      if (svg) {
        svg.setAttribute("width", "140");
        svg.setAttribute("height", "140");
      }
    }
  }

  // Copy buttons for the host modal.
  modal.querySelectorAll(".mm-copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const txt = btn.dataset.text;
      try {
        await navigator.clipboard.writeText(txt);
        const orig = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = orig), 1200);
      } catch {
        // Clipboard may be unavailable; show a hint instead
        flashVerdict("Couldn't copy — long-press to select", "weak");
      }
    });
  });

  modal.querySelector(".mm-cancel")?.addEventListener("click", () => {
    mp.cancelMatch();
    closeMatchmakingModal();
  });
  modal.querySelector("#mm-host-btn")?.addEventListener("click", () => {
    document.body.dispatchEvent(new CustomEvent("mpFriendHost"));
  });
  modal.querySelector("#mm-join-btn")?.addEventListener("click", () => {
    const code = document.getElementById("mm-code-input").value.trim().toUpperCase();
    if (!code || code.length !== 6) {
      flashVerdict("Enter a 6-char code", "weak");
      return;
    }
    document.body.dispatchEvent(new CustomEvent("mpFriendJoin", { detail: { code } }));
  });
}

function closeMatchmakingModal() {
  document.querySelector(".mm-overlay")?.remove();
}

function handleMpState(serverState) {
  const isFirst = state == null;
  state = serverState;
  if (isFirst) {
    _prevHps = { player: null, ai: null };
    _prevEnergy = null;
  }
  closeMatchmakingModal();
  gameMode = "mp";
  // Reuse the existing render() path. The state shape matches what the engine
  // produces (perspective normalized by the server).
  $("#menu").classList.add("hidden");
  $("#arena").classList.remove("hidden");
  document.body.classList.add("in-arena");
  startBGM();
  render();
}

function handleMpAnim(anim) {
  // Drives visuals for any action — yours or your opponent's. The server
  // ships anim.side flipped into our POV: "player" = us, "ai" = them.
  const isOpp = anim.side === "ai";
  if (anim.kind === "summon") {
    const sel = isOpp ? ".ai-field" : ".player-field";
    const slotEl = $(`${sel} .field-slot[data-slot="${anim.slot}"] .card`);
    if (slotEl) {
      slotEl.classList.add("ai-just-summoned");
      setTimeout(() => slotEl.classList.remove("ai-just-summoned"), 900);
    }
    if (isOpp) sfxCardPlay(); // local already played its own
    return;
  }
  if (anim.kind === "attack") {
    const attackerEl = isOpp
      ? $(`.ai-field .field-slot[data-slot="${anim.fromSlot}"] .card`)
      : $(`.player-field .field-slot[data-slot="${anim.fromSlot}"] .card`);
    let defenderEl;
    if (anim.target === "trainer") {
      defenderEl = isOpp
        ? ($(".trainer-row.bottom .trainer-block.player") || $(".trainer-row.bottom .trainer-block"))
        : $(".trainer-block.ai");
    } else {
      defenderEl = isOpp
        ? $(`.player-field .field-slot[data-slot="${anim.target}"] .card`)
        : $(`.ai-field .field-slot[data-slot="${anim.target}"] .card`);
    }
    fireAttackTrail(attackerEl, defenderEl, anim.attackerType || "normal");
    sfxAttack();
    if (defenderEl) {
      floatDamage(defenderEl, anim.multiplier === 0 ? "MISS" : `-${anim.damage}`, {
        kind: anim.critical ? "crit" : anim.multiplier >= 2 ? "super" : anim.multiplier < 1 ? "weak" : "hit",
      });
      if (anim.multiplier !== 0) {
        shakeHit(defenderEl);
        sfxHit({ supereffective: anim.multiplier >= 2 });
      }
      if (anim.critical) {
        sfxCrit();
        defenderEl.classList.add("crit-flash");
        setTimeout(() => defenderEl.classList.remove("crit-flash"), 700);
      }
    }
    if (anim.knockedOut) sfxKO();
    if (anim.critical) flashVerdict("CRITICAL HIT!", "super");
    else if (anim.verdict?.text) flashVerdict(anim.verdict.text, anim.verdict.tone);
    if (anim.attackerLeveled && attackerEl) {
      attackerEl.classList.add("leveled-up");
      flashVerdict(isOpp ? "Rival's Pokémon evolved!" : `Evolved! L${anim.attackerLeveled}`, isOpp ? "weak" : "super");
      setTimeout(() => attackerEl.classList.remove("leveled-up"), 850);
    }
    return;
  }
  if (anim.kind === "item") {
    const icon = ({ potion: "🧪", energy: "💎", switch: "🔄", revive: "✨", luckyDraw: "🎴" })[anim.itemId] || "🎁";
    flashVerdict(`${isOpp ? "Rival used" : "Used"} ${icon}`, isOpp ? "weak" : "super");
    return;
  }
}

// Turn-timer ticker — updates the countdown element every 250ms. Auto-ends
// the player's turn when the deadline passes.
let _turnTimerHandle = null;
function startTurnTimer() {
  stopTurnTimer();
  const el = $("#turn-timer");
  if (!el || !state || state.winner || !state.turnEndsAt) return;
  const update = () => {
    if (!state || state.winner) { stopTurnTimer(); return; }
    const left = state.turnEndsAt - Date.now();
    if (left <= 0) {
      el.textContent = "0:00";
      el.classList.add("expired");
      if (state.activePlayer === "player" && !state.winner) {
        stopTurnTimer();
        onEndTurn();
        return;
      }
      // AI-side watchdog: if the rival's turn timer has been expired for
      // more than 8 seconds, assume something jammed and force end the
      // turn. Covers solo + story (boss fights) + champion battles —
      // anything where the engine runs client-side. Multiplayer is
      // server-authoritative, so we skip the watchdog there.
      const isLocalAi = gameMode === "solo" || gameMode === "story";
      if (state.activePlayer === "ai" && isLocalAi && left < -8_000) {
        console.warn("[watchdog] AI turn hung past timer — forcing end-turn");
        try { endTurn(state); } catch (e) { console.error("[watchdog] endTurn failed:", e); }
        stopTurnTimer();
        render();
        flashVerdict(gameMode === "story" ? "Boss skipped a turn — fight on" : "Rival ran out of time", "weak");
        return;
      }
      return;
    }
    const secs = Math.ceil(left / 1000);
    el.textContent = `0:${String(secs).padStart(2, "0")}`;
    el.classList.toggle("urgent", left < 10_000);
    el.classList.toggle("crit-time", left < 5_000);
  };
  update();
  _turnTimerHandle = setInterval(update, 250);
}
function stopTurnTimer() {
  if (_turnTimerHandle) clearInterval(_turnTimerHandle);
  _turnTimerHandle = null;
}

// "Your turn" cue — large banner + chime when control flips back to you.
function showYourTurnBanner() {
  sfxYourTurn();
  document.querySelector(".your-turn-banner")?.remove();
  const el = document.createElement("div");
  el.className = "your-turn-banner";
  el.textContent = "YOUR TURN";
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 350);
  }, 1100);
}

// Red-vignette pulse from the screen edges. Fired whenever the player's
// trainer HP drops so trainer-targeted attacks + time-pressure ticks
// can't be missed. `heavy=true` for big-damage hits + KOs.
function triggerPlayerHitVignette(heavy = false) {
  document.querySelectorAll(".player-hit-vignette").forEach((n) => n.remove());
  const v = document.createElement("div");
  v.className = "player-hit-vignette" + (heavy ? " heavy" : "");
  document.body.appendChild(v);
  setTimeout(() => v.remove(), heavy ? 950 : 650);
}

function handleMpGameOver(over) {
  // The state update with winner already triggered onGameOver via render().
  // Stash the reward offer so the "Play again" overlay can show it.
  if (over.reward) {
    setTimeout(() => {
      rewards.showOffer(over.reward, {
        didWin: over.youWin,
        onClaim: (card) => {
          if (card) flashVerdict(`+${card.name}!`, "super");
        },
      });
    }, 400);
  }
}

// One-shot guard. render() calls onGameOver() every time it sees a
// state.winner, but the game-over overlay (with the Play Again button)
// must mount only once — otherwise repeated calls stack overlays and
// the Play Again click hits a buried (older) button instead of the
// visible one. Reset to false at every match start via createGame.
let _gameOverFired = false;
function onGameOver() {
  if (_gameOverFired) return;
  _gameOverFired = true;
  stopBGM();
  stopTurnTimer();
  const wasFirstMatch = !!state._isFirstMatch;
  const isFirstWin = state.winner === "player" && !hasWonBefore();
  markHasPlayed();
  if (state.winner === "player") {
    markHasWon();
    sfxVictory();
    // Juiced first-win moment: extra confetti + bigger fanfare. The
    // regular game-over overlay still shows below; this is an extra
    // celebration layer on top.
    if (isFirstWin || wasFirstMatch) {
      celebrateFirstWin();
      trackEvent("first_win");
    }
    // Anonymous players accumulate a small collection in localStorage
    // — one random Pokémon from the rival's deck per win. On signup
    // this state migrates into their real account via the existing
    // /me/migrate-guest endpoint.
    if (!currentUser) {
      try {
        import("./guest-state.js").then((g) => {
          const aiDeck = state.players?.ai?.discard || [];
          const allCards = aiDeck.concat(state.players.ai?.field?.filter(Boolean).map((i) => i?.card) || []);
          const winFromDeck = allCards.filter(Boolean);
          if (winFromDeck.length) {
            const pick = winFromDeck[Math.floor(Math.random() * winFromDeck.length)];
            if (pick?.id) g.addCard(pick.id);
          }
        }).catch(() => {});
      } catch {}
    }
  } else {
    sfxDefeat();
  }
  // Grant XP based on outcome (signed-in users only).
  if (currentUser) {
    const myKOs = state.players.ai.discard.length;   // we KO'd these
    const myRecap = state.recap?.player || {};
    grantXp({
      won: state.winner === "player",
      kos: myKOs,
      crits: myRecap.crits || 0,
    });
    // Submit per-match highlight stats so the in-match achievements (biggest
    // hit, crit master, rampage, perfect victory, lightning/endurance win)
    // can unlock. Best-effort — failures are silent.
    const matchStats = {
      biggestHit: myRecap.biggestHit || 0,
      crits: myRecap.crits || 0,
      kos: myKOs,
      perfectVictory: state.winner === "player" && state.players.player.trainerHp === TRAINER_START_HP,
      lightningWin:   state.winner === "player" && state.turn <= 8,
      enduranceWin:   state.winner === "player" && state.turn >= 25,
    };
    fetch("/me/match-stats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(matchStats),
    }).catch(() => {});
    setTimeout(() => achievements.checkForNewUnlocks(), 1500);
  }
  // Card Mastery: post per-Pokémon kill tallies from this match.
  // Server returns level-up info; we surface a quick "★ Mastery
  // levelled up" verdict for any cards that crossed a threshold.
  if (currentUser) {
    const kos = state.recap?.player?.kosByPokemonId || {};
    if (Object.keys(kos).length) {
      fetch("/me/mastery/bump", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kos }),
      }).then((r) => r.ok ? r.json() : null).then((data) => {
        if (!data?.updated) return;
        const levelups = Object.entries(data.updated)
          .filter(([, info]) => info.leveledUp);
        for (const [, info] of levelups) {
          setTimeout(() => flashVerdict(`★ Mastery L${info.level} reached`, "super"), 1400);
          trackEvent("mastery_levelup", { level: info.level });
        }
      }).catch(() => {});
    }
  }
  // Friend-challenge result — POST back to the deck-code owner's
  // inbox if this match was launched via /v/<code>. Best-effort,
  // anonymous-friendly.
  if (state._versusCode) {
    const anonId = (() => {
      try { return localStorage.getItem("pokemon-tcg-anon-id") || null; } catch { return null; }
    })();
    fetch(`/api/deck-code/${encodeURIComponent(state._versusCode)}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        won: state.winner === "player",
        turns: state.turn,
        hpLeft: state.players.player.trainerHp,
        anonId,
        challengerName: currentUser?.display_name || "Anonymous Trainer",
      }),
    }).then((r) => r.ok && trackEvent("versus_result_posted", { won: state.winner === "player" }))
      .catch(() => {});
  }
  // Win-streak tracking for solo / champion / story matches.  MP skips
  // (server-authoritative + would let one player tank a streak rival).
  if (currentUser && (gameMode === "solo" || gameMode === "story")) {
    const result = state.winner === "player" ? "win" : "loss";
    fetch("/me/winstreak/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result }),
    }).then((r) => r.ok ? r.json() : null).then((data) => {
      if (!data) return;
      // Surface the new streak number + label.  Crossing a milestone
      // gets a big banner; non-milestone wins get a quieter pip update.
      if (data.milestoneLabel && data.previousStreak < data.streak) {
        const intensity = data.milestone === "legendary" ? "legendary"
                       : data.milestone === "blazing" ? "blazing"
                       : "fire";
        flashStreakBanner(data.milestoneLabel, data.streak, intensity);
        trackEvent("winstreak_milestone", { streak: data.streak, tag: data.milestone });
      } else if (data.streak >= 2) {
        flashVerdict(`🔥 Streak ${data.streak}`, "super");
      }
      // Bonus card drop on threshold cross.
      if (data.bonus) {
        setTimeout(() => {
          rewards.showOffer({
            offerId: data.bonus.offerId,
            picks: data.bonus.picks,
          }, {
            didWin: true,
            onClaim: (card) => { if (card) flashVerdict(`+${card.name}! (streak bonus)`, "super"); },
          });
        }, 1800); // let the milestone banner play first
      }
    }).catch(() => {});
  }
  // Daily boss outcome → finishDaily + share dialog (highest viral leverage).
  // Fires INSTEAD of the regular story-chapter reward flow but still falls
  // through to the regular game-over overlay so the player has a Play
  // Again / Back-to-Menu button. Previously this branch returned early,
  // leaving the user stranded on the post-game board.
  const isDailyBoss = gameMode === "story" && _storyContext?.daily;
  if (isDailyBoss) {
    const won = state.winner === "player";
    const result = {
      sessionId: _storyContext.sessionId,
      won,
      turns: state.turn,
      hpLeft: state.players.player.trainerHp,
      kos: state.players.ai.discard.length,
    };
    daily.finishDaily(result).then((data) => {
      trackEvent("daily_finished", { won, turns: result.turns });
      if (data) setTimeout(() => daily.showShareDialog(data), 1200);
      // Quest counters were just bumped server-side; refresh the panel
      // so a "Back to menu" click finds fresh numbers.
      try { loadAndRenderQuests?.(); } catch {}
    }).catch(() => {});
  }
  // Story chapter: post outcome → roll reward → record progress.
  // Daily-boss already handled above; don't double-fire here.
  if (!isDailyBoss && gameMode === "story" && _storyContext) {
    const won = state.winner === "player";
    story.finishChapter({
      sessionId: _storyContext.sessionId,
      won,
      chapterId: _storyContext.chapterId,
      kos: state.players.ai.discard.length,
    }).then((reward) => {
      if (reward) {
        rewards.showOffer(reward, {
          didWin: true,
          onClaim: (card) => { if (card) flashVerdict(`+${card.name}!`, "super"); },
        });
      } else if (won) {
        flashVerdict("Chapter cleared!", "super");
      }
      // Server has now persisted bumpDailyStats — refresh the quest panel
      // so progress bars update without a manual page reload.
      try { loadAndRenderQuests?.(); } catch {}
    }).catch(() => {});
  }
  // In solo mode, finalise the server-tracked session and ask for a reward.
  if (gameMode === "solo" && currentUser && soloSessionId) {
    fetch("/me/solo/end", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: soloSessionId,
        won: state.winner === "player",
        championId: _championId || null,
        kos: state.players.ai.discard.length,
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.reward) {
          rewards.showOffer(data.reward, {
            didWin: state.winner === "player",
            onClaim: (card) => { if (card) flashVerdict(`+${card.name}!`, "super"); },
          });
        }
        // Refresh quests now that bumpDailyStats has persisted — otherwise
        // Play Again → renderMenu races the write and shows stale counts.
        try { loadAndRenderQuests?.(); } catch {}
      })
      .catch(() => {});
    soloSessionId = null;
  }

  const overlay = document.createElement("div");
  overlay.className = "game-over";
  const myKOs = state.players.ai.discard.length;     // we KO'd these of theirs
  const oppKOs = state.players.player.discard.length;
  const myHpLeft = state.players.player.trainerHp;
  const oppHpLeft = state.players.ai.trainerHp;
  const recap = state.recap || { player: {}, ai: {} };
  const my = recap.player || {};
  // Earned badges — pure flavour, drive replay urge.
  const badges = [];
  if (state.winner === "player") {
    if (myHpLeft === TRAINER_START_HP) badges.push({ key: "perfect", label: "PERFECT VICTORY", desc: "Won without taking a single point of damage." });
    else if (myHpLeft >= TRAINER_START_HP - 3) badges.push({ key: "untouchable", label: "UNTOUCHABLE", desc: "Won with nearly full HP." });
    if (state.turn <= 8) badges.push({ key: "lightning", label: "LIGHTNING WIN", desc: `Closed it out in ${state.turn} turns.` });
    if (state.turn >= 25) badges.push({ key: "endurance", label: "ENDURANCE", desc: `A ${state.turn}-turn grind — and you won.` });
    if ((my.crits || 0) >= 3) badges.push({ key: "crit-chain", label: "CRIT MASTER", desc: `${my.crits} critical hits in one match.` });
    if (myKOs >= 5) badges.push({ key: "rampage", label: "RAMPAGE", desc: `KO'd ${myKOs} of the rival's Pokémon.` });
  } else {
    if (state.turn >= 20) badges.push({ key: "valiant", label: "VALIANT EFFORT", desc: `Held out for ${state.turn} turns.` });
    if ((my.biggestHit || 0) >= 12) badges.push({ key: "punisher", label: "HEAVY HITTER", desc: `Landed a ${my.biggestHit}-damage strike.` });
  }
  const badgesHtml = badges.length ? `
    <div class="go-badges">
      ${badges.map((b) => `
        <div class="go-badge go-badge-${b.key}">
          <div class="go-badge-label">${b.label}</div>
          <div class="go-badge-desc">${escape(b.desc)}</div>
        </div>`).join("")}
    </div>` : "";
  const isTie = state.winner === "tie";
  const goClass = isTie ? "draw" : (state.winner === "player" ? "win" : "loss");
  const goTitle = isTie ? "Draw" : (state.winner === "player" ? "Victory!" : "Defeat");
  const goSub = isTie
    ? "Both trainers fell at the same moment."
    : (state.winner === "player"
        ? "Your rival's trainer has been knocked out."
        : "Your trainer has been knocked out.");
  overlay.innerHTML = `
    <div class="game-over-card ${goClass}">
      <h2>${goTitle}</h2>
      <p class="go-sub">${goSub}</p>
      ${badgesHtml}
      <div class="go-stats">
        <div class="go-stat"><span>Turns played</span><strong data-count-to="${state.turn}">0</strong></div>
        <div class="go-stat"><span>HP remaining</span><strong data-count-to="${myHpLeft}">0</strong> <em class="go-vs">vs</em> <strong data-count-to="${oppHpLeft}">0</strong></div>
        <div class="go-stat"><span>KOs scored</span><strong data-count-to="${myKOs}">0</strong></div>
        <div class="go-stat"><span>KOs taken</span><strong data-count-to="${oppKOs}">0</strong></div>
        <div class="go-stat"><span>Crit hits</span><strong data-count-to="${my.crits || 0}">0</strong></div>
        <div class="go-stat"><span>Total damage</span><strong data-count-to="${my.totalDamage || 0}">0</strong></div>
        ${my.biggestHitName ? `
          <div class="go-stat go-stat-mvp" style="grid-column:1/-1">
            <span>MVP — biggest hit</span>
            <strong><span class="mvp-name">${escape(my.biggestHitName)}</span> for <span data-count-to="${my.biggestHit}">0</span></strong>
          </div>
        ` : ""}
      </div>
      <div class="game-over-cta-row">
        <button id="share-highlight-btn" class="secondary">📷 Share highlight</button>
        <button id="play-again-btn">${isDailyBoss ? "Back to menu" : "Play again"}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  // Animate counters from 0 to their target. ~700ms ease-out so the numbers
  // feel earned, not slapped on.
  requestAnimationFrame(() => {
    overlay.querySelectorAll("[data-count-to]").forEach((el) => {
      const target = Number(el.dataset.countTo) || 0;
      if (target <= 0) { el.textContent = "0"; return; }
      const duration = 700;
      const start = performance.now();
      function tick(now) {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = String(Math.round(target * eased));
        if (t < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  });
  $("#share-highlight-btn")?.addEventListener("click", async () => {
    trackEvent("highlight_clicked", { won: state.winner === "player" });
    const { showHighlightShare } = await import("./highlight-card.js");
    await showHighlightShare({ state, currentUser });
  });
  // Play Again. Wrapped in try/catch + an escape-hatch reload because
  // any throw inside renderMenu / story.openStoryHub (account panel
  // wiring, daily card fetch, feature strip render…) used to silently
  // leave the user on the dim post-game screen with a broken button.
  let _playAgainClicked = false;
  $("#play-again-btn").addEventListener("click", async () => {
    if (_playAgainClicked) return;            // ignore double-tap
    _playAgainClicked = true;
    try {
      overlay.remove();
      // Restore body scroll in case the modal-scroll-lock didn't unmount
      // cleanly (modal CSS uses body:has(.game-over) — removing the
      // overlay should release it, but belt-and-suspenders).
      document.body.classList.remove("modal-open");
      const wasStory = gameMode === "story";
      const wasDailyBoss = isDailyBoss;
      const wasMp    = gameMode === "mp";
      state = null;
      selectedAttacker = null;
      if (wasMp) {
        try { mp.disconnect(); } catch (e) { console.warn("[play-again] mp.disconnect failed:", e); }
        try { teardownMpListeners(); } catch (e) { console.warn("[play-again] teardownMpListeners failed:", e); }
        mpOpponent = null;
      }
      gameMode = "solo";
      _championId = null;
      _storyContext = null;
      if (wasDailyBoss) {
        // Daily boss is one-attempt-per-day — back to the main menu so
        // the user can see the freshly-updated daily card + quest panel.
        renderMenu();
      } else if (wasStory) {
        await story.openStoryHub({ currentUser });
      } else {
        // renderMenu is sync but the panel widgets (daily card, quests
        // inbox) fire async fetches that we don't await — render the
        // menu shell first so the user always sees the chrome even if
        // a widget fetch hangs.
        renderMenu();
      }
      trackEvent("play_again", { from: wasStory ? "story" : wasMp ? "mp" : "solo" });
    } catch (err) {
      // Last-ditch: log + flash + force a page reload so the user
      // never gets stranded on a frozen post-game screen.
      console.error("[play-again] handler threw:", err);
      try { trackEvent("play_again_error", { name: err?.name || "Error", message: (err?.message || "").slice(0, 200) }); } catch {}
      flashVerdict("Reloading…", "weak");
      setTimeout(() => location.reload(), 600);
    }
  });
}

