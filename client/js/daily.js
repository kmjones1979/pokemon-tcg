// Daily Boss — the viral hook. Same fight for every player on a given UTC
// day, one attempt, and a shareable result.
//
// This module owns the "today's daily" landing card on the home screen
// plus the launch flow.  Match itself runs through the regular arena via
// the same startBossFight hook story-mode uses.

import { flashVerdict } from "./animations.js";

export const daily = { hooks: null };
export function setHooks(h) { daily.hooks = h; }

let _today = null;
let _lastResult = null; // { shareText, shareUrl, dayNumber, stars, bossName }

export async function loadToday() {
  try {
    const r = await fetch("/api/daily/today");
    if (!r.ok) return null;
    _today = await r.json();
    return _today;
  } catch {
    return null;
  }
}

export async function renderDailyCard(targetEl, { currentUser } = {}) {
  if (!targetEl) return;
  const today = await loadToday();
  if (!today) {
    targetEl.innerHTML = "";
    return;
  }
  const sprite = today.boss.anchorPokemonId
    ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${today.boss.anchorPokemonId}.png`
    : null;
  const playedTag = today.alreadyPlayed
    ? `<div class="daily-result-line">${today.alreadyPlayed.won ? "✅ Cleared today" : "❌ Defeated today"} — ${today.alreadyPlayed.turns} turns · ${today.alreadyPlayed.hp_left} HP left</div>`
    : "";
  const stats = await fetch("/api/daily/stats").then((r) => r.ok ? r.json() : null).catch(() => null);
  const statsLine = stats ? `<div class="daily-stats-line">🌍 ${stats.todayPlayed.toLocaleString()} trainer${stats.todayPlayed === 1 ? "" : "s"} attempted today · ${stats.todayWon.toLocaleString()} won</div>` : "";

  targetEl.innerHTML = `
    <div class="daily-card">
      <div class="daily-card-bg">${sprite ? `<img src="${sprite}" alt="" loading="lazy">` : ""}</div>
      <div class="daily-card-body">
        <div class="daily-card-tag">Daily Challenge #${today.dayNumber}</div>
        <div class="daily-card-boss">${today.boss.displayName}</div>
        <div class="daily-card-sub">One attempt today · ${today.boss.maxHp} HP boss</div>
        ${playedTag}
        ${statsLine}
        <div class="daily-card-actions">
          ${today.alreadyPlayed
            ? `<button class="primary" data-act="leaderboard">View leaderboard ▸</button>
               <button class="ghost"   data-act="share">📋 Share my result</button>`
            : `<button class="primary" data-act="fight" ${currentUser ? "" : "disabled title=\"Sign in to play the daily\""}>
                 ${currentUser ? "Take the challenge ▸" : "Sign in to play"}
               </button>
               <button class="ghost" data-act="leaderboard">Leaderboard</button>`}
        </div>
      </div>
    </div>`;

  targetEl.querySelector("[data-act=fight]")?.addEventListener("click", () => startDailyFight());
  targetEl.querySelector("[data-act=leaderboard]")?.addEventListener("click", () => openLeaderboard());
  targetEl.querySelector("[data-act=share]")?.addEventListener("click", () => shareLastResult());
}

async function startDailyFight() {
  if (!daily.hooks?.startBossFight) {
    flashVerdict("Daily hook not initialised", "weak");
    return;
  }
  // Confirm — once you start, you've used today's attempt.
  if (!confirm("This is your one attempt today. Begin?")) return;
  let sessionId = null;
  try {
    const r = await fetch("/me/daily/start", { method: "POST" });
    const data = await r.json();
    if (!r.ok) { flashVerdict(data.error || "Couldn't start.", "weak"); return; }
    sessionId = data.sessionId;
  } catch (err) {
    flashVerdict("Network error.", "weak");
    return;
  }
  try {
    await daily.hooks.startBossFight({
      dailyMode: true,
      sessionId,
      chapter: {
        id: `daily-${_today.dayNumber}`,
        name: `Daily #${_today.dayNumber}`,
        locale: "TODAY'S CHALLENGE",
        enemyTrainerName: _today.boss.displayName,
        enemyAbility: _today.boss.ability || "lance",
      },
      boss: _today.boss,
      deck: _today.deck,
      phaseRules: _today.phaseRules,
      summonCards: _today.summonCards,
    });
  } catch (err) {
    flashVerdict(`Couldn't start: ${err.message || "unknown"}`, "weak");
  }
}

// Called from main.js when a daily match ends.
export async function finishDaily({ sessionId, won, turns, hpLeft, kos }) {
  if (!sessionId) return null;
  try {
    const r = await fetch("/me/daily/end", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, won, turns, hpLeft, kos }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    _lastResult = data;
    return data;
  } catch {
    return null;
  }
}

