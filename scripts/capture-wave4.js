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
  const label = `Wave4-${Date.now().toString(36)}`;
  await page.addInitScript((n) => { window.__autoFillName = n; window.prompt = () => n; }, label);

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#how-to-play-btn");
  // How-to-play
  await page.click("#how-to-play-btn");
  await page.waitForSelector(".howto-card");
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, "wave4-howto.png") });
  await page.click(".howto-close");

  // Register + open achievements
  await page.click("#account-register-btn");
  await page.waitForSelector("#account-logout-btn", { timeout: 15000 });
  await page.click("#account-achievements-btn");
  await page.waitForSelector(".ach-card");
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, "wave4-achievements.png") });

  await browser.close();
  console.log("✓ wave4 captures done");
})().catch(e => { console.error(e); process.exit(1); });
