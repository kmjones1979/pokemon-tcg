// TCG board controller: renders the play area into #arena and drives player +
// AI turns. Click-based interaction with a small mode state machine. Auto
// promotion + auto retreat-energy selection keep v1 flowing without extra
// prompts. Mirrors the legacy battler's screen toggling (body.in-arena).

import * as engine from "./engine.js";
import { aiTakeTurn } from "./ai.js";
import { renderTcgCard, renderCardBack, TCG_COLORS, TYPE_GLYPH } from "./card-face.js";
import { STARTER_DECKS } from "./decks.js";

const ART = (dex) => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${dex}.png`;

// Entry point: show the deck picker, then run matches. The picker owns the
// screen (body classes) so "Play again" can return here cleanly.
export function openTcgMode({ onExit = () => {} } = {}) {
  const arena = document.getElementById("arena");
  const menu = document.getElementById("menu");

  function enter() {
    menu?.classList.add("hidden");
    arena.classList.remove("hidden");
    document.body.classList.add("in-arena", "tcg-mode");
  }
  function leave() {
    document.body.classList.remove("tcg-mode");
    onExit();
  }

  function renderPicker() {
    enter();
    arena.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "tcg-picker";
    wrap.innerHTML = `<h2>Trading Card Battle</h2>
      <div class="tcg-picker-sub">Pick a starter deck — you'll face a rival running one of the others. Real TCG rules: attach Energy, evolve, Bench + Active, Prize cards, and Weakness ×2.</div>`;
    const grid = document.createElement("div");
    grid.className = "tcg-deck-grid";
    STARTER_DECKS.forEach((d) => {
      const c = document.createElement("div");
      c.className = "tcg-deck-card";
      c.style.setProperty("--type", TCG_COLORS[d.type]);
      c.innerHTML = `<div class="tcg-deck-art" style="background-image:url('${ART(d.cover)}')"></div>
        <div class="tcg-deck-name">${d.name}</div><div class="tcg-deck-blurb">${d.blurb}</div>`;
      c.onclick = () => chooseDeck(d);
      grid.appendChild(c);
    });
    wrap.appendChild(grid);
    const exitBtn = document.createElement("button");
    exitBtn.className = "tcg-btn ghost tcg-picker-exit";
    exitBtn.textContent = "← Back to menu";
    exitBtn.onclick = leave;
    wrap.appendChild(exitBtn);
    arena.appendChild(wrap);
  }

  function chooseDeck(playerDeck) {
    const others = STARTER_DECKS.filter((d) => d.id !== playerDeck.id);
    const aiDeck = others[Math.floor(Math.random() * others.length)];
    startTcgMatch({
      playerDeck, aiDeck, playerName: "You", aiName: "Rival",
      onExit: (again) => { if (again) renderPicker(); else leave(); },
    });
  }

  renderPicker();
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel, root = document) => root.querySelector(sel);
const eln = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };

