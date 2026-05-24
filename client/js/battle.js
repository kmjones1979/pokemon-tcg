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
// is a trainer-ability flat-add (e.g. Pikachu Fan +1). If `rand` rolls a
// crit (10% by default), the result is multiplied by `critMult` (1.5×) and
// `critical: true` is flagged so the UI can play the gold flash.
//
// `themeType` (optional) — current week's themed type. Cards of that type
// get +1 attack while it's their week.
export const CRIT_CHANCE = 0.1;
export const CRIT_MULT = 1.5;

export function computeDamage(attacker, defender, opts = {}) {
  const { abilityBonus = 0, ability = null, rand = null, preview = false, themeType = null, ignoreDefense: forceIgnore = false, critBoost = 0, forceCrit = false } = opts;
  const attackerType = attacker.types?.[0];
  const mult = getMultiplier(attackerType, defender.types || []);
  // Theme-of-the-week bonus: +1 flat ATK if the attacker is the themed type.
  const themeBonus = themeType && attacker.types?.includes(themeType) ? 1 : 0;
  const base = (attacker.cardAttack || 0) + abilityBonus + themeBonus;
  const abilityMult = ability?.damageMult ?? 1;
  const ignoreDefenseFromAbility =
    ability?.id === "special" &&
    (attackerType === "flying" || attackerType === "ghost");
  const ignoreDefense = forceIgnore || ignoreDefenseFromAbility;
  const defenseTerm = ignoreDefense ? 0 : effectiveDefense(defender) / 2;

  // Crit roll. Skip in preview mode so hover-damage stays stable.
  const effectiveCrit = Math.min(0.5, CRIT_CHANCE + (critBoost || 0));
  // forceCrit (from the crit-timing micro-game) overrides the roll. We
  // still gate on mult > 0 so it doesn't crit through 0× immunity.
  const critical = !preview && mult > 0 && (forceCrit || (rand && rand() < effectiveCrit));
  const critFactor = critical ? CRIT_MULT : 1;

  const raw = (base * mult * abilityMult * critFactor) - defenseTerm;
  const damage = mult === 0 ? 0 : Math.max(1, Math.round(raw));
  return {
    damage,
    multiplier: mult,
    verdict: describeMultiplier(mult),
    ignoredDefense: ignoreDefense,
    critical,
    themeBonus,
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
  // Paralyze + sleep + freeze don't deal damage — they just gate the
  // next attack. `freeze` is applied by the Freeze spell card (player
  // chooses the target), unlike paralyze/sleep which roll on contact.
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
  const k = card.status.kind;
  return k === "paralyze" || k === "sleep" || k === "freeze";
}
