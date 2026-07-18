const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const chokidar = require("chokidar");
const http = require("http");
const socketIo = require("socket.io");
const qrcode = require("qrcode-terminal");
require("dotenv").config();
const cookieParser = require("cookie-parser");
const { createClient } = require("@supabase/supabase-js");
const { buildDeck, toCard } = require("./shared/deck-builder");
const auth = require("./server-modules/auth");
const collection = require("./server-modules/collection");
const multiplayer = require("./server-modules/multiplayer");
const multiplayerHttp = require("./server-modules/multiplayer-http");
const multiplayerTcg = require("./server-modules/multiplayer-tcg");
const artGallery = require("./server-modules/art-gallery");
const cardGallery = require("./server-modules/card-gallery");
const rewards = require("./server-modules/rewards");
const achievements = require("./server-modules/achievements");
const dailyStreak = require("./server-modules/daily-streak");
const xpModule = require("./server-modules/xp");
const quests = require("./server-modules/quests");
const theme = require("./server-modules/theme");
const champions = require("./server-modules/champions");
const story = require("./server-modules/story");
const readingMode = require("./server-modules/reading-mode");
const admin = require("./server-modules/admin");
const trading = require("./server-modules/trading");
const dailyBoss = require("./server-modules/daily-boss");
const dailyPuzzle = require("./server-modules/daily-puzzle");
const analytics = require("./server-modules/analytics");
const siteGate = require("./server-modules/site-gate");
const guestMigrate = require("./server-modules/guest-migrate");
const mathMode = require("./server-modules/math-mode");
const landingPages = require("./server-modules/landing-pages");
const deckShare = require("./server-modules/deck-share");
const friendChallenge = require("./server-modules/friend-challenge");
const mastery = require("./server-modules/mastery");
const winstreak = require("./server-modules/winstreak");
const avatars = require("./server-modules/avatars");

const app = express();
// Vercel + most PaaS hosts proxy requests. Trust the proxy headers so
// req.hostname / req.protocol come from X-Forwarded-* (matching the
// public URL) instead of the internal Lambda hostname.
app.set("trust proxy", true);
const server = http.createServer(app);
const io = socketIo(server);
app.use(express.json({ limit: "256kb" }));
app.use(cookieParser());

// Default SESSION_SECRET for local dev only — production must set this.
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = require("crypto").randomBytes(32).toString("hex");
  console.warn(
    "[auth] SESSION_SECRET was not set. Generated an ephemeral one — sessions will be invalidated on restart.",
  );
}

// Get local IP address
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip over non-IPv4 and internal (loopback) addresses
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1"; // Default to localhost if no external IP found
}

const localIp = getLocalIp();
const PORT = Number(process.env.PORT) || 3000;

// Generate server URL (still needed for console output)
const serverUrl = `http://${localIp}:${PORT}`;

// Site-password gate disabled — module + routes left in place so the
// gate can be re-enabled by uncommenting `app.use(siteGate.gateMiddleware)`.
siteGate.parseFormBody(app);
siteGate.mount(app);
// app.use(siteGate.gateMiddleware);

// Serve static files from the current directory
app.use(express.static(path.join(__dirname)));

// Serve index.html with a hot-swappable script src: prod uses the
// esbuild bundle at /dist/main.bundle.js; if that file doesn't exist
// (local dev without a build step) we swap it for the raw ESM entry.
const _bundlePath = path.join(__dirname, "dist", "main.bundle.js");
function readIndexHtml() {
  let html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  if (!fs.existsSync(_bundlePath)) {
    html = html.replace("/dist/main.bundle.js", "/client/js/main.js");
  }
  return html;
}
app.get("/", (_req, res) => {
  res.set("content-type", "text/html; charset=utf-8");
  res.send(readIndexHtml());
});

// Set up file watcher — reload clients on any HTML/CSS/JS change.
const watcher = chokidar.watch(["index.html", "client"], {
  ignored: /(^|[\/\\])\../, // ignore dotfiles
  persistent: true,
});

watcher.on("change", (p) => {
  console.log(`File ${p} has been changed`);
  io.emit("reload");
});

// --- Pokédex cache + deck endpoint -----------------------------------------
//
// Phase 2 (single-player) keeps all gameplay state in the browser. The server
// is just a static host + a card-data API. We load the full Pokédex into
// memory on boot so deck draws don't hit Supabase per-request.
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
let pokedex = []; // array of card objects, lazily loaded (Megas excluded)
let megaCards = []; // Mega cards, kept out of the drop/deck pool but shown in Explore
let _pokedexPromise = null;

