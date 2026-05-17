// Auto-generated highlight images for sharing match results.
// 1080×1350 vertical canvas — TikTok / Instagram Story friendly.
//
// Composition:
//   - Diagonal gradient backdrop from the player's primary type to the
//     rival's primary type (or boss type for story/daily).
//   - "VICTORY" / "DEFEAT" headline.
//   - Centerpiece: MVP card sprite (biggest-hit attacker on a win, or
//     the rival's signature mon on a loss) on a radial spotlight.
//   - Stat strip: turns · KOs · biggest hit · crits.
//   - Earned badges (PERFECT, LIGHTNING, etc.) as pills.
//   - Footer with the result tag + game URL.
//
// Exported via canvas.toBlob — caller can:
//   - download via createObjectURL + <a download>
//   - share via navigator.share({ files: [new File([blob], …)] })

import { TYPE_COLORS } from "./type-chart.js";

// Two output shapes:
//   "post"   1080×1350  Instagram / Twitter / iMessage (4:5)
//   "tiktok" 1080×1920  TikTok / IG Reels / IG Story (9:16)
// The composition uses the same pipeline; element y-positions scale
// off the canvas height + a couple of layout knobs.

const FORMATS = {
  post:   { w: 1080, h: 1350, mvpY: 620, stripY: 1040, badgeY: 1200, mvpSize: 520, footerY: 30 },
  tiktok: { w: 1080, h: 1920, mvpY: 880, stripY: 1380, badgeY: 1560, mvpSize: 620, footerY: 50 },
};
const DEFAULT_FORMAT = "post";

// Public helper: build the highlight image. Returns a Promise<Blob>.
// `format` selects between the 4:5 (post) and 9:16 (tiktok) layouts.
export async function generateHighlight({ state, currentUser, format = DEFAULT_FORMAT } = {}) {
  if (!state || typeof OffscreenCanvas === "undefined" && typeof document === "undefined") {
    return null;
  }
  const cfg = FORMATS[format] || FORMATS[DEFAULT_FORMAT];
  const W = cfg.w;
  const H = cfg.h;
  const cnv = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(W, H)
    : Object.assign(document.createElement("canvas"), { width: W, height: H });
  const ctx = cnv.getContext("2d");

  const won = state.winner === "player";
  const my = state.recap?.player || {};
  const myKOs = state.players?.ai?.discard?.length || 0;
  const myCardType  = bestSideType(state.players?.player) || "normal";
  const oppCardType = bestSideType(state.players?.ai)    || "normal";
  const c1 = TYPE_COLORS[myCardType]  || "#777";
  const c2 = TYPE_COLORS[oppCardType] || "#444";

  // 1. Backdrop — diagonal gradient between the two types.
  paintGradient(ctx, c1, c2, W, H);
  paintVignette(ctx, W, H);

  // 2. Top label band.
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, 60, W, 200);
  drawText(ctx, won ? "VICTORY" : "DEFEAT", {
    x: W / 2, y: 180,
    color: won ? "#06d6a0" : "#ef476f",
    font: "900 130px 'Press Start 2P', monospace",
    align: "center",
    shadow: won ? "#06d6a060" : "#ef476f60",
  });
  drawText(ctx, won ? "out-strategised the rival" : `held out for ${state.turn} turns`, {
    x: W / 2, y: 240,
    color: "rgba(255,255,255,0.7)",
    font: "italic 26px Inter, system-ui, sans-serif",
    align: "center",
  });

  // 3. MVP sprite spotlight.
  const mvp = pickMvp(state, won);
  if (mvp?.sprite_front) {
    try {
      const img = await loadImage(mvp.sprite_front);
      // Spotlight halo.
      const cx = W / 2, cy = cfg.mvpY;
      const radius = Math.round(cfg.mvpSize * 0.73);
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      grad.addColorStop(0, "rgba(255,255,255,0.28)");
      grad.addColorStop(0.6, `${(TYPE_COLORS[mvp.types?.[0]] || "#888")}88`);
      grad.addColorStop(1, "transparent");
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();
      // Sprite — drawn pixelated for that authentic pixel-art feel.
      ctx.imageSmoothingEnabled = false;
      const size = cfg.mvpSize;
      ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
      ctx.imageSmoothingEnabled = true;
    } catch {}
  }

  // 4. MVP name + role tag.
  if (mvp?.name) {
    drawText(ctx, mvp.name.toUpperCase(), {
      x: W / 2, y: cfg.mvpY + cfg.mvpSize / 2 + 40,
      color: "#fff",
      font: "900 64px 'Press Start 2P', monospace",
      align: "center",
      shadow: "#000",
    });
    drawText(ctx, won ? `★ MVP · ${my.biggestHit || 0} biggest hit` : `Rival's anchor`, {
      x: W / 2, y: cfg.mvpY + cfg.mvpSize / 2 + 88,
      color: "rgba(255,255,255,0.75)",
      font: "italic 24px Inter, system-ui",
      align: "center",
    });
  }

  // 5. Stat strip — four cells.
  const cells = [
    { label: "TURNS",    value: state.turn || 0 },
    { label: "KO'S",     value: myKOs },
    { label: "DAMAGE",   value: my.totalDamage || 0 },
    { label: "CRITS",    value: my.crits || 0 },
  ];
  const stripY = cfg.stripY;
  const cellW = (W - 80) / cells.length;
  for (let i = 0; i < cells.length; i++) {
    const x = 40 + cellW * i + cellW / 2;
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(40 + cellW * i + 6, stripY, cellW - 12, 110);
    drawText(ctx, cells[i].label, {
      x, y: stripY + 38,
      color: "rgba(255,255,255,0.7)",
      font: "700 18px 'Press Start 2P', monospace",
      align: "center",
    });
    drawText(ctx, String(cells[i].value), {
      x, y: stripY + 95,
      color: "#ffd166",
      font: "900 56px Inter, system-ui",
      align: "center",
      shadow: "rgba(0,0,0,0.6)",
    });
  }

  // 6. Earned-badge pills (PERFECT VICTORY etc.) — re-derived from the
  // existing onGameOver logic so the share image agrees with the recap.
  const badges = badgesFor(state, won);
  if (badges.length) {
    let bx = 60;
    const by = cfg.badgeY;
    for (const b of badges) {
      const w = ctx.measureText(b.label).width + 60;
      ctx.fillStyle = b.color + "33";
      roundRect(ctx, bx, by, w, 44, 22);
      ctx.fill();
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 2;
      roundRect(ctx, bx, by, w, 44, 22);
      ctx.stroke();
      drawText(ctx, b.label, {
        x: bx + w / 2, y: by + 28,
        color: b.color,
        font: "900 18px 'Press Start 2P', monospace",
        align: "center",
      });
      bx += w + 12;
      if (bx > W - 200) break;
    }
  }

  // 7. Footer.
  drawText(ctx, "play • pokemon TCG", {
    x: W / 2, y: H - cfg.footerY,
    color: "rgba(255,255,255,0.55)",
    font: "italic 22px Inter, system-ui",
    align: "center",
  });
  if (currentUser?.display_name) {
    drawText(ctx, `as ${currentUser.display_name}`, {
      x: 60, y: H - cfg.footerY,
      color: "rgba(255,255,255,0.5)",
      font: "20px Inter, system-ui",
      align: "left",
    });
  }
  return await canvasToBlob(cnv);
}

