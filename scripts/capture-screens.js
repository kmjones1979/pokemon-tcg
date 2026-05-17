// Drive the game far enough to grab screenshots of the major UI states.
// Outputs /tmp/pkmn-{menu,arena,attack,gameover}.png

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const BASE = process.argv[2] || "http://192.168.4.68:3000";
const OUT = "/tmp/pkmn-screens";
fs.mkdirSync(OUT, { recursive: true });

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (err) => console.error("pageerror:", err.message));

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".trainer-card");
  // Let the holo sheen animation reach a flattering frame.
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "menu.png"), fullPage: false });
  console.log("✓ menu.png");

  await page.click(".trainer-card");
  await page.waitForTimeout(200);
  await page.click("#start-btn");
  try { await page.waitForSelector(".mulligan-confirm", { timeout: 12000 }); await page.click(".mulligan-confirm"); } catch {}

  await page.waitForSelector("#hand .card", { timeout: 15000 });
  // Wait for hand to settle / sprites to load
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, "arena-fresh.png") });
  console.log("✓ arena-fresh.png");

  // Play a card on turn 1.
  const playable = await page.$$(".card:not(.unplayable)");
  if (playable.length > 0) {
    await playable[0].click();
    await page.waitForTimeout(800);
  }
  // End turn → AI plays → back to us.
  await page.click("#end-turn-btn");
  await page.waitForFunction(
    () => /Your move/i.test(document.querySelector(".turn-active")?.textContent || ""),
    { timeout: 15000 },
  );
  await page.waitForTimeout(300);

  // Turn 2: try another card if we can, then click our first attacker and
  // attempt to attack either the enemy card or the trainer face.
  const stillPlayable = await page.$$(".card.type-:not(.unplayable)");
  // Click our field card to "select" it
  const myField = await page.$$(".player-field .field-slot .card");
  if (myField.length > 0) {
    await myField[0].click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, "arena-attacker-selected.png") });
    console.log("✓ arena-attacker-selected.png");

    // Try to click an AI card; if none, click the AI trainer block.
    const enemy = await page.$$(".ai-field .field-slot .card");
    if (enemy.length > 0) {
      await enemy[0].click();
    } else {
      await page.click(".trainer-block.ai");
    }
    // Capture mid-FX
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(OUT, "arena-mid-fx.png") });
    console.log("✓ arena-mid-fx.png");
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, "arena-after-hit.png") });
    console.log("✓ arena-after-hit.png");
  }

  // Done — close.
  await browser.close();
  console.log(`\nSaved to ${OUT}`);
}

main().catch((err) => {
  console.error("failed:", err.message);
  process.exit(1);
});
