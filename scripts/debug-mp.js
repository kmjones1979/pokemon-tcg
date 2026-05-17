const { chromium } = require("playwright");
const path = "/Users/kevinjones/pokemon-game/pokemon-tcg";
process.chdir(path);
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.addInitScript(() => { window.__autoFillName = "DebugUser"; window.prompt = () => "DebugUser"; });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.log("[browser err]", m.text()); });
  page.on("response", (r) => { if (r.url().includes("/auth") || r.url().includes("/api/mp")) console.log("[resp]", r.status(), r.url()); });
  await page.goto("https://pokemon-tcg-five-lime.vercel.app/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#account-register-btn", { timeout: 8000 });
  console.log("→ click register");
  await page.click("#account-register-btn");
  await page.waitForTimeout(8000);
  console.log("logout btn?", !!(await page.$("#account-logout-btn")));
  await browser.close();
})().catch(e => console.error(e));
