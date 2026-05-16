// End-to-end test of the reward loop:
//   1. Register two players
//   2. Have them play a multiplayer match to completion
//      (we accelerate by directly setting trainer HP to 1 via repeated attacks
//      isn't possible without code injection, so we exercise the API path
//      directly: trigger a concede from B, A wins)
//   3. Verify A sees a reward modal with 3 picks and B sees 2 picks
//   4. Verify A clicks one and it shows up in their collection

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const BASE = process.argv[2] || "http://localhost:3000";
const OUT = "/tmp/pkmn-screens";
fs.mkdirSync(OUT, { recursive: true });

async function makePlayer(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
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
  await page.addInitScript((n) => { window.__autoFillName = n; window.prompt = () => n; }, label);
  // suppress the native confirm() for concede
  await page.addInitScript(() => { window.confirm = () => true; });
  const errs = [];
  page.on("pageerror", (e) => errs.push(`[${label}] pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errs.push(`[${label}] console.error: ${m.text()}`); });
  return { ctx, page, errs };
}

async function signupAndPickTrainer(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#account-register-btn");
  await page.click("#account-register-btn");
  await page.waitForSelector("#account-logout-btn", { timeout: 15000 });
  await page.click(".trainer-card");
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const labelA = `Aria-${Date.now().toString(36)}`;
  const labelB = `Boyd-${Date.now().toString(36)}`;
  const A = await makePlayer(browser, labelA);
  const B = await makePlayer(browser, labelB);
  await signupAndPickTrainer(A.page);
  await signupAndPickTrainer(B.page);
  console.log("✓ both players signed in");

  await A.page.click("#mode-mp-match");
  await A.page.waitForSelector(".mm-spinner", { timeout: 5000 });
  await B.page.click("#mode-mp-match");

  await Promise.all([
    A.page.waitForSelector("#hand .card", { timeout: 15000 }),
    B.page.waitForSelector("#hand .card", { timeout: 15000 }),
  ]);
  console.log("✓ match started");

  // B concedes immediately — A should win and get 3 picks, B gets 2 picks
  await B.page.click("#concede-btn");

  // The reward modal should appear on both
  await Promise.all([
    A.page.waitForSelector(".reward-overlay", { timeout: 8000 }),
    B.page.waitForSelector(".reward-overlay", { timeout: 8000 }),
  ]);

  const aPicks = await A.page.$$eval(".reward-pick", (els) => els.length);
  const bPicks = await B.page.$$eval(".reward-pick", (els) => els.length);
  console.log(`✓ A sees ${aPicks} picks (expect 3), B sees ${bPicks} (expect 2)`);
  if (aPicks !== 3 || bPicks !== 2) {
    throw new Error(`Wrong pick counts — A=${aPicks}, B=${bPicks}`);
  }

  await A.page.screenshot({ path: path.join(OUT, "reward-A-winner.png") });
  await B.page.screenshot({ path: path.join(OUT, "reward-B-loser.png") });

  // A claims their first pick
  const beforeCookie = await A.ctx.cookies();
  const cookieHdr = beforeCookie.map((c) => `${c.name}=${c.value}`).join("; ");
  const beforeRes = await fetch(`${BASE}/me/collection`, { headers: { cookie: cookieHdr } });
  const before = await beforeRes.json();
  const beforeTotal = before.total;

  await A.page.click(".reward-pick");
  await A.page.waitForFunction(
    () => /Added to collection/i.test(document.querySelector(".reward-title")?.textContent || ""),
    { timeout: 5000 },
  );
  console.log("✓ A claimed a card");

  // Wait for modal to fade and collection should have grown by 1
  await A.page.waitForTimeout(1300);
  const afterRes = await fetch(`${BASE}/me/collection`, { headers: { cookie: cookieHdr } });
  const after = await afterRes.json();
  if (after.total !== beforeTotal + 1) {
    throw new Error(`Collection didn't grow: was ${beforeTotal}, now ${after.total}`);
  }
  console.log(`✓ A's collection grew from ${beforeTotal} to ${after.total}`);

  const allErrs = [...A.errs, ...B.errs];
  if (allErrs.length) {
    console.error("\nConsole/page errors:");
    for (const e of allErrs) console.error("  " + e);
    process.exit(2);
  }
  console.log("\n✅ reward loop smoke test passed");
  await browser.close();
}

main().catch((err) => { console.error("\n❌ failed:", err.message); process.exit(1); });
