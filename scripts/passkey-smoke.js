// End-to-end passkey smoke test using Playwright's virtual authenticator.
// Verifies: register → /auth/me reports user → reload preserves session →
// sign-out clears session → sign-in via passkey works.
//
// Requires: server running, fresh display name (UUID suffix).
//
// Usage: node scripts/passkey-smoke.js [base-url]

const { chromium } = require("playwright");

const BASE = process.argv[2] || "http://192.168.4.68:3000";
const DISPLAY = `Smoke-${Date.now().toString(36)}`;

async function attachVirtualAuthenticator(cdp) {
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return authenticatorId;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  // Important: RP_ID for passkeys must match the navigation origin's hostname.
  // The server defaults RP_ID = req.hostname; we navigate to the same host
  // we serve from, so that's consistent.
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await attachVirtualAuthenticator(cdp);

  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push("console.error: " + m.text());
  });

  // Provide the display name to the auth modal (and the legacy prompt path).
  await page.addInitScript((name) => {
    window.__autoFillName = name;
    window.prompt = () => name;
  }, DISPLAY);

  console.log(`→ goto ${BASE}`);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#account-register-btn", { timeout: 8000 });
  console.log("✓ account panel rendered (signed-out)");

  // Register
  await page.click("#account-register-btn");
  try {
    await page.waitForSelector("#account-logout-btn", { timeout: 12000 });
  } catch (e) {
    console.error("REG TIMEOUT — errors so far:", errs);
    const modal = await page.$(".auth-modal");
    if (modal) {
      const errEl = await modal.$(".auth-err");
      if (errEl) console.error("  auth-err:", await errEl.textContent());
      const submit = await modal.$(".auth-submit");
      if (submit) console.error("  submit text:", await submit.textContent(), "disabled:", await submit.isDisabled());
    } else console.error("  no .auth-modal in DOM");
    throw e;
  }
  console.log(`✓ registered as ${DISPLAY}`);

  // Reload — session cookie should keep us signed in.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#account-logout-btn", { timeout: 8000 });
  const greeting = await page.$eval(".account-id strong", (el) => el.textContent.trim());
  if (greeting !== DISPLAY) throw new Error(`expected ${DISPLAY}, got ${greeting}`);
  console.log("✓ session persists across reload");

  // Sign out
  await page.click("#account-logout-btn");
  await page.waitForSelector("#account-register-btn", { timeout: 4000 });
  console.log("✓ signed out");

  // Sign back in (uses discoverable credential from the virtual authenticator)
  await page.click("#account-signin-btn");
  await page.waitForSelector("#account-logout-btn", { timeout: 12000 });
  console.log("✓ signed in via passkey");

  if (errs.length) {
    console.error("\nUnexpected console/page errors:");
    for (const e of errs) console.error("  " + e);
    process.exit(2);
  }
  console.log("\n✅ passkey smoke test passed");
  await browser.close();
}

main().catch((err) => {
  console.error("\n❌ passkey smoke test failed:", err.message);
  process.exit(1);
});
