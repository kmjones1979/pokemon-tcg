// Generate bespoke illustrator-style artwork for the TCG mode's Trainer and
// Stadium cards with Google's Gemini image model ("Nano Banana"), then host
// them on Supabase Storage — mirroring the Mega video pipeline.
//
// For each card below without art yet:
//   1. Generate an illustration from its prompt (gemini-2.5-flash-image).
//   2. Upload the PNG to the public `tcg-art` bucket.
//   3. Record the public URL in client/js/tcg/tcg-art.js (id → url), which the
//      catalog merges onto the card defs at load/build time.
//
// Idempotent: cards already in tcg-art.js are skipped unless you pass --force.
//
// Usage:
//   node scripts/generate-tcg-art.js                 # generate missing
//   node scripts/generate-tcg-art.js --force         # regenerate all
//   node scripts/generate-tcg-art.js trainer-potion  # just one card id
//
// Env (.env): VEO_API_KEY (Gemini API key), SUPABASE_URL, SUPABASE_SERVICE_KEY.

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const { VEO_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!VEO_API_KEY) { console.error("Missing VEO_API_KEY in .env"); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env"); process.exit(1); }

const GLA = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = process.env.TCG_ART_MODEL || "gemini-2.5-flash-image";
const BUCKET = "tcg-art";
const OUT_JS = path.join(__dirname, "..", "client", "js", "tcg", "tcg-art.js");

const STYLE =
  "Official Pokémon Trading Card Game illustration in the vibrant style of Pokémon TCG illustrators, " +
  "anime watercolor and digital painting, soft dramatic lighting, rich colour, highly detailed, clean composition, " +
  "no text, no typography, no card frame, no borders, no watermark, no logo.";

// The Trainer/Stadium cards to illustrate, with tailored subjects.
const CARDS = [
  { id: "trainer-potion", subject: "A Pokémon Potion healing item: a glossy purple-and-white medicine spray bottle with a nozzle, on a clean surface with a gentle restorative glow, centered." },
  { id: "trainer-super-potion", subject: "A Pokémon Super Potion healing item: a larger glossy orange-and-white medicine spray bottle glowing with restorative energy, centered." },
  { id: "trainer-poke-ball", subject: "A single classic red-and-white Poké Ball resting on dewy grass in warm golden morning sunlight, sparkles in the air." },
  { id: "trainer-great-ball", subject: "A single Great Ball — blue upper half with red stripes and a yellow marking, white lower half and centre button — resting on grass with glowing sparkles." },
  { id: "trainer-energy-search", subject: "A trainer's hand drawing a glowing card from a deck, with fire, water, grass and lightning Pokémon energy symbols floating and shining around it." },
  { id: "trainer-switch", subject: "Two Pokémon swapping places in a dynamic swirl of speed lines and rotating arrows, energetic action composition, a referee whistle." },
  { id: "trainer-research", subject: "A kindly elderly Pokémon Professor scientist in a white lab coat studying research notes and a Pokédex in a laboratory filled with books and Poké Balls." },
  { id: "trainer-hop", subject: "A cheerful energetic young Pokémon trainer boy in a sporty outfit joyfully tossing a Poké Ball, big grin, bright sunny outdoor background." },
  { id: "trainer-stadium-spa", subject: "A serene Pokémon hot-spring healing spa nestled in nature, several happy Pokémon relaxing in glowing warm water, drifting steam and soft light, wide scenic landscape." },
  { id: "trainer-stadium-arena", subject: "A grand roaring Pokémon battle stadium arena at night, bright spotlights, a huge cheering crowd in the stands and a glowing battlefield, epic wide scenic landscape." },
  { id: "trainer-ultra-ball", subject: "A single Ultra Ball — black-and-yellow upper half with an H-shaped yellow mark, white lower half and centre button — resting on a rocky surface with dramatic sparkles." },
  { id: "trainer-full-heal", subject: "A Pokémon Full Heal healing item: a small green-and-white aerosol medicine spray can glowing with soothing restorative light, centered." },
  { id: "trainer-max-potion", subject: "A Pokémon Max Potion healing item: a tall glossy yellow-and-white medicine spray bottle radiating powerful restorative energy, centered." },
  { id: "trainer-cynthia", subject: "A confident Pokémon Champion trainer woman with long pale hair in a black coat, standing heroically, dramatic wind and light, portrait." },
  { id: "trainer-hyper-potion", subject: "A Pokémon Hyper Potion healing item: a large glossy pink-and-white medicine spray bottle radiating a powerful restorative aura, centered." },
  { id: "trainer-pokemon-catcher", subject: "A Pokémon Catcher device: a high-tech handheld gadget with a glowing targeting reticle and a Poké Ball being launched, dynamic action, centered." },
];

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const onlyId = args.find((a) => !a.startsWith("--"));

function readArt() {
  try {
    const src = fs.readFileSync(OUT_JS, "utf8");
    const m = src.match(/export default (\{[\s\S]*\});?\s*$/);
    return m ? JSON.parse(m[1]) : {};
  } catch { return {}; }
}
function writeArt(obj) {
  const body = `// Auto-generated by scripts/generate-tcg-art.js — illustrator-style art for\n// Trainer/Stadium cards, hosted on Supabase. Do not edit by hand.\nexport default ${JSON.stringify(obj, null, 2)};\n`;
  fs.writeFileSync(OUT_JS, body);
}

async function generateImage(subject) {
  const res = await fetch(`${GLA}/models/${MODEL}:generateContent?key=${VEO_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${subject}\n\n${STYLE}` }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`imagegen ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  const part = (body.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData || p.inline_data);
  const data = part?.inlineData?.data || part?.inline_data?.data;
  if (!data) throw new Error(`no image in response: ${JSON.stringify(body).slice(0, 300)}`);
  return Buffer.from(data, "base64");
}

async function ensureBucket() {
  const headers = { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY };
  const get = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${BUCKET}`, { headers });
  if (get.ok) return;
  const create = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
  });
  if (!create.ok) throw new Error(`bucket create ${create.status}: ${(await create.text()).slice(0, 200)}`);
  console.log(`[tcg-art] created public bucket "${BUCKET}"`);
}

async function upload(id, buf) {
  const objectPath = `${id}.png`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY, "Content-Type": "image/png", "x-upsert": "true" },
    body: buf,
  });
  if (!res.ok) throw new Error(`upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;
}

async function main() {
  await ensureBucket();
  const art = readArt();
  const cards = CARDS.filter((c) => (onlyId ? c.id === onlyId : true));
  for (const card of cards) {
    if (art[card.id] && !FORCE) { console.log(`[tcg-art] skip ${card.id} (already generated)`); continue; }
    console.log(`[tcg-art] generating ${card.id}…`);
    try {
      const buf = await generateImage(card.subject);
      const url = await upload(card.id, buf);
      art[card.id] = url;
      writeArt(art); // persist incrementally
      console.log(`  ✓ ${card.id} → ${url}`);
    } catch (err) {
      console.error(`  ✗ ${card.id}: ${err.message}`);
    }
  }
  console.log("[tcg-art] done. Rebuild the client bundle to embed the new URLs.");
}

main().catch((e) => { console.error(e); process.exit(1); });
