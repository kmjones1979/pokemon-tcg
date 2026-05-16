// scripts/seed-pokedex.js
// Pulls Pokémon #1–1025 (Gen 1–9) from PokeAPI and upserts them into the
// `pokemon` table in Supabase. Idempotent — re-running won't duplicate rows.
//
// Usage:
//   1. Create a free Supabase project at https://supabase.com
//   2. Paste scripts/schema.sql into Supabase SQL Editor → Run
//   3. Copy .env.example → .env and fill SUPABASE_URL + SUPABASE_SERVICE_KEY
//   4. yarn && node scripts/seed-pokedex.js

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const cliProgress = require("cli-progress");
const { fetchPokemon } = require("../scraper/pokeapi");

const START = parseInt(process.env.START_ID || "1", 10);
const END = parseInt(process.env.END_ID || "1025", 10); // Gen 1–9
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "8", 10);
const BATCH_SIZE = 50; // upsert in batches to keep payloads small

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    "\nMissing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.\n" +
      "Copy .env.example to .env and fill in your Supabase credentials.\n",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// Tiny async pool — runs `worker(item)` over `items` with `n` in flight.
async function pool(items, n, worker) {
  const results = new Array(items.length);
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        results[idx] = { __error: err };
      }
    }
  }
  await Promise.all(Array.from({ length: n }, next));
  return results;
}

async function upsertBatch(rows) {
  const { error } = await supabase
    .from("pokemon")
    .upsert(rows, { onConflict: "id" });
  if (error) throw error;
}

async function main() {
  const ids = [];
  for (let id = START; id <= END; id++) ids.push(id);

  console.log(
    `Seeding pokemon ${START}–${END} (${ids.length} total), concurrency=${CONCURRENCY}`,
  );

  const bar = new cliProgress.SingleBar(
    {
      format:
        "Pokédex |{bar}| {percentage}% | {value}/{total} | fetched: {fetched} | failed: {failed}",
      hideCursor: true,
      barCompleteChar: "█",
      barIncompleteChar: "░",
    },
    cliProgress.Presets.shades_classic,
  );
  bar.start(ids.length, 0, { fetched: 0, failed: 0 });

  let fetched = 0;
  let failed = 0;
  const buffer = [];
  const failures = [];

  async function flushIfReady(force = false) {
    while (buffer.length >= BATCH_SIZE || (force && buffer.length > 0)) {
      const chunk = buffer.splice(0, BATCH_SIZE);
      let attempt = 0;
      while (true) {
        try {
          await upsertBatch(chunk);
          break;
        } catch (err) {
          attempt++;
          if (attempt > 5) {
            console.error("\nUpsert failed after retries:", err.message);
            throw err;
          }
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
    }
  }

  await pool(ids, CONCURRENCY, async (id) => {
    try {
      const row = await fetchPokemon(id);
      buffer.push(row);
      fetched++;
      await flushIfReady(false);
    } catch (err) {
      failed++;
      failures.push({ id, message: err.message });
    } finally {
      bar.increment(1, { fetched, failed });
    }
  });

  // Flush remainder.
  await flushIfReady(true);
  bar.stop();

  if (failures.length) {
    console.log(`\n${failures.length} failures:`);
    for (const f of failures.slice(0, 20)) {
      console.log(`  #${f.id}: ${f.message}`);
    }
    if (failures.length > 20) console.log(`  …and ${failures.length - 20} more`);
  }

  // Final sanity check.
  const { count, error: countErr } = await supabase
    .from("pokemon")
    .select("*", { count: "exact", head: true });
  if (countErr) {
    console.error("\nCould not query row count:", countErr.message);
  } else {
    console.log(`\nRows in pokemon table: ${count}`);
  }

  // Per-generation breakdown — query per-gen with head:true counts so we
  // aren't subject to PostgREST's default 1000-row limit.
  console.log("\nPer-generation counts:");
  for (let g = 1; g <= 9; g++) {
    const { count: gc, error: gerr } = await supabase
      .from("pokemon")
      .select("*", { count: "exact", head: true })
      .eq("generation", g);
    if (gerr) {
      console.log(`  Gen ${g}: <error: ${gerr.message}>`);
    } else {
      console.log(`  Gen ${g}: ${gc}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
