// Story Mode client — chapter hub, intro cutscene, battle UI, rewards.
//
// All story-mode UI lives in this module and is rendered into a single
// dynamically-created container `#story-stage`. The battle is server-
// authoritative; we POST actions and poll /api/story/match/:id between
// turns for the AI partner + boss responses.

import { renderCard } from "./cards.js";
import { TYPE_COLORS } from "./type-chart.js";
import * as rewards from "./rewards.js";
import { flashVerdict, fireAttackTrail, floatDamage, knockOut, shakeHit } from "./animations.js";
import { sfxAttack, sfxHit, sfxKO, sfxVictory, sfxDefeat, sfxCardPlay, sfxCrit } from "./audio.js";

let _current = null; // { matchId, playerId, view, mode, lastV, pollHandle }
let _stage = null;   // root DOM node for the story screen

function ensureStage() {
  if (_stage) return _stage;
  _stage = document.createElement("section");
  _stage.id = "story-stage";
  document.body.appendChild(_stage);
  return _stage;
}

function clearStage() {
  if (_stage) _stage.innerHTML = "";
}

function escape(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
}

// ----- Public entry --------------------------------------------------------

export async function openStoryHub({ currentUser } = {}) {
  ensureStage();
  document.body.classList.add("in-story");
  _stage.classList.remove("hidden");
  _stage.innerHTML = `<div class="story-loading">Loading story…</div>`;
  if (!currentUser) {
    _stage.innerHTML = `
      <div class="story-hub">
        <button class="story-back" data-action="close">✕ Back</button>
        <h1 class="story-title">Story Mode</h1>
        <p class="story-empty">Sign in to play Story Mode and save your progress.</p>
      </div>`;
    _stage.querySelector("[data-action=close]").addEventListener("click", closeStory);
    return;
  }
  try {
    const r = await fetch("/api/story/chapters");
    const { chapters, progress } = await r.json();
    renderHub(chapters, progress);
  } catch (err) {
    _stage.innerHTML = `<div class="story-error">Couldn't load story: ${escape(err.message)}</div>`;
  }
}

export function closeStory() {
  if (_current?.pollHandle) clearInterval(_current.pollHandle);
  _current = null;
  document.body.classList.remove("in-story");
  if (_stage) _stage.classList.add("hidden");
  if (_stage) _stage.innerHTML = "";
  // Restore menu/arena visibility.
  const menu = document.getElementById("menu");
  if (menu) menu.classList.remove("hidden");
}

