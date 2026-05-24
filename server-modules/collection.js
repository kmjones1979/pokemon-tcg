// Account-bound collection + deck endpoints. Mounted at /me/*.
//
//   GET    /me/collection       -> { cards: [{id, name, quantity, ...}], total }
//   GET    /me/decks            -> { decks: [...] }
//   GET    /me/decks/active     -> { deck: {...} | null }
//   POST   /me/decks            -> create deck { name, card_ids[30] }
//   PATCH  /me/decks/:id        -> update deck { name?, card_ids? }
//   POST   /me/decks/:id/active -> mark active
//   DELETE /me/decks/:id        -> delete deck

const { toCard } = require("../shared/deck-builder");

const DECK_SIZE = 30;
const MAX_COPIES = 2;

function requireAuth(req, res) {
  if (!req.user) {
    res.status(401).json({ error: "Sign in required." });
    return false;
  }
  return true;
}

function validateDeckCards(cardIds) {
  if (!Array.isArray(cardIds) || cardIds.length !== DECK_SIZE) {
    return `Deck must contain exactly ${DECK_SIZE} cards.`;
  }
  const counts = new Map();
  for (const id of cardIds) {
    if (!Number.isInteger(id) || id < 1) return "Invalid card id in deck.";
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  for (const [id, n] of counts) {
    if (n > MAX_COPIES) return `Card ${id} appears ${n} times (max ${MAX_COPIES}).`;
  }
  return null;
}

async function ensureOwnsAll(supabase, userId, cardIds) {
  const counts = new Map();
  for (const id of cardIds) counts.set(id, (counts.get(id) || 0) + 1);
  const uniqueIds = [...counts.keys()];
  const { data: owned, error } = await supabase
    .from("owned_cards")
    .select("pokemon_id, quantity")
    .eq("user_id", userId)
    .in("pokemon_id", uniqueIds);
  if (error) throw new Error(error.message);
  const ownedMap = new Map(owned.map((o) => [o.pokemon_id, o.quantity]));
  for (const [id, n] of counts) {
    const haveQty = ownedMap.get(id) || 0;
    if (haveQty < n) {
      return `You only own ${haveQty} of card #${id} (deck needs ${n}).`;
    }
  }
  return null;
}

function mount(app, supabase) {
  // GET /me/collection — joined with pokemon table for display
  app.get("/me/collection", async (req, res) => {
    if (!requireAuth(req, res)) return;
    const { data, error } = await supabase
      .from("owned_cards")
      .select("pokemon_id, quantity, shiny_level, acquired_at, pokemon:pokemon_id(*)")
      .eq("user_id", req.user.id)
      .order("acquired_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const cards = data.map((row) => ({
      ...toCard(row.pokemon),
      quantity: row.quantity,
      shinyLevel: row.shiny_level || 0,
      acquired_at: row.acquired_at,
    }));
    const total = cards.reduce((sum, c) => sum + c.quantity, 0);
    res.json({ cards, total });
  });

  app.get("/me/decks", async (req, res) => {
    if (!requireAuth(req, res)) return;
    const { data, error } = await supabase
      .from("decks")
      .select("*")
      .eq("user_id", req.user.id)
      .order("updated_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ decks: data });
  });

  app.get("/me/decks/active", async (req, res) => {
    if (!requireAuth(req, res)) return;
    const { data, error } = await supabase
      .from("decks")
      .select("*")
      .eq("user_id", req.user.id)
      .eq("is_active", true)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ deck: data || null });
  });

  app.post("/me/decks", async (req, res) => {
    if (!requireAuth(req, res)) return;
    const { name, card_ids, set_active } = req.body || {};
    const err = validateDeckCards(card_ids);
    if (err) return res.status(400).json({ error: err });
    const ownErr = await ensureOwnsAll(supabase, req.user.id, card_ids);
    if (ownErr) return res.status(400).json({ error: ownErr });

    if (set_active) {
      await supabase
        .from("decks")
        .update({ is_active: false })
        .eq("user_id", req.user.id);
    }
    const { data, error } = await supabase
      .from("decks")
      .insert({
        user_id: req.user.id,
        name: (name || "Main Deck").slice(0, 40),
        card_ids,
        is_active: !!set_active,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ deck: data });
  });

  app.patch("/me/decks/:id", async (req, res) => {
    if (!requireAuth(req, res)) return;
    const { id } = req.params;
    const { name, card_ids } = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (name) patch.name = String(name).slice(0, 40);
    if (card_ids) {
      const err = validateDeckCards(card_ids);
      if (err) return res.status(400).json({ error: err });
      const ownErr = await ensureOwnsAll(supabase, req.user.id, card_ids);
      if (ownErr) return res.status(400).json({ error: ownErr });
      patch.card_ids = card_ids;
    }
    const { data, error } = await supabase
      .from("decks")
      .update(patch)
      .eq("id", id)
      .eq("user_id", req.user.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ deck: data });
  });

  app.post("/me/decks/:id/active", async (req, res) => {
    if (!requireAuth(req, res)) return;
    const { id } = req.params;
    // Clear current active, then set this one. Two-step to dodge the unique idx.
    await supabase.from("decks").update({ is_active: false }).eq("user_id", req.user.id);
    const { data, error } = await supabase
      .from("decks")
      .update({ is_active: true })
      .eq("id", id)
      .eq("user_id", req.user.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Deck not found." });
    res.json({ deck: data });
  });

  app.delete("/me/decks/:id", async (req, res) => {
    if (!requireAuth(req, res)) return;
    const { id } = req.params;
    const { error } = await supabase
      .from("decks")
      .delete()
      .eq("id", id)
      .eq("user_id", req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  // Pokédex completion view — minimal data per row so the grid stays fast.
  app.get("/me/pokedex", async (req, res) => {
    if (!requireAuth(req, res)) return;
    // All 1025 species in order (id, name, sprite, generation, types).
    const { data: all, error: e1 } = await supabase
      .from("pokemon")
      .select("id, name, sprite_front, generation, types, is_legendary, is_mythical")
      .order("id", { ascending: true });
    if (e1) return res.status(500).json({ error: e1.message });
    const { data: mine, error: e2 } = await supabase
      .from("owned_cards")
      .select("pokemon_id, quantity, shiny_level")
      .eq("user_id", req.user.id);
    if (e2) return res.status(500).json({ error: e2.message });
    const owned = new Map((mine || []).map((r) => [r.pokemon_id, r]));
    const total = all.length;
    let ownedCount = 0;
    const rows = all.map((p) => {
      const o = owned.get(p.id);
      if (o) ownedCount++;
      return {
        id: p.id,
        name: p.name,
        sprite: p.sprite_front,
        generation: p.generation,
        types: p.types,
        legendary: !!p.is_legendary,
        mythical: !!p.is_mythical,
        quantity: o?.quantity || 0,
        shinyLevel: o?.shiny_level || 0,
      };
    });
    res.json({ total, owned: ownedCount, rows });
  });

  // Upgrade a card by consuming 3 duplicate copies — increments shiny_level.
  // Each shiny level grants +1 max HP and +1 attack when that card is
  // instantiated in a match (see engine instantiate()).
  app.post("/me/cards/:pokemonId/upgrade", async (req, res) => {
    if (!requireAuth(req, res)) return;
    const pokemonId = Number(req.params.pokemonId);
    if (!Number.isInteger(pokemonId)) return res.status(400).json({ error: "bad id" });

    const { data: row, error } = await supabase
      .from("owned_cards")
      .select("quantity, shiny_level")
      .eq("user_id", req.user.id)
      .eq("pokemon_id", pokemonId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!row) return res.status(404).json({ error: "You don't own this card." });
    if (row.quantity < 3) return res.status(400).json({ error: "Need 3 copies to upgrade." });
    if (row.shiny_level >= 3) return res.status(400).json({ error: "Already max-level shiny." });

    const newQty = row.quantity - 3;
    const newShiny = (row.shiny_level || 0) + 1;
    const { error: upErr } = await supabase
      .from("owned_cards")
      .update({ quantity: Math.max(1, newQty + 1), shiny_level: newShiny })
      .eq("user_id", req.user.id)
      .eq("pokemon_id", pokemonId);
    // We keep 1 instance of the upgraded card after consuming 3 → so newQty + 1
    if (upErr) return res.status(500).json({ error: upErr.message });
    res.json({ ok: true, shinyLevel: newShiny, quantity: Math.max(1, newQty + 1) });
  });

  // Hydrate a deck's card_ids[] back into full card objects (used by the
  // matchmaker / single-player launcher when a user wants to play with their
  // saved deck).
  app.get("/me/decks/:id/hydrate", async (req, res) => {
    if (!requireAuth(req, res)) return;
    const { id } = req.params;
    const { data: deck, error } = await supabase
      .from("decks")
      .select("*")
      .eq("id", id)
      .eq("user_id", req.user.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!deck) return res.status(404).json({ error: "Deck not found." });

    const uniqueIds = [...new Set(deck.card_ids)];
    const [{ data: rows, error: pErr }, { data: shinies }] = await Promise.all([
      supabase.from("pokemon").select("*").in("id", uniqueIds),
      supabase.from("owned_cards").select("pokemon_id, shiny_level")
        .eq("user_id", req.user.id).in("pokemon_id", uniqueIds),
    ]);
    if (pErr) return res.status(500).json({ error: pErr.message });
    const byId = new Map(rows.map((r) => [r.id, toCard(r)]));
    const shinyMap = new Map((shinies || []).map((s) => [s.pokemon_id, s.shiny_level || 0]));
    const cards = deck.card_ids.map((id) => {
      const c = byId.get(id);
      if (!c) return null;
      return { ...c, shinyLevel: shinyMap.get(id) || 0 };
    }).filter(Boolean);
    // Append the standard 10-spell section so saved decks have parity
    // with random `/api/deck` draws. The decks table only stores
    // Pokémon card_ids (size 30) — spells are added here at hydration
    // time, sampled with replacement from the active spell catalog.
    const { allSpellCards } = require("../shared/spell-cards");
    const { DEFAULT_SPELL_COUNT } = require("../shared/deck-builder");
    const spellPool = allSpellCards();
    if (spellPool.length > 0) {
      for (let i = 0; i < DEFAULT_SPELL_COUNT; i++) {
        cards.push(spellPool[Math.floor(Math.random() * spellPool.length)]);
      }
    }
    res.json({ deck: { ...deck, cards } });
  });
}

module.exports = { mount, DECK_SIZE, MAX_COPIES, validateDeckCards, ensureOwnsAll };
