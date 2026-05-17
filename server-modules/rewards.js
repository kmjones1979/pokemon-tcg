// Match-completion reward system.
//
// When a match ends the server rolls a small set of card "picks" for each
// player (winner gets more / better than loser). The picks are stashed
// in-memory keyed by a single-use offer id; clients claim with the chosen
// pokemon_id, which writes the card to owned_cards.
//
// Rewards are scoped to authenticated users only — guests get no drops.

const { randomUUID } = require("crypto");

// In-memory store: offerId → { userId, picks: [pokemonRow], expiresAt }
// Cleared after claim or after TTL.
const OFFERS = new Map();
const OFFER_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Tier weights — heavy lean on T1-T3 with a small chance at T4/5.
const WEIGHTS = { 1: 30, 2: 32, 3: 22, 4: 11, 5: 5 };

function weightedTier(rand = Math.random) {
  let total = 0;
  for (const t of Object.keys(WEIGHTS)) total += WEIGHTS[t];
  let r = rand() * total;
  for (const t of Object.keys(WEIGHTS)) {
    r -= WEIGHTS[t];
    if (r <= 0) return Number(t);
  }
  return 1;
}

function pickFromTier(pokedex, tier, exclude, rand = Math.random) {
  const candidates = pokedex.filter((p) => p.tier === tier && !exclude.has(p.id));
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rand() * candidates.length)];
}

function rollPicks(pokedex, count, rand = Math.random, opts = {}) {
  const { themeType = currentTheme(), themeBias = 0.3 } = opts;
  const picks = [];
  const seen = new Set();
  let safety = 0;
  while (picks.length < count && safety++ < 100) {
    const tier = weightedTier(rand);
    // With probability themeBias, try to draw a themed-type card of any
    // tier first; if none, fall through to the regular tier pick.
    let card = null;
    if (themeType && rand() < themeBias) {
      const themed = pokedex.filter((c) => !seen.has(c.id) && c.types?.includes(themeType));
      if (themed.length > 0) card = themed[Math.floor(rand() * themed.length)];
    }
    if (!card) card = pickFromTier(pokedex, tier, seen, rand);
    if (!card) {
      for (const t of [3, 2, 4, 1, 5]) {
        card = pickFromTier(pokedex, t, seen, rand);
        if (card) break;
      }
    }
    if (!card) break;
    seen.add(card.id);
    picks.push(card);
  }
  return picks;
}

function createOffer(userId, picks) {
  const id = randomUUID();
  OFFERS.set(id, {
    userId,
    picks: picks.map((p) => ({
      id: p.id, name: p.name, types: p.types, tier: p.tier,
      energyCost: p.energyCost, cardHp: p.cardHp, cardAttack: p.cardAttack,
      sprite_front: p.sprite_front,
    })),
    expiresAt: Date.now() + OFFER_TTL_MS,
  });
  return id;
}

function consumeOffer(offerId, userId) {
  const o = OFFERS.get(offerId);
  if (!o) return null;
  OFFERS.delete(offerId);
  if (Date.now() > o.expiresAt) return null;
  if (o.userId !== userId) return null;
  return o;
}

const { currentTheme } = require("./theme");

// Anti-cheat for solo rewards. Replaces the older "just trust the client"
// payload with server-tracked sessions:
//   POST /me/solo/start    -> records { userId, difficulty, startedAt }, returns sessionId
//   POST /me/solo/end      -> validates session is real + ≥MIN_DURATION old, then rolls.
// Plus a rolling rate limit so a determined attacker can't loop.
const SOLO_SESSIONS = new Map(); // sessionId → { userId, difficulty, startedAt, claimed }
const SOLO_HISTORY = new Map();   // userId → array of timestamps (claimed)
const SOLO_MIN_DURATION_MS = 30 * 1000;  // games shorter than this are suspect
const SOLO_MIN_GAP_MS = 30 * 1000;       // 1 reward per 30s
const SOLO_HOURLY_CAP = 30;              // 30 rewards/hour ceiling
const SESSION_TTL_MS = 60 * 60 * 1000;

function gcSoloSessions() {
  const now = Date.now();
  for (const [id, s] of SOLO_SESSIONS) {
    if (now - s.startedAt > SESSION_TTL_MS) SOLO_SESSIONS.delete(id);
  }
}
setInterval(gcSoloSessions, 5 * 60 * 1000).unref?.();

function canClaimSolo(userId) {
  const now = Date.now();
  let hist = SOLO_HISTORY.get(userId) || [];
  hist = hist.filter((t) => now - t < 60 * 60 * 1000);
  if (hist.length >= SOLO_HOURLY_CAP) return { ok: false, reason: "hourly_cap" };
  if (hist.length > 0 && now - hist[hist.length - 1] < SOLO_MIN_GAP_MS) {
    return { ok: false, reason: "rate_limited", retryAfterMs: SOLO_MIN_GAP_MS - (now - hist[hist.length - 1]) };
  }
  hist.push(now);
  SOLO_HISTORY.set(userId, hist);
  return { ok: true };
}

