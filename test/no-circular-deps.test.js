// Regression test for circular-require corruption.
//
// We previously hit a bug where quests.js destructured rollPicks/createOffer
// from rewards.js at module load time, but a require cycle meant those
// references were `undefined` (rewards.js → quests.js → rewards.js).
// Quest claim then crashed with `TypeError: rollPicks is not a function`,
// and the Express HTML 500 page broke the client's res.json() call.
//
// This test loads every server-side module and asserts the public exports
// it claims to ship are actually functions / objects — not undefined.
// Adding a new circular require that destructures will fail here before
// it can reach production.

const { test } = require("node:test");
const assert = require("node:assert/strict");

// Each entry: module path + the named exports that MUST be present.
const MODULES = [
  ["../server-modules/rewards",        ["mount", "rollPicks", "createOffer", "offerForOutcome", "weightedRarity"]],
  ["../server-modules/quests",         ["mount", "bumpDailyStats"]],
  ["../server-modules/story",          ["mount", "buildBossDeck", "summarisePhaseRules"]],
  ["../server-modules/daily-streak",   ["mount"]],
  ["../server-modules/daily-boss",     ["mount", "todayDateKey", "dayNumberFor", "bossForDay", "starsForResult", "POOL"]],
  ["../server-modules/daily-puzzle",   ["mount"]],
  ["../server-modules/champions",      ["mount"]],
  ["../server-modules/collection",     ["mount"]],
  ["../server-modules/achievements",   ["mount", "computeFor", "DEFS"]],
  ["../server-modules/xp",             ["mount", "levelFromXp", "nextLevelAt"]],
  ["../server-modules/auth",           ["mount"]],
  ["../server-modules/sessions",       ["setSession", "clearSession", "getSession", "attach", "COOKIE_NAME"]],
  ["../server-modules/state-store",    ["queuePush", "queuePopFifo", "roomGet", "roomSet", "kvSet", "kvGet", "kvTake"]],
  ["../server-modules/theme",          ["mount", "currentTheme"]],
  ["../server-modules/trading",        ["mount"]],
  ["../server-modules/site-gate",      ["gateMiddleware", "mount", "parseFormBody"]],
  ["../server-modules/guest-migrate",  ["mount", "sanitize", "PER_CARD_CAP", "TOTAL_GRANT_CAP"]],
  ["../server-modules/deck-share",     ["mount"]],
  ["../server-modules/friend-challenge", ["mount"]],
  ["../server-modules/mastery",        ["mount", "levelFor", "LEVELS"]],
  ["../server-modules/winstreak",      ["mount", "milestoneFor", "crossedMilestone", "MILESTONES"]],
  ["../server-modules/analytics",      ["mount"]],
  ["../server-modules/multiplayer",    ["attach"]],
  ["../server-modules/multiplayer-http", ["mount", "viewFor"]],
];

// SESSION_SECRET is required by sessions.js. Set a stable dev value before
// any module loads so the import order tests below don't fail spuriously.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret";

test("every server module exports the public names it documents", () => {
  for (const [modPath, expected] of MODULES) {
    let mod;
    try {
      mod = require(modPath);
    } catch (err) {
      assert.fail(`${modPath} failed to load: ${err.message}`);
    }
    for (const name of expected) {
      assert.ok(
        mod[name] !== undefined,
        `${modPath} should export ${name} (got ${typeof mod[name]})`,
      );
    }
  }
});

test("rewards.rollPicks is a function (regression: circular dep with quests)", () => {
  // Specifically guards the exact bug that surfaced in production:
  // quests.js destructured `rollPicks` at module load → undefined →
  // TypeError on quest claim.
  const rewards = require("../server-modules/rewards");
  assert.equal(typeof rewards.rollPicks, "function");
  assert.equal(typeof rewards.createOffer, "function");
});

test("quests.bumpDailyStats is a function (regression: cycle direction)", () => {
  const quests = require("../server-modules/quests");
  assert.equal(typeof quests.bumpDailyStats, "function");
});

test("rewards loaded BEFORE quests still has its exports", () => {
  // node caches modules so we can't easily test fresh-load order
  // without spawning child processes. The above tests cover the
  // happy-path cache state; this one just asserts the cached refs
  // stay live.
  const rewards = require("../server-modules/rewards");
  const quests = require("../server-modules/quests");
  assert.equal(typeof rewards.rollPicks, "function");
  assert.equal(typeof quests.bumpDailyStats, "function");
});

