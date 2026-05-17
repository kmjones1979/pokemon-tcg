// Game state machine. The entire match lives in one plain JS object so it
// trivially serializes for Phase 3 multiplayer.
//
// State shape:
//   {
//     turn: 1,
//     activePlayer: "player" | "ai",
//     phase: "draw" | "main" | "over",
//     winner: null | "player" | "ai",
//     log: [{ id, text, kind }],
//     players: {
//       player: { name, ability, trainerHp, energy, maxEnergy, deck, hand, field, discard },
//       ai:     { ... same shape ... }
//     }
//   }
//
// `field` is a sparse array of length 5 — null = empty slot. Each Pokémon on the
// field carries an `instanceId`, `currentHp`, `summoningSickness` (bool), and an
// optional `status` ({ kind, turnsLeft }).

import { computeDamage, rollStatus, isLockedOut, tickStatus } from "./battle.js";
import { abilityById } from "./abilities.js";
import { defaultKit, useItem as _useItem } from "./items.js";
export const useItem = _useItem;
// _useItem is re-used by the AI item phase below.

export const FIELD_SIZE = 5;
export const STARTING_HAND = 5;
export const TRAINER_START_HP = 30;
export const MAX_ENERGY = 10;

let _instanceCounter = 0;
const nextInstanceId = () => `i${++_instanceCounter}`;

// Six canonical Kanto-era human trainers (gym leaders + champion). Each is
// flavored to a Pokémon type and grants a passive ability for that type.
// The internal id ("pikachu" → renamed display to "Lt. Surge") is preserved
// so users who already picked that ability don't break.
//
// Portraits come from Pokémon Showdown's open trainer sprite collection
// (https://play.pokemonshowdown.com/sprites/trainers). Used under fair-use
// for this non-commercial fan project.
export const TRAINERS = {
  brock:   { id: "brock",   name: "Brock",     bio: "+1 Defense to Rock/Ground",        portrait: "rock",     sprite: "brock" },
  misty:   { id: "misty",   name: "Misty",     bio: "Water cards cost 1 less (min 1)",  portrait: "water",    sprite: "misty" },
  pikachu: { id: "pikachu", name: "Lt. Surge", bio: "+1 Attack to Electric Pokémon",    portrait: "electric", sprite: "ltsurge" },
  erika:   { id: "erika",   name: "Erika",     bio: "+1 HP to all Grass Pokémon",       portrait: "grass",    sprite: "erika" },
  sabrina: { id: "sabrina", name: "Sabrina",   bio: "Psychic specials cost 1 less",     portrait: "psychic",  sprite: "sabrina" },
  lance:   { id: "lance",   name: "Lance",     bio: "+1 Attack to Dragon Pokémon",      portrait: "dragon",   sprite: "lance" },
};

// Pokémon Showdown CDN — humans, transparent PNG, ~96×96.
export function trainerSpriteUrl(trainer) {
  const slug = TRAINERS[trainer]?.sprite;
  if (!slug) return null;
  return `https://play.pokemonshowdown.com/sprites/trainers/${slug}.png`;
}

// Backwards-compat alias (older import sites used trainerMascotUrl).
export const trainerMascotUrl = trainerSpriteUrl;

