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
  "freeze",       // slice 1: lock one enemy for 1 turn
  "paralyze",     // slice 2: paralyze one enemy for 1 turn
  "heal",         // slice 2: restore one ally to full HP
  "defender",     // slice 2: +5 max HP + force opponents to target this ally
  "evolve",       // slice 2: +50% max HP and +50% attack on one ally
  "aoe",          // slice 2: deal flat damage to every enemy on field
  "bolt",         // slice 6: direct 5 damage to one enemy (bypass combat math)
  "sleep-powder", // slice 6: sleep one enemy for 2 turns (stronger than freeze)
  "cleanse",      // slice 6: remove all status effects from one ally
  "surge",        // slice 6: gain +2 energy this turn (capped at max)
  "scout",        // slice 6: draw 2 cards from your deck
  "phoenix",      // slice 6: revive most-recently-fainted Pokémon at full HP
  "burn",         // slice 7: apply burn status (2 dmg/turn for 3 turns)
  "shield",       // slice 7: block the next attack on one ally (one-time)
  "mass-heal",    // slice 7: heal every ally by 3 HP
  "power-strike", // slice 7: +3 ATK to one ally's next attack (one-time)
  "counter",      // slice 7: reflect the next attack's damage back to attacker
  "stop-time",    // slice 7: opponent skips their next turn entirely
  "confusion",    // slice 8: confuse status — 50% chance enemy hits itself
  "storm",        // slice 8: 2 dmg to EVERY Pokémon on field (both sides)
  "burst",        // slice 8: 3 direct damage to one enemy (cheap Bolt)
  "brave-strike", // slice 8: ally takes 50% HP loss for a double-damage next attack
  "refresh",      // slice 8: heal every ally by 2 HP (lighter Mass Heal)
  "drain",        // slice 8: 3 damage to enemy + heal lowest-HP ally by same
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
  // --- Slice 6 -------------------------------------------------------
  {
    id: SPELL_BASE_ID + 7,
    kind: "spell",
    name: "Bolt",
    effect: "bolt",
    target: "enemyField",
    types: ["electric"],
    glyph: "⚡",
    power: 4,
    rarity: "rare",
    boltDamage: 5,
    description: "Deal 5 damage directly to one enemy Pokémon.",
    flavor_text: "A spark of pure voltage, aimed.",
  },
  {
    id: SPELL_BASE_ID + 8,
    kind: "spell",
    name: "Sleep Powder",
    effect: "sleep-powder",
    target: "enemyField",
    types: ["grass"],
    glyph: "💤",
    power: 4,
    rarity: "uncommon",
    sleepTurns: 2,
    description: "Put one enemy to sleep for 2 turns — they can't act.",
    flavor_text: "Spores drift down — eyelids close.",
  },
  {
    id: SPELL_BASE_ID + 9,
    kind: "spell",
    name: "Cleanse",
    effect: "cleanse",
    target: "ownField",
    types: ["fairy"],
    glyph: "✨",
    power: 2,
    rarity: "common",
    description: "Remove all status effects from one of your Pokémon.",
    flavor_text: "A soft light. The pain melts away.",
  },
  {
    id: SPELL_BASE_ID + 10,
    kind: "spell",
    name: "Surge",
    effect: "surge",
    target: "none",
    types: ["electric"],
    glyph: "🔋",
    power: 2,
    rarity: "common",
    surgeEnergy: 2,
    description: "Gain +2 Energy this turn (capped at your max).",
    flavor_text: "Power floods the field — for now.",
  },
  {
    id: SPELL_BASE_ID + 11,
    kind: "spell",
    name: "Scout",
    effect: "scout",
    target: "none",
    types: ["normal"],
    glyph: "🎴",
    power: 2,
    rarity: "uncommon",
    drawCount: 2,
    description: "Draw 2 cards from your deck.",
    flavor_text: "A quick peek — perfect timing.",
  },
  {
    id: SPELL_BASE_ID + 12,
    kind: "spell",
    name: "Phoenix",
    effect: "phoenix",
    target: "none",
    types: ["fire"],
    glyph: "🦅",
    power: 8,
    rarity: "legendary",
    description: "Revive your most recently fainted Pokémon at full HP.",
    flavor_text: "From ashes, returning.",
  },
  // --- Slice 7 ------------------------------------------------------
  {
    id: SPELL_BASE_ID + 13,
    kind: "spell",
    name: "Burn",
    effect: "burn",
    target: "enemyField",
    types: ["fire"],
    glyph: "🔥",
    power: 2,
    rarity: "uncommon",
    burnTurns: 3,
    description: "Set one enemy on fire — 2 damage at the end of their next 3 turns.",
    flavor_text: "Ember catches. Flames take hold.",
  },
  {
    id: SPELL_BASE_ID + 14,
    kind: "spell",
    name: "Shield",
    effect: "shield",
    target: "ownField",
    types: ["steel"],
    glyph: "🛡",
    power: 4,
    rarity: "rare",
    description: "Block the next attack on one of your Pokémon (one-time).",
    flavor_text: "An iron wall, raised in a heartbeat.",
  },
  {
    id: SPELL_BASE_ID + 15,
    kind: "spell",
    name: "Mass Heal",
    effect: "mass-heal",
    target: "none",
    types: ["fairy"],
    glyph: "💗",
    power: 6,
    rarity: "rare",
    massHealAmount: 3,
    description: "Restore 3 HP to every one of your Pokémon on the field.",
    flavor_text: "A soft wave washes across the team.",
  },
  {
    id: SPELL_BASE_ID + 16,
    kind: "spell",
    name: "Power Strike",
    effect: "power-strike",
    target: "ownField",
    types: ["fighting"],
    glyph: "⚔",
    power: 2,
    rarity: "common",
    powerStrikeBonus: 3,
    description: "+3 Attack on one ally's next attack (one-time).",
    flavor_text: "All your strength, one perfect strike.",
  },
  {
    id: SPELL_BASE_ID + 17,
    kind: "spell",
    name: "Counter",
    effect: "counter",
    target: "ownField",
    types: ["psychic"],
    glyph: "↩",
    power: 6,
    rarity: "epic",
    description: "Reflect the next attack on one of your Pokémon back at the attacker.",
    flavor_text: "Mirror up. Whatever hits, hits back.",
  },
  {
    id: SPELL_BASE_ID + 18,
    kind: "spell",
    name: "Stop Time",
    effect: "stop-time",
    target: "none",
    types: ["psychic"],
    glyph: "⏸",
    power: 10,
    rarity: "legendary",
    description: "Your opponent's next turn is skipped entirely.",
    flavor_text: "The clock holds its breath.",
  },
  // --- Slice 8 ------------------------------------------------------
  {
    id: SPELL_BASE_ID + 19,
    kind: "spell",
    name: "Confusion",
    effect: "confusion",
    target: "enemyField",
    types: ["psychic"],
    glyph: "🌀",
    power: 4,
    rarity: "rare",
    confuseTurns: 2,
    description: "Confuse one enemy — 50% chance they hit themselves next attack.",
    flavor_text: "Up is down. Left is right. The room spins.",
  },
  {
    id: SPELL_BASE_ID + 20,
    kind: "spell",
    name: "Storm",
    effect: "storm",
    target: "none",
    types: ["water"],
    glyph: "⛈",
    power: 4,
    rarity: "uncommon",
    stormDamage: 2,
    description: "A wild storm — 2 damage to every Pokémon on the field (both sides).",
    flavor_text: "No shelter. No mercy. Just rain and lightning.",
  },
  {
    id: SPELL_BASE_ID + 21,
    kind: "spell",
    name: "Burst",
    effect: "burst",
    target: "enemyField",
    types: ["fire"],
    glyph: "💥",
    power: 2,
    rarity: "common",
    burstDamage: 3,
    description: "Deal 3 direct damage to one enemy (cheap finisher).",
    flavor_text: "A short, sharp blast.",
  },
  {
    id: SPELL_BASE_ID + 22,
    kind: "spell",
    name: "Brave Strike",
    effect: "brave-strike",
    target: "ownField",
    types: ["fighting"],
    glyph: "💢",
    power: 6,
    rarity: "epic",
    braveSelfDamageFrac: 0.5,
    description: "Your ally takes 50% HP damage — but their next attack does DOUBLE damage.",
    flavor_text: "Risk it all. Hit twice as hard.",
  },
  {
    id: SPELL_BASE_ID + 23,
    kind: "spell",
    name: "Refresh",
    effect: "refresh",
    target: "none",
    types: ["grass"],
    glyph: "🌿",
    power: 4,
    rarity: "uncommon",
    refreshAmount: 2,
    description: "A gentle breeze — heal every one of your Pokémon by 2 HP.",
    flavor_text: "New leaves, new strength.",
  },
  {
    id: SPELL_BASE_ID + 24,
    kind: "spell",
    name: "Drain",
    effect: "drain",
    target: "enemyField",
    types: ["dark"],
    glyph: "🦇",
    power: 4,
    rarity: "rare",
    drainDamage: 3,
    description: "Deal 3 damage to one enemy and heal your lowest-HP ally by the same amount.",
    flavor_text: "What's theirs is yours now.",
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
    defenderHpBonus:  spell.defenderHpBonus,
    evolveHpMult:     spell.evolveHpMult,
    evolveAtkMult:    spell.evolveAtkMult,
    aoeDamage:        spell.aoeDamage,
    // Slice 6 params:
    boltDamage:       spell.boltDamage,
    sleepTurns:       spell.sleepTurns,
    surgeEnergy:      spell.surgeEnergy,
    drawCount:        spell.drawCount,
    // Slice 7 params:
    burnTurns:           spell.burnTurns,
    massHealAmount:      spell.massHealAmount,
    powerStrikeBonus:    spell.powerStrikeBonus,
    // Slice 8 params:
    confuseTurns:        spell.confuseTurns,
    stormDamage:         spell.stormDamage,
    burstDamage:         spell.burstDamage,
    braveSelfDamageFrac: spell.braveSelfDamageFrac,
    refreshAmount:       spell.refreshAmount,
    drainDamage:         spell.drainDamage,
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
