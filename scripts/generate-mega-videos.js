// Generate the animated HD looping videos for Mega cards with Google Veo
// (Gemini API), then host them on Supabase Storage — mirroring the TTS
// pipeline in generate-tts.js.
//
// For each Mega in shared/mega-evolutions.js that doesn't yet have a video:
//   1. Seed Veo with the Mega's official artwork (posterUrl) + videoPrompt.
//   2. Poll the long-running operation until the clip is ready.
//   3. Download the MP4 and upload it to the public `mega-videos` bucket.
//   4. Record the public URL in shared/mega-videos.json (id → url), which the
//      registry merges at load/build time.
//
// Idempotent: Megas already present in mega-videos.json are skipped unless you
// pass --force. Veo clips are ~8s at 720p+; the prompts ask for a seamless
// loop, which reads well as looping card art.
//
// Usage:
//   node scripts/generate-mega-videos.js            # generate missing videos
//   node scripts/generate-mega-videos.js --force    # regenerate all
//   node scripts/generate-mega-videos.js 10094      # just one mega id
//
// Env (.env): VEO_API_KEY (Gemini API key), SUPABASE_URL, SUPABASE_SERVICE_KEY.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { MEGA_DEFS } = require("../shared/mega-evolutions");

const { VEO_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!VEO_API_KEY) { console.error("Missing VEO_API_KEY in .env"); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env"); process.exit(1);
}

const GLA = "https://generativelanguage.googleapis.com/v1beta";
// Veo model (image-to-video). veo-3.1-fast is quick + cheap and looks great
// for short card loops; override with VEO_MODEL (e.g. veo-3.1-generate-preview
// for max quality).
const MODEL = process.env.VEO_MODEL || "veo-3.1-fast-generate-preview";
const BUCKET = "mega-videos";
const OUT_JSON = path.join(__dirname, "..", "shared", "mega-videos.json");

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const onlyId = args.find((a) => /^\d+$/.test(a));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readGenerated() {
  try { return JSON.parse(fs.readFileSync(OUT_JSON, "utf8")); } catch { return {}; }
}
function writeGenerated(obj) {
  fs.writeFileSync(OUT_JSON, JSON.stringify(obj, null, 2) + "\n");
}

// Fetch the seed artwork and return { bytesBase64Encoded, mimeType }.
async function fetchSeedImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`seed image ${res.status} for ${url}`);
  const mimeType = res.headers.get("content-type") || "image/png";
  const buf = Buffer.from(await res.arrayBuffer());
  return { bytesBase64Encoded: buf.toString("base64"), mimeType };
}

// Kick off Veo image-to-video; returns the long-running operation name.
async function startVeo(def) {
  const image = await fetchSeedImage(def.posterUrl);
  const res = await fetch(`${GLA}/models/${MODEL}:predictLongRunning?key=${VEO_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: [{ prompt: def.videoPrompt, image }],
      // 9:16 vertical so the clip fills a portrait trading-card frame.
      parameters: { aspectRatio: "9:16", personGeneration: "allow_all" },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Veo start ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
  if (!body.name) throw new Error(`Veo start returned no operation name: ${JSON.stringify(body).slice(0, 400)}`);
  return body.name;
}

// Poll until the operation is done; return the video bytes (Buffer).
async function awaitVeo(opName) {
  for (let i = 0; i < 60; i++) { // up to ~10 min at 10s cadence
    await sleep(10_000);
    const res = await fetch(`${GLA}/${opName}?key=${VEO_API_KEY}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`poll ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    if (!body.done) { process.stdout.write("."); continue; }
    if (body.error) throw new Error(`Veo op error: ${JSON.stringify(body.error).slice(0, 300)}`);
    // Result shape: response.generateVideoResponse.generatedSamples[0].video
    const sample =
      body.response?.generateVideoResponse?.generatedSamples?.[0]?.video
      || body.response?.generatedVideos?.[0]?.video
      || body.response?.predictions?.[0];
    if (!sample) throw new Error(`no video in response: ${JSON.stringify(body).slice(0, 400)}`);
    // Either inline base64 or a URI we fetch with the key.
    if (sample.bytesBase64Encoded) return Buffer.from(sample.bytesBase64Encoded, "base64");
    const uri = sample.uri || sample.videoUri;
    if (!uri) throw new Error(`no bytes or uri in sample: ${JSON.stringify(sample).slice(0, 300)}`);
    const dl = await fetch(uri.includes("key=") ? uri : `${uri}${uri.includes("?") ? "&" : "?"}key=${VEO_API_KEY}`);
    if (!dl.ok) throw new Error(`video download ${dl.status}`);
    return Buffer.from(await dl.arrayBuffer());
  }
  throw new Error("Veo operation timed out");
}

async function ensureBucket() {
  const headers = { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY };
  const get = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${BUCKET}`, { headers });
  if (get.ok) return;
  const create = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
  });
  if (!create.ok) throw new Error(`bucket create ${create.status}: ${(await create.text()).slice(0, 200)}`);
  console.log(`[mega-video] created public bucket "${BUCKET}"`);
}

async function uploadVideo(id, buf) {
  const objectPath = `${id}.mp4`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      apikey: SUPABASE_SERVICE_KEY,
      "Content-Type": "video/mp4",
      "x-upsert": "true",
    },
    body: buf,
  });
  if (!res.ok) throw new Error(`upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;
}

async function main() {
  await ensureBucket();
  const generated = readGenerated();
  const defs = Object.values(MEGA_DEFS).filter((d) => (onlyId ? String(d.id) === onlyId : true));

  for (const def of defs) {
    if (generated[def.id] && !FORCE) {
      console.log(`[mega-video] skip ${def.name} (already generated)`);
      continue;
    }
    console.log(`[mega-video] generating ${def.name}…`);
    try {
      const op = await startVeo(def);
      const buf = await awaitVeo(op);
      const url = await uploadVideo(def.id, buf);
      generated[def.id] = url;
      writeGenerated(generated); // persist incrementally so a crash keeps progress
      console.log(`\n  ✓ ${def.name} → ${url}`);
    } catch (err) {
      console.error(`\n  ✗ ${def.name}: ${err.message}`);
    }
  }
  console.log("[mega-video] done. Rebuild the client bundle to embed the new URLs.");
}

main().catch((e) => { console.error(e); process.exit(1); });
