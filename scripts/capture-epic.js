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
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".trainer-card");
  await page.waitForSelector(".feature-strip", { timeout: 8000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, "epic-menu.png") });
  console.log("✓ epic menu captured");
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