function loadPokedex() {
  if (_pokedexPromise) return _pokedexPromise;
  _pokedexPromise = (async () => {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      console.warn(
        "[pokedex] SUPABASE_URL/SUPABASE_SERVICE_KEY missing — /api/deck will 503.",
      );
      return;
    }
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    });
    const PAGE = 1000;
    const all = [];
    let from = 0;
    while (true) {
      const { data, error } = await sb
        .from("pokemon")
        .select("*")
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        console.error("[pokedex] supabase error:", error.message);
        // Reset so the next request can retry
        _pokedexPromise = null;
        return;
      }
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    // Megas are obtainable ONLY by mega-evolving, never from random drops or
    // AI decks, so keep them out of the gameplay pool. Players still play
    // their own Megas — those load via deck hydration, which queries by id.
    const { isMegaId } = require("./shared/mega-evolutions");
    pokedex = all.filter((r) => !isMegaId(r.id)).map(toCard);
    // Megas: kept out of the gameplay pool above, but exposed to the Explore
    // browser (see /api/pokedex/all) as a prestige section.
    megaCards = all.filter((r) => isMegaId(r.id)).map(toCard);
    // Bake the evolution-target card data onto each card so the engine
    // can transform a Pokémon mid-match without needing a separate
    // pokedex lookup. The chain table is static (shared/evolution-
    // chains.js) so this pass is O(n) over the dex on first load.
    {
      const { evolutionFor } = require("./shared/evolution-chains");
      const byId = new Map(pokedex.map((c) => [c.id, c]));
      for (const c of pokedex) {
        const nextId = evolutionFor(c.id);
        if (nextId && byId.has(nextId)) {
          c.evolves_to_card = byId.get(nextId);
        }
      }
    }
    // Append all active spell cards so drops + deck-builder see them
    // alongside Pokémon. allSpellCards() only returns spells whose
    // engine effect is wired (see ACTIVE_EFFECTS in shared/spell-cards
    // — slice 1 = Freeze only).
    const { allSpellCards } = require("./shared/spell-cards");
    const spells = allSpellCards();
    pokedex.push(...spells);
    console.log(`[pokedex] loaded ${pokedex.length - spells.length} Pokémon + ${spells.length} spell card(s)`);
  })();
  return _pokedexPromise;
}
async function ensurePokedex() {
  await loadPokedex();
  return pokedex;
}

// --- Auth + session ---
// We construct a Supabase client just for the auth/account routes so they can
// share one connection. Reuses SUPABASE_URL/SUPABASE_SERVICE_KEY.
let authSupabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  authSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
  auth.mount(app, authSupabase);
  collection.mount(app, authSupabase);
  rewards.mount(app, authSupabase, ensurePokedex);
  multiplayerHttp.mount(app, authSupabase, ensurePokedex);
  achievements.mount(app, authSupabase, ensurePokedex);
  dailyStreak.mount(app, authSupabase, ensurePokedex);
  xpModule.mount(app, authSupabase);
  quests.mount(app, authSupabase, ensurePokedex);
  theme.mount(app);
  champions.mount(app, authSupabase);
  story.mount(app, authSupabase, ensurePokedex);
  readingMode.mount(app);
  admin.mount(app, authSupabase, ensurePokedex);
  trading.mount(app, authSupabase, ensurePokedex);
  dailyBoss.mount(app, authSupabase, ensurePokedex);
  dailyPuzzle.mount(app, authSupabase);
  analytics.mount(app);
  guestMigrate.mount(app, authSupabase);
  mathMode.mount(app, authSupabase, ensurePokedex);
  deckShare.mount(app, authSupabase, ensurePokedex);
  friendChallenge.mount(app, authSupabase);
  mastery.mount(app, authSupabase);
  winstreak.mount(app, authSupabase, ensurePokedex);
  avatars.mount(app, authSupabase);

  // Match history for the signed-in user.
  app.get("/me/matches", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const { data, error } = await authSupabase
      .from("matches")
      .select(`
        id, p1_user_id, p2_user_id, winner_id, reason, turns, started_at, ended_at,
        p1:p1_user_id(display_name),
        p2:p2_user_id(display_name)
      `)
      .or(`p1_user_id.eq.${req.user.id},p2_user_id.eq.${req.user.id}`)
      .order("started_at", { ascending: false })
      .limit(25);
    if (error) return res.status(500).json({ error: error.message });
    const rows = (data || []).map((m) => ({
      id: m.id,
      iWon: m.winner_id === req.user.id,
      iWasP1: m.p1_user_id === req.user.id,
      opponent: m.p1_user_id === req.user.id ? m.p2?.display_name : m.p1?.display_name,
      reason: m.reason,
      turns: m.turns,
      startedAt: m.started_at,
      endedAt: m.ended_at,
    }));
    res.json({ matches: rows });
  });
} else {
  console.warn("[auth] Supabase credentials missing — auth routes disabled.");
}

