// Headless smoke test for Phase 2.
// Drives the actual page through several turns and asserts the UI responds.
// Run after the server is up: node scripts/smoke-test.js [base-url]

const { chromium } = require("playwright");

const BASE = process.argv[2] || "http://192.168.4.68:3000";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(`console.error: ${msg.text()}`);
  });

  console.log(`→ goto ${BASE}`);
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 });

  // Wait for the menu to render.
  await page.waitForSelector(".trainer-card", { timeout: 8000 });
  console.log("✓ menu rendered");

  // Pick the first trainer + start.
  await page.click(".trainer-card");
  await page.click("#start-btn");
  console.log("→ starting match");
  // Mulligan: keep starting hand
  await page.waitForSelector(".mulligan-confirm", { timeout: 12000 });
  await page.click(".mulligan-confirm");

  await page.waitForSelector("#hand .card", { timeout: 12000 });
  const handSize = await page.$$eval("#hand .card", (els) => els.length);
  console.log(`✓ hand rendered with ${handSize} cards`);
  if (handSize !== 6) throw new Error(`expected 6 cards in hand, got ${handSize}`);

  // Field should be 5 slots per side.
  const playerSlots = await page.$$eval(".player-field .field-slot", (els) => els.length);
  const aiSlots = await page.$$eval(".ai-field .field-slot", (els) => els.length);
  if (playerSlots !== 5 || aiSlots !== 5)
    throw new Error(`expected 5 slots per side, got player=${playerSlots} ai=${aiSlots}`);
  console.log("✓ field slots correct");

  // Trainer HP bars show 30/30 each.
  const labels = await page.$$eval(".hp-text", (els) => els.map((e) => e.textContent.trim()));
  if (!labels.every((t) => t === "30/30"))
    throw new Error(`HP bars not 30/30: ${labels.join(", ")}`);
  console.log("✓ HP bars 30/30");

  // Play turn 1: try to play the cheapest playable card.
  // Energy is 1, so a tier-1 card should be playable.
  const playable = await page.$$(".card:not(.unplayable)");
  console.log(`→ ${playable.length} playable cards in hand`);
  if (playable.length === 0) throw new Error("no playable cards on turn 1");
  await playable[0].click();
  // Wait for the field to update.
  await page.waitForFunction(
    () => document.querySelectorAll(".player-field .field-slot .card").length >= 1,
    { timeout: 5000 },
  );
  console.log("✓ summoned a Pokémon onto the field");

  // End turn, AI moves, then we get turn 2.
  await page.click("#end-turn-btn");
  // Wait for AI turn to finish (activePlayer text flips back).
  await page.waitForFunction(
    () => /Your move/i.test(document.querySelector(".turn-active")?.textContent || ""),
    { timeout: 15000 },
  );
  console.log("✓ AI took its turn and control returned to player");

  // Check for any JS errors during the run.
  if (consoleErrors.length) {
    console.error("\nConsole/page errors:");
    for (const e of consoleErrors) console.error("  " + e);
    process.exit(2);
  }

  console.log("\n✅ smoke test passed");
  await browser.close();
}

main().catch(async (err) => {
  console.error("\n❌ smoke test failed:", err.message);
  process.exit(1);
});