// ----- Hub (chapter select) -----------------------------------------------

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
            ? `<button class="primary" data-act="solo" data-chapter="${c.id}">▸ Solo (with AI partner)</button>
               <button class="ghost" data-act="host" data-chapter="${c.id}">Host 2-player</button>
               <button class="ghost" data-act="join">Join code</button>`
            : `<span class="chapter-tag locked-tag">🔒 Complete chapter ${c.chapterNumber - 1} first</span>`}
        </div>
      </div>`;
  }).join("");
  _stage.innerHTML = `
    <div class="story-hub">
      <button class="story-back" data-action="close">✕ Close</button>
      <h1 class="story-title">Story Mode</h1>
      <p class="story-sub">A four-chapter co-op campaign. Play solo with an AI partner, or invite a friend with a private code.</p>
      <div class="chapter-grid">${cards}</div>
    </div>`;
  _stage.querySelector("[data-action=close]").addEventListener("click", closeStory);
  _stage.querySelectorAll("[data-act=solo]").forEach((b) =>
    b.addEventListener("click", () => startSolo(b.dataset.chapter)));
  _stage.querySelectorAll("[data-act=host]").forEach((b) =>
    b.addEventListener("click", () => hostCoop(b.dataset.chapter)));
  _stage.querySelectorAll("[data-act=join]").forEach((b) =>
    b.addEventListener("click", () => joinCoop()));
}

// ----- Intro cutscene -----------------------------------------------------

async function playIntro(chapter, onDone) {
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
  skip.addEventListener("click", () => { cancelled = true; onDone(); });
  for (let i = 0; i < lines.length; i++) {
    if (cancelled) return;
    const el = document.createElement("div");
    el.className = "intro-line";
    el.textContent = lines[i];
    out.appendChild(el);
    await new Promise((r) => setTimeout(r, 1200));
  }
  if (!cancelled) {
    skip.textContent = "Begin battle ▸";
    skip.classList.add("ready");
  }
}

// ----- Start sessions -----------------------------------------------------

async function startSolo(chapterId) {
  ensureStage();
  _stage.innerHTML = `<div class="story-loading">Loading chapter…</div>`;
  // Fetch chapter intro from the meta endpoint (already fetched in hub but we
  // need the intro lines too — re-fetch is cheap).
  const metaRes = await fetch("/api/story/chapters");
  const { chapters } = await metaRes.json();
  const meta = chapters.find((c) => c.id === chapterId);
  // Intro lines live in the server module's CHAPTERS — request via a tiny
  // dedicated endpoint? For simplicity we hardcode a fallback if missing.
  const intro = await fetch(`/api/story/chapter/${chapterId}/intro`).then((r) => r.ok ? r.json() : null).catch(() => null);
  const chapter = { ...meta, intro: intro?.intro || meta.intro || [] };

  await new Promise((resolve) => playIntro(chapter, resolve));

  const r = await fetch("/api/story/start-solo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chapterId, deckSource: "active" }),
  });
  const data = await r.json();
  if (!r.ok) {
    _stage.innerHTML = `<div class="story-error">${escape(data.error || "Couldn't start chapter.")}</div>`;
    return;
  }
  _current = {
    matchId: data.view.matchId,
    playerId: data.playerId,
    view: data.view,
    mode: "solo",
    lastV: data.view.v,
  };
  renderBattle();
}

async function hostCoop(chapterId) {
  const r = await fetch("/api/story/host", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chapterId, deckSource: "active" }),
  });
  const data = await r.json();
  if (!r.ok) { flashVerdict(data.error || "Couldn't host.", "weak"); return; }
  const code = data.code;
  _stage.innerHTML = `
    <div class="story-wait">
      <button class="story-back" data-action="close">✕ Cancel</button>
      <h1 class="story-title">Co-op room ready</h1>
      <div class="room-code">${escape(code)}</div>
      <p>Share this code with a friend. The chapter begins once they join.</p>
      <div class="story-waiting-dots">Waiting<span>.</span><span>.</span><span>.</span></div>
    </div>`;
  _stage.querySelector("[data-action=close]").addEventListener("click", () => {
    if (_current?.pollHandle) clearInterval(_current.pollHandle);
    closeStory();
  });
  // Poll for the host's player record being bound to a match.
  let attempts = 0;
  _current = { pollHandle: null };
  _current.pollHandle = setInterval(async () => {
    attempts++;
    if (attempts > 120) { clearInterval(_current.pollHandle); flashVerdict("Room expired.", "weak"); closeStory(); return; }
    try {
      const me = await fetch("/auth/me").then((r) => r.ok ? r.json() : null);
      if (!me?.id) return;
      // Bound matches by host id — query via match-status (we re-use the host's id as playerId)
      const sres = await fetch(`/api/story/match-status?playerId=${encodeURIComponent(me.id)}`).catch(() => null);
      if (sres?.ok) {
        const sd = await sres.json();
        if (sd.state === "matched") {
          clearInterval(_current.pollHandle);
          _current = { matchId: sd.view.matchId, playerId: me.id, view: sd.view, mode: "coop", lastV: sd.view.v };
          renderBattle();
        }
      }
    } catch {}
  }, 1500);
}

async function joinCoop() {
  const code = (prompt("Enter co-op room code:") || "").trim().toUpperCase();
  if (!code) return;
  const r = await fetch("/api/story/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, deckSource: "active" }),
  });
  const data = await r.json();
  if (!r.ok) { flashVerdict(data.error || "Couldn't join.", "weak"); return; }
  _current = { matchId: data.view.matchId, playerId: data.playerId, view: data.view, mode: "coop", lastV: data.view.v };
  renderBattle();
}

// ----- Battle UI ----------------------------------------------------------

function renderBattle() {
  const v = _current.view;
  if (!v) return;
  const boss = v.boss;
  const me = v.youAre;
  const partner = me === "p1" ? "p2" : "p1";
  const myP = v.players[me];
  const partnerP = v.players[partner];
  const bossPct = Math.round((boss.hp / boss.maxHp) * 100);
  const bossType = TYPE_COLORS[boss.types?.[0]] || "#999";
  const bossSpriteUrl = boss.anchorPokemonId
    ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${boss.anchorPokemonId}.png`
    : null;
  const phaseTag = boss.phaseIndex > 0 ? `<span class="boss-phase">PHASE ${boss.phaseIndex + 1}</span>` : "";

  _stage.innerHTML = `
    <div class="story-battle">
      <header class="story-header">
        <div class="story-loc">${escape(v.chapter.locale)}</div>
        <div class="story-turn">Turn ${v.turn} · ${turnLabel(v.activeSide, me)}</div>
        <button class="story-concede" data-action="concede">Concede</button>
      </header>

      <div class="boss-banner" style="--type:${bossType}">
        ${bossSpriteUrl ? `<img class="boss-sprite" src="${bossSpriteUrl}" alt="${escape(boss.displayName)}">` : ""}
        <div class="boss-info">
          <div class="boss-name-row">
            <span class="boss-name">${escape(boss.displayName)}</span>
            ${phaseTag}
          </div>
          <div class="boss-hp-bar"><div class="boss-hp-fill" style="width:${bossPct}%"></div></div>
          <div class="boss-hp-text">${boss.hp} / ${boss.maxHp} HP</div>
        </div>
        ${boss.minions?.length ? `
          <div class="boss-minions">
            ${boss.minions.map((m, i) => `
              <button class="minion" data-target-minion="${i}">
                <div class="minion-name">${escape(m.name)}</div>
                <div class="minion-hp">${m.currentHp}</div>
              </button>
            `).join("")}
          </div>` : ""}
      </div>

      <div class="party-row">
        ${renderPlayerPanel(myP, me, "me", v.activeSide === me)}
        ${renderPlayerPanel(partnerP, partner, "partner", v.activeSide === partner)}
      </div>

      <div class="story-log">
        ${v.log.slice(-5).map((l) => `<div class="log-line log-${l.kind}">${escape(l.text)}</div>`).join("")}
      </div>

      <div class="hand-row">
        ${renderHand(myP, me, v.activeSide === me)}
      </div>

      <div class="story-actionbar">
        <button class="primary" data-action="end-turn" ${v.activeSide === me && !v.winner ? "" : "disabled"}>End turn</button>
      </div>
    </div>`;

  wireBattleHandlers();
  if (v.winner) handleGameOver();
  // Solo: server already ran partner + boss after our last end-turn. Just
  // render. No need to poll for solo. Coop: poll for partner's actions.
  if (_current.mode === "coop" && !v.winner) startCoopPoll();
}

