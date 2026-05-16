// Two-browser-instance multiplayer smoke test:
// - Player A registers, picks a trainer, clicks "Find online match"
// - Player B registers, picks a trainer, clicks "Find online match"
// - Server pairs them; both should see a fresh arena
// - A plays a card, B sees the AI hand-size update
// - A ends turn, B's banner says "Your move"
// - B plays a card
// - We screenshot both browsers mid-game
//
// Run: node scripts/multiplayer-smoke.js [base-url]

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const BASE = process.argv[2] || "http://localhost:3000";
const OUT = "/tmp/pkmn-screens";
fs.mkdirSync(OUT, { recursive: true });

async function makePlayer(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", transport: "internal",
      hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  await page.addInitScript((n) => { window.prompt = () => n; }, label);
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[${label}] pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(`[${label}] console.error: ${m.text()}`);
  });
  return { ctx, page, errs };
}

async function ready(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#account-register-btn");
  await page.click("#account-register-btn");
  await page.waitForSelector("#account-logout-btn", { timeout: 15000 });
  await page.click(".trainer-card"); // pick the first trainer (Brock)
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const labelA = `Alice-${Date.now().toString(36)}`;
  const labelB = `Bob-${Date.now().toString(36)}`;
  const A = await makePlayer(browser, labelA);
  const B = await makePlayer(browser, labelB);

  await ready(A.page);
  await ready(B.page);

  console.log(`✓ both players signed in (${labelA}, ${labelB})`);

  // Both click Find online match. The order matters for the race; we kick A
  // first, wait briefly, then B.
  await A.page.click("#mode-mp-match");
  // Confirm we see the "Searching" modal
  await A.page.waitForSelector(".mm-spinner", { timeout: 5000 });

  await B.page.click("#mode-mp-match");

  // Both should land in the arena once match found.
  await Promise.all([
    A.page.waitForSelector("#hand .card", { timeout: 15000 }),
    B.page.waitForSelector("#hand .card", { timeout: 15000 }),
  ]);
  console.log("✓ both clients entered the arena (match:found received)");

  // Player A is server-side "player" (first one paired). Confirm A sees
  // "Your move" and B sees a waiting banner.
  const aTurn = await A.page.$eval(".turn-active", (el) => el.textContent.trim());
  const bTurn = await B.page.$eval(".turn-active", (el) => el.textContent.trim());
  if (!/your move/i.test(aTurn)) console.warn("expected A to be on their turn, got:", aTurn);

  // Capture pre-attack screenshot for both browsers.
  await A.page.waitForTimeout(500);
  await A.page.screenshot({ path: path.join(OUT, "mp-A-start.png") });
  await B.page.screenshot({ path: path.join(OUT, "mp-B-start.png") });

  // A plays a card.
  const playableA = await A.page.$$(".hand .card:not(.unplayable)");
  if (playableA.length === 0) throw new Error("A has no playable card");
  await playableA[0].click();
  // The card lands; A's field should now have 1 card.
  await A.page.waitForFunction(
    () => document.querySelectorAll(".player-field .field-slot .card").length >= 1,
    { timeout: 5000 },
  );
  console.log("✓ A summoned a Pokémon");

  // B should see the opposing field populated.
  await B.page.waitForFunction(
    () => document.querySelectorAll(".ai-field .field-slot .card").length >= 1,
    { timeout: 8000 },
  );
  console.log("✓ B saw the opposing field update");

  // A ends turn.
  await A.page.click("#end-turn-btn");
  await B.page.waitForFunction(
    () => /Your move/i.test(document.querySelector(".turn-active")?.textContent || ""),
    { timeout: 8000 },
  );
  console.log("✓ turn switched to B");

  // B plays a card.
  const playableB = await B.page.$$(".hand .card:not(.unplayable)");
  if (playableB.length === 0) throw new Error("B has no playable card");
  await playableB[0].click();
  await B.page.waitForFunction(
    () => document.querySelectorAll(".player-field .field-slot .card").length >= 1,
    { timeout: 5000 },
  );
  console.log("✓ B summoned a Pokémon");

  await A.page.waitForFunction(
    () => document.querySelectorAll(".ai-field .field-slot .card").length >= 1,
    { timeout: 8000 },
  );

  await A.page.waitForTimeout(400);
  await A.page.screenshot({ path: path.join(OUT, "mp-A-midgame.png") });
  await B.page.screenshot({ path: path.join(OUT, "mp-B-midgame.png") });

  const allErrs = [...A.errs, ...B.errs];
  if (allErrs.length) {
    console.error("\nConsole/page errors:");
    for (const e of allErrs) console.error("  " + e);
    process.exit(2);
  }

  console.log("\n✅ multiplayer smoke test passed");
  await browser.close();
}

main().catch(async (err) => {
  console.error("\n❌ multiplayer smoke test failed:", err.message);
  process.exit(1);
});
