const { chromium } = require("playwright");
process.chdir("/Users/kevinjones/pokemon-game/pokemon-tcg");
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const DISPLAY = `Smoke-${Date.now().toString(36)}`;
  await page.addInitScript((name) => {
    window.__autoFillName = name;
    window.prompt = () => name;
  }, DISPLAY);
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.log("[err]", m.text()); });
  await page.goto("https://pokemon-tcg-five-lime.vercel.app/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#account-register-btn");
  console.log("→ click register");
  await page.click("#account-register-btn");
  // Just wait and probe
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(1500);
    const modal = await page.$(".auth-modal");
    const logout = await page.$("#account-logout-btn");
    const submit = await page.$(".auth-submit");
    console.log(`t+${(i+1)*1.5}s: modal=${!!modal} submit=${!!submit} logout=${!!logout}`);
    if (logout) break;
  }
  await browser.close();
})().catch(e => console.error(e));
