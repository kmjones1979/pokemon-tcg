const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.addInitScript(() => { window.prompt = () => "DebugUser"; });
  page.on("console", (m) => console.log(`[browser:${m.type()}]`, m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  page.on("response", (r) => {
    if (r.url().includes("/auth/")) console.log("[response]", r.status(), r.url());
  });
  await page.goto("https://pokemon-tcg-five-lime.vercel.app/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#account-register-btn", { timeout: 8000 });
  console.log("Clicking register...");
  await page.click("#account-register-btn");
  await page.waitForTimeout(8000);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