function renderPlayerPanel(p, side, role, isActive) {
  return `
    <div class="player-panel ${role} ${isActive ? "active-turn" : ""}">
      <div class="player-row">
        <span class="player-name">${escape(p.displayName)}</span>
        <span class="player-hp"><span class="hp-pip">❤</span>${p.trainerHp}/${p.maxTrainerHp}</span>
        <span class="player-energy">⚡ ${p.energy}/${p.maxEnergy}</span>
      </div>
      <div class="field-row" data-side="${side}">
        ${(p.field || []).map((inst, slot) => {
          if (!inst) return `<div class="field-slot empty" data-slot="${slot}"></div>`;
          const hpPct = Math.round((inst.currentHp / inst.maxHp) * 100);
          const type = inst.card?.types?.[0] || "normal";
          return `
            <div class="field-slot occupied type-${type}" data-slot="${slot}" data-side="${side}" ${role === "me" ? `draggable="true"` : ""}>
              <div class="field-card-name">${escape(inst.card?.name || "")}</div>
              <div class="field-card-hp">${inst.currentHp}/${inst.maxHp}</div>
              <div class="field-card-bar"><div class="field-card-bar-fill" style="width:${hpPct}%"></div></div>
            </div>`;
        }).join("")}
      </div>
    </div>`;
}

function renderHand(p, side, canAct) {
  return (p.hand || []).map((card, i) => {
    if (card?.hidden) return `<div class="hand-card hidden">·</div>`;
    const type = card.types?.[0] || "normal";
    const tcol = TYPE_COLORS[type] || "#999";
    return `
      <button class="hand-card type-${type}" data-hand="${i}" ${canAct ? "" : "disabled"} style="--type:${tcol}">
        <div class="hc-name">${escape(card.name)}</div>
        <div class="hc-stats">⚡${card.energyCost} · ⚔${card.cardAttack} · ❤${card.cardHp}</div>
      </button>`;
  }).join("");
}

function turnLabel(activeSide, me) {
  if (activeSide === me) return "YOUR TURN";
  if (activeSide === "boss") return "BOSS";
  return "PARTNER";
}

