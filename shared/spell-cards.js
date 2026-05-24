// Spell cards — non-Pokémon cards that share the deck and trigger a
// one-shot effect when played, then go to discard. Mixed into the same
// deck as Pokémon (no separate trainer-card pile), drop through the
// same rarity-based reward system, and play through engine.playCard()
// just like Pokémon — the engine branches on `card.kind`.
//
// Energy cost is derived from a card's `power` rating (higher power →
// more energy). Rarity is hand-picked per card to fit the difficulty
// drop ladder: medium-difficulty wins can pull common/uncommon/rare
// spells (5 of 6 defined here); hard wins pull epic/legendary (the
// board-wipe AOE).
//
// Effects:
//   freeze   — lock one enemy Pokémon for 1 turn (no attack, no act)
//   paralyze — lock one enemy Pokémon for 1 turn (chained on `paralyze` status)
//   heal     — restore one of your Pokémon to full HP
//   defender — +5 max HP to one of yours AND must-be-attacked-first this match
//   evolve   — +50% Max HP and +50% Attack to one of yours
//   aoe      — deal `aoeDamage` to every enemy on the field
//
// Targeting:
//   target = "enemyField" → caller picks an enemy slot
//   target = "ownField"   → caller picks one of their own slots
//   target = "none"       → no slot pick (AOE)
//
// Costs (ceil(power / 2)):
//   power 2 → 1 energy
//   power 4 → 2 energy
//   power 6 → 3 energy
//   power 8 → 4 energy

const SPELL_BASE_ID = 10000;

// Only effects listed in ACTIVE_EFFECTS are shipped to players (deck +
// drops + catalog). Effects in SPELL_CARDS but NOT in ACTIVE_EFFECTS
// remain "designed but not yet wired" — they live in the spec so the
// next vertical slice has a target, but won't drop until their engine
// + UI integration ships.
const ACTIVE_EFFECTS = new Set([
  "freeze", // slice 1: lock one enemy for 1 turn
  // TODO future slices: paralyze, heal, defender, evolve, aoe
]);

const SPELL_CARDS = [
  {
    id: SPELL_BASE_ID + 1,
    kind: "spell",
    name: "Freeze",
    effect: "freeze",
    target: "enemyField",
    types: ["ice"],
    glyph: "❄",
    power: 2,
    rarity: "uncommon",
    description: "Freeze one enemy Pokémon — it can't act on its next turn.",
    flavor_text: "A glacial seal — nothing thaws in time.",
  },
  {
    id: SPELL_BASE_ID + 2,
    kind: "spell",
    name: "Paralyze",
    effect: "paralyze",
    target: "enemyField",
    types: ["electric"],
    glyph: "⚡",
    power: 2,
    rarity: "uncommon",
    description: "Paralyze one enemy Pokémon — it can't act on its next turn.",
    flavor_text: "Static lock. Muscles refuse the call.",
  },
  {
    id: SPELL_BASE_ID + 3,
    kind: "spell",
    name: "Heal Pulse",
    effect: "heal",
    target: "ownField",
    types: ["grass"],
    glyph: "💚",
    power: 4,
    rarity: "uncommon",
    description: "Restore one of your Pokémon to full HP.",
    flavor_text: "Verdant pulse — wounds close in seconds.",
  },
  {
    id: SPELL_BASE_ID + 4,
    kind: "spell",
    name: "Defender",
    effect: "defender",
    target: "ownField",
    types: ["steel"],
    glyph: "🛡",
    power: 4,
    rarity: "rare",
    defenderHpBonus: 5,
    description: "+5 max HP to one of your Pokémon and force opponents to attack it first.",
    flavor_text: "Steel will, drawn forward.",
  },
  {
    id: SPELL_BASE_ID + 5,
    kind: "spell",
    name: "Evolve",
    effect: "evolve",
    target: "ownField",
    types: ["psychic"],
    glyph: "✨",
    power: 6,
    rarity: "rare",
    evolveHpMult: 1.5,
    evolveAtkMult: 1.5,
    description: "Evolve one of your Pokémon — +50% Max HP and +50% Attack.",
    flavor_text: "A surge of latent power, unsealed.",
  },
  {
    id: SPELL_BASE_ID + 6,
    kind: "spell",
    name: "Quake",
    effect: "aoe",
    target: "none",
    types: ["ground"],
    glyph: "💥",
    power: 8,
    rarity: "epic",
    aoeDamage: 4,
    description: "Deal 4 damage to every enemy Pokémon on the field.",
    flavor_text: "The earth itself answers your call.",
  },
];

