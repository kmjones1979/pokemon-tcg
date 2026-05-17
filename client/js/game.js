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
import {
  hasPassive, pinchAttackBonus, levitateBlocks,
  staticTrigger, intimidateOnSummon, isGuardian, entranceAbility,
  signatureFor, fieldAttackBonusFor, enemyFieldAttackPenaltyFor, fieldCritBonus,
} from "./passives.js";
import { defaultKit, useItem as _useItem } from "./items.js";
export const useItem = _useItem;
// _useItem is re-used by the AI item phase below.

export const FIELD_SIZE = 5;
export const STARTING_HAND = 5;
export const TRAINER_START_HP = 30;
export const MAX_ENERGY = 10;
export const MAX_HAND = 10;
export const TURN_DURATION_MS = 60_000; // each player has 60s per turn

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
  const shiny = card.shinyLevel || 0;
  const cardHp = (card.cardHp || 1) + hpBonus + shiny;
  return {
    instanceId: nextInstanceId(),
    card,
    currentHp: cardHp,
    maxHp: cardHp,
    summoningSickness: !hasQuickTrait(card),
    status: null,
    // Shiny copies enter the field with a baseline attackBoost; the
    // KO-level-up system adds to this further.
    attackBoost: shiny,
    level: shiny,
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

// Type-combo bonus — if the attacker shares a primary type with 2+ of its
// own field, that type's attackers get +1 ATK on this strike. Two adds +1,
// three adds +2, four adds +3, capped at +3.
function comboBonusFor(playerState, card) {
  const t = card.types?.[0];
  if (!t) return 0;
  const count = playerState.field.filter(
    (s) => s && s.card.types?.[0] === t,
  ).length;
  if (count < 2) return 0;
  return Math.min(3, count - 1);
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
  // Brock — boosted: now also adds +1 max HP to Rock/Ground for parity with
  // Erika / Lance.
  if (a === "brock" && (card.types?.includes("rock") || card.types?.includes("ground"))) {
    defenseBonus += 1;
    hpBonus += 1;
  }
  if (a === "erika" && card.types?.includes("grass")) hpBonus += 1;
  if (a === "lance" && card.types?.includes("dragon")) attackBonus += 1;
  // Sabrina's discount is applied per-ability (Psychic specials only), see
  // specialAbilityCost() below.
  return { costMod, attackBonus, defenseBonus, hpBonus };
}

// Per-trainer adjustment to a special ability's energy cost. Lookup is by
// (playerState.ability, card type, ability id). Plus per-signature field
// auras (e.g. Lucario's Aura Sphere reduces specials cost by 1).
export function trainerAbilityCostMod(playerState, card, ability) {
  if (!playerState || !ability) return 0;
  let mod = 0;
  if (playerState.ability === "sabrina"
      && card.types?.includes("psychic")
      && ability.id === "special") {
    mod -= 1;
  }
  if (ability.id === "special") {
    for (const inst of playerState.field) {
      if (!inst) continue;
      const sig = signatureFor(inst.card);
      if (sig?.fieldAura?.specialCostMod) mod += sig.fieldAura.specialCostMod;
    }
  }
  return mod;
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
    firstSide,
    // Per-match recap: aggregated stats we show in the game-over screen.
    recap: {
      player: { crits: 0, kos: 0, biggestHit: 0, biggestHitName: null, totalDamage: 0 },
      ai:     { crits: 0, kos: 0, biggestHit: 0, biggestHitName: null, totalDamage: 0 },
    },
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
  state.turnEndsAt = Date.now() + TURN_DURATION_MS;
  const p = state.players[state.activePlayer];

  // Auto-loss: a player who has nothing left to do (no deck, no hand, no
  // field) can't recover, so we end the game immediately rather than
  // grinding through fatigue. This also fixes the "opponent has 0 cards
  // but I still have to play it out" case.
  const fieldCount = p.field.filter(Boolean).length;
  if (p.deck.length === 0 && p.hand.length === 0 && fieldCount === 0) {
    const winnerSide = state.activePlayer === "player" ? "ai" : "player";
    state.winner = winnerSide;
    state.phase = "over";
    log(state, `${p.name} has no cards left — ${state.players[winnerSide].name} wins!`, "win");
    return;
  }

  // Draw 1 (or 2 if this is the first time the second-mover plays — fairness)
  const isFirstSecondMoverTurn =
    state.activePlayer !== state.firstSide &&
    state.turn === 2; // turn 1: first mover, turn 2: second mover's first turn
  const draws = isFirstSecondMoverTurn ? 2 : 1;
  for (let i = 0; i < draws; i++) {
    if (p.deck.length > 0) {
      const card = p.deck.shift();
      if (p.hand.length >= MAX_HAND) {
        // Burn — hand is full, card goes straight to the discard pile.
        p.discard.push(card);
        log(state, `${p.name}'s hand is full — ${card.name} burned.`, "warn");
      } else {
        p.hand.push(card);
      }
    } else {
      // Fatigue scales each turn an empty-deck player draws — Hearthstone-
      // style — so decking out is decisive instead of dragging on forever.
      p.fatigueTicks = (p.fatigueTicks || 0) + 1;
      const dmg = Math.min(8, p.fatigueTicks * 2);
      log(state, `${p.name} is out of cards! Trainer takes ${dmg} fatigue.`, "warn");
      p.trainerHp = Math.max(0, p.trainerHp - dmg);
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
  // Signature onTurnStart hooks (Mewtwo Recover, Rayquaza Dragon Ascent, …)
  for (const inst of p.field) {
    if (!inst) continue;
    const sig = signatureFor(inst.card);
    if (sig?.onTurnStart) sig.onTurnStart(state, state.activePlayer, inst);
  }
  // Erika's trainer ability: heal 1 HP per turn for every Grass Pokémon on
  // the field. Tuned to make Grass decks feel sustainable.
  if (p.ability === "erika") {
    for (const inst of p.field) {
      if (!inst) continue;
      if (!inst.card.types?.includes("grass")) continue;
      const cap = inst.maxHp ?? inst.card.cardHp;
      if (inst.currentHp < cap) {
        inst.currentHp = Math.min(cap, inst.currentHp + 1);
      }
    }
  }
  state.phase = "main";
  log(state, `Turn ${state.turn} — ${p.name} to move (${p.energy} Energy)`, "turn");

  if (checkWinner(state)) return;
}

// Pre-game mulligan: swap up to N starting cards back into the deck and
// draw replacements. Returns nothing — mutates state.
export function mulliganHand(state, side, indices = [], { rand = Math.random } = {}) {
  const p = state.players[side];
  const sorted = [...new Set(indices)].sort((a, b) => b - a);
  const returned = [];
  for (const i of sorted) {
    if (i < 0 || i >= p.hand.length) continue;
    returned.push(p.hand.splice(i, 1)[0]);
  }
  if (returned.length === 0) return;
  p.deck = [...p.deck, ...returned];
  for (let i = p.deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p.deck[i], p.deck[j]] = [p.deck[j], p.deck[i]];
  }
  for (let i = 0; i < returned.length; i++) {
    if (p.deck.length === 0) break;
    p.hand.push(p.deck.shift());
  }
}

export function playCard(state, side, handIndex, { rand = Math.random, replaceSlot = null } = {}) {
  if (state.winner) return { ok: false, reason: "game over" };
  if (state.activePlayer !== side) return { ok: false, reason: "not your turn" };
  if (state.phase !== "main") return { ok: false, reason: "wrong phase" };
  const p = state.players[side];
  const card = p.hand[handIndex];
  if (!card) return { ok: false, reason: "no such card" };
  const cost = effectiveCost(p, card);
  if (p.energy < cost) return { ok: false, reason: "not enough energy" };

  // Determine target slot.
  let slot = emptySlot(p.field);
  let sacrificed = null;
  if (replaceSlot != null) {
    if (!Number.isInteger(replaceSlot) || replaceSlot < 0 || replaceSlot >= FIELD_SIZE) {
      return { ok: false, reason: "invalid replace slot" };
    }
    const existing = p.field[replaceSlot];
    if (!existing) return { ok: false, reason: "slot is empty — no need to replace" };
    sacrificed = existing.card;
    p.discard.push(existing.card);
    slot = replaceSlot;
  } else if (slot === -1) {
    return { ok: false, reason: "field is full — pick a slot to replace" };
  }

  p.energy -= cost;
  p.hand.splice(handIndex, 1);
  const inst = instantiate(card, p);
  p.field[slot] = inst;
  if (sacrificed) {
    log(state, `${p.name} sacrificed ${sacrificed.name} and summoned ${card.name}!`, "summon");
  } else {
    log(state, `${p.name} summoned ${card.name}!`, "summon");
  }
  // Intimidate passive: enemy field loses 1 attack each.
  if (hasPassive(card, "intimidate")) {
    const otherSide = side === "player" ? "ai" : "player";
    let n = 0;
    for (const opp of state.players[otherSide].field) {
      if (!opp) continue;
      opp.attackBoost = (opp.attackBoost || 0) - 1;
      n++;
    }
    if (n > 0) log(state, `🦁 ${card.name}'s Intimidate lowered ${n} foe${n === 1 ? "'s" : "s'"} attack.`, "status");
  }
  // Entrance abilities for legendary / mythical cards.
  const entrance = entranceAbility(card);
  if (entrance) {
    const otherSide = side === "player" ? "ai" : "player";
    if (entrance.kind === "roar") {
      // Damage every enemy on the field.
      let hits = 0;
      for (let i = 0; i < state.players[otherSide].field.length; i++) {
        const enemy = state.players[otherSide].field[i];
        if (!enemy) continue;
        enemy.currentHp = Math.max(0, enemy.currentHp - entrance.damage);
        hits++;
        if (enemy.currentHp <= 0) {
          state.players[otherSide].discard.push(enemy.card);
          state.players[otherSide].field[i] = null;
          log(state, `${enemy.card.name} fainted to ${card.name}'s Roar!`, "ko");
        }
      }
      if (hits > 0) log(state, `🔊 ${card.name}'s entrance hit ${hits} foe${hits === 1 ? "" : "s"} for ${entrance.damage}.`, "status");
    } else if (entrance.kind === "aurora") {
      let healed = 0;
      for (const ally of state.players[side].field) {
        if (!ally) continue;
        const cap = ally.maxHp ?? ally.card.cardHp;
        const before = ally.currentHp;
        ally.currentHp = Math.min(cap, ally.currentHp + entrance.heal);
        if (ally.currentHp > before) healed += (ally.currentHp - before);
      }
      if (healed > 0) log(state, `✨ ${card.name}'s Aurora restored ${healed} HP across the field.`, "summon");
    }
  }
  // Per-Pokémon signature ability: onSummon hook.
  const sig = signatureFor(card);
  if (sig?.onSummon) sig.onSummon(state, side, inst);
  return { ok: true, slot, instance: inst, sacrificed };
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
  // Guardian: if any opposing card has the Guardian trait, the attacker
  // MUST target a Guardian first.
  const guardians = o.field
    .map((inst, slot) => ({ inst, slot }))
    .filter(({ inst }) => inst && isGuardian(inst.card));
  if (guardians.length > 0 && target !== "trainer") {
    if (!guardians.some((g) => g.slot === target)) {
      return { ok: false, reason: "Must attack a Guardian (🛡) first" };
    }
  }

  let result;
  if (target === "trainer") {
    if (hasField) {
      return { ok: false, reason: "must attack opposing Pokémon first" };
    }
    const comboBonus = comboBonusFor(p, attackerInst.card);
    const base = attackerInst.card.cardAttack + attackBonus + (attackerInst.attackBoost || 0) + comboBonus;
    const damage = Math.max(1, Math.round(base * (ability.damageMult || 1)));
    o.trainerHp = Math.max(0, o.trainerHp - damage);
    log(state, attackPhrase(attackerInst.card, ability, o.name, damage, 1, state.turn), "attack");
    result = { damage, multiplier: 1, target: "trainer", abilityId, abilityName: ability.name };
  } else {
    const defenderSlot = target;
    const defenderInst = o.field[defenderSlot];
    if (!defenderInst) return { ok: false, reason: "no defender in slot" };
    const { defenseBonus } = abilityModifiers(o, defenderInst.card);
    // Levitate: defender immune to Ground regardless of type chart.
    const levitated = levitateBlocks(attackerInst.card, defenderInst.card);
    const pinchBonus = pinchAttackBonus(attackerInst);
    // Giratina Shadow Force — phase out one attack per match.
    const defSig = signatureFor(defenderInst.card);
    if (defSig?.onPreHit && defSig.onPreHit(state, opponentSide, defenderInst)) {
      attackerInst.attackedThisTurn = true;
      p.energy -= 0; // no charge — attack was phased out
      return { ok: true, damage: 0, multiplier: 0, verdict: { text: "Shadow Force!", tone: "miss" }, abilityId, abilityName: ability.name, target: defenderSlot };
    }
    // Signature passive (e.g. Lugia's Aeroblast) → ignoreDefense flag.
    const sigPassive = signatureFor(attackerInst.card)?.passive || null;
    const comboBonus = comboBonusFor(p, attackerInst.card);
    // Kyogre Drizzle / Groudon Drought-style aura modifiers.
    const auraBonus = fieldAttackBonusFor(p.field, attackerInst.card);
    const auraPenalty = enemyFieldAttackPenaltyFor(o.field, attackerInst.card);
    // Zapdos Thunderstorm-style aura crit boost.
    const critBoost = fieldCritBonus(p.field);
    const ignoreDefenseFlag =
      sigPassive?.ignoreDefense ||
      (sigPassive?.ignoreDefenseSpecial && ability?.id === "special");
    const calc = computeDamage(attackerInst.card, defenderInst.card, {
      abilityBonus:
        attackBonus +
        (attackerInst.attackBoost || 0) +
        pinchBonus +
        comboBonus +
        auraBonus -
        auraPenalty,
      ability,
      rand,
      themeType: state.themeType || null,
      ignoreDefense: ignoreDefenseFlag,
      critBoost,
    });
    if (comboBonus > 0) calc.comboBonus = comboBonus;
    if (levitated) {
      calc.damage = 0;
      calc.multiplier = 0;
      calc.verdict = { text: "Levitate — no effect!", tone: "miss" };
    }
    // Metagross-style damage reduction (defender passive).
    const defReduction = defSig?.passive?.damageReduction || 0;
    let damageBase = Math.max(calc.multiplier === 0 ? 0 : 1, calc.damage - defenseBonus);
    // Multiscale (Dragonite): halve damage while at full HP.
    let multiscaleApplied = false;
    if (defSig?.passive?.multiscale) {
      const cap = defenderInst.maxHp ?? defenderInst.card.cardHp;
      if (defenderInst.currentHp >= cap) {
        damageBase = Math.max(1, Math.round(damageBase / 2));
        multiscaleApplied = true;
      }
    }
    const damage = Math.max(calc.multiplier === 0 ? 0 : 1, damageBase - defReduction);
    defenderInst.currentHp = Math.max(0, defenderInst.currentHp - damage);
    if (multiscaleApplied) log(state, `🐉 ${defenderInst.card.name}'s Multiscale halved the blow.`, "status");
    if (defReduction > 0 && damageBase > damage) {
      log(state, `🛡 ${defenderInst.card.name}'s Iron Defense softened ${defReduction} damage.`, "status");
    }

    let line = attackPhrase(attackerInst.card, ability, defenderInst.card.name, damage, calc.multiplier, state.turn);
    if (calc.critical) line = `💥 CRITICAL! ${line}`;
    if (state.recap && damage > 0) {
      const r = state.recap[side];
      r.totalDamage += damage;
      if (damage > r.biggestHit) {
        r.biggestHit = damage;
        r.biggestHitName = attackerInst.card.name;
      }
      if (calc.critical) r.crits += 1;
    }
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
    // Static counter-passive: if the defender has Static and we made contact,
    // 25% chance to paralyze the attacker.
    if (damage > 0 && !attackerInst.status) {
      const back = staticTrigger(defenderInst.card, rand);
      if (back) {
        attackerInst.status = back;
        log(state, `⚡ ${defenderInst.card.name}'s Static paralyzed ${attackerInst.card.name}!`, "status");
      }
    }
    // Field aura: Reshiram / Zekrom-style auto-apply status if attacker is
    // the aura's type AND the defender survived the hit.
    if (damage > 0 && defenderInst.currentHp > 0 && !status) {
      for (const ally of p.field) {
        if (!ally) continue;
        const sigA = signatureFor(ally.card);
        if (sigA?.fieldAura?.statusOnHit && attackerInst.card.types?.includes(sigA.fieldAura.type)) {
          const kind = sigA.fieldAura.statusOnHit;
          const turnsLeft = kind === "burn" ? 2 : 1;
          defenderInst.status = { kind, turnsLeft };
          status = defenderInst.status;
          log(state, `${ally.card.name}'s aura inflicted ${kind} on ${defenderInst.card.name}!`, "status");
          break;
        }
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
      // Phoenix Down (Ho-Oh) / other onKO signatures get a chance to save it.
      const sig = signatureFor(defenderInst.card);
      const saved = sig?.onKO ? sig.onKO(state, opponentSide, defenderInst) : false;
      if (saved && defenderInst.currentHp > 0) {
        result.savedByPassive = sig.name;
        // Don't count this as a KO. Skip discard + level-up branch.
      } else {
      log(state, `${defenderInst.card.name} fainted!`, "ko");
      o.discard.push(defenderInst.card);
      o.field[defenderSlot] = null;
      result.knockedOut = true;
      if (state.recap) state.recap[side].kos += 1;
      // Garchomp Sand Force-style onKill hook on the attacker.
      const attackerSig = signatureFor(attackerInst.card);
      if (attackerSig?.onKill) attackerSig.onKill(state, side, attackerInst);
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
      } // closes phoenix-saved else
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

  // Guardian taunt — must attack guardians first.
  const guardians = fieldTargets.filter(({ inst }) => isGuardian(inst.card));
  const reachable = guardians.length > 0 ? guardians : fieldTargets;
  // Carry the filtered pool through the rest of the picker.
  fieldTargets.length = 0;
  fieldTargets.push(...reachable);

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
  try {
    return await aiTakeTurnInner(state, { rand, difficulty, onAction, personality });
  } catch (err) {
    // Defense-in-depth: if anything throws mid-turn we MUST still hand control
    // back to the player, otherwise the game wedges with activePlayer="ai"
    // forever. Log + force the turn to end. Surfacing the error to the user is
    // the caller's job (main.js shows a verdict).
    console.error("[ai] turn aborted by exception:", err);
    if (state && state.activePlayer === "ai" && !state.winner) {
      try { endTurn(state); } catch (e2) { console.error("[ai] endTurn fallback failed:", e2); }
    }
    throw err;
  }
}

async function aiTakeTurnInner(state, { rand, difficulty, onAction, personality }) {
  const policy = POLICIES[difficulty] || POLICIES.medium;
  const ai = state.players.ai;
  const mood = personality || PERSONALITIES[Math.floor(rand() * PERSONALITIES.length)];

  // Item phase — opportunistic use of the AI's starter kit.
  if (ai.items?.length) {
    // Revive: if we have a KO'd Pokémon and an open slot, bring it back.
    {
      const item = ai.items.find((i) => i.id === "revive" && i.uses > 0);
      if (item && ai.energy >= 3 && ai.discard.length > 0 && ai.field.includes(null)) {
        const r = _useItem(state, "ai", "revive", null);
        if (r.ok && onAction) await onAction({ kind: "item", itemId: "revive" });
      }
    }
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
    // Lucky Draw: when hand is small + lots of deck left.
    {
      const item = ai.items.find((i) => i.id === "luckyDraw" && i.uses > 0);
      if (item && ai.energy >= 1 && ai.hand.length <= 3 && ai.deck.length >= 4) {
        const r = _useItem(state, "ai", "luckyDraw", null);
        if (r.ok && onAction) await onAction({ kind: "item", itemId: "luckyDraw" });
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
      let targets = opp.field
        .map((inst, slot) => ({ inst, slot }))
        .filter(({ inst }) => inst != null);
      // Honor Guardian taunt in the heuristic.
      const guards = targets.filter(({ inst }) => isGuardian(inst.card));
      if (guards.length > 0) targets = guards;
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
