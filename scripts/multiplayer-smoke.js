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
  await page.addInitScript((n) => { window.__autoFillName = n; window.prompt = () => n; }, label);
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
  // Vercel cold-starts can push registration past 15s — bump the budget.
  await page.waitForSelector("#account-logout-btn", { timeout: 25000 });
  await page.click(".trainer-card");
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

  // First player is randomized — detect which side is active.
  async function isActive(page) {
    return /your move/i.test(await page.$eval(".turn-active", (el) => el.textContent));
  }
  let first = (await isActive(A.page)) ? A : B;
  let second = first === A ? B : A;
  console.log(`✓ first to move: ${first === A ? "A" : "B"}`);

  await first.page.waitForTimeout(500);
  await first.page.screenshot({ path: path.join(OUT, "mp-A-start.png") });
  await second.page.screenshot({ path: path.join(OUT, "mp-B-start.png") });

  // First player summons.
  const playable = await first.page.$$(".hand .card:not(.unplayable)");
  if (playable.length === 0) throw new Error("first player has no playable card");
  await playable[0].click();
  await first.page.waitForFunction(
    () => document.querySelectorAll(".player-field .field-slot .card").length >= 1,
    { timeout: 5000 },
  );
  console.log("✓ first player summoned a Pokémon");

  await second.page.waitForFunction(
    () => document.querySelectorAll(".ai-field .field-slot .card").length >= 1,
    { timeout: 8000 },
  );
  console.log("✓ second player saw the opposing field update");

  // First ends turn.
  await first.page.click("#end-turn-btn");
  await second.page.waitForFunction(
    () => /Your move/i.test(document.querySelector(".turn-active")?.textContent || ""),
    { timeout: 8000 },
  );
  console.log("✓ turn switched");

  // Second summons.
  const playable2 = await second.page.$$(".hand .card:not(.unplayable)");
  if (playable2.length === 0) throw new Error("second player has no playable card");
  await playable2[0].click();
  await second.page.waitForFunction(
    () => document.querySelectorAll(".player-field .field-slot .card").length >= 1,
    { timeout: 5000 },
  );
  console.log("✓ second player summoned a Pokémon");

  await first.page.waitForFunction(
    () => document.querySelectorAll(".ai-field .field-slot .card").length >= 1,
    { timeout: 8000 },
  );

  await first.page.waitForTimeout(400);
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
