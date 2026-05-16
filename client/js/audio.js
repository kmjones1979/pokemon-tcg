// Web Audio playback for Pokémon cries. Lazy AudioContext (must be created
// after a user gesture) and a tiny in-memory buffer cache so re-summoning the
// same Pokémon doesn't re-fetch.

let _ctx = null;
let _muted = localStorage.getItem("pokemon-tcg-muted") === "1";
const _buffers = new Map(); // url → AudioBuffer
const _inFlight = new Map(); // url → Promise<AudioBuffer>

function ctx() {
  if (!_ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    _ctx = new AC();
  }
  return _ctx;
}

async function loadBuffer(url) {
  if (_buffers.has(url)) return _buffers.get(url);
  if (_inFlight.has(url)) return _inFlight.get(url);
  const p = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`audio fetch failed: ${res.status}`);
    const data = await res.arrayBuffer();
    const c = ctx();
    if (!c) return null;
    const buf = await c.decodeAudioData(data.slice(0));
    _buffers.set(url, buf);
    return buf;
  })().catch((e) => {
    // Don't crash gameplay if a cry fails to load.
    console.warn("[audio] failed to load", url, e?.message);
    return null;
  });
  _inFlight.set(url, p);
  return p;
}

export async function playCry(url, { volume = 0.3 } = {}) {
  if (_muted || !url) return;
  const c = ctx();
  if (!c) return;
  if (c.state === "suspended") {
    try { await c.resume(); } catch {}
  }
  const buf = await loadBuffer(url);
  if (!buf) return;
  const src = c.createBufferSource();
  src.buffer = buf;
  const gain = c.createGain();
  gain.gain.value = volume;
  src.connect(gain).connect(c.destination);
  src.start();
}

export function setMuted(m) {
  _muted = !!m;
  localStorage.setItem("pokemon-tcg-muted", _muted ? "1" : "0");
}

export function isMuted() {
  return _muted;
}
