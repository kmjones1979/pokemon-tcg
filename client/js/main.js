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
  trainerMascotUrl,
} from "./game.js";
import { renderCard } from "./cards.js";
import { fireAttackTrail, floatDamage, knockOut, flashVerdict, shakeHit } from "./animations.js";
import {
  playCry, setMuted, isMuted,
  sfxAttack, sfxHit, sfxKO, sfxVictory, sfxDefeat, sfxCardPlay, sfxCrit,
  startBGM, stopBGM,
} from "./audio.js";
import { TYPE_COLORS } from "./type-chart.js";
import { computeDamage } from "./battle.js";
import { abilitiesFor, abilityById, basicAbility } from "./abilities.js";
import { attachPreviewHandlers } from "./card-preview.js";
import { ITEM_DEFS, useItem } from "./items.js";
import * as passkey from "./passkey.js";
import * as deckBuilder from "./deck-builder.js";
import * as mp from "./multiplayer.js";
import * as rewards from "./rewards.js";
import * as leaderboard from "./leaderboard.js";
import * as achievements from "./achievements.js";

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
let currentTheme = null;       // { type, endsAt } — theme of the week
let _prevHps = { player: null, ai: null }; // tracks trainer HPs between renders for the flash
let _prevEnergy = null; // tracks your energy across renders so we can pip-refill the new ones