// Multiplayer wires into the Socket.IO server. It uses the Pokédex cache
// (loaded below) and Supabase for deck hydration + match record persistence.
// Attached after `pokedex` has been populated by loadPokedex().

app.get("/api/pokedex/size", async (_req, res) => {
  await ensurePokedex();
  res.json({ size: pokedex.length });
});

// Lightweight Pokédex search — used by the trade UI's "what do you want"
// picker. Returns up to 50 matches by case-insensitive name substring or
// by ID. No auth.
// Public "Explore" endpoint — every Pokémon in the in-memory pokedex
// with the full detail set the detail panel needs (sprite, types,
// tier, rarity, card stats, raw stats, flavor, abilities, legendary
// flags). Excludes spell cards via the kind filter. Cached in-memory
// already; the response is ~1MB so we lean on HTTP cache headers
// rather than hand-rolling pagination.
app.get("/api/pokedex/all", async (_req, res) => {
  await ensurePokedex();
  const { megaVideoUrl } = require("./shared/mega-evolutions");
  const toRow = (c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    sprite_front: c.sprite_front,
    sprite_back: c.sprite_back,
    types: c.types,
    generation: c.generation,
    bst: c.bst,
    tier: c.tier,
    rarity: c.rarity,
    energyCost: c.energyCost,
    cardHp: c.cardHp,
    cardAttack: c.cardAttack,
    is_legendary: !!c.is_legendary,
    is_mythical: !!c.is_mythical,
    flavor_text: c.flavor_text,
    abilities: c.abilities || [],
    raw: c.raw,
  });
  // Species first, then the Mega section (flagged + carrying the looping
  // video URL so Explore can animate them).
  const rows = pokedex
    .filter((c) => c.kind !== "spell")
    .map(toRow)
    .concat(megaCards.map((c) => ({ ...toRow(c), is_mega: true, videoUrl: megaVideoUrl(c.id) })));
  // Cache for 10 minutes — the dex doesn't change at runtime, so even
  // long-tab users don't need fresh data.
  res.set("Cache-Control", "public, max-age=600");
  res.json({ count: rows.length, rows });
});

// Per-Pokémon landing pages with OG/Twitter preview meta. Public (no auth) so
// shared links work for anyone, signed-in or not. Lives next to the other
// public Pokédex routes since it shares the same data source.
landingPages.mount(app, ensurePokedex);

// TCG card-game multiplayer. Self-contained (its own engine + client-side
// collection), so it mounts regardless of Supabase — guests can play PvP.
multiplayerTcg.mount(app);

// Public art gallery at /art — showcases the generated TCG artwork.
artGallery.mount(app);
// Public card gallery at /cards — browse every card face in 3D.
cardGallery.mount(app);

app.get("/api/pokedex/search", async (req, res) => {
  await ensurePokedex();
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q) return res.json({ results: [] });
  const asNum = Number(q);
  const matches = pokedex.filter((c) => {
    if (Number.isFinite(asNum) && c.id === asNum) return true;
    return c.name?.toLowerCase().includes(q);
  }).slice(0, 50).map((c) => ({
    id: c.id, name: c.name, types: c.types, tier: c.tier,
    energyCost: c.energyCost, cardHp: c.cardHp, cardAttack: c.cardAttack,
    sprite_front: c.sprite_front,
    is_legendary: !!c.is_legendary, is_mythical: !!c.is_mythical,
  }));
  res.json({ results: matches });
});

