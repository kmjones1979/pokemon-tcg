// Pick-one-of-N reward modal shown after a match ends.
// Server hands the client an offer { offerId, picks: [card,...] }.
// User clicks one card to claim it; server adds to owned_cards.

import { renderCard } from "./cards.js";

export function showOffer(offer, { onClaim, didWin } = {}) {
  if (!offer || !offer.picks?.length) {
    onClaim?.(null);
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "reward-overlay";
  overlay.innerHTML = `
    <div class="reward-card">
      <div class="reward-title">
        ${didWin ? "Victory drop" : "Consolation pack"}
      </div>
      <div class="reward-sub">Pick ONE card to add to your collection</div>
      <div class="reward-picks"></div>
      <button class="reward-skip">Skip</button>
    </div>
  `;
  const picksEl = overlay.querySelector(".reward-picks");
  offer.picks.forEach((card, i) => {
    const wrap = document.createElement("div");
    wrap.className = "reward-pick";
    wrap.style.setProperty("--pick-i", String(i));
    wrap.style.setProperty("--pick-delay", `${i * 220}ms`);
    const cardEl = renderCard({ ...card, raw: { hp: card.cardHp * 10, attack: card.cardAttack * 15 } });
    wrap.appendChild(cardEl);
    const rarity = card.rarity || "common";
    const rarityLabel = rarity.charAt(0).toUpperCase() + rarity.slice(1);
    const badge = document.createElement("div");
    // Keep tier-N class so existing CSS rules still apply; rarity-X is
    // the new word-based class for future styling.
    badge.className = `reward-tier tier-${card.tier} rarity-${rarity}`;
    badge.textContent = rarityLabel;
    wrap.appendChild(badge);
    // Sparkle particle layer behind the card.
    const sparkle = document.createElement("div");
    sparkle.className = "reward-sparkle";
    sparkle.innerHTML = "✦ ✧ ✦ ✧ ✦".split(" ").map((s) => `<span>${s}</span>`).join("");
    wrap.appendChild(sparkle);
    wrap.addEventListener("click", async () => {
      // Visually mark this one
      [...picksEl.children].forEach((c) => c.classList.remove("chosen"));
      wrap.classList.add("chosen");
      // Disable further clicks
      picksEl.style.pointerEvents = "none";
      try {
        const res = await fetch("/me/rewards/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ offerId: offer.offerId, pokemonId: card.id }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "claim failed");
        overlay.querySelector(".reward-title").textContent =
          `Added to collection!`;
        overlay.querySelector(".reward-sub").textContent =
          `${card.name} x${data.newQuantity}`;
        setTimeout(() => {
          overlay.remove();
          onClaim?.(card);
        }, 1100);
      } catch (err) {
        alert("Claim failed: " + (err.message || "unknown"));
        picksEl.style.pointerEvents = "auto";
      }
    });
    picksEl.appendChild(wrap);
  });
  overlay.querySelector(".reward-skip").addEventListener("click", () => {
    overlay.remove();
    onClaim?.(null);
  });
  document.body.appendChild(overlay);
}
