// Pure combat math. No DOM, no state mutation outside the structures handed in.
// damage = max(1, attackerATK * multiplier − defenderDEF / 2)

import { getMultiplier, describeMultiplier } from "./type-chart.js";

// Defender's "defense stat" used in the formula: round((defense + sp_defense) / 30),
// minimum 0. Pulled out so animations + AI can preview damage.
export function effectiveDefense(card) {
  const d = (card.raw?.defense || 0) + (card.raw?.sp_defense || 0);
  return Math.max(0, Math.round(d / 30));
}

// `ability` may include damageMult and may set `ignoreDefense`. abilityBonus
// is a trainer-ability flat-add (e.g. Pikachu Fan +1).
export function computeDamage(attacker, defender, opts = {}) {
  const { abilityBonus = 0, ability = null } = opts;
  const attackerType = attacker.types?.[0];
  const mult = getMultiplier(attackerType, defender.types || []);
  const base = (attacker.cardAttack || 0) + abilityBonus;
  const abilityMult = ability?.damageMult ?? 1;
  const ignoreDefense =
    ability?.id === "special" &&
    (attackerType === "flying" || attackerType === "ghost");
  const defenseTerm = ignoreDefense ? 0 : effectiveDefense(defender) / 2;
  const raw = base * mult * abilityMult - defenseTerm;
  const damage = mult === 0 ? 0 : Math.max(1, Math.round(raw));
  return {
    damage,
    multiplier: mult,
    verdict: describeMultiplier(mult),
    ignoredDefense: ignoreDefense,
  };
}

// Roll for status effects based on attacker's primary type. Returns the status
// to apply to the defender (or null). Callers pass `rand` so tests are
// deterministic; the in-game caller can pass Math.random.
export function rollStatus(attacker, defender, rand = Math.random) {
  if (!attacker || !defender) return null;
  const type = attacker.types?.[0];
  // Don't re-apply the same status; new statuses overwrite.
  switch (type) {
    case "fire":
      if (rand() < 0.25) return { kind: "burn", turnsLeft: 2 };
      break;
    case "electric":
      if (rand() < 0.25) return { kind: "paralyze", turnsLeft: 1 };
      break;
    case "psychic":
      if (rand() < 0.2) return { kind: "sleep", turnsLeft: 1 };
      break;
  }
  return null;
}

// Per-turn ticks for a defender's status (called at end of attacker's turn).
// Returns { damage, expired, message } describing what should happen.
export function tickStatus(card) {
  if (!card.status) return { damage: 0, expired: false };
  const s = card.status;
  if (s.kind === "burn") {
    s.turnsLeft -= 1;
    if (s.turnsLeft <= 0) {
      delete card.status;
      return { damage: 2, expired: true, message: "Burn fades" };
    }
    return { damage: 2, expired: false, message: `${card.name} is burning` };
  }
  // Paralyze + sleep don't deal damage — they just gate the next attack.
  s.turnsLeft -= 1;
  if (s.turnsLeft <= 0) {
    delete card.status;
    return { damage: 0, expired: true, message: `${s.kind} fades` };
  }
  return { damage: 0, expired: false };
}

// True if the card is "locked" from attacking right now because of a status.
export function isLockedOut(card) {
  if (!card.status) return false;
  return card.status.kind === "paralyze" || card.status.kind === "sleep";
}
