#!/usr/bin/env node
// TTS generation pipeline for Reading Mode stories.
//
// One-time generation: each section text gets converted to MP3 via the
// ElevenLabs API (using a voice ID per Pokémon speaker), then uploaded
// to Supabase Storage (bucket: `tts-audio`). The resulting public URL
// is recorded in `shared/reading-stories-manifest.json`, which the
// server loads at boot and merges onto the story sections so the
// client receives `audioUrl` populated for each section.
//
// Why this design:
//   - Pay ElevenLabs ONCE per section (paid). Playback is free forever
//     (Supabase Storage is served from CDN).
//   - Skips already-generated sections automatically so adding a new
//     story only generates the new ones.
//   - Dry-run by default: prints what would be generated + estimated
//     cost. Pass `--confirm` to actually fire the paid API.
//
// Usage:
//   node scripts/generate-tts.js                # dry-run
//   node scripts/generate-tts.js --confirm      # generate + upload
//   node scripts/generate-tts.js --confirm --force  # regenerate even if cached
//
// Required env (sourced from ~/.secrets/pokemon.env):
//   ELEVENLABS_API_KEY     ElevenLabs API token
//   SUPABASE_PROJECT_ID    e.g. "bphnyyiwwcetryafgjof"
//   SUPABASE_SERVICE_KEY   service-role key (NOT the anon key — uploads
//                          require service-level access)

const fs = require("node:fs");
const path = require("node:path");
const { READING_STORIES } = require("../shared/reading-stories");

const SECRETS_FILE = path.join(process.env.HOME || "", ".secrets", "pokemon.env");
const MANIFEST_PATH = path.join(__dirname, "..", "shared", "reading-stories-manifest.json");
const BUCKET = "tts-audio";
const ELEVEN_BASE = "https://api.elevenlabs.io/v1";

// Speaker → ElevenLabs voice ID. Restricted to voices that appear in
// the account's /v1/voices listing — library voices outside that list
// require a paid plan, which the project explicitly avoids. Adjust by
// running `curl -s https://api.elevenlabs.io/v1/voices -H "xi-api-key:
// $ELEVENLABS_API_KEY"` and picking from the returned list.
const SPEAKER_VOICES = {
  narrator:   "JBFqnCBsd6RMkjVDRZzb", // George — warm captivating storyteller
  pikachu:    "cgSgspJ2msm6clMCkdW9", // Jessica — playful, bright, warm
  jigglypuff: "hpp4J3VqNfWAUOO0d1Us", // Bella — professional, bright, warm
  clefairy:   "XrExE9yKIg1WjnnlVkGX", // Matilda — knowledgable, professional
  squirtle:   "IKne3meq5aSn9XLyUdCD", // Charlie — deep, confident, energetic
  charmander: "TX3LPaxmHKxFdv7VOQHJ", // Liam — energetic, social media creator
  bulbasaur:  "bIHbv24MWmeRgasZH58o", // Will — relaxed optimist
  caterpie:   "Xb7hH8MSUJpSbSDYk0k2", // Alice — clear, engaging educator
  pidgey:     "N2lVS1w4EtoT3dr4eOWO", // Callum — husky trickster
  weedle:     "Xb7hH8MSUJpSbSDYk0k2", // Alice — small, clear
  snorlax:    "cjVigY5qzO86Huf0OWal", // Eric — smooth, trustworthy (deeper)
};

const ELEVEN_MODEL = "eleven_turbo_v2_5"; // cheapest model that sounds good

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch (err) {
    console.warn("[tts] manifest read failed, starting fresh:", err.message);
    return {};
  }
}

function saveManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

function manifestKey(storyId, sectionId) {
  return `${storyId}/${sectionId}`;
}

