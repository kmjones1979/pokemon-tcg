// Admin-only endpoints. Gated by the ADMIN_USER_IDS env var (a
// comma-separated list of authenticated-user UUIDs). Currently a
// single feature — airdropping cards directly into a target user's
// collection — but the module is the natural home for future admin
// affordances (force-finishing a quest, resetting a player's deck,
// granting XP, etc.).
//
// Routes:
//   POST /me/admin/airdrop  body { recipientUserId, pokemonId, quantity?=1 }
//                            (auth + admin allowlist required)
//
// Why the allowlist lives in an env var rather than a database flag:
//   - No risk of an injection / mis-update turning the wrong account
//     into an admin (env is server-only).
//   - The list rarely changes, so the operational cost of redeploying
//     to add a new admin is acceptable in exchange for the audit
//     simplicity.
//   - Trivially auditable: `vercel env ls production` shows who has
//     admin without needing DB access.

function parseAdminIds() {
  const raw = process.env.ADMIN_USER_IDS || "";
  return new Set(
    raw.split(",").map((s) => s.trim()).filter(Boolean),
  );
}

function isAdmin(userId) {
  if (!userId) return false;
  return parseAdminIds().has(String(userId));
}

function mount(app, supabase) {
  // POST /me/admin/airdrop — grants `quantity` copies of `pokemonId`
  // to `recipientUserId`. Idempotent on (user_id, pokemon_id) — re-
  // runs add to the existing quantity instead of erroring.
  app.post("/me/admin/airdrop", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    if (!isAdmin(req.user.id)) return res.status(403).json({ error: "Admin only." });
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
}

module.exports = { mount, isAdmin, parseAdminIds };
