// Special abilities derived from a Pokémon's primary type. Each card gets
// (a) a free "Basic" attack and (b) one type-flavored "Special" that costs
// extra energy when used. Specials apply a damage multiplier and may
// guarantee a status effect.
//
// Pure data + helpers; no DOM, no game-state.
//
// Public shape returned by abilitiesFor(card):
//   [
//     { id, name, type, energyCost: 0, damageMult: 1, status: null, desc },
//     { id, name, type, energyCost: 2, damageMult: 1.4, status: "burn", desc },
//   ]

const TYPE_SPECIALS = {
  normal:   { name: "Body Slam",   energyCost: 1, damageMult: 1.4, status: null,     desc: "+40% damage" },
  fire:     { name: "Inferno",     energyCost: 2, damageMult: 1.5, status: "burn",     desc: "+50% dmg, guaranteed Burn" },
  water:    { name: "Hydro Pump",  energyCost: 2, damageMult: 1.5, status: null,       desc: "+50% damage" },
  electric: { name: "Volt Shock",  energyCost: 2, damageMult: 1.4, status: "paralyze", desc: "+40% dmg, guaranteed Paralyze" },
  grass:    { name: "Razor Leaf",  energyCost: 1, damageMult: 1.3, status: null,       desc: "+30% damage, low cost" },
  ice:      { name: "Blizzard",    energyCost: 2, damageMult: 1.4, status: "paralyze", desc: "+40% dmg, may Paralyze" },
  fighting: { name: "Cross Chop",  energyCost: 2, damageMult: 1.7, status: null,       desc: "+70% raw damage" },
  poison:   { name: "Toxic Bite",  energyCost: 1, damageMult: 1.1, status: "burn",     desc: "Light dmg, guaranteed Poison/Burn" },
  ground:   { name: "Earth Power", energyCost: 2, damageMult: 1.5, status: null,       desc: "+50% damage" },
  flying:   { name: "Aerial Ace",  energyCost: 1, damageMult: 1.2, status: null,       desc: "Cheap, +20% dmg, ignores defense" },
  psychic:  { name: "Mind Blast",  energyCost: 2, damageMult: 1.3, status: "sleep",    desc: "+30% dmg, guaranteed Sleep" },
  bug:      { name: "Leech Life",  energyCost: 1, damageMult: 1.1, status: null,       desc: "+10% dmg, heals attacker for half" },
  rock:     { name: "Rock Slide",  energyCost: 2, damageMult: 1.4, status: null,       desc: "+40% damage" },
  ghost:    { name: "Shadow Ball", energyCost: 2, damageMult: 1.4, status: null,       desc: "+40% dmg, ignores defense" },
  dragon:   { name: "Dragon Rage", energyCost: 3, damageMult: 1.9, status: null,       desc: "+90% damage, expensive" },
  dark:     { name: "Crunch",      energyCost: 2, damageMult: 1.5, status: null,       desc: "+50% damage" },
  steel:    { name: "Iron Head",   energyCost: 2, damageMult: 1.4, status: null,       desc: "+40% damage" },
  fairy:    { name: "Moonblast",   energyCost: 2, damageMult: 1.4, status: null,       desc: "+40% damage" },
};

export function basicAbility(card) {
  const type = card.types?.[0] || "normal";
  return {
    id: "basic",
    name: "Strike",
    type,
    energyCost: 0,
    damageMult: 1,
    status: null,
    desc: "Standard attack",
  };
}

export function specialAbility(card) {
  const type = card.types?.[0] || "normal";
  const spec = TYPE_SPECIALS[type] || TYPE_SPECIALS.normal;
  return {
    id: "special",
    type,
    name: spec.name,
    energyCost: spec.energyCost,
    damageMult: spec.damageMult,
    status: spec.status,
    desc: spec.desc,
  };
}

export function abilitiesFor(card) {
  return [basicAbility(card), specialAbility(card)];
}

// Look up an ability by id for a card (used by the battle resolver).
export function abilityById(card, id) {
  if (id === "special") return specialAbility(card);
  return basicAbility(card);
}

// Cheap predicate used by UI: can the actor afford this ability right now?
export function canAfford(player, ability) {
  return player.energy >= (ability.energyCost || 0);
}
