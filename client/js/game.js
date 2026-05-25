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
import { getMultiplier } from "./type-chart.js";
import { abilityById } from "./abilities.js";
import {
  hasPassive, pinchAttackBonus, levitateBlocks,
  staticTrigger, intimidateOnSummon, isGuardian, entranceAbility,
  signatureFor, fieldAttackBonusFor, enemyFieldAttackPenaltyFor, fieldCritBonus,
} from "./passives.js";
import { defaultKit, useItem as _useItem } from "./items.js";
// Evolution chain threshold — the server stamps `evolves_to_card`
// directly on each card at pokedex-load time, so the engine doesn't
// need the full chain table at runtime. Just the KO threshold.
import * as _evoModule from "../../shared/evolution-chains.js";
const { EVOLUTION_KO_THRESHOLD } = _evoModule.default ?? _evoModule;
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
    // Evolution tracking — kos counts THIS-INSTANCE knockouts. When
    // it crosses EVOLUTION_KO_THRESHOLD AND the card has an
    // evolves_to mapping, the engine transforms the instance on the
    // next eligible moment (see `tryEvolveInstance`).
    kos: 0,
  };
}

// Phase 2 spec mentions "Pokémon with the Quick trait can attack the turn
// they're played." We don't have data for that in PokeAPI per-card, so for now
// pure-Flying types act as the "Quick" set — fluffy + thematic. Easy to change.
// Try to evolve an instance into its next form. Called after the
// instance scores a KO. Returns true if a transformation happened.
//
// Rules:
//   - The instance must have hit EVOLUTION_KO_THRESHOLD KOs this life.
//   - The card must have `evolves_to_card` baked on it (server adds
//     this at pokedex-load time so the engine doesn't need a
//     separate lookup table at runtime).
//   - HP percentage carries over (so a 50%-HP Charmander becomes a
//     50%-HP Charmeleon).
//   - kos resets to 0 on the evolved form — so a Charmander →
//     Charmeleon can later evolve again into Charizard with another
//     2 KOs (if Charmeleon's card also has evolves_to_card set).
//   - level / attackBoost from KOs and shiny flags are preserved.
function tryEvolveInstance(state, side, instance) {
  if (!instance) return false;
  if ((instance.kos || 0) < EVOLUTION_KO_THRESHOLD) return false;
  const evolved = instance.card?.evolves_to_card;
  if (!evolved) return false;
  const oldName = instance.card?.name || "Pokémon";
  const oldMax = instance.maxHp || instance.card?.cardHp || 1;
  const hpFrac = Math.max(0.1, instance.currentHp / oldMax);
  const newMax = (evolved.cardHp || 1) + (instance.level || 0);
  instance.card = evolved;
  instance.maxHp = newMax;
  instance.currentHp = Math.max(1, Math.round(newMax * hpFrac));
  instance.kos = 0;
  // Visual hint for the renderer — UI flashes any inst with this stamp.
  instance.justEvolved = { fromName: oldName, toName: evolved.name, at: Date.now() };
  log(state, `✨ ${oldName} evolved into ${evolved.name}!`, "summon");
  return true;
}

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
  let cost = (card.energyCost || 1) + costMod;
  // Comeback mechanic: when you're below 25% trainer HP, every card
  // play costs 1 less energy (floor 1). Last-Stand match modifier
  // raises the threshold to 40% so the comeback fires earlier.
  if (playerState && playerState.trainerHp != null && playerState.maxTrainerHp != null) {
    const ratio = playerState.trainerHp / playerState.maxTrainerHp;
    const threshold = playerState._comebackThreshold || 0.25;
    if (ratio > 0 && ratio < threshold) cost -= 1;
  }
  return Math.max(1, cost);
}

