// Card rendering. Returns DOM elements; no game-state knowledge.

import { TYPE_COLORS } from "./type-chart.js";
import { isGuardian } from "./passives.js";

function isGuardianCard(card) { return isGuardian(card); }

const TYPE_GLYPH = {
  normal: "★",
  fire: "🔥",
  water: "💧",
  electric: "⚡",
  grass: "🌿",
  ice: "❄",
  fighting: "✊",
  poison: "☠",
  ground: "⛰",
  flying: "🕊",
  psychic: "🌀",
  bug: "🐛",
  rock: "🪨",
  ghost: "👻",
  dragon: "🐉",
  dark: "🌒",
  steel: "⚙",
  fairy: "✨",
};

export function renderCard(card, { compact = false, instance = null } = {}) {
  // Spell cards (Freeze, etc.) render through a separate path: no HP /
  // attack stats, big glyph in the art slot, type-themed gradient,
  // description on the footer instead of the name+ATK row.
  if (card?.kind === "spell") {
    return renderSpellCard(card, { compact });
  }

  const el = document.createElement("div");
  el.className = `card type-${card.types?.[0] || "normal"}${compact ? " compact" : ""}`;
  if (instance) el.dataset.instanceId = instance.instanceId;
  el.dataset.cardId = card.id;
  if (card.is_mythical) el.dataset.cardRare = "mythical";
  else if (card.is_legendary) el.dataset.cardRare = "legendary";

  const primary = card.types?.[0] || "normal";
  const secondary = card.types?.[1];
  const c1 = TYPE_COLORS[primary] || "#888";
  const c2 = TYPE_COLORS[secondary] || c1;
  el.style.setProperty("--type-1", c1);
  el.style.setProperty("--type-2", c2);

  const hp = instance ? instance.currentHp : card.cardHp;
  const maxHp = instance?.maxHp ?? card.cardHp;

  el.innerHTML = `
    <div class="card-inner">
      <div class="card-sheen"></div>
      <header class="card-header">
        <div class="cost-gem" title="${card.energyCost} Energy">${card.energyCost}</div>
        <div class="card-hp" title="HP">${hp}<span class="card-hp-max">/${maxHp}</span></div>
        <div class="card-types">
          ${(card.types || []).map(
            (t) =>
              `<span class="type-badge" style="background:${TYPE_COLORS[t] || "#888"}" title="${t}">${TYPE_GLYPH[t] || "•"}</span>`,
          ).join("")}
        </div>
      </header>
      <div class="card-art">
        <img loading="lazy" src="${card.sprite_front || ""}" alt="${card.name}" draggable="false">
      </div>
      <footer class="card-footer">
        <div class="card-name">${escape(card.name)}</div>
        <div class="card-attack" title="Attack">⚔ ${card.cardAttack}</div>
      </footer>
      ${instance && instance.status ? `
        <div class="card-status status-${instance.status.kind}">${instance.status.kind}</div>
        <div class="status-icon kind-${instance.status.kind}">${statusGlyph(instance.status.kind)}</div>
      ` : ""}
      ${instance && instance.level ? `
        <div class="card-level" title="Level ${instance.level} (+${instance.level} HP, +${instance.attackBoost || instance.level} ATK)">★${instance.level}</div>
      ` : ""}
      ${!instance && card.shinyLevel ? `
        <div class="card-level shiny-badge" title="Shiny L${card.shinyLevel} (+${card.shinyLevel} HP, +${card.shinyLevel} ATK)">★${card.shinyLevel}</div>
      ` : ""}
      ${card.is_legendary ? `<div class="card-rarity">★ LEGENDARY ★</div>` : card.is_mythical ? `<div class="card-rarity mythical">✦ MYTHICAL ✦</div>` : ""}
      ${card._masteryLevel ? `<div class="card-mastery" title="Card Mastery L${card._masteryLevel}${card._masteryLevel >= 3 ? " · +1 ATK active" : ""}">${"★".repeat(card._masteryLevel)}</div>` : ""}
    </div>
    ${isGuardianCard(card) ? `
      <div class="guardian-ring" aria-hidden="true"></div>
      <div class="card-guardian" title="Guardian — opponents must attack this first">🛡</div>
      <div class="guardian-tag">DEFENDER</div>
    ` : ""}
  `;

  return el;
}

function statusGlyph(kind) {
  if (kind === "sleep") return "💤";
  if (kind === "burn") return "🔥";
  if (kind === "paralyze") return "⚡";
  if (kind === "freeze") return "❄";
  return "✦";
}

// Spell-card render — distinct frame from Pokémon. Type-themed gradient
// background, big glyph instead of a sprite, description text below.
// The `card.kind === "spell"` branch in renderCard funnels here so
// downstream callers don't need to know about the split.
function renderSpellCard(card, { compact = false } = {}) {
  const el = document.createElement("div");
  const primary = card.types?.[0] || "normal";
  const rarity = card.rarity || "common";
  el.className = `card spell-card type-${primary} rarity-${rarity}${compact ? " compact" : ""}`;
  el.dataset.cardId = card.id;
  el.dataset.cardKind = "spell";
  el.dataset.spellEffect = card.effect;

  const c1 = TYPE_COLORS[primary] || "#888";
  el.style.setProperty("--type-1", c1);
  el.style.setProperty("--type-2", c1);

  el.innerHTML = `
    <div class="card-inner">
      <div class="card-sheen"></div>
      <header class="card-header">
        <div class="cost-gem" title="${card.energyCost} Energy">${card.energyCost}</div>
        <div class="spell-tag" title="Spell">SPELL</div>
        <div class="card-types">
          <span class="type-badge" style="background:${c1}" title="${primary}">${TYPE_GLYPH[primary] || "•"}</span>
        </div>
      </header>
      <div class="card-art spell-art">
        <div class="spell-glyph" aria-hidden="true">${card.glyph || "✦"}</div>
      </div>
      <footer class="card-footer spell-footer">
        <div class="card-name">${escape(card.name)}</div>
        <div class="spell-desc">${escape(card.description || "")}</div>
      </footer>
    </div>
  `;
  return el;
}

function escape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
