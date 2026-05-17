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
  if (_muted) stopBGM();
}

export function isMuted() {
  return _muted;
}

// --- Procedural SFX --------------------------------------------------------
// Lightweight synthesized sounds using Web Audio primitives. Saves shipping
// any audio assets, lets us tune timbres per gameplay event.

function fxGain(c, level) {
  const g = c.createGain();
  g.gain.value = level;
  g.connect(c.destination);
  return g;
}

// Attack swoosh: short filtered noise burst.
export function sfxAttack(typeColor = "#fff") {
  if (_muted) return;
  const c = ctx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  const len = 0.18;
  const buffer = c.createBuffer(1, c.sampleRate * len, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    // Pinkish noise envelope
    const t = i / data.length;
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2);
  }
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(2200, c.currentTime);
  filter.frequency.linearRampToValueAtTime(600, c.currentTime + len);
  filter.Q.value = 4;
  src.connect(filter).connect(fxGain(c, 0.18));
  src.start();
}

// "Your turn" — bright two-note chime so the player can't miss the
// transition (especially during multiplayer waits).
export function sfxYourTurn() {
  if (_muted) return;
  const c = ctx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  const notes = [659.25, 880]; // E5, A5 — bright ping
  notes.forEach((freq, i) => {
    const o = c.createOscillator();
    o.type = "triangle";
    o.frequency.value = freq;
    const g = c.createGain();
    const start = c.currentTime + i * 0.09;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.28, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
    o.connect(g).connect(c.destination);
    o.start(start);
    o.stop(start + 0.34);
  });
}

// Critical hit: short ascending chirp + bright cymbal-ish noise.
export function sfxCrit() {
  if (_muted) return;
  const c = ctx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  // Bright tone
  const o = c.createOscillator();
  o.type = "triangle";
  o.frequency.setValueAtTime(880, c.currentTime);
  o.frequency.exponentialRampToValueAtTime(1760, c.currentTime + 0.12);
  const og = c.createGain();
  og.gain.setValueAtTime(0.0001, c.currentTime);
  og.gain.exponentialRampToValueAtTime(0.28, c.currentTime + 0.01);
  og.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.2);
  o.connect(og).connect(c.destination);
  o.start();
  o.stop(c.currentTime + 0.22);
  // Plus a quick noise sizzle for cymbal feel.
  const len = 0.18;
  const buf = c.createBuffer(1, c.sampleRate * len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 1.5);
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  const filt = c.createBiquadFilter();
  filt.type = "highpass";
  filt.frequency.value = 4000;
  const ng = c.createGain();
  ng.gain.value = 0.12;
  src.connect(filt).connect(ng).connect(c.destination);
  src.start();
}

// Damage hit: short tonal blip with downward pitch sweep.
export function sfxHit({ supereffective = false } = {}) {
  if (_muted) return;
  const c = ctx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  const osc = c.createOscillator();
  osc.type = supereffective ? "square" : "triangle";
  const startHz = supereffective ? 900 : 550;
  osc.frequency.setValueAtTime(startHz, c.currentTime);
  osc.frequency.exponentialRampToValueAtTime(startHz * 0.4, c.currentTime + 0.12);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.22, c.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.18);
  osc.connect(g).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + 0.2);
}

// KO ding: descending chord, signals a Pokémon fainted.
export function sfxKO() {
  if (_muted) return;
  const c = ctx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  const notes = [392, 311, 247]; // G4, Eb4, B3 — minor-ish drop
  notes.forEach((freq, i) => {
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const g = c.createGain();
    const start = c.currentTime + i * 0.08;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.18, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.36);
    osc.connect(g).connect(c.destination);
    osc.start(start);
    osc.stop(start + 0.4);
  });
}

