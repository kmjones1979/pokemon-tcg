// Achievements & match-history overlays + toast notifications for newly
// unlocked achievements after a match ends.

let _onCloseAch = null;
let _onCloseMatches = null;
let _lastSeen = new Set();
try {
  _lastSeen = new Set(
    JSON.parse(localStorage.getItem("pokemon-tcg-seen-achievements") || "[]"),
  );
} catch {}

function persistSeen() {
  try {
    localStorage.setItem(
      "pokemon-tcg-seen-achievements",
      JSON.stringify([..._lastSeen]),
    );
  } catch {}
}

export async function openAchievements({ onClose } = {}) {
  _onCloseAch = onClose;
  const overlay = ensure(".ach-overlay");
  overlay.classList.remove("hidden");
  overlay.innerHTML = `<div class="ach-loading">Loading achievements…</div>`;
  try {
    const res = await fetch("/me/achievements");
    if (!res.ok) throw new Error(res.statusText);
    const { unlocked, locked } = await res.json();
    // Mark everything in `unlocked` as seen so the toast won't re-fire later
    for (const a of unlocked) _lastSeen.add(a.id);
    persistSeen();
    renderAch(overlay, unlocked, locked);
  } catch (err) {
    overlay.innerHTML = `<div class="ach-err">Couldn't load: ${err.message}</div>`;
  }
}

export function closeAchievements() {
  document.querySelector(".ach-overlay")?.remove();
  _onCloseAch?.();
}

export async function openMatchHistory({ onClose } = {}) {
  _onCloseMatches = onClose;
  const overlay = ensure(".mh-overlay");
  overlay.classList.remove("hidden");
  overlay.innerHTML = `<div class="mh-loading">Loading matches…</div>`;
  try {
    const res = await fetch("/me/matches");
    if (!res.ok) throw new Error(res.statusText);
    const { matches } = await res.json();
    renderMatches(overlay, matches);
  } catch (err) {
    overlay.innerHTML = `<div class="mh-err">Couldn't load: ${err.message}</div>`;
  }
}

export function closeMatchHistory() {
  document.querySelector(".mh-overlay")?.remove();
  _onCloseMatches?.();
}

// Called after each game-over to detect newly unlocked achievements.
// Shows a toast for each new one.
export async function checkForNewUnlocks() {
  try {
    const res = await fetch("/me/achievements");
    if (!res.ok) return;
    const { unlocked } = await res.json();
    const fresh = unlocked.filter((a) => !_lastSeen.has(a.id));
    for (const a of fresh) {
      _lastSeen.add(a.id);
      showAchToast(a);
    }
    persistSeen();
  } catch {}
}

function showAchToast(a) {
  const el = document.createElement("div");
  el.className = "ach-toast";
  el.innerHTML = `
    <div class="ach-toast-icon">${a.icon}</div>
    <div class="ach-toast-body">
      <div class="ach-toast-title">Achievement unlocked</div>
      <div class="ach-toast-name">${escape(a.name)}</div>
      <div class="ach-toast-desc">${escape(a.description)}</div>
    </div>
  `;
  document.body.appendChild(el);
  // Stack new toasts
  const stack = document.querySelectorAll(".ach-toast");
  stack.forEach((t, i) => (t.style.bottom = `${24 + i * 92}px`));
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 400);
  }, 4200);
}

function ensure(cls) {
  let el = document.querySelector(cls);
  if (el) return el;
  el = document.createElement("div");
  el.className = `${cls.slice(1)} ach-shell`;
  document.body.appendChild(el);
  return el;
}

function renderAch(overlay, unlocked, locked) {
  overlay.innerHTML = `
    <div class="ach-card">
      <header class="ach-header">
        <div class="ach-title">Achievements</div>
        <div class="ach-sub">${unlocked.length}/${unlocked.length + locked.length} unlocked</div>
        <button class="ach-x">✕</button>
      </header>
      <div class="ach-grid">
        ${[...unlocked.map((a) => row(a, true)), ...locked.map((a) => row(a, false))].join("")}
      </div>
    </div>
  `;
  overlay.querySelector(".ach-x").addEventListener("click", closeAchievements);
}

function row(a, isUnlocked) {
  const pct = Math.min(100, Math.round((a.progress / a.goal) * 100));
  return `
    <div class="ach-row ${isUnlocked ? "unlocked" : "locked"}">
      <div class="ach-icon">${a.icon}</div>
      <div class="ach-body">
        <div class="ach-name">${escape(a.name)}</div>
        <div class="ach-desc">${escape(a.description)}</div>
        <div class="ach-bar"><div class="ach-bar-fill" style="width:${pct}%"></div></div>
        <div class="ach-prog">${a.progress}/${a.goal}</div>
      </div>
    </div>
  `;
}

function renderMatches(overlay, matches) {
  overlay.innerHTML = `
    <div class="mh-card">
      <header class="mh-header">
        <div class="mh-title">Match History</div>
        <button class="mh-x">✕</button>
      </header>
      ${matches.length === 0
        ? `<div class="mh-empty">No matches played yet. Tap "Find online match" to play your first.</div>`
        : `<div class="mh-list">${matches.map(matchRow).join("")}</div>`}
    </div>
  `;
  overlay.querySelector(".mh-x").addEventListener("click", closeMatchHistory);
}

function matchRow(m) {
  const when = m.endedAt ? timeAgo(m.endedAt) : "in progress";
  const verdict = m.endedAt
    ? m.iWon
      ? `<span class="mh-win">Win</span>`
      : `<span class="mh-loss">Loss</span>`
    : `<span class="mh-pending">…</span>`;
  return `
    <div class="mh-row">
      <span class="mh-verdict">${verdict}</span>
      <span class="mh-opp">vs ${escape(m.opponent || "Unknown")}</span>
      <span class="mh-meta">${m.turns} turn${m.turns === 1 ? "" : "s"} · ${m.reason || "—"}</span>
      <span class="mh-when">${when}</span>
    </div>
  `;
}

function timeAgo(ts) {
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
