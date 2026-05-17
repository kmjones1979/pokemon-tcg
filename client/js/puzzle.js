// Daily Puzzle client — a small chess-style board where the player taps
// to assign attacks and tries to clear every enemy in `par` moves.
//
// No energy, no card draws — this is a puzzle, not a deck-building loop.
// Each "move" is one attack by one of your Pokémon. They have a single
// attack per puzzle (no repeats). Damage uses the same computeDamage
// pipeline as the main game so type matchups carry over.

import { computeDamage } from "./battle.js";
import { TYPE_COLORS } from "./type-chart.js";
import { flashVerdict } from "./animations.js";
import { sfxAttack, sfxKO, sfxVictory, sfxDefeat } from "./audio.js";
import { showShareDialog as showDailyShare } from "./daily.js";
import { trackEvent } from "./analytics.js";

let _stage = null;
let _state = null;

function ensureStage() {
  if (_stage) return _stage;
  _stage = document.createElement("section");
  _stage.id = "puzzle-stage";
  document.body.appendChild(_stage);
  installCloseShortcuts();
  return _stage;
}

function closeStage() {
  _stage?.remove();
  _stage = null;
  _state = null;
  // Untie the escape handler when the puzzle is closed.
  document.removeEventListener("keydown", _escHandler);
}
// Single escape-handler reference so add/remove pair correctly.
function _escHandler(e) {
  if (e.key === "Escape") closeStage();
}
// Attach backdrop click + Escape on every stage mount so the X is
// never the only way out. Idempotent — multiple installs are
// safe because we always pass the same handler reference.
function installCloseShortcuts() {
  if (!_stage) return;
  // Click on the stage backdrop (NOT the inner card) closes.
  _stage.addEventListener("click", (e) => {
    if (e.target === _stage) closeStage();
  });
  document.addEventListener("keydown", _escHandler);
}

function escape(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
}

export async function openPuzzle({ currentUser } = {}) {
  ensureStage();
  _stage.innerHTML = `<div class="puzzle-loading">Loading puzzle…</div>`;
  let payload;
  try {
    const r = await fetch("/api/puzzle/today");
    payload = await r.json();
    if (!r.ok) throw new Error(payload.error || "Failed to load.");
  } catch (err) {
    _stage.innerHTML = `<div class="puzzle-error">${escape(err.message)}</div>`;
    return;
  }
  const { puzzle, dayNumber, alreadyAttempted } = payload;
  if (alreadyAttempted) {
    // Player already played today — show their result + share button.
    renderPostGame(payload, {
      solved: alreadyAttempted.solved,
      movesUsed: alreadyAttempted.moves_used,
    }, currentUser, /*fromReplay=*/true);
    return;
  }
  if (!currentUser) {
    _stage.innerHTML = `
      <div class="puzzle-card">
        <button class="puzzle-close" data-act="close">✕</button>
        <h2>Daily Puzzle #${dayNumber}</h2>
        <p>${escape(puzzle.title)} — sign in to record your result and appear on the leaderboard.</p>
        <button class="primary" data-act="play-anon">Play anyway (no save)</button>
      </div>`;
    _stage.querySelector("[data-act=close]")?.addEventListener("click", closeStage);
    _stage.querySelector("[data-act=play-anon]")?.addEventListener("click", () =>
      startPuzzle(payload, { sessionId: null, currentUser: null }));
    return;
  }
  let sessionId = null;
  try {
    const r = await fetch("/me/puzzle/start", { method: "POST" });
    const d = await r.json();
    if (!r.ok) {
      // Already attempted today via another tab.
      if (r.status === 409) {
        const reattempt = await fetch("/api/puzzle/today").then((x) => x.json());
        return renderPostGame(reattempt, reattempt.alreadyAttempted, currentUser, true);
      }
      flashVerdict(d.error || "Couldn't start.", "weak");
      closeStage();
      return;
    }
    sessionId = d.sessionId;
  } catch (err) {
    flashVerdict("Network error.", "weak");
    closeStage();
    return;
  }
  trackEvent("puzzle_started", { day: dayNumber });
  startPuzzle(payload, { sessionId, currentUser });
}

