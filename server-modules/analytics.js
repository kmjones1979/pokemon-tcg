// Lightweight analytics endpoint. Receives client beacons and:
//   1. Bumps in-process per-event counters (one-line log every N events).
//   2. (Optional) forwards to a real provider when configured.
//
// Replace this with PostHog / Plausible / Vercel Analytics when the
// strategic plan picks a provider (PLAN.md blocker #2).

const COUNTS = new Map(); // event name -> count
let LAST_FLUSH = Date.now();

function bump(name) {
  COUNTS.set(name, (COUNTS.get(name) || 0) + 1);
  // Periodically log a summary so we can eyeball traffic without a
  // provider hooked up.
  if (Date.now() - LAST_FLUSH > 60_000) {
    LAST_FLUSH = Date.now();
    const totals = [...COUNTS.entries()].sort((a, b) => b[1] - a[1])
      .slice(0, 8).map(([k, v]) => `${k}=${v}`).join(" ");
    if (totals) console.log(`[analytics] ${totals}`);
  }
}

function mount(app) {
  app.post("/api/track", (req, res) => {
    // Body may arrive as Blob (sendBeacon) or JSON.
    let payload = req.body;
    try {
      if (Buffer.isBuffer(payload)) payload = JSON.parse(payload.toString("utf8"));
      if (typeof payload === "string") payload = JSON.parse(payload);
    } catch { payload = null; }
    if (!payload || typeof payload.name !== "string") {
      return res.status(204).end();
    }
    bump(payload.name);
    // Don't echo any client data in the response — keep it a fire-and-
    // forget beacon.
    res.status(204).end();
  });

  // Minimal "what's hot today" endpoint for the home page / a future
  // admin view.  Returns the in-process counters; meaningless across
  // multi-instance Vercel deploys but useful for a single-host dev.
  app.get("/api/track/summary", (_req, res) => {
    res.json({
      counters: Object.fromEntries(COUNTS),
      generatedAt: new Date().toISOString(),
    });
  });
}

module.exports = { mount };
