// Visual FX layer: particle trails, floating damage numbers, KO dissolve.
// Pure DOM + canvas — no game state, just coordinates and colors.

import { TYPE_COLORS } from "./type-chart.js";

let _canvas, _ctx;
const _particles = [];
let _rafId = null;

function ensureCanvas() {
  if (_canvas) return _canvas;
  _canvas = document.createElement("canvas");
  _canvas.className = "fx-canvas";
  document.body.appendChild(_canvas);
  _ctx = _canvas.getContext("2d");
  resize();
  window.addEventListener("resize", resize);
  return _canvas;
}

function resize() {
  if (!_canvas) return;
  const dpr = window.devicePixelRatio || 1;
  _canvas.width = window.innerWidth * dpr;
  _canvas.height = window.innerHeight * dpr;
  _canvas.style.width = window.innerWidth + "px";
  _canvas.style.height = window.innerHeight + "px";
  _ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function tick() {
  if (!_ctx) {
    _rafId = null;
    return;
  }
  _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
  const now = performance.now();
  for (let i = _particles.length - 1; i >= 0; i--) {
    const p = _particles[i];
    const t = (now - p.t0) / p.life;
    if (t >= 1) {
      _particles.splice(i, 1);
      continue;
    }
    const x = p.x0 + (p.x1 - p.x0) * easeOut(t) + (Math.random() - 0.5) * 6;
    const y = p.y0 + (p.y1 - p.y0) * easeOut(t) + (Math.random() - 0.5) * 6;
    const r = p.size * (1 - t * 0.6);
    _ctx.globalAlpha = 1 - t;
    _ctx.fillStyle = p.color;
    _ctx.beginPath();
    _ctx.arc(x, y, r, 0, Math.PI * 2);
    _ctx.fill();
  }
  _ctx.globalAlpha = 1;
  if (_particles.length > 0) {
    _rafId = requestAnimationFrame(tick);
  } else {
    _rafId = null;
  }
}

function easeOut(t) {
  return 1 - (1 - t) * (1 - t);
}

// Fire a particle trail from one element to another, colored by attacker type.
export function fireAttackTrail(fromEl, toEl, attackerType = "normal") {
  if (!fromEl || !toEl) return;
  ensureCanvas();
  const a = fromEl.getBoundingClientRect();
  const b = toEl.getBoundingClientRect();
  const x0 = a.left + a.width / 2;
  const y0 = a.top + a.height / 2;
  const x1 = b.left + b.width / 2;
  const y1 = b.top + b.height / 2;
  const color = TYPE_COLORS[attackerType] || "#fff";
  const count = 28;
  const t0 = performance.now();
  for (let i = 0; i < count; i++) {
    _particles.push({
      x0,
      y0,
      x1,
      y1,
      t0: t0 + i * 14,
      life: 500 + Math.random() * 200,
      size: 5 + Math.random() * 4,
      color,
    });
  }
  if (!_rafId) _rafId = requestAnimationFrame(tick);
}

// Float a damage number up from a target element and fade out.
export function floatDamage(targetEl, text, { kind = "hit" } = {}) {
  if (!targetEl) return;
  const r = targetEl.getBoundingClientRect();
  const el = document.createElement("div");
  el.className = `damage-float kind-${kind}`;
  el.textContent = text;
  el.style.left = `${r.left + r.width / 2}px`;
  el.style.top = `${r.top + r.height / 2}px`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("rise"));
  setTimeout(() => el.remove(), 1500);
}

// Brief shake to convey "this card was hit" (driven by .dmg-shake CSS class).
export function shakeHit(el) {
  if (!el) return;
  el.classList.remove("dmg-shake");
  // Force reflow so the animation can replay
  // eslint-disable-next-line no-unused-expressions
  el.offsetHeight;
  el.classList.add("dmg-shake");
  setTimeout(() => el.classList.remove("dmg-shake"), 450);
}

// Apply a fade/desaturate transition and remove the element after.
export function knockOut(el) {
  if (!el) return Promise.resolve();
  return new Promise((resolve) => {
    el.classList.add("ko");
    setTimeout(() => {
      el.remove();
      resolve();
    }, 800);
  });
}

// Flash a short verdict overlay (e.g. "Super effective!").
export function flashVerdict(text, tone = "super") {
  if (!text) return;
  const el = document.createElement("div");
  el.className = `verdict tone-${tone}`;
  el.textContent = text;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 400);
  }, 1100);
}
