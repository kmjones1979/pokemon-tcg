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
  TRAINERS,
  FIELD_SIZE,
  TRAINER_START_HP,
} from "./game.js";
import { renderCard } from "./cards.js";
import { fireAttackTrail, floatDamage, knockOut, flashVerdict, shakeHit } from "./animations.js";
import { playCry, setMuted, isMuted } from "./audio.js";
import { TYPE_COLORS } from "./type-chart.js";
import { computeDamage } from "./battle.js";
import * as passkey from "./passkey.js";
import * as deckBuilder from "./deck-builder.js";
import * as mp from "./multiplayer.js";
import * as rewards from "./rewards.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let state = null; // current game state
let selectedAttacker = null; // { slot: number } when player has clicked one of their field cards
let aiDifficulty = localStorage.getItem("pokemon-tcg-difficulty") || "easy";
let currentUser = null;     // populated after passkey login/register or /auth/me probe
let gameMode = "solo";      // "solo" | "mp"
let mpOpponent = null;      // { displayName, ability } in multiplayer
let chosenTrainer = null;   // remember during multiplayer matchmaking

// --- Boot ------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", async () => {
  try {
    currentUser = await passkey.me();
  } catch {
    currentUser = null;
  }
  renderMenu();
  $("#mute-toggle").addEventListener("click", () => {
    setMuted(!isMuted());
    refreshMuteIcon();
  });
  refreshMuteIcon();
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

  const trainerEls = Object.values(TRAINERS).map((t) => {
    const c = TYPE_COLORS[t.portrait] || "#888";
    return `
      <button class="trainer-card" data-trainer="${t.id}" style="--accent:${c}">
        <div class="trainer-portrait" style="background:linear-gradient(140deg, ${c}, #1a1f2e)"></div>
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
      <div class="menu-tagline">Pick your trainer. First to drop the opposing trainer to 0 HP wins.</div>
      <div class="trainer-grid">${trainerEls.join("")}</div>
      <div class="section-label">Solo vs. AI difficulty</div>
      <div class="difficulty-grid">${difficultyEls.join("")}</div>
      <div class="menu-foot">
        <button class="start-btn" id="start-btn" disabled>Choose a trainer to begin</button>
        <div class="play-modes">
          <button class="mode-btn" id="mode-mp-match" disabled>Find online match</button>
          <button class="mode-btn" id="mode-mp-friend" disabled>Play vs friend (code)</button>
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
      const [playerDeck, aiDeck] = await Promise.all([loadPlayerDeck(), fetchDeck()]);
      state = createGame({
        playerDeck,
        aiDeck,
        playerAbility: chosen,
        aiAbility: aiTrainer,
        // Solo: human always goes first. The going-second bonus only matters
        // when both players are human and one happened to draw the short
        // straw on first-player random.
        firstPlayer: "player",
      });
      menu.classList.add("hidden");
      $("#arena").classList.remove("hidden");
      render();
    } catch (err) {
      console.error(err);
      btn.textContent = "Failed to load deck. Retry";
      btn.disabled = false;
    }
  });

  $("#mode-mp-match").addEventListener("click", () => startMultiplayer({ mode: "queue" }));
  $("#mode-mp-friend").addEventListener("click", () => startMultiplayer({ mode: "friend" }));
}

// --- Arena rendering -------------------------------------------------------
function render() {
  if (!state) return;
  const arena = $("#arena");
  arena.innerHTML = `
    <div class="arena-bg"></div>
    <div class="trainer-row top">
      <div class="trainer-block ai">
        <div class="trainer-avatar" data-ability="${state.players.ai.ability}"></div>
        <div class="trainer-meta">
          <div class="trainer-label">${escape(opponentLabel())} (${TRAINERS[state.players.ai.ability]?.name || state.players.ai.ability})</div>
          ${hpBar(state.players.ai.trainerHp)}
          <div class="trainer-resources">
            <span>✋ ${state.players.ai.hand.length}</span>
            <span>📚 ${state.players.ai.deck.length}</span>
          </div>
        </div>
      </div>
      <div class="turn-banner">
        <div class="turn-label">Turn ${state.turn}</div>
        <div class="turn-active">${state.activePlayer === "player" ? "Your move" : "Rival is thinking…"}</div>
      </div>
    </div>

    <div class="field ai-field" id="ai-field"></div>
    <div class="field player-field" id="player-field"></div>

    <div class="trainer-row bottom">
      <div class="trainer-block player">
        <div class="trainer-avatar" data-ability="${state.players.player.ability}"></div>
        <div class="trainer-meta">
          <div class="trainer-label">${escape(youLabel())} (${TRAINERS[state.players.player.ability]?.name || state.players.player.ability})</div>
          ${hpBar(state.players.player.trainerHp)}
          <div class="trainer-resources">
            <span class="energy-pill">⚡ ${state.players.player.energy}/${state.players.player.maxEnergy}</span>
            <span>📚 ${state.players.player.deck.length}</span>
            <span>🗑 ${state.players.player.discard.length}</span>
          </div>
        </div>
      </div>
      <div class="action-bar">
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

  if (state.winner) onGameOver();
}

function opponentLabel() {
  if (gameMode === "mp" && mpOpponent?.displayName) return mpOpponent.displayName;
  return state?.players?.ai?.name || "Rival";
}
function youLabel() {
  if (gameMode === "mp") return currentUser?.display_name || "You";
  return state?.players?.player?.name || "You";
}

function hpBar(hp) {
  const pct = Math.max(0, (hp / TRAINER_START_HP) * 100);
  const tone = pct > 60 ? "good" : pct > 30 ? "mid" : "bad";
  return `
    <div class="hp-row">
      <div class="hp-bar tone-${tone}"><div class="hp-fill" style="width:${pct}%"></div></div>
      <div class="hp-text">${hp}/${TRAINER_START_HP}</div>
    </div>
  `;
}

function renderFields() {
  for (const side of ["player", "ai"]) {
    const root = $(side === "player" ? "#player-field" : "#ai-field");
    root.innerHTML = "";
    const p = state.players[side];
    for (let i = 0; i < FIELD_SIZE; i++) {
      const slot = document.createElement("div");
      slot.className = `field-slot ${side}`;
      slot.dataset.side = side;
      slot.dataset.slot = String(i);
      const inst = p.field[i];
      if (inst) {
        const card = renderCard(inst.card, { instance: inst });
        if (inst.summoningSickness) card.classList.add("summoning");
        if (inst.attackedThisTurn) card.classList.add("spent");
        if (selectedAttacker && side === "player" && selectedAttacker.slot === i) card.classList.add("selected");
        slot.appendChild(card);
        // Damage preview: when an enemy card is hovered AND we have an
        // attacker selected, show predicted -dmg above the target.
        if (side === "ai" && selectedAttacker) {
          slot.addEventListener("mouseenter", () => showDamagePreview(slot, inst));
          slot.addEventListener("mouseleave", () => clearDamagePreview(slot));
        }
      } else {
        slot.innerHTML = `<div class="slot-empty">empty</div>`;
      }
      slot.addEventListener("click", () => onSlotClick(side, i));
      root.appendChild(slot);
    }
  }
}

function showDamagePreview(slotEl, defenderInst) {
  if (!selectedAttacker) return;
  const attackerInst = state.players.player.field[selectedAttacker.slot];
  if (!attackerInst) return;
  // The engine bonuses come from the player object; treat trainer bonuses
  // as 0 here since we don't want this UI hint to leak the opposing
  // trainer's defense bonus. It's a preview, not a guarantee.
  const result = computeDamage(attackerInst.card, defenderInst.card);
  const el = document.createElement("div");
  el.className = `dmg-preview tone-${result.verdict?.tone || "normal"}`;
  el.textContent = result.multiplier === 0 ? "MISS" : `-${result.damage}`;
  if (result.verdict?.text) {
    el.dataset.verdict = result.verdict.text;
  }
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
  p.hand.forEach((card, idx) => {
    const cardEl = renderCard(card);
    const cost = effectiveCost(p, card);
    cardEl.dataset.handIndex = String(idx);
    const playable = state.activePlayer === "player" && p.energy >= cost && state.players.player.field.includes(null);
    if (!playable) cardEl.classList.add("unplayable");
    // Fan layout — slight rotation/translation per card.
    const mid = (n - 1) / 2;
    const rel = idx - mid;
    cardEl.style.setProperty("--fan-rot", `${rel * 3.5}deg`);
    cardEl.style.setProperty("--fan-y", `${Math.abs(rel) * 6}px`);
    cardEl.style.setProperty("--fan-x", `${rel * 4}px`);
    cardEl.addEventListener("click", () => onHandCardClick(idx));
    hand.appendChild(cardEl);
  });
}

function renderLog() {
  const panel = $("#log-panel");
  panel.innerHTML = `<div class="log-title">Combat Log</div>` +
    state.log
      .slice(-12)
      .map((e) => `<div class="log-line tone-${e.kind}">${escape(e.text)}</div>`)
      .join("");
}

function escape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- Interaction -----------------------------------------------------------
function onHandCardClick(handIndex) {
  if (state.activePlayer !== "player" || state.winner) return;
  const p = state.players.player;
  const card = p.hand[handIndex];
  if (!card) return;
  const cost = effectiveCost(p, card);
  if (p.energy < cost) {
    flashVerdict(`Need ${cost} ⚡`, "weak");
    return;
  }
  if (!p.field.includes(null)) {
    flashVerdict("Field is full!", "weak");
    return;
  }

  if (gameMode === "mp") {
    // Optimistic cry, server will broadcast the canonical state.
    playCry(card.cry_url).catch(() => {});
    mp.playCard(handIndex);
    return;
  }

  const result = playCard(state, "player", handIndex);
  if (!result.ok) {
    flashVerdict(result.reason, "weak");
    return;
  }
  playCry(card.cry_url).catch(() => {});
  render();
}

function onSlotClick(side, slot) {
  if (state.winner) return;
  if (state.activePlayer !== "player") return;

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
    renderFields();
    return;
  }

  // Clicked an enemy slot — only valid if we have a selected attacker.
  if (!selectedAttacker) return;
  const fromSlot = selectedAttacker.slot;
  const defenderInst = state.players.ai.field[slot];
  if (!defenderInst) return; // can't attack empty slot directly (use trainer button)

  if (gameMode === "mp") {
    selectedAttacker = null;
    mp.attack(fromSlot, slot);
    return;
  }

  const attackerEl = $(`.player-field .field-slot[data-slot="${fromSlot}"] .card`);
  const defenderEl = $(`.ai-field .field-slot[data-slot="${slot}"] .card`);
  const attackerInst = state.players.player.field[fromSlot];

  const result = attack(state, "player", fromSlot, slot);
  if (!result.ok) {
    flashVerdict(result.reason, "weak");
    selectedAttacker = null;
    renderFields();
    return;
  }
  selectedAttacker = null;
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
      mp.attack(fromSlot, "trainer");
      return;
    }
    const attackerEl = $(`.player-field .field-slot[data-slot="${fromSlot}"] .card`);
    const result = attack(state, "player", fromSlot, "trainer");
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
  setTimeout(() => {
    floatDamage(defenderEl, result.multiplier === 0 ? "MISS" : `-${result.damage}`, {
      kind: result.multiplier >= 2 ? "super" : result.multiplier < 1 ? "weak" : "hit",
    });
    if (result.multiplier !== 0) shakeHit(defenderEl);
    if (result.verdict?.text) flashVerdict(result.verdict.text, result.verdict.tone);
    if (result.knockedOut) {
      knockOut(defenderEl).then(() => done && done());
    } else {
      setTimeout(() => done && done(), 350);
    }
  }, 450);
}

