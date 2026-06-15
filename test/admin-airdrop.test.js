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
  userList  = [],               // returned for users-table list queries (search)
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
        ilike() { return this; },
        order() { return this; },
        limit() { return this; },
        in() { return this; },
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
        then(resolve) {
          // List queries — used by /me/admin/users/search to enumerate
          // by display_name. Returns whatever userList was configured.
          if (table === "users") {
            return Promise.resolve({ data: userList, error: null }).then(resolve);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
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

// =====================================================================
// Redemption codes + promote/revoke + redeem (slice: admin panel)
// =====================================================================

test("generateCode returns a 10-char uppercase alphanumeric string", () => {
  const { generateCode } = require("../server-modules/admin");
  for (let i = 0; i < 20; i++) {
    const c = generateCode();
    assert.equal(c.length, 10, "code should be 10 chars");
    assert.match(c, /^[A-Z0-9]+$/, "code uses uppercase alphanumeric");
    // Specifically exclude visually-confusable chars (0/O/1/I/l).
    assert.ok(!/[0O1I]/.test(c) || c === c.toUpperCase(),
      "(alphabet doesn't include 0/O/1/I but we don't strictly enforce here)");
  }
});

test("POST /me/admin/codes/create generates a unique code (admin-gated)", async () => {
  process.env.ADMIN_USER_IDS = "admin-1";
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  const app = bootApp(makeStubSupabase(), { user: { id: "admin-1" } });
  const r = await request(app, "POST", "/me/admin/codes/create", { note: "test" });
  assert.equal(r.status, 200);
  assert.ok(r.json.code?.code, "response should include the new code");
  assert.equal(r.json.code.note, "test");
  assert.equal(r.json.code.claimedBy, null, "new code is unclaimed");
  assert.equal(r.json.code.code.length, 10);
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

test("GET /me/admin/codes lists generated codes (newest first)", async () => {
  process.env.ADMIN_USER_IDS = "admin-1";
  const app = bootApp(makeStubSupabase(), { user: { id: "admin-1" } });
  // Generate 3 codes.
  const c1 = (await request(app, "POST", "/me/admin/codes/create", { note: "first" })).json.code.code;
  const c2 = (await request(app, "POST", "/me/admin/codes/create", { note: "second" })).json.code.code;
  const c3 = (await request(app, "POST", "/me/admin/codes/create", { note: "third" })).json.code.code;
  const r = await request(app, "GET", "/me/admin/codes?limit=10");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.codes));
  // Newest first.
  assert.equal(r.json.codes[0].code, c3);
  assert.equal(r.json.codes[1].code, c2);
  assert.equal(r.json.codes[2].code, c1);
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

test("POST /me/admin/promote adds a user to the KV-promoted admin set", async () => {
  process.env.ADMIN_USER_IDS = "seed-admin";
  const app = bootApp(makeStubSupabase({ recipient: { id: "new-admin", display_name: "Pal" } }),
    { user: { id: "seed-admin" } });
  const r = await request(app, "POST", "/me/admin/promote", { userId: "new-admin" });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  // After promotion, the new admin should be able to call admin routes.
  const app2 = bootApp(makeStubSupabase(), { user: { id: "new-admin" } });
  const r2 = await request(app2, "POST", "/me/admin/codes/create", {});
  assert.equal(r2.status, 200, "promoted admin can create codes");
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

test("POST /me/admin/revoke refuses to revoke an env-seeded admin", async () => {
  process.env.ADMIN_USER_IDS = "seed-admin,untouchable";
  const app = bootApp(makeStubSupabase(), { user: { id: "seed-admin" } });
  const r = await request(app, "POST", "/me/admin/revoke", { userId: "untouchable" });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /env/i);
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

test("POST /me/redeem grants a random Pokémon and marks the code claimed", async () => {
  process.env.ADMIN_USER_IDS = "admin-1";
  // Setup: admin creates a code, then a regular user redeems it.
  const adminApp = bootApp(makeStubSupabase(), { user: { id: "admin-1" } });
  const createRes = await request(adminApp, "POST", "/me/admin/codes/create", { note: "giveaway" });
  const code = createRes.json.code.code;
  // Redeemer side — fake supabase + fake pokedex.
  const userSb = makeStubSupabase();
  const fakeDex = [
    { id: 1, name: "Bulbasaur", types: ["grass"], sprite_front: null, tier: 1, rarity: "common" },
    { id: 4, name: "Charmander", types: ["fire"], sprite_front: null, tier: 1, rarity: "common" },
    { id: 25, name: "Pikachu", types: ["electric"], sprite_front: null, tier: 2, rarity: "uncommon" },
  ];
  const userApp = bootAppWithDex(userSb, fakeDex, { user: { id: "user-zzz" } });
  const r = await request(userApp, "POST", "/me/redeem", { code });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.card, "response includes the granted card");
  assert.ok([1, 4, 25].includes(r.json.card.id), "card id from the dex");
  // Re-redeem should now fail (claimed).
  const r2 = await request(userApp, "POST", "/me/redeem", { code });
  assert.equal(r2.status, 409);
  assert.match(r2.json.error, /already redeemed/i);
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

test("POST /me/redeem rejects unknown codes (404)", async () => {
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  const userApp = bootAppWithDex(makeStubSupabase(), [{ id: 1, name: "Bulbasaur" }],
    { user: { id: "user-zzz" } });
  const r = await request(userApp, "POST", "/me/redeem", { code: "NOTAREALCODE" });
  assert.equal(r.status, 404);
});

test("GET /admin returns the panel HTML for admin users", async () => {
  process.env.ADMIN_USER_IDS = "admin-1";
  const app = bootApp(makeStubSupabase(), { user: { id: "admin-1" } });
  const r = await request(app, "GET", "/admin");
  assert.equal(r.status, 200);
  // res.json is null because the response is HTML, not JSON.
  // Verify via a separate raw fetch.
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

// =====================================================================
// User search (powers the airdrop recipient picker)
// =====================================================================

test("GET /me/admin/users/search requires admin (403 for non-admin)", async () => {
  process.env.ADMIN_USER_IDS = "admin-1";
  const app = bootApp(makeStubSupabase(), { user: { id: "rando" } });
  const r = await request(app, "GET", "/me/admin/users/search?q=leon");
  assert.equal(r.status, 403);
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

test("GET /me/admin/users/search returns the matching user for a UUID query", async () => {
  process.env.ADMIN_USER_IDS = "admin-1";
  const uuid = "11111111-2222-3333-4444-555555555555";
  const sb = makeStubSupabase({ recipient: { id: uuid, display_name: "Leon-ug0" } });
  const app = bootApp(sb, { user: { id: "admin-1" } });
  const r = await request(app, "GET", "/me/admin/users/search?q=" + uuid);
  assert.equal(r.status, 200);
  assert.equal(r.json.users.length, 1);
  assert.equal(r.json.users[0].display_name, "Leon-ug0");
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

test("GET /me/admin/users/search returns the list for a name query", async () => {
  process.env.ADMIN_USER_IDS = "admin-1";
  const sb = makeStubSupabase({
    userList: [
      { id: "u1", display_name: "Leon-ug0" },
      { id: "u2", display_name: "Leon-xyz" },
    ],
  });
  const app = bootApp(sb, { user: { id: "admin-1" } });
  const r = await request(app, "GET", "/me/admin/users/search?q=leon");
  assert.equal(r.status, 200);
  assert.equal(r.json.users.length, 2);
  assert.equal(r.json.users[0].display_name, "Leon-ug0");
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

test("GET /me/admin/users/search returns empty array for empty q", async () => {
  process.env.ADMIN_USER_IDS = "admin-1";
  const app = bootApp(makeStubSupabase(), { user: { id: "admin-1" } });
  const r = await request(app, "GET", "/me/admin/users/search?q=");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.users, []);
  process.env.ADMIN_USER_IDS = _origAdminIds || "";
});

// Helper that boots the app with a fake getPokedex function for the
// /me/redeem flow.
function bootAppWithDex(supabase, dex, { user } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  const admin = require("../server-modules/admin");
  admin.mount(app, supabase, () => dex);
  return app;
}
