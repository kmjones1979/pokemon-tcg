// Story Mode chapter intros are now kid-friendly read-along sections
// instead of dramatic auto-timed lines. These tests pin the structural
// contract so a future edit can't accidentally drop sections, exceed
// K-2 length, or break the audio-manifest hydration.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CHAPTERS, getChapter } = require("../shared/story-chapters");

test("every chapter has a kid-friendly readAlong array (slice 5d contract)", () => {
  for (const c of CHAPTERS) {
    assert.ok(Array.isArray(c.readAlong), `${c.id}: readAlong missing — Story Mode kid-friendliness regressed`);
    assert.ok(c.readAlong.length >= 3, `${c.id}: readAlong should have ≥3 sections, got ${c.readAlong.length}`);
  }
});

test("each chapter readAlong section has id, speaker, text", () => {
  for (const c of CHAPTERS) {
    const seenIds = new Set();
    for (const sec of c.readAlong) {
      assert.ok(sec.id, `${c.id}: section missing id`);
      assert.ok(!seenIds.has(sec.id), `${c.id}: duplicate section id "${sec.id}"`);
      seenIds.add(sec.id);
      assert.ok(sec.speaker, `${c.id} ${sec.id}: speaker required`);
      assert.ok(sec.text && sec.text.length > 0, `${c.id} ${sec.id}: text required`);
    }
  }
});

test("readAlong sections obey the K-2 ≤250 chars cap", () => {
  for (const c of CHAPTERS) {
    for (const sec of c.readAlong) {
      assert.ok(
        sec.text.length <= 250,
        `${c.id} ${sec.id}: section is ${sec.text.length} chars (>250) — too long for K-2`,
      );
    }
  }
});

test("legacy intro_v1 array preserved for backwards compat", () => {
  // If the old client still hits a chapter without readAlong, it should
  // fall back to intro_v1 (the dramatic 4-line array). The server route
  // returns this as `intro` for unchanged behavior.
  for (const c of CHAPTERS) {
    assert.ok(Array.isArray(c.intro_v1), `${c.id}: intro_v1 missing — backwards compat broken`);
    assert.ok(c.intro_v1.length >= 3, `${c.id}: intro_v1 should keep its lines`);
  }
});

test("chapter speakers map to known Pokémon or 'narrator'/'lance' (UI portrait support)", () => {
  // The client's INTRO_SPEAKER_TO_POKEMON_ID needs an entry for each
  // speaker — if a chapter adds a new one, this test catches the
  // missing UI-side mapping before deploy.
  const KNOWN = new Set([
    "narrator", "lance", "mewtwo",
    "pikachu", "squirtle", "bulbasaur", "charmander",
    "caterpie", "pidgey", "weedle",
    "snorlax", "jigglypuff", "clefairy",
    "beedrill", "onix",
  ]);
  for (const c of CHAPTERS) {
    for (const sec of c.readAlong) {
      assert.ok(
        KNOWN.has(sec.speaker),
        `${c.id} ${sec.id}: speaker "${sec.speaker}" not in client's portrait map — add it to INTRO_SPEAKER_TO_POKEMON_ID + SPEAKER_VOICES`,
      );
    }
  }
});

test("getChapter returns the readAlong shape", () => {
  const ch1 = getChapter("ch1_viridian");
  assert.ok(ch1);
  assert.ok(Array.isArray(ch1.readAlong));
  assert.ok(ch1.readAlong[0].speaker);
  assert.ok(ch1.readAlong[0].text);
});

test("/api/story/chapter/:id/intro returns readAlong with audioUrl hydration", async () => {
  // Boot a tiny server with the story route mounted, hit the intro
  // endpoint, confirm the response shape is the new read-along shape.
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret";
  const express = require("express");
  const http = require("http");
  const story = require("../server-modules/story");

  // story.mount expects supabase and getPokedex. We don't actually hit
  // either for the /intro route — it's a pure read of CHAPTERS — so
  // stubs are fine.
  const fakeSupabase = { from: () => ({ select: () => ({}), eq: () => ({}), maybeSingle: () => ({}) }) };
  const app = express();
  story.mount(app, fakeSupabase, () => []);

  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;
  try {
    const res = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/api/story/chapter/ch1_viridian/intro" }, (r) => {
        let buf = "";
        r.on("data", (c) => (buf += c));
        r.on("end", () => {
          try { resolve({ status: r.statusCode, json: JSON.parse(buf) }); }
          catch (e) { reject(e); }
        });
      }).on("error", reject);
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json?.readAlong));
    assert.ok(res.json.readAlong.length >= 3);
    // Each section has audioUrl key (null is fine if manifest is empty
    // in the test env; populated if generate-tts has been run).
    for (const sec of res.json.readAlong) {
      assert.ok("audioUrl" in sec, `intro section ${sec.id} missing audioUrl key`);
    }
    // Backwards-compat: also returns legacy `intro` array.
    assert.ok(Array.isArray(res.json.intro));
  } finally {
    await new Promise((r) => server.close(r));
  }
});