function onEndTurn() {
  if (state.activePlayer !== "player" || state.winner) return;
  if (gameMode === "mp") {
    mp.endTurn();
    return;
  }
  endTurn(state);
  render();
  if (state.winner) return;
  // Give the player a beat to see the turn shift before AI plays.
  setTimeout(() => {
    if (state.winner) return;
    aiTakeTurn(state, { difficulty: aiDifficulty });
    render();
  }, 700);
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
        </div>
        <div class="account-actions">
          <button id="account-collection-btn">Collection</button>
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
}

async function onRegister() {
  if (!passkey.isSupported()) {
    alert("Passkeys aren't supported on this browser. Try Safari, Chrome, or Edge.");
    return;
  }
  const displayName = prompt("Choose a display name (2-32 chars). Other trainers will see this.");
  if (!displayName) return;
  try {
    const user = await passkey.register(displayName.trim());
    currentUser = user;
    flashVerdict(`Welcome, ${user.display_name}!`, "super");
    renderMenu();
  } catch (err) {
    alert(err.message || "Sign up failed.");
  }
}

async function onSignIn() {
  if (!passkey.isSupported()) {
    alert("Passkeys aren't supported on this browser.");
    return;
  }
  try {
    const user = await passkey.login("");
    currentUser = user;
    flashVerdict(`Welcome back, ${user.display_name}`, "super");
    renderMenu();
  } catch (err) {
    alert(err.message || "Sign-in failed.");
  }
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
    body = `
      <div class="mm-title">Share this code</div>
      <div class="mm-code">${code}</div>
      <div class="mm-hint">Send this code to a friend. As soon as they enter it, the match starts.</div>
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
  state = serverState;
  closeMatchmakingModal();
  gameMode = "mp";
  // Reuse the existing render() path. The state shape matches what the engine
  // produces (perspective normalized by the server).
  $("#menu").classList.add("hidden");
  $("#arena").classList.remove("hidden");
  render();
}

function handleMpAnim(anim) {
  // Best-effort visual hooks for opponent actions. Our own actions already
  // played their own animation locally on click.
  if (anim.kind === "attack" && anim.fromSide === "ai") {
    const attackerEl = $(`.ai-field .field-slot[data-slot="${anim.fromSlot}"] .card`);
    let defenderEl;
    if (anim.target === "trainer") {
      defenderEl = $(".trainer-row.bottom .trainer-block.player") || $(".trainer-row.bottom .trainer-block");
    } else {
      defenderEl = $(`.player-field .field-slot[data-slot="${anim.target}"] .card`);
    }
    const attackerType = (state?.players?.ai?.field?.[anim.fromSlot]?.card?.types?.[0]) || "normal";
    fireAttackTrail(attackerEl, defenderEl, attackerType);
    if (defenderEl) {
      floatDamage(defenderEl, anim.multiplier === 0 ? "MISS" : `-${anim.damage}`, {
        kind: anim.multiplier >= 2 ? "super" : anim.multiplier < 1 ? "weak" : "hit",
      });
      if (anim.multiplier !== 0) shakeHit(defenderEl);
    }
    if (anim.verdict?.text) flashVerdict(anim.verdict.text, anim.verdict.tone);
  } else if (anim.kind === "opponent-disconnected") {
    flashVerdict("Opponent disconnected — 60s grace", "weak");
  }
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

function onGameOver() {
  // In solo mode, ask the server for a reward roll.
  if (gameMode === "solo" && currentUser) {
    fetch("/me/rewards/solo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        difficulty: aiDifficulty,
        won: state.winner === "player",
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
      })
      .catch(() => {});
  }

  const overlay = document.createElement("div");
  overlay.className = "game-over";
  overlay.innerHTML = `
    <div class="game-over-card">
      <h2>${state.winner === "player" ? "Victory!" : "Defeat"}</h2>
      <p>${state.winner === "player"
        ? "Your rival's trainer has been knocked out."
        : "Your trainer has been knocked out."}</p>
      <button id="play-again-btn">Play again</button>
    </div>
  `;
  document.body.appendChild(overlay);
  $("#play-again-btn").addEventListener("click", () => {
    overlay.remove();
    state = null;
    selectedAttacker = null;
    if (gameMode === "mp") {
      mp.disconnect();
      teardownMpListeners();
      mpOpponent = null;
    }
    gameMode = "solo";
    renderMenu();
  });
}