function startPuzzle(payload, { sessionId, currentUser }) {
  const { puzzle, dayNumber } = payload;
  _state = {
    dayNumber,
    sessionId,
    par: puzzle.par,
    title: puzzle.title,
    flavor: puzzle.flavor,
    player: puzzle.player.map((p) => ({ ...p, hp: p.maxHp, used: false })),
    enemy:  puzzle.enemy.map((e)  => ({ ...e, hp: e.maxHp })),
    selectedSlot: null,
    movesUsed: 0,
    done: false,
    currentUser,
  };
  renderBoard();
}

function renderBoard() {
  const s = _state;
  const enemyHp = s.enemy.reduce((sum, e) => sum + Math.max(0, e.hp), 0);
  const enemyMaxHp = s.enemy.reduce((sum, e) => sum + e.maxHp, 0);
  const movesLeft = Math.max(0, s.par - s.movesUsed);
  _stage.innerHTML = `
    <div class="puzzle-board">
      <header class="puzzle-header">
        <button class="puzzle-close" data-act="close">✕</button>
        <div class="puzzle-title-row">
          <div class="puzzle-num">Puzzle #${s.dayNumber}</div>
          <h2 class="puzzle-title">${escape(s.title)}</h2>
          <div class="puzzle-flavor">${escape(s.flavor || "")}</div>
        </div>
        <div class="puzzle-moves">
          <div class="puzzle-moves-label">Moves</div>
          <div class="puzzle-moves-count">${s.movesUsed}<span class="puzzle-moves-par">/${s.par}</span></div>
        </div>
      </header>
      <div class="puzzle-enemy-row">
        ${s.enemy.map((e, i) => renderUnit(e, i, "enemy")).join("")}
      </div>
      <div class="puzzle-vs">vs</div>
      <div class="puzzle-player-row">
        ${s.player.map((p, i) => renderUnit(p, i, "player")).join("")}
      </div>
      <div class="puzzle-hint">${puzzleHint(s)}</div>
      <div class="puzzle-actions">
        <button class="ghost" data-act="restart">↺ Restart</button>
        <button class="ghost" data-act="give-up">Give up</button>
      </div>
    </div>`;
  _stage.querySelector("[data-act=close]")?.addEventListener("click", closeStage);
  _stage.querySelector("[data-act=restart]")?.addEventListener("click", restart);
  _stage.querySelector("[data-act=give-up]")?.addEventListener("click", () => finishPuzzle(false));
  // Click handlers.
  _stage.querySelectorAll(".puzzle-unit.player").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = Number(el.dataset.slot);
      if (s.player[idx].used || s.player[idx].hp <= 0) {
        flashVerdict("Already attacked.", "weak"); return;
      }
      s.selectedSlot = (s.selectedSlot === idx) ? null : idx;
      renderBoard();
    });
  });
  _stage.querySelectorAll(".puzzle-unit.enemy").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = Number(el.dataset.slot);
      if (s.enemy[idx].hp <= 0) return;
      if (s.selectedSlot == null) {
        flashVerdict("Tap one of your Pokémon first.", "weak");
        return;
      }
      attackEnemy(s.selectedSlot, idx);
    });
  });
}

function renderUnit(unit, slot, side) {
  const dead = unit.hp <= 0;
  const used = unit.used;
  const sel = side === "player" && _state.selectedSlot === slot;
  const type = unit.card?.types?.[0] || "normal";
  const color = TYPE_COLORS[type] || "#888";
  const types = (unit.card?.types || []).map((t) =>
    `<span class="puzzle-type" style="background:${TYPE_COLORS[t] || "#888"}">${t}</span>`).join("");
  return `
    <div class="puzzle-unit ${side} ${dead ? "dead" : ""} ${used ? "used" : ""} ${sel ? "selected" : ""} type-${type}"
         data-slot="${slot}" style="--type:${color}">
      <div class="puzzle-unit-art">
        ${unit.card?.sprite_front ? `<img src="${unit.card.sprite_front}" alt="${escape(unit.card.name)}" loading="lazy">` : ""}
      </div>
      <div class="puzzle-unit-name">${escape(unit.card?.name || "?")}</div>
      <div class="puzzle-unit-types">${types}</div>
      <div class="puzzle-unit-stats">
        <div class="puzzle-unit-hp ${dead ? "ko" : ""}">${dead ? "KO" : `${unit.hp}/${unit.maxHp}`}</div>
        <div class="puzzle-unit-atk">⚔${unit.atk}</div>
      </div>
    </div>`;
}

