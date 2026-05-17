// Leaderboard overlay. Top players by wins, with the current user's row
// highlighted (if signed in) and their rank shown.

let _onClose = null;

export async function open({ onClose } = {}) {
  _onClose = onClose;
  let overlay = document.querySelector(".lb-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "lb-overlay";
    document.body.appendChild(overlay);
  }
  overlay.classList.remove("hidden");
  overlay.innerHTML = `<div class="lb-loading">Loading rankings…</div>`;

  try {
    const res = await fetch("/api/leaderboard?limit=25");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { rows, me } = await res.json();
    render(overlay, rows, me);
  } catch (err) {
    overlay.innerHTML = `
      <div class="lb-error">
        Couldn't load the leaderboard: ${err.message || "unknown"}.
        <button class="lb-close">Close</button>
      </div>`;
    overlay.querySelector(".lb-close")?.addEventListener("click", close);
  }
}

export function close() {
  document.querySelector(".lb-overlay")?.classList.add("hidden");
  document.querySelector(".lb-overlay")?.remove();
  _onClose?.();
}

function render(overlay, rows, me) {
  const myRank = me ? rows.findIndex((r) => r.user_id === me.user_id) + 1 : 0;
  const meInTopList = myRank > 0;

  overlay.innerHTML = `
    <div class="lb-card">
      <header class="lb-header">
        <div class="lb-title">Global Leaderboard</div>
        <button class="lb-x">✕</button>
      </header>
      ${me ? `
        <div class="lb-mystats">
          <div class="lb-mystat"><span>You</span><strong>${escape(me.display_name)}</strong></div>
          <div class="lb-mystat"><span>Rank</span><strong>${meInTopList ? `#${myRank}` : "—"}</strong></div>
          <div class="lb-mystat"><span>W / L</span><strong>${me.wins} / ${me.losses}</strong></div>
          <div class="lb-mystat"><span>Win %</span><strong>${me.win_pct ?? 0}%</strong></div>
          <div class="lb-mystat"><span>Cards</span><strong>${me.cards_owned ?? 0}</strong></div>
        </div>
      ` : `
        <div class="lb-anon">Sign in to track your rank.</div>
      `}
      <div class="lb-table">
        <div class="lb-row lb-head">
          <span class="lb-rank">#</span>
          <span class="lb-name">Trainer</span>
          <span class="lb-cell">Lvl</span>
          <span class="lb-cell">Wins</span>
          <span class="lb-cell">Losses</span>
          <span class="lb-cell">Win %</span>
          <span class="lb-cell">Cards</span>
        </div>
        ${rows.length === 0
          ? `<div class="lb-empty">No matches played yet — be the first.</div>`
          : rows.map((r, i) => `
              <div class="lb-row ${me && r.user_id === me.user_id ? "is-me" : ""}">
                <span class="lb-rank">#${i + 1}</span>
                <span class="lb-name">${escape(r.display_name)}</span>
                <span class="lb-cell"><span class="lb-level-chip">L${r.trainer_level || 1}</span></span>
                <span class="lb-cell">${r.wins}</span>
                <span class="lb-cell">${r.losses}</span>
                <span class="lb-cell">${r.win_pct}%</span>
                <span class="lb-cell">${r.cards_owned}</span>
              </div>
            `).join("")
        }
      </div>
    </div>
  `;
  overlay.querySelector(".lb-x").addEventListener("click", close);
}

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
