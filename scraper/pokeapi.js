// PokeAPI client with disk caching + polite throttling.
// Source: https://pokeapi.co/docs/v2 — free, no API key.

const fs = require("fs");
const path = require("path");

const CACHE_DIR = path.join(__dirname, "cache");
const BASE = "https://pokeapi.co/api/v2";

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

let lastReqAt = 0;
const MIN_GAP_MS = 50; // PokeAPI is generous, but stay polite

async function gentle() {
  const now = Date.now();
  const wait = Math.max(0, lastReqAt + MIN_GAP_MS - now);
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastReqAt = Date.now();
}

function cacheKey(url) {
  return url.replace(/[^a-z0-9]+/gi, "_") + ".json";
}

async function fetchJson(url, { retries = 5 } = {}) {
  const cachePath = path.join(CACHE_DIR, cacheKey(url));
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {
      // fall through and re-fetch
    }
  }

  let attempt = 0;
  while (true) {
    await gentle();
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      const data = await res.json();
      fs.writeFileSync(cachePath, JSON.stringify(data));
      return data;
    } catch (err) {
      attempt++;
      if (attempt > retries) throw err;
      const backoff = Math.min(30000, 500 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

// generation_id from species → integer 1-9
// PokeAPI uses URLs like /generation/3/, so we just parse.
function generationFromUrl(url) {
  const m = url.match(/\/generation\/(\d+)\//);
  return m ? parseInt(m[1], 10) : null;
}

// Get the best English flavor text (most-recent version).
function pickFlavor(flavorTextEntries) {
  if (!flavorTextEntries) return null;
  const en = flavorTextEntries.filter((e) => e.language?.name === "en");
  if (!en.length) return null;
  // Prefer entries from sword/shield/scarlet/violet, fall back to any.
  const prefer = ["scarlet", "violet", "sword", "shield", "sun", "moon", "x"];
  for (const v of prefer) {
    const hit = en.find((e) => e.version?.name === v);
    if (hit) return hit.flavor_text.replace(/\s+/g, " ").trim();
  }
  return en[0].flavor_text.replace(/\s+/g, " ").trim();
}

// PokeAPI gives several sprite URLs. We want the high-res official artwork as
// the "front" sprite if available, with a sensible fallback chain.
function pickSpriteFront(p) {
  return (
    p.sprites?.other?.["official-artwork"]?.front_default ||
    p.sprites?.other?.home?.front_default ||
    p.sprites?.front_default ||
    null
  );
}

function pickSpriteBack(p) {
  return (
    p.sprites?.back_default ||
    p.sprites?.other?.showdown?.back_default ||
    null
  );
}

function pickCry(p) {
  return p.cries?.latest || p.cries?.legacy || null;
}

// Pure mapper: combines /pokemon and /pokemon-species JSON into the row we
// store in Supabase. Side-effect free so it can be unit tested.
function mapPokemon(p, s) {
  const stats = {};
  for (const st of p.stats) stats[st.stat.name] = st.base_stat;

  return {
    id: p.id,
    name: (s.names?.find((n) => n.language?.name === "en")?.name) || p.name,
    slug: p.name,
    types: p.types
      .sort((a, b) => a.slot - b.slot)
      .map((t) => t.type.name),
    hp: stats["hp"] ?? 0,
    attack: stats["attack"] ?? 0,
    defense: stats["defense"] ?? 0,
    sp_attack: stats["special-attack"] ?? 0,
    sp_defense: stats["special-defense"] ?? 0,
    speed: stats["speed"] ?? 0,
    height_m: p.height ? p.height / 10 : null, // decimetres → m
    weight_kg: p.weight ? p.weight / 10 : null, // hectograms → kg
    abilities: p.abilities.map((a) => a.ability.name),
    sprite_front: pickSpriteFront(p),
    sprite_back: pickSpriteBack(p),
    cry_url: pickCry(p),
    flavor_text: pickFlavor(s.flavor_text_entries),
    generation: generationFromUrl(s.generation?.url || ""),
    is_legendary: !!s.is_legendary,
    is_mythical: !!s.is_mythical,
  };
}

// Pull the full record we need for one Pokémon (combines /pokemon and /pokemon-species).
async function fetchPokemon(id) {
  const p = await fetchJson(`${BASE}/pokemon/${id}`);
  const s = await fetchJson(`${BASE}/pokemon-species/${id}`);
  return mapPokemon(p, s);
}

module.exports = { fetchPokemon, fetchJson, mapPokemon, pickFlavor, generationFromUrl };
