// Mega Evolutions — a prestige tier above the normal chain.
//
// A stage-2 (final-form) Pokémon can Mega Evolve: own 3 copies, consume 2,
// and receive one Mega card. Megas are FULL, PLAYABLE cards — they live in
// the `pokemon` table as synthetic rows (id = 10000 + baseId) so they flow
// through toCard() / deck-builder / battle engine / collection like any other
// card. What makes them special lives here: canonical boosted stats, a "MEGA"
// identity, and an AI-generated looping HD video that plays in place of the
// static sprite.
//
// Why a code registry (not DB columns): there are only a handful of Megas and
// their video URLs are static once generated, so scripts/generate-mega-videos
// .js writes the URLs straight into MEGA_DEFS below — no schema migration, and
// the mega id → card-row mapping stays greppable in one place.
//
// CommonJS so the Node server can require() it; the browser imports it the
// same way game.js imports evolution-chains.js.

// Copies of the stage-2 you must OWN to Mega Evolve, and how many are consumed.
const MEGA_MIN_COPIES = 3;
const MEGA_CONSUMES = 2;

// Synthetic pokemon-table id offset for Mega rows: 10000 + baseId.
const MEGA_ID_BASE = 10000;
function megaIdFor(baseId) {
  return MEGA_ID_BASE + baseId;
}

// Poster / Veo seed image: PokéAPI official mega artwork on GitHub raw (stable
// host). Shown until the looping video is generated, and used as the
// image-to-video seed by the generation script.
const ARTWORK = (pokeApiMegaId) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${pokeApiMegaId}.png`;

// The starter set (kept small + iconic for a first pass). Stats are the
// canonical Gen-6 Mega base stats; toCard() derives cardHp/cardAttack/energy.
// `videoUrl` is null until generate-mega-videos.js fills it in.
const MEGA_DEFS = {
  10003: {
    id: 10003, baseId: 3, name: "Mega Venusaur", slug: "venusaur-mega",
    types: ["grass", "poison"],
    stats: { hp: 80, attack: 100, defense: 123, sp_attack: 122, sp_defense: 120, speed: 80 },
    posterUrl: ARTWORK(10033),
    videoUrl: null,
    videoPrompt: "Mega Venusaur, majestic, the giant flower on its back blooming and pulsing with pink and green light, leaves swaying, subtle breathing, cinematic HD, seamless loop, dark vignette background",
  },
  10006: {
    id: 10006, baseId: 6, name: "Mega Charizard X", slug: "charizard-mega-x",
    types: ["fire", "dragon"],
    stats: { hp: 78, attack: 130, defense: 111, sp_attack: 130, sp_defense: 85, speed: 100 },
    posterUrl: ARTWORK(10034),
    videoUrl: null,
    videoPrompt: "Mega Charizard X breathing blue-white flames, wings flexing, embers rising, black dragon scales glinting, powerful idle animation, cinematic HD, seamless loop, dark background",
  },
  10009: {
    id: 10009, baseId: 9, name: "Mega Blastoise", slug: "blastoise-mega",
    types: ["water"],
    stats: { hp: 79, attack: 103, defense: 120, sp_attack: 135, sp_defense: 115, speed: 78 },
    posterUrl: ARTWORK(10036),
    videoUrl: null,
    videoPrompt: "Mega Blastoise with its huge central water cannon, water swirling and dripping, cannons rotating slightly, powerful stance, cinematic HD, seamless loop, dark background",
  },
  10094: {
    id: 10094, baseId: 94, name: "Mega Gengar", slug: "gengar-mega",
    types: ["ghost", "poison"],
    stats: { hp: 60, attack: 65, defense: 80, sp_attack: 170, sp_defense: 95, speed: 130 },
    posterUrl: ARTWORK(10038),
    videoUrl: null,
    videoPrompt: "Mega Gengar grinning mischievously, purple shadow aura swirling, ghostly wisps and glowing red eyes, floating and pulsing, spooky cinematic HD, seamless loop, dark background",
  },
};

// Merge in generated video URLs. scripts/generate-mega-videos.js writes them
// to mega-videos.json (id → public URL) so we never hand-edit stats above.
// The file is committed as `{}` so this require always resolves (Node + the
// esbuild client bundle both static-resolve it).
{
  // eslint-disable-next-line global-require
  const generated = require("./mega-videos.json");
  for (const [id, url] of Object.entries(generated)) {
    if (MEGA_DEFS[id] && url) MEGA_DEFS[id].videoUrl = url;
  }
}

// baseId (stage-2 dex id) → mega id. Derived from MEGA_DEFS so there's one
// source of truth.
const MEGA_OF = Object.fromEntries(
  Object.values(MEGA_DEFS).map((m) => [m.baseId, m.id]),
);

function megaForBase(baseId) {
  return MEGA_OF[baseId] || null;
}
function isMegaId(id) {
  return Object.prototype.hasOwnProperty.call(MEGA_DEFS, Number(id));
}
function megaDef(id) {
  return MEGA_DEFS[Number(id)] || null;
}
function allMegaIds() {
  return Object.keys(MEGA_DEFS).map(Number);
}
// Video URL for a mega id (null until generated). Read by card rendering.
function megaVideoUrl(id) {
  return MEGA_DEFS[Number(id)]?.videoUrl || null;
}

module.exports = {
  MEGA_MIN_COPIES,
  MEGA_CONSUMES,
  MEGA_ID_BASE,
  MEGA_DEFS,
  MEGA_OF,
  megaIdFor,
  megaForBase,
  isMegaId,
  megaDef,
  allMegaIds,
  megaVideoUrl,
};
