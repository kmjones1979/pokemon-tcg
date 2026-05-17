const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const BASE = process.argv[2] || "https://pokemon-tcg-five-lime.vercel.app";
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
  await page.waitForSelector("#account-logout-btn", { timeout: 15000 });
  await page.click(".trainer-card");
  await page.click("#start-btn");
  try { await page.waitForSelector(".mulligan-confirm", { timeout: 12000 }); await page.click(".mulligan-confirm"); } catch {}
  await page.waitForSelector("#hand .card", { timeout: 12000 });
  // Play a few turns to accumulate energy + a couple of pokemon on the field
  for (let t=0; t<3; t++) {
    const cards = await page.$$(".hand .card:not(.unplayable)");
    if (cards.length) await cards[0].click();
    await page.waitForTimeout(300);
    await page.click("#end-turn-btn");
    await page.waitForFunction(() => /Your move/i.test(document.querySelector(".turn-active")?.textContent || ""), { timeout: 12000 });
  }
  // Click our field card to bring up the ability popover
  const my = await page.$$(".player-field .field-slot .card");
  if (my.length) await my[0].click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, "polish-ability-popover.png") });
  console.log("✓ ability popover screenshot saved");
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
