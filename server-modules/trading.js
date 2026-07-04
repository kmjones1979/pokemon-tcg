// Player-to-player card trading.
//
// One simple model: a trade OFFER says "I'm offering pokemon X and looking
// for pokemon Y". Anyone who owns Y can accept by clicking — server runs the
// swap atomically (decrement X from offerer, give Y to offerer, decrement Y
// from accepter, give X to accepter).
//
// Endpoints:
//   GET  /api/trades/market               — browse open offers (no auth)
//   POST /me/trades                       — create an offer
//   GET  /me/trades                       — your own open offers
//   GET  /me/trades/history               — your completed swaps
//   POST /me/trades/:id/accept            — atomic accept + swap
//   POST /me/trades/:id/cancel            — cancel your own offer
//
// Anti-spam:
//   - Max 5 open offers per user
//   - Can't offer pokemon you don't own
//   - Can't accept your own offer
//   - Can't offer/want the same pokemon

const MAX_OPEN_OFFERS = 5;
// Gifting anti-abuse.
const MAX_GIFT_QTY = 99;        // per single gift (also enforced by DB check)
const MAX_GIFTS_PER_DAY = 25;   // rolling 24h send cap per user
const MAX_GIFT_MESSAGE = 200;
const OWNED_CAP = 999;          // matches admin airdrop cap

async function ownedQty(supabase, userId, pokemonId) {
  const { data } = await supabase
    .from("owned_cards")
    .select("quantity")
    .eq("user_id", userId)
    .eq("pokemon_id", pokemonId)
    .maybeSingle();
  return data?.quantity || 0;
}

async function incrementOwned(supabase, userId, pokemonId, delta) {
  const { data: existing } = await supabase
    .from("owned_cards")
    .select("quantity")
    .eq("user_id", userId)
    .eq("pokemon_id", pokemonId)
    .maybeSingle();
  const newQty = (existing?.quantity || 0) + delta;
  if (newQty <= 0) {
    // Delete row when quantity hits zero so the collection doesn't carry
    // ghost entries (which would show up in trade lists etc).
    await supabase
      .from("owned_cards")
      .delete()
      .eq("user_id", userId)
      .eq("pokemon_id", pokemonId);
    return 0;
  }
  await supabase
    .from("owned_cards")
    .upsert(
      { user_id: userId, pokemon_id: pokemonId, quantity: newQty, acquired_at: new Date().toISOString() },
      { onConflict: "user_id,pokemon_id" }
    );
  return newQty;
}

// Decorate an offer row with the offerer's display name + pokemon meta so
// the client doesn't need a separate join.
async function decorateOffers(supabase, getPokedex, rows) {
  if (!rows.length) return [];
  const pokedex = await getPokedex();
  const byId = new Map((pokedex || []).map((p) => [p.id, p]));
  // Batch-fetch display names.
  const userIds = [...new Set(rows.flatMap((r) => [r.offerer_user_id, r.accepter_user_id].filter(Boolean)))];
  let users = {};
  if (userIds.length) {
    const { data } = await supabase.from("users").select("id, display_name").in("id", userIds);
    for (const u of (data || [])) users[u.id] = u.display_name;
  }
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    offered: byId.get(r.offered_pokemon_id) ? cardSummary(byId.get(r.offered_pokemon_id)) : null,
    wanted:  byId.get(r.wanted_pokemon_id)  ? cardSummary(byId.get(r.wanted_pokemon_id))  : null,
    offererName:  users[r.offerer_user_id]  || "Trainer",
    accepterName: users[r.accepter_user_id] || null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    acceptedAt: r.accepted_at,
  }));
}

