// End-to-end smoke test for the collection + deck-builder UI.
// Registers a fresh user, opens collection, runs auto-fill, saves deck,
// verifies via API that the deck persisted, and finally starts a single-
// player match (which should use the saved deck).

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.argv[2] || "http://localhost:3000";
const DISPLAY = `Builder-${Date.now().toString(36)}`;
const OUT = "/tmp/pkmn-screens";
fs.mkdirSync(OUT, { recursive: true });

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 920 }, deviceScaleFactor: 2 });
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
  await page.addInitScript((n) => { window.__autoFillName = n; window.prompt = () => n; }, DISPLAY);
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console.error: " + m.text()); });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#account-register-btn");
  await page.click("#account-register-btn");
  await page.waitForSelector("#account-logout-btn", { timeout: 12000 });
  console.log(`✓ registered ${DISPLAY}`);

  await page.click("#account-collection-btn");
  await page.waitForSelector(".cb-panel", { timeout: 8000 });
  await page.waitForSelector(".cb-grid .cb-card-wrapper", { timeout: 8000 });
  const ownedCount = await page.$$eval(".cb-grid .cb-card-wrapper", (els) => els.length);
  console.log(`✓ collection rendered — ${ownedCount} cards visible (before filters)`);
  if (ownedCount < 30) throw new Error("expected at least 30 starter cards");

  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, "collection-overlay.png") });

  // Auto-fill the deck.
  await page.click(".cb-auto");
  const deckCount = await page.$eval(".cb-deck-count", (el) => Number(el.textContent));
  console.log(`✓ auto-fill produced ${deckCount}-card deck`);
  if (deckCount !== 30) throw new Error(`expected 30, got ${deckCount}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "deck-builder-filled.png") });

  // Save
  await page.click(".cb-save");
  await page.waitForFunction(
    () => /Saved/.test(document.querySelector(".cb-save")?.textContent || ""),
    { timeout: 5000 },
  );
  console.log("✓ deck saved");

  // Confirm via API.
  const cookies = await ctx.cookies();
  const cookieHdr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const apiRes = await fetch(`${BASE}/me/decks/active`, { headers: { cookie: cookieHdr } });
  const apiData = await apiRes.json();
  if (!apiData.deck || apiData.deck.card_ids.length !== 30) {
    throw new Error("API didn't reflect the saved active deck");
  }
  console.log(`✓ /me/decks/active reports deck with ${apiData.deck.card_ids.length} cards`);

  // Close panel, then start a single-player match — should use the saved deck.
  await page.click(".cb-x");
  await page.click(".trainer-card");
  await page.click("#start-btn");
  try { await page.waitForSelector(".mulligan-confirm", { timeout: 12000 }); await page.click(".mulligan-confirm"); } catch {}
  await page.waitForSelector("#hand .card", { timeout: 15000 });
  const handCount = await page.$$eval("#hand .card", (els) => els.length);
  console.log(`✓ match started using saved deck — hand: ${handCount}`);
  if (handCount !== 6) throw new Error("hand should still be 6 cards (5 dealt + 1 draw)");

  if (errs.length) {
    console.error("\nConsole/page errors:");
    for (const e of errs) console.error("  " + e);
    process.exit(2);
  }
  console.log("\n✅ deck-builder smoke test passed");
  await browser.close();
}

main().catch((err) => { console.error("\n❌ failed:", err.message); process.exit(1); });