// --- Boot ------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", async () => {
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
      <div class="menu-tagline">Pick your trainer. First to drop the opposing trainer to 0 HP wins.</div>
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
      const [playerDeck, aiDeck] = await Promise.all([loadPlayerDeck(), fetchDeck()]);
      state = createGame({
        playerDeck,
        aiDeck,
        playerAbility: chosen,
        aiAbility: aiTrainer,
        firstPlayer: "player",
      });
      if (currentTheme?.type) state.themeType = currentTheme.type;
      _prevHps = { player: null, ai: null };
      _prevEnergy = null;
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
      render();
    } catch (err) {
      console.error(err);
      btn.textContent = "Failed to load deck. Retry";
      btn.disabled = false;
    }
  });

  $("#mode-mp-match").addEventListener("click", () => startMultiplayer({ mode: "queue" }));
  $("#mode-mp-friend").addEventListener("click", () => startMultiplayer({ mode: "friend" }));
  $("#how-to-play-btn").addEventListener("click", showHowToPlay);

  // Daily streak banner + trainer level chip + daily quests (signed-in only).
  if (currentUser) {
    loadAndRenderStreak();
    loadAndRenderTrainerLevel();
    loadAndRenderQuests();
  }

  // First-time helper: nudge new visitors who haven't started a game yet.
  if (!localStorage.getItem("pokemon-tcg-seen-howto")) {
    setTimeout(() => {
      if (document.body.contains($("#how-to-play-btn"))) {
        $("#how-to-play-btn").classList.add("can-act");
      }
    }, 800);
  }
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
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "claim failed");
    rewards.showOffer(data.reward, {
      didWin: true,
      onClaim: (card) => {
        if (card) flashVerdict(`+${card.name}!`, "super");
        loadAndRenderQuests();
      },
    });
  } catch (err) {
    alert("Couldn't claim: " + (err.message || "unknown"));
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
      if (data.leveledUp) {
        setTimeout(() => flashVerdict(`Trainer Level ${data.level}!`, "super"), 900);
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
        <div class="turn-hint">${escape(turnHint())}</div>
      </div>
    </div>

    <div class="field ai-field" id="ai-field"></div>
    <div class="field player-field" id="player-field"></div>

    <div class="trainer-row bottom">
      <div class="trainer-block player${state.activePlayer === "player" && !state.winner ? " is-turn" : ""}">
        <div class="trainer-avatar" data-ability="${state.players.player.ability}"></div>
        <div class="trainer-meta">
          <div class="trainer-label">${escape(youLabel())} (${TRAINERS[state.players.player.ability]?.name || state.players.player.ability})</div>
          ${hpBar(state.players.player.trainerHp)}
          <div class="trainer-resources">
            <div class="energy-pips" title="Energy ${state.players.player.energy}/${state.players.player.maxEnergy}">
              ${renderEnergyPips(state.players.player.energy, state.players.player.maxEnergy)}
            </div>
            <span>📚 ${state.players.player.deck.length}</span>
            <span>🗑 ${state.players.player.discard.length}</span>
          </div>
          ${renderItemBar(state.players.player)}
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
  bindItemBar();

  // Long-hover preview anywhere a card is rendered in-arena.
  attachPreviewHandlers($("#arena"), cardLookup);

  // Trainer HP flash: if either side's HP dropped vs the previous render,
  // run the damage animation on that bar.
  for (const side of ["player", "ai"]) {
    const cur = state.players[side].trainerHp;
    const prev = _prevHps[side];
    if (prev != null && cur < prev) {
      const bar = $(`.trainer-block.${side} .hp-bar`);
      if (bar) {
        bar.classList.remove("damaged");
        // Force reflow to replay the animation on consecutive hits.
        // eslint-disable-next-line no-unused-expressions
        bar.offsetHeight;
        bar.classList.add("damaged");
      }
    }
    _prevHps[side] = cur;
  }

  if (state.winner) onGameOver();
}

// Coach the player about what to do next. Reads state to figure out which
// action is the most useful nudge.
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
        if (pendingReplace && side === "player") card.classList.add("sacrifice-target");
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

function showDamagePreview(slotEl, defenderInst) {
  if (!selectedAttacker) return;
  const attackerInst = state.players.player.field[selectedAttacker.slot];
  if (!attackerInst) return;
  const ability = abilityById(attackerInst.card, chosenAbilityId);
  const result = computeDamage(attackerInst.card, defenderInst.card, { ability });
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
    const playable = state.activePlayer === "player" && p.energy >= cost && state.players.player.field.includes(null);
    if (!playable) cardEl.classList.add("unplayable");
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
  if (state.youAre === "spectator") return;
  if (state.activePlayer !== "player" || state.winner) {
    flashVerdict("Wait for your turn", "weak");
    return;
  }
  const p = state.players.player;
  const card = p.hand[handIndex];
  if (!card) return;
  const cost = effectiveCost(p, card);
  if (p.energy < cost) {
    flashVerdict(`Need ${cost} ⚡`, "weak");
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

function onSlotClick(side, slot) {
  if (state.youAre === "spectator") return;
  if (state.winner) return;
  if (state.activePlayer !== "player") {
    flashVerdict("Wait for your turn", "weak");
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

  const result = attack(state, "player", fromSlot, slot, { abilityId: chosenAbilityId });
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
          flashVerdict(`Evolved! L${result.attackerLeveled}`, "super");
          setTimeout(() => attackerEl.classList.remove("leveled-up"), 850);
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
  // Brief pause for the turn shift before the AI starts acting visibly.
  await sleep(500);
  await aiTakeTurn(state, {
    difficulty: aiDifficulty,
    onAction: handleAiAction,
  });
  render();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function handleAiAction(action) {
  if (state.winner) return;
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
  stopBGM();
  if (state.winner === "player") sfxVictory();
  else sfxDefeat();
  // Grant XP based on outcome (signed-in users only).
  if (currentUser) {
    const myKOs = state.players.ai.discard.length;   // we KO'd these
    grantXp({
      won: state.winner === "player",
      kos: myKOs,
      crits: 0, // not currently tracked per-match; approx via kos
    });
    setTimeout(() => achievements.checkForNewUnlocks(), 1500);
  }
  // In solo mode, finalise the server-tracked session and ask for a reward.
  if (gameMode === "solo" && currentUser && soloSessionId) {
    fetch("/me/solo/end", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: soloSessionId,
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
    soloSessionId = null;
  }

  const overlay = document.createElement("div");
  overlay.className = "game-over";
  const myKOs = state.players.player.discard.length;
  const oppKOs = state.players.ai.discard.length;
  const myHpLeft = state.players.player.trainerHp;
  const oppHpLeft = state.players.ai.trainerHp;
  overlay.innerHTML = `
    <div class="game-over-card ${state.winner === "player" ? "win" : "loss"}">
      <h2>${state.winner === "player" ? "Victory!" : "Defeat"}</h2>
      <p class="go-sub">${state.winner === "player"
        ? "Your rival's trainer has been knocked out."
        : "Your trainer has been knocked out."}</p>
      <div class="go-stats">
        <div class="go-stat"><span>Turns played</span><strong>${state.turn}</strong></div>
        <div class="go-stat"><span>Your KOs</span><strong>${oppKOs}</strong></div>
        <div class="go-stat"><span>Their KOs</span><strong>${myKOs}</strong></div>
        <div class="go-stat"><span>Trainer HP</span><strong>${myHpLeft} vs ${oppHpLeft}</strong></div>
      </div>
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