// Decorate gift rows with pokemon meta + both parties' display names so the
// client can render sent/received lists without extra round-trips.
async function decorateGifts(supabase, getPokedex, rows) {
  if (!rows.length) return [];
  const pokedex = await getPokedex();
  const byId = new Map((pokedex || []).map((p) => [p.id, p]));
  const userIds = [...new Set(rows.flatMap((r) => [r.sender_user_id, r.recipient_user_id]))];
  let users = {};
  if (userIds.length) {
    const { data } = await supabase.from("users").select("id, display_name").in("id", userIds);
    for (const u of (data || [])) users[u.id] = u.display_name;
  }
  return rows.map((r) => ({
    id: r.id,
    card: byId.get(r.pokemon_id) ? cardSummary(byId.get(r.pokemon_id)) : null,
    quantity: r.quantity,
    message: r.message || null,
    seen: !!r.seen,
    senderName: users[r.sender_user_id] || "Trainer",
    recipientName: users[r.recipient_user_id] || "Trainer",
    createdAt: r.created_at,
  }));
}

function cardSummary(c) {
  return {
    id: c.id, name: c.name, types: c.types, tier: c.tier,
    energyCost: c.energyCost, cardHp: c.cardHp, cardAttack: c.cardAttack,
    sprite_front: c.sprite_front, is_legendary: !!c.is_legendary, is_mythical: !!c.is_mythical,
  };
}

