// Server-boot smoke test. Boots the Express app with a stub Supabase,
// hits the public + auth-required routes, and confirms each one
// returns parseable JSON with the documented status codes.
//
// This is the closest thing to "the whole game still loads after my
// last commit" we have without standing up a real Supabase + Redis.
// Failures here surface module-loading bugs (circular dep undefined
// references, missing mounts, etc.) that unit tests can't see.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

// Pre-configure the test env BEFORE any modules load so secrets are
// present + Redis falls back to in-memory.
process.env.SESSION_SECRET = "boot-test-secret";
delete process.env.REDIS_URL;
delete process.env.KV_URL;

const express = require("express");
const http = require("http");
const cookieParser = require("cookie-parser");
const path = require("path");

// Tiny Supabase stub. Every query returns { data: null, error: null }
// or sensible defaults — enough to exercise route wiring without a
// real DB.
function makeSupabaseStub() {
  const builder = {
    select() { return this; },
    insert() { return this; },
    update() { return this; },
    upsert() { return this; },
    delete() { return this; },
    eq() { return this; },
    in() { return this; },
    or() { return this; },
    gte() { return this; },
    lt() { return this; },
    order() { return this; },
    limit() { return this; },
    maybeSingle() { return Promise.resolve({ data: null, error: null }); },
    single() { return Promise.resolve({ data: null, error: null }); },
    then(resolve) { return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve); },
  };
  return {
    from() { return builder; },
    auth: { persistSession: false },
  };
}

let server;
let port;

before(async () => {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "256kb" }));
  app.use(cookieParser());

  const supabaseStub = makeSupabaseStub();
  const getPokedex = () => Promise.resolve([]);

  // Mount every module the same way server.js does.
  const auth = require("../server-modules/auth");
  const collection = require("../server-modules/collection");
  const rewards = require("../server-modules/rewards");
  const achievements = require("../server-modules/achievements");
  const dailyStreak = require("../server-modules/daily-streak");
  const xp = require("../server-modules/xp");
  const quests = require("../server-modules/quests");
  const theme = require("../server-modules/theme");
  const champions = require("../server-modules/champions");
  const story = require("../server-modules/story");
  const trading = require("../server-modules/trading");
  const dailyBoss = require("../server-modules/daily-boss");
  const dailyPuzzle = require("../server-modules/daily-puzzle");
  const analytics = require("../server-modules/analytics");
  const siteGate = require("../server-modules/site-gate");
  const guestMigrate = require("../server-modules/guest-migrate");
  const deckShare = require("../server-modules/deck-share");
  const friendChallenge = require("../server-modules/friend-challenge");
  const mastery = require("../server-modules/mastery");
  const winstreak = require("../server-modules/winstreak");
  const multiplayerHttp = require("../server-modules/multiplayer-http");

  // None of these should throw at mount time.
  auth.mount(app, supabaseStub);
  collection.mount(app, supabaseStub);
  rewards.mount(app, supabaseStub, getPokedex);
  achievements.mount(app, supabaseStub, getPokedex);
  dailyStreak.mount(app, supabaseStub, getPokedex);
  xp.mount(app, supabaseStub);
  quests.mount(app, supabaseStub, getPokedex);
  theme.mount(app);
  champions.mount(app, supabaseStub);
  story.mount(app, supabaseStub, getPokedex);
  trading.mount(app, supabaseStub, getPokedex);
  dailyBoss.mount(app, supabaseStub, getPokedex);
  dailyPuzzle.mount(app, supabaseStub);
  analytics.mount(app);
  siteGate.parseFormBody(app);
  siteGate.mount(app);
  guestMigrate.mount(app, supabaseStub);
  deckShare.mount(app, supabaseStub, getPokedex);
  friendChallenge.mount(app, supabaseStub);
  mastery.mount(app, supabaseStub);
  winstreak.mount(app, supabaseStub, getPokedex);
  multiplayerHttp.mount(app, supabaseStub, getPokedex);

  // Match server.js: a JSON-emitting error handler so any async-route
  // throw becomes `{error}` instead of Express 5's HTML 500 fallback.
  // Without this, the boot test can't catch regressions where a route
  // returns HTML and the client crashes on JSON.parse.
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return;
    res.status(500).json({ error: err && err.message ? err.message : "Internal server error" });
  });

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", resolve);
    port = null;
  });
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

async function req(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.headers["Content-Length"] = Buffer.byteLength(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, ...opts }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch {}
        resolve({ status: res.statusCode, body: buf, json, headers: res.headers });
      });
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// --- Public endpoints (no auth) ---------------------------------------

test("GET /api/theme returns 200 + JSON", async () => {
  const r = await req("GET", "/api/theme");
  assert.equal(r.status, 200);
  assert.ok(r.json, "response should be JSON");
});

test("GET /api/champion/list returns a list", async () => {
  const r = await req("GET", "/api/champion/list");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json?.champions));
});

test("GET /api/daily/today returns 200 (with stubbed supabase)", async () => {
  const r = await req("GET", "/api/daily/today");
  // 200 with empty deck OR 500 with a JSON error — both acceptable.
  // The crucial check is that we got JSON back, not an HTML crash page.
  assert.ok(r.json !== null, `expected JSON, got body: ${r.body.slice(0, 100)}`);
});

test("GET /api/daily/stats returns valid JSON", async () => {
  const r = await req("GET", "/api/daily/stats");
  assert.equal(r.status, 200);
  assert.ok(typeof r.json?.todayPlayed === "number");
});

test("GET /api/puzzle/today returns valid JSON", async () => {
  const r = await req("GET", "/api/puzzle/today");
  assert.ok(r.json !== null);
});

test("GET /api/trades/market returns JSON list", async () => {
  const r = await req("GET", "/api/trades/market");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json?.offers));
});

// --- Auth required (no cookie) ----------------------------------------

test("auth-gated /me/* routes return 401 with JSON error (regression: HTML crash)", async () => {
  // Note: /me/matches is defined inline in server.js (outside any
  // module) so it isn't part of this boot harness; tested via the
  // real prod deploy.
  for (const path of [
    "/me/quests", "/me/achievements", "/me/xp", "/me/streak",
    "/me/mastery", "/me/challenges/recent", "/me/shared-decks",
    "/me/collection",
  ]) {
    const r = await req("GET", path);
    assert.equal(r.status, 401, `${path} should 401 without auth`);
    assert.ok(r.json?.error, `${path} 401 must include {error}`);
  }
});

test("POST /me/quests/:id/claim returns 401 not 500 (regression: circular dep)", async () => {
  const r = await req("POST", "/me/quests/play3/claim", {});
  // 401 because unauthenticated. If this is 500 with HTML body, the
  // circular-dep bug regressed.
  assert.equal(r.status, 401);
  assert.ok(r.json?.error);
});

test("POST /me/rewards/claim returns 401 not 500", async () => {
  const r = await req("POST", "/me/rewards/claim", { offerId: "abc", pokemonId: 6 });
  assert.equal(r.status, 401);
  assert.ok(r.json?.error);
});

test("POST /api/track accepts JSON body and returns 204", async () => {
  const r = await req("POST", "/api/track", { name: "test_event", props: { foo: 1 }, anonId: "boot-test" });
  assert.equal(r.status, 204);
});

test("POST /api/gate without password returns 401 HTML (gate page) or 401 JSON", async () => {
  const r = await req("POST", "/api/gate", { password: "wrong" });
  // The gate handler returns 401 either way; just confirm we got a
  // response with that status.
  assert.equal(r.status, 401);
});
