// Capture screenshots of the polish wave on production:
//  1. signed-in menu with Leaderboard button + turn hint
//  2. leaderboard overlay (after some matches have populated it)
//  3. multi-deck builder with switcher
//  4. arena with attack hint banner + pulsing cards

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.argv[2] || "https://pokemon-tcg-five-lime.vercel.app";
const OUT = "/tmp/pkmn-screens";
fs.mkdirSync(OUT, { recursive: true });

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const label = `Polish-${Date.now().toString(36)}`;
  await page.addInitScript((n) => { window.__autoFillName = n; window.prompt = () => n; }, label);

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#account-register-btn");
  await page.click("#account-register-btn");
  await page.waitForSelector("#account-logout-btn", { timeout: 15000 });
  await page.click(".trainer-card");
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, "polish-menu.png") });

  // Leaderboard
  await page.click("#account-leaderboard-btn");
  await page.waitForSelector(".lb-card", { timeout: 8000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, "polish-leaderboard.png") });
  await page.click(".lb-x");
  await page.waitForTimeout(300);

  // Deck builder with switcher visible
  await page.click("#account-collection-btn");
  await page.waitForSelector(".cb-panel", { timeout: 8000 });
  await page.click(".cb-auto");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "polish-deckbuilder.png") });
  await page.click(".cb-x");

  // Arena turn hint
  await page.click("#start-btn");
  try { await page.waitForSelector(".mulligan-confirm", { timeout: 12000 }); await page.click(".mulligan-confirm"); } catch {}
  await page.waitForSelector("#hand .card", { timeout: 12000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, "polish-arena-turn1.png") });

  // Play a card, end turn, capture the attack-prompt state on turn 2.
  const playable = await page.$$(".hand .card:not(.unplayable)");
  if (playable.length > 0) await playable[0].click();
  await page.waitForTimeout(400);
  await page.click("#end-turn-btn");
  await page.waitForFunction(
    () => /Your move/i.test(document.querySelector(".turn-active")?.textContent || ""),
    { timeout: 12000 },
  );
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "polish-arena-turn2.png") });

  await browser.close();
  console.log(`✓ wrote to ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
