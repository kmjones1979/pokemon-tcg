// WebAuthn / passkey routes. Mounted at /auth/*.
//
// Endpoints:
//   POST /auth/register/begin    { displayName } -> options
//   POST /auth/register/complete { credential, userId } -> { user }
//   POST /auth/login/begin       { displayName? } -> options
//   POST /auth/login/complete    { credential } -> { user }
//   POST /auth/logout
//   GET  /auth/me
//
// Challenges live in-memory (Map keyed by a temp `challengeId` returned to
// the client). They expire after 5 minutes. Single-server only — when we
// scale beyond one node this needs to move to Redis or Supabase.

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");

const { setSession, clearSession, attach } = require("./sessions");

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function makeChallengeStore() {
  const m = new Map();
  function set(id, payload) {
    m.set(id, { payload, exp: Date.now() + CHALLENGE_TTL_MS });
  }
  function take(id) {
    const v = m.get(id);
    if (!v) return null;
    m.delete(id);
    if (Date.now() > v.exp) return null;
    return v.payload;
  }
  // periodic GC
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of m) if (now > v.exp) m.delete(k);
  }, 60000).unref?.();
  return { set, take };
}

function randomId() {
  return require("crypto").randomBytes(12).toString("base64url");
}

function rpFromReq(req) {
  // RP ID is the registrable host (no port). For local dev that's "localhost".
  // Resolution order:
  //   1. RP_ID env var if it matches the current request's hostname (or is
  //      an ancestor domain of it).
  //   2. Otherwise fall back to the actual request hostname.
  //   3. "localhost" if neither is set.
  // This makes preview-URL deployments (pokemon-xxxxx.vercel.app) work
  // without breaking the canonical alias.
  const envId = (process.env.RP_ID || "").trim();
  const host = (req.hostname || "").trim() || "localhost";
  let rpID;
  if (envId && (host === envId || host.endsWith("." + envId))) {
    rpID = envId;
  } else {
    rpID = host;
  }
  const rpName = (process.env.RP_NAME || "Pokémon TCG").trim();
  // Origin must match the page the user is on, so always derive from request.
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const origin = `${proto}://${req.headers.host}`;
  return { rpID, rpName, origin };
}

function mount(app, supabase) {
  const challenges = makeChallengeStore();

  app.use(attach(supabase));

  // GET /auth/me -- light identity probe
  app.get("/auth/me", (req, res) => {
    if (!req.user) return res.json({ user: null });
    res.json({ user: req.user });
  });

  app.post("/auth/logout", (req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });

  // --- Registration ------------------------------------------------------
  app.post("/auth/register/begin", async (req, res) => {
    const displayName = String(req.body?.displayName || "").trim().slice(0, 32);
    if (!displayName || displayName.length < 2) {
      return res.status(400).json({ error: "Display name must be at least 2 characters." });
    }

    // Create the user up-front so the credential has somewhere to attach.
    // Display names aren't unique-required but we'll suffix with random if a
    // case-insensitive collision exists.
    let finalName = displayName;
    {
      const { data: dupe } = await supabase
        .from("users")
        .select("id")
        .ilike("display_name", finalName)
        .maybeSingle();
      if (dupe) {
        finalName = `${displayName}-${Math.random().toString(36).slice(2, 5)}`;
      }
    }
    const { data: created, error } = await supabase
      .from("users")
      .insert({ display_name: finalName })
      .select("id, display_name")
      .single();
    if (error) return res.status(500).json({ error: error.message });

    const { rpID, rpName } = rpFromReq(req);
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: new TextEncoder().encode(created.id),
      userName: finalName,
      userDisplayName: finalName,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
      supportedAlgorithmIDs: [-7, -257],
    });

    const challengeId = randomId();
    challenges.set(challengeId, {
      kind: "register",
      userId: created.id,
      expectedChallenge: options.challenge,
    });

    res.json({ challengeId, options, user: created });
  });

  app.post("/auth/register/complete", async (req, res) => {
    const { challengeId, credential, deviceName } = req.body || {};
    const stash = challenges.take(challengeId);
    if (!stash || stash.kind !== "register") {
      return res.status(400).json({ error: "Challenge expired. Try registering again." });
    }
    const { rpID, origin } = rpFromReq(req);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: credential,
        expectedChallenge: stash.expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: "Registration verification failed." });
    }
    const info = verification.registrationInfo;
    // @simplewebauthn/server 11.x changed the shape — try both forms.
    const credentialID = info.credential?.id || info.credentialID;
    const credentialPublicKey = info.credential?.publicKey || info.credentialPublicKey;
    const counter = info.credential?.counter ?? info.counter ?? 0;
    const transports = info.credential?.transports || credential.response?.transports || [];

    const { error: insertErr } = await supabase.from("passkeys").insert({
      credential_id: typeof credentialID === "string"
        ? credentialID
        : Buffer.from(credentialID).toString("base64url"),
      user_id: stash.userId,
      public_key: Buffer.from(credentialPublicKey).toString("base64url"),
      counter,
      transports,
      device_name: deviceName || null,
      last_used: new Date().toISOString(),
    });
    if (insertErr) return res.status(500).json({ error: insertErr.message });

    // Grant a 60-card starter pack so the new user can immediately deck-build.
    await grantStarter(supabase, stash.userId);

    setSession(res, stash.userId);
    const { data: user } = await supabase
      .from("users")
      .select("id, display_name, trainer_ability")
      .eq("id", stash.userId)
      .single();
    res.json({ user });
  });

  // --- Authentication / Login --------------------------------------------
  app.post("/auth/login/begin", async (req, res) => {
    const displayName = String(req.body?.displayName || "").trim();
    let allowCredentials;
    if (displayName) {
      // Discoverable creds work without this, but if the caller knows their
      // name we narrow down the allowList.
      const { data: u } = await supabase
        .from("users")
        .select("id")
        .ilike("display_name", displayName)
        .maybeSingle();
      if (u) {
        const { data: creds } = await supabase
          .from("passkeys")
          .select("credential_id, transports")
          .eq("user_id", u.id);
        if (creds?.length) {
          allowCredentials = creds.map((c) => ({
            id: c.credential_id,
            type: "public-key",
            transports: c.transports || undefined,
          }));
        }
      }
    }

    const { rpID } = rpFromReq(req);
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials,
      userVerification: "preferred",
    });
    const challengeId = randomId();
    challenges.set(challengeId, {
      kind: "login",
      expectedChallenge: options.challenge,
    });
    res.json({ challengeId, options });
  });

  app.post("/auth/login/complete", async (req, res) => {
    const { challengeId, credential } = req.body || {};
    const stash = challenges.take(challengeId);
    if (!stash || stash.kind !== "login") {
      return res.status(400).json({ error: "Challenge expired. Try signing in again." });
    }
    const credId = credential.id;
    const { data: pk } = await supabase
      .from("passkeys")
      .select("credential_id, public_key, counter, user_id, transports")
      .eq("credential_id", credId)
      .maybeSingle();
    if (!pk) return res.status(400).json({ error: "Unknown credential — register first." });

    const { rpID, origin } = rpFromReq(req);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: credential,
        expectedChallenge: stash.expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: pk.credential_id,
          publicKey: Buffer.from(pk.public_key, "base64url"),
          counter: Number(pk.counter),
          transports: pk.transports || undefined,
        },
        requireUserVerification: false,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!verification.verified) return res.status(401).json({ error: "Auth failed." });

    await supabase
      .from("passkeys")
      .update({
        counter: verification.authenticationInfo.newCounter,
        last_used: new Date().toISOString(),
      })
      .eq("credential_id", pk.credential_id);

    setSession(res, pk.user_id);

    const { data: user } = await supabase
      .from("users")
      .select("id, display_name, trainer_ability")
      .eq("id", pk.user_id)
      .single();
    res.json({ user });
  });

  // --- Auxiliary: list current user's passkeys + stats -------------------
  app.get("/me/passkeys", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "not signed in" });
    const { data, error } = await supabase
      .from("passkeys")
      .select("credential_id, device_name, transports, created_at, last_used")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ passkeys: data });
  });

  app.get("/me/stats", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "not signed in" });
    const { data, error } = await supabase
      .from("user_stats")
      .select("*")
      .eq("user_id", req.user.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ stats: data || { matches_played: 0, wins: 0, losses: 0, win_pct: 0, cards_owned: 0 } });
  });
}

