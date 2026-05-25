// Battle-emote player. Pulls a tiny manifest of pre-generated TTS clip
// URLs from /api/reading/emotes, then plays a random matching clip
// when the engine fires a battle event.
//
// User-facing toggle: localStorage["pokemon-tcg-emotes"] === "off"
// disables all emote playback. Default ON.

let _manifest = null;       // { [event]: [{ id, audioUrl }, ...] }
let _loadPromise = null;
let _currentAudio = null;
let _lastEventTs = 0;        // global cooldown so rapid-fire hits don't overlap
const EMOTE_COOLDOWN_MS = 600;

function emotesEnabled() {
  try {
    return localStorage.getItem("pokemon-tcg-emotes") !== "off";
  } catch {
    return true;
  }
}

export function setEmotesEnabled(on) {
  try {
    localStorage.setItem("pokemon-tcg-emotes", on ? "on" : "off");
  } catch {}
}

async function loadManifest() {
  if (_manifest) return _manifest;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      const res = await fetch("/api/reading/emotes");
      if (!res.ok) throw new Error("emote manifest 404");
      const data = await res.json();
      _manifest = data.emotes || {};
    } catch (err) {
      // Manifest fetch failed — degrade silently. Emotes are flavour;
      // missing audio shouldn't break the battle.
      console.warn("[emotes] manifest load failed:", err.message);
      _manifest = {};
    }
    return _manifest;
  })();
  return _loadPromise;
}

// Fire-and-forget: call with the engine event name to play a random
// matching clip. No-op if disabled, manifest missing, or no clips for
// this event. Respects a short global cooldown so the AOE event +
// per-enemy hit events don't trigger a Cacophony.
export async function playEmote(event) {
  if (!event || !emotesEnabled()) return;
  const now = Date.now();
  if (now - _lastEventTs < EMOTE_COOLDOWN_MS) return;
  const manifest = await loadManifest();
  const candidates = manifest[event];
  if (!candidates || !candidates.length) return;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  if (!pick?.audioUrl) return;
  _lastEventTs = now;
  if (_currentAudio) { try { _currentAudio.pause(); } catch {} }
  try {
    _currentAudio = new Audio(pick.audioUrl);
    _currentAudio.volume = 0.7;
    _currentAudio.play().catch(() => { /* autoplay block, etc. */ });
  } catch {}
}

// Classify an attack result into the right emote event. Centralised so
// both the solo + multiplayer code paths share the same mapping.
//   { critical, multiplier, knockedOut } → "super" | "weak" | "hit" + maybe "ko"
export function attackResultToEvents(result) {
  if (!result || result.ok === false) return [];
  const events = [];
  const mult = result.multiplier ?? 1;
  if (result.critical || mult > 1.5) events.push("super");
  else if (mult < 1)                 events.push("weak");
  else                               events.push("hit");
  if (result.knockedOut) events.push("ko");
  return events;
}

// Spell-effect → event mapping. Engine returns result.effect; the
// emote event mirrors that with a `spell-` prefix where one exists.
export function spellResultToEvent(result) {
  if (!result?.effect) return null;
  switch (result.effect) {
    case "freeze":       return "spell-freeze";
    case "heal":         return "spell-heal";
    case "evolve":       return "spell-evolve";
    case "aoe":          return "spell-aoe";
    // Slice 6:
    case "bolt":         return "spell-bolt";
    case "sleep-powder": return "spell-sleep-powder";
    case "cleanse":      return "spell-cleanse";
    case "surge":        return "spell-surge";
    case "scout":        return "spell-scout";
    case "phoenix":      return "spell-phoenix";
    // Slice 7:
    case "burn":         return "spell-burn";
    case "shield":       return "spell-shield";
    case "mass-heal":    return "spell-mass-heal";
    case "power-strike": return "spell-power-strike";
    case "counter":      return "spell-counter";
    case "stop-time":    return "spell-stop-time";
    // Slice 8:
    case "confusion":    return "spell-confusion";
    case "storm":        return "spell-storm";
    case "burst":        return "spell-burst";
    case "brave-strike": return "spell-brave-strike";
    case "refresh":      return "spell-refresh";
    case "drain":        return "spell-drain";
    default:             return null;
  }
}
