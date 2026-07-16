// Pure helpers + the card-effect interpreter for the TCG mode.
//
// This module holds NO game state and imports nothing from the engine. The
// interpreter (`applyCardEffect`) mutates state only through the `api` object
// the engine passes in, which keeps the dependency one-directional
// (engine → effects) and makes every effect unit-testable in isolation.

// --- Energy-cost matching -------------------------------------------------

// Tally an array of attached energy cards into { fire: 2, colorless: 1, ... }.
export function energyCounts(attached) {
  const counts = {};
  for (const e of attached) {
    const t = e.energyType || "colorless";
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

// Can `attached` energy pay an attack `cost` (array like ["fire","fire","colorless"])?
// Typed requirements must be met by that exact energy type; "colorless" slots
// may be paid by any leftover energy. Special energy is deferred, so each
// attached card provides exactly one unit of its own type.
export function canPayCost(attached, cost) {
  if (!cost || cost.length === 0) return true;
  const pool = energyCounts(attached);
  let colorlessNeeded = 0;
  for (const req of cost) {
    if (req === "colorless") { colorlessNeeded += 1; continue; }
    if ((pool[req] || 0) <= 0) return false;
    pool[req] -= 1;
  }
  // Colorless can be paid by whatever specific energy is left over.
  const leftover = Object.values(pool).reduce((a, b) => a + b, 0);
  return leftover >= colorlessNeeded;
}

// --- Randomness -----------------------------------------------------------
// Module-level RNG mirrors game.js's use of Math.random: state stays a plain
// serializable object (no function stored on it), and tests can force a
// deterministic sequence via setRng().
let _rng = Math.random;
export function setRng(fn) { _rng = fn || Math.random; }
export function rng() { return _rng(); }
export function flipCoin() { return _rng() < 0.5 ? "heads" : "tails"; }
export function shuffle(arr) {
  // Fisher–Yates using the shared RNG.
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(_rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --- Effect interpreter ---------------------------------------------------
//
// `effect` is a plain descriptor from a card def. `api` is supplied by the
// engine and exposes the mutations an effect may perform. `ctx` carries the
// acting side key and, for attacks, the attacker/defender instances.
//
// Returns a partial result the engine may use, e.g. { bonusDamage } for
// damage-modifying attack effects. Non-damage effects return {}.
export function applyCardEffect(effect, api, ctx = {}) {
  if (!effect) return {};
  switch (effect.type) {
    // ---- damage modifiers (run during attack damage calc) ----
    case "coinFlipBonus": {
      const flip = flipCoin();
      api.log(`${ctx.attackName || "Attack"}: coin flip — ${flip}.`);
      return { bonusDamage: flip === "heads" ? effect.damage : 0, flip };
    }
    case "plusPerEnergy": {
      const counts = energyCounts(ctx.attacker?.attached || []);
      const n = effect.energyType ? (counts[effect.energyType] || 0) : (ctx.attacker?.attached.length || 0);
      const extra = Math.max(0, (n - (effect.ignore || 0))) * effect.per;
      return { bonusDamage: extra };
    }
    case "damagePerBenchOpp": {
      const n = api.benchCount(api.opponentOf(ctx.side));
      return { bonusDamage: n * effect.per };
    }

    // ---- after-damage attack effects ----
    case "recoil":
      api.damageInst(ctx.attacker, effect.amount, "recoil");
      return {};
    case "selfDiscardEnergy":
      api.discardEnergyFromInst(ctx.attacker, effect.amount);
      return {};
    case "healSelf":
      api.healInst(ctx.attacker, effect.amount);
      return {};
    case "switchOpponent":
      api.switchActive(api.opponentOf(ctx.side));
      return {};

    // ---- trainer effects ----
    case "heal":
      api.healChosen(ctx.side, effect.amount);
      return {};
    case "draw":
      api.draw(ctx.side, effect.count);
      return {};
    case "discardHandDraw":
      api.discardHand(ctx.side);
      api.draw(ctx.side, effect.count);
      return {};
    case "search":
      api.searchToHand(ctx.side, effect.filter, effect.count || 1);
      return {};
    case "switchOwn":
      api.switchActive(ctx.side);
      return {};
    case "healAllStadium":
      api.stadiumHealHook(effect);
      return {};

    default:
      api.log(`(unhandled effect: ${effect.type})`);
      return {};
  }
}