export function createGame({
  playerDeck,
  aiDeck,
  playerAbility,
  aiAbility,
  rand = Math.random,
  firstPlayer,             // "player" | "ai" — if omitted, picked at random
  aiTrainerHp,             // override AI side's starting HP (boss fights)
  aiName,                  // override AI's display name (boss name)
  masteryById,             // { [pokemonId]: { level: 0..3 } } — player-side
                            // mastery snapshot. L3 cards get +1 ATK for the
                            // whole match (engine applies via cardAttack).
} = {}) {
  // Stamp the mastery bonus directly onto a clone of each player-side
  // card so every code path (hand, field, draw, discard) sees the
  // boosted value with no per-call lookup overhead.
  function applyMasteryToDeck(deck) {
    if (!masteryById) return deck;
    return deck.map((card) => {
      const m = masteryById[card?.id];
      if (m?.level >= 3) {
        return { ...card, cardAttack: (card.cardAttack || 0) + 1, _masteryLevel: m.level };
      }
      if (m?.level) {
        return { ...card, _masteryLevel: m.level };
      }
      return card;
    });
  }
  const adjustedPlayerDeck = applyMasteryToDeck(playerDeck);
  function makePlayer(name, ability, deck, hpOverride) {
    const shuffled = shuffle(deck, rand);
    const hand = shuffled.splice(0, STARTING_HAND);
    return {
      name,
      ability,
      trainerHp: hpOverride || TRAINER_START_HP,
      maxTrainerHp: hpOverride || TRAINER_START_HP,
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
      player: makePlayer("You", playerAbility || "brock", adjustedPlayerDeck),
      ai:     makePlayer(aiName || "Rival", aiAbility || "pikachu", aiDeck, aiTrainerHp),
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
  // Boss-mode phase check: at every turn boundary, see if the boss has
  // crossed a new HP threshold and apply that phase's effects once.
  applyBossPhaseChecks(state);
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
  // Stalemate damage moved out of beginTurn — it now fires symmetrically
  // at endTurn so both trainers take it at the exact same instant. That
  // means a 1-HP-vs-1-HP situation actually resolves as a TIE instead
  // of whichever side happened to have their beginTurn run first.
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

// Spell-card dispatcher. Called from playCard when card.kind === "spell".
// Each effect branch must (a) validate its target, (b) return a useful
// error reason if invalid, and (c) on success pay energy + remove from
// hand + push to discard. Logging happens INSIDE each branch so the
// message references the right card/target.
// Helpers for spell handlers. Each spell does three things on success:
// (1) mutate state, (2) pay energy, (3) move the card from hand →
// discard. consumeSpell wraps (2)+(3) so each handler only has to
// worry about the unique mutation.
function consumeSpell(p, handIndex, card, cost) {
  p.energy -= cost;
  p.hand.splice(handIndex, 1);
  p.discard.push(card);
}

function requireEnemyTarget(state, side, spellTarget, verb) {
  if (!Number.isInteger(spellTarget) || spellTarget < 0 || spellTarget >= FIELD_SIZE) {
    return { err: { ok: false, reason: `Pick an enemy Pokémon to ${verb}` } };
  }
  const otherSide = side === "player" ? "ai" : "player";
  const enemy = state.players[otherSide].field[spellTarget];
  if (!enemy) return { err: { ok: false, reason: "That slot is empty" } };
  return { enemy, otherSide };
}

function requireAllyTarget(state, side, spellTarget, verb) {
  if (!Number.isInteger(spellTarget) || spellTarget < 0 || spellTarget >= FIELD_SIZE) {
    return { err: { ok: false, reason: `Pick one of your Pokémon to ${verb}` } };
  }
  const ally = state.players[side].field[spellTarget];
  if (!ally) return { err: { ok: false, reason: "That slot is empty" } };
  return { ally };
}

function playSpellCard(state, side, handIndex, card, cost, { spellTarget = null } = {}) {
  const p = state.players[side];
  const otherSide = side === "player" ? "ai" : "player";
  switch (card.effect) {

    // -------- FREEZE --------------------------------------------------
    // Lock one enemy Pokémon for 1 turn. Reuses the same status pipe
    // paralyze/sleep use — battle.isLockedOut() recognises "freeze"
    // and tickStatus expires it after one tick.
    case "freeze": {
      const r = requireEnemyTarget(state, side, spellTarget, "freeze");
      if (r.err) return r.err;
      r.enemy.status = { kind: "freeze", turnsLeft: 1 };
      consumeSpell(p, handIndex, card, cost);
      log(state, `❄ ${card.name}: ${r.enemy.card.name} was frozen solid!`, "status");
      return { ok: true, spell: card, effect: "freeze", targetSide: r.otherSide, targetSlot: spellTarget, targetName: r.enemy.card.name };
    }

    // -------- PARALYZE -----------------------------------------------
    // Same lockout shape as freeze, different status kind so the
    // animation + log read as paralysis. Both decrement via tickStatus.
    case "paralyze": {
      const r = requireEnemyTarget(state, side, spellTarget, "paralyze");
      if (r.err) return r.err;
      r.enemy.status = { kind: "paralyze", turnsLeft: 1 };
      consumeSpell(p, handIndex, card, cost);
      log(state, `⚡ ${card.name}: ${r.enemy.card.name} is paralyzed!`, "status");
      return { ok: true, spell: card, effect: "paralyze", targetSide: r.otherSide, targetSlot: spellTarget, targetName: r.enemy.card.name };
    }

    // -------- HEAL ----------------------------------------------------
    // Restore one ally to its current max HP. Cheap to compute, doesn't
    // overheal past maxHp (the cap a Defender / Evolve has already
    // raised, if applicable).
    case "heal": {
      const r = requireAllyTarget(state, side, spellTarget, "heal");
      if (r.err) return r.err;
      const cap = r.ally.maxHp ?? r.ally.card.cardHp;
      const before = r.ally.currentHp;
      r.ally.currentHp = cap;
      const healed = r.ally.currentHp - before;
      consumeSpell(p, handIndex, card, cost);
      log(state, `💚 ${card.name}: ${r.ally.card.name} restored ${healed} HP (full).`, "status");
      return { ok: true, spell: card, effect: "heal", targetSide: side, targetSlot: spellTarget, targetName: r.ally.card.name, healed };
    }

    // -------- DEFENDER -----------------------------------------------
    // Raises one ally's max HP and marks the instance as a Defender so
    // attack() routes incoming damage to it first. The marker lives on
    // the instance (not the card), so it travels with this specific
    // copy on the field and doesn't bleed to other instances of the
    // same Pokémon. Stacking: a second Defender re-applies the bonus
    // (incremental, by design — you can pile guard on the same target).
    case "defender": {
      const r = requireAllyTarget(state, side, spellTarget, "defend");
      if (r.err) return r.err;
      const bonus = Math.max(1, card.defenderHpBonus || 5);
      const oldMax = r.ally.maxHp ?? r.ally.card.cardHp;
      r.ally.maxHp = oldMax + bonus;
      r.ally.currentHp = r.ally.currentHp + bonus;
      r.ally.isDefender = true;
      consumeSpell(p, handIndex, card, cost);
      log(state, `🛡 ${card.name}: ${r.ally.card.name} braces (+${bonus} HP, must be attacked first).`, "status");
      return { ok: true, spell: card, effect: "defender", targetSide: side, targetSlot: spellTarget, targetName: r.ally.card.name };
    }

    // -------- EVOLVE --------------------------------------------------
    // Tries to species-transform the target into its next evolution
    // form (Charmander → Charmeleon → Charizard). Falls back to a
    // stat buff (+50% HP, +50% ATK) for Pokémon that have no chain
    // entry (Mewtwo, single-form rares, etc.), so the spell always
    // does SOMETHING good.
    case "evolve": {
      const r = requireAllyTarget(state, side, spellTarget, "evolve");
      if (r.err) return r.err;
      // Force the evolution by pre-bumping kos past the threshold;
      // tryEvolveInstance handles the actual transformation. If it
      // succeeds we return without applying the stat buff.
      const beforeCardId = r.ally.card?.id;
      r.ally.kos = Math.max(r.ally.kos || 0, EVOLUTION_KO_THRESHOLD);
      const evolved = tryEvolveInstance(state, side, r.ally);
      if (evolved) {
        consumeSpell(p, handIndex, card, cost);
        return {
          ok: true, spell: card, effect: "evolve",
          targetSide: side, targetSlot: spellTarget,
          targetName: r.ally.card.name,
          transformed: true,
          fromName: r.ally.justEvolved?.fromName,
          toName: r.ally.justEvolved?.toName,
        };
      }
      // Fallback: no chain available → apply the original stat buff.
      // Restore kos to its pre-attempt value so we don't accidentally
      // queue a future KO-triggered evolution for a Pokémon that
      // doesn't have one.
      r.ally.kos = 0;
      const hpMult  = card.evolveHpMult  || 1.5;
      const atkMult = card.evolveAtkMult || 1.5;
      const oldMax = r.ally.maxHp ?? r.ally.card.cardHp;
      const newMax = Math.max(oldMax + 1, Math.ceil(oldMax * hpMult));
      const hpGain = newMax - oldMax;
      r.ally.maxHp = newMax;
      r.ally.currentHp = r.ally.currentHp + hpGain;
      const baseAtk = r.ally.card.cardAttack || 0;
      const atkGain = Math.max(1, Math.ceil(baseAtk * (atkMult - 1)));
      r.ally.attackBoost = (r.ally.attackBoost || 0) + atkGain;
      r.ally.evolved = true;
      consumeSpell(p, handIndex, card, cost);
      log(state, `✨ ${card.name}: ${r.ally.card.name} powered up! +${hpGain} HP, +${atkGain} ATK.`, "status");
      return { ok: true, spell: card, effect: "evolve", targetSide: side, targetSlot: spellTarget, targetName: r.ally.card.name, hpGain, atkGain, transformed: false };
    }

    // -------- AOE -----------------------------------------------------
    // Deal flat damage to every enemy on the field. No target picker
    // (target=null). KO'd Pokémon land in the opponent's discard pile.
    // Damage scaling is intentionally low (4 HP default) — most card
    // HPs are 3-10 so tier-1s die but tier-3+ survive the wipe.
    case "aoe": {
      const dmg = Math.max(1, card.aoeDamage || 4);
      const enemies = state.players[otherSide].field;
      let hits = 0;
      let kos = 0;
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (!e) continue;
        const dealt = Math.min(e.currentHp, dmg);
        e.currentHp -= dealt;
        hits++;
        if (e.currentHp <= 0) {
          state.players[otherSide].discard.push(e.card);
          enemies[i] = null;
          kos++;
        }
      }
      if (hits === 0) {
        // Refuse to fire if there's nothing to hit (no wasted card).
        return { ok: false, reason: "No enemies on the field to hit." };
      }
      consumeSpell(p, handIndex, card, cost);
      log(state, `💥 ${card.name}: dealt ${dmg} to ${hits} enemy Pokémon${kos > 0 ? ` (${kos} KO)` : ""}.`, "status");
      return { ok: true, spell: card, effect: "aoe", targetSide: otherSide, damage: dmg, hits, kos };
    }

    // -------- BOLT (slice 6) -----------------------------------------
    // Direct damage to one enemy — bypasses combat math (no type
    // multiplier, no defender's defense). Useful as a finisher on
    // chip-damaged enemies the player can't quite KO with a normal
    // attack. KO'd Pokémon move to the opponent's discard.
    case "bolt": {
      const r = requireEnemyTarget(state, side, spellTarget, "strike");
      if (r.err) return r.err;
      const dmg = Math.max(1, card.boltDamage || 5);
      const dealt = Math.min(r.enemy.currentHp, dmg);
      r.enemy.currentHp -= dealt;
      let kod = false;
      if (r.enemy.currentHp <= 0) {
        state.players[r.otherSide].discard.push(r.enemy.card);
        state.players[r.otherSide].field[spellTarget] = null;
        kod = true;
      }
      consumeSpell(p, handIndex, card, cost);
      log(state, `⚡ ${card.name}: ${r.enemy.card.name} took ${dealt} damage${kod ? " — KO!" : ""}.`, kod ? "ko" : "status");
      return { ok: true, spell: card, effect: "bolt", targetSide: r.otherSide, targetSlot: spellTarget, targetName: r.enemy.card.name, damage: dealt, knockedOut: kod };
    }

    // -------- SLEEP POWDER (slice 6) ---------------------------------
    // Stronger lockout than Freeze: 2 turns instead of 1. Uses the
    // existing "sleep" status kind so battle.tickStatus + isLockedOut
    // handle it without engine changes.
    case "sleep-powder": {
      const r = requireEnemyTarget(state, side, spellTarget, "lull");
      if (r.err) return r.err;
      const turns = Math.max(1, card.sleepTurns || 2);
      r.enemy.status = { kind: "sleep", turnsLeft: turns };
      consumeSpell(p, handIndex, card, cost);
      log(state, `💤 ${card.name}: ${r.enemy.card.name} fell asleep for ${turns} turns.`, "status");
      return { ok: true, spell: card, effect: "sleep-powder", targetSide: r.otherSide, targetSlot: spellTarget, targetName: r.enemy.card.name };
    }

    // -------- CLEANSE (slice 6) --------------------------------------
    // Counter to enemy disruption (freeze, paralyze, sleep, burn). The
    // cheap common-rarity equivalent of "wake up please". No-op on a
    // status-free ally but still consumes the card.
    case "cleanse": {
      const r = requireAllyTarget(state, side, spellTarget, "cleanse");
      if (r.err) return r.err;
      const removed = r.ally.status?.kind || null;
      r.ally.status = null;
      consumeSpell(p, handIndex, card, cost);
      log(state, `✨ ${card.name}: ${r.ally.card.name} ${removed ? `shook off ${removed}!` : "stayed in fine shape."}`, "status");
      return { ok: true, spell: card, effect: "cleanse", targetSide: side, targetSlot: spellTarget, targetName: r.ally.card.name, removedStatus: removed };
    }

    // -------- SURGE (slice 6) ----------------------------------------
    // Pay 1 energy to gain 2 energy this turn (net +1). Tempo card —
    // enables an expensive play one turn earlier. Capped at maxEnergy
    // so a maxed-out player gets less benefit (no infinite ladder).
    case "surge": {
      const gain = Math.max(1, card.surgeEnergy || 2);
      const cap  = p.maxEnergy ?? 10;
      // Pay the cost FIRST so a player at energy=1 doesn't go negative
      // when the cost is 1 — consumeSpell already does this in the
      // other branches but we run it inline here so we can clamp.
      p.energy = Math.max(0, p.energy - cost);
      const before = p.energy;
      p.energy = Math.min(cap, p.energy + gain);
      const realGain = p.energy - before;
      p.hand.splice(handIndex, 1);
      p.discard.push(card);
      log(state, `🔋 ${card.name}: +${realGain} Energy (now ${p.energy}/${cap}).`, "summon");
      return { ok: true, spell: card, effect: "surge", gained: realGain, energyAfter: p.energy };
    }

    // -------- SCOUT (slice 6) ----------------------------------------
    // Draw 2 cards. Card advantage in a deck where draws happen 1/turn.
    // Capped at MAX_HAND so a near-full hand doesn't over-stuff.
    case "scout": {
      const want = Math.max(1, card.drawCount || 2);
      const drawn = [];
      for (let i = 0; i < want; i++) {
        if (p.deck.length === 0) break;
        if (p.hand.length >= MAX_HAND) break;
        const c = p.deck.shift();
        p.hand.push(c);
        drawn.push(c.name);
      }
      if (drawn.length === 0) {
        return { ok: false, reason: "Hand is full or deck is empty." };
      }
      consumeSpell(p, handIndex, card, cost);
      log(state, `🎴 ${card.name}: drew ${drawn.length} card${drawn.length === 1 ? "" : "s"} (${drawn.join(", ")}).`, "summon");
      return { ok: true, spell: card, effect: "scout", drew: drawn.length, drawnNames: drawn };
    }

    // -------- PHOENIX (slice 6) --------------------------------------
    // Revive the most recently fainted Pokémon at full HP. Only Pokémon
    // count (skips spell cards that landed in discard via consumeSpell).
    // Summoning sickness applies so the revived Pokémon can't attack
    // the turn it comes back — otherwise this would be too snowbally.
    case "phoenix": {
      let lastPokeIdx = -1;
      for (let i = p.discard.length - 1; i >= 0; i--) {
        if (p.discard[i]?.kind !== "spell") { lastPokeIdx = i; break; }
      }
      if (lastPokeIdx === -1) {
        return { ok: false, reason: "No fainted Pokémon to revive." };
      }
      const emptyIdx = p.field.findIndex((s) => s === null);
      if (emptyIdx === -1) {
        return { ok: false, reason: "Field is full — no room to revive." };
      }
      const revivedCard = p.discard.splice(lastPokeIdx, 1)[0];
      const inst = instantiate(revivedCard, p);
      // Override instantiate's default HP (which uses cardHp + bonuses)
      // to set explicit full HP. Most code paths already do this but
      // we pin it for Phoenix specifically.
      inst.currentHp = inst.maxHp;
      p.field[emptyIdx] = inst;
      consumeSpell(p, handIndex, card, cost);
      log(state, `🦅 ${card.name}: ${revivedCard.name} rose from the ashes at full HP!`, "summon");
      return { ok: true, spell: card, effect: "phoenix", targetSide: side, targetSlot: emptyIdx, targetName: revivedCard.name };
    }

    // -------- BURN (slice 7) ----------------------------------------
    // Apply burn status — battle.tickStatus deals 2 damage at the end
    // of the burnt Pokémon's own turn for `burnTurns` ticks. Different
    // shape from Freeze/Paralyze: it's slow consistent damage, not a
    // hard lockout.
    case "burn": {
      const r = requireEnemyTarget(state, side, spellTarget, "burn");
      if (r.err) return r.err;
      const turns = Math.max(1, card.burnTurns || 3);
      r.enemy.status = { kind: "burn", turnsLeft: turns };
      consumeSpell(p, handIndex, card, cost);
      log(state, `🔥 ${card.name}: ${r.enemy.card.name} caught fire — ${turns} turns of burn damage!`, "status");
      return { ok: true, spell: card, effect: "burn", targetSide: r.otherSide, targetSlot: spellTarget, targetName: r.enemy.card.name };
    }

    // -------- SHIELD (slice 7) --------------------------------------
    // Mark an ally with `shieldedNext = true`. The attack() function
    // consumes this flag on the next incoming hit: damage becomes 0,
    // flag clears, log line announces the block.
    case "shield": {
      const r = requireAllyTarget(state, side, spellTarget, "shield");
      if (r.err) return r.err;
      r.ally.shieldedNext = true;
      consumeSpell(p, handIndex, card, cost);
      log(state, `🛡 ${card.name}: ${r.ally.card.name} is shielded from the next attack!`, "status");
      return { ok: true, spell: card, effect: "shield", targetSide: side, targetSlot: spellTarget, targetName: r.ally.card.name };
    }

    // -------- MASS HEAL (slice 7) -----------------------------------
    // Heal every ally on field by `massHealAmount` HP, capped at each
    // Pokémon's maxHp. No-target spell — fires the moment you pick it.
    case "mass-heal": {
      const amount = Math.max(1, card.massHealAmount || 3);
      const allies = p.field.filter((s) => s !== null);
      if (allies.length === 0) {
        return { ok: false, reason: "No Pokémon on the field to heal." };
      }
      let totalHealed = 0;
      for (const ally of allies) {
        const cap = ally.maxHp ?? ally.card.cardHp;
        const before = ally.currentHp;
        ally.currentHp = Math.min(cap, ally.currentHp + amount);
        totalHealed += ally.currentHp - before;
      }
      consumeSpell(p, handIndex, card, cost);
      log(state, `💗 ${card.name}: restored ${totalHealed} HP across ${allies.length} Pokémon.`, "status");
      return { ok: true, spell: card, effect: "mass-heal", healed: totalHealed, allies: allies.length };
    }

    // -------- POWER STRIKE (slice 7) --------------------------------
    // Mark an ally with `powerStrikeBonus`. The attack() function adds
    // this to the next attack's damage, then clears the flag.
    case "power-strike": {
      const r = requireAllyTarget(state, side, spellTarget, "power up");
      if (r.err) return r.err;
      const bonus = Math.max(1, card.powerStrikeBonus || 3);
      r.ally.powerStrikeBonus = bonus;
      consumeSpell(p, handIndex, card, cost);
      log(state, `⚔ ${card.name}: ${r.ally.card.name}'s next attack will hit for +${bonus} damage!`, "status");
      return { ok: true, spell: card, effect: "power-strike", targetSide: side, targetSlot: spellTarget, targetName: r.ally.card.name };
    }

    // -------- COUNTER (slice 7) -------------------------------------
    // Mark an ally with `counterNext = true`. When they next get
    // attacked, attack() reflects the damage back at the attacker AND
    // still takes the hit themselves. Powerful but single-use.
    case "counter": {
      const r = requireAllyTarget(state, side, spellTarget, "set as counter");
      if (r.err) return r.err;
      r.ally.counterNext = true;
      consumeSpell(p, handIndex, card, cost);
      log(state, `↩ ${card.name}: ${r.ally.card.name} will reflect the next attack!`, "status");
      return { ok: true, spell: card, effect: "counter", targetSide: side, targetSlot: spellTarget, targetName: r.ally.card.name };
    }

    // -------- CONFUSION (slice 8) ----------------------------------
    // Apply "confuse" status. attack() rolls a 50% self-hit chance
    // whenever an attacker has this status — the attack redirects to
    // the attacker themselves. The status ticks down at end of the
    // confused player's turn (handled in battle.tickStatus via the
    // generic non-burn branch).
    case "confusion": {
      const r = requireEnemyTarget(state, side, spellTarget, "confuse");
      if (r.err) return r.err;
      const turns = Math.max(1, card.confuseTurns || 2);
      r.enemy.status = { kind: "confuse", turnsLeft: turns };
      consumeSpell(p, handIndex, card, cost);
      log(state, `🌀 ${card.name}: ${r.enemy.card.name} is confused for ${turns} turns!`, "status");
      return { ok: true, spell: card, effect: "confusion", targetSide: r.otherSide, targetSlot: spellTarget, targetName: r.enemy.card.name };
    }

    // -------- STORM (slice 8) --------------------------------------
    // Both-sides AOE. Hits every Pokémon on the field (yours + theirs)
    // for `stormDamage`. Risky but high-tempo: useful when your board
    // is healthier than theirs.
    case "storm": {
      const dmg = Math.max(1, card.stormDamage || 2);
      const sides = ["player", "ai"];
      let totalHits = 0, totalKos = 0;
      for (const sd of sides) {
        const team = state.players[sd];
        for (let i = 0; i < team.field.length; i++) {
          const inst = team.field[i];
          if (!inst) continue;
          const dealt = Math.min(inst.currentHp, dmg);
          inst.currentHp -= dealt;
          totalHits++;
          if (inst.currentHp <= 0) {
            team.discard.push(inst.card);
            team.field[i] = null;
            totalKos++;
          }
        }
      }
      if (totalHits === 0) {
        return { ok: false, reason: "No Pokémon on the field to storm." };
      }
      consumeSpell(p, handIndex, card, cost);
      log(state, `⛈ ${card.name}: ${dmg} damage to ${totalHits} Pokémon (both sides)${totalKos > 0 ? ` — ${totalKos} KO` : ""}.`, "status");
      return { ok: true, spell: card, effect: "storm", damage: dmg, hits: totalHits, kos: totalKos };
    }

    // -------- BURST (slice 8) --------------------------------------
    // Cheap 1-energy direct damage. Like Bolt at half the cost but
    // less damage — common-rarity finisher for low-HP enemies.
    case "burst": {
      const r = requireEnemyTarget(state, side, spellTarget, "burst");
      if (r.err) return r.err;
      const dmg = Math.max(1, card.burstDamage || 3);
      const dealt = Math.min(r.enemy.currentHp, dmg);
      r.enemy.currentHp -= dealt;
      let kod = false;
      if (r.enemy.currentHp <= 0) {
        state.players[r.otherSide].discard.push(r.enemy.card);
        state.players[r.otherSide].field[spellTarget] = null;
        kod = true;
      }
      consumeSpell(p, handIndex, card, cost);
      log(state, `💥 ${card.name}: ${r.enemy.card.name} took ${dealt} damage${kod ? " — KO!" : ""}.`, kod ? "ko" : "status");
      return { ok: true, spell: card, effect: "burst", damage: dealt, knockedOut: kod, targetSide: r.otherSide, targetSlot: spellTarget, targetName: r.enemy.card.name };
    }

    // -------- BRAVE STRIKE (slice 8) -------------------------------
    // Self-damage for a big attack buff. Ally loses 50% of currentHp
    // (floor, min 1). powerStrikeBonus is set to attacker's own base
    // cardAttack — that doubles their next attack's damage (since the
    // bonus is added to attackBonus, effectively +100% on top of base).
    case "brave-strike": {
      const r = requireAllyTarget(state, side, spellTarget, "brave");
      if (r.err) return r.err;
      const selfDmg = Math.max(1, Math.floor(r.ally.currentHp * (card.braveSelfDamageFrac || 0.5)));
      r.ally.currentHp = Math.max(1, r.ally.currentHp - selfDmg);
      // Doubling = adding the base attack as a bonus.
      const baseAtk = r.ally.card?.cardAttack || 0;
      r.ally.powerStrikeBonus = (r.ally.powerStrikeBonus || 0) + baseAtk;
      consumeSpell(p, handIndex, card, cost);
      log(state, `💢 ${card.name}: ${r.ally.card.name} sacrificed ${selfDmg} HP for a doubled-power next attack!`, "status");
      return { ok: true, spell: card, effect: "brave-strike", targetSide: side, targetSlot: spellTarget, targetName: r.ally.card.name, selfDamage: selfDmg };
    }

    // -------- REFRESH (slice 8) ------------------------------------
    // Lighter Mass Heal: +2 HP to every ally on the field. Uncommon
    // tier, no target needed.
    case "refresh": {
      const amount = Math.max(1, card.refreshAmount || 2);
      const allies = p.field.filter((s) => s !== null);
      if (allies.length === 0) return { ok: false, reason: "No Pokémon on the field to refresh." };
      let total = 0;
      for (const ally of allies) {
        const cap = ally.maxHp ?? ally.card.cardHp;
        const before = ally.currentHp;
        ally.currentHp = Math.min(cap, ally.currentHp + amount);
        total += ally.currentHp - before;
      }
      consumeSpell(p, handIndex, card, cost);
      log(state, `🌿 ${card.name}: restored ${total} HP across ${allies.length} Pokémon.`, "status");
      return { ok: true, spell: card, effect: "refresh", healed: total, allies: allies.length };
    }

    // -------- DRAIN (slice 8) --------------------------------------
    // Damage one enemy AND heal your lowest-HP ally by the same amount.
    // If no allies on field, heals trainer HP instead.
    case "drain": {
      const r = requireEnemyTarget(state, side, spellTarget, "drain");
      if (r.err) return r.err;
      const dmg = Math.max(1, card.drainDamage || 3);
      const dealt = Math.min(r.enemy.currentHp, dmg);
      r.enemy.currentHp -= dealt;
      let kod = false;
      if (r.enemy.currentHp <= 0) {
        state.players[r.otherSide].discard.push(r.enemy.card);
        state.players[r.otherSide].field[spellTarget] = null;
        kod = true;
      }
      // Find lowest-HP ally to heal.
      let bestAlly = null, bestFrac = Infinity;
      for (const a of p.field) {
        if (!a) continue;
        const cap = a.maxHp ?? a.card.cardHp;
        const frac = a.currentHp / cap;
        if (frac < bestFrac) { bestFrac = frac; bestAlly = a; }
      }
      let healed = 0;
      if (bestAlly) {
        const cap = bestAlly.maxHp ?? bestAlly.card.cardHp;
        const before = bestAlly.currentHp;
        bestAlly.currentHp = Math.min(cap, bestAlly.currentHp + dealt);
        healed = bestAlly.currentHp - before;
      } else {
        // No allies → heal trainer HP.
        const maxTrainer = p.maxTrainerHp ?? 30;
        const before = p.trainerHp;
        p.trainerHp = Math.min(maxTrainer, p.trainerHp + dealt);
        healed = p.trainerHp - before;
      }
      consumeSpell(p, handIndex, card, cost);
      log(state, `🦇 ${card.name}: drained ${dealt} HP from ${r.enemy.card.name}${healed > 0 ? `, restored ${healed} to your side` : ""}.`, kod ? "ko" : "status");
      return { ok: true, spell: card, effect: "drain", damage: dealt, healed, knockedOut: kod, targetSide: r.otherSide, targetSlot: spellTarget, targetName: r.enemy.card.name };
    }

    // -------- STOP TIME (slice 7) -----------------------------------
    // Set a flag on the opposing player; the turn-end → next-player
    // switch checks it and skips their turn entirely (clearing the
    // flag on the way out). Legendary — high impact, expensive.
    case "stop-time": {
      const oppPlayer = state.players[otherSide];
      oppPlayer.skipNextTurn = true;
      consumeSpell(p, handIndex, card, cost);
      log(state, `⏸ ${card.name}: time freezes — opponent's next turn is skipped!`, "status");
      return { ok: true, spell: card, effect: "stop-time", targetSide: otherSide };
    }

    default:
      // Catalog effect that the engine hasn't been taught about yet.
      // Shouldn't be reachable while ACTIVE_EFFECTS gates the catalog,
      // but the safety net keeps any future addition from crashing.
      return { ok: false, reason: `${card.name} isn't ready to cast yet.` };
  }
}

export function playCard(state, side, handIndex, { rand = Math.random, replaceSlot = null, spellTarget = null } = {}) {
  if (state.winner) return { ok: false, reason: "game over" };
  if (state.activePlayer !== side) return { ok: false, reason: "not your turn" };
  if (state.phase !== "main") return { ok: false, reason: "wrong phase" };
  const p = state.players[side];
  const card = p.hand[handIndex];
  if (!card) return { ok: false, reason: "no such card" };
  const cost = effectiveCost(p, card);
  if (p.energy < cost) return { ok: false, reason: "not enough energy" };

  // Spell cards — branch BEFORE the field-slot machinery. Spells don't
  // get summoned; they trigger an immediate state effect and go to the
  // discard pile. The dispatcher returns its own result shape.
  if (card.kind === "spell") {
    return playSpellCard(state, side, handIndex, card, cost, { spellTarget });
  }

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
  { rand = Math.random, abilityId = "basic", forceCrit = false } = {},
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
  // Confusion (slice 8): 50% chance the attacker hits THEMSELVES this
  // strike. The check fires before the regular lockout / target / damage
  // pipeline so a confused attacker who self-hits doesn't also burn
  // through ability cost or deal damage to the chosen target.
  if (attackerInst.status?.kind === "confuse" && (rand() < 0.5)) {
    const baseAtk = attackerInst.card.cardAttack || 1;
    const selfDmg = Math.max(1, baseAtk);
    attackerInst.currentHp = Math.max(0, attackerInst.currentHp - selfDmg);
    log(state, `🌀 ${attackerInst.card.name} is confused — hit itself for ${selfDmg}!`, "status");
    attackerInst.attackedThisTurn = true;
    if (attackerInst.currentHp <= 0) {
      log(state, `${attackerInst.card.name} fainted in confusion!`, "ko");
      p.discard.push(attackerInst.card);
      p.field[fromSlot] = null;
    }
    return { ok: true, damage: selfDmg, multiplier: 1, verdict: { text: "Confusion!", tone: "miss" }, target: "self", selfHit: true, abilityId, abilityName: "Confused" };
  }
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
    // A slot is "guardian-routed" if either the CARD has Guardian
    // (legendary / tank / type-passive) OR the INSTANCE has been
    // turned into a Defender by the spell. Same routing rule applies
    // to both: opponents must clear guardians/defenders first.
    .filter(({ inst }) => inst && (isGuardian(inst.card) || inst.isDefender));
  if (guardians.length > 0 && target !== "trainer") {
    if (!guardians.some((g) => g.slot === target)) {
      return { ok: false, reason: "Must attack a Guardian (🛡) first" };
    }
  }

  // Per-difficulty AI combat bonus (Hard adds +1 ATK and +8% crit).
  // Hoisted here so BOTH the trainer-hit branch and the
  // Pokémon-vs-Pokémon branch can read it. Set by aiTakeTurnInner
  // at the start of each AI turn.
  const aiDifficultyAtk =
    side === "ai" && state.aiCombatBonus
      ? (state.aiCombatBonus.atkBonus || 0)
      : 0;
  const aiDifficultyCrit =
    side === "ai" && state.aiCombatBonus
      ? (state.aiCombatBonus.critBoost || 0)
      : 0;

  let result;
  if (target === "trainer") {
    if (hasField) {
      return { ok: false, reason: "must attack opposing Pokémon first" };
    }
    const comboBonus = comboBonusFor(p, attackerInst.card);
    const bossSideBonus = (side === "ai" && state.boss?.attackBonus) || 0;
    const base = attackerInst.card.cardAttack + attackBonus + (attackerInst.attackBoost || 0) + comboBonus + bossSideBonus + aiDifficultyAtk;
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
    if (defSig?.onPreHit && defSig.onPreHit(state, opponentSide, defenderInst, attackerInst)) {
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
    // Crit boost: signature passive (Zapdos Thunderstorm) + match
    // modifier (Crit Carnival) stack additively.
    const critBoost = fieldCritBonus(p.field) + (state.modifier_critBoost || 0);
    const ignoreDefenseFlag =
      sigPassive?.ignoreDefense ||
      (sigPassive?.ignoreDefenseSpecial && ability?.id === "special") ||
      (side === "ai" && state.boss?.ignoreDefense);
    // Boss-mode bonus: in story chapters, the boss's attacks get a flat
    // +attackBonus from active phase rules. (aiDifficultyAtk is hoisted
    // above the trainer/Pokémon branch so it's in scope for both.)
    const bossSideBonus = (side === "ai" && state.boss?.attackBonus) || 0;
    // Type-storm match modifier: cards of the rolled type get a flat
    // +N to abilityBonus when their primary type matches.
    let typeStormBonus = 0;
    if (state.modifier_typeAtkBonus
        && attackerInst.card.types?.[0] === state.modifier_typeAtkBonus.type) {
      typeStormBonus = state.modifier_typeAtkBonus.bonus || 0;
    }
    // Power Strike (slice 7): one-time +N attack bonus from a spell.
    // Consumed once and cleared regardless of hit/miss.
    const powerStrikeBonus = attackerInst.powerStrikeBonus || 0;
    if (powerStrikeBonus) {
      log(state, `⚔ ${attackerInst.card.name}'s Power Strike adds +${powerStrikeBonus} attack!`, "status");
      attackerInst.powerStrikeBonus = 0;
    }
    const calc = computeDamage(attackerInst.card, defenderInst.card, {
      abilityBonus:
        attackBonus +
        (attackerInst.attackBoost || 0) +
        pinchBonus +
        comboBonus +
        auraBonus -
        auraPenalty +
        bossSideBonus +
        typeStormBonus +
        powerStrikeBonus +
        aiDifficultyAtk,
      ability,
      rand,
      themeType: state.themeType || null,
      ignoreDefense: ignoreDefenseFlag,
      critBoost: critBoost + aiDifficultyCrit,
      forceCrit,
    });
    // Match-modifier damage multiplier (Glass Cannon / Iron Wall).
    if (state.modifier_damageMult && calc.multiplier !== 0) {
      calc.damage = Math.max(1, Math.round(calc.damage * state.modifier_damageMult));
    }
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
    // Solid Rock (Rhyperior): super-effective hits deal half damage.
    let solidRockApplied = false;
    if (defSig?.passive?.resistSuperEffective && calc.multiplier >= 2) {
      damageBase = Math.max(1, Math.round(damageBase / 2));
      solidRockApplied = true;
    }
    let damage = Math.max(calc.multiplier === 0 ? 0 : 1, damageBase - defReduction);
    // Shield (slice 7): if the defender's instance is shielded by a
    // prior Shield spell, the next incoming attack does 0 damage and
    // the shield is consumed.
    if (defenderInst.shieldedNext && damage > 0) {
      log(state, `🛡 ${defenderInst.card.name}'s Shield blocked the attack!`, "status");
      damage = 0;
      defenderInst.shieldedNext = false;
      calc.multiplier = 0;
      if (!calc.verdict?.text) calc.verdict = { text: "Shielded!", tone: "miss" };
    }
    defenderInst.currentHp = Math.max(0, defenderInst.currentHp - damage);
    // Counter (slice 7): if the defender was set to Counter the next
    // incoming attack, reflect the same damage back at the attacker
    // (after their hit lands — both Pokémon take the damage).
    if (defenderInst.counterNext && damage > 0) {
      defenderInst.counterNext = false;
      const reflected = Math.min(attackerInst.currentHp, damage);
      attackerInst.currentHp -= reflected;
      log(state, `↩ ${defenderInst.card.name}'s Counter reflects ${reflected} damage back!`, "status");
      if (attackerInst.currentHp <= 0) {
        log(state, `${attackerInst.card.name} fainted to its own reflected attack!`, "ko");
        p.discard.push(attackerInst.card);
        p.field[fromSlot] = null;
      }
    }
    if (multiscaleApplied) log(state, `🐉 ${defenderInst.card.name}'s Multiscale halved the blow.`, "status");
    if (solidRockApplied) log(state, `🪨 ${defenderInst.card.name}'s Solid Rock weakened the super-effective hit.`, "status");
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
      if (state.recap) {
        state.recap[side].kos += 1;
        // Per-Pokémon kill tracking for Card Mastery. The player-side
        // tally is posted to /me/mastery/bump at game-over.
        const m = state.recap[side].kosByPokemonId = state.recap[side].kosByPokemonId || {};
        const attackerId = attackerInst.card?.id;
        if (attackerId) m[attackerId] = (m[attackerId] || 0) + 1;
      }
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
        log(state, `⚡ ${attackerInst.card.name} grew stronger (L${lvls}, +1 HP, +1 ATK)`, "summon");
      }
      // Species evolution (slice 9): increment this-instance KO count
      // and transform if the chain says we should. Runs AFTER the
      // level-up bump so the evolved form inherits the snowball stats.
      attackerInst.kos = (attackerInst.kos || 0) + 1;
      const evolved = tryEvolveInstance(state, side, attackerInst);
      if (evolved) result.attackerEvolved = {
        fromName: attackerInst.justEvolved?.fromName,
        toName: attackerInst.justEvolved?.toName,
      };
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

  // Match-length governor: starting turn 30, both trainers take the
  // SAME damage at the SAME moment so the outcome is symmetric — if
  // both bars hit 0 on the same tick, the match resolves as a draw
  // (not "whoever's beginTurn ran first wins"). Schedule:
  //   T30-33  -1
  //   T34-37  -2
  //   T38+    -3 (cap)
  if (state.turn >= 30) {
    const tick = Math.min(3, Math.floor((state.turn - 30) / 4) + 1);
    state.players.player.trainerHp = Math.max(0, state.players.player.trainerHp - tick);
    state.players.ai.trainerHp     = Math.max(0, state.players.ai.trainerHp     - tick);
    log(state, `⏱ Stalemate (turn ${state.turn}): both trainers chip −${tick} HP simultaneously — end the match!`, "warn");
    const playerOut = state.players.player.trainerHp <= 0;
    const aiOut     = state.players.ai.trainerHp     <= 0;
    if (playerOut && aiOut) {
      state.winner = "tie";
      state.phase = "over";
      log(state, "Both trainers fell at the same instant — it's a draw!", "win");
      return;
    }
  }
  if (checkWinner(state)) return;

  // Switch sides.
  state.activePlayer = state.activePlayer === "player" ? "ai" : "player";
  // Stop Time: if the new active player has skipNextTurn set, consume
  // the flag and immediately switch back. This is the engine's
  // representation of "the opponent loses their turn entirely".
  const incoming = state.players[state.activePlayer];
  if (incoming?.skipNextTurn) {
    incoming.skipNextTurn = false;
    log(state, `⏸ ${incoming.name}'s turn is frozen in time — skipped!`, "status");
    state.activePlayer = state.activePlayer === "player" ? "ai" : "player";
  }
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

// Difficulty policies. Tuned from playtest feedback:
//   easy  → forgiving, lots of passes / skipped attacks for new players
//   medium → competent opponent (was reported "too easy"). Now picks
//             best-damage targets like Hard and never passes / never
//             skips attacks. Pokémon selection stays on "smart" (a
//             lighter heuristic than Hard's signature-aware pick) so
//             Medium still feels noticeably softer than Hard.
//   hard  → fully optimal. Signature-aware pick, best-dmg targets, no
//             pass / skip chance.
// Difficulty policies. Tuned from playtest feedback:
//   easy  → forgiving, lots of passes / skipped attacks for new players
//   medium → competent: bestDmg targets, never skips, "smart" card pick
//             (lighter heuristic than Hard's signature-aware version)
//   hard  → fully optimal play + small combat bonuses (+1 ATK, +8% crit
//             chance on AI strikes). The bonuses make every Hard fight
//             noticeably tighter without crushing — most attacks still
//             follow the same type-chart math, just with extra bite.
//
// Per-policy combat bonuses (read by attack() when side === "ai"):
//   atkBonus   → flat damage bonus on every AI attack
//   critBoost  → additive crit chance (0.08 = +8%)
const POLICIES = {
  easy:   { pickCard: "cheapest",  pickTarget: "random",   passPlayChance: 0.55, skipAttackChance: 0.4,  useTypeEff: false, useSpecial: false,        atkBonus: 0, critBoost: 0 },
  medium: { pickCard: "smart",     pickTarget: "bestDmg",  passPlayChance: 0,    skipAttackChance: 0,    useTypeEff: true,  useSpecial: "sometimes",  atkBonus: 0, critBoost: 0 },
  hard:   { pickCard: "smartSig",  pickTarget: "bestDmg",  passPlayChance: 0,    skipAttackChance: 0,    useTypeEff: true,  useSpecial: "smart",      atkBonus: 1, critBoost: 0.08 },
};

// True if a spell can actually do something useful given the current
// board state. Used by the AI to skip a spell when its target type is
// absent (Heal with no allies, AOE with no enemies, etc.) — playing
// it anyway would either fail at the engine or burn the card on
// nothing.
//
// Offensive spells (freeze/paralyze/aoe) additionally require the AI
// to have at least one Pokémon on the field. Regression fix: without
// this gate the AI sometimes spent all its energy on Freeze early in
// the match before summoning a single attacker, leaving the attack
// phase with nothing to fire and making it look like "the AI didn't
// attack this turn" to the player.
export function spellPlayable(card, ai, opp) {
  if (card.kind !== "spell") return true;
  const aiHasField = ai?.field?.some((s) => s !== null) ?? false;
  const oppHasField = opp?.field?.some((s) => s !== null) ?? false;
  switch (card.effect) {
    case "freeze":
    case "paralyze":
    case "sleep-powder":
      return aiHasField && oppHasField;
    case "bolt":
      // Direct damage — at least one enemy must exist. AI-field gate
      // matches the other offensive spells so we don't burn a Bolt
      // before deploying anything to attack with afterwards.
      return aiHasField && oppHasField;
    case "aoe":
      // Worth burning the 4-energy spell only if 2+ enemies share the
      // board AND the AI has its own attackers to follow up.
      return aiHasField && ((opp?.field?.filter((s) => s !== null).length || 0) >= 2);
    case "heal":
      return ai?.field?.some((s) => s !== null && s.currentHp < (s.maxHp ?? s.card?.cardHp ?? 1)) ?? false;
    case "cleanse":
      return ai?.field?.some((s) => s !== null && s.status?.kind) ?? false;
    case "defender":
    case "evolve":
      return aiHasField;
    case "surge":
      // Only worth playing if we'd actually GAIN energy (already at
      // cap = pure waste). Also need to be able to afford the cost.
      return (ai?.energy ?? 0) < (ai?.maxEnergy ?? 10);
    case "scout":
      // Card draw is wasted if the deck is empty OR hand is full.
      return (ai?.deck?.length ?? 0) > 0 && (ai?.hand?.length ?? 0) < 10;
    case "phoenix":
      // Need a fainted Pokémon (in discard, non-spell) AND room on
      // the field to revive into.
      return ai?.discard?.some((c) => c?.kind !== "spell")
          && ai?.field?.some((s) => s === null);
    case "burn":
      return aiHasField && oppHasField;
    case "shield":
    case "power-strike":
    case "counter":
      return aiHasField;
    case "mass-heal":
      // Worth playing if at least one ally is below max HP. Wasted
      // otherwise (caps at maxHp).
      return ai?.field?.some((s) => s !== null && s.currentHp < (s.maxHp ?? s.card?.cardHp ?? 1)) ?? false;
    case "stop-time":
      // 5-energy legendary — high impact. Only worth it when the
      // opponent has at least one attacker on the board, otherwise
      // skipping their turn doesn't deny them anything.
      return oppHasField;
    case "confusion":
    case "burst":
    case "drain":
      return aiHasField && oppHasField;
    case "storm":
      // Worth it if THEIR board has more / equal Pokémon than ours
      // (otherwise we hurt ourselves net).
      return ((opp?.field?.filter((s) => s !== null).length || 0)
            >= (ai?.field?.filter((s) => s !== null).length || 0))
        && oppHasField;
    case "brave-strike":
      // Need an ally with enough HP to survive the self-damage
      // (>1 HP) AND an enemy to clobber afterwards.
      return ai?.field?.some((s) => s !== null && s.currentHp > 1)
        && oppHasField;
    case "refresh":
      return ai?.field?.some((s) => s !== null && s.currentHp < (s.maxHp ?? s.card?.cardHp ?? 1)) ?? false;
    default:
      return false;
  }
}

// Pick the best target slot for a spell given the current board.
// Returns a slot index for targeted spells, or null for AOE / unknown.
// Strategy per effect:
//   freeze/paralyze → highest effective-attack enemy (shut down their hitter)
//   heal            → lowest HP fraction ally (most efficient heal)
//   defender/evolve → highest base-attack ally (protect/boost the threat)
//   aoe             → no target needed
function aiPickSpellTarget(state, side, card) {
  const ai = state.players[side];
  const opp = state.players[side === "ai" ? "player" : "ai"];
  const enemyField = opp.field;
  const allyField  = ai.field;
  switch (card.effect) {
    case "freeze":
    case "paralyze":
    case "sleep-powder": {
      // Lock the enemy with the highest effective attack — disrupts
      // their biggest threat for a turn.
      let best = null, bestScore = -Infinity;
      for (let i = 0; i < enemyField.length; i++) {
        const e = enemyField[i];
        if (!e) continue;
        const atk = (e.card?.cardAttack || 0) + (e.attackBoost || 0);
        if (atk > bestScore) { bestScore = atk; best = i; }
      }
      return best;
    }
    case "bolt": {
      // Pick the lowest-HP enemy to finish them off (≤5 HP = KO).
      let best = null, bestHp = Infinity;
      for (let i = 0; i < enemyField.length; i++) {
        const e = enemyField[i];
        if (!e) continue;
        if (e.currentHp < bestHp) { bestHp = e.currentHp; best = i; }
      }
      return best;
    }
    case "heal": {
      let best = null, bestFrac = Infinity;
      for (let i = 0; i < allyField.length; i++) {
        const a = allyField[i];
        if (!a) continue;
        const cap = a.maxHp ?? a.card?.cardHp ?? 1;
        const frac = a.currentHp / cap;
        if (frac < bestFrac) { bestFrac = frac; best = i; }
      }
      return best;
    }
    case "cleanse": {
      // First ally with any status. Status comparison is binary —
      // we don't try to rank them.
      for (let i = 0; i < allyField.length; i++) {
        if (allyField[i]?.status?.kind) return i;
      }
      return null;
    }
    case "defender":
    case "evolve": {
      let best = null, bestScore = -Infinity;
      for (let i = 0; i < allyField.length; i++) {
        const a = allyField[i];
        if (!a) continue;
        const atk = (a.card?.cardAttack || 0) + (a.attackBoost || 0);
        if (atk > bestScore) { bestScore = atk; best = i; }
      }
      return best;
    }
    case "burn": {
      // Burn the highest-attack enemy so chip damage chases them down.
      let best = null, bestScore = -Infinity;
      for (let i = 0; i < enemyField.length; i++) {
        const e = enemyField[i];
        if (!e) continue;
        const atk = (e.card?.cardAttack || 0) + (e.attackBoost || 0);
        if (atk > bestScore) { bestScore = atk; best = i; }
      }
      return best;
    }
    case "shield":
    case "counter":
    case "power-strike":
    case "brave-strike": {
      // Pick the ally with the highest base attack (the one most
      // likely to be a target / get an attack off).
      let best = null, bestScore = -Infinity;
      for (let i = 0; i < allyField.length; i++) {
        const a = allyField[i];
        if (!a) continue;
        if (card.effect === "brave-strike" && a.currentHp <= 1) continue;
        const atk = (a.card?.cardAttack || 0) + (a.attackBoost || 0);
        if (atk > bestScore) { bestScore = atk; best = i; }
      }
      return best;
    }
    case "confusion": {
      // Same as freeze/paralyze — disable the strongest enemy threat.
      let best = null, bestScore = -Infinity;
      for (let i = 0; i < enemyField.length; i++) {
        const e = enemyField[i];
        if (!e) continue;
        const atk = (e.card?.cardAttack || 0) + (e.attackBoost || 0);
        if (atk > bestScore) { bestScore = atk; best = i; }
      }
      return best;
    }
    case "burst":
    case "drain": {
      // Lowest-HP enemy (finisher), same as Bolt.
      let best = null, bestHp = Infinity;
      for (let i = 0; i < enemyField.length; i++) {
        const e = enemyField[i];
        if (!e) continue;
        if (e.currentHp < bestHp) { bestHp = e.currentHp; best = i; }
      }
      return best;
    }
    case "aoe":
    case "surge":
    case "scout":
    case "phoenix":
    case "mass-heal":
    case "stop-time":
    case "storm":
    case "refresh":
    default:
      // No target slot — caller passes spellTarget: null.
      return null;
  }
}

function chooseHandIndex(ai, policy, rand, state = null) {
  const opp = state?.players?.player;
  const candidates = ai.hand
    .map((c, idx) => ({ c, idx, cost: effectiveCost(ai, c) }))
    // A spell is a candidate only if it'd be useful given the board.
    // A non-spell Pokémon is always a candidate (subject to the energy
    // gate below).
    .filter((x) => spellPlayable(x.c, ai, opp))
    .filter((x) => x.cost <= ai.energy);
  if (candidates.length === 0) return -1;
  switch (policy.pickCard) {
    case "cheapest":
      candidates.sort((a, b) => a.cost - b.cost);
      return candidates[0].idx;
    case "expensive":
      candidates.sort((a, b) => b.cost - a.cost);
      return candidates[0].idx;
    case "smartSig": {
      // Hard AI: score each playable card by its signature/passive value
      // against the current board state.  Higher score wins.
      const opp = state?.players?.player;
      candidates.sort((a, b) => scoreCardForSummon(ai, opp, b.c) - scoreCardForSummon(ai, opp, a.c));
      return candidates[0].idx;
    }
    case "smart": {
    // Medium: similar but lighter weights — picks expensive most of the
      // time, with a small situational tilt toward useful signatures.
      const oppM = state?.players?.player;
      candidates.sort((a, b) => {
        const scoreA = (a.cost * 2) + (signatureFor(a.c) ? 2 : 0) + matchupBonus(a.c, oppM);
        const scoreB = (b.cost * 2) + (signatureFor(b.c) ? 2 : 0) + matchupBonus(b.c, oppM);
        return scoreB - scoreA;
      });
      return candidates[0].idx;
    }
    case "random":
    default:
      return candidates[Math.floor(rand() * candidates.length)].idx;
  }
}

// Weight a hand card by how useful its on-summon / passive / aura would be
// right now given the board state.  Higher = better drop.
export function scoreCardForSummon(ai, opp, card) {
  let score = (card.energyCost || 1) * 3;
  const sig = signatureFor(card);
  const enemyCount = opp ? opp.field.filter(Boolean).length : 0;
  const allyCount  = ai.field.filter(Boolean).length;
  const damagedAllies = ai.field.filter((a) => a && a.currentHp < (a.maxHp ?? a.card.cardHp)).length;

  if (sig) {
    score += 4; // baseline "has a signature"
    const desc = (sig.desc || "").toLowerCase();
    const name = (sig.name || "").toLowerCase();
    if (sig.onSummon) {
      if (/damage|hit|deal|strike|psychic|shock|hex|hydro|pulse|force|sight|sandstorm/.test(desc)) score += enemyCount * 5;
      if (/heal|restore|recover|moonlight|aurora|soft.?boiled|continent/.test(desc + " " + name)) score += damagedAllies * 5;
      if (/sleep|paralyze|burn|curse|veil|kiss/.test(desc + " " + name)) score += enemyCount * 3;
      if (/grants|buff|max hp|\+\d+\s*atk|geomancy|mimicry|charge/.test(desc + " " + name)) score += allyCount * 3;
    }
    if (sig.passive) score += 5;       // Multiscale / Iron Defense / etc.
    if (sig.fieldAura) score += 4;     // Drizzle / Drought / aura buffs
    if (sig.onTurnStart) score += 4;   // Recover / Ascent / Sandstorm tick
  }
  // Type matchup vs current enemies on field — drop type-effective cards.
  score += matchupBonus(card, opp);
  return score;
}

export function matchupBonus(card, opp) {
  if (!opp) return 0;
  let bonus = 0;
  const type = card.types?.[0];
  for (const e of opp.field) {
    if (!e) continue;
    const m = getMultiplier(type, e.card?.types || []);
    if (m >= 2) bonus += 3;
    else if (m === 0) bonus += 4;
    else if (m < 1) bonus -= 1;
  }
  return bonus;
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

// ---------------------------------------------------------------------------
// Boss mode (story chapters) — additional rules layered on top of the regular
// 1v1 engine. State carries `state.boss = { displayName, maxHp, phaseRules,
// summonCards, attackBonus, ignoreDefense }` when a story fight is in flight.
// `phaseRules` is an array of { fromHpFraction, effects: [{kind, ...}] }
// sorted high-fraction → low. Each rule has an `applied` flag set once its
// threshold is crossed so effects fire exactly once per match.
// ---------------------------------------------------------------------------
function applyBossPhaseChecks(state) {
  const rules = state.boss?.phaseRules;
  if (!rules || !rules.length) return;
  const ai = state.players.ai;
  const max = state.boss.maxHp || ai.trainerHp || 30;
  const frac = ai.trainerHp / max;
  for (const rule of rules) {
    if (rule.applied) continue;
    if (frac > rule.fromHpFraction) continue; // not yet crossed
    rule.applied = true;
    for (const eff of rule.effects || []) applyBossEffect(state, eff);
  }
}

function applyBossEffect(state, eff) {
  const ai = state.players.ai;
  const bossName = state.boss?.displayName || "Boss";
  switch (eff.kind) {
    case "buff":
      state.boss.attackBonus = (state.boss.attackBonus || 0) + (eff.amount || 1);
      log(state, `⚡ ${bossName} surges — all attacks +${eff.amount || 1} ATK!`, "boss-move");
      break;
    case "ignoreDef":
      state.boss.ignoreDefense = true;
      log(state, `🔥 ${bossName}'s attacks now pierce defenses!`, "boss-move");
      break;
    case "summon": {
      let n = 0;
      for (const id of (eff.pokemonIds || [])) {
        const c = state.boss?.summonCards?.[id];
        if (c && ai.hand.length < MAX_HAND) { ai.hand.push(c); n++; }
      }
      if (eff.note) log(state, eff.note, "boss-move");
      else if (n) log(state, `${bossName} called in reinforcements!`, "boss-move");
      break;
    }
    case "aoe": {
      const dmg = eff.amount || 3;
      let hits = 0;
      const p = state.players.player;
      for (let i = 0; i < p.field.length; i++) {
        const inst = p.field[i];
        if (!inst) continue;
        inst.currentHp = Math.max(0, inst.currentHp - dmg);
        hits++;
        if (inst.currentHp <= 0) {
          p.discard.push(inst.card);
          p.field[i] = null;
          log(state, `${inst.card.name} fainted!`, "ko");
        }
      }
      if (hits) log(state, `💥 ${bossName}'s wave hit ${hits} of your Pokémon for ${dmg}!`, "boss-move");
      break;
    }
    case "transform":
      state.boss.displayName = eff.displayName || bossName;
      // Buff the boss's anchor card on the field if present.
      for (const inst of ai.field) {
        if (!inst) continue;
        if (inst.card?.is_legendary) {
          inst.attackBoost = (inst.attackBoost || 0) + (eff.attackBonus || 0);
          inst.maxHp += (eff.attackBonus || 0) * 2;
          inst.currentHp += (eff.attackBonus || 0) * 2;
        }
      }
      // Stack a permanent global +attackBonus so even non-anchor cards feel the shift.
      state.boss.attackBonus = (state.boss.attackBonus || 0) + Math.max(1, Math.round((eff.attackBonus || 0) / 2));
      if (eff.note) log(state, eff.note, "boss-move");
      break;
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
  // Guard: if a spell (Stop Time) flipped control back to the player
  // during endTurn, the caller may still hand us a state where it's
  // NOT the AI's turn. Bail out early — running through the play/
  // attack/endTurn pipeline would mistakenly hand the AI a real
  // turn (and re-start the AI's countdown timer).
  if (state.activePlayer !== "ai" || state.winner) {
    if (onAction) await onAction({ kind: "skipped" });
    return;
  }
  const policy = POLICIES[difficulty] || POLICIES.medium;
  // Cache the per-difficulty combat bonus on state so attack() can
  // read it without plumbing difficulty through every call site.
  // Re-set every turn so it stays in sync if difficulty ever changes
  // mid-match (boss fights override this with their own attack bonus).
  state.aiCombatBonus = {
    atkBonus:  policy.atkBonus  || 0,
    critBoost: policy.critBoost || 0,
  };
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
  // The passPlayChance roll is gated on `playsThisTurn > 0` so the AI always
  // attempts at least one summon when it has the energy + a slot; otherwise
  // ~6% of medium-mode turns ended with the AI sitting on a full hand for no
  // visible reason. If the field is full but the AI has a clear upgrade (the
  // best hand card outscores the worst board card), it sacrifices to replace.
  let playsThisTurn = 0;
  for (let safety = 0; safety < 10; safety++) {
    if (state.phase !== "main") break;
    if (playsThisTurn > 0 && rand() < policy.passPlayChance) break;

    const idx = chooseHandIndex(ai, policy, rand, state);
    if (idx === -1) break;
    const handCard = ai.hand[idx];

    // Spell cards route through their own dispatch path — no field
    // slot, no replace. aiPickSpellTarget walks the board to pick the
    // best slot for each effect (or null for AOE).
    if (handCard.kind === "spell") {
      const spellTarget = aiPickSpellTarget(state, "ai", handCard);
      const r = playCard(state, "ai", idx, { rand, spellTarget });
      if (!r.ok) break;
      playsThisTurn++;
      if (onAction) {
        await onAction({
          kind: "spell",
          spell: r.spell,
          effect: r.effect,
          targetSide: r.targetSide,
          targetSlot: r.targetSlot,
        });
      }
      continue;
    }

    // Pokémon summon — needs a field slot. If full, the smart
    // policies may sacrifice the weakest current board card to make
    // room; easier policies just stop summoning when the board is full.
    let replaceSlot = null;
    if (emptySlot(ai.field) === -1) {
      if (policy.pickCard !== "smartSig" && policy.pickCard !== "smart") break;
      const handScore = scoreCardForSummon(ai, state.players.player, handCard);
      let worstSlot = -1;
      let worstScore = Infinity;
      for (let i = 0; i < ai.field.length; i++) {
        const inst = ai.field[i];
        if (!inst) continue;
        const score = scoreCardForSummon(ai, state.players.player, inst.card) - 6;
        const hpFrac = inst.currentHp / ((inst.maxHp ?? inst.card.cardHp) || 1);
        const adj = score - (1 - hpFrac) * 5;
        if (adj < worstScore) { worstScore = adj; worstSlot = i; }
      }
      if (worstSlot === -1 || handScore <= worstScore + 4) break;
      replaceSlot = worstSlot;
    }
    const r = playCard(state, "ai", idx, { rand, replaceSlot });
    if (!r.ok) break;
    playsThisTurn++;
    if (onAction) {
      await onAction({
        kind: "summon",
        slot: r.slot,
        instance: r.instance,
        replaced: replaceSlot != null,
      });
    }
  }

  // Before the attack loop: log a "still asleep / frozen / paralyzed"
  // line for each locked-out Pokémon. Otherwise a player who cast
  // Sleep Powder sees the AI's turn pass silently and can't tell the
  // disruption worked. Fires once per AI turn (outside the safety
  // retry loop).
  for (const inst of ai.field) {
    if (!inst || !isLockedOut(inst)) continue;
    const k = inst.status?.kind || "lock";
    const phrase = k === "sleep"    ? "fast asleep"
                 : k === "freeze"   ? "frozen solid"
                 : k === "paralyze" ? "paralyzed"
                 : k;
    log(state, `${inst.card.name} is ${phrase} — can't move this turn!`, "status");
  }
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
  // Guard the endTurn the same way the top of this function does. If
  // control already left the AI (player-side timeout force-end, Stop
  // Time bounce, etc.), calling endTurn would flip the turn AGAIN and
  // leave the AI as activePlayer with nobody scheduled to play —
  // the "rival is stuck thinking" symptom.
  if (state.activePlayer === "ai" && !state.winner) {
    endTurn(state);
  }
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