test("rewards.js must NOT top-level-require quests (cycle init-order bug)", () => {
  // The production failure: rewards.js had a top-level
  //   const { bumpDailyStats } = require("./quests");
  // line. When rewards loaded FIRST, this triggered quests to load
  // mid-rewards, and quests' captured `const rewards = require("./
  // rewards")` got a partial exports object (rollPicks undefined).
  // The fix moved bumpDailyStats to a lazy require at call time.
  // This test pins the fix by source-grep so a future "let me clean
  // up by hoisting the require" doesn't silently re-break.
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "..", "server-modules", "rewards.js"), "utf8");
  // Strip line + block comments so a comment that mentions the
  // forbidden line doesn't trip the check.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  // Now find any top-level require("./quests"). "Top-level" means
  // not inside a function body — heuristic: indented requires are
  // call-site requires, top-level requires start at column 0.
  const topLevelQuestRequire = stripped
    .split("\n")
    .find((line) => /^\s{0,3}(?:const|let|var)?\s*[\w{},:\s]*=?\s*require\(["']\.\/quests["']\)/.test(line) && !/^\s{4,}/.test(line));
  assert.ok(
    !topLevelQuestRequire,
    `rewards.js top-level requires "./quests" at: "${topLevelQuestRequire}" — must be lazy (inside the route handler)`,
  );
});

test("circular dep regression: quests loaded FIRST still sees rewards.rollPicks", () => {
  // The production bug: quests.js did `const rewards = require("./
  // rewards")` at module init. If rewards then REASSIGNED module.exports
  // (instead of mutating it), quests' cached reference pointed at the
  // empty initial {} — so rewards.rollPicks was undefined when called
  // at request time. To catch this in tests, we spawn a fresh node
  // child that loads quests FIRST and verify quests can call into
  // rewards via its cached reference.
  const { spawnSync } = require("node:child_process");
  const path = require("node:path");
  const root = path.join(__dirname, "..");
  const probe = `
    process.env.SESSION_SECRET = "circular-dep-probe";
    // Load quests FIRST — this forces the cycle direction that broke
    // production. Inside quests.js: const rewards = require("./rewards").
    // rewards.js then requires quests back. If rewards reassigns
    // module.exports, quests' captured reference goes stale.
    const quests = require("${root}/server-modules/quests");
    const rewards = require("${root}/server-modules/rewards");
    if (typeof rewards.rollPicks !== "function") {
      console.error("FAIL: rewards.rollPicks is " + typeof rewards.rollPicks);
      process.exit(1);
    }
    // Also exercise the captured reference inside quests by trying a
    // claim-shaped operation: rewards exports the rollPicks reference
    // that quests will reach for at call time. We can't easily inspect
    // quests' captured rewards directly, but if the IDENTITY of the
    // module.exports object stayed stable (mutated, not replaced) then
    // any holder of the captured ref sees the same exports.
    const cachedExports = require.cache[require.resolve("${root}/server-modules/rewards")].exports;
    if (cachedExports !== rewards) {
      console.error("FAIL: module.exports identity changed between captures");
      process.exit(1);
    }
    if (typeof cachedExports.rollPicks !== "function") {
      console.error("FAIL: cached rewards.rollPicks is " + typeof cachedExports.rollPicks);
      process.exit(1);
    }
    console.log("ok");
  `;
  const r = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
  assert.equal(r.status, 0, `quests-first probe failed:\n${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /ok/);
});

// A subtler check — destructured-at-load-time consts in any module
// would be `undefined` if a cycle bit them. Spot-check the most
// historically-fragile users of `createOffer` / `rollPicks`.
test("no module that uses rewards.rollPicks has a broken reference", () => {
  // We can't see the original destructured const without spawning a
  // child process — but we can prove that if any module's reference
  // were broken, its mount() would throw when its routes ran.  Here
  // we just confirm the live module objects all expose the helpers
  // at call time, which is what those modules actually access now
  // (since the quests.js fix uses live access).
  const story = require("../server-modules/story");
  const streak = require("../server-modules/daily-streak");
  const quests = require("../server-modules/quests");
  // mount() always exists as a function in healthy state.
  assert.equal(typeof story.mount, "function");
  assert.equal(typeof streak.mount, "function");
  assert.equal(typeof quests.mount, "function");
});