export function showShareDialog(result) {
  if (!result) return;
  _lastResult = result;
  document.querySelector(".share-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "share-overlay";
  const tweetText = encodeURIComponent(result.shareText);
  overlay.innerHTML = `
    <div class="share-card">
      <button class="share-close">✕</button>
      <h2 class="share-title">${result.shareText.split("\n")[0]}</h2>
      <pre class="share-string">${escape(result.shareText)}</pre>
      <div class="share-actions">
        <button class="primary" data-act="copy">📋 Copy result</button>
        <button class="ghost" data-act="native">📤 Share…</button>
      </div>
      <div class="share-socials">
        <a class="share-social tw" target="_blank" rel="noopener noreferrer"
           href="https://twitter.com/intent/tweet?text=${tweetText}">𝕏 / Twitter</a>
        <a class="share-social rd" target="_blank" rel="noopener noreferrer"
           href="https://www.reddit.com/submit?title=${encodeURIComponent(`Pokémon TCG Daily #${result.dayNumber}: ${result.bossName}`)}&url=${encodeURIComponent(result.shareUrl)}">Reddit</a>
        <a class="share-social wa" target="_blank" rel="noopener noreferrer"
           href="https://wa.me/?text=${tweetText}">WhatsApp</a>
        <a class="share-social tg" target="_blank" rel="noopener noreferrer"
           href="https://t.me/share/url?text=${tweetText}&url=${encodeURIComponent(result.shareUrl)}">Telegram</a>
      </div>
      <div class="share-foot">Come back tomorrow for a new boss!</div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector(".share-close").addEventListener("click", () => overlay.remove());
  overlay.querySelector("[data-act=copy]").addEventListener("click", () => copyToClipboard(result.shareText, overlay));
  overlay.querySelector("[data-act=native]").addEventListener("click", () => nativeShare(result));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
}

async function copyToClipboard(text, host) {
  try {
    await navigator.clipboard.writeText(text);
    const btn = host?.querySelector("[data-act=copy]");
    if (btn) { btn.textContent = "✓ Copied!"; setTimeout(() => btn.textContent = "📋 Copy result", 1800); }
  } catch {
    // Fallback for older browsers / non-HTTPS.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch {}
    ta.remove();
    flashVerdict("Copied", "super");
  }
}

async function nativeShare(result) {
  if (!navigator.share) { copyToClipboard(result.shareText); return; }
  try {
    await navigator.share({
      title: `Pokémon TCG Daily #${result.dayNumber}`,
      text: result.shareText,
      url: result.shareUrl,
    });
  } catch (err) {
    // User cancelled — that's fine.
  }
}

function shareLastResult() {
  if (_lastResult) { showShareDialog(_lastResult); return; }
  // Reconstruct from today's record if we don't have a stashed result.
  if (!_today?.alreadyPlayed) return;
  const p = _today.alreadyPlayed;
  const url = `${location.origin}/?d=${_today.dayNumber}`;
  const stars = p.won
    ? (p.turns <= 8 ? "★★★★★" : p.turns <= 12 ? "★★★★☆" : p.turns <= 18 ? "★★★☆☆" : "★★☆☆☆")
    : "💀";
  const text = p.won
    ? `Pokémon TCG Daily #${_today.dayNumber} · ${_today.boss.displayName}\n${stars}  ✅ ${p.turns} turn${p.turns === 1 ? "" : "s"} · ${p.hp_left} HP left\nplay: ${url}`
    : `Pokémon TCG Daily #${_today.dayNumber} · ${_today.boss.displayName}\n${stars}  ❌ Survived ${p.turns} turns\nplay: ${url}`;
  showShareDialog({ shareText: text, shareUrl: url, dayNumber: _today.dayNumber, stars, bossName: _today.boss.displayName });
}

async function openLeaderboard() {
  document.querySelector(".leaderboard-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "leaderboard-overlay";
  overlay.innerHTML = `<div class="leaderboard-card"><div class="lb-loading">Loading…</div></div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  try {
    const r = await fetch("/api/daily/leaderboard");
    const data = await r.json();
    overlay.querySelector(".leaderboard-card").innerHTML = `
      <button class="lb-close">✕</button>
      <h2>Daily #${data.dayNumber} Leaderboard</h2>
      ${!data.rows.length
        ? `<p class="lb-empty">No one has finished today's challenge yet — be the first!</p>`
        : `<table class="lb-table"><thead><tr><th>#</th><th>Trainer</th><th>Result</th><th>Turns</th><th>HP</th></tr></thead>
            <tbody>${data.rows.map((r) => `
              <tr class="${r.isYou ? "is-you" : ""}">
                <td>${r.rank}</td>
                <td>${escape(r.displayName)}${r.isYou ? " (you)" : ""}</td>
                <td>${r.won ? "✅" : "❌"}</td>
                <td>${r.turns}</td>
                <td>${r.hpLeft}</td>
              </tr>`).join("")}</tbody></table>`}
    `;
    overlay.querySelector(".lb-close").addEventListener("click", () => overlay.remove());
  } catch (err) {
    overlay.querySelector(".leaderboard-card").innerHTML = `<div class="lb-error">Couldn't load: ${escape(err.message)}</div>`;
  }
}

function escape(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
}
