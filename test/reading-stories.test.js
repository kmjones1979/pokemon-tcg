// Content + route tests for Reading Mode (read-along stories for young
// readers). Validates the structural contract every story must honor
// so the UI can render them without per-story special-cases.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  READING_STORIES,
  listStories,
  getStory,
  allSpeakers,
} = require("../shared/reading-stories");

// --- Structural contract ---------------------------------------------

test("at least 3 stories ship in Reading Mode", () => {
  assert.ok(READING_STORIES.length >= 3, `expected ≥3 stories, got ${READING_STORIES.length}`);
});

test("each story has id, title, sections, and required metadata", () => {
  for (const s of READING_STORIES) {
    assert.ok(s.id, "story missing id");
    assert.ok(s.title, `story ${s.id} missing title`);
    assert.ok(Array.isArray(s.sections), `story ${s.id} sections must be an array`);
    assert.ok(s.sections.length >= 3, `story ${s.id} should have ≥3 sections, got ${s.sections.length}`);
    assert.ok(s.summary, `story ${s.id} missing summary`);
    assert.ok(s.readingLevel, `story ${s.id} missing readingLevel`);
    assert.ok(s.estimatedMinutes > 0, `story ${s.id} estimatedMinutes must be positive`);
    assert.ok(s.cover, `story ${s.id} missing cover metadata`);
  }
});

test("each section has id, speaker, text, and audioUrl placeholder", () => {
  for (const s of READING_STORIES) {
    for (const sec of s.sections) {
      assert.ok(sec.id, `${s.id}: section missing id`);
      assert.ok(sec.speaker, `${s.id} ${sec.id}: speaker required`);
      assert.ok(sec.text && sec.text.length > 0, `${s.id} ${sec.id}: text required`);
      // audioUrl is null in slice 5a (no TTS yet) but the field must exist
      // so the UI can branch without a "key in section" check on every render.
      assert.ok("audioUrl" in sec, `${s.id} ${sec.id}: audioUrl key must exist (null is fine)`);
    }
  }
});

test("section ids are unique within a story", () => {
  for (const s of READING_STORIES) {
    const seen = new Set();
    for (const sec of s.sections) {
      assert.ok(!seen.has(sec.id), `${s.id}: duplicate section id ${sec.id}`);
      seen.add(sec.id);
    }
  }
});

test("story ids are unique across the catalog", () => {
  const seen = new Set();
  for (const s of READING_STORIES) {
    assert.ok(!seen.has(s.id), `duplicate story id ${s.id}`);
    seen.add(s.id);
  }
});

// --- Reading-level sanity --------------------------------------------

test("section text is short (K-2 reading: ≤ 250 chars per section)", () => {
  // Reading-level proxy: very long paragraphs are harder for young
  // readers. 250 chars ≈ 50 words, which is the upper bound for
  // K-2 chunks. Trip this if a future edit drifts into long-form.
  for (const s of READING_STORIES) {
    for (const sec of s.sections) {
      assert.ok(
        sec.text.length <= 250,
        `${s.id} ${sec.id}: section is ${sec.text.length} chars (>250) — too long for K-2`,
      );
    }
  }
});

test("no story has a single section longer than the rest of the story combined", () => {
  // Catches accidentally-pasting-a-novel into one section.
  for (const s of READING_STORIES) {
    const lengths = s.sections.map((sec) => sec.text.length);
    const longest = Math.max(...lengths);
    const restTotal = lengths.reduce((a, b) => a + b, 0) - longest;
    assert.ok(longest <= restTotal + 50, `${s.id}: one section dwarfs the rest`);
  }
});

// --- Lookup helpers --------------------------------------------------

test("listStories returns summary objects without section text (privacy of payload size)", () => {
  // The list endpoint should be light: no section text. Saves bandwidth
  // and keeps the response tiny so the picker UI loads fast.
  const list = listStories();
  for (const item of list) {
    assert.ok(item.id);
    assert.ok(item.title);
    assert.ok(typeof item.sectionCount === "number");
    assert.equal(item.sections, undefined, "list view must not include full sections");
  }
});

test("getStory returns full story by id; unknown id returns null", () => {
  const first = READING_STORIES[0];
  const found = getStory(first.id);
  assert.equal(found?.id, first.id);
  assert.ok(found.sections.length > 0);
  assert.equal(getStory("not-a-real-story"), null);
});

test("allSpeakers returns the union of speakers across all stories", () => {
  const speakers = allSpeakers();
  assert.ok(speakers.length > 0);
  // Must include narrator (used as a fallback voice for non-dialog sections).
  assert.ok(speakers.includes("narrator"), `expected 'narrator' in speakers: ${speakers.join(",")}`);
  // Sorted deterministically.
  const sorted = [...speakers].sort();
  assert.deepEqual(speakers, sorted);
});

// --- Route smoke test ------------------------------------------------

test("server-modules/reading-mode mounts /api/reading routes returning JSON", async () => {
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

  async function get(path) {
    return new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path }, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json = null;
          try { json = buf ? JSON.parse(buf) : null; } catch {}
          resolve({ status: res.statusCode, json, headers: res.headers });
        });
      }).on("error", reject);
    });
  }

  try {
    const list = await get("/api/reading/stories");
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.json?.stories));
    assert.ok(list.json.stories.length >= 3);

    const detail = await get("/api/reading/stories/" + list.json.stories[0].id);
    assert.equal(detail.status, 200);
    assert.ok(Array.isArray(detail.json?.story?.sections));

    const missing = await get("/api/reading/stories/nope");
    assert.equal(missing.status, 404);
    assert.ok(missing.json?.error);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
