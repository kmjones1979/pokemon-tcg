// Guest-state migration. After a brand-new user signs up (or signs in
// for the first time on a new device), the client posts whatever they
// accumulated as a guest — owned cards, completed story chapters,
// champion wins — and this endpoint merges it into their user row.
//
// Idempotency: merging is union-based for the array fields, additive
// + capped for the per-card quantity. Calling twice with the same
// payload only changes anything the first time (subsequent calls
// either no-op or bump card counts again until the cap). The client
// clears its localStorage on success, so a normal flow never replays.
//
// Anti-abuse: we cap guest-granted cards at 5 each, total card grant
// at 50 (hand-tuned: enough to seed a deck draft, not enough to fund
// a meta).

const PER_CARD_CAP = 5;
const TOTAL_GRANT_CAP = 50;
const VALID_CHAMPION_IDS = new Set(["lance", "cynthia", "steven", "red"]);

async function bumpOwnedCards(supabase, userId, entries) {
  // entries: [{ pokemonId, quantity }]. Idempotent within the cap —
  // we read current quantity, raise by `quantity` clamped to the cap.
  for (const { pokemonId, quantity } of entries) {
    if (!Number.isFinite(pokemonId) || pokemonId <= 0) continue;
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const { data } = await supabase
      .from("owned_cards")
      .select("quantity")
      .eq("user_id", userId)
      .eq("pokemon_id", pokemonId)
      .maybeSingle();
    const cur = data?.quantity || 0;
    const next = Math.min(PER_CARD_CAP, cur + Math.min(PER_CARD_CAP, quantity));
    if (next === cur) continue;
    await supabase.from("owned_cards").upsert({
      user_id: userId,
      pokemon_id: pokemonId,
      quantity: next,
      acquired_at: new Date().toISOString(),
    }, { onConflict: "user_id,pokemon_id" });
  }
}

async function mergeStoryProgress(supabase, userId, chapterIds) {
  if (!Array.isArray(chapterIds) || !chapterIds.length) return;
  const valid = chapterIds.filter((id) => typeof id === "string" && id.length < 64).slice(0, 20);
  if (!valid.length) return;
  const { data } = await supabase.from("users").select("story_progress").eq("id", userId).maybeSingle();
  const cur = data?.story_progress || { completed: [] };
  const merged = { ...cur, completed: [...new Set([...(cur.completed || []), ...valid])] };
  await supabase.from("users").update({ story_progress: merged }).eq("id", userId);
}

async function mergeChampionWins(supabase, userId, championIds) {
  if (!Array.isArray(championIds) || !championIds.length) return;
  const valid = championIds.filter((id) => VALID_CHAMPION_IDS.has(id));
  if (!valid.length) return;
  const { data } = await supabase.from("users").select("champion_wins").eq("id", userId).maybeSingle();
  const cur = data?.champion_wins || [];
  const merged = [...new Set([...cur, ...valid])];
  await supabase.from("users").update({ champion_wins: merged }).eq("id", userId);
}

// Sanitize + size-limit the inbound payload. Returns the cleaned entries
// (ready for bumpOwnedCards) plus the chapter and champion arrays.
function sanitize(body) {
  const ownedRaw = body?.ownedCards || {};
  const entries = [];
  let totalGrant = 0;
  for (const [k, v] of Object.entries(ownedRaw)) {
    const id = Number(k);
    const qty = Math.min(PER_CARD_CAP, Math.max(0, Math.floor(Number(v) || 0)));
    if (!Number.isInteger(id) || id <= 0 || qty <= 0) continue;
    if (totalGrant + qty > TOTAL_GRANT_CAP) break;
    totalGrant += qty;
    entries.push({ pokemonId: id, quantity: qty });
    if (entries.length >= 100) break;
  }
  return {
    entries,
    storyProgress: Array.isArray(body?.storyProgress) ? body.storyProgress : [],
    championWins: Array.isArray(body?.championWins) ? body.championWins : [],
  };
}

function mount(app, supabase) {
  if (!supabase) return;
  app.post("/me/migrate-guest", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    const { entries, storyProgress, championWins } = sanitize(req.body || {});
    try {
      await bumpOwnedCards(supabase, req.user.id, entries);
      await mergeStoryProgress(supabase, req.user.id, storyProgress);
      await mergeChampionWins(supabase, req.user.id, championWins);
      res.json({
        ok: true,
        cardsGranted: entries.length,
        chaptersMerged: storyProgress.length,
        championsMerged: championWins.length,
      });
    } catch (err) {
      console.error("[migrate-guest] failed:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { mount, sanitize, PER_CARD_CAP, TOTAL_GRANT_CAP };
