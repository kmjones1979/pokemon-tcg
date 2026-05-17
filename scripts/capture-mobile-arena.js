const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const BASE = process.argv[2] || "https://pokemon-tcg-five-lime.vercel.app";
const OUT = "/tmp/pkmn-screens";
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".trainer-card");
  await page.click(".trainer-card");
  await page.click("#start-btn");
  try { await page.waitForSelector(".mulligan-confirm", { timeout: 12000 }); await page.click(".mulligan-confirm"); } catch {}
  await page.waitForSelector("#hand .card", { timeout: 12000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "mobile-arena-before.png") });
  console.log("✓ mobile arena captured");
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
