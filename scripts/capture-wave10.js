const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const BASE = process.argv[2] || "https://pokemon-tcg-five-lime.vercel.app";
const OUT = "/tmp/pkmn-screens";
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.addInitScript((n) => { window.__autoFillName = n; window.prompt = () => n; }, `Wave10-${Date.now().toString(36)}`);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.click("#account-register-btn");
  await page.waitForSelector("#account-logout-btn", { timeout: 15000 });
  await page.waitForSelector(".quests-panel", { timeout: 6000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, "wave10-menu-quests.png") });
  console.log("✓ menu with quests + level chip");
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
