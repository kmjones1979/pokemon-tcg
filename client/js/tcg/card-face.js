// TCG card-face renderer. Bright, real-card-inspired faces: type-colored
// frame, framed art window, Energy-symbol costs, HP corner, Weakness/retreat
// footer. All iconography is inline SVG from icons.js — no emoji.

import { TCG_COLORS, energySVG, energyBadge, pokeballSVG, trainerSVG } from "./icons.js";

export { TCG_COLORS };

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

const STAGE = { basic: "Basic", stage1: "Stage 1", stage2: "Stage 2" };
const RARITY_MARK = { common: "●", uncommon: "◆", rare: "★", ultra: "✦" };
const STATUS_ABBR = { poison: "PSN", burn: "BRN", paralyze: "PAR", sleep: "SLP", confuse: "CNF" };

// Render a Pokémon / Energy / Trainer card. `inst` overlays in-play state
// (current HP, attached Energy, damage). `opts.affordable` is a Set of attack
// indices the engine says are payable. `opts.size` = "full" | "mini".
export function renderTcgCard(card, opts = {}) {
  const { inst = null, size = "full" } = opts;
  if (card.kind === "energy") return renderEnergyCard(card, size);
  if (["item", "supporter", "stadium"].includes(card.kind)) return renderTrainerCard(card, size);

  const type = card.type || "colorless";
  const rarity = card.rarity || "common";
  // Ultra Rares with bespoke art render "full-art": the illustration fills the
  // whole card and the text is overlaid, like a real Illustration Rare.
  const fullArt = card.genArt && rarity === "ultra";
  const wrap = el("div", `tcg-card tcg-pokemon tcg-${size} type-${type} rarity-${rarity}${card.genArt ? " gen-art" : ""}${fullArt ? " full-art" : ""}`);
  wrap.style.setProperty("--type", TCG_COLORS[type] || "#888");
  wrap.dataset.cardId = card.id;
  if (inst) wrap.dataset.uid = inst.uid;

  const curHp = inst ? Math.max(0, card.hp - inst.damage) : card.hp;

  wrap.appendChild(el("div", "tcg-card-head",
    `<div class="tcg-head-left">
       <span class="tcg-stage">${STAGE[card.stage] || ""}</span>
       <span class="tcg-name">${card.name}</span>
     </div>
     <div class="tcg-head-right">
       <span class="tcg-hp"><i>HP</i>${curHp}</span>
       ${energyBadge(type, "tcg-type-badge")}
     </div>`));

  const art = el("div", "tcg-art");
  art.innerHTML = `<div class="tcg-art-frame"><img loading="lazy" src="${card.art}" alt="${card.name}" draggable="false"></div>`;
  if (inst) {
    if (inst.attached?.length) {
      art.insertAdjacentHTML("beforeend",
        `<div class="tcg-attached">${inst.attached.map((e) => energyBadge(e.energyType, "pip-mini")).join("")}</div>`);
    }
    if (inst.damage > 0) art.insertAdjacentHTML("beforeend", `<div class="tcg-damage">−${inst.damage}</div>`);
    if (inst.status) art.insertAdjacentHTML("beforeend", `<div class="tcg-cond st-${inst.status.kind}">${STATUS_ABBR[inst.status.kind] || ""}</div>`);
  }
  wrap.appendChild(art);

  if (size === "full") {
    const atks = el("div", "tcg-attacks");
    card.attacks.forEach((a, i) => {
      const row = el("div", `tcg-attack${opts.affordable?.has(i) ? " affordable" : ""}`);
      row.dataset.attackIndex = i;
      row.innerHTML =
        `<span class="tcg-cost">${(a.cost || []).map((t) => energyBadge(t, "pip-cost")).join("")}</span>
         <span class="tcg-atk-name">${a.name}</span>
         <span class="tcg-atk-dmg">${a.damage || ""}</span>`;
      if (a.text) row.title = a.text;
      atks.appendChild(row);
    });
    wrap.appendChild(atks);

    const weak = card.weak
      ? `${energyBadge(card.weak, "pip-mini")}<span class="tcg-x2">×2</span>`
      : `<span class="tcg-dash">—</span>`;
    const retreat = card.retreat
      ? Array.from({ length: card.retreat }, () => energyBadge("colorless", "pip-mini")).join("")
      : `<span class="tcg-dash">—</span>`;
    wrap.appendChild(el("div", "tcg-card-foot",
      `<span class="tcg-foot-cell"><b>Weakness</b>${weak}</span>
       <span class="tcg-foot-cell"><b>Retreat</b>${retreat}</span>`));
  } else {
    wrap.appendChild(el("div", "tcg-mini-foot",
      `${energyBadge(type, "pip-mini")}<span class="tcg-mini-name">${card.name}</span>`));
  }
  // Holographic sheen for Rare/Ultra, plus a rarity mark like real cards.
  if (rarity === "rare" || rarity === "ultra") wrap.appendChild(el("div", "tcg-holo"));
  if (size === "full") wrap.appendChild(el("div", `tcg-rarity-mark rm-${rarity}`, RARITY_MARK[rarity] || ""));
  return wrap;
}

function renderEnergyCard(card, size) {
  const type = card.energyType;
  const wrap = el("div", `tcg-card tcg-energy tcg-${size} type-${type}`);
  wrap.style.setProperty("--type", TCG_COLORS[type] || "#888");
  wrap.dataset.cardId = card.id;
  wrap.innerHTML =
    `<div class="tcg-energy-symbol">${energySVG(type)}</div>
     <div class="tcg-energy-name">${size === "full" ? card.name : "Energy"}</div>`;
  return wrap;
}

function renderTrainerCard(card, size) {
  const wrap = el("div", `tcg-card tcg-trainer kind-${card.kind} art-${card.artStyle || "icon"} tcg-${size}`);
  wrap.dataset.cardId = card.id;
  const label = card.kind === "item" ? "Item" : card.kind === "supporter" ? "Supporter" : "Stadium";
  // Real trainer-card look: a framed illustration window with the category
  // banner above and the name/text below. Falls back to the SVG icon if a
  // card has no art.
  const art = card.art
    ? `<div class="tcg-trainer-art"><img loading="lazy" src="${card.art}" alt="${card.name}" draggable="false"></div>`
    : `<div class="tcg-trainer-art tcg-trainer-art-icon">${trainerSVG(card.kind)}</div>`;
  wrap.innerHTML =
    `<div class="tcg-trainer-banner">${label}</div>
     ${art}
     <div class="tcg-name tcg-trainer-name">${card.name}</div>
     ${size === "full" ? `<div class="tcg-trainer-text">${card.text || ""}</div>` : ""}`;
  return wrap;
}

// Face-down card back (Prizes, opponent hand/deck): the classic blue Pokéball.
export function renderCardBack(size = "mini") {
  return el("div", `tcg-card tcg-back tcg-${size}`, `<div class="tcg-back-face">${pokeballSVG()}</div>`);
}