function wireBattleHandlers() {
  _stage.querySelector("[data-action=concede]")?.addEventListener("click", () => {
    if (!confirm("Concede the chapter?")) return;
    sendAction("concede", {});
  });
  _stage.querySelector("[data-action=end-turn]")?.addEventListener("click", () => sendAction("end-turn", {}));

  // Click hand → play card.
  _stage.querySelectorAll(".hand-card[data-hand]").forEach((btn) => {
    btn.addEventListener("click", () => sendAction("play-card", { handIndex: Number(btn.dataset.hand) }));
  });

  // Click own field card → select attacker (highlight). Click boss/minion → attack.
  let selectedSlot = null;
  _stage.querySelectorAll('.player-panel.me .field-slot.occupied').forEach((slot) => {
    slot.addEventListener("click", () => {
      _stage.querySelectorAll('.player-panel.me .field-slot.occupied').forEach((s) => s.classList.remove("selected-attacker"));
      slot.classList.add("selected-attacker");
      selectedSlot = Number(slot.dataset.slot);
    });
  });
  _stage.querySelector(".boss-banner")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-target-minion]")) return;
    if (selectedSlot == null) { flashVerdict("Click your own card first", "weak"); return; }
    sendAction("attack", { fromSlot: selectedSlot, target: { kind: "boss" } });
    selectedSlot = null;
  });
  _stage.querySelectorAll("[data-target-minion]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (selectedSlot == null) { flashVerdict("Click your own card first", "weak"); return; }
      sendAction("attack", { fromSlot: selectedSlot, target: { kind: "minion", index: Number(btn.dataset.targetMinion) } });
      selectedSlot = null;
    });
  });
}

let _coopPollHandle = null;
function startCoopPoll() {
  if (_coopPollHandle) clearInterval(_coopPollHandle);
  _coopPollHandle = setInterval(async () => {
    if (!_current?.matchId) { clearInterval(_coopPollHandle); return; }
    try {
      const r = await fetch(`/api/story/match/${_current.matchId}?playerId=${encodeURIComponent(_current.playerId)}&since=${_current.lastV}`);
      if (r.status === 204) return;
      if (!r.ok) return;
      const { view } = await r.json();
      _current.view = view;
      _current.lastV = view.v;
      renderBattle();
    } catch {}
  }, 1500);
}

async function sendAction(action, payload) {
  if (!_current?.matchId) return;
  try {
    const r = await fetch(`/api/story/match/${_current.matchId}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId: _current.playerId, action, payload }),
    });
    const data = await r.json();
    if (!r.ok) { flashVerdict(data.error || "Action failed.", "weak"); return; }
    _current.view = data.view;
    _current.lastV = data.view.v;
    // Animate partner actions playback (solo mode).
    if (data.partnerActions?.length && _current.mode === "solo") {
      await playPartnerSequence(data.partnerActions);
    }
    renderBattle();
  } catch (err) {
    flashVerdict("Network error.", "weak");
  }
}

async function playPartnerSequence(actions) {
  for (const a of actions) {
    if (a.kind === "play") {
      sfxCardPlay();
      flashVerdict(`Partner: ${a.cardName || ""}`, "weak");
    } else if (a.kind === "attack") {
      sfxAttack();
      if (a.critical) sfxCrit();
    }
    await new Promise((r) => setTimeout(r, 600));
  }
}

// ----- Game over + rewards ------------------------------------------------

function handleGameOver() {
  if (_coopPollHandle) { clearInterval(_coopPollHandle); _coopPollHandle = null; }
  const v = _current.view;
  const won = v.winner === "team";
  setTimeout(() => won ? sfxVictory() : sfxDefeat(), 200);
  setTimeout(() => {
    const overlay = document.createElement("div");
    overlay.className = "story-gameover";
    overlay.innerHTML = `
      <div class="story-gameover-card ${won ? "win" : "loss"}">
        <h1>${won ? "Chapter cleared!" : "Defeated"}</h1>
        <p>${won ? "Your team prevailed against " + escape(v.boss.displayName) + "." : "Try again — adjust your deck or strategy."}</p>
        <button class="primary" data-action="hub">Back to Story Hub</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("[data-action=hub]").addEventListener("click", () => {
      overlay.remove();
      // Re-fetch chapters to reflect new unlocks.
      openStoryHub({ currentUser: { id: _current.playerId } });
    });
    if (won && v.rewardOffer) {
      setTimeout(() => {
        rewards.showOffer(v.rewardOffer, {
          didWin: true,
          onClaim: (card) => { if (card) flashVerdict(`+${card.name}!`, "super"); },
        });
      }, 800);
    }
  }, 400);
}
