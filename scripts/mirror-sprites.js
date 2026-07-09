// scripts/mirror-sprites.js
// Self-host Pokémon card art on Supabase Storage instead of hot-linking
// raw.githubusercontent.com.
//
// Why: the scraper stores PokeAPI's `official-artwork` URLs
// (https://raw.githubusercontent.com/PokeAPI/sprites/.../official-artwork/<id>.png)
// directly in pokemon.sprite_front / sprite_back. raw.githubusercontent.com
// is NOT a CDN — it rate-limits hot-linking and now returns HTTP 429 for the
// big official-artwork files, so card grids render broken images. This script
// downloads each sprite ONCE (throttled, so we don't trip the 429), uploads it
// to a public Supabase Storage bucket, and rewrites the DB column to the
// Supabase CDN URL. Runtime traffic then never touches GitHub.
//
// Idempotent: rows already pointing at our bucket are skipped. Safe to re-run
// (e.g. after seeding new Pokémon). Uploads use upsert so a partial prior run
// just resumes.
//
// Usage:
//   node scripts/mirror-sprites.js            # dry run — prints the plan, no writes
//   node scripts/mirror-sprites.js --confirm  # download, upload, rewrite DB
//   node scripts/mirror-sprites.js --confirm --force  # re-mirror even rows already on Supabase
//
// Env (same as seed-pokedex.js): SUPABASE_URL, SUPABASE_SERVICE_KEY

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    "\nMissing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.\n" +
      "Copy .env.example to .env and fill in your Supabase credentials.\n",
  );
  process.exit(1);
}

const BUCKET = "card-sprites";
// Serial download with a small delay dodges GitHub's 429. ~1000 Pokémon × 2
// sprites at ~150ms each ≈ 5 min for a full first run; near-instant on re-runs.
// jsDelivr (the primary source) has no hot-link rate limit, so we can go fast;
// the small delay is just politeness / smoothing.
const DOWNLOAD_DELAY_MS = parseInt(process.env.MIRROR_DELAY_MS || "40", 10);
const DOWNLOAD_RETRIES = 4;
const CONCURRENCY = parseInt(process.env.MIRROR_CONCURRENCY || "8", 10);

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");
const FORCE = args.includes("--force");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tiny async pool — runs `worker(item)` over `items` with `n` in flight.
// Same shape as seed-pokedex.js.
async function pool(items, n, worker) {
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: n }, next));
}

// Public URL for an object we've uploaded (or will upload) to the bucket.
function publicUrl(objectPath) {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;
}

// A URL is "already mirrored" if it points at our own bucket.
function isMirrored(url) {
  return typeof url === "string" && url.includes(`/storage/v1/object/public/${BUCKET}/`);
}

async function ensureBucket() {
  // Mirror generate-tts.js: GET the bucket, create public-read if missing.
  const headers = { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY };
  const getRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${BUCKET}`, { headers });
  if (getRes.ok) return;
  if (getRes.status !== 404 && getRes.status !== 400) {
    throw new Error(`bucket check failed ${getRes.status}: ${(await getRes.text()).slice(0, 200)}`);
  }
  const createRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
  });
  if (!createRes.ok) {
    throw new Error(`bucket create failed ${createRes.status}: ${(await createRes.text()).slice(0, 200)}`);
  }
  console.log(`[mirror] created public Supabase Storage bucket "${BUCKET}"`);
}

// The stored URLs are raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>,
// which rate-limits hot-linking (429) — hammering it to mirror just re-trips
// the throttle. So we fetch the SAME file through CDN mirrors of the GitHub
// repo, falling back down the chain per image. jsDelivr is a real CDN with no
// hot-link rate limit and serves the bulk; raw GitHub and statically.io mop up
// the occasional straggler one CDN 403/429s on.
function candidateUrls(rawUrl) {
  const m = rawUrl.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return [rawUrl]; // already a CDN/Supabase URL — just use it as-is
  const [, owner, repo, ref, path] = m;
  return [
    `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${path}`,
    rawUrl,
    `https://cdn.statically.io/gh/${owner}/${repo}/${ref}/${path}`,
  ];
}

