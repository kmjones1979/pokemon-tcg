// Generate lightweight thumbnails for every bespoke TCG illustration so the
// /art gallery (and the game's card faces) load fast — the full-res PNGs are
// ~2.6 MB each, the thumbnails ~75 KB. Uses macOS `sips` to resize+compress
// (no npm image dependency), then uploads to the same Supabase bucket under a
// `thumb/` prefix as JPEG.
//
//   full: SUPABASE/storage/v1/object/public/tcg-art/<id>.png
//   thumb: SUPABASE/storage/v1/object/public/tcg-art/thumb/<id>.jpg
//
// Idempotent: skips ids that already have a thumb unless you pass --force.
//
// Usage: node scripts/generate-thumbs.js [--force]

require("dotenv").config();
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env"); process.exit(1); }

const BUCKET = "tcg-art";
const WIDTH = 480;         // max dimension; card faces render <=180px, gallery grid ~380px
const QUALITY = 72;
const FORCE = process.argv.includes("--force");
const ART_JS = path.join(__dirname, "..", "client", "js", "tcg", "tcg-art.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tcg-thumb-"));

function readArt() {
  const src = fs.readFileSync(ART_JS, "utf8");
  const m = src.match(/export default (\{[\s\S]*\});?\s*$/);
  return m ? JSON.parse(m[1]) : {};
}

async function thumbExists(id) {
  const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/thumb/${id}.jpg`;
  try { const r = await fetch(url, { method: "HEAD" }); return r.ok; } catch { return false; }
}

async function upload(id, buf) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/thumb/${id}.jpg`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY, "Content-Type": "image/jpeg", "x-upsert": "true" },
    body: buf,
  });
  if (!res.ok) throw new Error(`upload ${res.status}: ${(await res.text()).slice(0, 160)}`);
}

async function makeThumb(id, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch seed ${res.status}`);
  const inPath = path.join(TMP, `${id}.png`);
  const outPath = path.join(TMP, `${id}.jpg`);
  fs.writeFileSync(inPath, Buffer.from(await res.arrayBuffer()));
  execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(QUALITY), "-Z", String(WIDTH), inPath, "--out", outPath], { stdio: "ignore" });
  const buf = fs.readFileSync(outPath);
  fs.unlinkSync(inPath); fs.unlinkSync(outPath);
  return buf;
}

async function main() {
  const art = readArt();
  const ids = Object.keys(art);
  let done = 0, skipped = 0, failed = 0;
  for (const id of ids) {
    if (!FORCE && (await thumbExists(id))) { skipped++; continue; }
    try {
      const buf = await makeThumb(id, art[id]);
      await upload(id, buf);
      done++;
      if (done % 10 === 0) console.log(`[thumbs] ${done} uploaded…`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${id}: ${err.message}`);
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`[thumbs] done. uploaded=${done} skipped=${skipped} failed=${failed} of ${ids.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
