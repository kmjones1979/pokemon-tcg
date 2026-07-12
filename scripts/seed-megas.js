// Seed the Mega Evolution cards into the `pokemon` table.
//
// Megas are playable cards stored as synthetic rows (id = 10000 + baseId) so
// they flow through toCard() / deck-builder / battle engine like any species.
// Their identity + stats come from shared/mega-evolutions.js. This inserts /
// updates those rows using ONLY existing columns (no schema change): the
// poster art goes in sprite_front; the looping video URL is served from the
// registry, not the DB.
//
// Idempotent — upserts on id, safe to re-run (e.g. after tweaking stats).
//
// Usage:
//   node scripts/seed-megas.js          # upsert all Mega rows
//
// Env (same as seed-pokedex.js): SUPABASE_URL, SUPABASE_SERVICE_KEY

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { MEGA_DEFS } = require("../shared/mega-evolutions");

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("\nMissing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.\n");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// Megas sit at the top of the power curve; generation is a sentinel (0) so
// they're easy to exclude from the Gen-1..9 Pokédex if a query ever forgets
// to filter on id. flavor_text doubles as a UI blurb.
const GEN_SENTINEL = 0;

function rowFor(def) {
  const s = def.stats;
  return {
    id: def.id,
    name: def.name,
    slug: def.slug,
    types: def.types,
    hp: s.hp,
    attack: s.attack,
    defense: s.defense,
    sp_attack: s.sp_attack,
    sp_defense: s.sp_defense,
    speed: s.speed,
    abilities: [],
    sprite_front: def.posterUrl,
    sprite_back: null,
    cry_url: null,
    flavor_text: `${def.name} — a Mega Evolution. Mega-evolve by owning 3 of its final form.`,
    generation: GEN_SENTINEL,
    is_legendary: false,
    is_mythical: false,
  };
}

async function main() {
  const rows = Object.values(MEGA_DEFS).map(rowFor);
  console.log(`[seed-megas] upserting ${rows.length} Mega rows…`);
  const { data, error } = await supabase
    .from("pokemon")
    .upsert(rows, { onConflict: "id" })
    .select("id, name");
  if (error) {
    console.error("[seed-megas] failed:", error.message);
    process.exit(1);
  }
  for (const r of data) console.log(`  ✓ #${r.id} ${r.name}`);
  console.log("[seed-megas] done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
