// Shared (server-side) card derivation + deck builder.
//
// Phase 2 only uses this server-side: the deck endpoint sends the resulting
// JSON to the browser. Phase 3 will likely import this from socket handlers
// as well, hence the `shared/` location.
//
// Card stats are derived from the raw Pokémon stats per spec:
//   cardHp     = round(hp / 10)
//   cardAttack = round((attack + sp_attack) / 30)
//   tier from BST → energy cost

const TIERS = [
  { tier: 1, max: 349, cost: 1 },
  { tier: 2, max: 449, cost: 2 },
  { tier: 3, max: 524, cost: 3 },
  { tier: 4, max: 599, cost: 5 },
  { tier: 5, max: Infinity, cost: 7 },
];

function tierFromBst(bst) {
  for (const t of TIERS) if (bst <= t.max) return t;
  return TIERS[TIERS.length - 1];
}

// Player-facing rarity ladder. Every Pokémon classifies into exactly one
// of these — derived from the BST-based tier, plus the is_legendary /
// is_mythical flags. This is the single source of truth for "how rare
// is this card", used by drops, the collection UI, and the reward modal.
const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"];
const RARITY_BY_TIER = {
  1: "common",
  2: "uncommon",
  3: "rare",
  4: "epic",
  5: "legendary",
};

function rarityForCard(card) {
  // Flagged legendaries/mythicals always read as "legendary" regardless of
  // their BST tier — keeps the player-facing ladder honest even when a
  // legendary's BST happens to land in a lower stat bucket.
  if (card?.is_legendary || card?.is_mythical) return "legendary";
  return RARITY_BY_TIER[card?.tier] || "common";
}

function toCard(row) {
  const bst =
    (row.hp || 0) +
    (row.attack || 0) +
    (row.defense || 0) +
    (row.sp_attack || 0) +
    (row.sp_defense || 0) +
    (row.speed || 0);
  const t = tierFromBst(bst);
  const card = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    types: row.types || [],
    sprite_front: row.sprite_front,
    sprite_back: row.sprite_back,
    cry_url: row.cry_url,
    flavor_text: row.flavor_text,
    generation: row.generation,
    is_legendary: !!row.is_legendary,
    is_mythical: !!row.is_mythical,
    abilities: Array.isArray(row.abilities) ? row.abilities : [],
    // raw stats (kept for trainer abilities + Phase 3 server validation)
    raw: {
      hp: row.hp,
      attack: row.attack,
      defense: row.defense,
      sp_attack: row.sp_attack,
      sp_defense: row.sp_defense,
      speed: row.speed,
    },
    bst,
    tier: t.tier,
    energyCost: t.cost,
    cardHp: Math.max(1, Math.round((row.hp || 10) / 10)),
    // Tier 4+ get a slightly steeper Attack scale (/28 instead of /30) to
    // make their high Energy cost feel worth it.
    cardAttack: Math.max(
      1,
      Math.round(
        ((row.attack || 0) + (row.sp_attack || 0)) / (t.tier >= 4 ? 28 : 30),
      ),
    ),
  };
  // Every Pokémon ships with an explicit rarity so the drop / UI layers
  // don't have to recompute it. Driven by BST tier + the legendary flags.
  card.rarity = rarityForCard(card);
  return card;
}

// Seedable RNG (mulberry32). Deterministic when a seed is given — handy for
// tests and reproducible match draws.
function rng(seed) {
  let s =
    seed === undefined
      ? (Math.random() * 2 ** 32) >>> 0
      : hashSeed(String(seed));
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickOne(arr, rand) {
  return arr[Math.floor(rand() * arr.length)];
}

// Target distribution per 30-card Pokémon section.
const DEFAULT_DIST = { 1: 10, 2: 10, 3: 6, 4: 3, 5: 1 };

// Default spell-card count appended to every deck. 10 spells in a
// 40-card deck = ~25% chance per draw, enough disruption to feel
// constantly available without crowding out the Pokémon mix.
const DEFAULT_SPELL_COUNT = 10;

// Build a 40-card deck: 30 Pokémon + 10 spell cards.
//
// Pokémon section:
//   - mix of tiers per `distribution` (default DEFAULT_DIST)
//   - no more than 2 copies of any single Pokémon (by id)
//   - if a tier doesn't have enough variety we fall back to neighbouring tiers
//
// Spell section:
//   - `spellCount` cards drawn from cards with kind === "spell"
//   - sampled with replacement (10 of the same spell is allowed — slice 1
//     only ships Freeze, so a deck during slice 1 is 30 Pokémon + 10 Freeze)
//   - silently no-ops if the pokedex contains no spells (e.g. tests that
//     use a synth dex of Pokémon only)
function buildDeck(pokedex, { seed, distribution = DEFAULT_DIST, spellCount = DEFAULT_SPELL_COUNT } = {}) {
  const rand = rng(seed);

  // Split pokedex into Pokémon (no kind, or kind="pokemon") and spells.
  // The 30-slot Pokémon section must never accidentally include a spell.
  const pokemonPool = pokedex.filter((c) => c.kind !== "spell");
  const spellPool   = pokedex.filter((c) => c.kind === "spell");

  // Bucket by tier — Pokémon only.
  const byTier = new Map();
  for (const c of pokemonPool) {
    if (!byTier.has(c.tier)) byTier.set(c.tier, []);
    byTier.get(c.tier).push(c);
  }

  // Shuffle each bucket (Fisher–Yates).
  for (const bucket of byTier.values()) {
    for (let i = bucket.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [bucket[i], bucket[j]] = [bucket[j], bucket[i]];
    }
  }

  const deck = [];
  const counts = new Map(); // id → count

  function tryPick(tier) {
    const bucket = byTier.get(tier) || [];
    for (let i = 0; i < bucket.length; i++) {
      const card = bucket[i];
      if ((counts.get(card.id) || 0) < 2) {
        counts.set(card.id, (counts.get(card.id) || 0) + 1);
        deck.push(card);
        // rotate bucket so we don't keep returning the same first card
        bucket.push(bucket.splice(i, 1)[0]);
        return true;
      }
    }
    return false;
  }

  for (const tierStr of Object.keys(distribution).sort()) {
    const tier = Number(tierStr);
    const want = distribution[tierStr];
    for (let n = 0; n < want; n++) {
      if (!tryPick(tier)) {
        // fall through to a neighbouring tier if this one is exhausted
        const tried = new Set([tier]);
        let ok = false;
        for (const fallback of [tier - 1, tier + 1, tier - 2, tier + 2, tier + 3, tier - 3]) {
          if (tried.has(fallback)) continue;
          tried.add(fallback);
          if (tryPick(fallback)) {
            ok = true;
            break;
          }
        }
        if (!ok) break;
      }
    }
  }

  // Append the spell section. Sampled with replacement: slice 1 ships
  // only Freeze so all 10 spell slots will be Freeze; once more spells
  // come online they'll spread naturally.
  for (let i = 0; i < spellCount && spellPool.length > 0; i++) {
    const spell = spellPool[Math.floor(rand() * spellPool.length)];
    deck.push(spell);
  }

  return deck;
}

module.exports = {
  toCard, buildDeck, tierFromBst, rng,
  rarityForCard, RARITIES, RARITY_BY_TIER,
  DEFAULT_SPELL_COUNT,
};