async function elevenLabsTTS(apiKey, voiceId, text) {
  const res = await fetch(`${ELEVEN_BASE}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: ELEVEN_MODEL,
      voice_settings: { stability: 0.6, similarity_boost: 0.75, style: 0.2 },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function ensureBucket(supabaseUrl, serviceKey) {
  // Try to GET the bucket. If 404, create it (public-read).
  const headers = { "Authorization": `Bearer ${serviceKey}`, "apikey": serviceKey };
  const getRes = await fetch(`${supabaseUrl}/storage/v1/bucket/${BUCKET}`, { headers });
  if (getRes.ok) return; // already exists
  if (getRes.status !== 404 && getRes.status !== 400) {
    const body = await getRes.text();
    throw new Error(`bucket check failed ${getRes.status}: ${body.slice(0, 200)}`);
  }
  const createRes = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
  });
  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`bucket create failed ${createRes.status}: ${body.slice(0, 200)}`);
  }
  console.log(`[tts] created Supabase Storage bucket "${BUCKET}" (public)`);
}

async function uploadMp3(supabaseUrl, serviceKey, storyId, sectionId, buf) {
  const objectPath = `reading-stories/${storyId}/${sectionId}.mp3`;
  // Use upsert so re-runs overwrite without 409.
  const res = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${serviceKey}`,
      "apikey": serviceKey,
      "Content-Type": "audio/mpeg",
      "x-upsert": "true",
    },
    body: buf,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`upload failed ${res.status}: ${body.slice(0, 200)}`);
  }
  return `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${objectPath}`;
}

async function main() {
  loadDotEnv(SECRETS_FILE);
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const projectId = process.env.SUPABASE_PROJECT_ID;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!apiKey)     throw new Error(`ELEVENLABS_API_KEY missing (looked in ${SECRETS_FILE})`);
  if (!projectId)  throw new Error(`SUPABASE_PROJECT_ID missing (looked in ${SECRETS_FILE})`);
  if (!serviceKey) throw new Error(`SUPABASE_SERVICE_KEY missing (looked in ${SECRETS_FILE})`);
  const supabaseUrl = `https://${projectId}.supabase.co`;

  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const force   = args.includes("--force");

  // Plan: walk all stories, decide what needs generating.
  const manifest = loadManifest();
  const plan = [];
  let totalChars = 0;
  for (const story of READING_STORIES) {
    for (const sec of story.sections) {
      const key = manifestKey(story.id, sec.id);
      const cached = manifest[key];
      if (cached && !force) continue;
      const voiceId = SPEAKER_VOICES[sec.speaker] || SPEAKER_VOICES.narrator;
      plan.push({ storyId: story.id, sectionId: sec.id, speaker: sec.speaker, voiceId, text: sec.text });
      totalChars += sec.text.length;
    }
  }

  console.log(`[tts] Reading Mode TTS generation`);
  console.log(`[tts] Stories: ${READING_STORIES.length}`);
  console.log(`[tts] Plan   : ${plan.length} sections to generate (${force ? "FORCE: regenerating everything" : "cache-skipping existing"})`);
  console.log(`[tts] Chars  : ${totalChars} (~$${(totalChars / 1000 * 0.18).toFixed(3)} on ElevenLabs paid tier, free under 10K/mo)`);
  if (plan.length === 0) {
    console.log(`[tts] Nothing to do — all sections already cached. Run with --force to regenerate.`);
    return;
  }
  if (!confirm) {
    console.log(`[tts] DRY RUN — re-run with --confirm to actually call ElevenLabs + upload to Supabase.`);
    console.log(`[tts] Sample plan items:`);
    for (const item of plan.slice(0, 3)) {
      console.log(`        ${item.storyId}/${item.sectionId} [${item.speaker} → ${item.voiceId}] "${item.text.slice(0, 60)}…"`);
    }
    return;
  }

  await ensureBucket(supabaseUrl, serviceKey);

  let done = 0;
  for (const item of plan) {
    process.stdout.write(`[tts] ${done + 1}/${plan.length}  ${item.storyId}/${item.sectionId} [${item.speaker}] … `);
    try {
      const mp3 = await elevenLabsTTS(apiKey, item.voiceId, item.text);
      const url = await uploadMp3(supabaseUrl, serviceKey, item.storyId, item.sectionId, mp3);
      manifest[manifestKey(item.storyId, item.sectionId)] = { audioUrl: url, voiceId: item.voiceId, generatedAt: new Date().toISOString() };
      saveManifest(manifest); // checkpoint after each section so a crash doesn't lose progress
      done++;
      console.log(`✓ ${mp3.length} bytes`);
    } catch (err) {
      console.log(`✗ ${err.message}`);
      console.error(`[tts] aborting at ${item.storyId}/${item.sectionId}; partial manifest saved`);
      process.exit(1);
    }
  }
  console.log(`[tts] Done. Generated ${done} sections. Manifest: ${MANIFEST_PATH}`);
}

main().catch((err) => {
  console.error(`[tts] fatal: ${err.message}`);
  process.exit(1);
});
