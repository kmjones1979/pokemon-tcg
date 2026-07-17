// Animated booster-pack opening. Shows face-down cards that reveal one by one
// with a pop; Rares and Ultra Rares get a burst of shine. Opened cards are
// added to the collection immediately, then the summary is shown.

import { cardById } from "./catalog.js";
import { renderTcgCard } from "./card-face.js";
import { rollPack } from "./packs.js";
import * as collection from "./collection.js";
import { pokeballSVG } from "./icons.js";

const RARITY_LABEL = { common: "Common", uncommon: "Uncommon", rare: "Rare", ultra: "Ultra Rare" };

export function openPack({ onDone } = {}) {
  const ids = rollPack();
  collection.addCards(ids); // grant immediately so a mid-open close still keeps them
  const best = ids.map((id) => cardById(id).rarity).sort((a, b) =>
    ["common", "uncommon", "rare", "ultra"].indexOf(b) - ["common", "uncommon", "rare", "ultra"].indexOf(a))[0];

  const ov = document.createElement("div");
  ov.className = "tcg-pack-overlay";
  ov.innerHTML = `
    <div class="tcg-pack-stage">
      <div class="tcg-pack-title">Booster Pack</div>
      <div class="tcg-pack-sub">Tap each card to reveal</div>
      <div class="tcg-pack-cards"></div>
      <div class="tcg-pack-actions"></div>
    </div>`;
  const cardsEl = ov.querySelector(".tcg-pack-cards");
  const actions = ov.querySelector(".tcg-pack-actions");

  const slots = ids.map((id, i) => {
    const slot = document.createElement("div");
    slot.className = "tcg-pack-slot";
    slot.style.setProperty("--i", String(i));
    slot.innerHTML = `<div class="tcg-pack-back">${pokeballSVG()}</div>`;
    slot.onclick = () => reveal(i);
    cardsEl.appendChild(slot);
    return slot;
  });

  let revealed = 0;
  function reveal(i) {
    const slot = slots[i];
    if (slot.dataset.done) return;
    slot.dataset.done = "1";
    const card = cardById(ids[i]);
    slot.innerHTML = "";
    slot.classList.add("revealed", `rar-${card.rarity}`);
    const c = renderTcgCard(card, { size: "full" });
    c.classList.add("tcg-pack-reveal");
    slot.appendChild(c);
    slot.insertAdjacentHTML("beforeend", `<div class="tcg-pack-rlabel">${RARITY_LABEL[card.rarity]}</div>`);
    revealed++;
    if (revealed === ids.length) showDone();
  }
  function revealAll() { slots.forEach((_, i) => reveal(i)); }

  function showDone() {
    actions.innerHTML = "";
    if (best === "ultra" || best === "rare") {
      ov.querySelector(".tcg-pack-title").textContent = best === "ultra" ? "✦ ULTRA RARE PULL! ✦" : "★ Rare pull!";
      ov.querySelector(".tcg-pack-title").classList.add(`hit-${best}`);
    }
    const b = document.createElement("button");
    b.className = "tcg-btn primary"; b.textContent = "Add to Binder";
    b.onclick = () => { ov.remove(); onDone && onDone(ids); };
    actions.appendChild(b);
  }

  const ra = document.createElement("button");
  ra.className = "tcg-btn"; ra.textContent = "Reveal all";
  ra.onclick = revealAll;
  actions.appendChild(ra);

  document.body.appendChild(ov);
}
