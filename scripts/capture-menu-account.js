// Capture the menu in three states: signed-out, signed-in, and the new
// difficulty selector.

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.argv[2] || "http://localhost:3000";
const OUT = "/tmp/pkmn-screens";
fs.mkdirSync(OUT, { recursive: true });

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", transport: "internal",
      hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  await page.addInitScript(() => { window.prompt = () => "Ash-" + Math.random().toString(36).slice(2, 6); });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".trainer-card");
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "menu-signed-out.png") });

  // Click difficulty + trainer to show the picker state
  await page.click('.diff-card[data-difficulty="medium"]');
  await page.click(".trainer-card");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "menu-with-difficulty.png") });

  // Now sign up
  await page.click("#account-register-btn");
  await page.waitForSelector("#account-logout-btn", { timeout: 12000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "menu-signed-in.png") });

  await browser.close();
  console.log("✓ wrote screenshots to", OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
