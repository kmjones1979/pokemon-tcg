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
  await page.addInitScript((n) => { window.__autoFillName = n; window.prompt = () => n; }, `Wave8-${Date.now().toString(36)}`);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".trainer-card");
  // Wait for trainer mascot images to load
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(OUT, "wave8-menu-mascots.png") });
  console.log("✓ mascots menu");

  // Register + start a match for items bar
  await page.click("#account-register-btn");
  await page.waitForSelector("#account-logout-btn", { timeout: 15000 });
  await page.click(".trainer-card");
  await page.click("#start-btn");
  try { await page.waitForSelector(".mulligan-confirm", { timeout: 12000 }); await page.click(".mulligan-confirm"); } catch {}
  await page.waitForSelector("#hand .card", { timeout: 12000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "wave8-arena-items.png") });
  console.log("✓ arena with items");
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
