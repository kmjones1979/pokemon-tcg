// Admin-only endpoints. Two-tier admin allowlist:
//
//   1. ADMIN_USER_IDS env var (seed admins) — comma-separated UUIDs.
//      Cannot be removed via the panel; intended for bootstrap admins.
//   2. KV-backed promoted-admin set ("admin:promoted") — admins added
//      from the admin panel UI. Stored in the Redis-backed state-store
//      so promotions survive deploys and don't require an env update.
//
// Why the hybrid:
//   - Env seeds let us bootstrap admin access without a chicken-and-
//     egg problem (someone needs to be admin BEFORE the panel can
//     create more admins).
//   - KV-promoted admins let real admins onboard each other from the
//     panel — no redeploy, no shell access required.
//
// Routes:
//   POST /me/admin/airdrop         body { recipientUserId, pokemonId, quantity?=1 }
//   GET  /me/admin/users/search    ?q=name|uuid   → { users: [...] }
//   POST /me/admin/codes/create    body { note? } → { code }
//   GET  /me/admin/codes                          → { codes: [...] }
//   POST /me/admin/promote         body { userId }
//   POST /me/admin/revoke          body { userId }
//   GET  /me/admin/admins                         → { admins: [...] }
//   POST /me/redeem                body { code }  → { card, newQuantity }
//                                  (any signed-in user)

const store = require("./state-store");
const PROMOTED_KEY = "admin:promoted";
const CODE_INDEX_KEY = "admin:redeem-codes";
const CODE_PREFIX = "redeem:";
const CODE_LENGTH = 10;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/l

function parseAdminIds() {
  const raw = process.env.ADMIN_USER_IDS || "";
  return new Set(
    raw.split(",").map((s) => s.trim()).filter(Boolean),
  );
}

async function getPromotedAdmins() {
  // Stored as a JSON array of UUIDs under a single KV key. Read-on-
  // demand; we don't cache because the set changes rarely and the
  // KV read is one round-trip.
  const raw = await store.kvGet(PROMOTED_KEY);
  if (!raw) return new Set();
  try {
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

async function isAdminAsync(userId) {
  if (!userId) return false;
  if (parseAdminIds().has(String(userId))) return true;
  const promoted = await getPromotedAdmins();
  return promoted.has(String(userId));
}

// Sync env-only check (used in places that can't await — falls back
// to the env list. Doesn't see promoted admins but is safe to use
// in non-critical guards. Most callers should use isAdminAsync.)
function isAdmin(userId) {
  if (!userId) return false;
  return parseAdminIds().has(String(userId));
}

function generateCode(rand = Math.random) {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  }
  return s;
}

// Small middleware factory: gates a route behind admin status (env or
// KV-promoted). Async-aware. Sends 401 / 403 if unauthorised.
function requireAdmin() {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    if (!(await isAdminAsync(req.user.id))) {
      return res.status(403).json({ error: "Admin only." });
    }
    next();
  };
}

