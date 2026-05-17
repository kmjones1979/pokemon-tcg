const { chromium } = require("playwright");
process.chdir("/Users/kevinjones/pokemon-game/pokemon-tcg");
const BASE = "https://pokemon-tcg-five-lime.vercel.app";
const DISPLAY = `Smoke-${Date.now().toString(36)}`;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  console.log("auth id:", authenticatorId);
  const errs = [];
  page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errs.push(`console.error: ${m.text()}`); });
  await page.addInitScript((name) => {
    window.__autoFillName = name;
    window.prompt = () => name;
  }, DISPLAY);
  console.log("→ goto");
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForSelector("#account-register-btn", { timeout: 8000 });
  console.log("→ click register");
  await page.click("#account-register-btn");
  console.log("→ waiting for logout button (12s)...");
  try {
    await page.waitForSelector("#account-logout-btn", { timeout: 12000 });
    console.log("✓ got logout button");
  } catch (e) {
    console.log("✗ timeout. errors:", errs);
    console.log("✗ current modal contents:");
    const modal = await page.$(".auth-modal");
    if (modal) {
      const errEl = await modal.$(".auth-err");
      if (errEl) console.log("  auth-err:", await errEl.textContent());
      const submit = await modal.$(".auth-submit");
      if (submit) console.log("  submit text:", await submit.textContent(), "disabled:", await submit.isDisabled());
    } else {
      console.log("  no .auth-modal in DOM");
    }
  }
  await browser.close();
})().catch(e => console.error(e));
