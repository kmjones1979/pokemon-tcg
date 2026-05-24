// Tests for tokenizeTextForWordClicks — the pure function that wraps
// each word in a clickable span. Pinned so a future edit can't break:
//   - punctuation preserved in display but stripped from data-word
//   - whitespace stays untouched
//   - hyphens / apostrophes INSIDE a word survive
//   - HTML-special chars in the input escape correctly
//   - data-word is lowercased (consistent TTS input)

import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenizeTextForWordClicks } from "../client/js/word-click-tts.js";

function spanCount(html) {
  return (html.match(/<span class="reading-word"/g) || []).length;
}
function dataWords(html) {
  return [...html.matchAll(/data-word="([^"]+)"/g)].map((m) => m[1]);
}

test("returns empty string for null / undefined / empty input", () => {
  assert.equal(tokenizeTextForWordClicks(null), "");
  assert.equal(tokenizeTextForWordClicks(undefined), "");
  assert.equal(tokenizeTextForWordClicks(""), "");
});

test("wraps every word in a reading-word span", () => {
  const out = tokenizeTextForWordClicks("Pikachu had a special berry");
  assert.equal(spanCount(out), 5);
  assert.deepEqual(dataWords(out), ["pikachu", "had", "a", "special", "berry"]);
});

test("strips trailing punctuation from data-word but keeps it in display", () => {
  const out = tokenizeTextForWordClicks("It was sweet.");
  // Three spans + a period attached to the last word's display.
  assert.equal(spanCount(out), 3);
  assert.deepEqual(dataWords(out), ["it", "was", "sweet"]);
  // Period must still appear in rendered HTML somewhere.
  assert.match(out, /sweet\./, "period stays in rendered output");
});

test("preserves whitespace between words", () => {
  const out = tokenizeTextForWordClicks("hi there");
  // The single space between "hi" and "there" stays as plain text.
  assert.match(out, />hi<\/span> <span/, "single space preserved");
});

test("handles dialogue with curly + straight quotes", () => {
  const out = tokenizeTextForWordClicks(`"My berry!" said Pikachu.`);
  // Words: my, berry, said, pikachu (4 spans).
  assert.equal(spanCount(out), 4);
  const words = dataWords(out);
  assert.ok(words.includes("my"));
  assert.ok(words.includes("berry"));
  assert.ok(words.includes("pikachu"));
});

test("apostrophes inside contractions survive intact", () => {
  const out = tokenizeTextForWordClicks("Don't worry");
  // "Don't" should be one clickable span with data-word="don't"
  assert.equal(spanCount(out), 2);
  assert.deepEqual(dataWords(out), ["don't", "worry"]);
});

test("hyphens inside a hyphenated word are preserved (no split)", () => {
  const out = tokenizeTextForWordClicks("super-strong tail");
  // "super-strong" → one span, not two.
  assert.equal(spanCount(out), 2);
  assert.deepEqual(dataWords(out), ["super-strong", "tail"]);
});

test("data-word is lowercased even when display preserves case", () => {
  const out = tokenizeTextForWordClicks("Squirtle Pikachu");
  assert.deepEqual(dataWords(out), ["squirtle", "pikachu"]);
  // But the display retains the capital S / P.
  assert.match(out, />Squirtle</);
  assert.match(out, />Pikachu</);
});

test("HTML-special characters in the input are escaped (no XSS via story text)", () => {
  // A story author can't sneak in <script> via section text. Belt-
  // and-suspenders even though our content is server-controlled.
  const out = tokenizeTextForWordClicks(`<b>oops</b>`);
  assert.ok(!out.includes("<b>"), "tag must not survive raw");
  assert.match(out, /&lt;b&gt;/, "tag must be HTML-escaped");
});

test("attribute values use HTML-escaped quotes", () => {
  // If someone tries to put a double-quote in the source, the
  // data-word attribute must stay valid.
  const out = tokenizeTextForWordClicks(`"hi" said pikachu`);
  // No raw " inside the attribute value.
  const matches = [...out.matchAll(/data-word="([^"]*)"/g)];
  for (const m of matches) {
    assert.ok(!m[1].includes('"'), `data-word should not contain raw "`);
  }
});

test("pure-punctuation tokens are NOT made clickable", () => {
  // An em-dash by itself shouldn't get a data-word span — there's
  // nothing for TTS to pronounce.
  const out = tokenizeTextForWordClicks("hi — there");
  // 2 word spans (hi, there); the dash sits as plain text.
  assert.equal(spanCount(out), 2);
});

test("longer kid-story sentence tokenises sensibly", () => {
  // Pin behaviour on a real Reading Mode line so a regression in the
  // tokeniser surfaces immediately in a recognisable failure mode.
  const out = tokenizeTextForWordClicks(
    `"I will look in the tall grass. Berries hide!"`,
  );
  const words = dataWords(out);
  // "i", "will", "look", "in", "the", "tall", "grass", "berries", "hide"
  assert.equal(words.length, 9);
  assert.deepEqual(words, ["i", "will", "look", "in", "the", "tall", "grass", "berries", "hide"]);
});
