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
const { BATTLE_EMOTES, EMOTE_VOICES } = require("../shared/battle-emotes");
const { CHAPTERS } = require("../shared/story-chapters");

const SECRETS_FILE = path.join(process.env.HOME || "", ".secrets", "pokemon.env");
const MANIFEST_PATH = path.join(__dirname, "..", "shared", "reading-stories-manifest.json");
const BUCKET = "tts-audio";
const ELEVEN_BASE = "https://api.elevenlabs.io/v1";

// Speaker → ElevenLabs voice ID. Restricted to voices that appear in
// the account's /v1/voices listing — library voices outside that list
// require a paid plan, which the project explicitly avoids. Adjust by
// running `curl -s https://api.elevenlabs.io/v1/voices -H "xi-api-key:
// $ELEVENLABS_API_KEY"` and picking from the returned list.
//
// Tuned for kid-friendly + character fit: brighter/younger voices for
// small Pokémon (Pikachu, Caterpie, Jigglypuff), deeper voices for big
// ones (Snorlax, Onix), warmer storyteller for the narrator. When the
// manifest carries a voiceId that no longer matches this map, the
// `--regenerate-voice-mismatch` flag re-creates just those entries.
const SPEAKER_VOICES = {
  narrator:   "JBFqnCBsd6RMkjVDRZzb", // George — warm, captivating storyteller
  pikachu:    "cgSgspJ2msm6clMCkdW9", // Jessica — playful, bright, warm (kid-feel)
  jigglypuff: "FGY2WhTYpPnrIDTdsKH5", // Laura — enthusiast, quirky (high-energy cute)
  clefairy:   "pFZP5JQG7iQjIQuC4Bku", // Lily — velvety actress (sweet, soft)
  squirtle:   "TX3LPaxmHKxFdv7VOQHJ", // Liam — energetic (young male)
  charmander: "TX3LPaxmHKxFdv7VOQHJ", // Liam — energetic, fiery
  bulbasaur:  "bIHbv24MWmeRgasZH58o", // Will — relaxed optimist (gentle plant)
  caterpie:   "FGY2WhTYpPnrIDTdsKH5", // Laura — enthusiast, quirky (small bug)
  pidgey:     "cgSgspJ2msm6clMCkdW9", // Jessica — bright (chirpy bird)
  weedle:     "FGY2WhTYpPnrIDTdsKH5", // Laura — small, quirky
  snorlax:    "pqHfZKP75CvOlQylNhV4", // Bill — wise, mature, balanced (sleepy)
  // Story Mode chapter speakers — boss + Champion characters.
  beedrill:   "SOYHLrjzK2X1ezoPC6cr", // Harry — fierce warrior
  onix:       "nPczCjzI2devNBz1zQrb", // Brian — deep, resonant and comforting (ancient rock)
  mewtwo:     "SAz9YHcvj6GT2YYXdXww", // River — relaxed, neutral (cosmic psychic)
  lance:      "IKne3meq5aSn9XLyUdCD", // Charlie — deep, confident (champion)
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

// Voice-setting presets per content kind:
//   "story" / "chapter-intro" → calm, consistent reading. Higher
//     stability so the voice doesn't bounce around mid-paragraph.
//   "emote" → battle interjections. Lower stability + higher style
//     so they sound EXCITED and varied, like a kid yelling at the
//     screen, not a corporate VO booth.
function voiceSettingsFor(kind) {
  if (kind === "emote") {
    return { stability: 0.25, similarity_boost: 0.70, style: 0.75, use_speaker_boost: true };
  }
  return { stability: 0.6, similarity_boost: 0.75, style: 0.2 };
}

async function elevenLabsTTS(apiKey, voiceId, text, kind = "story") {
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
      voice_settings: voiceSettingsFor(kind),
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
  // `--regenerate-voice-mismatch` re-creates ONLY the entries whose
  // manifest voiceId no longer matches the current SPEAKER_VOICES /
  // EMOTE_VOICES map. Useful when reassigning voices: you change the
  // map, run this flag, and only the affected clips re-generate.
  const voiceMismatch = args.includes("--regenerate-voice-mismatch");
  // `--regenerate-emotes` re-creates every emote clip (forces emote
  // entries through TTS regardless of cache). Used when changing the
  // emote voice_settings to make them sound more excited — voiceId
  // didn't change, just the delivery, which the cache doesn't see.
  const regenerateEmotes = args.includes("--regenerate-emotes");

  // Plan: walk all stories + battle emotes, decide what needs generating.
  // Stories use `<storyId>/<sectionId>` keys; emotes use `emotes/<emoteId>`.
  // The `--force` flag re-runs everything. `--regenerate-voice-mismatch`
  // re-runs only entries whose voiceId in the manifest no longer matches
  // the current code-level voice map (useful after swapping voice IDs).
  const manifest = loadManifest();
  const plan = [];
  let totalChars = 0;
  const shouldRegen = (cached, currentVoiceId) => {
    if (!cached) return true;
    if (force) return true;
    if (voiceMismatch && cached.voiceId !== currentVoiceId) return true;
    return false;
  };
  for (const story of READING_STORIES) {
    for (const sec of story.sections) {
      const key = manifestKey(story.id, sec.id);
      const voiceId = SPEAKER_VOICES[sec.speaker] || SPEAKER_VOICES.narrator;
      if (!shouldRegen(manifest[key], voiceId)) continue;
      plan.push({
        kind: "story",
        storyId: story.id,
        sectionId: sec.id,
        speaker: sec.speaker,
        voiceId,
        text: sec.text,
      });
      totalChars += sec.text.length;
    }
  }
  for (const emote of BATTLE_EMOTES) {
    const key = `emotes/${emote.id}`;
    const voiceId = EMOTE_VOICES[emote.voiceKey] || EMOTE_VOICES.narrator;
    // --regenerate-emotes treats every emote as if its cache is stale,
    // bypassing the voiceId match — captures voice_settings changes
    // (excitement tuning) that the standard cache check can't see.
    if (!regenerateEmotes && !shouldRegen(manifest[key], voiceId)) continue;
    plan.push({
      kind: "emote",
      emoteId: emote.id,
      event: emote.event,
      voiceId,
      text: emote.text,
    });
    totalChars += emote.text.length;
  }
  // Story Mode chapter intros (read-along).
  for (const chapter of CHAPTERS) {
    if (!Array.isArray(chapter.readAlong)) continue;
    for (const sec of chapter.readAlong) {
      const key = `chapter-intro/${chapter.id}/${sec.id}`;
      const voiceId = SPEAKER_VOICES[sec.speaker] || SPEAKER_VOICES.narrator;
      if (!shouldRegen(manifest[key], voiceId)) continue;
      plan.push({
        kind: "chapter-intro",
        chapterId: chapter.id,
        sectionId: sec.id,
        speaker: sec.speaker,
        voiceId,
        text: sec.text,
      });
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
    for (const item of plan.slice(0, 5)) {
      const id = describePlanItem(item).id;
      const label = describePlanItem(item).label;
      console.log(`        ${id} [${label} → ${item.voiceId}] "${item.text.slice(0, 60)}…"`);
    }
    return;
  }

  await ensureBucket(supabaseUrl, serviceKey);

  let done = 0;
  for (const item of plan) {
    const { id, label, objectPath } = describePlanItem(item);
    process.stdout.write(`[tts] ${done + 1}/${plan.length}  ${id} [${label}] … `);
    try {
      const mp3 = await elevenLabsTTS(apiKey, item.voiceId, item.text, item.kind);
      const url = await uploadAt(supabaseUrl, serviceKey, objectPath, mp3);
      manifest[id] = {
        audioUrl: url,
        voiceId: item.voiceId,
        generatedAt: new Date().toISOString(),
      };
      saveManifest(manifest); // checkpoint after each item so a crash doesn't lose progress
      done++;
      console.log(`✓ ${mp3.length} bytes`);
    } catch (err) {
      console.log(`✗ ${err.message}`);
      console.error(`[tts] aborting at ${id}; partial manifest saved`);
      process.exit(1);
    }
  }
  console.log(`[tts] Done. Generated ${done} items. Manifest: ${MANIFEST_PATH}`);
}

// Plan items come in three flavours (story section, emote, chapter-
// intro section). describePlanItem centralises how each renders for
// log lines + which object path to upload to.
function describePlanItem(item) {
  if (item.kind === "story") {
    return {
      id:         `${item.storyId}/${item.sectionId}`,
      label:      item.speaker,
      objectPath: `reading-stories/${item.storyId}/${item.sectionId}.mp3`,
    };
  }
  if (item.kind === "emote") {
    return {
      id:         `emotes/${item.emoteId}`,
      label:      item.event,
      objectPath: `emotes/${item.emoteId}.mp3`,
    };
  }
  if (item.kind === "chapter-intro") {
    return {
      id:         `chapter-intro/${item.chapterId}/${item.sectionId}`,
      label:      item.speaker,
      objectPath: `chapter-intros/${item.chapterId}/${item.sectionId}.mp3`,
    };
  }
  throw new Error(`unknown plan item kind: ${item.kind}`);
}

// Generic uploader — replaces uploadMp3 + uploadEmoteMp3, which were
// nearly identical. Pass the full object path under the bucket.
async function uploadAt(supabaseUrl, serviceKey, objectPath, buf) {
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
    throw new Error(`upload ${objectPath} failed ${res.status}: ${body.slice(0, 200)}`);
  }
  return `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${objectPath}`;
}

main().catch((err) => {
  console.error(`[tts] fatal: ${err.message}`);
  process.exit(1);
});