function mount(app, supabase, getPokedex) {
  if (!supabase) return;

  async function loadDex() {
    const v = getPokedex();
    return v && typeof v.then === "function" ? await v : v;
  }

  // Public market — anyone can browse open offers.
  app.get("/api/trades/market", async (req, res) => {
    const wanted = Number(req.query.wanted) || null;
    const offered = Number(req.query.offered) || null;
    let q = supabase.from("trade_offers").select("*").eq("status", "open").order("created_at", { ascending: false }).limit(50);
    if (wanted) q = q.eq("wanted_pokemon_id", wanted);
    if (offered) q = q.eq("offered_pokemon_id", offered);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    const offers = await decorateOffers(supabase, loadDex, data || []);
    res.json({ offers });
  });

  app.post("/me/trades", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const offered = Number(req.body?.offeredPokemonId);
    const wanted  = Number(req.body?.wantedPokemonId);
    if (!offered || !wanted) return res.status(400).json({ error: "Both offered and wanted pokemon ids required." });
    if (offered === wanted) return res.status(400).json({ error: "Can't offer the same pokemon you're asking for." });
    // Ownership check.
    const qty = await ownedQty(supabase, req.user.id, offered);
    if (qty < 1) return res.status(400).json({ error: "You don't own that card." });
    // Open-offer cap.
    const { count } = await supabase
      .from("trade_offers")
      .select("*", { count: "exact", head: true })
      .eq("offerer_user_id", req.user.id)
      .eq("status", "open");
    if ((count || 0) >= MAX_OPEN_OFFERS) {
      return res.status(429).json({ error: `Max ${MAX_OPEN_OFFERS} open offers — cancel one first.` });
    }
    const { data, error } = await supabase
      .from("trade_offers")
      .insert({
        offerer_user_id: req.user.id,
        offered_pokemon_id: offered,
        wanted_pokemon_id: wanted,
      })
      .select("*")
      .single();
    if (error) return res.status(500).json({ error: error.message });
    const decorated = await decorateOffers(supabase, loadDex, [data]);
    res.json({ offer: decorated[0] });
  });

  app.get("/me/trades", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const { data, error } = await supabase
      .from("trade_offers")
      .select("*")
      .eq("offerer_user_id", req.user.id)
      .eq("status", "open")
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const offers = await decorateOffers(supabase, loadDex, data || []);
    res.json({ offers });
  });

  app.get("/me/trades/history", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const { data, error } = await supabase
      .from("trade_offers")
      .select("*")
      .or(`offerer_user_id.eq.${req.user.id},accepter_user_id.eq.${req.user.id}`)
      .in("status", ["accepted", "cancelled", "expired"])
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) return res.status(500).json({ error: error.message });
    const offers = await decorateOffers(supabase, loadDex, data || []);
    res.json({ offers });
  });

  app.post("/me/trades/:id/accept", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const tradeId = req.params.id;
    // Read + check + mark accepted in one query (atomic via WHERE clause).
    // If another accepter beat us to it, the update affects 0 rows.
    const { data: offer } = await supabase
      .from("trade_offers")
      .select("*")
      .eq("id", tradeId)
      .maybeSingle();
    if (!offer) return res.status(404).json({ error: "Trade not found." });
    if (offer.status !== "open") return res.status(409).json({ error: "Trade no longer open." });
    if (offer.offerer_user_id === req.user.id) return res.status(400).json({ error: "Can't accept your own trade." });
    if (new Date(offer.expires_at).getTime() < Date.now()) {
      await supabase.from("trade_offers").update({ status: "expired" }).eq("id", tradeId).eq("status", "open");
      return res.status(410).json({ error: "Trade expired." });
    }
    // Both parties must still own their side of the swap.
    const [offererHas, accepterHas] = await Promise.all([
      ownedQty(supabase, offer.offerer_user_id, offer.offered_pokemon_id),
      ownedQty(supabase, req.user.id, offer.wanted_pokemon_id),
    ]);
    if (offererHas < 1) {
      await supabase.from("trade_offers").update({ status: "cancelled" }).eq("id", tradeId).eq("status", "open");
      return res.status(410).json({ error: "Offerer no longer has the card. Offer cancelled." });
    }
    if (accepterHas < 1) {
      return res.status(400).json({ error: "You don't own the card this trade wants." });
    }
    // Atomically claim the offer: only succeeds if it's still open. If
    // another accepter raced us, this affects 0 rows.
    const { data: claim, error: claimErr } = await supabase
      .from("trade_offers")
      .update({ status: "accepted", accepter_user_id: req.user.id, accepted_at: new Date().toISOString() })
      .eq("id", tradeId)
      .eq("status", "open")
      .select("*")
      .maybeSingle();
    if (claimErr) return res.status(500).json({ error: claimErr.message });
    if (!claim) return res.status(409).json({ error: "Trade was just accepted by someone else." });
    // Run the swap. Order matters slightly — decrement first so a
    // mid-flight failure can't double-grant.
    await incrementOwned(supabase, offer.offerer_user_id, offer.offered_pokemon_id, -1);
    await incrementOwned(supabase, req.user.id, offer.wanted_pokemon_id, -1);
    await incrementOwned(supabase, offer.offerer_user_id, offer.wanted_pokemon_id, +1);
    await incrementOwned(supabase, req.user.id, offer.offered_pokemon_id, +1);
    const decorated = await decorateOffers(supabase, loadDex, [claim]);
    res.json({ offer: decorated[0], swapped: true });
  });

  app.post("/me/trades/:id/cancel", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const tradeId = req.params.id;
    const { data, error } = await supabase
      .from("trade_offers")
      .update({ status: "cancelled" })
      .eq("id", tradeId)
      .eq("offerer_user_id", req.user.id)
      .eq("status", "open")
      .select("*")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Trade not found or not yours." });
    res.json({ ok: true });
  });

  // ===== Gifting ==========================================================
  // A gift is a one-way transfer — unlike a trade offer, nobody has to accept.
  // Pick a card you own + a recipient trainer, and copies move straight into
  // their collection with an optional note.

  // Find a trainer to gift to (by display name, or exact UUID). Excludes you.
  app.get("/me/users/search", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ users: [] });
    const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);
    let query = supabase.from("users").select("id, display_name");
    query = uuidLike ? query.eq("id", q) : query.ilike("display_name", `%${q}%`);
    const { data, error } = await query.order("display_name", { ascending: true }).limit(10);
    if (error) return res.status(500).json({ error: error.message });
    const users = (data || []).filter((u) => u.id !== req.user.id);
    res.json({ users });
  });

  // Send a gift. Body: { recipientUserId, pokemonId, quantity?, message? }.
  app.post("/me/gifts", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const recipientUserId = String(req.body?.recipientUserId || "").trim();
    const pokemonId = Number(req.body?.pokemonId);
    let quantity = Math.floor(Number(req.body?.quantity) || 1);
    const message = String(req.body?.message || "").trim().slice(0, MAX_GIFT_MESSAGE) || null;

    if (!recipientUserId) return res.status(400).json({ error: "Pick a trainer to gift to." });
    if (!pokemonId) return res.status(400).json({ error: "Pick a card to gift." });
    if (recipientUserId === req.user.id) return res.status(400).json({ error: "You can't gift to yourself." });
    if (quantity < 1) quantity = 1;
    if (quantity > MAX_GIFT_QTY) return res.status(400).json({ error: `Max ${MAX_GIFT_QTY} copies per gift.` });

    // Recipient must exist.
    const { data: recipient } = await supabase
      .from("users").select("id, display_name").eq("id", recipientUserId).maybeSingle();
    if (!recipient) return res.status(404).json({ error: "That trainer wasn't found." });

    // Daily send cap (rolling 24h) — cheap anti-spam.
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count } = await supabase
      .from("card_gifts")
      .select("*", { count: "exact", head: true })
      .eq("sender_user_id", req.user.id)
      .gte("created_at", since);
    if ((count || 0) >= MAX_GIFTS_PER_DAY) {
      return res.status(429).json({ error: `You've hit the daily gift limit (${MAX_GIFTS_PER_DAY}). Try again later.` });
    }

    // Must own enough copies.
    const owned = await ownedQty(supabase, req.user.id, pokemonId);
    if (owned < quantity) {
      return res.status(400).json({ error: owned === 0 ? "You don't own that card." : `You only own ${owned} of that card.` });
    }

    // Transfer: decrement sender first (so a mid-flight failure can't
    // double-grant), then credit the recipient, capped like admin airdrops.
    await incrementOwned(supabase, req.user.id, pokemonId, -quantity);
    const recipientHas = await ownedQty(supabase, recipientUserId, pokemonId);
    const grant = Math.min(quantity, OWNED_CAP - recipientHas);
    if (grant > 0) await incrementOwned(supabase, recipientUserId, pokemonId, grant);

    // Log it (best-effort — the transfer already happened).
    const { data: giftRow, error: logErr } = await supabase
      .from("card_gifts")
      .insert({
        sender_user_id: req.user.id,
        recipient_user_id: recipientUserId,
        pokemon_id: pokemonId,
        quantity,
        message,
      })
      .select("*")
      .single();
    if (logErr) console.error("[gift] log insert failed:", logErr.message);
    console.log(`[gift] ${req.user.id} → ${recipientUserId} (${recipient.display_name}) pokemon=${pokemonId} x${quantity}`);

    const decorated = giftRow ? await decorateGifts(supabase, loadDex, [giftRow]) : [];
    res.json({ ok: true, gift: decorated[0] || null, recipientName: recipient.display_name });
  });

  // Inbox + sent history, plus the unseen badge count.
  app.get("/me/gifts", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const [{ data: received }, { data: sent }] = await Promise.all([
      supabase.from("card_gifts").select("*")
        .eq("recipient_user_id", req.user.id).order("created_at", { ascending: false }).limit(50),
      supabase.from("card_gifts").select("*")
        .eq("sender_user_id", req.user.id).order("created_at", { ascending: false }).limit(50),
    ]);
    const [rx, tx] = await Promise.all([
      decorateGifts(supabase, loadDex, received || []),
      decorateGifts(supabase, loadDex, sent || []),
    ]);
    res.json({ received: rx, sent: tx, unseen: rx.filter((g) => !g.seen).length });
  });

  // Clear the unseen badge (called when the Gifts tab is opened).
  app.post("/me/gifts/seen", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    await supabase.from("card_gifts").update({ seen: true })
      .eq("recipient_user_id", req.user.id).eq("seen", false);
    res.json({ ok: true });
  });
}

module.exports = { mount };
