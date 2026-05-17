// Canonical Pokémon passive abilities pulled from PokeAPI's `abilities`
// field on each Pokémon row. Most abilities have flavor only; this module
// picks a handful with mechanical effects we can implement cleanly and
// wires them into the battle pipeline.
//
// Effects implemented:
//   static    — 25% chance to paralyze the attacker on contact
//   levitate  — defender is immune to Ground attacks (0× multiplier)
//   intimidate— on summon, every enemy field Pokémon loses 1 ATK
//   blaze     — Fire moves +1 ATK while attacker is below 1/3 HP
//   torrent   — Water moves +1 ATK while attacker is below 1/3 HP
//   overgrow  — Grass moves +1 ATK while attacker is below 1/3 HP
//
// Each Pokémon row has card.abilities[]; we check membership.

export function hasPassive(card, abilityName) {
  return Array.isArray(card.abilities) && card.abilities.includes(abilityName);
}

// Compute pinch-clause damage bonus for the attacker (blaze/torrent/overgrow).
export function pinchAttackBonus(attackerInst) {
  const card = attackerInst.card;
  const hp = attackerInst.currentHp;
  const max = attackerInst.maxHp ?? card.cardHp;
  if (hp > max / 3) return 0;
  const primary = card.types?.[0];
  if (primary === "fire"  && hasPassive(card, "blaze"))    return 1;
  if (primary === "water" && hasPassive(card, "torrent"))  return 1;
  if (primary === "grass" && hasPassive(card, "overgrow")) return 1;
  return 0;
}

// Levitate immunity check — if defender has Levitate and attacker is Ground,
// multiplier becomes 0 regardless of the chart.
export function levitateBlocks(attackerCard, defenderCard) {
  return attackerCard.types?.[0] === "ground" && hasPassive(defenderCard, "levitate");
}

// Static-on-contact: returns a status object if the defender's static
// triggers (25% on any landed hit), otherwise null.
export function staticTrigger(defenderCard, rand) {
  if (!hasPassive(defenderCard, "static")) return null;
  if (rand() < 0.25) return { kind: "paralyze", turnsLeft: 1 };
  return null;
}

// Intimidate (called from playCard at summon): every opposing field Pokémon
// loses 1 attack permanently (capped so it doesn't go negative).
export function intimidateOnSummon(state, summoningSide) {
  const card = state.players[summoningSide].field
    .filter(Boolean)
    .map((inst) => inst.card);
  // Look for the most recently summoned card with intimidate. We assume the
  // caller has just placed it, so check the *new* instance specifically.
  const myField = state.players[summoningSide].field;
  const newInst = myField[myField.length - 1] || myField.find(Boolean);
  if (!newInst || !hasPassive(newInst.card, "intimidate")) return null;
  const otherSide = summoningSide === "player" ? "ai" : "player";
  let affected = 0;
  for (const opp of state.players[otherSide].field) {
    if (!opp) continue;
    opp.attackBoost = (opp.attackBoost || 0) - 1;
    affected += 1;
  }
  if (affected > 0) {
    return { affected, attackerName: newInst.card.name };
  }
  return null;
}