function mount(app, supabase, getPokedex) {
  // POST /me/admin/airdrop — grants `quantity` copies of `pokemonId`
  // to `recipientUserId`. Idempotent on (user_id, pokemon_id) — re-
  // runs add to the existing quantity instead of erroring.
  app.post("/me/admin/airdrop", requireAdmin(), async (req, res) => {
    if (!supabase) return res.status(503).json({ error: "DB unavailable." });

    const recipientUserId = String(req.body?.recipientUserId || "");
    const pokemonId = Number(req.body?.pokemonId);
    const quantity = Math.max(1, Math.min(99, Number(req.body?.quantity) || 1));

    if (!recipientUserId) {
      return res.status(400).json({ error: "recipientUserId required" });
    }
    if (!Number.isInteger(pokemonId) || pokemonId < 1) {
      return res.status(400).json({ error: "pokemonId must be a positive integer" });
    }

    // Validate the recipient exists. Surface a clean 404 instead of an
    // opaque FK violation on the insert.
    let recipientRow;
    try {
      const { data, error } = await supabase
        .from("users")
        .select("id, display_name")
        .eq("id", recipientUserId)
        .maybeSingle();
      if (error) throw error;
      recipientRow = data;
    } catch (err) {
      console.error("[admin] recipient lookup threw:", err);
      return res.status(500).json({ error: `Recipient lookup failed: ${err.message || "unknown"}` });
    }
    if (!recipientRow) {
      return res.status(404).json({ error: "Recipient user not found." });
    }

    // Validate the pokémon id exists in the pokedex table.
    let pokeRow;
    try {
      const { data, error } = await supabase
        .from("pokemon")
        .select("id, name")
        .eq("id", pokemonId)
        .maybeSingle();
      if (error) throw error;
      pokeRow = data;
    } catch (err) {
      console.error("[admin] pokemon lookup threw:", err);
      return res.status(500).json({ error: `Pokémon lookup failed: ${err.message || "unknown"}` });
    }
    if (!pokeRow) {
      return res.status(404).json({ error: `Pokémon #${pokemonId} not found.` });
    }

    // Read current quantity (if any), then upsert with the new total.
    // Capped at 999 so a runaway script can't pollute the column with
    // absurd numbers.
    let existing;
    try {
      const { data, error } = await supabase
        .from("owned_cards")
        .select("quantity")
        .eq("user_id", recipientUserId)
        .eq("pokemon_id", pokemonId)
        .maybeSingle();
      if (error) throw error;
      existing = data;
    } catch (err) {
      console.error("[admin] owned_cards read threw:", err);
      return res.status(500).json({ error: `Collection read failed: ${err.message || "unknown"}` });
    }

    const newQty = Math.min(999, (existing?.quantity || 0) + quantity);

    try {
      const { error } = await supabase
        .from("owned_cards")
        .upsert(
          {
            user_id: recipientUserId,
            pokemon_id: pokemonId,
            quantity: newQty,
            acquired_at: new Date().toISOString(),
          },
          { onConflict: "user_id,pokemon_id" },
        );
      if (error) throw error;
    } catch (err) {
      console.error("[admin] airdrop upsert threw:", err);
      return res.status(500).json({ error: `Airdrop failed: ${err.message || "unknown"}` });
    }

    // Audit log — stays in the function logs so admin actions are
    // greppable post-hoc.
    console.log(
      `[admin] airdrop by ${req.user.id} → recipient=${recipientUserId} (${recipientRow.display_name})`
      + ` pokemon=${pokemonId} (${pokeRow.name}) quantity=${quantity} newTotal=${newQty}`,
    );

    res.json({
      ok: true,
      recipient: { id: recipientUserId, display_name: recipientRow.display_name },
      pokemon:   { id: pokemonId, name: pokeRow.name },
      quantityAdded: quantity,
      newTotal: newQty,
    });
  });

  // GET /me/admin/users/search — fuzzy lookup by display_name (ilike)
  // or exact UUID match. Powers the airdrop recipient picker so admins
  // don't have to copy/paste UUIDs.
  app.get("/me/admin/users/search", requireAdmin(), async (req, res) => {
    if (!supabase) return res.status(503).json({ error: "DB unavailable." });
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ users: [] });
    // Looks like a UUID? Try exact match first.
    const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);
    try {
      if (uuidLike) {
        const { data } = await supabase.from("users").select("id, display_name").eq("id", q).maybeSingle();
        return res.json({ users: data ? [data] : [] });
      }
      const { data, error } = await supabase
        .from("users")
        .select("id, display_name")
        .ilike("display_name", `%${q}%`)
        .order("display_name", { ascending: true })
        .limit(20);
      if (error) throw error;
      res.json({ users: data || [] });
    } catch (err) {
      console.error("[admin] user search threw:", err);
      res.status(500).json({ error: `Search failed: ${err.message || "unknown"}` });
    }
  });

  // ===== Admin panel page (served HTML) =============================
  //
  // Single-file static-ish HTML page that talks to the admin API
  // endpoints below. Auth gate happens via the same session cookie
  // the rest of the app uses — if the page-visitor isn't an admin,
  // the API calls 403 and the UI surfaces the message.

  app.get("/admin", async (req, res) => {
    // Soft auth check — render the page either way, but show a
    // sign-in / not-admin message if appropriate. The API calls
    // enforce the real gate.
    const adminOk = req.user && (await isAdminAsync(req.user.id));
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(renderAdminPage({ adminOk, userId: req.user?.id }));
  });

  // ===== Redemption codes ============================================
  //
  // Codes are generated by admins, claimed by any signed-in user.
  // Stored as JSON under `redeem:<code>` in the KV store with shape:
  //   { code, createdBy, createdAt, note, claimedBy?, claimedAt?,
  //     claimedPokemonId?, claimedPokemonName? }
  // An index key (CODE_INDEX_KEY) holds a JSON array of all known
  // codes (most-recent first, capped at 500) so the admin panel can
  // list them without a KEYS scan.

  // POST /me/admin/codes/create — generate a new code. No limit on
  // how many an admin can create; index is capped at 500 entries to
  // keep the panel listing snappy.
  app.post("/me/admin/codes/create", requireAdmin(), async (req, res) => {
    const note = String(req.body?.note || "").slice(0, 80);
    // Generate with a collision-retry — astronomically unlikely with
    // a 10-char alphabet but the loop costs nothing.
    let code;
    for (let i = 0; i < 8; i++) {
      const candidate = generateCode();
      if (!(await store.kvGet(CODE_PREFIX + candidate))) {
        code = candidate;
        break;
      }
    }
    if (!code) return res.status(500).json({ error: "Couldn't generate a unique code — try again." });
    const row = {
      code,
      createdBy: req.user.id,
      createdAt: new Date().toISOString(),
      note,
      claimedBy: null,
      claimedAt: null,
      claimedPokemonId: null,
      claimedPokemonName: null,
    };
    await store.kvSet(CODE_PREFIX + code, row, 60 * 60 * 24 * 365); // 1y TTL
    // Update the index (newest first, cap 500).
    let index = (await store.kvGet(CODE_INDEX_KEY)) || [];
    if (!Array.isArray(index)) index = [];
    index = [code, ...index.filter((c) => c !== code)].slice(0, 500);
    await store.kvSet(CODE_INDEX_KEY, index, 60 * 60 * 24 * 365);
    console.log(`[admin] code created: ${code} by ${req.user.id} note="${note}"`);
    res.json({ code: row });
  });

  // GET /me/admin/codes — list codes (newest first). Limit clamped to
  // 200 so the panel response stays small even if an admin's been
  // generating a lot of codes. Each claimed code is enriched with the
  // claimant's display_name so the panel doesn't show raw UUIDs.
  app.get("/me/admin/codes", requireAdmin(), async (req, res) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    let index = (await store.kvGet(CODE_INDEX_KEY)) || [];
    if (!Array.isArray(index)) index = [];
    const slice = index.slice(0, limit);
    const codes = (await Promise.all(slice.map((c) => store.kvGet(CODE_PREFIX + c)))).filter(Boolean);

    // Batch-resolve display names for everyone who's claimed a code +
    // everyone who created one, so the panel can show "Leon-ug0"
    // instead of "b5134fec…".
    const userIds = new Set();
    for (const c of codes) {
      if (c.claimedBy) userIds.add(c.claimedBy);
      if (c.createdBy) userIds.add(c.createdBy);
    }
    const nameById = new Map();
    if (supabase && userIds.size) {
      try {
        const { data } = await supabase
          .from("users")
          .select("id, display_name")
          .in("id", [...userIds]);
        for (const row of data || []) nameById.set(row.id, row.display_name);
      } catch (err) {
        console.warn("[admin] claimant-name lookup failed:", err.message);
      }
    }
    const enriched = codes.map((c) => ({
      ...c,
      claimedByName: c.claimedBy ? (nameById.get(c.claimedBy) || null) : null,
      createdByName: c.createdBy ? (nameById.get(c.createdBy) || null) : null,
    }));
    res.json({ codes: enriched });
  });

  // ===== Admin allowlist (KV-promoted) ===============================
  //
  // Env-seeded admins can promote other users into the KV-stored
  // admin set. Removing an env admin requires editing the env var;
  // removing a promoted admin works from the panel.

  app.get("/me/admin/admins", requireAdmin(), async (_req, res) => {
    const envAdmins = [...parseAdminIds()];
    const promoted = [...(await getPromotedAdmins())];
    let promotedRows = [];
    if (supabase && promoted.length) {
      try {
        const { data } = await supabase
          .from("users")
          .select("id, display_name")
          .in("id", promoted);
        promotedRows = data || [];
      } catch (err) {
        console.warn("[admin] promoted-admin lookup failed:", err.message);
      }
    }
    let envRows = [];
    if (supabase && envAdmins.length) {
      try {
        const { data } = await supabase
          .from("users")
          .select("id, display_name")
          .in("id", envAdmins);
        envRows = data || [];
      } catch (err) {
        console.warn("[admin] env-admin lookup failed:", err.message);
      }
    }
    res.json({
      env:      envAdmins.map((id) => ({ id, display_name: envRows.find((r) => r.id === id)?.display_name || null, source: "env" })),
      promoted: promoted.map((id) => ({ id, display_name: promotedRows.find((r) => r.id === id)?.display_name || null, source: "promoted" })),
    });
  });

  app.post("/me/admin/promote", requireAdmin(), async (req, res) => {
    const userId = String(req.body?.userId || "");
    if (!userId) return res.status(400).json({ error: "userId required" });
    // Validate user exists.
    if (supabase) {
      try {
        const { data } = await supabase.from("users").select("id, display_name").eq("id", userId).maybeSingle();
        if (!data) return res.status(404).json({ error: "User not found." });
      } catch (err) {
        return res.status(500).json({ error: `User lookup failed: ${err.message || "unknown"}` });
      }
    }
    const promoted = await getPromotedAdmins();
    promoted.add(userId);
    await store.kvSet(PROMOTED_KEY, [...promoted], 60 * 60 * 24 * 365 * 10);
    console.log(`[admin] promote: ${req.user.id} promoted ${userId}`);
    res.json({ ok: true, userId });
  });

  app.post("/me/admin/revoke", requireAdmin(), async (req, res) => {
    const userId = String(req.body?.userId || "");
    if (!userId) return res.status(400).json({ error: "userId required" });
    // Refuse to revoke an env-seed admin (UI shouldn't show the button
    // for them anyway, but defense-in-depth).
    if (parseAdminIds().has(userId)) {
      return res.status(409).json({ error: "Cannot revoke an env-seeded admin — edit ADMIN_USER_IDS instead." });
    }
    const promoted = await getPromotedAdmins();
    if (!promoted.has(userId)) {
      return res.status(404).json({ error: "User is not a promoted admin." });
    }
    promoted.delete(userId);
    await store.kvSet(PROMOTED_KEY, [...promoted], 60 * 60 * 24 * 365 * 10);
    console.log(`[admin] revoke: ${req.user.id} revoked ${userId}`);
    res.json({ ok: true, userId });
  });

  // ===== Redeem (any signed-in user) ================================
  //
  // Reads + atomically-claims a code, picks a random Pokémon from the
  // active pokedex, and grants it to the redeemer's owned_cards.

  app.post("/me/redeem", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    if (!supabase) return res.status(503).json({ error: "DB unavailable." });
    const rawCode = String(req.body?.code || "").trim().toUpperCase();
    if (!rawCode) return res.status(400).json({ error: "Enter a code." });
    const row = await store.kvGet(CODE_PREFIX + rawCode);
    if (!row) return res.status(404).json({ error: "Code not found." });
    if (row.claimedBy) {
      return res.status(409).json({ error: `Code already redeemed${row.claimedAt ? " on " + row.claimedAt.slice(0, 10) : ""}.` });
    }
    // Pick a random Pokémon from the active pokedex (excluding spells).
    let dex = [];
    if (typeof getPokedex === "function") {
      const v = getPokedex();
      dex = v && typeof v.then === "function" ? await v : v;
    }
    const pool = (dex || []).filter((c) => c && c.kind !== "spell");
    if (!pool.length) return res.status(503).json({ error: "Pokédex not loaded yet — try again in a few seconds." });
    const card = pool[Math.floor(Math.random() * pool.length)];
    // Grant the card (upsert owned_cards).
    let existing;
    try {
      ({ data: existing } = await supabase
        .from("owned_cards")
        .select("quantity")
        .eq("user_id", req.user.id)
        .eq("pokemon_id", card.id)
        .maybeSingle());
    } catch (err) {
      console.error("[redeem] read owned_cards threw:", err);
      return res.status(500).json({ error: `Couldn't read your collection: ${err.message || "unknown"}` });
    }
    const newQty = Math.min(999, (existing?.quantity || 0) + 1);
    try {
      const { error } = await supabase
        .from("owned_cards")
        .upsert(
          { user_id: req.user.id, pokemon_id: card.id, quantity: newQty, acquired_at: new Date().toISOString() },
          { onConflict: "user_id,pokemon_id" },
        );
      if (error) throw error;
    } catch (err) {
      console.error("[redeem] upsert threw:", err);
      return res.status(500).json({ error: `Couldn't save the card: ${err.message || "unknown"}` });
    }
    // Mark the code claimed (atomic-ish — we read row earlier, write
    // back now. Race window is small; if two users hit the same code
    // simultaneously both might get a card. Acceptable for MVP given
    // codes are admin-distributed manually).
    row.claimedBy = req.user.id;
    row.claimedAt = new Date().toISOString();
    row.claimedPokemonId = card.id;
    row.claimedPokemonName = card.name;
    await store.kvSet(CODE_PREFIX + rawCode, row, 60 * 60 * 24 * 365);
    console.log(`[redeem] ${rawCode} claimed by ${req.user.id} → ${card.name} (newQty ${newQty})`);
    res.json({
      ok: true,
      card: {
        id: card.id, name: card.name, types: card.types,
        sprite_front: card.sprite_front, tier: card.tier, rarity: card.rarity,
        is_legendary: !!card.is_legendary, is_mythical: !!card.is_mythical,
      },
      newQuantity: newQty,
    });
  });
}