// Victory: ascending arpeggio, plays at game-over for the winner.
export function sfxVictory() {
  if (_muted) return;
  const c = ctx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  const notes = [392, 494, 587, 784]; // G4, B4, D5, G5 — major triad ascending
  notes.forEach((freq, i) => {
    const osc = c.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;
    const g = c.createGain();
    const start = c.currentTime + i * 0.11;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.22, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
    osc.connect(g).connect(c.destination);
    osc.start(start);
    osc.stop(start + 0.4);
  });
}

// Defeat: a falling minor cadence.
export function sfxDefeat() {
  if (_muted) return;
  const c = ctx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  const notes = [440, 370, 311, 247]; // A4, F#4, Eb4, B3
  notes.forEach((freq, i) => {
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const g = c.createGain();
    const start = c.currentTime + i * 0.14;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.18, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
    osc.connect(g).connect(c.destination);
    osc.start(start);
    osc.stop(start + 0.45);
  });
}

// --- Ambient BGM ----------------------------------------------------------
// A slow, very soft chord that cycles through a 4-chord pad. Web Audio only,
// no assets. Stops when muted, fades out cleanly on stop.
let _bgmNodes = null;
let _bgmInterval = null;
const CHORDS = [
  // D minor / F maj / A minor / C maj — calm modal feel
  [146.83, 220.00, 293.66, 349.23],
  [174.61, 220.00, 261.63, 349.23],
  [220.00, 261.63, 329.63, 440.00],
  [196.00, 261.63, 329.63, 392.00],
];
const BGM_VOLUME = 0.035;

export function startBGM() {
  if (_bgmNodes || _muted) return;
  const c = ctx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});

  const master = c.createGain();
  master.gain.value = 0;
  master.connect(c.destination);
  master.gain.linearRampToValueAtTime(BGM_VOLUME, c.currentTime + 2.5);

  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 1600;
  filter.Q.value = 0.7;
  filter.connect(master);

  // Slow LFO on the filter for breathing motion.
  const lfo = c.createOscillator();
  lfo.frequency.value = 0.07;
  const lfoGain = c.createGain();
  lfoGain.gain.value = 400;
  lfo.connect(lfoGain).connect(filter.frequency);
  lfo.start();

  // 4 sustained oscillators per chord, retuned on each chord change.
  const oscs = [];
  const gains = [];
  for (let i = 0; i < 4; i++) {
    const o = c.createOscillator();
    o.type = i === 0 ? "sine" : i === 3 ? "triangle" : "sine";
    o.frequency.value = CHORDS[0][i];
    const g = c.createGain();
    g.gain.value = i === 0 ? 0.5 : 0.3;
    o.connect(g).connect(filter);
    o.start();
    oscs.push(o);
    gains.push(g);
  }

  _bgmNodes = { master, filter, lfo, oscs, gains, ctx: c };

  // Cycle through chords every 8 seconds.
  let chordIdx = 0;
  const stepChord = () => {
    if (!_bgmNodes) return;
    chordIdx = (chordIdx + 1) % CHORDS.length;
    const t = c.currentTime;
    for (let i = 0; i < 4; i++) {
      oscs[i].frequency.linearRampToValueAtTime(CHORDS[chordIdx][i], t + 1.5);
    }
  };
  _bgmInterval = setInterval(stepChord, 8000);
}

export function stopBGM() {
  if (!_bgmNodes) return;
  const { master, oscs, lfo, ctx: c } = _bgmNodes;
  master.gain.cancelScheduledValues(c.currentTime);
  master.gain.linearRampToValueAtTime(0, c.currentTime + 0.8);
  setTimeout(() => {
    try {
      oscs.forEach((o) => o.stop());
      lfo.stop();
    } catch {}
  }, 900);
  clearInterval(_bgmInterval);
  _bgmInterval = null;
  _bgmNodes = null;
}

// Card play "thud" — a low percussive blip.
export function sfxCardPlay() {
  if (_muted) return;
  const c = ctx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  const osc = c.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(180, c.currentTime);
  osc.frequency.exponentialRampToValueAtTime(60, c.currentTime + 0.12);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.18, c.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.15);
  osc.connect(g).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + 0.16);
}
