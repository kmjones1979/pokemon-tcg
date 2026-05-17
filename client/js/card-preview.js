// Long-hover card preview. Shows an enlarged version of a card with full
// flavor text + ability list anchored next to where the cursor is.
//
// Public: attachPreviewHandlers(rootEl) — call once after a render; finds
//   every `.card[data-card-id]` inside `rootEl` and wires hover handlers.

import { renderCard } from "./cards.js";
import { abilitiesFor } from "./abilities.js";
import { isGuardian, entranceAbility, signatureFor } from "./passives.js";

const HOVER_DELAY_MS = 350;
let _hoverTimer = null;
let _previewEl = null;

// Touch-only devices fire mouseenter on tap but never mouseleave reliably,
// which leaves the preview stuck open. Skip the long-hover behaviour there.
function isTouchDevice() {
  return typeof window !== "undefined" &&
    (window.matchMedia?.("(hover: none)").matches || "ontouchstart" in window);
}

export function attachPreviewHandlers(rootEl, lookup) {
  if (isTouchDevice()) return;
  const cards = rootEl.querySelectorAll(".card[data-card-id]");
  cards.forEach((cardEl) => {
    cardEl.addEventListener("mouseenter", (e) => {
      if (_hoverTimer) clearTimeout(_hoverTimer);
      _hoverTimer = setTimeout(() => {
        // Never show the preview while another higher-priority overlay is
        // up — the ability popover, the reward modal, the deck builder, etc.
        if (
          document.querySelector(".ability-popover") ||
          document.querySelector(".reward-overlay") ||
          document.querySelector(".collection-overlay:not(.hidden)") ||
          document.querySelector(".mm-overlay") ||
          document.querySelector(".howto-overlay") ||
          document.querySelector(".auth-modal") ||
          document.querySelector(".game-over")
        ) return;
        const id = Number(cardEl.dataset.cardId);
        const card = lookup ? lookup(id) : null;
        if (!card) return;
        showPreview(card, cardEl);
      }, HOVER_DELAY_MS);
    });
    cardEl.addEventListener("mouseleave", () => {
      if (_hoverTimer) clearTimeout(_hoverTimer);
      hidePreview();
    });
  });
}

function showPreview(card, anchorEl) {
  hidePreview();
  const el = document.createElement("div");
  el.className = "card-preview";

  // Build the enlarged card.
  const big = renderCard(card);
  big.classList.add("preview-card");

  // Sidebar: stats + abilities + flavor
  const side = document.createElement("div");
  side.className = "card-preview-info";
  const abilities = abilitiesFor(card);
  side.innerHTML = `
    <div class="cp-title">${escape(card.name)}</div>
    <div class="cp-meta">
      Tier ${card.tier} · Cost ⚡${card.energyCost} ·
      Type ${(card.types || []).join("/")}
    </div>
    <div class="cp-stats">
      <span>❤️ ${card.cardHp}</span>
      <span>⚔ ${card.cardAttack}</span>
    </div>
    <div class="cp-section">Attacks</div>
    ${abilities.map((a) => `
      <div class="cp-ability">
        <span class="cp-aname">${escape(a.name)}</span>
        <span class="cp-acost">${a.energyCost > 0 ? `⚡${a.energyCost}` : "free"}</span>
        <span class="cp-amult">×${(a.damageMult || 1).toFixed(2).replace(/\.00$/, "")}</span>
        ${a.status ? `<span class="cp-astatus">${a.status}</span>` : ""}
        <span class="cp-adesc">${escape(a.desc)}</span>
      </div>
    `).join("")}
    ${renderTraitsSection(card)}
    ${renderPassivesSection(card)}
    ${card.flavor_text ? `
      <div class="cp-section">Pokédex entry</div>
      <div class="cp-flavor">${escape(card.flavor_text)}</div>
    ` : ""}
  `;

  el.appendChild(big);
  el.appendChild(side);
  document.body.appendChild(el);
  _previewEl = el;

  // Anchor: put it next to the source card; flip side if it'd run off screen.
  const r = anchorEl.getBoundingClientRect();
  const W = 460; // card-preview width target (matches CSS)
  const H = 380;
  const desiredLeft = r.right + 12;
  const flipped = desiredLeft + W > window.innerWidth;
  el.style.left = flipped ? `${r.left - W - 12}px` : `${desiredLeft}px`;
  el.style.top = `${Math.max(8, Math.min(window.innerHeight - H - 8, r.top - 40))}px`;
}

export function hidePreview() {
  if (_hoverTimer) { clearTimeout(_hoverTimer); _hoverTimer = null; }
  _previewEl?.remove();
  _previewEl = null;
}

// Any click anywhere dismisses an open preview immediately — otherwise the
// hover-card lingers and can cover the ability popover that just opened.
if (typeof document !== "undefined") {
  document.addEventListener("mousedown", hidePreview, true);
  document.addEventListener("touchstart", hidePreview, { capture: true, passive: true });
}

const PASSIVE_DESCS = {
  static: "Static — 25% chance to paralyze the attacker on contact.",
  levitate: "Levitate — immune to Ground attacks.",
  intimidate: "Intimidate — on summon, every enemy Pokémon loses 1 ATK.",
  blaze: "Blaze — +1 ATK to Fire moves when below 1/3 HP.",
  torrent: "Torrent — +1 ATK to Water moves when below 1/3 HP.",
  overgrow: "Overgrow — +1 ATK to Grass moves when below 1/3 HP.",
};
function renderTraitsSection(card) {
  const traits = [];
  const sig = signatureFor(card);
  if (sig) traits.push(`<div class="cp-ability"><span class="cp-aname">⭐ Signature: ${escape(sig.name)}</span><span class="cp-adesc">${escape(sig.desc)}</span></div>`);
  const entrance = entranceAbility(card);
  if (entrance) traits.push(`<div class="cp-ability"><span class="cp-aname">Entrance: ${escape(entrance.name)}</span><span class="cp-adesc">${escape(entrance.desc)}</span></div>`);
  if (isGuardian(card)) traits.push(`<div class="cp-ability"><span class="cp-aname">🛡 Guardian</span><span class="cp-adesc">Opposing attackers must target this first while it's on the field.</span></div>`);
  if (!traits.length) return "";
  return `<div class="cp-section">Special traits</div>${traits.join("")}`;
}

function renderPassivesSection(card) {
  if (!Array.isArray(card.abilities) || card.abilities.length === 0) return "";
  const active = card.abilities.filter((a) => PASSIVE_DESCS[a]);
  if (!active.length) return "";
  return `
    <div class="cp-section">Passive abilities</div>
    ${active.map((a) => `
      <div class="cp-ability"><span class="cp-aname">${escape(a)}</span>
        <span class="cp-adesc">${escape(PASSIVE_DESCS[a])}</span>
      </div>
    `).join("")}
  `;
}

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