// --- helpers --------------------------------------------------------------

function paintGradient(ctx, c1, c2, W, H) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0,    c1);
  g.addColorStop(0.55, mix(c1, c2, 0.5));
  g.addColorStop(1,    c2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function paintVignette(ctx, W, H) {
  const g = ctx.createRadialGradient(W/2, H/2, W*0.4, W/2, H/2, W*0.9);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function drawText(ctx, text, { x, y, color = "#fff", font, align = "left", shadow }) {
  ctx.font = font || "24px Inter, system-ui, sans-serif";
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  if (shadow) {
    ctx.fillStyle = shadow;
    ctx.fillText(text, x + 3, y + 3);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("img load failed"));
    img.src = url;
  });
}

function canvasToBlob(cnv) {
  if (cnv.convertToBlob) return cnv.convertToBlob({ type: "image/png" });
  return new Promise((resolve) => cnv.toBlob((b) => resolve(b), "image/png"));
}

function mix(a, b, t) {
  // Quick hex mixer — assumes #RRGGBB strings.
  const pa = parseHex(a), pb = parseHex(b);
  if (!pa || !pb) return a;
  const r = Math.round(pa[0] * (1 - t) + pb[0] * t);
  const g = Math.round(pa[1] * (1 - t) + pb[1] * t);
  const bl = Math.round(pa[2] * (1 - t) + pb[2] * t);
  return `rgb(${r},${g},${bl})`;
}
function parseHex(c) {
  if (typeof c !== "string") return null;
  const m = c.replace(/^#/, "").match(/^([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function bestSideType(p) {
  if (!p) return null;
  // Use the most-recent ko'd card's type — that's the side's "spirit".
  const last = p.discard?.[p.discard.length - 1];
  if (last?.types?.[0]) return last.types[0];
  for (const inst of (p.field || [])) {
    if (inst?.card?.types?.[0]) return inst.card.types[0];
  }
  return null;
}

function pickMvp(state, won) {
  if (won) {
    // Prefer the card that scored the biggest hit by name. Fall back
    // to any legendary on the player side, then the last KO'd ai card.
    const my = state.recap?.player;
    if (my?.biggestHitName) {
      // Find a card with that name in either side's lists.
      for (const side of ["player", "ai"]) {
        for (const inst of (state.players[side]?.field || [])) {
          if (inst?.card?.name === my.biggestHitName) return inst.card;
        }
        for (const card of (state.players[side]?.discard || [])) {
          if (card?.name === my.biggestHitName) return card;
        }
      }
    }
    // Any legendary on field?
    for (const inst of (state.players.player?.field || [])) {
      if (inst?.card?.is_legendary || inst?.card?.is_mythical) return inst.card;
    }
    return state.players.ai?.discard?.[state.players.ai.discard.length - 1] || null;
  }
  // Loss: feature the rival's last big card.
  for (const inst of (state.players.ai?.field || [])) {
    if (inst?.card?.is_legendary || inst?.card?.is_mythical) return inst.card;
  }
  return state.players.ai?.discard?.[state.players.ai.discard.length - 1] || null;
}

function badgesFor(state, won) {
  // Mirrors the labels from main.js onGameOver but trimmed for the
  // image (no descriptions, 4-letter max colors).
  const my = state.recap?.player || {};
  const myKOs = state.players?.ai?.discard?.length || 0;
  const myHpLeft = state.players?.player?.trainerHp || 0;
  const maxHp = state.players?.player?.maxTrainerHp || 30;
  const out = [];
  if (won) {
    if (myHpLeft === maxHp) out.push({ label: "PERFECT", color: "#ffd166" });
    else if (myHpLeft >= maxHp - 3) out.push({ label: "UNTOUCHABLE", color: "#06d6a0" });
    if (state.turn <= 8) out.push({ label: "LIGHTNING", color: "#ffd166" });
    if (state.turn >= 25) out.push({ label: "ENDURANCE", color: "#118ab2" });
    if ((my.crits || 0) >= 3) out.push({ label: "CRIT MASTER", color: "#ef476f" });
    if (myKOs >= 5) out.push({ label: "RAMPAGE", color: "#ff8a3d" });
  } else {
    if (state.turn >= 20) out.push({ label: "VALIANT", color: "#b388ff" });
    if ((my.biggestHit || 0) >= 12) out.push({ label: "HEAVY HITTER", color: "#ff6b6b" });
  }
  return out;
}

// Convenience UI helper: render the canvas inline + offer download +
// native-share. Caller passes the same { state, currentUser } shape.
// The dialog has a Post / TikTok toggle that re-renders the canvas
// in 1080×1350 (post) or 1080×1920 (TikTok / Reels / Story).
export async function showHighlightShare({ state, currentUser } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "highlight-overlay";
  overlay.innerHTML = `
    <div class="highlight-card">
      <button class="hc-close">✕</button>
      <h2>Share your highlight</h2>
      <div class="hc-format-toggle">
        <button class="hc-format active" data-format="post">📷 Post (4:5)</button>
        <button class="hc-format"        data-format="tiktok">📱 TikTok (9:16)</button>
      </div>
      <div class="hc-img-wrap">
        <div class="hc-loading">Generating…</div>
        <img class="hc-img" alt="Match highlight">
      </div>
      <div class="hc-actions">
        <a class="primary"  href="#" download="pokemon-tcg-highlight.png">📥 Save image</a>
        <button class="ghost" data-act="share">📤 Share…</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const imgEl = overlay.querySelector(".hc-img");
  const dlEl  = overlay.querySelector(".hc-actions .primary");
  const loadingEl = overlay.querySelector(".hc-loading");
  let currentBlob = null;
  let currentUrl = null;

  async function render(format) {
    loadingEl.style.display = "block";
    imgEl.style.opacity = "0.4";
    try {
      const blob = await generateHighlight({ state, currentUser, format });
      if (!blob) throw new Error("no blob");
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      currentBlob = blob;
      currentUrl = URL.createObjectURL(blob);
      imgEl.src = currentUrl;
      dlEl.href = currentUrl;
      dlEl.download = format === "tiktok"
        ? "pokemon-tcg-highlight-tiktok.png"
        : "pokemon-tcg-highlight.png";
    } catch (err) {
      console.warn("[highlight] gen failed:", err);
    } finally {
      loadingEl.style.display = "none";
      imgEl.style.opacity = "1";
    }
  }
  overlay.querySelectorAll(".hc-format").forEach((b) => {
    b.addEventListener("click", () => {
      overlay.querySelectorAll(".hc-format").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      render(b.dataset.format);
    });
  });
  overlay.querySelector(".hc-close").addEventListener("click", () => {
    overlay.remove(); if (currentUrl) URL.revokeObjectURL(currentUrl);
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) { overlay.remove(); if (currentUrl) URL.revokeObjectURL(currentUrl); }
  });
  overlay.querySelector("[data-act=share]")?.addEventListener("click", async () => {
    if (!currentBlob) return;
    try {
      const file = new File([currentBlob], "pokemon-tcg-highlight.png", { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          title: state.winner === "player" ? "I won my Pokémon TCG match!" : "Tough match in Pokémon TCG",
          files: [file],
        });
      } else if (navigator.share) {
        await navigator.share({ title: "Pokémon TCG", url: location.origin });
      }
    } catch {}
  });
  render("post");
}
