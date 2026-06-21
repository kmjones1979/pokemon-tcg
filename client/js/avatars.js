// Trainer-avatar picker overlay.
//
// Opens from the account drawer's "Change avatar" button. Shows the
// full roster as a grid; unlocked avatars are tappable, locked ones
// display their level requirement so the player can see what's next.
//
// Public surface:
//   open({ onClose })       — show the picker
//   close()                 — hide it
//   getSelected()           — cached current selection (or null)
//   getRosterByKey(key)     — lookup helper for renderers (leaderboard,
//                             battle screen, math header) so they can
//                             resolve sprite/name without an extra fetch
//   prefetch()              — kick off the cache fill without rendering

let _onClose = null;
let _cache = null;   // { selected, unlocked, level, roster }
let _rosterByKey = new Map();
let _selectListeners = new Set();

export function getSelected() {
  return _cache?.selected || null;
}

export function getRosterByKey(key) {
  return _rosterByKey.get(key) || null;
}

export function onSelect(fn) {
  _selectListeners.add(fn);
  return () => _selectListeners.delete(fn);
}

async function loadState() {
  const res = await fetch("/me/avatars");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  _cache = await res.json();
  _rosterByKey = new Map((_cache.roster || []).map((r) => [r.key, r]));
  return _cache;
}

export async function prefetch() {
  if (_cache) return _cache;
  try { return await loadState(); } catch { return null; }
}

export async function open({ onClose } = {}) {
  _onClose = onClose;
  let overlay = document.querySelector(".avatar-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "avatar-overlay";
    document.body.appendChild(overlay);
  }
  overlay.classList.remove("hidden");
  overlay.innerHTML = `<div class="avatar-loading">Loading trainers…</div>`;

  try {
    await loadState();
    render(overlay);
  } catch (err) {
    overlay.innerHTML = `
      <div class="avatar-error">
        Couldn't load avatars: ${escape(err.message || "unknown")}.
        <button class="avatar-close-btn">Close</button>
      </div>`;
    overlay.querySelector(".avatar-close-btn")?.addEventListener("click", close);
  }
}

export function close() {
  const o = document.querySelector(".avatar-overlay");
  if (o) { o.classList.add("hidden"); o.remove(); }
  _onClose?.();
  _onClose = null;
}

function render(overlay) {
  const { selected, level, roster } = _cache;
  // Group roster by levelRequired so tiers render as labeled sections.
  const byTier = new Map();
  for (const a of roster) {
    if (!byTier.has(a.levelRequired)) byTier.set(a.levelRequired, []);
    byTier.get(a.levelRequired).push(a);
  }
  const tiers = [...byTier.keys()].sort((a, b) => a - b);

  overlay.innerHTML = `
    <div class="avatar-card">
      <header class="avatar-header">
        <div class="avatar-title">Choose your trainer</div>
        <button class="avatar-x" aria-label="Close">✕</button>
      </header>
      <div class="avatar-sub">You're trainer level <strong>${level}</strong>. New trainers unlock every 10 levels.</div>
      <div class="avatar-grid">
        ${tiers.map((tier) => {
          const all = byTier.get(tier);
          const anyUnlocked = all.some((a) => a.unlocked);
          return `
            <div class="avatar-tier ${anyUnlocked ? "" : "is-locked-tier"}">
              <div class="avatar-tier-label">Level ${tier}${tier === 1 ? " · Starter" : ""}</div>
              <div class="avatar-tier-row">
                ${all.map((a) => `
                  <button class="avatar-cell ${a.unlocked ? "is-unlocked" : "is-locked"} ${selected === a.key ? "is-selected" : ""}"
                          data-key="${escape(a.key)}"
                          ${a.unlocked ? "" : "disabled"}
                          title="${escape(a.name)} — ${escape(a.game)}">
                    <img class="avatar-img" src="${escape(a.sprite)}" alt="${escape(a.name)}" loading="lazy">
                    <div class="avatar-cell-name">${escape(a.name)}</div>
                    ${a.unlocked
                      ? (selected === a.key ? `<div class="avatar-cell-tag is-on">✓ Selected</div>` : `<div class="avatar-cell-tag">Tap to pick</div>`)
                      : `<div class="avatar-cell-tag">🔒 L${a.levelRequired}</div>`}
                  </button>
                `).join("")}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;

  overlay.querySelector(".avatar-x")?.addEventListener("click", close);
  overlay.querySelectorAll(".avatar-cell.is-unlocked").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.getAttribute("data-key");
      if (key === _cache.selected) return;
      // Optimistic UI — flip selected immediately, roll back on error.
      const prev = _cache.selected;
      _cache.selected = key;
      overlay.querySelectorAll(".avatar-cell").forEach((c) => {
        c.classList.toggle("is-selected", c.getAttribute("data-key") === key);
        const tag = c.querySelector(".avatar-cell-tag");
        if (!c.classList.contains("is-locked") && tag) {
          tag.textContent = c.getAttribute("data-key") === key ? "✓ Selected" : "Tap to pick";
          tag.classList.toggle("is-on", c.getAttribute("data-key") === key);
        }
      });
      try {
        const res = await fetch("/me/avatars/select", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        _selectListeners.forEach((fn) => { try { fn(key); } catch {} });
      } catch (err) {
        _cache.selected = prev;
        // Restore visual state on failure.
        render(overlay);
        alert(err.message || "Couldn't save.");
      }
    });
  });
}

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
