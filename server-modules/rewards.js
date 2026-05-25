// Match-completion reward system.
//
// When a match ends the server rolls a small set of card "picks" for each
// player (winner gets more / better than loser). Picks are stashed in
// shared KV (Redis via state-store) keyed by a single-use offer id so the
// claim endpoint can find them regardless of which Lambda instance
// handles the request.  Falls back to in-memory when no Redis.
//
// Rewards are scoped to authenticated users only — guests get no drops.

const { randomUUID } = require("crypto");
const store = require("./state-store");
const {
  rarityForCard,
  RARITIES,
  RARITY_BY_TIER,
} = require("../shared/deck-builder");

const OFFER_TTL_SEC = 10 * 60;       // 10 minutes

// Player-facing drop-rate ladder. Drop frequencies sum to 100 across the
// five rarities, with each step roughly halving the one below. This is
// the SINGLE source of truth for "how often does each rarity drop" —
// difficulty bands carve subsets out of this table but never override
// the underlying ratios.
const RARITY_RATES = {
  common:    50,
  uncommon:  30,
  rare:      15,
  epic:       4,
  legendary:  1,
};

// Difficulty pools — what a win at each difficulty is allowed to drop:
//   easy   → 0 cards (handled at the route layer, no pool here)
//   medium → common / uncommon / rare
//   hard   → epic / legendary
//   default (multiplayer / champion / unrestricted) → all five
//
// Rares were intentionally moved from hard → medium so each band has a
// distinct character: hard is the "elite drop" tier (no overlap with
// medium), medium is the steady grind.
const MEDIUM_RARITIES = ["common", "uncommon", "rare"];
const HARD_RARITIES   = ["epic", "legendary"];

function weightedRarity(rand = Math.random, allowed = RARITIES, rates = RARITY_RATES) {
  // Sum the rates for ONLY the allowed rarities so subsetting (e.g.
  // medium-mode) renormalises to 100% within that subset.
  let total = 0;
  for (const r of allowed) total += rates[r] || 0;
  if (total <= 0) return allowed[0];
  let x = rand() * total;
  for (const r of allowed) {
    x -= (rates[r] || 0);
    if (x <= 0) return r;
  }
  return allowed[allowed.length - 1];
}

function pickFromRarity(pokedex, rarity, exclude, rand = Math.random) {
  const candidates = pokedex.filter(
    (p) => rarityForCard(p) === rarity && !exclude.has(p.id),
  );
  if (!candidates.length) return null;
  return candidates[Math.floor(rand() * candidates.length)];
}

function rollPicks(pokedex, count, rand = Math.random, opts = {}) {
  const {
    themeType = currentTheme(),
    themeBias = 0.3,
    allowedRarities = RARITIES,
    rates = RARITY_RATES,
  } = opts;
  const allowedSet = new Set(allowedRarities);
  // Restrict the candidate pool to the eligible rarities up front. This
  // means an is_legendary card with a low BST tier can NEVER show up in
  // a medium-mode roll, because its computed rarity is "legendary" and
  // "legendary" isn't in MEDIUM_RARITIES.
  const pool = pokedex.filter((c) => allowedSet.has(rarityForCard(c)));
  const picks = [];
  const seen = new Set();
  let safety = 0;
  while (picks.length < count && safety++ < 100) {
    const rarity = weightedRarity(rand, allowedRarities, rates);
    let card = null;
    if (themeType && rand() < themeBias) {
      const themed = pool.filter(
        (c) => !seen.has(c.id) && c.types?.includes(themeType) && rarityForCard(c) === rarity,
      );
      if (themed.length > 0) card = themed[Math.floor(rand() * themed.length)];
    }
    if (!card) card = pickFromRarity(pool, rarity, seen, rand);
    if (!card) {
      // Fallback walks ONLY the allowed rarities so we never bleed an
      // epic into a medium-mode reward when the targeted bucket is empty.
      for (const r of allowedRarities) {
        card = pickFromRarity(pool, r, seen, rand);
        if (card) break;
      }
    }
    if (!card) break;
    seen.add(card.id);
    picks.push(card);
  }
  return picks;
}

// Shape a pokedex row into the offer-pick payload sent to the client.
// Includes rarity + is_legendary/is_mythical so the reward modal can
// render the rarity word and apply holo styling.
function toPickPayload(p) {
  return {
    id: p.id, name: p.name, types: p.types, tier: p.tier,
    rarity: rarityForCard(p),
    is_legendary: !!p.is_legendary,
    is_mythical: !!p.is_mythical,
    energyCost: p.energyCost, cardHp: p.cardHp, cardAttack: p.cardAttack,
    sprite_front: p.sprite_front,
  };
}

