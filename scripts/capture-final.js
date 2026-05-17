// Capture a polished mid-game shot with the damage-preview hover visible.

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.argv[2] || "http://localhost:3000";
const OUT = "/tmp/pkmn-screens";
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.addInitScript((n) => { window.__autoFillName = n; window.prompt = () => n; }, `Ash-${Date.now().toString(36)}`);

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#account-register-btn");
  await page.click("#account-register-btn");
  await page.waitForSelector("#account-logout-btn", { timeout: 12000 });
  await page.click(".trainer-card");           // pick first trainer
  await page.click('[data-difficulty="medium"]');
  await page.click("#start-btn");
  try { await page.waitForSelector(".mulligan-confirm", { timeout: 12000 }); await page.click(".mulligan-confirm"); } catch {}
  await page.waitForSelector("#hand .card", { timeout: 15000 });

  // Play 2 cards on turn 1+3. End turns to advance state.
  for (let turn = 0; turn < 4; turn++) {
    const cards = await page.$$(".hand .card:not(.unplayable)");
    if (cards.length > 0) await cards[0].click();
    await page.waitForTimeout(300);
    await page.click("#end-turn-btn");
    await page.waitForFunction(
      () => /Your move/i.test(document.querySelector(".turn-active")?.textContent || ""),
      { timeout: 12000 },
    );
  }

  // Click one of our field cards to select it as an attacker.
  const myField = await page.$$(".player-field .field-slot .card");
  if (myField.length > 0) await myField[0].click();
  await page.waitForTimeout(300);

  // Hover an enemy card to trigger the damage preview.
  const enemyField = await page.$$(".ai-field .field-slot .card");
  if (enemyField.length > 0) {
    await enemyField[0].hover();
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: path.join(OUT, "polished-midgame.png") });
  console.log("✓ wrote polished-midgame.png");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
