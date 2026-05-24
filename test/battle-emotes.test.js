// Tests for the battle-emote catalog + the /api/reading/emotes route
// that the client polls at boot.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  BATTLE_EMOTES,
  EMOTE_VOICES,
  listEmotes,
  emotesForEvent,
  emoteEvents,
} = require("../shared/battle-emotes");

// --- Catalog shape ---------------------------------------------------

test("each emote has id, event, text, and voiceKey", () => {
  for (const e of BATTLE_EMOTES) {
    assert.ok(e.id, "emote missing id");
    assert.ok(e.event, `${e.id}: event required`);
    assert.ok(e.text && e.text.length > 0, `${e.id}: text required`);
    assert.ok(e.voiceKey, `${e.id}: voiceKey required`);
    assert.ok(EMOTE_VOICES[e.voiceKey], `${e.id}: voiceKey ${e.voiceKey} not in EMOTE_VOICES map`);
  }
});

test("emote ids are unique", () => {
  const seen = new Set();
  for (const e of BATTLE_EMOTES) {
    assert.ok(!seen.has(e.id), `duplicate emote id ${e.id}`);
    seen.add(e.id);
  }
});

test("each emote text is short (≤30 chars — these are interjections)", () => {
  // Emotes interrupt gameplay; keep them short so they don't drown out
  // the action. Trip this if a future edit pastes a sentence.
  for (const e of BATTLE_EMOTES) {
    assert.ok(e.text.length <= 30, `${e.id}: "${e.text}" is ${e.text.length} chars (>30)`);
  }
});

test("expected battle events are all covered", () => {
  // Pinning the required event coverage so a future refactor doesn't
  // accidentally drop hit / super / ko (the most common).
  const events = new Set(emoteEvents());
  for (const required of ["hit", "super", "weak", "ko", "win", "loss"]) {
    assert.ok(events.has(required), `missing emote variants for event "${required}"`);
  }
});

test("hit (the most-fired event) has multiple variants to avoid repetition", () => {
  // 'hit' fires every time damage lands — needs at least 3 variants
  // so the same clip doesn't repeat back-to-back.
  const hits = emotesForEvent("hit");
  assert.ok(hits.length >= 3, `hit event needs ≥3 variants, got ${hits.length}`);
});

test("listEmotes returns the full catalog (read-only API surface)", () => {
  const list = listEmotes();
  assert.equal(list.length, BATTLE_EMOTES.length);
});

test("emotesForEvent returns only matching events", () => {
  const supers = emotesForEvent("super");
  assert.ok(supers.length > 0);
  for (const s of supers) assert.equal(s.event, "super");
  assert.deepEqual(emotesForEvent("not-a-real-event"), []);
});

// --- Route smoke test ------------------------------------------------

test("/api/reading/emotes returns event → [{id, audioUrl}] map (JSON)", async () => {
  const express = require("express");
  const http = require("http");
  const readingMode = require("../server-modules/reading-mode");
  const app = express();
  readingMode.mount(app);

  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;
  try {
    const res = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/api/reading/emotes" }, (r) => {
        let buf = "";
        r.on("data", (c) => (buf += c));
        r.on("end", () => {
          try { resolve({ status: r.statusCode, json: JSON.parse(buf) }); }
          catch (e) { reject(e); }
        });
      }).on("error", reject);
    });
    assert.equal(res.status, 200);
    assert.ok(res.json?.emotes && typeof res.json.emotes === "object");
    // If the manifest is populated locally (post-TTS-generation),
    // we should see at least one event with at least one entry.
    // If it's not (pre-generation), the response is just an empty {}
    // — also acceptable.
    for (const event of Object.keys(res.json.emotes)) {
      for (const entry of res.json.emotes[event]) {
        assert.ok(entry.id, `entry under "${event}" missing id`);
        assert.ok(entry.audioUrl, `entry "${entry.id}" missing audioUrl`);
      }
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
