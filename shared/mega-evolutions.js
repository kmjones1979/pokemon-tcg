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
    videoPrompt: "Mega Venusaur centered, majestic, the giant flower on its back blooming and pulsing with pink and green light, leaves swaying, subtle breathing, cinematic HD, seamless loop, isolated on a solid pure black background, vertical portrait composition",
  },
  10006: {
    id: 10006, baseId: 6, name: "Mega Charizard X", slug: "charizard-mega-x",
    types: ["fire", "dragon"],
    stats: { hp: 78, attack: 130, defense: 111, sp_attack: 130, sp_defense: 85, speed: 100 },
    posterUrl: ARTWORK(10034),
    videoUrl: null,
    videoPrompt: "Mega Charizard X centered, breathing blue-white flames, wings flexing, embers rising, black dragon scales glinting, powerful idle animation, cinematic HD, seamless loop, isolated on a solid pure black background, vertical portrait composition",
  },
  10009: {
    id: 10009, baseId: 9, name: "Mega Blastoise", slug: "blastoise-mega",
    types: ["water"],
    stats: { hp: 79, attack: 103, defense: 120, sp_attack: 135, sp_defense: 115, speed: 78 },
    posterUrl: ARTWORK(10036),
    videoUrl: null,
    videoPrompt: "Mega Blastoise centered, with its huge central water cannon, water swirling and dripping, cannons rotating slightly, powerful stance, cinematic HD, seamless loop, isolated on a solid pure black background, vertical portrait composition",
  },
  10094: {
    id: 10094, baseId: 94, name: "Mega Gengar", slug: "gengar-mega",
    types: ["ghost", "poison"],
    stats: { hp: 60, attack: 65, defense: 80, sp_attack: 170, sp_defense: 95, speed: 130 },
    posterUrl: ARTWORK(10038),
    videoUrl: null,
    videoPrompt: "Mega Gengar centered, grinning mischievously, purple shadow aura swirling, ghostly wisps and glowing red eyes, floating and pulsing, spooky cinematic HD, seamless loop, isolated on a solid pure black background, vertical portrait composition",
  },
  10065: {
    id: 10065, baseId: 65, name: "Mega Alakazam", slug: "alakazam-mega",
    types: ["psychic"],
    stats: { hp: 55, attack: 50, defense: 65, sp_attack: 175, sp_defense: 95, speed: 150 },
    posterUrl: ARTWORK(10037),
    videoUrl: null,
    videoPrompt: "Mega Alakazam centered, levitating spoons orbiting, glowing psychic energy and warping air around its head, meditative idle animation, cinematic HD, seamless loop, isolated on a solid pure black background, vertical portrait composition",
  },
  10115: {
    id: 10115, baseId: 115, name: "Mega Kangaskhan", slug: "kangaskhan-mega",
    types: ["normal"],
    stats: { hp: 105, attack: 125, defense: 100, sp_attack: 60, sp_defense: 100, speed: 100 },
    posterUrl: ARTWORK(10039),
    videoUrl: null,
    videoPrompt: "Mega Kangaskhan centered with its energetic baby beside it, protective stance, subtle breathing and the baby bouncing, warm powerful idle animation, cinematic HD, seamless loop, isolated on a solid pure black background, vertical portrait composition",
  },
  10127: {
    id: 10127, baseId: 127, name: "Mega Pinsir", slug: "pinsir-mega",
    types: ["bug", "flying"],
    stats: { hp: 65, attack: 155, defense: 120, sp_attack: 65, sp_defense: 90, speed: 105 },
    posterUrl: ARTWORK(10040),
    videoUrl: null,
    videoPrompt: "Mega Pinsir centered, large translucent wings fluttering, giant pincers flexing, fierce idle animation, cinematic HD, seamless loop, isolated on a solid pure black background, vertical portrait composition",
  },
  10130: {
    id: 10130, baseId: 130, name: "Mega Gyarados", slug: "gyarados-mega",
    types: ["water", "dark"],
    stats: { hp: 95, attack: 155, defense: 109, sp_attack: 70, sp_defense: 130, speed: 81 },
    posterUrl: ARTWORK(10041),
    videoUrl: null,
    videoPrompt: "Mega Gyarados centered, serpentine body coiling and rippling, water splashing, menacing dark-blue scales glinting, roaring idle animation, cinematic HD, seamless loop, isolated on a solid pure black background, vertical portrait composition",
  },
  10142: {
    id: 10142, baseId: 142, name: "Mega Aerodactyl", slug: "aerodactyl-mega",
    types: ["rock", "flying"],
    stats: { hp: 80, attack: 135, defense: 85, sp_attack: 70, sp_defense: 95, speed: 150 },
    posterUrl: ARTWORK(10042),
    videoUrl: null,
    videoPrompt: "Mega Aerodactyl centered, rocky spikes and stone shards floating around it, wings beating, hovering menacingly, prehistoric cinematic HD, seamless loop, isolated on a solid pure black background, vertical portrait composition",
  },
  10150: {
    id: 10150, baseId: 150, name: "Mega Mewtwo X", slug: "mewtwo-mega-x",
    types: ["psychic", "fighting"],
    stats: { hp: 106, attack: 190, defense: 100, sp_attack: 154, sp_defense: 100, speed: 130 },
    posterUrl: ARTWORK(10043),
    videoUrl: null,
    videoPrompt: "Mega Mewtwo X centered, muscular and powerful, crackling purple-white psychic aura, glowing eyes, intense idle animation with rippling energy, cinematic HD, seamless loop, isolated on a solid pure black background, vertical portrait composition",
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
