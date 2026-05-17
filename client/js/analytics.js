// Lightweight client analytics. Sends events to /api/track via a
// non-blocking fetch with keepalive, so navigation/close events don't lose
// their final payload. The server endpoint is a thin write-to-log + count
// stub today (server-modules/analytics.js); easy to swap to PostHog /
// Plausible / Vercel Analytics once a provider is chosen.

const enabled = (() => {
  // Honor a kill switch in localStorage so I can disable on demand
  // without touching server.
  try { return localStorage.getItem("pokemon-tcg-analytics") !== "off"; } catch { return true; }
})();

// Anonymous, session-stable id so we can de-dupe pageviews without
// tracking identifiable info.
let _anonId = null;
function anonId() {
  if (_anonId) return _anonId;
  try {
    _anonId = localStorage.getItem("pokemon-tcg-anon-id");
    if (!_anonId) {
      _anonId = "a" + Math.random().toString(36).slice(2, 11);
      localStorage.setItem("pokemon-tcg-anon-id", _anonId);
    }
  } catch {
    _anonId = "a" + Math.random().toString(36).slice(2, 11);
  }
  return _anonId;
}

export function trackEvent(name, props = {}) {
  if (!enabled || typeof name !== "string") return;
  // Forward to Vercel Analytics if their script loaded. Pageviews are
  // auto-tracked by their script; we only push custom events through `va`.
  try {
    if (typeof window !== "undefined" && typeof window.va === "function") {
      window.va("event", { name, ...props });
    }
  } catch {}
  // Always also send to our own beacon so we have a server-side log
  // independent of Vercel's quota — single source of truth for funnels
  // until we move to PostHog or similar.
  try {
    const body = JSON.stringify({
      name,
      props,
      anonId: anonId(),
      ts: Date.now(),
      path: location.pathname,
      ref: document.referrer || null,
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/track", new Blob([body], { type: "application/json" }));
    } else {
      fetch("/api/track", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {}
}

// Auto-track page-load. Subsequent in-app navigations call trackEvent
// directly via the action paths that matter (play_started, first_win,
// daily_finished, etc.).
if (typeof window !== "undefined") {
  window.addEventListener("DOMContentLoaded", () => trackEvent("page_view"));
}