// HTML for the /admin page. Keeps the template inline so the route
// has no extra static-file dependencies; the page calls the same
// /me/admin/* API endpoints any other client would.
function renderAdminPage({ adminOk, userId }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Admin · Pokémon Battle</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 880px; margin: 24px auto; padding: 0 16px; background: #0b1224; color: #f5f6fb; line-height: 1.5; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .sub { opacity: 0.7; font-size: 14px; margin-bottom: 20px; }
  section { background: #15192a; border: 1px solid #2a3658; border-radius: 12px; padding: 18px 20px; margin-bottom: 18px; }
  section h2 { font-size: 16px; margin: 0 0 12px; letter-spacing: 1px; text-transform: uppercase; opacity: 0.85; }
  button { background: linear-gradient(135deg, #34d399, #06b6d4); color: #0a0f1c; border: none; border-radius: 8px; padding: 9px 16px; font-size: 14px; font-weight: 700; cursor: pointer; }
  button:hover { filter: brightness(1.07); }
  button.danger { background: linear-gradient(135deg, #f87171, #ef4444); color: #fff; }
  button.ghost { background: rgba(255,255,255,0.06); color: inherit; border: 1px solid rgba(255,255,255,0.18); }
  input[type=text] { background: rgba(255,255,255,0.07); color: inherit; border: 1px solid rgba(255,255,255,0.18); border-radius: 8px; padding: 8px 12px; font-size: 14px; width: 100%; }
  input[type=text]:focus { outline: none; border-color: #60a5fa; }
  .row { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
  .row > * { flex-shrink: 0; }
  .row > input[type=text] { flex: 1; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid rgba(255,255,255,0.06); vertical-align: top; }
  th { font-weight: 600; opacity: 0.75; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .code { font-family: ui-monospace, monospace; font-size: 14px; font-weight: 700; background: rgba(255,255,255,0.08); padding: 2px 8px; border-radius: 6px; letter-spacing: 1px; }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; }
  .pill.active { background: #06402d; color: #6ee7b7; }
  .pill.claimed { background: #4a1e0d; color: #fbbf24; }
  tr.is-claimed { background: rgba(251, 191, 36, 0.04); }
  .claimed-cell { font-size: 12px; line-height: 1.4; }
  .claimed-when { opacity: 0.7; font-size: 11px; display: block; }
  .pill.env { background: #1e3a5f; color: #93c5fd; }
  .pill.promoted { background: #2a3658; color: #cbd5e1; }
  .muted { opacity: 0.65; font-size: 12px; }
  .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #06b6d4; color: #0a0f1c; padding: 10px 18px; border-radius: 10px; font-weight: 700; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
  .err { color: #fca5a5; font-size: 13px; }
  .empty { opacity: 0.5; font-style: italic; padding: 12px 0; }
  .picker { position: relative; }
  .picker-results { position: absolute; top: 100%; left: 0; right: 0; max-height: 240px; overflow-y: auto; background: #1a2140; border: 1px solid #2a3658; border-radius: 8px; margin-top: 4px; z-index: 10; display: none; }
  .picker-results.open { display: block; }
  .picker-row { padding: 8px 12px; cursor: pointer; display: flex; align-items: center; gap: 10px; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .picker-row:hover, .picker-row.focused { background: rgba(96, 165, 250, 0.15); }
  .picker-row img { width: 32px; height: 32px; image-rendering: pixelated; }
  .picker-row .pokeid { opacity: 0.5; font-size: 11px; margin-left: auto; }
  .selected-chip { background: rgba(52, 211, 153, 0.12); border: 1px solid rgba(52, 211, 153, 0.4); border-radius: 8px; padding: 8px 12px; display: flex; align-items: center; gap: 10px; font-size: 13px; margin-top: 6px; }
  .selected-chip img { width: 36px; height: 36px; image-rendering: pixelated; }
  .selected-chip .clear { margin-left: auto; background: transparent; color: #fca5a5; border: none; padding: 2px 8px; font-weight: 700; cursor: pointer; font-size: 16px; }
  .qty-row { display: flex; gap: 10px; align-items: center; margin-top: 10px; }
  .qty-row label { font-size: 13px; opacity: 0.85; }
  .qty-row input[type=number] { background: rgba(255,255,255,0.07); color: inherit; border: 1px solid rgba(255,255,255,0.18); border-radius: 8px; padding: 8px 12px; font-size: 14px; width: 80px; }
</style>
</head>
<body>
<h1>Admin Panel</h1>
<div class="sub">${adminOk
    ? `Signed in as <code>${userId}</code> · admin access ✓`
    : userId
      ? `Signed in as <code>${userId}</code> — NOT an admin. Contact a current admin to be promoted.`
      : `Not signed in. <a href="/" style="color:#60a5fa">Go home to sign in</a>.`}</div>

${adminOk ? `
<section>
  <h2>Airdrop a Card</h2>
  <p class="muted" style="margin-top:-4px;">Grant a specific Pokémon to a specific user. Idempotent — re-runs add to the recipient's current quantity (capped at 999).</p>
  <div style="margin-bottom: 12px;">
    <label style="font-size:13px; opacity:0.85;">Recipient (search by name or paste UUID)</label>
    <div class="picker">
      <input type="text" id="airdrop-user-input" placeholder="Type a display name or paste a UUID…" autocomplete="off">
      <div id="airdrop-user-results" class="picker-results"></div>
    </div>
    <div id="airdrop-user-selected"></div>
  </div>
  <div style="margin-bottom: 12px;">
    <label style="font-size:13px; opacity:0.85;">Pokémon (search by name or Pokédex #)</label>
    <div class="picker">
      <input type="text" id="airdrop-poke-input" placeholder="e.g. ‘pikachu’ or ‘25’…" autocomplete="off">
      <div id="airdrop-poke-results" class="picker-results"></div>
    </div>
    <div id="airdrop-poke-selected"></div>
  </div>
  <div class="qty-row">
    <label for="airdrop-qty">Quantity:</label>
    <input type="number" id="airdrop-qty" value="1" min="1" max="99">
    <button id="airdrop-send">🎁 Send Airdrop</button>
  </div>
  <div id="airdrop-error" class="err" style="margin-top: 8px;"></div>
  <div id="airdrop-success" style="margin-top: 8px; color: #6ee7b7; font-size: 13px;"></div>
</section>

<section>
  <h2>Redemption Codes</h2>
  <div class="row">
    <input type="text" id="note-input" placeholder="Note (optional) — e.g. ‘Halloween giveaway’">
    <button id="create-code">Generate Code</button>
    <button id="refresh-codes" class="ghost" title="Refresh — shows newly-redeemed codes">↻ Refresh</button>
  </div>
  <div class="muted" id="codes-summary" style="margin-bottom: 8px;"></div>
  <div id="codes-error" class="err"></div>
  <table id="codes-table">
    <thead><tr><th>Code</th><th>Status</th><th>Note</th><th>Redeemed by</th><th>Reward</th></tr></thead>
    <tbody id="codes-body"><tr><td colspan="5" class="empty">Loading…</td></tr></tbody>
  </table>
</section>

<section>
  <h2>Admins</h2>
  <div class="row">
    <input type="text" id="promote-input" placeholder="User UUID to promote">
    <button id="promote-btn">Promote</button>
  </div>
  <div id="admins-error" class="err"></div>
  <table id="admins-table">
    <thead><tr><th>User</th><th>Source</th><th>Actions</th></tr></thead>
    <tbody id="admins-body"><tr><td colspan="3" class="empty">Loading…</td></tr></tbody>
  </table>
  <p class="muted">Env-seeded admins (blue) can only be removed via the ADMIN_USER_IDS env var. Promoted admins (grey) can be revoked here.</p>
</section>

<script>
const $ = (s) => document.querySelector(s);
const escape = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const toast = (msg) => {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
};
// Human-readable relative timestamp ("2 min ago", "1 day ago").
// Falls back to absolute ISO date for >7 day.
function relTime(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || isNaN(ms)) return iso.slice(0, 10);
  const s = Math.floor(ms / 1000);
  if (s < 60)       return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60)       return m + " min ago";
  const h = Math.floor(m / 60);
  if (h < 24)       return h + "h ago";
  const d = Math.floor(h / 24);
  if (d < 7)        return d + " day" + (d === 1 ? "" : "s") + " ago";
  return iso.slice(0, 10);
}
// ===== Airdrop picker =====
// Two pickers (user, pokemon) share the same shape: typing into the input
// debounces a search, the results dropdown shows clickable rows, picking
// a row commits the selection and hides the dropdown. Selection persists
// in a local state object the Send button reads.
const airdropState = { user: null, pokemon: null };

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function renderUserSelected() {
  const el = $("#airdrop-user-selected");
  const u = airdropState.user;
  if (!u) { el.innerHTML = ""; return; }
  el.innerHTML = '<div class="selected-chip">'
    + '<strong>' + escape(u.display_name || '(no name)') + '</strong>'
    + '<code class="muted" style="font-size:11px;">' + escape(u.id.slice(0, 8)) + '…</code>'
    + '<button class="clear" title="Clear">×</button></div>';
  el.querySelector('.clear').addEventListener('click', () => {
    airdropState.user = null;
    renderUserSelected();
    $("#airdrop-user-input").value = "";
    $("#airdrop-user-input").focus();
  });
}

function renderPokeSelected() {
  const el = $("#airdrop-poke-selected");
  const p = airdropState.pokemon;
  if (!p) { el.innerHTML = ""; return; }
  el.innerHTML = '<div class="selected-chip">'
    + (p.sprite_front ? '<img src="' + escape(p.sprite_front) + '" alt="">' : '')
    + '<strong>' + escape(p.name) + '</strong>'
    + '<code class="muted" style="font-size:11px;">#' + p.id + '</code>'
    + '<button class="clear" title="Clear">×</button></div>';
  el.querySelector('.clear').addEventListener('click', () => {
    airdropState.pokemon = null;
    renderPokeSelected();
    $("#airdrop-poke-input").value = "";
    $("#airdrop-poke-input").focus();
  });
}

const searchUsers = debounce(async (q) => {
  const box = $("#airdrop-user-results");
  if (!q.trim()) { box.classList.remove('open'); box.innerHTML = ''; return; }
  try {
    const r = await fetch('/me/admin/users/search?q=' + encodeURIComponent(q));
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    const { users } = await r.json();
    if (!users.length) {
      box.innerHTML = '<div class="picker-row" style="cursor:default; opacity:0.6;">No matches.</div>';
      box.classList.add('open');
      return;
    }
    box.innerHTML = users.map((u) => '<div class="picker-row" data-id="' + escape(u.id) + '" data-name="' + escape(u.display_name || '') + '">'
      + '<strong>' + escape(u.display_name || '(no name)') + '</strong>'
      + '<code class="pokeid">' + escape(u.id.slice(0, 8)) + '…</code></div>').join('');
    box.classList.add('open');
    box.querySelectorAll('.picker-row[data-id]').forEach((row) => {
      row.addEventListener('click', () => {
        airdropState.user = { id: row.getAttribute('data-id'), display_name: row.getAttribute('data-name') };
        renderUserSelected();
        box.classList.remove('open');
        $("#airdrop-user-input").value = "";
      });
    });
  } catch (err) {
    box.innerHTML = '<div class="picker-row" style="cursor:default; color:#fca5a5;">' + escape(err.message) + '</div>';
    box.classList.add('open');
  }
}, 200);

const searchPokemon = debounce(async (q) => {
  const box = $("#airdrop-poke-results");
  if (!q.trim()) { box.classList.remove('open'); box.innerHTML = ''; return; }
  try {
    const r = await fetch('/api/pokedex/search?q=' + encodeURIComponent(q));
    if (!r.ok) throw new Error(r.statusText);
    const { results } = await r.json();
    if (!results.length) {
      box.innerHTML = '<div class="picker-row" style="cursor:default; opacity:0.6;">No matches.</div>';
      box.classList.add('open');
      return;
    }
    box.innerHTML = results.slice(0, 30).map((p) => '<div class="picker-row" data-id="' + p.id + '" data-name="' + escape(p.name) + '" data-sprite="' + escape(p.sprite_front || '') + '">'
      + (p.sprite_front ? '<img src="' + escape(p.sprite_front) + '" alt="">' : '')
      + '<strong>' + escape(p.name) + '</strong>'
      + '<span class="pokeid">#' + p.id + '</span></div>').join('');
    box.classList.add('open');
    box.querySelectorAll('.picker-row[data-id]').forEach((row) => {
      row.addEventListener('click', () => {
        airdropState.pokemon = {
          id: Number(row.getAttribute('data-id')),
          name: row.getAttribute('data-name'),
          sprite_front: row.getAttribute('data-sprite') || null,
        };
        renderPokeSelected();
        box.classList.remove('open');
        $("#airdrop-poke-input").value = "";
      });
    });
  } catch (err) {
    box.innerHTML = '<div class="picker-row" style="cursor:default; color:#fca5a5;">' + escape(err.message) + '</div>';
    box.classList.add('open');
  }
}, 200);

$("#airdrop-user-input").addEventListener('input', (e) => searchUsers(e.target.value));
$("#airdrop-poke-input").addEventListener('input', (e) => searchPokemon(e.target.value));

// Click-outside closes dropdowns.
document.addEventListener('click', (e) => {
  if (!e.target.closest('#airdrop-user-results') && e.target.id !== 'airdrop-user-input') {
    $("#airdrop-user-results").classList.remove('open');
  }
  if (!e.target.closest('#airdrop-poke-results') && e.target.id !== 'airdrop-poke-input') {
    $("#airdrop-poke-results").classList.remove('open');
  }
});

$("#airdrop-send").addEventListener('click', async () => {
  const err = $("#airdrop-error"), ok = $("#airdrop-success");
  err.textContent = ''; ok.textContent = '';
  if (!airdropState.user) { err.textContent = 'Pick a recipient first.'; return; }
  if (!airdropState.pokemon) { err.textContent = 'Pick a Pokémon first.'; return; }
  const quantity = Math.max(1, Math.min(99, Number($("#airdrop-qty").value) || 1));
  const btn = $("#airdrop-send"); const original = btn.textContent;
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const r = await fetch('/me/admin/airdrop', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        recipientUserId: airdropState.user.id,
        pokemonId: airdropState.pokemon.id,
        quantity,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    ok.textContent = '✓ Sent ' + quantity + '× ' + data.pokemon.name + ' to ' + (data.recipient.display_name || data.recipient.id.slice(0, 8) + '…') + '. Their new total: ' + data.newTotal + '.';
    toast('Airdropped ' + quantity + '× ' + data.pokemon.name);
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
});

async function refreshCodes() {
  $("#codes-error").textContent = "";
  try {
    const r = await fetch("/me/admin/codes?limit=100");
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    const { codes } = await r.json();
    // Summary header — quick read on how many codes are out there.
    const active  = codes.filter((c) => !c.claimedBy).length;
    const claimed = codes.filter((c) =>  c.claimedBy).length;
    $("#codes-summary").textContent =
      codes.length === 0
        ? ""
        : (active + " active · " + claimed + " redeemed · " + codes.length + " total");
    const body = $("#codes-body");
    if (!codes.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty">No codes yet — generate one above.</td></tr>';
      return;
    }
    body.innerHTML = codes.map((c) => {
      const claimed = !!c.claimedBy;
      const claimedByDisplay = c.claimedByName
        ? '<strong>' + escape(c.claimedByName) + '</strong>'
        : (c.claimedBy ? '<code>' + escape(c.claimedBy.slice(0, 8)) + '…</code>' : '');
      const whenCell = claimed
        ? '<div class="claimed-cell">' + claimedByDisplay
          + '<span class="claimed-when">' + escape(relTime(c.claimedAt)) + '</span></div>'
        : '<span class="muted">—</span>';
      const rewardCell = claimed
        ? '<strong>🎁 ' + escape(c.claimedPokemonName || '?') + '</strong>'
        : '<span class="muted">—</span>';
      return \`
        <tr class="\${claimed ? 'is-claimed' : ''}">
          <td><span class="code">\${escape(c.code)}</span>
              <button class="ghost" style="margin-left:6px; padding:2px 8px; font-size:11px;"
                      onclick="navigator.clipboard.writeText('\${escape(c.code)}').then(()=>toast('Copied'))">Copy</button></td>
          <td><span class="pill \${claimed ? 'claimed' : 'active'}">\${claimed ? 'REDEEMED ✓' : 'ACTIVE'}</span></td>
          <td>\${escape(c.note || '')}</td>
          <td>\${whenCell}</td>
          <td>\${rewardCell}</td>
        </tr>\`;
    }).join("");
  } catch (err) {
    $("#codes-error").textContent = err.message;
  }
}
$("#refresh-codes").addEventListener("click", refreshCodes);
// Auto-refresh every 20s so a redemption shows up without manual
// reload. Stop if the tab is hidden to avoid background polling.
setInterval(() => { if (!document.hidden) refreshCodes(); }, 20000);
$("#create-code").addEventListener("click", async () => {
  const note = $("#note-input").value;
  $("#codes-error").textContent = "";
  try {
    const r = await fetch("/me/admin/codes/create", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note }),
    });
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    const { code } = await r.json();
    $("#note-input").value = "";
    toast("Code generated: " + code.code);
    refreshCodes();
  } catch (err) { $("#codes-error").textContent = err.message; }
});
async function refreshAdmins() {
  $("#admins-error").textContent = "";
  try {
    const r = await fetch("/me/admin/admins");
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    const data = await r.json();
    const rows = [...data.env, ...data.promoted];
    const body = $("#admins-body");
    if (!rows.length) { body.innerHTML = '<tr><td colspan="3" class="empty">No admins.</td></tr>'; return; }
    body.innerHTML = rows.map((a) => \`
      <tr>
        <td><strong>\${escape(a.display_name || '(no name)')}</strong><br><code class="muted">\${escape(a.id)}</code></td>
        <td><span class="pill \${a.source}">\${a.source.toUpperCase()}</span></td>
        <td>\${a.source === 'promoted'
          ? '<button class="danger" data-revoke="' + escape(a.id) + '">Revoke</button>'
          : '<span class="muted">(env)</span>'}</td>
      </tr>\`).join("");
    document.querySelectorAll('[data-revoke]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const uid = btn.getAttribute("data-revoke");
        if (!confirm("Revoke admin from " + uid + "?")) return;
        const r = await fetch("/me/admin/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: uid }) });
        if (!r.ok) { $("#admins-error").textContent = (await r.json()).error; return; }
        toast("Revoked");
        refreshAdmins();
      });
    });
  } catch (err) { $("#admins-error").textContent = err.message; }
}
$("#promote-btn").addEventListener("click", async () => {
  const userId = $("#promote-input").value.trim();
  if (!userId) return;
  $("#admins-error").textContent = "";
  const r = await fetch("/me/admin/promote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) });
  if (!r.ok) { $("#admins-error").textContent = (await r.json()).error; return; }
  $("#promote-input").value = "";
  toast("Promoted");
  refreshAdmins();
});
refreshCodes();
refreshAdmins();
</script>
` : ''}
</body>
</html>`;
}

module.exports = {
  mount, isAdmin, isAdminAsync, parseAdminIds,
  getPromotedAdmins, generateCode,
};