// Public leaderboard — ranks players by match wins, with win-rate
// breaking ties. No auth required (read-only).
//
// Why this order: wins is the most legible "I'm winning" stat, and
// players have a strong intuition that a 0-win player should NOT
// outrank a 1-win player. Previously we sorted by trainer_level first,
// which let high-XP losers (XP accrues from solo/story play too,
// independent of multiplayer wins) sit at the top of the table.
//
// Tiebreakers:
//   1. wins desc            — primary signal
//   2. win_pct desc         — 5W/0L > 5W/5L
//   3. matches_played asc   — fewer losses for the same wins → higher
//   4. trainer_level desc   — final tiebreaker, rewards long-term play
app.get("/api/leaderboard", async (req, res) => {
  if (!authSupabase) return res.json({ rows: [], me: null });
  const limit = Math.min(50, Math.max(5, Number(req.query.limit) || 25));
  const { data, error } = await authSupabase
    .from("user_stats")
    .select("user_id, display_name, matches_played, wins, losses, win_pct, cards_owned, trainer_xp, trainer_level")
    .gt("matches_played", 0)
    .order("wins", { ascending: false })
    .order("win_pct", { ascending: false })
    .order("matches_played", { ascending: true })
    .order("trainer_level", { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });

  // The user_stats view computes trainer_level with a stale formula
  // (e.g. capped at L10) that doesn't match server-modules/xp.js's
  // curve. Recompute from trainer_xp here so the displayed level is
  // always consistent with what /me/xp returns.
  const { levelFromXp } = require("./server-modules/xp");
  for (const r of data || []) {
    r.trainer_level = levelFromXp(r.trainer_xp || 0);
  }

  // Enrich rows with selected_avatar from the users table — user_stats
  // is a view that doesn't carry the avatar column. One batched lookup
  // for all visible user_ids; cheap relative to the leaderboard query.
  const rows = data || [];
  if (rows.length) {
    try {
      const ids = rows.map((r) => r.user_id);
      const { data: avatarRows } = await authSupabase
        .from("users")
        .select("id, selected_avatar")
        .in("id", ids);
      const avatarByUser = new Map((avatarRows || []).map((r) => [r.id, r.selected_avatar]));
      const { getAvatar } = require("./server-modules/avatars");
      for (const r of rows) {
        const key = avatarByUser.get(r.user_id) || "red";
        const a = getAvatar(key) || getAvatar("red");
        r.selected_avatar = key;
        r.avatar_sprite = a?.sprite || null;
        r.avatar_name   = a?.name   || null;
      }
    } catch (err) {
      console.warn("[leaderboard] avatar enrich failed:", err.message);
      for (const r of rows) r.selected_avatar = "red";
    }
  }

  let me = null, myRank = null;
  if (req.user) {
    const { data: mine } = await authSupabase
      .from("user_stats")
      .select("*")
      .eq("user_id", req.user.id)
      .maybeSingle();
    me = mine || null;
    // Same correction as the row loop above — keep `me.trainer_level`
    // consistent with the xp.js curve, not whatever the view returns.
    if (me) me.trainer_level = levelFromXp(me.trainer_xp || 0);
    // Compute global rank — count players strictly ahead of me on our
    // compound key. Covers (wins, win_pct) lexicographically; remaining
    // ties land in the same rank bucket which is acceptable for display.
    // Only meaningful if the player has actually played a match.
    if (me && (me.matches_played || 0) > 0) {
      const orExpr = [
        `wins.gt.${Number(me.wins) || 0}`,
        `and(wins.eq.${Number(me.wins) || 0},win_pct.gt.${Number(me.win_pct) || 0})`,
      ].join(",");
      const { count } = await authSupabase
        .from("user_stats")
        .select("user_id", { count: "exact", head: true })
        .gt("matches_played", 0)
        .or(orExpr);
      myRank = (count || 0) + 1;
    }
  }
  res.json({ rows: data || [], me, myRank });
});

app.get("/api/deck", async (req, res) => {
  await ensurePokedex();
  if (pokedex.length === 0) {
    return res.status(503).json({ error: "pokedex not loaded yet" });
  }
  const seed = req.query.seed ? String(req.query.seed) : undefined;
  const deck = buildDeck(pokedex, { seed });
  res.json({ deck });
});

// Socket.io connection
let onlineUsers = 0;
// Store connected users with details
let connectedUsers = {};

