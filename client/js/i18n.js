// Minimal i18n shell. Loads a flat string bag keyed by dot-path (e.g.
// "menu.battleAs") and substitutes `{name}` placeholders. English is
// bundled by default; additional locales lazy-load when the browser
// preference matches (ES / PT-BR / JA / KO / DE per the growth plan).
//
// Usage:
//   import { t, setLocale } from "./i18n.js";
//   t("menu.battleAs", { name: "Brock" });   // "Battle as Brock ▸"
//
// New copy throughout the codebase lands here. Migration of legacy
// hardcoded strings happens file-by-file as they get touched (no
// big-bang refactor).

let _strings = {};
let _locale = "en";

// English bundle is critical-path. Loaded synchronously at module init
// via a top-level fetch — the `await` is hoisted by the bundler. For
// now we ship en.json as a separate fetch since there's no build step
// yet; once esbuild lands we'll inline the JSON via a static import.
async function loadLocale(locale) {
  try {
    const r = await fetch(`/i18n/${locale}.json`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function init(locale = detectLocale()) {
  _locale = locale;
  _strings = (await loadLocale(locale)) || {};
  // Fall back to English if a non-EN locale failed to load.
  if (!Object.keys(_strings).length && locale !== "en") {
    _strings = (await loadLocale("en")) || {};
    _locale = "en";
  }
}

export function setLocale(locale) { return init(locale); }
export function locale() { return _locale; }

export function t(key, params = {}) {
  // Resolve dot-path against the loaded bag.
  let cur = _strings;
  for (const part of key.split(".")) {
    if (cur == null) break;
    cur = cur[part];
  }
  if (typeof cur !== "string") {
    // Return the key so missing strings are obvious in the UI.
    return key;
  }
  // Replace {placeholders} with params; tolerate missing entries.
  return cur.replace(/\{(\w+)\}/g, (_, name) =>
    params[name] != null ? String(params[name]) : `{${name}}`);
}

function detectLocale() {
  try {
    const stored = localStorage.getItem("pokemon-tcg-locale");
    if (stored) return stored;
    const nav = (navigator.language || "en").toLowerCase();
    if (nav.startsWith("es")) return "es";
    if (nav.startsWith("pt")) return "pt-br";
    if (nav.startsWith("ja")) return "ja";
    if (nav.startsWith("ko")) return "ko";
    if (nav.startsWith("de")) return "de";
    return "en";
  } catch {
    return "en";
  }
}
