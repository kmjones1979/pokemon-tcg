// Tap-to-hear: clicking any word in a story renders its pronunciation
// via the browser's built-in `speechSynthesis` API. Designed for early
// readers — when a kid hits a word they can't decode, they tap it and
// hear it pronounced once, slowly. No network round-trip, no per-word
// ElevenLabs cost, works for ANY word the story might use.
//
// API:
//   tokenizeTextForWordClicks(text)
//     Returns HTML where each word is wrapped in a span carrying
//     `data-word` (lowercased, punctuation-stripped). Whitespace +
//     punctuation between words is preserved as plain text.
//
//   attachWordClickListener(rootEl)
//     Adds a single delegated click handler on `rootEl`. Clicking any
//     `.reading-word` span calls speakWord() with that span's data-word.
//     Returns a detach function for cleanup.
//
//   speakWord(word)
//     Cancels any in-flight speech and pronounces the word. Slower
//     rate (0.85) for clarity. No-op if speechSynthesis is unavailable.
//
//   wordTtsAvailable()
//     True if the browser supports speechSynthesis. The UI can hide
//     the "tap any word" hint when this is false.

let _currentSpan = null; // the .reading-word currently highlighted

export function wordTtsAvailable() {
  return typeof window !== "undefined"
      && "speechSynthesis" in window
      && typeof SpeechSynthesisUtterance === "function";
}

export function speakWord(word, opts = {}) {
  if (!word || !wordTtsAvailable()) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(String(word));
    // Slow + slightly bright — easier for K-2 to parse.
    utter.rate  = opts.rate  ?? 0.85;
    utter.pitch = opts.pitch ?? 1.05;
    utter.volume = opts.volume ?? 1;
    // Prefer an English voice when more than one is installed (Chrome
    // often defaults to a generic system voice that mis-pronounces).
    const voices = window.speechSynthesis.getVoices?.() || [];
    const enVoice = voices.find((v) => /^en[-_]?/.test(v.lang)) || voices[0];
    if (enVoice) utter.voice = enVoice;
    window.speechSynthesis.speak(utter);
  } catch {
    // Some browsers throw on speak() when the API is partially
    // disabled; degrade silently so a story click never crashes.
  }
}

// Word-boundary tokeniser: splits on whitespace, leaves punctuation
// attached for display, but strips it from the data-word so the TTS
// engine doesn't try to verbalise "berry." as "berry period".
//
// Punctuation handled: . , ! ? ; : " ' ( ) — and curly-quote variants.
//
// Hyphens INSIDE a word are preserved ("super-strong" → spoken whole)
// since splitting hyphenated compounds usually hurts comprehension.
export function tokenizeTextForWordClicks(text) {
  if (text == null) return "";
  const str = String(text);
  // Split keeping whitespace + non-word runs so we can re-emit them.
  // Capturing group keeps the separators in the output array.
  const parts = str.split(/(\s+)/);
  const out = [];
  for (const part of parts) {
    if (part === "") continue;
    if (/^\s+$/.test(part)) {
      out.push(escapeHtml(part));
      continue;
    }
    // Strip leading/trailing punctuation for the spoken token only.
    const cleaned = part.replace(/^[^\p{L}\p{N}'-]+/u, "").replace(/[^\p{L}\p{N}'-]+$/u, "");
    if (!cleaned) {
      // Pure punctuation token (e.g. "—" alone). Don't make it clickable.
      out.push(escapeHtml(part));
      continue;
    }
    out.push(
      `<span class="reading-word" data-word="${escapeAttr(cleaned.toLowerCase())}">${escapeHtml(part)}</span>`,
    );
  }
  return out.join("");
}

export function attachWordClickListener(rootEl) {
  if (!rootEl || !wordTtsAvailable()) return () => {};
  const handler = (ev) => {
    const span = ev.target.closest?.(".reading-word");
    if (!span || !rootEl.contains(span)) return;
    const word = span.dataset.word;
    if (!word) return;
    if (_currentSpan) _currentSpan.classList.remove("speaking");
    span.classList.add("speaking");
    _currentSpan = span;
    speakWord(word);
    // Clear the highlight when speech ends (or after a safety timeout).
    const cleanup = () => { if (_currentSpan === span) { span.classList.remove("speaking"); _currentSpan = null; } };
    const onEnd = () => cleanup();
    // SpeechSynthesisUtterance has its own events but we'd have to
    // hold a reference — easier path: a max-duration timer based on
    // word length (~250ms per char at rate 0.85).
    setTimeout(cleanup, Math.max(1200, word.length * 220));
    // Best-effort onend hook for browsers that fire it reliably.
    if (window.speechSynthesis?.addEventListener) {
      window.speechSynthesis.addEventListener("end", onEnd, { once: true });
    }
  };
  rootEl.addEventListener("click", handler);
  return () => rootEl.removeEventListener("click", handler);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s);
}
