// TCG board controller: renders the play area into #arena and drives player +
// AI turns. Click-based interaction with a small mode state machine. Auto
// promotion + auto retreat-energy selection keep v1 flowing without extra
// prompts. Mirrors the legacy battler's screen toggling (body.in-arena).

import * as engine from "./engine.js";
import { aiTakeTurn } from "./ai.js";
import { renderTcgCard, renderCardBack, TCG_COLORS } from "./card-face.js";
import { energyBadge, pileSVG, trainerSVG, trophySVG, pokeballSVG } from "./icons.js";
import { STARTER_DECKS, deckStats } from "./decks.js";
import * as collection from "./collection.js";
import { openPack } from "./pack-open.js";
import { cardById, POKEMON, TRAINERS } from "./catalog.js";

const ART = (dex) => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${dex}.png`;
const SPRITE = (dex) => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${dex}.png`;

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
    wrap.innerHTML = `
      <div class="tcg-picker-head">
        <h2 class="tcg-picker-title">Trading Card Battle</h2>
        <div class="tcg-picker-sub">Choose your deck — your rival runs one of the others.<br>Attach Energy, evolve, work the Bench, take Prizes, exploit Weakness ×2.</div>
      </div>`;
    const grid = document.createElement("div");
    grid.className = "tcg-deck-grid";
    STARTER_DECKS.forEach((d, i) => {
      const s = deckStats(d);
      const c = document.createElement("div");
      c.className = `tcg-deck-card type-${d.type}`;
      c.style.setProperty("--type", TCG_COLORS[d.type]);
      c.style.setProperty("--pick-delay", `${i * 90}ms`);
      c.innerHTML = `
        <div class="tcg-deck-shine"></div>
        <div class="tcg-deck-top">
          <span class="tcg-deck-type">${energyBadge(d.type, "pip-cost")}<b>${d.type}</b></span>
          <span class="tcg-deck-total">60</span>
        </div>
        <div class="tcg-deck-hero"><img src="${ART(d.cover)}" alt="${d.name}" draggable="false"></div>
        <div class="tcg-deck-name">${d.name}</div>
        <div class="tcg-deck-blurb">${d.blurb}</div>
        <div class="tcg-deck-preview">${s.preview.map((dex) => `<span class="tcg-deck-thumb" style="background-image:url('${SPRITE(dex)}')"></span>`).join("")}</div>
        <div class="tcg-deck-stats">
          <span title="Pokémon">${pokeballSVG()}${s.pokemon}</span>
          <span title="Trainers">${trainerSVG("item")}${s.trainers}</span>
          <span title="Energy">${energyBadge(d.type, "pip-mini")}${s.energy}</span>
        </div>
        <div class="tcg-deck-play">Play this deck ›</div>`;
      c.onclick = () => chooseDeck(d);
      grid.appendChild(c);
    });
    wrap.appendChild(grid);

    // Binder + booster-pack shelf.
    const shelf = document.createElement("div");
    shelf.className = "tcg-shelf";
    const packs = collection.getPacks();
    const binderBtn = document.createElement("button");
    binderBtn.className = "tcg-btn";
    binderBtn.innerHTML = `🎴 Binder · ${collection.uniqueCards()}/${POKEMON.length + TRAINERS.length}`;
    binderBtn.onclick = renderBinder;
    const packBtn = document.createElement("button");
    packBtn.className = `tcg-btn ${packs > 0 ? "primary tcg-pack-cta" : "disabled"}`;
    packBtn.innerHTML = `${pokeballSVG()} Open Packs · ${packs}`;
    if (packs > 0) packBtn.onclick = () => openPacksFlow();
    shelf.appendChild(binderBtn);
    shelf.appendChild(packBtn);
    wrap.appendChild(shelf);

    const exitBtn = document.createElement("button");
    exitBtn.className = "tcg-btn ghost tcg-picker-exit";
    exitBtn.textContent = "← Back to menu";
    exitBtn.onclick = leave;
    wrap.appendChild(exitBtn);
    arena.appendChild(wrap);
  }

  // Open one booster pack, then return to the picker (refreshes counts).
  function openPacksFlow() {
    if (!collection.takePack()) return renderPicker();
    openPack({ onDone: () => renderPicker() });
  }

  // The Binder: every card, owned ones in colour with a count, unseen ones
  // dimmed — grouped by type, sorted by rarity.
  function renderBinder() {
    enter();
    arena.innerHTML = "";
    const owned = collection.getCards();
    const wrap = document.createElement("div");
    wrap.className = "tcg-binder";
    wrap.innerHTML = `<div class="tcg-binder-head">
        <h2 class="tcg-picker-title">Your Binder</h2>
        <div class="tcg-picker-sub">${collection.uniqueCards()} of ${POKEMON.length + TRAINERS.length} cards collected · ${collection.totalCards()} total</div>
      </div>`;
    const RANK = { ultra: 0, rare: 1, uncommon: 2, common: 3 };
    const all = [...POKEMON, ...TRAINERS].slice().sort((a, b) => {
      const ra = RANK[a.rarity] ?? (a.kind === "stadium" ? 1 : a.kind === "supporter" ? 2 : 3);
      const rb = RANK[b.rarity] ?? (b.kind === "stadium" ? 1 : b.kind === "supporter" ? 2 : 3);
      return ra - rb;
    });
    const grid = document.createElement("div");
    grid.className = "tcg-binder-grid";
    for (const card of all) {
      const n = owned[card.id] || 0;
      const cell = document.createElement("div");
      cell.className = `tcg-binder-cell${n ? "" : " unowned"}`;
      cell.appendChild(renderTcgCard(card, { size: "mini" }));
      cell.insertAdjacentHTML("beforeend", n ? `<div class="tcg-binder-count">×${n}</div>` : `<div class="tcg-binder-count locked">—</div>`);
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);
    const back = document.createElement("button");
    back.className = "tcg-btn ghost tcg-picker-exit";
    back.textContent = "← Back";
    back.onclick = renderPicker;
    wrap.appendChild(back);
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
  let rewarded = false;         // grant the win reward exactly once
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

  async function doAttack(i) {
    const o = state.players.ai;
    const defUid = o.active?.uid;
    const atkEl = document.querySelector(".tcg-active-player .tcg-card[data-uid]");
    const defEl = document.querySelector(".tcg-active-ai .tcg-card[data-uid]");
    let err = null;
    try { engine.attack(state, "player", i); } catch (e) { err = e; }
    if (err) return flash(err.message);
    clearSel();
    const ko = !o.active || o.active.uid !== defUid;
    const dmg = lastDamageFromLog();
    await animateAttack(atkEl, defEl, "up", ko ? "KO!" : (dmg != null ? `−${dmg}` : null), ko);
    afterPlayerAction();
  }

  function flash(msg) { message = msg; render(); }

  // ---- combat animation -------------------------------------------------

  function lastDamageFromLog() {
    for (let i = state.log.length - 1; i >= Math.max(0, state.log.length - 5); i--) {
      const m = /for (\d+)/.exec(state.log[i].text || "");
      if (m) return Number(m[1]);
    }
    return null;
  }

  function floatDamage(el, text, ko) {
    if (!el || !text) return;
    const r = el.getBoundingClientRect();
    const d = document.createElement("div");
    d.className = `tcg-dmg-float${ko ? " ko" : ""}`;
    d.textContent = text;
    d.style.left = `${r.left + r.width / 2}px`;
    d.style.top = `${r.top + r.height / 2}px`;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 1000);
  }

  // Lunge the attacker toward the defender, shake + flash the defender, and
  // float the damage. Runs on the pre-render DOM, so the elements are the ones
  // currently on screen; the next render() then reflects the new state.
  function animateAttack(atkEl, defEl, dir, floatText, ko) {
    return new Promise((resolve) => {
      if (!atkEl || !defEl) return resolve();
      atkEl.classList.add(dir === "up" ? "tcg-lunge-up" : "tcg-lunge-down");
      setTimeout(() => { defEl.classList.add("tcg-hit"); floatDamage(defEl, floatText, ko); }, 170);
      setTimeout(resolve, 620);
    });
  }

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
      // delay so the player's turn is live the instant it begins. On an attack,
      // animate the AI's strike on the current (pre-render) DOM first.
      await aiTakeTurn(state, "ai", async ({ text } = {}) => {
        if (text === "attacks") {
          const atkEl = document.querySelector(".tcg-active-ai .tcg-card[data-uid]");
          const defEl = document.querySelector(".tcg-active-player .tcg-card[data-uid]");
          const dmg = lastDamageFromLog();
          await animateAttack(atkEl, defEl, "down", dmg != null ? `−${dmg}` : null, false);
        }
        render();
        if (state.activePlayer === "ai") await delay(620);
      });
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

  function finish() {
    if (state.winner === "player" && !rewarded) { rewarded = true; collection.addPacks(1); }
    render();
  }

  // ---- rendering --------------------------------------------------------

  function render() {
    const p = state.players.player, a = state.players.ai;
    arena.innerHTML = "";
    const board = eln("div", "tcg-board");
    const mat = eln("div", "tcg-mat");

    // Left rail: prizes + deck + discard for both players, freeing vertical
    // space in the field so the Bench is fully visible.
    mat.appendChild(renderRail(a, p));

    const field = eln("div", "tcg-field");
    field.appendChild(renderNameBar(a, "ai"));
    field.appendChild(renderHandFan(a));
    field.appendChild(renderRow(a.bench, "ai"));
    field.appendChild(renderActiveRow(a.active, "ai"));
    field.appendChild(renderCenter());
    field.appendChild(renderActiveRow(p.active, "player"));
    field.appendChild(renderRow(p.bench, "player"));
    field.appendChild(renderNameBar(p, "player"));
    mat.appendChild(field);
    board.appendChild(mat);
    // Hand + controls live in a dock pinned to the bottom of the viewport, so
    // your hand is always visible while the field scrolls above it.
    const dock = eln("div", "tcg-dock");
    dock.appendChild(renderHand(p));
    dock.appendChild(renderActionBar(p));
    board.appendChild(dock);
    // Play log floats at the right-middle of the screen (out of the way of the
    // hand and controls at the bottom).
    board.appendChild(renderLog());

    // NOTE: the click handler is a single delegated listener on #arena added
    // once in startTcgMatch — NOT re-added per board here.
    arena.appendChild(board);
    if (state.winner) arena.appendChild(renderGameOver());
  }

  // Prize cards as face-down Pokéball cards (the real win-track — 6 to take)
  // plus deck + discard stacks, laid out vertically for the left rail.
  function railHalf(s, side) {
    let prizes = "";
    for (let i = 0; i < engine.PRIZE_COUNT; i++) {
      prizes += i < s.prizes.length
        ? `<span class="tcg-prize-card">${pokeballSVG()}</span>`
        : `<span class="tcg-prize-card empty"></span>`;
    }
    const deck = `<div class="tcg-pile" title="${s.deck.length} cards in deck">
      <div class="tcg-pile-stack">${pokeballSVG()}</div><span class="tcg-pile-n">${s.deck.length}</span></div>`;
    const discard = `<div class="tcg-pile${s.discard.length ? "" : " empty"}" title="${s.discard.length} cards in discard">
      <div class="tcg-pile-discard">${pileSVG("discard")}</div><span class="tcg-pile-n">${s.discard.length}</span></div>`;
    return `<div class="tcg-rail-half tcg-rail-${side}">
      <div class="tcg-rail-label">Prizes</div>
      <div class="tcg-rail-prizes" title="${s.prizes.length} Prizes left">${prizes}</div>
      <div class="tcg-rail-piles">${deck}${discard}</div>
    </div>`;
  }

  function renderRail(a, p) {
    const rail = eln("div", "tcg-rail");
    rail.innerHTML = railHalf(a, "ai") + `<div class="tcg-rail-mid"></div>` + railHalf(p, "player");
    return rail;
  }

  // Compact name bar (whose turn); opponent's also shows hand count.
  function renderNameBar(s, side) {
    const bar = eln("div", `tcg-namebar tcg-namebar-${side}`);
    const nameCls = state.activePlayer === side && !state.winner ? " active" : "";
    const hand = side === "ai"
      ? `<span class="tcg-hand-count" title="${s.hand.length} cards in hand">${pileSVG("hand")}${s.hand.length}</span>`
      : "";
    bar.innerHTML = `<span class="tcg-strip-name${nameCls}">${side === "ai" ? s.name : "You"}</span>${hand}`;
    return bar;
  }

  // Opponent's hand as a fanned row of face-down card backs (shows hand size).
  function renderHandFan(s) {
    const fan = eln("div", "tcg-hand-fan");
    const n = Math.min(s.hand.length, 8);
    for (let i = 0; i < n; i++) {
      const c = eln("div", "tcg-fan-card", pokeballSVG());
      const spread = i - (n - 1) / 2;
      c.style.setProperty("--rot", `${spread * 4}deg`);
      c.style.setProperty("--x", `${spread * 15}px`);
      c.style.setProperty("--y", `${Math.abs(spread) * 2}px`);
      fan.appendChild(c);
    }
    return fan;
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
    if (state.stadium) c.appendChild(eln("div", "tcg-stadium", `${trainerSVG("stadium")}${state.stadium.card.name}`));
    return c;
  }

  function renderHand(p) {
    const wrap = eln("div", "tcg-hand-wrap");
    const hand = eln("div", "tcg-hand");
    // Drive the fan/overlap amount from hand size (see .tcg-hand[data-size] CSS)
    // so a big hand (e.g. after Professor's Research) stays on one row instead
    // of a long scroll; hovering/selecting a card lifts it clear of the stack.
    const n = p.hand.length;
    hand.dataset.size = String(Math.min(n, 14));
    if (n) wrap.appendChild(eln("div", "tcg-hand-label", `Your hand · ${n}`));
    p.hand.forEach((card, i) => {
      const c = renderTcgCard(card, { size: "full" });
      c.dataset.zone = "hand"; c.dataset.handIndex = i;
      // Arc fan (like the main battle game): rotate outward and dip the edge
      // cards down, pivoting from the bottom.
      const t = n > 1 ? i / (n - 1) - 0.5 : 0; // -0.5 .. 0.5
      c.style.setProperty("--fan-rot", `${(t * Math.min(n * 3.2, 20)).toFixed(2)}deg`);
      c.style.setProperty("--fan-y", `${(Math.abs(t) * Math.min(n * 2.4, 16)).toFixed(1)}px`);
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
        const acts = engine.canAct(p.active);
        p.active.card.attacks.forEach((atk, i) => {
          const can = acts && engine.affordableAttacks(p.active).includes(atk) && !state.noAttack;
          const cost = (atk.cost || []).map((t) => energyBadge(t, "pip-cost")).join("");
          const b = eln("button", `tcg-atk-btn${can ? "" : " disabled"}`,
            `<span class="tcg-cost">${cost}</span> <span class="tcg-atk-btn-name">${atk.name}</span>${atk.damage ? `<span class="tcg-atk-btn-dmg">${atk.damage}</span>` : ""}`);
          if (can) { b.dataset.action = "attack"; b.dataset.i = i; }
          list.appendChild(b);
        });
        bar.appendChild(list);
        if (state.noAttack) bar.appendChild(eln("div", "tcg-note", "The player going first can't attack on turn 1."));
        else if (!acts) bar.appendChild(eln("div", "tcg-note", `${p.active.card.name} is ${p.active.status.kind} and can't attack — end your turn.`));
        const canRetreat = acts && p.active && p.bench.length && !p.retreatedThisTurn && p.active.attached.length >= (p.active.card.retreat || 0);
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
        if (p.active) btns.appendChild(button("Attack", "open-attacks"));
        btns.appendChild(button("End Turn ›", "end-turn", "primary"));
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
    card.appendChild(eln("div", "tcg-go-title", won ? `${trophySVG()} You win!` : "Defeated"));
    card.appendChild(eln("div", "tcg-go-sub", won
      ? "You knocked out your rival's team."
      : "Your rival cleared the field. Try another deck!"));
    if (won) {
      const reward = eln("div", "tcg-go-reward", `${pokeballSVG()} You earned a Booster Pack!`);
      card.appendChild(reward);
    }
    const row = eln("div", "tcg-go-btns");
    if (won) {
      const open = button("Open Pack", "open-reward-pack", "primary");
      open.onclick = () => openPack({ onDone: () => render() });
      row.appendChild(open);
      row.appendChild(button("Play again", "again", "ghost"));
    } else {
      row.appendChild(button("Play again", "again", "primary"));
    }
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