// Pure helper: grant a starter set. 60 random cards, ≤2 per pokemon, weighted
// toward tiers 1-3. Idempotent: only runs for users with zero cards.
async function grantStarter(supabase, userId) {
  const { count } = await supabase
    .from("owned_cards")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);
  if (count && count > 0) return;

  const { data: all, error } = await supabase
    .from("pokemon")
    .select("id, hp, attack, defense, sp_attack, sp_defense, speed, is_legendary, is_mythical");
  if (error) {
    console.warn("[starter] could not load pokedex:", error.message);
    return;
  }
  const bsts = all.map((p) => ({
    id: p.id,
    bst: p.hp + p.attack + p.defense + p.sp_attack + p.sp_defense + p.speed,
    rare: p.is_legendary || p.is_mythical,
  }));
  // Bucket by tier
  const tiers = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (const p of bsts) {
    if (p.bst < 350) tiers[1].push(p.id);
    else if (p.bst < 450) tiers[2].push(p.id);
    else if (p.bst < 525) tiers[3].push(p.id);
    else if (p.bst < 600) tiers[4].push(p.id);
    else tiers[5].push(p.id);
  }
  // Distribution for a 60-card starter: 25 T1, 22 T2, 10 T3, 3 T4, 0 T5
  const dist = { 1: 25, 2: 22, 3: 10, 4: 3, 5: 0 };
  const picks = new Map(); // pokemon_id -> qty
  for (const tier of Object.keys(dist)) {
    const want = dist[tier];
    const bucket = tiers[tier].slice();
    // Shuffle
    for (let i = bucket.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bucket[i], bucket[j]] = [bucket[j], bucket[i]];
    }
    let added = 0;
    for (const id of bucket) {
      if (added >= want) break;
      const q = picks.get(id) || 0;
      if (q >= 2) continue;
      picks.set(id, q + 1);
      added++;
    }
  }
  const rows = [];
  for (const [pokemon_id, qty] of picks) {
    rows.push({ user_id: userId, pokemon_id, quantity: qty });
  }
  if (rows.length) {
    const { error: insErr } = await supabase
      .from("owned_cards")
      .upsert(rows, { onConflict: "user_id,pokemon_id" });
    if (insErr) console.warn("[starter] could not grant:", insErr.message);
  }
}

module.exports = { mount, grantStarter };