// Express routes — mounted at /me/rewards/*
function mount(app, supabase, getPokedex) {
  async function loadDex() {
    const v = getPokedex();
    return v && typeof v.then === "function" ? await v : v;
  }

  // Start a solo session — call when the match begins. Returns a sessionId
  // that must be passed back to /me/solo/end. Without this handshake, no
  // reward will be issued, which gates the "lie about a win" attack.
  app.post("/me/solo/start", (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const difficulty = String(req.body?.difficulty || "easy");
    if (!["easy", "medium", "hard"].includes(difficulty)) {
      return res.status(400).json({ error: "Invalid difficulty." });
    }
    const sessionId = require("crypto").randomBytes(12).toString("base64url");
    SOLO_SESSIONS.set(sessionId, {
      userId: req.user.id,
      difficulty,
      startedAt: Date.now(),
      claimed: false,
    });
    res.json({ sessionId });
  });

  // End a solo session — call when the player wins/loses. Server checks the
  // session is real, owned by the same user, at least MIN_DURATION old, not
  // already claimed, and applies per-user rate limit. Returns an offer
  // shaped exactly like the multiplayer reward.
  app.post("/me/solo/end", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const pokedex = await loadDex();
    if (!pokedex || pokedex.length === 0) {
      return res.status(503).json({ error: "Pokédex not loaded yet." });
    }
    const { sessionId, won, championId } = req.body || {};
    const session = SOLO_SESSIONS.get(sessionId);
    if (!session) return res.json({ reward: null, reason: "no_session" });
    if (session.userId !== req.user.id) {
      return res.status(403).json({ error: "Session belongs to another user." });
    }
    if (session.claimed) return res.json({ reward: null, reason: "already_claimed" });
    if (Date.now() - session.startedAt < SOLO_MIN_DURATION_MS) {
      return res.json({ reward: null, reason: "session_too_short" });
    }
    session.claimed = true;

    let count = 0;
    let guaranteeLegendary = false;
    const difficulty = session.difficulty;
    if (championId && won) {
      // Champion victory — chunky reward: 5 picks, one guaranteed legendary.
      count = 5;
      guaranteeLegendary = true;
    } else if (won && difficulty === "medium") count = 1;
    else if (won && difficulty === "hard") count = 2;
    else if (!won && difficulty === "hard") count = 1;
    if (count === 0) {
      return res.json({ reward: null, reason: "no_drop_for_difficulty" });
    }
    const gate = canClaimSolo(req.user.id);
    if (!gate.ok) return res.json({ reward: null, reason: gate.reason, retryAfterMs: gate.retryAfterMs });

    let picks = rollPicks(pokedex, count);
    if (guaranteeLegendary && !picks.some((p) => p.is_legendary || p.is_mythical)) {
      // Swap one pick out for a random legendary/mythical.
      const rares = pokedex.filter((p) => p.is_legendary || p.is_mythical);
      if (rares.length) {
        picks[picks.length - 1] = rares[Math.floor(Math.random() * rares.length)];
      }
    }
    const offerId = createOffer(req.user.id, picks);
    res.json({
      reward: {
        offerId,
        picks: picks.map((p) => ({
          id: p.id, name: p.name, types: p.types, tier: p.tier,
          energyCost: p.energyCost, cardHp: p.cardHp, cardAttack: p.cardAttack,
          sprite_front: p.sprite_front,
        })),
      },
    });
  });

  app.post("/me/rewards/claim", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const { offerId, pokemonId } = req.body || {};
    const offer = consumeOffer(offerId, req.user.id);
    if (!offer) return res.status(400).json({ error: "Offer expired or unknown." });
    const matched = offer.picks.find((p) => p.id === Number(pokemonId));
    if (!matched) return res.status(400).json({ error: "Card wasn't in this offer." });

    // Upsert quantity (cap at 999, but really we just +1)
    const { data: existing } = await supabase
      .from("owned_cards")
      .select("quantity")
      .eq("user_id", req.user.id)
      .eq("pokemon_id", matched.id)
      .maybeSingle();
    const newQty = (existing?.quantity || 0) + 1;
    const { error } = await supabase
      .from("owned_cards")
      .upsert(
        {
          user_id: req.user.id,
          pokemon_id: matched.id,
          quantity: newQty,
          acquired_at: new Date().toISOString(),
        },
        { onConflict: "user_id,pokemon_id" },
      );
    if (error) return res.status(500).json({ error: error.message });
    res.json({ card: matched, newQuantity: newQty });
  });

  // GC expired offers every 5 minutes.
  setInterval(() => {
    const now = Date.now();
    for (const [id, o] of OFFERS) if (now > o.expiresAt) OFFERS.delete(id);
  }, 5 * 60 * 1000).unref?.();
}

// Helper used by the multiplayer module on match end.
function offerForOutcome(userId, pokedex, didWin) {
  const count = didWin ? 3 : 2;
  const picks = rollPicks(pokedex, count);
  const offerId = createOffer(userId, picks);
  return {
    offerId,
    picks: picks.map((p) => ({
      id: p.id, name: p.name, types: p.types, tier: p.tier,
      energyCost: p.energyCost, cardHp: p.cardHp, cardAttack: p.cardAttack,
      sprite_front: p.sprite_front,
    })),
    expiresAt: Date.now() + OFFER_TTL_MS,
  };
}

module.exports = { mount, offerForOutcome, rollPicks, weightedTier, createOffer };