io.on("connection", (socket) => {
  console.log("A client connected");
  onlineUsers++;

  // Generate a unique ID for this user if they don't provide one
  const userId =
    socket.handshake.query.userId ||
    `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Store user information
  connectedUsers[socket.id] = {
    id: userId,
    socketId: socket.id,
    ip: socket.handshake.address,
    userAgent: socket.handshake.headers["user-agent"],
    connectedAt: new Date(),
    lastActivity: new Date(),
  };

  // Broadcast the updated user count to all clients
  io.emit("userCount", onlineUsers);

  // Send the user their ID
  socket.emit("userId", userId);

  // Update user status when they send a ping
  socket.on("ping", () => {
    if (connectedUsers[socket.id]) {
      connectedUsers[socket.id].lastActivity = new Date();
    }
  });

  socket.on("disconnect", () => {
    console.log("A client disconnected");
    onlineUsers--;

    // Remove user from connected users
    delete connectedUsers[socket.id];

    // Broadcast the updated user count to all clients
    io.emit("userCount", onlineUsers);
  });
});

// Modify index.html to include socket.io code and QR code
let htmlContent = fs.readFileSync("index.html", "utf8");

// Only inject the script if it's not already there
if (!htmlContent.includes("socket.io")) {
  // Find the position to inject before the closing body tag
  const bodyClosePos = htmlContent.lastIndexOf("</body>");

  if (bodyClosePos !== -1) {
    const scriptToInject = `
    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        
        // Get user ID from URL or generate one
        const urlParams = new URLSearchParams(window.location.search);
        const userId = urlParams.get('userId') || localStorage.getItem('userId');
        
        // Connect with user ID if available
        if (userId) {
            socket.io.opts.query = { userId };
        }
        
        // Store user ID when received from server
        socket.on('userId', (id) => {
            localStorage.setItem('userId', id);
        });
        
        socket.on('reload', () => {
            console.log('Reloading page...');
            window.location.reload();
        });
        
        // Handle disconnection events
        socket.on('disconnect', () => {
            console.log('Disconnected from server, will reload in 1 second...');
            setTimeout(() => {
                window.location.reload();
            }, 1000);
        });
        
        // Send periodic pings to update last activity
        setInterval(() => {
            socket.emit('ping');
        }, 30000);
    </script>
`;

    // Insert the script before the closing body tag
    htmlContent =
      htmlContent.substring(0, bodyClosePos) +
      scriptToInject +
      htmlContent.substring(bodyClosePos);

    // Write the modified content back to the file
    fs.writeFileSync("index.html", htmlContent);
    console.log("Added auto-reload script to index.html");
  }
}

// JSON error handler — last middleware before listen. Any uncaught throw
// from an async route handler ends up here. Without this, Express 5's
// default fallback returns an HTML 500 page, which the client tries to
// JSON.parse and crashes with "non-JSON" errors (see /me/rewards/claim
// regression). Must be registered AFTER all routes.
app.use((err, req, res, _next) => {
  console.error("[server] unhandled route error:", req.method, req.url, err);
  if (res.headersSent) return;
  res.status(500).json({
    error: err && err.message ? err.message : "Internal server error",
  });
});

// Start the server. Bind on all interfaces so both LAN IP and localhost work.
// (Passkeys require a domain RP_ID, so localhost:3000 is the right URL for
// local dev — IP-address RP_IDs are rejected by Chrome/Safari.)
//
// On Vercel we don't call .listen() — the platform owns the listener. The
// boot still has to happen (loadPokedex + multiplayer.attach), but the
// module.exports at the bottom hands the http server back to Vercel.
const isVercel = !!process.env.VERCEL;

// Register Socket.IO handlers immediately. They'll await the Pokédex on
// first event-triggered use. This works on both Vercel (where the function
// is invoked per WebSocket connect) and Node (where attach is called once).
multiplayer.attach(io, authSupabase, () => pokedex);

// On Vercel, kick off the load so subsequent requests see a populated dex.
// On local Node, this runs as part of normal boot.
const bootPromise = loadPokedex();

if (!isVercel) bootPromise.finally(() => {
  server.listen(PORT, "0.0.0.0", () => {
    if (process.env.NODE_ENV !== "production") {
      console.log(`Server running at http://${localIp}:${PORT}/  (LAN — no passkeys)`);
      console.log(`Use http://localhost:${PORT}/ for passkey login (required by WebAuthn)`);
    } else {
      console.log(`Server listening on :${PORT}`);
    }

    // Create QR code for console in dev only.
    if (process.env.NODE_ENV !== "production") {
      console.log("\nAccess the server using the URL above.");
      console.log("\nServer QR Code:");
      qrcode.generate(serverUrl, { small: true });
    }
  });
});

// Vercel adapter: export the http server. The platform forwards both
// requests and WebSocket upgrades to it.
if (isVercel) {
  module.exports = server;
}

// Graceful shutdown so container hosts (Fly, Render, Docker) can recycle the
// server cleanly. Tell connected clients the server is going away so they
// can show a "reconnecting…" UI rather than dying silently.
function shutdown(signal) {
  console.log(`[shutdown] received ${signal}, draining...`);
  io.emit("server:shutdown");
  io.close(() => {
    server.close(() => {
      console.log("[shutdown] closed cleanly");
      process.exit(0);
    });
  });
  // Hard exit if we don't finish within 10s.
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