// Download via the CDN fallback chain, with retry/backoff on 429/5xx per source.
async function download(rawUrl) {
  const sources = candidateUrls(rawUrl);
  let lastErr;
  for (const url of sources) {
    for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
      try {
        const res = await fetch(url, { redirect: "follow" });
        if (res.ok) {
          const ct = res.headers.get("content-type") || "image/png";
          return { buf: Buffer.from(await res.arrayBuffer()), contentType: ct };
        }
        lastErr = new Error(`${url} → HTTP ${res.status}`);
        // 429/5xx → back off and retry this source; 403/404 → move to next source.
        if (res.status !== 429 && res.status < 500) break;
      } catch (err) {
        lastErr = err;
      }
      await sleep(DOWNLOAD_DELAY_MS * attempt * 3);
    }
  }
  throw lastErr || new Error("download failed (all sources)");
}

async function uploadToBucket(objectPath, buf, contentType) {
  // Supabase Storage REST upload with upsert (x-upsert) so re-runs overwrite.
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      apikey: SUPABASE_SERVICE_KEY,
      "Content-Type": contentType,
      "x-upsert": "true",
      "cache-control": "public, max-age=31536000, immutable",
    },
    body: buf,
  });
  if (!res.ok) {
    throw new Error(`upload ${objectPath} failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

// Mirror one column value. Returns the new (Supabase) URL, or null if there's
// nothing to do / the source couldn't be fetched.
async function mirrorOne(id, side, sourceUrl) {
  if (!sourceUrl) return null;
  if (!FORCE && isMirrored(sourceUrl)) return null; // already ours

  const ext = (sourceUrl.split("?")[0].match(/\.(png|jpg|jpeg|webp|gif)$/i) || [, "png"])[1].toLowerCase();
  const objectPath = `${id}-${side}.${ext}`;

  const { buf, contentType } = await download(sourceUrl);
  await uploadToBucket(objectPath, buf, contentType);
  await sleep(DOWNLOAD_DELAY_MS);
  return publicUrl(objectPath);
}

async function main() {
  console.log(`[mirror] ${CONFIRM ? "LIVE run" : "DRY run (pass --confirm to write)"}${FORCE ? " --force" : ""}`);

  // Pull every card's sprite columns.
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("pokemon")
      .select("id, name, sprite_front, sprite_back")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  console.log(`[mirror] ${rows.length} cards in DB`);

  const needFront = rows.filter((r) => r.sprite_front && (FORCE || !isMirrored(r.sprite_front)));
  const needBack = rows.filter((r) => r.sprite_back && (FORCE || !isMirrored(r.sprite_back)));
  console.log(`[mirror] to mirror: ${needFront.length} fronts, ${needBack.length} backs`);

  if (!CONFIRM) {
    console.log("[mirror] dry run — showing first 5 fronts that would be mirrored:");
    for (const r of needFront.slice(0, 5)) {
      const ext = "png";
      console.log(`  #${r.id} ${r.name}: ${r.sprite_front}\n     → ${publicUrl(`${r.id}-front.${ext}`)}`);
    }
    console.log("\n[mirror] re-run with --confirm to download, upload, and rewrite the DB.");
    return;
  }

  await ensureBucket();

  let done = 0;
  let failed = 0;
  const total = rows.length;

  // Process cards concurrently — jsDelivr is a CDN and handles it, and each
  // card's DB update is keyed by its own id so parallel writes don't race.
  await pool(rows, CONCURRENCY, async (r) => {
    const update = {};
    try {
      const front = await mirrorOne(r.id, "front", r.sprite_front);
      if (front) update.sprite_front = front;
    } catch (err) {
      failed++;
      console.warn(`[mirror] #${r.id} front FAILED: ${err.message} (keeping original URL)`);
    }
    try {
      const back = await mirrorOne(r.id, "back", r.sprite_back);
      if (back) update.sprite_back = back;
    } catch (err) {
      failed++;
      console.warn(`[mirror] #${r.id} back FAILED: ${err.message} (keeping original URL)`);
    }

    if (Object.keys(update).length) {
      const { error } = await supabase.from("pokemon").update(update).eq("id", r.id);
      if (error) {
        failed++;
        console.warn(`[mirror] #${r.id} DB update FAILED: ${error.message}`);
      }
    }

    done++;
    if (done % 50 === 0 || done === total) {
      console.log(`[mirror] ${done}/${total} cards processed (${failed} failures)`);
    }
  });

  console.log(`\n[mirror] done. ${done} cards processed, ${failed} failures.`);
  console.log(`[mirror] card art now served from ${publicUrl("<id>-front.png")}`);
  if (failed) console.log("[mirror] failures kept their original URL — safe to re-run to retry them.");
}

main().catch((err) => {
  console.error("[mirror] fatal:", err);
  process.exit(1);
});