// createOffer stores the picks in shared KV under an opaque id. The
// returned id is what we ship to the client; only that id can redeem.
// Awaits the KV write so callers can guarantee the offer is durable
// before responding to the client.
async function createOffer(userId, picks) {
  const id = randomUUID();
  const offer = {
    userId,
    picks: picks.map(toPickPayload),
    expiresAt: Date.now() + OFFER_TTL_SEC * 1000,
  };
  try {
    await store.kvSet(`offer:${id}`, offer, OFFER_TTL_SEC);
  } catch (err) {
    console.warn("[rewards] kvSet failed:", err.message);
  }
  return id;
}

async function consumeOffer(offerId, userId) {
  const o = await store.kvTake(`offer:${offerId}`);
  if (!o) return null;
  if (Date.now() > o.expiresAt) return null;
  if (o.userId !== userId) return null;
  return o;
}

const { currentTheme } = require("./theme");
// NOTE: bumpDailyStats lives in quests.js, which imports THIS module.
// To avoid the circular-dep init-order bug (quests captures a partial
// rewards.exports → rewards.rollPicks is undefined at call time), we
// defer the require to the call site (search for "lazy bumpDailyStats"
// below). Theme has no cycle so it's required eagerly.

// Anti-cheat for solo rewards. Replaces the older "just trust the client"
// payload with server-tracked sessions:
//   POST /me/solo/start    -> records { userId, difficulty, startedAt }, returns sessionId
//   POST /me/solo/end      -> validates session is real + ≥MIN_DURATION old, then rolls.
// Plus a rolling rate limit so a determined attacker can't loop.
// Sessions stored in the shared KV (Redis or in-memory fallback) so the
// /me/solo/end POST can read state regardless of which Vercel Fluid
// Compute instance the /me/solo/start request landed on.
const SOLO_HISTORY = new Map();   // userId → array of timestamps (claimed)
const SOLO_MIN_DURATION_MS = 30 * 1000;  // games shorter than this are suspect
const SOLO_MIN_GAP_MS = 30 * 1000;       // 1 reward per 30s
const SOLO_HOURLY_CAP = 30;              // 30 rewards/hour ceiling
const SESSION_TTL_SEC = 60 * 60;          // 1 hour

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
  app.post("/me/solo/start", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const difficulty = String(req.body?.difficulty || "easy");
    if (!["easy", "medium", "hard"].includes(difficulty)) {
      return res.status(400).json({ error: "Invalid difficulty." });
    }
    const sessionId = require("crypto").randomBytes(12).toString("base64url");
    await store.kvSet(`solo-sess:${sessionId}`, {
      userId: req.user.id,
      difficulty,
      startedAt: Date.now(),
    }, SESSION_TTL_SEC);
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
    // kvTake = atomic get+delete. If the player retries the request,
    // the second call hits "no_session" instead of re-issuing a reward.
    const session = await store.kvTake(`solo-sess:${sessionId}`);
    if (!session) return res.json({ reward: null, reason: "no_session" });
    if (session.userId !== req.user.id) {
      return res.status(403).json({ error: "Session belongs to another user." });
    }
    if (Date.now() - session.startedAt < SOLO_MIN_DURATION_MS) {
      return res.json({ reward: null, reason: "session_too_short" });
    }
    // Daily quest tracking — solo matches don't write to the matches table,
    // so this is the only place per-day play/win counters get incremented.
    const koCount = Number(req.body?.kos) || 0;
    // Lazy bumpDailyStats: require here so the cycle resolves at
    // call time (after both modules are fully loaded).
    const { bumpDailyStats } = require("./quests");
    await bumpDailyStats(supabase, req.user.id, { matches: 1, wins: won ? 1 : 0, kos: koCount });

    // Drop policy by difficulty (wins only — losses get nothing):
    //   easy   → 0 cards (signal effort, not luck)
    //   medium → 1 card from {common, uncommon, rare}
    //   hard   → 1 card from {epic, legendary}
    //   champion override → 5 picks, full pool, one guaranteed legendary
    let count = 0;
    let guaranteeLegendary = false;
    let rollOpts = {};
    const difficulty = session.difficulty;
    if (championId && won) {
      count = 5;
      guaranteeLegendary = true;
      // Persist champion_wins for achievements (best-effort, ignore failures
      // so the reward path itself never breaks).
      try {
        const { data: u } = await supabase
          .from("users").select("champion_wins").eq("id", req.user.id).maybeSingle();
        const cur = u?.champion_wins || [];
        if (!cur.includes(championId)) {
          await supabase.from("users")
            .update({ champion_wins: [...cur, championId] })
            .eq("id", req.user.id);
        }
      } catch (err) {
        console.warn("[rewards] champion_wins persist failed:", err.message);
      }
    } else if (won && difficulty === "medium") {
      count = 1;
      rollOpts = { allowedRarities: MEDIUM_RARITIES };
    } else if (won && difficulty === "hard") {
      count = 1;
      rollOpts = { allowedRarities: HARD_RARITIES };
    }
    if (count === 0) {
      return res.json({ reward: null, reason: "no_drop_for_difficulty" });
    }
    const gate = canClaimSolo(req.user.id);
    if (!gate.ok) return res.json({ reward: null, reason: gate.reason, retryAfterMs: gate.retryAfterMs });

    let picks = rollPicks(pokedex, count, Math.random, rollOpts);
    if (guaranteeLegendary && !picks.some((p) => p.is_legendary || p.is_mythical)) {
      // Swap one pick out for a random legendary/mythical.
      const rares = pokedex.filter((p) => p.is_legendary || p.is_mythical);
      if (rares.length) {
        picks[picks.length - 1] = rares[Math.floor(Math.random() * rares.length)];
      }
    }
    const offerId = await createOffer(req.user.id, picks);
    res.json({
      reward: {
        offerId,
        picks: picks.map(toPickPayload),
      },
    });
  });

  app.post("/me/rewards/claim", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const { offerId, pokemonId } = req.body || {};
    if (!offerId || typeof offerId !== "string") {
      return res.status(400).json({ error: "Missing offerId." });
    }
    const numericId = Number(pokemonId);
    if (!Number.isInteger(numericId) || numericId < 1) {
      return res.status(400).json({ error: "Invalid card id." });
    }
    let offer;
    try {
      offer = await consumeOffer(offerId, req.user.id);
    } catch (err) {
      console.error("[rewards] consumeOffer threw:", err);
      return res.status(500).json({ error: "Reward storage error — try again." });
    }
    if (!offer) return res.status(400).json({ error: "Offer expired or unknown. The reward window is 10 minutes — please play again." });
    const matched = offer.picks.find((p) => p.id === numericId);
    if (!matched) return res.status(400).json({ error: `Card #${numericId} wasn't in this offer.` });

    // Upsert quantity (cap at 999, but really we just +1)
    let existing;
    try {
      ({ data: existing } = await supabase
        .from("owned_cards")
        .select("quantity")
        .eq("user_id", req.user.id)
        .eq("pokemon_id", matched.id)
        .maybeSingle());
    } catch (err) {
      console.error("[rewards] read owned_cards failed:", err);
      return res.status(500).json({ error: `Couldn't read collection: ${err.message}` });
    }
    const newQty = (existing?.quantity || 0) + 1;
    let upsertError;
    try {
      // supabase-js returns { error } on REST errors but can THROW on
      // network failures, auth refresh issues, or timeouts. Catch both
      // shapes so the client always gets JSON (not Express's default
      // HTML 500), and so we don't burn the offer without explaining why.
      ({ error: upsertError } = await supabase
        .from("owned_cards")
        .upsert(
          {
            user_id: req.user.id,
            pokemon_id: matched.id,
            quantity: newQty,
            acquired_at: new Date().toISOString(),
          },
          { onConflict: "user_id,pokemon_id" },
        ));
    } catch (err) {
      console.error("[rewards] upsert owned_cards threw:", err);
      return res.status(500).json({
        error: `Couldn't save card (network): ${err.message || "unknown error"}`,
      });
    }
    if (upsertError) {
      console.error("[rewards] upsert owned_cards failed:", upsertError);
      return res.status(500).json({
        error: `Couldn't save card: ${upsertError.message} (code ${upsertError.code || "?"})`,
      });
    }
    res.json({ card: matched, newQuantity: newQty });
  });

  // Offers expire automatically via Redis TTL (10 min). For the in-memory
  // fallback path, state-store.kvGet does lazy expiry on read.
}

// Helper used by the multiplayer module on match end.
async function offerForOutcome(userId, pokedex, didWin) {
  const count = didWin ? 3 : 2;
  const picks = rollPicks(pokedex, count);
  const offerId = await createOffer(userId, picks);
  return {
    offerId,
    picks: picks.map(toPickPayload),
    expiresAt: Date.now() + OFFER_TTL_SEC * 1000,
  };
}

// Mutate the existing module.exports object instead of replacing it.
// Replacing creates a NEW object — any module that captured the OLD
// reference via require() still sees the empty initial {}. Mutating
// keeps the identity stable so cached references resolve correctly
// even when the import graph has a cycle (rewards ↔ quests).
module.exports = {
  mount, offerForOutcome, rollPicks, weightedRarity, pickFromRarity,
  createOffer, rarityForCard, toPickPayload,
  RARITIES, RARITY_BY_TIER, RARITY_RATES,
  MEDIUM_RARITIES, HARD_RARITIES,
};
