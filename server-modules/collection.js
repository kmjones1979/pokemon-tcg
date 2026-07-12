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
const { evolutionFor, evolvingToIds } = require("../shared/evolution-chains");
const {
  MEGA_MIN_COPIES, MEGA_CONSUMES, megaForBase, isMegaId, megaDef, megaVideoUrl,
} = require("../shared/mega-evolutions");

// Set of species that are themselves an evolution target — i.e. something
// evolves INTO them. Used to tell a "stage 1" (mid-chain) apart from a basic.
const EVOLUTION_TARGETS = new Set(evolvingToIds());

// Copies consumed by a single evolution. A basic → stage 1 costs 1; a
// stage 1 → stage 2 costs 2. (A species is "stage 1" when it is itself the
// target of an earlier evolution.) The owner keeps the remainder.
function copiesConsumed(pokemonId) {
  return EVOLUTION_TARGETS.has(pokemonId) ? 2 : 1;
}

// Copies you must OWN before a species can be evolved: one more than it
// consumes, so an evolution always leaves you with at least one copy.
// Basic → stage 1 needs 2; stage 1 → stage 2 needs 3.
function minCopiesToEvolve(pokemonId) {
  return copiesConsumed(pokemonId) + 1;
}

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

// Best-effort restore of a base card's quantity after a failed evolve grant,
// so an interrupted evolution doesn't burn the player's copies.
async function rollbackDeduct(supabase, userId, pokemonId, originalQty) {
  try {
    await supabase
      .from("owned_cards")
      .update({ quantity: originalQty })
      .eq("user_id", userId)
      .eq("pokemon_id", pokemonId);
  } catch (err) {
    console.error("[evolve] rollback failed:", err);
  }
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
    // Megas are excluded from the species grid + completion count (they're a
    // prestige tier, not one of the base dex species) and surfaced separately.
    const species = all.filter((p) => !isMegaId(p.id));
    const total = species.length;
    let ownedCount = 0;
    const rows = species.map((p) => {
      const o = owned.get(p.id);
      if (o) ownedCount++;
      const megaId = megaForBase(p.id);
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
        // Next form in the evolution chain (null for final forms / species
        // with no curated chain). Powers the Pokédex "Evolve" action, which
        // is offered once the player owns evolveMinCopies+ copies.
        evolvesToId: evolutionFor(p.id) || null,
        // Copies an evolution of THIS species consumes (1 for a basic, 2 for
        // a stage 1) and the minimum you must own to evolve (consumed + 1).
        // Both null when the species can't evolve.
        evolveCost: evolutionFor(p.id) ? copiesConsumed(p.id) : null,
        evolveMinCopies: evolutionFor(p.id) ? minCopiesToEvolve(p.id) : null,
        // Mega Evolution: a stage-2 with a Mega form can mega-evolve once the
        // player owns MEGA_MIN_COPIES. megaId is the resulting card's dex id.
        megaId: megaId || null,
        megaMinCopies: megaId ? MEGA_MIN_COPIES : null,
      };
    });
    // The Mega showcase: every defined Mega, flagged with whether the player
    // owns it and whether they can craft it right now. Includes the video URL
    // so the client can play the looping animation for owned Megas.
    const megaRows = all.filter((p) => isMegaId(p.id));
    const megas = megaRows.map((p) => {
      const def = megaDef(p.id) || {};
      const o = owned.get(p.id);
      const base = owned.get(def.baseId);
      return {
        id: p.id,
        baseId: def.baseId,
        name: p.name,
        sprite: p.sprite_front,
        videoUrl: megaVideoUrl(p.id),
        types: p.types,
        quantity: o?.quantity || 0,
        owned: !!o && o.quantity > 0,
        // Can the player mega-evolve into this right now?
        canEvolveNow: (base?.quantity || 0) >= MEGA_MIN_COPIES,
        baseOwned: base?.quantity || 0,
        minCopies: MEGA_MIN_COPIES,
        consumes: MEGA_CONSUMES,
      };
    });
    res.json({ total, owned: ownedCount, rows, megas });
  });

  // POST /me/mega-evolve — Mega Evolve a stage-2 into its Mega form. Requires
  // owning MEGA_MIN_COPIES of the base; consumes MEGA_CONSUMES of them and
  // grants one Mega card. Fail-safe deduct-then-grant with rollback, mirroring
  // /me/evolve.
  app.post("/me/mega-evolve", async (req, res) => {
    if (!requireAuth(req, res)) return;
    const baseId = Number(req.body?.pokemonId);
    if (!Number.isInteger(baseId) || baseId < 1) {
      return res.status(400).json({ error: "bad id" });
    }
    const megaId = megaForBase(baseId);
    if (!megaId) {
      return res.status(400).json({ error: "This Pokémon has no Mega Evolution." });
    }

    const { data: baseRow, error: readErr } = await supabase
      .from("owned_cards")
      .select("quantity")
      .eq("user_id", req.user.id)
      .eq("pokemon_id", baseId)
      .maybeSingle();
    if (readErr) return res.status(500).json({ error: readErr.message });
    if (!baseRow || baseRow.quantity < MEGA_MIN_COPIES) {
      return res.status(400).json({ error: `Need ${MEGA_MIN_COPIES} copies to Mega Evolve.` });
    }

    const { data: names, error: nameErr } = await supabase
      .from("pokemon")
      .select("id, name")
      .in("id", [baseId, megaId]);
    if (nameErr) return res.status(500).json({ error: nameErr.message });
    const nameById = new Map((names || []).map((n) => [n.id, n.name]));
    if (!nameById.has(megaId)) {
      return res.status(500).json({ error: "Mega card is not seeded — run scripts/seed-megas.js." });
    }

    const newBaseQty = baseRow.quantity - MEGA_CONSUMES;

    const { error: deductErr } = await supabase
      .from("owned_cards")
      .update({ quantity: newBaseQty })
      .eq("user_id", req.user.id)
      .eq("pokemon_id", baseId);
    if (deductErr) return res.status(500).json({ error: deductErr.message });

    const { data: megaRow, error: megaReadErr } = await supabase
      .from("owned_cards")
      .select("quantity")
      .eq("user_id", req.user.id)
      .eq("pokemon_id", megaId)
      .maybeSingle();
    if (megaReadErr) {
      await rollbackDeduct(supabase, req.user.id, baseId, baseRow.quantity);
      return res.status(500).json({ error: megaReadErr.message });
    }
    const newMegaQty = (megaRow?.quantity || 0) + 1;
    const { error: grantErr } = await supabase
      .from("owned_cards")
      .upsert(
        {
          user_id: req.user.id,
          pokemon_id: megaId,
          quantity: newMegaQty,
          acquired_at: new Date().toISOString(),
        },
        { onConflict: "user_id,pokemon_id" },
      );
    if (grantErr) {
      await rollbackDeduct(supabase, req.user.id, baseId, baseRow.quantity);
      return res.status(500).json({ error: grantErr.message });
    }

    res.json({
      ok: true,
      from: { id: baseId, name: nameById.get(baseId) || `#${baseId}`, quantity: newBaseQty },
      to: {
        id: megaId, name: nameById.get(megaId), quantity: newMegaQty,
        videoUrl: megaVideoUrl(megaId),
      },
      consumed: MEGA_CONSUMES,
    });
  });

  // POST /me/evolve — evolve one copy of `pokemonId` into its next form. Both
  // the eligibility gate and the copies consumed are stage-dependent: a basic
  // needs 2 owned and consumes 1; a stage 1 needs 3 owned and consumes 2 (see
  // minCopiesToEvolve / copiesConsumed). The remainder is kept. Chain data
  // lives in shared/evolution-chains.js.
  app.post("/me/evolve", async (req, res) => {
    if (!requireAuth(req, res)) return;
    const pokemonId = Number(req.body?.pokemonId);
    if (!Number.isInteger(pokemonId) || pokemonId < 1) {
      return res.status(400).json({ error: "bad id" });
    }
    const targetId = evolutionFor(pokemonId);
    if (!targetId) {
      return res.status(400).json({ error: "This Pokémon has no further evolution." });
    }
    const consumed = copiesConsumed(pokemonId);
    const minCopies = minCopiesToEvolve(pokemonId);

    // How many of the base species do we hold?
    const { data: baseRow, error: readErr } = await supabase
      .from("owned_cards")
      .select("quantity")
      .eq("user_id", req.user.id)
      .eq("pokemon_id", pokemonId)
      .maybeSingle();
    if (readErr) return res.status(500).json({ error: readErr.message });
    if (!baseRow || baseRow.quantity < minCopies) {
      return res.status(400).json({ error: `Need ${minCopies} copies to evolve.` });
    }

    // Resolve display names for a friendly response + client toast.
    const { data: names, error: nameErr } = await supabase
      .from("pokemon")
      .select("id, name")
      .in("id", [pokemonId, targetId]);
    if (nameErr) return res.status(500).json({ error: nameErr.message });
    const nameById = new Map((names || []).map((n) => [n.id, n.name]));
    if (!nameById.has(targetId)) {
      // The evolved species isn't in the active Pokédex — refuse rather than
      // grant a card that can't be displayed/played.
      return res.status(500).json({ error: "Evolved species is unavailable." });
    }

    const newBaseQty = baseRow.quantity - consumed;

    // No cross-row transaction available over the REST client, so order the
    // writes to fail safe: deduct the base copies first, then grant the
    // evolved form. If the grant fails we roll the deduction back so the
    // player never silently loses cards.
    const { error: deductErr } = await supabase
      .from("owned_cards")
      .update({ quantity: newBaseQty })
      .eq("user_id", req.user.id)
      .eq("pokemon_id", pokemonId);
    if (deductErr) return res.status(500).json({ error: deductErr.message });

    // Read + upsert the evolved form's quantity (+1).
    const { data: evoRow, error: evoReadErr } = await supabase
      .from("owned_cards")
      .select("quantity")
      .eq("user_id", req.user.id)
      .eq("pokemon_id", targetId)
      .maybeSingle();
    if (evoReadErr) {
      await rollbackDeduct(supabase, req.user.id, pokemonId, baseRow.quantity);
      return res.status(500).json({ error: evoReadErr.message });
    }
    const newEvoQty = (evoRow?.quantity || 0) + 1;
    const { error: grantErr } = await supabase
      .from("owned_cards")
      .upsert(
        {
          user_id: req.user.id,
          pokemon_id: targetId,
          quantity: newEvoQty,
          acquired_at: new Date().toISOString(),
        },
        { onConflict: "user_id,pokemon_id" },
      );
    if (grantErr) {
      await rollbackDeduct(supabase, req.user.id, pokemonId, baseRow.quantity);
      return res.status(500).json({ error: grantErr.message });
    }

    res.json({
      ok: true,
      from: { id: pokemonId, name: nameById.get(pokemonId) || `#${pokemonId}`, quantity: newBaseQty },
      to: { id: targetId, name: nameById.get(targetId), quantity: newEvoQty },
      consumed,
    });
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
