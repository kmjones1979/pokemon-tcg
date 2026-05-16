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

function rollPicks(pokedex, count, rand = Math.random) {
  const picks = [];
  const seen = new Set();
  let safety = 0;
  while (picks.length < count && safety++ < 100) {
    const tier = weightedTier(rand);
    let card = pickFromTier(pokedex, tier, seen, rand);
    if (!card) {
      // Fall back through tiers
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

// Rate limit: each user can claim a solo reward at most once per 30s, and
// at most 20 in any rolling hour. Anti-grind, not anti-cheat: a determined
// attacker can still farm slowly. Real anti-cheat would tie rewards to a
// server-tracked solo match record.
const SOLO_HISTORY = new Map(); // userId → array of timestamps
const SOLO_MIN_GAP_MS = 30 * 1000;
const SOLO_HOURLY_CAP = 20;
function canClaimSolo(userId) {
  const now = Date.now();
  let hist = SOLO_HISTORY.get(userId) || [];
  hist = hist.filter((t) => now - t < 60 * 60 * 1000);
  if (hist.length >= SOLO_HOURLY_CAP) return false;
  if (hist.length > 0 && now - hist[hist.length - 1] < SOLO_MIN_GAP_MS) return false;
  hist.push(now);
  SOLO_HISTORY.set(userId, hist);
  return true;
}

// Express routes — mounted at /me/rewards/*
function mount(app, supabase, getPokedex) {
  // Solo (vs-AI) reward: client posts at game-over with { difficulty, won }.
  // Server rolls and returns an offer. The client then POSTs /me/rewards/claim
  // with the chosen pokemonId from the offer.
  app.post("/me/rewards/solo", (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const pokedex = getPokedex();
    if (!pokedex || pokedex.length === 0) {
      return res.status(503).json({ error: "Pokédex not loaded yet." });
    }
    const difficulty = String(req.body?.difficulty || "easy");
    const won = !!req.body?.won;
    let count = 0;
    if (won && difficulty === "medium") count = 1;
    else if (won && difficulty === "hard") count = 2;
    else if (!won && difficulty === "hard") count = 1; // small consolation
    if (count === 0) return res.json({ reward: null, reason: "no_drop" });
    if (!canClaimSolo(req.user.id)) {
      return res.json({ reward: null, reason: "rate_limited" });
    }
    const picks = rollPicks(pokedex, count);
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

module.exports = { mount, offerForOutcome, rollPicks, weightedTier };
