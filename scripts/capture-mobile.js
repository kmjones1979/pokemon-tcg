const { chromium, devices } = require("playwright");
const fs = require("fs");
const path = require("path");
const BASE = process.argv[2] || "https://pokemon-tcg-five-lime.vercel.app";
const OUT = "/tmp/pkmn-screens";
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true });
  // iPhone 14 landscape: 844x390 viewport
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
  });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".trainer-card");
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, "mobile-landscape-top.png") });
  // Scroll down to verify we can reach Start
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "mobile-landscape-bottom.png") });

  // Also iPhone portrait (narrower) — test the 2-col grid
  const portraitCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const pp = await portraitCtx.newPage();
  await pp.goto(BASE, { waitUntil: "domcontentloaded" });
  await pp.waitForSelector(".trainer-card");
  await pp.waitForTimeout(600);
  await pp.screenshot({ path: path.join(OUT, "mobile-portrait.png"), fullPage: true });

  await browser.close();
  console.log("✓ mobile captures done");
})().catch(e => { console.error(e); process.exit(1); });
