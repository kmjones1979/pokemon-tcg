// Admin airdrop endpoint — gates a card-grant operation behind the
// ADMIN_USER_IDS env allowlist. Tests cover the auth/admin gates, the
// happy-path insert, and validation of recipient + pokemon ids.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const express = require("express");
const http = require("http");

// Stash + restore env so other tests don't see our admin allowlist.
const _origAdminIds = process.env.ADMIN_USER_IDS;

// ---- Stub Supabase that records upserts -----------------------------

function makeStubSupabase({
  recipient = { id: "rec-1", display_name: "Recipient" },
  pokemon   = { id: 25, name: "Pikachu" },
  existing  = null,             // null = no current owned_cards row
  upsertError = null,
} = {}) {
  const upserts = [];
  return {
    upserts,
    from(table) {
      const ctx = { table, mode: null };
      const builder = {
        select(_c, opts) {
          if (opts?.head) ctx.mode = "count";
          return this;
        },
        eq() { return this; },
        upsert(row) {
          if (table === "owned_cards") {
            upserts.push(row);
            return Promise.resolve({ error: upsertError });
          }
          return Promise.resolve({ error: null });
        },
        maybeSingle() {
          if (table === "users")   return Promise.resolve({ data: recipient, error: null });
          if (table === "pokemon") return Promise.resolve({ data: pokemon,   error: null });
          if (table === "owned_cards") return Promise.resolve({ data: existing, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); },
      };
      return builder;
    },
  };
}

function bootApp(supabase, { user } = {}) {
  const app = express();
  app.use(express.json());
  // Test auth shim: req.user gets set from the x-test-user-id header.
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  const admin = require("../server-modules/admin");
  admin.mount(app, supabase);
  return app;
}

async function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const payload = body ? JSON.stringify(body) : "";
      const req = http.request({
        method, host: "127.0.0.1", port, path,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      }, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          server.close();
          let json = null; try { json = JSON.parse(buf); } catch {}
          resolve({ status: res.statusCode, json });
        });
      });
      req.on("error", (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

// ---- Tests ----------------------------------------------------------

test("airdrop requires auth (401 without req.user)", async () => {
  process.env.ADMIN_USER_IDS = "admin-1";
  const app = bootApp(makeStubSupabase(), { user: null });
  const r = await request(app, "POST", "/me/admin/airdrop", { recipientUserId: "rec-1", pokemonId: 25 });
  assert.equal(r.status, 401);
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

test("airdrop refuses non-admins (403)", async () => {
  process.env.ADMIN_USER_IDS = "admin-1";
  const app = bootApp(makeStubSupabase(), { user: { id: "not-admin" } });
  const r = await request(app, "POST", "/me/admin/airdrop", { recipientUserId: "rec-1", pokemonId: 25 });
  assert.equal(r.status, 403);
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

test("airdrop happy path — admin grants 1 Pikachu to recipient", async () => {
  process.env.ADMIN_USER_IDS = "admin-1";
  const sb = makeStubSupabase({
    recipient: { id: "leon", display_name: "Leon-ug0" },
    pokemon:   { id: 612, name: "Haxorus" },
    existing: null,
  });
  const app = bootApp(sb, { user: { id: "admin-1" } });
  const r = await request(app, "POST", "/me/admin/airdrop", {
    recipientUserId: "leon", pokemonId: 612, quantity: 1,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.recipient.display_name, "Leon-ug0");
  assert.equal(r.json.pokemon.name, "Haxorus");
  assert.equal(r.json.quantityAdded, 1);
  assert.equal(r.json.newTotal, 1);
  // One upsert was recorded.
  assert.equal(sb.upserts.length, 1);
  assert.equal(sb.upserts[0].user_id, "leon");
  assert.equal(sb.upserts[0].pokemon_id, 612);
  assert.equal(sb.upserts[0].quantity, 1);
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

test("airdrop adds to existing quantity (idempotent stacking)", async () => {
  process.env.ADMIN_USER_IDS = "admin-1";
  const sb = makeStubSupabase({
    existing: { quantity: 3 },
  });
  const app = bootApp(sb, { user: { id: "admin-1" } });
  const r = await request(app, "POST", "/me/admin/airdrop", {
    recipientUserId: "rec-1", pokemonId: 25, quantity: 2,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.newTotal, 5);
  assert.equal(sb.upserts[0].quantity, 5);
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

test("airdrop caps at 999 to prevent runaway scripts", async () => {
  process.env.ADMIN_USER_IDS = "admin-1";
  const sb = makeStubSupabase({
    existing: { quantity: 998 },
  });
  const app = bootApp(sb, { user: { id: "admin-1" } });
  const r = await request(app, "POST", "/me/admin/airdrop", {
    recipientUserId: "rec-1", pokemonId: 25, quantity: 50,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.newTotal, 999, "should clamp at 999 even with a 50-card request");
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

test("airdrop rejects missing recipientUserId", async () => {
  process.env.ADMIN_USER_IDS = "admin-1";
  const app = bootApp(makeStubSupabase(), { user: { id: "admin-1" } });
  const r = await request(app, "POST", "/me/admin/airdrop", { pokemonId: 25 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /recipientUserId/);
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

test("airdrop rejects invalid pokemonId", async () => {
  process.env.ADMIN_USER_IDS = "admin-1";
  const app = bootApp(makeStubSupabase(), { user: { id: "admin-1" } });
  const r = await request(app, "POST", "/me/admin/airdrop", { recipientUserId: "rec-1", pokemonId: -5 });
  assert.equal(r.status, 400);
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

test("airdrop returns 404 if recipient doesn't exist", async () => {
  process.env.ADMIN_USER_IDS = "admin-1";
  const sb = makeStubSupabase({ recipient: null });
  const app = bootApp(sb, { user: { id: "admin-1" } });
  const r = await request(app, "POST", "/me/admin/airdrop", { recipientUserId: "ghost", pokemonId: 25 });
  assert.equal(r.status, 404);
  assert.match(r.json.error, /recipient/i);
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

test("airdrop returns 404 if pokémon doesn't exist", async () => {
  process.env.ADMIN_USER_IDS = "admin-1";
  const sb = makeStubSupabase({ pokemon: null });
  const app = bootApp(sb, { user: { id: "admin-1" } });
  const r = await request(app, "POST", "/me/admin/airdrop", { recipientUserId: "rec-1", pokemonId: 99999 });
  assert.equal(r.status, 404);
  assert.match(r.json.error, /Pokémon/);
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

test("ADMIN_USER_IDS allowlist parses comma-separated values + trims", () => {
  const { parseAdminIds, isAdmin } = require("../server-modules/admin");
  process.env.ADMIN_USER_IDS = "uuid-a , uuid-b,uuid-c";
  const set = parseAdminIds();
  assert.equal(set.has("uuid-a"), true);
  assert.equal(set.has("uuid-b"), true);
  assert.equal(set.has("uuid-c"), true);
  assert.equal(set.size, 3);
  assert.equal(isAdmin("uuid-b"), true);
  assert.equal(isAdmin("uuid-d"), false);
  assert.equal(isAdmin(null), false);
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});