function shuffle(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function instantiate(card, playerState) {
  const { hpBonus } = playerState ? abilityModifiers(playerState, card) : { hpBonus: 0 };
  const cardHp = (card.cardHp || 1) + hpBonus;
  return {
    instanceId: nextInstanceId(),
    card,
    currentHp: cardHp,
    maxHp: cardHp,
    summoningSickness: !hasQuickTrait(card),
    status: null,
  };
}

// Phase 2 spec mentions "Pokémon with the Quick trait can attack the turn
// they're played." We don't have data for that in PokeAPI per-card, so for now
// pure-Flying types act as the "Quick" set — fluffy + thematic. Easy to change.
function hasQuickTrait(card) {
  return Array.isArray(card.types) && card.types[0] === "flying" && !card.is_legendary;
}

function emptySlot(field) {
  for (let i = 0; i < field.length; i++) if (field[i] == null) return i;
  return -1;
}

// Trainer ability effects applied at lookup time (no state mutation needed).
function abilityModifiers(playerState, card) {
  const a = playerState.ability;
  let costMod = 0;
  let attackBonus = 0;
  let defenseBonus = 0;
  let hpBonus = 0;
  if (a === "misty" && card.types?.includes("water")) costMod -= 1;
  if (a === "pikachu" && card.types?.includes("electric")) attackBonus += 1;
  if (a === "brock" && (card.types?.includes("rock") || card.types?.includes("ground"))) defenseBonus += 1;
  if (a === "erika" && card.types?.includes("grass")) hpBonus += 1;
  if (a === "lance" && card.types?.includes("dragon")) attackBonus += 1;
  // Sabrina's discount is applied per-ability (Psychic specials only), see
  // specialAbilityCost() below.
  return { costMod, attackBonus, defenseBonus, hpBonus };
}

// Per-trainer adjustment to a special ability's energy cost. Lookup is by
// (playerState.ability, card type, ability id).
export function trainerAbilityCostMod(playerState, card, ability) {
  if (!playerState || !ability) return 0;
  if (playerState.ability === "sabrina"
      && card.types?.includes("psychic")
      && ability.id === "special") {
    return -1;
  }
  return 0;
}

export function effectiveCost(playerState, card) {
  const { costMod } = abilityModifiers(playerState, card);
  return Math.max(1, (card.energyCost || 1) + costMod);
}

export function createGame({
  playerDeck,
  aiDeck,
  playerAbility,
  aiAbility,
  rand = Math.random,
  firstPlayer,             // "player" | "ai" — if omitted, picked at random
} = {}) {
  function makePlayer(name, ability, deck) {
    const shuffled = shuffle(deck, rand);
    const hand = shuffled.splice(0, STARTING_HAND);
    return {
      name,
      ability,
      trainerHp: TRAINER_START_HP,
      energy: 0,
      maxEnergy: 0,
      deck: shuffled,
      hand,
      field: new Array(FIELD_SIZE).fill(null),
      discard: [],
      items: defaultKit(),
    };
  }
  const firstSide = firstPlayer || (rand() < 0.5 ? "player" : "ai");
  const state = {
    turn: 0,
    activePlayer: firstSide,
    phase: "draw",
    winner: null,
    log: [],
    players: {
      player: makePlayer("You", playerAbility || "brock", playerDeck),
      ai:     makePlayer("Rival", aiAbility || "pikachu", aiDeck),
    },
    // Going-second compensation: the player who didn't go first will draw
    // an extra card on their first turn. We track that with a flag so
    // beginTurn can grant it once.
    firstSide,
  };
  beginTurn(state);
  return state;
}

function log(state, text, kind = "info") {
  state.log.push({ id: state.log.length + 1, text, kind });
}

// Combat log variety — different verb per attack so the log doesn't read as
// "X used Y on Z" line after line. The phrasebook is shallow on purpose so
// the underlying mechanics (ability name, damage, verdict) remain readable.
const BASIC_VERBS = ["struck", "tackled", "lunged at", "snapped at", "slammed"];
const SPECIAL_VERBS = ["unleashed", "channelled", "let loose", "rained down", "called forth"];
function attackPhrase(attackerCard, ability, defenderName, damage, mult, turn = 0) {
  const seed = (attackerCard.id + turn) | 0;
  const pick = (arr) => arr[Math.abs(seed) % arr.length];
  if (ability.id === "special") {
    const verb = pick(SPECIAL_VERBS);
    return `${attackerCard.name} ${verb} ${ability.name} — ${defenderName} took ${damage}`;
  }
  const verb = pick(BASIC_VERBS);
  return `${attackerCard.name} ${verb} ${defenderName} for ${damage}`;
}

function beginTurn(state) {
  state.turn += 1;
  state.phase = "draw";
  const p = state.players[state.activePlayer];
  // Draw 1 (or 2 if this is the first time the second-mover plays — fairness)
  const isFirstSecondMoverTurn =
    state.activePlayer !== state.firstSide &&
    state.turn === 2; // turn 1: first mover, turn 2: second mover's first turn
  const draws = isFirstSecondMoverTurn ? 2 : 1;
  for (let i = 0; i < draws; i++) {
    if (p.deck.length > 0) {
      p.hand.push(p.deck.shift());
    } else {
      log(state, `${p.name} is out of cards! Trainer takes 1 fatigue.`, "warn");
      p.trainerHp = Math.max(0, p.trainerHp - 1);
    }
  }
  if (isFirstSecondMoverTurn) {
    log(state, `${p.name} drew an extra card (going second).`, "info");
  }
  // Energy step
  p.maxEnergy = Math.min(MAX_ENERGY, p.maxEnergy + 1);
  p.energy = p.maxEnergy;
  // Field maintenance: clear summoning sickness on cards that survived a turn.
  for (const slot of p.field) {
    if (slot) slot.summoningSickness = false;
  }
  state.phase = "main";
  log(state, `Turn ${state.turn} — ${p.name} to move (${p.energy} Energy)`, "turn");

  if (checkWinner(state)) return;
}

export function playCard(state, side, handIndex, { rand = Math.random } = {}) {
  if (state.winner) return { ok: false, reason: "game over" };
  if (state.activePlayer !== side) return { ok: false, reason: "not your turn" };
  if (state.phase !== "main") return { ok: false, reason: "wrong phase" };
  const p = state.players[side];
  const card = p.hand[handIndex];
  if (!card) return { ok: false, reason: "no such card" };
  const cost = effectiveCost(p, card);
  if (p.energy < cost) return { ok: false, reason: "not enough energy" };
  const slot = emptySlot(p.field);
  if (slot === -1) return { ok: false, reason: "field is full" };
  p.energy -= cost;
  p.hand.splice(handIndex, 1);
  const inst = instantiate(card, p);
  p.field[slot] = inst;
  log(state, `${p.name} summoned ${card.name}!`, "summon");
  return { ok: true, slot, instance: inst };
}

export function attack(
  state, side, fromSlot, target,
  { rand = Math.random, abilityId = "basic" } = {},
) {
  if (state.winner) return { ok: false, reason: "game over" };
  if (state.activePlayer !== side) return { ok: false, reason: "not your turn" };
  if (state.phase !== "main") return { ok: false, reason: "wrong phase" };

  const p = state.players[side];
  const opponentSide = side === "player" ? "ai" : "player";
  const o = state.players[opponentSide];
  const attackerInst = p.field[fromSlot];
  if (!attackerInst) return { ok: false, reason: "no attacker" };
  if (attackerInst.summoningSickness) return { ok: false, reason: "summoning sickness" };
  if (attackerInst.attackedThisTurn) return { ok: false, reason: "already attacked" };
  if (isLockedOut(attackerInst)) {
    log(state, `${attackerInst.card.name} can't move (${attackerInst.status.kind})!`, "status");
    attackerInst.attackedThisTurn = true;
    return { ok: false, reason: attackerInst.status.kind };
  }

  const ability = abilityById(attackerInst.card, abilityId);
  // Sabrina's trainer ability discounts Psychic specials.
  const costMod = trainerAbilityCostMod(p, attackerInst.card, ability);
  const effectiveAbilityCost = Math.max(0, ability.energyCost + costMod);
  if (p.energy < effectiveAbilityCost) {
    return { ok: false, reason: `Need ${effectiveAbilityCost} energy for ${ability.name}` };
  }

  const { attackBonus } = abilityModifiers(p, attackerInst.card);

  // Target: "trainer" or a slot index on the opponent's field.
  // If opponent has Pokémon on the field, must attack one of them (taunt-style).
  const hasField = o.field.some((s) => s != null);

  let result;
  if (target === "trainer") {
    if (hasField) {
      return { ok: false, reason: "must attack opposing Pokémon first" };
    }
    const base = attackerInst.card.cardAttack + attackBonus + (attackerInst.attackBoost || 0);
    const damage = Math.max(1, Math.round(base * (ability.damageMult || 1)));
    o.trainerHp = Math.max(0, o.trainerHp - damage);
    log(state, attackPhrase(attackerInst.card, ability, o.name, damage, 1, state.turn), "attack");
    result = { damage, multiplier: 1, target: "trainer", abilityId, abilityName: ability.name };
  } else {
    const defenderSlot = target;
    const defenderInst = o.field[defenderSlot];
    if (!defenderInst) return { ok: false, reason: "no defender in slot" };
    const { defenseBonus } = abilityModifiers(o, defenderInst.card);
    const calc = computeDamage(attackerInst.card, defenderInst.card, {
      abilityBonus: attackBonus + (attackerInst.attackBoost || 0),
      ability,
      rand,
    });
    const damage = Math.max(calc.multiplier === 0 ? 0 : 1, calc.damage - defenseBonus);
    defenderInst.currentHp = Math.max(0, defenderInst.currentHp - damage);

    let line = attackPhrase(attackerInst.card, ability, defenderInst.card.name, damage, calc.multiplier, state.turn);
    if (calc.critical) line = `💥 CRITICAL! ${line}`;
    if (calc.verdict.text) line += ` — ${calc.verdict.text}`;
    log(state, line, "attack");

    // Status: ability-guaranteed status overrides the type-based random roll.
    let status = null;
    if (ability.status && defenderInst.currentHp > 0) {
      const turnsLeft = ability.status === "burn" ? 2 : 1;
      status = { kind: ability.status, turnsLeft };
      defenderInst.status = status;
      log(state, `${defenderInst.card.name} suffered ${status.kind}!`, "status");
    } else {
      // Otherwise fall back to the regular type-flavored chance
      const rolled = rollStatus(attackerInst.card, defenderInst.card, rand);
      if (rolled && defenderInst.currentHp > 0) {
        defenderInst.status = rolled;
        status = rolled;
        log(state, `${defenderInst.card.name} was inflicted with ${rolled.kind}!`, "status");
      }
    }

    // Bug Special: leech 50% of damage as healing for the attacker.
    if (ability.id === "special" && (attackerInst.card.types?.[0] === "bug")) {
      const heal = Math.max(1, Math.floor(damage / 2));
      const before = attackerInst.currentHp;
      attackerInst.currentHp = Math.min(attackerInst.card.cardHp, attackerInst.currentHp + heal);
      const gained = attackerInst.currentHp - before;
      if (gained > 0) log(state, `${attackerInst.card.name} drained ${gained} HP.`, "status");
    }

    result = {
      damage,
      multiplier: calc.multiplier,
      verdict: calc.verdict,
      status,
      target: defenderSlot,
      abilityId,
      abilityName: ability.name,
      ignoredDefense: !!calc.ignoredDefense,
      critical: !!calc.critical,
    };

    if (defenderInst.currentHp <= 0) {
      log(state, `${defenderInst.card.name} fainted!`, "ko");
      o.discard.push(defenderInst.card);
      o.field[defenderSlot] = null;
      result.knockedOut = true;
      // Level-up reward: the attacker grows +1 HP / +1 ATK for the rest of
      // the match. Snowballs aggressive play and gives long-lived Pokémon a
      // distinct identity ("Evolved x2"). Cap at +3 so it doesn't run away.
      const lvls = (attackerInst.level || 0) + 1;
      const cap = 3;
      if (lvls <= cap) {
        attackerInst.level = lvls;
        attackerInst.maxHp = (attackerInst.maxHp ?? attackerInst.card.cardHp) + 1;
        attackerInst.currentHp = Math.min(attackerInst.maxHp, attackerInst.currentHp + 1);
        attackerInst.attackBoost = (attackerInst.attackBoost || 0) + 1;
        result.attackerLeveled = lvls;
        log(state, `⚡ ${attackerInst.card.name} evolved to L${lvls} (+1 HP, +1 ATK)`, "summon");
      }
    }
  }

  // Charge the energy and mark the attacker as spent.
  p.energy -= effectiveAbilityCost;
  attackerInst.attackedThisTurn = true;

  if (checkWinner(state)) {
    result.winner = state.winner;
  }
  return { ok: true, ...result };
}

function checkWinner(state) {
  for (const side of ["player", "ai"]) {
    if (state.players[side].trainerHp <= 0) {
      state.winner = side === "player" ? "ai" : "player";
      state.phase = "over";
      log(state, `${state.players[state.winner].name} wins!`, "win");
      return true;
    }
  }
  return false;
}

export function endTurn(state) {
  if (state.winner) return;
  const p = state.players[state.activePlayer];
  // Apply end-of-turn status ticks to your own field (burns).
  for (const inst of p.field) {
    if (!inst) continue;
    const r = tickStatus(inst);
    if (r.damage > 0) {
      inst.currentHp = Math.max(0, inst.currentHp - r.damage);
      log(state, `${inst.card.name} took ${r.damage} burn damage`, "status");
      if (inst.currentHp <= 0) {
        log(state, `${inst.card.name} fainted to burn!`, "ko");
        p.discard.push(inst.card);
        const idx = p.field.indexOf(inst);
        if (idx >= 0) p.field[idx] = null;
      }
    }
  }
  // Reset attackedThisTurn flag on your own cards.
  for (const inst of p.field) if (inst) inst.attackedThisTurn = false;
  // Switch sides.
  state.activePlayer = state.activePlayer === "player" ? "ai" : "player";
  beginTurn(state);
}

// --- AI --------------------------------------------------------------------
//
// Three difficulty modes. The same skeleton, but with different policies on
// (a) card selection, (b) target selection, and (c) how often the AI passes
// on a legal action.
//
// easy:   plays cheapest cards, randomized targets, ~55% chance to pass each
//         play step and ~40% to skip each attack step. Doesn't account for
//         type effectiveness.
// medium: plays a random affordable card (not always the most expensive),
//         targets the lowest-HP enemy, occasionally passes.
// hard:   plays most expensive affordable card. Picks the attacker/target
//         pairing that yields the best damage-per-attacker. Always attacks
//         when it can.

import { computeDamage as _computeDamage } from "./battle.js";
import { basicAbility, specialAbility } from "./abilities.js";

const POLICIES = {
  easy:   { pickCard: "cheapest",  pickTarget: "random",   passPlayChance: 0.55, skipAttackChance: 0.4,  useTypeEff: false, useSpecial: false },
  medium: { pickCard: "random",    pickTarget: "lowestHp", passPlayChance: 0.15, skipAttackChance: 0.1,  useTypeEff: false, useSpecial: "sometimes" },
  hard:   { pickCard: "expensive", pickTarget: "bestDmg",  passPlayChance: 0,    skipAttackChance: 0,    useTypeEff: true,  useSpecial: "smart" },
};

function chooseHandIndex(ai, policy, rand) {
  const candidates = ai.hand
    .map((c, idx) => ({ c, idx, cost: effectiveCost(ai, c) }))
    .filter((x) => x.cost <= ai.energy);
  if (candidates.length === 0) return -1;
  switch (policy.pickCard) {
    case "cheapest":
      candidates.sort((a, b) => a.cost - b.cost);
      return candidates[0].idx;
    case "expensive":
      candidates.sort((a, b) => b.cost - a.cost);
      return candidates[0].idx;
    case "random":
    default:
      return candidates[Math.floor(rand() * candidates.length)].idx;
  }
}

function chooseTarget(state, attackerInst, policy, rand) {
  const opp = state.players.player;
  const fieldTargets = opp.field
    .map((inst, slot) => ({ inst, slot }))
    .filter(({ inst }) => inst != null);

  if (fieldTargets.length === 0) return "trainer";

  switch (policy.pickTarget) {
    case "random":
      return fieldTargets[Math.floor(rand() * fieldTargets.length)].slot;

    case "lowestHp":
      fieldTargets.sort((a, b) => a.inst.currentHp - b.inst.currentHp);
      return fieldTargets[0].slot;

    case "bestDmg": {
      // Prefer KOs: pick the target where our damage >= their currentHp.
      // Otherwise maximize damage dealt.
      let best = fieldTargets[0];
      let bestScore = -Infinity;
      for (const t of fieldTargets) {
        const { damage } = _computeDamage(attackerInst.card, t.inst.card);
        const ko = damage >= t.inst.currentHp;
        // big bonus for guaranteed KO
        const score = damage + (ko ? 1000 : 0);
        if (score > bestScore) {
          best = t;
          bestScore = score;
        }
      }
      return best.slot;
    }

    default:
      return fieldTargets[0].slot;
  }
}

// Personalities bias the AI's preferences without overriding difficulty.
// Picked at random per match so two consecutive runs feel different.
const PERSONALITIES = ["aggressive", "balanced", "tactical"];

export async function aiTakeTurn(state, { rand = Math.random, difficulty = "medium", onAction = null, personality = null } = {}) {
  const policy = POLICIES[difficulty] || POLICIES.medium;
  const ai = state.players.ai;
  const mood = personality || PERSONALITIES[Math.floor(rand() * PERSONALITIES.length)];

  // Item phase — opportunistic use of the AI's starter kit.
  if (ai.items?.length) {
    // Potion: heal a Pokémon below 50% HP (tactical/balanced).
    if (mood !== "aggressive") {
      const item = ai.items.find((i) => i.id === "potion" && i.uses > 0);
      if (item && ai.energy >= 1) {
        const lowSlot = ai.field.findIndex(
          (inst) => inst && inst.currentHp < (inst.maxHp ?? inst.card.cardHp) * 0.5,
        );
        if (lowSlot !== -1) {
          const r = _useItem(state, "ai", "potion", lowSlot);
          if (r.ok && onAction) await onAction({ kind: "item", itemId: "potion", slot: lowSlot });
        }
      }
    }
    // Energy Crystal: spend if it unlocks a card we couldn't otherwise play.
    {
      const item = ai.items.find((i) => i.id === "energy" && i.uses > 0);
      if (item) {
        const stretchPlay = ai.hand.find((c) => {
          const cost = effectiveCost(ai, c);
          return cost > ai.energy && cost <= ai.energy + 2;
        });
        if (stretchPlay) {
          const r = _useItem(state, "ai", "energy", null);
          if (r.ok && onAction) await onAction({ kind: "item", itemId: "energy" });
        }
      }
    }
  }

  // Summon phase — keep summoning until field is full, hand empty, or we pass.
  for (let safety = 0; safety < 10; safety++) {
    if (state.phase !== "main") break;
    if (emptySlot(ai.field) === -1) break;
    if (rand() < policy.passPlayChance) break; // sometimes just pass
    const idx = chooseHandIndex(ai, policy, rand);
    if (idx === -1) break;
    const r = playCard(state, "ai", idx, { rand });
    if (!r.ok) break;
    if (onAction) await onAction({ kind: "summon", slot: r.slot, instance: r.instance });
  }

  // Attack phase.
  for (let safety = 0; safety < 20; safety++) {
    if (state.winner) return;
    const attackers = ai.field
      .map((inst, slot) => ({ inst, slot }))
      .filter(({ inst }) => inst && !inst.summoningSickness && !inst.attackedThisTurn && !isLockedOut(inst));
    if (attackers.length === 0) break;

    // For "Hard" we use the best attacker/target pair globally. For easier
    // modes we just walk left-to-right and maybe skip.
    let attackerSlot, attackerInst;
    if (policy.pickTarget === "bestDmg") {
      const opp = state.players.player;
      const targets = opp.field
        .map((inst, slot) => ({ inst, slot }))
        .filter(({ inst }) => inst != null);
      if (targets.length === 0) {
        attackerSlot = attackers[0].slot;
        attackerInst = attackers[0].inst;
      } else {
        let bestPair = null;
        let bestScore = -Infinity;
        for (const a of attackers) {
          for (const t of targets) {
            const { damage } = _computeDamage(a.inst.card, t.inst.card);
            const ko = damage >= t.inst.currentHp;
            const score = damage + (ko ? 1000 : 0);
            if (score > bestScore) {
              bestScore = score;
              bestPair = a;
            }
          }
        }
        attackerSlot = bestPair.slot;
        attackerInst = bestPair.inst;
      }
    } else {
      attackerSlot = attackers[0].slot;
      attackerInst = attackers[0].inst;
    }

    if (rand() < policy.skipAttackChance) {
      // Easy mode pretends this attacker "rests"
      attackerInst.attackedThisTurn = true;
      continue;
    }

    const target = chooseTarget(state, attackerInst, policy, rand);
    // Decide which ability to use.
    let abilityId = "basic";
    if (policy.useSpecial) {
      const special = specialAbility(attackerInst.card);
      const canAfford = ai.energy >= special.energyCost;
      if (canAfford) {
        if (policy.useSpecial === "smart") {
          // Hard: use special whenever it KOs the target or hits an SE matchup.
          if (target !== "trainer") {
            const t = state.players.player.field[target];
            if (t) {
              const basic = _computeDamage(attackerInst.card, t.card);
              const spec  = _computeDamage(attackerInst.card, t.card, { ability: special });
              const basicKO = basic.damage >= t.currentHp;
              const specKO = spec.damage >= t.currentHp;
              if (specKO && !basicKO) abilityId = "special";
              else if (spec.multiplier >= 2 && ai.energy >= special.energyCost + 2) abilityId = "special";
            }
          } else if (ai.energy >= special.energyCost + 2) {
            abilityId = "special";
          }
        } else if (policy.useSpecial === "sometimes" && rand() < 0.35) {
          abilityId = "special";
        }
      }
    }
    const r = attack(state, "ai", attackerSlot, target, { rand, abilityId });
    if (onAction) await onAction({ kind: "attack", fromSlot: attackerSlot, target, result: r, attackerCard: attackerInst.card });
  }
  endTurn(state);
  if (onAction) await onAction({ kind: "end-turn" });
}

// Convenience: build a deck on the client from the /api/deck response.
export async function fetchDeck({ seed } = {}) {
  const qs = seed ? `?seed=${encodeURIComponent(seed)}` : "";
  const res = await fetch(`/api/deck${qs}`);
  if (!res.ok) throw new Error(`deck fetch failed: ${res.status}`);
  const { deck } = await res.json();
  return deck;
}