function puzzleHint(s) {
  const aliveEnemies = s.enemy.filter((e) => e.hp > 0).length;
  const availableAttackers = s.player.filter((p) => !p.used && p.hp > 0).length;
  if (aliveEnemies === 0) return "✅ All enemies down. Result locked in…";
  if (availableAttackers === 0) return "❌ Out of attackers.";
  if (s.selectedSlot != null) return `Tap an enemy to attack with ${escape(s.player[s.selectedSlot].card?.name || "your Pokémon")}.`;
  return "Tap one of your Pokémon, then tap an enemy.";
}

async function attackEnemy(playerSlot, enemySlot) {
  const s = _state;
  const attacker = s.player[playerSlot];
  const defender = s.enemy[enemySlot];
  // Use the existing damage formula. Build pseudo-cards with the puzzle's
  // overridden HP/ATK.
  const aCard = { ...attacker.card, cardAttack: attacker.atk };
  const dCard = { ...defender.card, cardHp: defender.maxHp };
  const result = computeDamage(aCard, dCard, { rand: Math.random });
  defender.hp = Math.max(0, defender.hp - result.damage);
  attacker.used = true;
  s.movesUsed += 1;
  s.selectedSlot = null;
  sfxAttack();
  if (defender.hp <= 0) sfxKO();
  trackEvent("puzzle_move", { day: s.dayNumber, dmg: result.damage });
  // Render the new state.
  renderBoard();
  // Check end conditions.
  const allDown = s.enemy.every((e) => e.hp <= 0);
  if (allDown) {
    setTimeout(() => finishPuzzle(true), 500);
    return;
  }
  const noAttackersLeft = s.player.every((p) => p.used || p.hp <= 0);
  if (noAttackersLeft) {
    setTimeout(() => finishPuzzle(false), 500);
  }
}

function restart() {
  const s = _state;
  for (const p of s.player) { p.hp = p.maxHp; p.used = false; }
  for (const e of s.enemy)  { e.hp = e.maxHp; }
  s.movesUsed = 0; s.selectedSlot = null;
  renderBoard();
}

async function finishPuzzle(solved) {
  if (_state.done) return;
  _state.done = true;
  if (solved) sfxVictory(); else sfxDefeat();
  trackEvent("puzzle_finished", { day: _state.dayNumber, solved, moves: _state.movesUsed });
  if (!_state.sessionId) {
    // Anonymous play — show local result + share dialog, but don't post.
    renderPostGame(
      { dayNumber: _state.dayNumber, puzzle: { title: _state.title, par: _state.par } },
      { solved, movesUsed: _state.movesUsed, moves_used: _state.movesUsed },
      _state.currentUser,
      false,
      /*localOnly=*/true,
    );
    return;
  }
  try {
    const r = await fetch("/me/puzzle/end", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: _state.sessionId, solved, movesUsed: _state.movesUsed }),
    });
    const data = await r.json();
    if (!r.ok) { flashVerdict(data.error || "Couldn't save result.", "weak"); }
    // Re-fetch today to refresh `alreadyAttempted` for the post-game UI.
    const refresh = await fetch("/api/puzzle/today").then((x) => x.json()).catch(() => null);
    renderPostGame(refresh || { dayNumber: _state.dayNumber, puzzle: { title: _state.title, par: _state.par } },
      { solved, movesUsed: _state.movesUsed, moves_used: _state.movesUsed },
      _state.currentUser, false, false, data);
  } catch (err) {
    flashVerdict("Network error.", "weak");
  }
}

