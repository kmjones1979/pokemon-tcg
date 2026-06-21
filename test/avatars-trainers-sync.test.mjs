// Guards against drift between the two trainer rosters:
//   - client/js/game.js   exports TRAINERS (drives the menu grid +
//                         per-match ability logic)
//   - server-modules/avatars.js  exports ROSTER (drives the avatar
//                         picker + /me/avatars API + level-tier unlocks)
//
// Both files have to list the same keys with the same level requirement,
// same display name, and the same Showdown sprite slug — otherwise the
// menu and picker show different worlds and the unlock cadence diverges.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { TRAINERS } = await import("../client/js/game.js");
const { ROSTER }   = require("../server-modules/avatars");

test("client TRAINERS and server ROSTER cover the same keys", () => {
  const clientKeys = new Set(Object.keys(TRAINERS));
  const serverKeys = new Set(ROSTER.map((r) => r.key));
  const onlyClient = [...clientKeys].filter((k) => !serverKeys.has(k));
  const onlyServer = [...serverKeys].filter((k) => !clientKeys.has(k));
  assert.deepEqual(onlyClient, [], `keys only in client TRAINERS: ${onlyClient.join(", ")}`);
  assert.deepEqual(onlyServer, [], `keys only in server ROSTER: ${onlyServer.join(", ")}`);
});

test("level requirements agree across client + server", () => {
  for (const r of ROSTER) {
    const t = TRAINERS[r.key];
    assert.equal(
      t.levelRequired, r.levelRequired,
      `${r.key}: client L${t.levelRequired} vs server L${r.levelRequired}`,
    );
  }
});

test("display names agree across client + server", () => {
  for (const r of ROSTER) {
    assert.equal(TRAINERS[r.key].name, r.name, `${r.key} name mismatch`);
  }
});

test("sprite slugs agree across client + server", () => {
  for (const r of ROSTER) {
    const serverSlug = r.sprite.replace(/^.*\/trainers\//, "").replace(/\.png$/, "");
    assert.equal(
      TRAINERS[r.key].sprite, serverSlug,
      `${r.key} sprite slug mismatch: client="${TRAINERS[r.key].sprite}" vs server="${serverSlug}"`,
    );
  }
});

test("ability bio in server roster matches the gameplay bio in client", () => {
  // The picker shows server `bio`; the menu shows client `bio`. If
  // these drift, a player sees different ability text in the two
  // surfaces and gets surprised mid-battle.
  for (const r of ROSTER) {
    assert.equal(TRAINERS[r.key].bio, r.bio, `${r.key} bio mismatch`);
  }
});

test("L1 tier includes the 6 Gen-1 gym leaders + Red & Leaf", () => {
  const l1 = ROSTER.filter((r) => r.levelRequired === 1).map((r) => r.key).sort();
  assert.deepEqual(
    l1,
    ["brock", "erika", "lance", "leaf", "misty", "pikachu", "red", "sabrina"],
    `L1 set unexpected: ${l1.join(", ")}`,
  );
});
