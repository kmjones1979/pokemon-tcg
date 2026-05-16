// Secondary scraper for https://www.pokemon.com/us/pokedex/{slug}.
// PokeAPI covers everything we currently need, so this module is only
// invoked as a fallback for fields PokeAPI is missing. It's kept separate so
// the main path stays fast and doesn't require chromium.
//
// Be polite: 1 req/sec, exponential backoff on failure, disk cache so re-runs
// are free.

const fs = require("fs");
const path = require("path");

const CACHE_DIR = path.join(__dirname, "cache", "pokemon-com");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

let chromium;
let browser;

async function getBrowser() {
  if (browser) return browser;
  if (!chromium) {
    try {
      ({ chromium } = require("playwright"));
    } catch (err) {
      throw new Error(
        "playwright not installed. Run: yarn add playwright && npx playwright install chromium",
      );
    }
  }
  browser = await chromium.launch({ headless: true });
  return browser;
}

async function close() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

let lastReqAt = 0;
async function polite() {
  const gap = 1000;
  const wait = Math.max(0, lastReqAt + gap - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastReqAt = Date.now();
}

// Scrape the pokedex page for a given slug. Returns the visible text of the
// title element (handy as a sanity check that the page rendered correctly).
async function fetchPokedexPage(slug, { retries = 3 } = {}) {
  const cachePath = path.join(CACHE_DIR, `${slug}.json`);
  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  }

  const url = `https://www.pokemon.com/us/pokedex/${slug}`;
  let attempt = 0;
  while (true) {
    await polite();
    let page;
    try {
      const b = await getBrowser();
      page = await b.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForSelector(".pokedex-pokemon-pagination-title", {
        timeout: 15000,
      });
      const title = await page.$eval(
        ".pokedex-pokemon-pagination-title",
        (el) => el.textContent.trim(),
      );
      const result = { slug, url, title };
      fs.writeFileSync(cachePath, JSON.stringify(result));
      await page.close();
      return result;
    } catch (err) {
      if (page) await page.close().catch(() => {});
      attempt++;
      if (attempt > retries) throw err;
      const backoff = Math.min(30000, 1000 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

module.exports = { fetchPokedexPage, close };