function renderPostGame(payload, result, currentUser, fromReplay = false, localOnly = false, serverShareData = null) {
  const { puzzle, dayNumber } = payload;
  const solved = !!result.solved;
  const moves = result.movesUsed ?? result.moves_used ?? 0;
  const par = puzzle.par || _state?.par || 0;
  _stage.innerHTML = `
    <div class="puzzle-card postgame">
      <button class="puzzle-close" data-act="close">✕</button>
      <div class="puzzle-result-tag">${solved ? "✅ Cleared" : "❌ Defeated"} · Puzzle #${dayNumber}</div>
      <h2 class="puzzle-result-title">${escape(puzzle.title || "")}</h2>
      <div class="puzzle-stars">${starsFor({ solved, movesUsed: moves, par })}</div>
      <div class="puzzle-moves-line">
        ${solved
          ? `Cleared in <strong>${moves}</strong> of <strong>${par}</strong> ${moves === 1 ? "move" : "moves"}`
          : `Defeated after <strong>${moves}</strong> ${moves === 1 ? "move" : "moves"}`}
      </div>
      ${fromReplay ? `<div class="puzzle-already">You already attempted today's puzzle. Come back tomorrow!</div>` : ""}
      ${localOnly ? `<div class="puzzle-already">Anonymous play — sign in to save and appear on the leaderboard.</div>` : ""}
      <div class="puzzle-actions">
        <button class="primary" data-act="share">📋 Share result</button>
        <button class="ghost"   data-act="leaderboard">🏆 Leaderboard</button>
      </div>
    </div>`;
  _stage.querySelector("[data-act=close]")?.addEventListener("click", closeStage);
  _stage.querySelector("[data-act=share]")?.addEventListener("click", () => {
    if (serverShareData) {
      showDailyShare(serverShareData);
    } else {
      // Reconstruct locally for replay / anonymous paths.
      const url = `${location.origin}/?puzzle=${dayNumber}`;
      const text = solved
        ? `Pokémon TCG Puzzle #${dayNumber} · "${puzzle.title || ""}"\n${starsFor({ solved, movesUsed: moves, par })}  ✅ Cleared in ${moves}/${par} ${moves === 1 ? "move" : "moves"}\nplay: ${url}`
        : `Pokémon TCG Puzzle #${dayNumber} · "${puzzle.title || ""}"\n${starsFor({ solved, movesUsed: moves, par })}  ❌ Defeated after ${moves} ${moves === 1 ? "move" : "moves"}\nplay: ${url}`;
      showDailyShare({ shareText: text, shareUrl: url, dayNumber, stars: "", bossName: puzzle.title });
    }
  });
  _stage.querySelector("[data-act=leaderboard]")?.addEventListener("click", () => openLeaderboard());
}

function starsFor({ solved, movesUsed, par }) {
  if (!solved) return "💀";
  if (movesUsed <= par) return "⭐⭐⭐⭐⭐";
  if (movesUsed === par + 1) return "⭐⭐⭐⭐☆";
  if (movesUsed === par + 2) return "⭐⭐⭐☆☆";
  if (movesUsed <= par * 2) return "⭐⭐☆☆☆";
  return "⭐☆☆☆☆";
}

async function openLeaderboard() {
  document.querySelector(".leaderboard-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "leaderboard-overlay";
  overlay.innerHTML = `<div class="leaderboard-card"><div class="lb-loading">Loading…</div></div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  try {
    const r = await fetch("/api/puzzle/leaderboard");
    const data = await r.json();
    overlay.querySelector(".leaderboard-card").innerHTML = `
      <button class="lb-close">✕</button>
      <h2>Puzzle #${data.dayNumber} Leaderboard</h2>
      ${!data.rows.length
        ? `<p class="lb-empty">No one has tried today's puzzle yet — be the first!</p>`
        : `<table class="lb-table"><thead><tr><th>#</th><th>Trainer</th><th>Result</th><th>Moves</th></tr></thead>
            <tbody>${data.rows.map((r) => `
              <tr class="${r.isYou ? "is-you" : ""}">
                <td>${r.rank}</td>
                <td>${escape(r.displayName)}${r.isYou ? " (you)" : ""}</td>
                <td>${r.solved ? "✅" : "❌"}</td>
                <td>${r.movesUsed}</td>
              </tr>`).join("")}</tbody></table>`}
    `;
    overlay.querySelector(".lb-close").addEventListener("click", () => overlay.remove());
  } catch (err) {
    overlay.querySelector(".leaderboard-card").innerHTML = `<div class="lb-error">Couldn't load: ${escape(err.message)}</div>`;
  }
}
