// TCG card-face renderer. Dedicated to this mode because a real TCG face
// (HP corner, attacks with Energy-symbol costs, Weakness, retreat cost) differs
// too much from client/js/cards.js. Returns detached DOM elements.

export const TCG_COLORS = {
  fire: "#ff6b3d", water: "#3d9bff", grass: "#5fbf5f", lightning: "#f5c518",
  psychic: "#c56bd6", fighting: "#c8702f", colorless: "#cfcdc2",
};
export const TYPE_GLYPH = {
  fire: "🔥", water: "💧", grass: "🍃", lightning: "⚡", psychic: "🔮", fighting: "✊", colorless: "✦",
};

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

// A single Energy-cost pip.
function energyPip(type) {
  const p = el("span", "tcg-pip");
  p.style.background = TCG_COLORS[type] || "#888";
  p.title = type;
  p.textContent = TYPE_GLYPH[type] || "•";
  return p;
}

function costRow(cost) {
  const row = el("span", "tcg-cost");
  if (!cost || !cost.length) { row.appendChild(el("span", "tcg-pip tcg-pip-none", "—")); return row; }
  for (const t of cost) row.appendChild(energyPip(t));
  return row;
}

// Render a Pokémon card. `inst` (optional) overlays in-play state: current HP,
// attached Energy, damage. `opts.affordable` is a Set of attack indices the
// engine says are payable (highlights them). `opts.size` = "full" | "mini".
export function renderTcgCard(card, opts = {}) {
  const { inst = null, size = "full" } = opts;
  if (card.kind === "energy") return renderEnergyCard(card, size);
  if (["item", "supporter", "stadium"].includes(card.kind)) return renderTrainerCard(card, size);

  const type = card.type || "colorless";
  const wrap = el("div", `tcg-card tcg-pokemon tcg-${size} type-${type}`);
  wrap.style.setProperty("--type", TCG_COLORS[type] || "#888");
  wrap.dataset.cardId = card.id;
  if (inst) wrap.dataset.uid = inst.uid;

  const curHp = inst ? Math.max(0, card.hp - inst.damage) : card.hp;
  wrap.appendChild(el("div", "tcg-card-head",
    `<span class="tcg-stage">${card.stage === "basic" ? "Basic" : card.stage === "stage1" ? "Stage 1" : "Stage 2"}</span>
     <span class="tcg-name">${card.name}</span>
     <span class="tcg-hp">${curHp}<small>HP</small></span>`));

  const art = el("div", "tcg-art");
  art.style.setProperty("--type", TCG_COLORS[type] || "#888");
  const img = el("img");
  img.loading = "lazy"; img.src = card.art; img.alt = card.name; img.draggable = false;
  art.appendChild(img);
  // Attached-energy pips + damage counter for in-play instances.
  if (inst) {
    if (inst.attached?.length) {
      const en = el("div", "tcg-attached");
      for (const e of inst.attached) en.appendChild(energyPip(e.energyType));
      art.appendChild(en);
    }
    if (inst.damage > 0) art.appendChild(el("div", "tcg-damage", `−${inst.damage}`));
  }
  wrap.appendChild(art);

  if (size === "full") {
    const atks = el("div", "tcg-attacks");
    card.attacks.forEach((a, i) => {
      const row = el("div", `tcg-attack${opts.affordable?.has(i) ? " affordable" : ""}`);
      row.dataset.attackIndex = i;
      row.appendChild(costRow(a.cost));
      row.appendChild(el("span", "tcg-atk-name", a.name));
      row.appendChild(el("span", "tcg-atk-dmg", a.damage ? String(a.damage) : ""));
      if (a.text) row.title = a.text;
      atks.appendChild(row);
    });
    wrap.appendChild(atks);
    wrap.appendChild(el("div", "tcg-card-foot",
      `<span class="tcg-weak">${card.weak ? `weak <b style="color:${TCG_COLORS[card.weak]}">${TYPE_GLYPH[card.weak]}</b> ×2` : "—"}</span>
       <span class="tcg-retreat">retreat ${"◦".repeat(card.retreat || 0) || "0"}</span>`));
  } else {
    // Mini: a compact type stripe with the name.
    wrap.appendChild(el("div", "tcg-mini-foot", `<span>${TYPE_GLYPH[type]}</span><span>${card.name}</span>`));
  }
  return wrap;
}

function renderEnergyCard(card, size) {
  const type = card.energyType;
  const wrap = el("div", `tcg-card tcg-energy tcg-${size} type-${type}`);
  wrap.style.setProperty("--type", TCG_COLORS[type] || "#888");
  wrap.dataset.cardId = card.id;
  wrap.appendChild(el("div", "tcg-energy-badge", TYPE_GLYPH[type] || "✦"));
  wrap.appendChild(el("div", "tcg-energy-name", card.name));
  return wrap;
}

function renderTrainerCard(card, size) {
  const wrap = el("div", `tcg-card tcg-trainer kind-${card.kind} tcg-${size}`);
  wrap.dataset.cardId = card.id;
  const label = card.kind === "item" ? "Item" : card.kind === "supporter" ? "Supporter" : "Stadium";
  wrap.appendChild(el("div", "tcg-trainer-head", `<span class="tcg-trainer-kind">${label}</span><span class="tcg-name">${card.name}</span>`));
  wrap.appendChild(el("div", "tcg-trainer-glyph", card.kind === "supporter" ? "👤" : card.kind === "stadium" ? "🏟" : "🎒"));
  if (size === "full") wrap.appendChild(el("div", "tcg-trainer-text", card.text || ""));
  return wrap;
}

// A face-down card back (prizes, opponent hand, deck).
export function renderCardBack(size = "mini") {
  return el("div", `tcg-card tcg-back tcg-${size}`, `<div class="tcg-back-logo">◓</div>`);
}
