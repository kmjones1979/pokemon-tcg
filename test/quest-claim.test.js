// Regression tests for POST /me/quests/:id/claim — the "Claim Card"
// button on the daily quests panel. Originally returned an HTML 500 when
// any supabase-js call threw (network/auth-refresh), which the client
// parsed as "server returned non-JSON (status 500)". Every failure mode
// below must respond with a JSON `{error}` body so the client can show
// a useful message instead of crashing on JSON.parse.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

process.env.SESSION_SECRET = "quest-claim-test-secret";
delete process.env.REDIS_URL;
delete process.env.KV_URL;

const express = require("express");
const http = require("http");

const quests = require("../server-modules/quests");

// Hand-rolled supabase stub. Each call site is its own knob so a test
// can make exactly one query throw (or return an error row) and verify
// the route returns JSON.
function makeStub({
  lookup = { data: null, error: null }, // quest_claims.select.maybeSingle
  matches = { data: [], error: null },  // matches.select.or.gte.lt
  userRow = { data: null, error: null }, // users.select.eq.maybeSingle
  ownedCount = { count: 0, error: null }, // owned_cards count
  insert = { error: null },             // quest_claims.insert
  lookupThrows = null,
  matchesThrows = null,
  insertThrows = null,
} = {}) {
  return {
    from(table) {
      const ctx = { table, mode: null };
      const builder = {
        select(_cols, opts) {
          if (opts && opts.head && opts.count === "exact") ctx.mode = "count";
          return this;
        },
        insert() { ctx.mode = "insert"; return this; },
        update() { ctx.mode = "update"; return Promise.resolve({ error: null }); },
        eq() { return this; },
        or() { return this; },
        gte() { return this; },
        lt() { return this; },
        maybeSingle() {
          if (table === "quest_claims") {
            if (lookupThrows) return Promise.reject(lookupThrows);
            return Promise.resolve(lookup);
          }
          if (table === "users") return Promise.resolve(userRow);
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve, reject) {
          if (ctx.mode === "insert" && table === "quest_claims") {
            if (insertThrows) return Promise.reject(insertThrows).then(resolve, reject);
            return Promise.resolve(insert).then(resolve, reject);
          }
          if (ctx.mode === "count" && table === "owned_cards") {
            return Promise.resolve(ownedCount).then(resolve, reject);
          }
          if (table === "matches") {
            if (matchesThrows) return Promise.reject(matchesThrows).then(resolve, reject);
            return Promise.resolve(matches).then(resolve, reject);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
    auth: { persistSession: false },
  };
}

// Pokédex stub — 30 cards across tiers so rollPicks always succeeds.
function makePokedex() {
  const out = [];
  for (let i = 1; i <= 30; i++) {
    out.push({
      id: i,
      name: `Mon${i}`,
      types: ["normal"],
      tier: ((i - 1) % 5) + 1,
      energyCost: 1,
      cardHp: 30,
      cardAttack: 10,
      sprite_front: "x",
      is_legendary: false,
      is_mythical: false,
    });
  }
  return out;
}

// Force the route to skip the "Quest not yet complete" 400 branch by
// stubbing computeProgress to satisfy any target. We do this by patching
// the users table to return today's tallies above target.
function userRowWithProgress() {
  const today = new Date();
  const y = today.getUTCFullYear();
  const m = String(today.getUTCMonth() + 1).padStart(2, "0");
  const d = String(today.getUTCDate()).padStart(2, "0");
  const dayKey = `${y}-${m}-${d}`;
  return {
    data: {
      quest_progress: {
        [dayKey]: { matches: 999, wins: 999, kos: 999 },
      },
    },
    error: null,
  };
}

let server;
let port;
let stubRef;

function buildApp(stub, opts = {}) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  // Test-only auth shim: any request with x-test-user-id gets req.user.
  app.use((req, _res, next) => {
    const id = req.headers["x-test-user-id"];
    if (id) req.user = { id: String(id) };
    next();
  });
  quests.mount(app, stub, () => (opts.emptyPokedex ? [] : makePokedex()));
  // Mirror server.js: JSON error middleware. Any throw past the route
  // must still come back as JSON, not Express's HTML 500.
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return;
    res.status(500).json({ error: err && err.message ? err.message : "Internal server error" });
  });
  return app;
}

async function bootWith(stub, opts) {
  const app = buildApp(stub, opts);
  return new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

async function req(method, path, { body, userId } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (userId) headers["x-test-user-id"] = userId;
  const opts = { method, headers, host: "127.0.0.1", port, path };
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
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

async function withServer(stub, opts, fn) {
  const s = await bootWith(stub, opts);
  port = s.address().port;
  server = s;
  try {
    return await fn();
  } finally {
    await new Promise((r) => s.close(r));
  }
}

// pickTwoQuests is deterministic per (userId, day). For our test user
// "test-user" today, we don't actually care which two quests come up —
// we'll just try each one in the pool until we find one of the two.
async function postClaimAnyQuest(userId) {
  // Try every quest id; one of these two will match today's deterministic
  // pair and exercise the real route logic. The others 404 — also JSON.
  const ids = ["play3", "win2", "ko10", "win5", "collect5", "win3"];
  const results = [];
  for (const id of ids) {
    const r = await req("POST", `/me/quests/${id}/claim`, { userId });
    results.push({ id, ...r });
  }
  return results;
}

// --- Tests ------------------------------------------------------------

test("claim returns JSON 401 when unauthenticated (no HTML)", async () => {
  await withServer(makeStub(), {}, async () => {
    const r = await req("POST", "/me/quests/play3/claim");
    assert.equal(r.status, 401);
    assert.ok(r.json?.error, "401 must include {error}");
    assert.ok(!r.body.startsWith("<"), "body must be JSON, not HTML");
  });
});

test("claim returns JSON 503 when pokedex unavailable", async () => {
  await withServer(makeStub(), { emptyPokedex: true }, async () => {
    const r = await req("POST", "/me/quests/play3/claim", { userId: "test-user" });
    assert.equal(r.status, 503);
    assert.ok(r.json?.error);
    assert.ok(!r.body.startsWith("<"));
  });
});

test("claim returns JSON 404 for unknown quest id (not today's pair)", async () => {
  // "zzz" is never in the pool, so it'll always 404 regardless of which
  // two quests the deterministic picker chose.
  await withServer(makeStub(), {}, async () => {
    const r = await req("POST", "/me/quests/zzz/claim", { userId: "test-user" });
    assert.equal(r.status, 404);
    assert.ok(r.json?.error);
  });
});

test("claim returns JSON 500 (not HTML) when supabase lookup THROWS", async () => {
  // Regression: previously, supabase-js throwing on network/auth refresh
  // would bubble up to Express 5's default error handler, which sends
  // HTML. The client then alerts "server returned non-JSON (status 500)".
  // After the fix, this must always be JSON.
  const stub = makeStub({
    lookupThrows: new Error("fetch failed: network unreachable"),
  });
  await withServer(stub, {}, async () => {
    const results = await postClaimAnyQuest("test-user");
    // For the quest ids that match today's pair (2 of them), we should
    // see 500 with JSON error mentioning the network failure.
    const five00s = results.filter((r) => r.status === 500);
    assert.ok(five00s.length >= 1, "at least one quest id should hit the lookup throw path");
    for (const r of five00s) {
      assert.ok(r.json?.error, `500 must include {error}; got body: ${r.body.slice(0, 100)}`);
      assert.ok(!r.body.startsWith("<"), `body must be JSON, got: ${r.body.slice(0, 100)}`);
      assert.match(r.json.error, /claim status|network/i);
    }
  });
});

test("claim returns JSON 500 (not HTML) when computeProgress THROWS", async () => {
  // `computeProgress` queries the matches table first. If supabase-js
  // throws there, the route must still return JSON.
  const stub = makeStub({
    matchesThrows: new Error("fetch failed: ETIMEDOUT"),
  });
  await withServer(stub, {}, async () => {
    const results = await postClaimAnyQuest("test-user");
    const five00s = results.filter((r) => r.status === 500);
    assert.ok(five00s.length >= 1);
    for (const r of five00s) {
      assert.ok(r.json?.error);
      assert.ok(!r.body.startsWith("<"));
      assert.match(r.json.error, /progress|network/i);
    }
  });
});

test("claim returns JSON 500 (not HTML) when claim INSERT throws", async () => {
  // Lookup succeeds, progress meets target, picks roll fine, createOffer
  // succeeds — but the final insert into quest_claims throws. Must be JSON.
  const stub = makeStub({
    userRow: userRowWithProgress(),
    insertThrows: new Error("fetch failed: socket hang up"),
  });
  await withServer(stub, {}, async () => {
    const results = await postClaimAnyQuest("test-user");
    const five00s = results.filter((r) => r.status === 500);
    assert.ok(five00s.length >= 1, "insert throw should produce at least one 500");
    for (const r of five00s) {
      assert.ok(r.json?.error);
      assert.ok(!r.body.startsWith("<"));
      assert.match(r.json.error, /record claim|network/i);
    }
  });
});

test("claim returns JSON 409 on duplicate-key insert error (race)", async () => {
  const stub = makeStub({
    userRow: userRowWithProgress(),
    insert: { error: { code: "23505", message: "duplicate key" } },
  });
  await withServer(stub, {}, async () => {
    const results = await postClaimAnyQuest("test-user");
    const has409 = results.some((r) => r.status === 409 && r.json?.error);
    assert.ok(has409, "duplicate key must surface as 409 JSON");
  });
});

test("claim returns JSON 500 when insert returns a non-23505 error", async () => {
  const stub = makeStub({
    userRow: userRowWithProgress(),
    insert: { error: { code: "42P01", message: "relation does not exist" } },
  });
  await withServer(stub, {}, async () => {
    const results = await postClaimAnyQuest("test-user");
    const has500 = results.some((r) => r.status === 500 && /record claim/i.test(r.json?.error || ""));
    assert.ok(has500, "non-duplicate insert errors must surface as JSON 500");
  });
});

test("claim returns JSON 400 when progress is below target", async () => {
  // No progress in user row → all metrics 0 → fails target check.
  const stub = makeStub({
    userRow: { data: { quest_progress: {} }, error: null },
  });
  await withServer(stub, {}, async () => {
    const results = await postClaimAnyQuest("test-user");
    const has400 = results.some((r) => r.status === 400 && /not yet complete/i.test(r.json?.error || ""));
    assert.ok(has400, "below-target must surface as JSON 400");
  });
});

test("claim returns JSON 409 when already claimed today", async () => {
  const stub = makeStub({
    lookup: { data: { quest_id: "play3" }, error: null },
  });
  await withServer(stub, {}, async () => {
    const results = await postClaimAnyQuest("test-user");
    const has409 = results.some((r) => r.status === 409 && /already claimed/i.test(r.json?.error || ""));
    assert.ok(has409, "already-claimed must surface as JSON 409");
  });
});

test("every response from claim has Content-Type application/json", async () => {
  // Belt-and-suspenders sweep: across all the failure modes above, no
  // response should ever leak HTML through.
  const stubs = [
    makeStub({ lookupThrows: new Error("net") }),
    makeStub({ matchesThrows: new Error("net") }),
    makeStub({ userRow: userRowWithProgress(), insertThrows: new Error("net") }),
    makeStub({ userRow: userRowWithProgress(), insert: { error: { code: "23505", message: "dup" } } }),
    makeStub({ userRow: userRowWithProgress(), insert: { error: { code: "42P01", message: "missing" } } }),
    makeStub({ lookup: { data: { quest_id: "play3" }, error: null } }),
    makeStub({ userRow: { data: { quest_progress: {} }, error: null } }),
  ];
  for (const stub of stubs) {
    await withServer(stub, {}, async () => {
      const results = await postClaimAnyQuest("test-user");
      for (const r of results) {
        // 401s won't fire here because we authed, but any non-2xx must
        // still be JSON.
        assert.ok(
          (r.headers["content-type"] || "").includes("application/json"),
          `expected JSON content-type, got: ${r.headers["content-type"]} body: ${r.body.slice(0, 100)}`,
        );
        assert.ok(!r.body.startsWith("<"), `HTML leak detected: ${r.body.slice(0, 100)}`);
      }
    });
  }
});
