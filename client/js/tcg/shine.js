// Player preference: disable the animated holo / rainbow-foil "shine" on cards.
// The continuously-animating gradient sweeps look great but repaint every frame,
// and with many Rare/Ultra cards on screen (a full board, or the 200-card
// gallery) that stutters on low-end GPUs. This lets players turn it off. The
// preference is stored per-browser and honoured both in-game and on /cards via
// the shared `body.no-shine` CSS switch in tcg.css.

const KEY = "tcg-shine-off";

export function shineOff() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

// Reflect the stored preference onto <body> so the CSS can suppress animations.
export function applyShine() {
  if (typeof document !== "undefined" && document.body) {
    document.body.classList.toggle("no-shine", shineOff());
  }
}

export function setShineOff(off) {
  try {
    localStorage.setItem(KEY, off ? "1" : "0");
  } catch {}
  applyShine();
}