const SPELL_EFFECTS = SPELL_CARDS.map((s) => s.effect);

function energyCostFromPower(power) {
  // Cost scales with power so playing a stronger spell costs more.
  // ceil(power/2) keeps each tier of power neatly aligned to a whole
  // energy step (2→1, 4→2, 6→3, 8→4).
  return Math.max(1, Math.ceil(power / 2));
}

function tierFromSpellCost(cost) {
  // Spells use the same tier ladder Pokémon use so the deck-builder's
  // tier-bucketed distribution can mix them in without special cases.
  // Spell cost 1→tier 1, 2→2, 3→3, 4→4. Caps at 5 just in case future
  // spells go higher.
  return Math.max(1, Math.min(5, cost));
}

// Inflate a spell def into the same shape Pokémon cards use — so any
// part of the codebase that consumes `card.tier`, `card.energyCost`,
// `card.rarity`, etc. works without branching on kind. The differences
// (kind, effect, target, glyph, description, flavor_text) ride along.
function spellToCard(spell) {
  const energyCost = energyCostFromPower(spell.power);
  return {
    id: spell.id,
    kind: "spell",
    name: spell.name,
    slug: spell.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    types: spell.types || [],
    sprite_front: spell.sprite_front || null, // CSS frame + glyph for now;
                                              // swap in a PNG later via this
                                              // field without code changes.
    flavor_text: spell.flavor_text,
    description: spell.description,
    is_legendary: false,
    is_mythical: false,
    abilities: [],
    raw: { hp: 0, attack: 0, defense: 0, sp_attack: 0, sp_defense: 0, speed: 0 },
    bst: 0,
    tier: tierFromSpellCost(energyCost),
    energyCost,
    cardHp: 0,        // spells don't sit on the field — they're played + discarded
    cardAttack: 0,
    rarity: spell.rarity,
    // Spell-specific fields:
    effect: spell.effect,
    target: spell.target,
    glyph: spell.glyph,
    power: spell.power,
    // Effect parameters — carried so the engine can resolve without
    // re-importing the catalog.
    defenderHpBonus: spell.defenderHpBonus,
    evolveHpMult: spell.evolveHpMult,
    evolveAtkMult: spell.evolveAtkMult,
    aoeDamage: spell.aoeDamage,
  };
}

// All ACTIVE spell card objects shaped like Pokémon cards. The server
// loader concatenates this onto the pokedex array on boot so drops +
// deck builds see them naturally. Inactive effects (still in
// SPELL_CARDS but not in ACTIVE_EFFECTS) are filtered out so players
// can't draw or pull a card the engine doesn't know how to resolve.
function allSpellCards() {
  return SPELL_CARDS
    .filter((s) => ACTIVE_EFFECTS.has(s.effect))
    .map(spellToCard);
}

function isActiveSpellEffect(effect) {
  return ACTIVE_EFFECTS.has(effect);
}

function isSpellCard(card) {
  return card?.kind === "spell";
}

function spellById(id) {
  const s = SPELL_CARDS.find((x) => x.id === id);
  return s ? spellToCard(s) : null;
}

module.exports = {
  SPELL_CARDS,
  SPELL_EFFECTS,
  SPELL_BASE_ID,
  ACTIVE_EFFECTS,
  spellToCard,
  allSpellCards,
  isSpellCard,
  isActiveSpellEffect,
  spellById,
  energyCostFromPower,
  tierFromSpellCost,
};