export function startTcgMatch({ playerDeck, aiDeck, playerName = "You", aiName = "Rival", onExit = () => {} }) {
  const arena = document.getElementById("arena");
  const menu = document.getElementById("menu");
  menu?.classList.add("hidden");
  arena.classList.remove("hidden");
  document.body.classList.add("in-arena");
  document.body.classList.add("tcg-mode");

  const state = engine.createTcgGame({
    playerDeckIds: playerDeck.cards, aiDeckIds: aiDeck.cards, playerName, aiName,
  });

  // UI selection state.
  let mode = "idle";            // idle | attach | evolve | heal | retreat | attack
  let selHand = -1;             // selected hand index
  let aiRunning = false;        // re-entrancy guard for the AI turn loop
  let message = "";

  function clearSel() { mode = "idle"; selHand = -1; message = ""; }

  // ---- interaction ------------------------------------------------------

  function onBoardClick(e) {
    // Gate on whose turn it ACTUALLY is (the engine is the source of truth),
    // not a manual lock flag. The old inputLocked flag lagged: after the AI
    // ended its turn, its final cosmetic render showed "your turn" while the
    // flag was still set for another ~720ms, so the first taps of your turn
    // were silently dropped — which read as "can't attach Energy".
    if (state.winner) {
      const go = e.target.closest('[data-action="again"], [data-action="exit"]');
      if (go) return handleAction(go.dataset.action, go.dataset);
      return;
    }
    if (state.activePlayer !== "player") return;
    const actionEl = e.target.closest("[data-action]");
    if (actionEl) return handleAction(actionEl.dataset.action, actionEl.dataset);
    const atk = e.target.closest(".tcg-attack");
    if (atk && mode === "attack") return doAttack(Number(atk.dataset.attackIndex));
    const cardEl = e.target.closest(".tcg-card");
    if (!cardEl) return;
    const zone = cardEl.dataset.zone;
    if (zone === "hand") return selectHand(Number(cardEl.dataset.handIndex));
    if (zone === "player" && cardEl.dataset.uid) return onOwnPokemon(cardEl.dataset.uid);
  }

  function handleAction(action, data) {
    switch (action) {
      case "end-turn": return endPlayerTurn();
      case "cancel": clearSel(); return render();
      case "play-basic": {
        try { engine.playBasic(state, "player", selHand); } catch (err) { flash(err.message); }
        clearSel(); return render();
      }
      case "play-trainer": {
        try { engine.playTrainer(state, "player", selHand); } catch (err) { flash(err.message); }
        clearSel(); return afterPlayerAction();
      }
      case "open-attacks": mode = "attack"; message = ""; return render();
      case "attack": return doAttack(Number(data.i));
      case "retreat-start": mode = "retreat"; message = "Tap a Benched Pokémon to retreat into."; return render();
      case "exit": return exit();
      case "again": return exit(true);
    }
  }

  function selectHand(i) {
    const card = state.players.player.hand[i];
    if (!card) return;
    selHand = i;
    if (card.kind === "energy") {
      mode = "attach"; message = `Tap one of your Pokémon to attach ${card.name}.`;
    } else if (card.kind === "pokemon" && card.stage === "basic") {
      mode = "place"; message = "";
    } else if (card.kind === "pokemon") {
      mode = "evolve"; message = "Tap the Pokémon to evolve.";
    } else if (card.kind === "item" && card.effect?.type === "heal") {
      mode = "heal"; message = "Tap a Pokémon to heal.";
    } else {
      // Supporters, Stadiums, and self-targeting Items (Switch auto-selects the
      // healthiest Bench Pokémon) are a single confirm-to-play action.
      mode = "play-trainer"; message = "";
    }
    render();
  }

  function onOwnPokemon(uid) {
    const s = state.players.player;
    const inst = engine.findInst(s, uid);
    if (!inst) return;
    // On success clear the selection; on failure KEEP the error visible (don't
    // clearSel, which would wipe the message and make the tap look inert).
    const attempt = (fn) => { try { fn(); clearSel(); } catch (err) { message = err.message; } render(); };
    if (mode === "attach") return attempt(() => engine.attachEnergy(state, "player", selHand, uid));
    if (mode === "evolve") return attempt(() => engine.evolve(state, "player", selHand, uid));
    if (mode === "heal") return attempt(() => engine.playTrainer(state, "player", selHand, { targetUid: uid }));
    if (mode === "retreat") {
      const benchIdx = s.bench.indexOf(inst);
      if (benchIdx < 0) { message = "Pick a Benched Pokémon."; return render(); }
      return attempt(() => engine.retreat(state, "player", benchIdx));
    }
    // idle: tapping the Active opens its attack panel.
    if (inst === s.active) { mode = "attack"; return render(); }
  }

  function doAttack(i) {
    try { engine.attack(state, "player", i); } catch (err) { flash(err.message); return; }
    clearSel();
    afterPlayerAction();
  }

  function flash(msg) { message = msg; render(); }

  // ---- turn handoff -----------------------------------------------------

  function afterPlayerAction() {
    if (state.winner) return finish();
    if (state.activePlayer === "ai") return runAiTurn();
    render();
  }

  function endPlayerTurn() {
    clearSel();
    engine.endTurn(state, "player");
    if (state.winner) return finish();
    runAiTurn();
  }

  async function runAiTurn() {
    if (aiRunning) return;       // never overlap two AI loops
    aiRunning = true; render();
    let guard = 0;
    while (state.activePlayer === "ai" && !state.winner && guard++ < 3) {
      // Delay only WHILE it's still the AI's turn. Once the AI's final action
      // hands control back to the player, render immediately with no trailing
      // delay so the player's turn is live the instant it begins.
      await aiTakeTurn(state, "ai", async () => { render(); if (state.activePlayer === "ai") await delay(720); });
    }
    aiRunning = false;
    if (state.winner) return finish();
    render();
  }

  function exit(again = false) {
    // Remove this match's delegated listener so matches don't stack handlers
    // on the reused #arena element across "Play again".
    arena.removeEventListener("click", onBoardClick);
    // Screen/class cleanup is owned by the caller (openTcgMode) so "Play again"
    // can re-enter the picker without flicker.
    onExit(again);
  }

  function finish() { render(); }

  // ---- rendering --------------------------------------------------------

  function render() {
    const p = state.players.player, a = state.players.ai;
    arena.innerHTML = "";
    const board = eln("div", "tcg-board");

    board.appendChild(renderOppPanel(a));
    board.appendChild(renderRow(a.bench, "ai", "bench", "Opponent Bench"));
    board.appendChild(renderActiveRow(a.active, "ai"));
    board.appendChild(renderCenter());
    board.appendChild(renderActiveRow(p.active, "player"));
    board.appendChild(renderRow(p.bench, "player", "bench", "Your Bench"));
    board.appendChild(renderHand(p));
    board.appendChild(renderActionBar(p));
    board.appendChild(renderLog());

    // NOTE: the click handler is a single delegated listener on #arena added
    // once in startTcgMatch — NOT re-added per board here. Re-adding it to a
    // fresh board every render created a window where a click landing during a
    // re-render hit a board whose listener wiring was momentarily off, which is
    // why taps (e.g. attaching Energy) intermittently did nothing.
    arena.appendChild(board);
    if (state.winner) arena.appendChild(renderGameOver());
  }

  function prizePips(s) {
    let pips = "";
    for (let i = 0; i < engine.PRIZE_COUNT; i++) pips += `<span class="tcg-prize-pip${i < s.prizes.length ? "" : " taken"}"></span>`;
    return pips;
  }

  function renderOppPanel(a) {
    const panel = eln("div", "tcg-opp-panel");
    panel.appendChild(eln("div", "tcg-opp-id", `<strong>${a.name}</strong>`));
    panel.appendChild(eln("div", "tcg-prizes", `<span class="tcg-prize-label">Prizes</span>${prizePips(a)}`));
    panel.appendChild(eln("div", "tcg-piles",
      `<span title="Cards in hand">✋ ${a.hand.length}</span>
       <span title="Cards in deck">🂠 ${a.deck.length}</span>
       <span title="Discard pile">🗑 ${a.discard.length}</span>`));
    return panel;
  }

  function renderActiveRow(inst, side) {
    const row = eln("div", `tcg-active-row tcg-active-${side}`);
    if (inst) {
      const card = renderTcgCard(inst.card, { inst, size: "full", affordable: affordableSet(side, inst) });
      card.dataset.zone = side; card.dataset.uid = inst.uid;
      markTargetable(card, inst, side);
      row.appendChild(card);
    } else {
      row.appendChild(eln("div", "tcg-empty-active", side === "player" ? "No Active Pokémon" : ""));
    }
    return row;
  }

  function affordableSet(side, inst) {
    if (side !== "player" || inst !== state.players.player.active || mode !== "attack") return new Set();
    const set = new Set();
    inst.card.attacks.forEach((atk, i) => { if (engine.affordableAttacks(inst).includes(atk)) set.add(i); });
    return set;
  }

  function renderRow(insts, side, kind, label) {
    const row = eln("div", `tcg-bench-row tcg-bench-${side}`);
    for (let i = 0; i < engine.BENCH_MAX; i++) {
      const inst = insts[i];
      if (inst) {
        const card = renderTcgCard(inst.card, { inst, size: "mini" });
        card.dataset.zone = side; card.dataset.uid = inst.uid;
        markTargetable(card, inst, side);
        row.appendChild(card);
      } else {
        row.appendChild(eln("div", "tcg-slot-empty"));
      }
    }
    return row;
  }

  // Highlight a Pokémon when it's a valid target for the current mode.
  function markTargetable(cardEl, inst, side) {
    if (side !== "player") return;
    const s = state.players.player;
    let ok = false;
    if (mode === "attach") ok = true;
    else if (mode === "evolve") ok = engine.canEvolve(state, "player", s.hand[selHand], inst);
    else if (mode === "heal") ok = inst.damage > 0;
    else if (mode === "switch" || mode === "retreat") ok = s.bench.includes(inst);
    if (ok) cardEl.classList.add("targetable");
  }

  function renderCenter() {
    const c = eln("div", "tcg-center");
    const who = state.activePlayer === "player" ? "Your" : `${state.players.ai.name}'s`;
    const turnTxt = state.winner ? "Game over" : `${who} turn ${state.turn}`;
    c.appendChild(eln("div", "tcg-turn", turnTxt));
    if (state.stadium) c.appendChild(eln("div", "tcg-stadium", `🏟 ${state.stadium.card.name}`));
    return c;
  }

  function renderHand(p) {
    const wrap = eln("div", "tcg-hand-wrap");
    const hand = eln("div", "tcg-hand");
    p.hand.forEach((card, i) => {
      const c = renderTcgCard(card, { size: "full" });
      c.dataset.zone = "hand"; c.dataset.handIndex = i;
      if (i === selHand) c.classList.add("selected");
      hand.appendChild(c);
    });
    if (!p.hand.length) hand.appendChild(eln("div", "tcg-hand-empty", "Hand is empty"));
    wrap.appendChild(hand);
    return wrap;
  }

  function renderActionBar(p) {
    const bar = eln("div", "tcg-action-bar");
    const yours = state.activePlayer === "player" && !state.winner;
    const status = eln("div", "tcg-status");
    if (state.winner) status.textContent = "";
    else if (!yours) status.textContent = `${p === state.players.player ? state.players.ai.name : ""} is thinking…`;
    else if (message) status.textContent = message;
    else if (mode === "place") status.textContent = "Play this Basic Pokémon to your Bench.";
    else status.textContent = "Your turn — attach Energy, evolve, play cards, then attack.";
    bar.appendChild(status);

    const btns = eln("div", "tcg-buttons");
    if (yours) {
      if (mode === "attack" && p.active) {
        // Attack chooser.
        const list = eln("div", "tcg-attack-choose");
        p.active.card.attacks.forEach((atk, i) => {
          const can = engine.affordableAttacks(p.active).includes(atk) && !state.noAttack;
          const cost = (atk.cost || []).map((t) => `<span class="tcg-pip" style="background:${TCG_COLORS[t]}">${TYPE_GLYPH[t]}</span>`).join("");
          const b = eln("button", `tcg-atk-btn${can ? "" : " disabled"}`,
            `${cost} <span class="tcg-atk-btn-name">${atk.name}</span>${atk.damage ? `<span class="tcg-atk-btn-dmg">${atk.damage}</span>` : ""}`);
          if (can) { b.dataset.action = "attack"; b.dataset.i = i; }
          list.appendChild(b);
        });
        bar.appendChild(list);
        if (state.noAttack) bar.appendChild(eln("div", "tcg-note", "The player going first can't attack on turn 1."));
        const canRetreat = p.active && p.bench.length && !p.retreatedThisTurn && p.active.attached.length >= (p.active.card.retreat || 0);
        if (canRetreat) btns.appendChild(button("Retreat", "retreat-start"));
        btns.appendChild(button("Back", "cancel", "ghost"));
      } else if (mode === "place") {
        btns.appendChild(button("Play to Bench", "play-basic"));
        btns.appendChild(button("Cancel", "cancel", "ghost"));
      } else if (mode === "play-trainer") {
        btns.appendChild(button("Play", "play-trainer"));
        btns.appendChild(button("Cancel", "cancel", "ghost"));
      } else if (mode !== "idle") {
        btns.appendChild(button("Cancel", "cancel", "ghost"));
      }
      if (mode === "idle") {
        if (p.active) btns.appendChild(button("⚔ Attack", "open-attacks"));
        btns.appendChild(button("End Turn ▸", "end-turn", "primary"));
      }
    }
    bar.appendChild(btns);
    return bar;
  }

  function button(label, action, variant = "") {
    const b = eln("button", `tcg-btn ${variant}`, label);
    b.dataset.action = action;
    return b;
  }

  function renderLog() {
    const log = eln("div", "tcg-log");
    for (const l of state.log.slice(-5)) log.appendChild(eln("div", "tcg-log-line", l.text));
    return log;
  }

  function renderGameOver() {
    const won = state.winner === "player";
    const ov = eln("div", "tcg-gameover");
    const card = eln("div", `tcg-gameover-card ${won ? "win" : "lose"}`);
    card.appendChild(eln("div", "tcg-go-title", won ? "🏆 You win!" : "Defeated"));
    card.appendChild(eln("div", "tcg-go-sub", won
      ? "You knocked out your rival's team."
      : "Your rival cleared the field. Try another deck!"));
    const row = eln("div", "tcg-go-btns");
    row.appendChild(button("Play again", "again", "primary"));
    row.appendChild(button("Exit to menu", "exit", "ghost"));
    card.appendChild(row);
    ov.appendChild(card);
    return ov;
  }

  // ---- kick off ---------------------------------------------------------
  // One delegated listener on the stable #arena container, live for the whole
  // match regardless of how often the board re-renders.
  arena.addEventListener("click", onBoardClick);
  render();
  if (state.activePlayer === "ai") runAiTurn();
}
