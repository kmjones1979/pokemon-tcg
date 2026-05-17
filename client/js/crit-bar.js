// Crit-timing micro-game. When the player triggers a Special attack,
// a short horizontal bar appears with a sweet spot in the middle and a
// sweeping indicator. Tap inside the sweet spot → guaranteed crit
// (1.5× damage flag). Anywhere else → regular crit chance applies.
//
// The whole interaction is < 1.5s — players get a sense of agency on
// big moments without slowing the match meaningfully.
//
// Usage:
//   const result = await runCritBar();   // { crit: bool, hit: bool }
// `crit === true` means engine should force-crit on this attack.

const SWEEPS = 3;
const SWEEP_MS = 600;       // one direction
const SWEET_SPOT_WIDTH = 0.22; // 22% of the bar width

let _open = false;

export async function runCritBar({ themeColor = "#ffd166" } = {}) {
  // Disable on touch+reduced-motion (the timing UI is intrinsically
  // motion-heavy). Caller just gets a "didn't try" result.
  if (typeof window === "undefined") return { crit: false, hit: false };
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return { crit: false, hit: false };
  }
  if (_open) return { crit: false, hit: false };
  _open = true;
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "critbar-overlay";
    overlay.innerHTML = `
      <div class="critbar-card" style="--theme:${themeColor}">
        <div class="critbar-hint">TAP THE SWEET SPOT</div>
        <div class="critbar-track">
          <div class="critbar-zone"></div>
          <div class="critbar-indicator"></div>
        </div>
        <div class="critbar-sub">Crit guaranteed if you nail it</div>
      </div>`;
    document.body.appendChild(overlay);
    const card = overlay.querySelector(".critbar-card");
    const track = overlay.querySelector(".critbar-track");
    const indicator = overlay.querySelector(".critbar-indicator");
    requestAnimationFrame(() => overlay.classList.add("show"));

    const start = performance.now();
    const totalDuration = SWEEPS * 2 * SWEEP_MS;
    let resolved = false;
    let rafId;

    function done(result) {
      if (resolved) return;
      resolved = true;
      cancelAnimationFrame(rafId);
      _open = false;
      overlay.classList.remove("show");
      overlay.classList.add(result.crit ? "hit" : (result.hit ? "near" : "miss"));
      setTimeout(() => overlay.remove(), 320);
      resolve(result);
    }

    function commit() {
      const trackRect = track.getBoundingClientRect();
      const indRect = indicator.getBoundingClientRect();
      const indCenter = indRect.left + indRect.width / 2;
      const fromLeft = indCenter - trackRect.left;
      const ratio = fromLeft / trackRect.width;
      const zoneStart = (1 - SWEET_SPOT_WIDTH) / 2;
      const zoneEnd = 1 - zoneStart;
      if (ratio >= zoneStart && ratio <= zoneEnd) {
        done({ crit: true, hit: true });
      } else {
        // Near-miss bonus: within 1 zone-width on either side bumps the
        // base crit chance but doesn't force.
        const near = Math.abs(ratio - 0.5) < SWEET_SPOT_WIDTH;
        done({ crit: false, hit: near });
      }
    }

    function tick(now) {
      const t = now - start;
      if (t >= totalDuration) {
        done({ crit: false, hit: false });
        return;
      }
      // Triangle wave between 0 and 1 — sweep across in SWEEP_MS, back
      // in SWEEP_MS, repeat. Looks smoother than a sinusoid for the
      // bar+sweet-spot pattern.
      const phase = (t % (2 * SWEEP_MS)) / SWEEP_MS;
      const x = phase < 1 ? phase : 2 - phase;
      indicator.style.left = (x * 100) + "%";
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    overlay.addEventListener("pointerdown", commit, { once: true });
    // Esc / outside-tap cancels (counts as miss).
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done({ crit: false, hit: false });
    });
    setTimeout(() => card?.focus?.(), 10);
  });
}
