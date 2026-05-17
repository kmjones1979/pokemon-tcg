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
  await page.addInitScript((n) => { window.__autoFillName = n; window.prompt = () => n; }, `Wave5-${Date.now().toString(36)}`);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#account-register-btn");
  await page.click("#account-register-btn");
  await page.waitForSelector("#account-logout-btn", { timeout: 15000 });
  await page.click(".trainer-card");
  await page.click("#start-btn");
  try { await page.waitForSelector(".mulligan-confirm", { timeout: 12000 }); await page.click(".mulligan-confirm"); } catch {}
  await page.waitForSelector("#hand .card", { timeout: 12000 });
  await page.waitForTimeout(500);
  // Hover a card to trigger preview
  const firstCard = await page.$(".hand .card");
  if (firstCard) {
    const box = await firstCard.boundingBox();
    await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
  }
  await page.waitForSelector(".card-preview", { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "wave5-cardpreview.png") });
  console.log("✓ card preview captured");
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
