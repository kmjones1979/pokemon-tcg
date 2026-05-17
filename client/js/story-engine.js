// Story-mode game engine. Three sides: p1, p2, boss.
//
// Co-op: p1 and p2 are both human-allied. Each has independent HP (trainerHp),
// hand, deck, energy, and field. The boss has a single HP pool and a scripted
// phase/move pattern. Turn order: p1 → p2 → boss → p1 …
//
// In solo mode, p2 is AI-controlled (a Lucario-style "partner") and plays
// automatically when its turn comes up. In coop mode, the server expects an
// action from a second authenticated player.
//
// Win:  boss.hp ≤ 0 (team victory)
// Lose: both p1.trainerHp ≤ 0 AND p2.trainerHp ≤ 0 (team defeat)
//
// State shape (intentionally kept JSON-serializable):
// {
//   mode: 'story',
//   chapterId,
//   turn,
//   activeSide: 'p1' | 'p2' | 'boss',
//   phase: 'play' | 'over',
//   winner: null | 'team' | 'boss',
//   log: [{ id, text, kind }],
//   players: { p1: PlayerState, p2: PlayerState },
//   boss: BossState,
// }

import { computeDamage } from "./battle.js";

const FIELD_SIZE = 3;
const STARTING_HAND = 4;
const TRAINER_HP = 25;
const MAX_ENERGY = 10;

let _ic = 0;
const nextInstanceId = () => `s${++_ic}`;

function shuffle(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function logLine(state, text, kind = "info") {
  state.log.push({ id: state.log.length + 1, text, kind });
  if (state.log.length > 80) state.log.shift();
}

function instantiate(card) {
  const cardHp = card.cardHp || 1;
  return {
    instanceId: nextInstanceId(),
    card,
    currentHp: cardHp,
    maxHp: cardHp,
    summoningSickness: true,
    status: null,
  };
}

function makeBossCard(spec) {
  return {
    id: -1,
    name: spec.displayName,
    types: spec.types,
    cardHp: spec.maxHp,
    cardAttack: spec.attack,
    raw: { defense: spec.defense * 30, sp_defense: spec.defense * 30 },
    is_legendary: true,
    sprite_front: null, // client looks up by anchorPokemonId
  };
}

// Public entry: build initial state.
//   { chapter, p1: {displayName, deck, ability, isAi}, p2: {...} }
export function createStory({ chapter, p1, p2 }) {
  const p1Deck = shuffle(p1.deck);
  const p2Deck = shuffle(p2.deck);
  const state = {
    mode: "story",
    chapterId: chapter.id,
    chapterName: chapter.name,
    locale: chapter.locale,
    turn: 1,
    activeSide: "p1",
    phase: "play",
    winner: null,
    log: [],
    players: {
      p1: {
        displayName: p1.displayName || "Player 1",
        ability: p1.ability || "brock",
        isAi: !!p1.isAi,
        trainerHp: TRAINER_HP,
        maxTrainerHp: TRAINER_HP,
        energy: 1,
        maxEnergy: 1,
        deck: p1Deck.slice(STARTING_HAND),
        hand: p1Deck.slice(0, STARTING_HAND),
        field: new Array(FIELD_SIZE).fill(null),
        discard: [],
      },
      p2: {
        displayName: p2.displayName || "Player 2",
        ability: p2.ability || "erika",
        isAi: !!p2.isAi,
        trainerHp: TRAINER_HP,
        maxTrainerHp: TRAINER_HP,
        energy: 1,
        maxEnergy: 1,
        deck: p2Deck.slice(STARTING_HAND),
        hand: p2Deck.slice(0, STARTING_HAND),
        field: new Array(FIELD_SIZE).fill(null),
        discard: [],
      },
    },
    boss: {
      anchorPokemonId: chapter.boss.anchorPokemonId,
      displayName: chapter.boss.displayName,
      types: chapter.boss.types,
      hp: chapter.boss.maxHp,
      maxHp: chapter.boss.maxHp,
      baseAttack: chapter.boss.attack,
      baseDefense: chapter.boss.defense,
      phaseIndex: 0,
      moveIndex: 0,
      transformed: false,
      rechargingNext: false,
      minions: [], // boss summons fill this
      attackBonus: 0,
      ignoreDefense: false,
    },
    chapter: {
      id: chapter.id,
      name: chapter.name,
      locale: chapter.locale,
      isFinale: !!chapter.isFinale,
      enemyTrainerName: chapter.enemyTrainerName,
    },
  };
  // Apply phase 0 modifiers immediately.
  applyPhase(state, 0, chapter);
  logLine(state, `Chapter: ${chapter.name}.`, "story");
  logLine(state, `${chapter.enemyTrainerName} blocks the way!`, "story");
  return state;
}

function applyPhase(state, idx, chapter) {
  const phase = chapter.boss.phases[idx];
  if (!phase) return;
  state.boss.phaseIndex = idx;
  state.boss.moveIndex = 0;
  state.boss.attackBonus = phase.attackBonus || 0;
  state.boss.ignoreDefense = !!phase.ignoreDefense;
  state.boss._pattern = phase.attackPattern.slice();
  if (phase.summonOnEntry?.note) {
    logLine(state, phase.summonOnEntry.note, "story");
  }
  if (phase.summonOnEntry?.pokemonIds?.length && state.minionPokedex) {
    // The server should populate minionPokedex with the lookup map; client
    // pass-through ignores this if absent.
    for (const id of phase.summonOnEntry.pokemonIds) {
      const row = state.minionPokedex.get?.(id);
      if (row) {
        state.boss.minions.push({
          instanceId: nextInstanceId(),
          pokemonId: id,
          name: row.name,
          types: row.types,
          currentHp: Math.max(8, Math.round((row.hp || 40) / 6)),
          attack: Math.max(2, Math.round(((row.attack || 0) + (row.sp_attack || 0)) / 30)),
          summoningSickness: true,
        });
      }
    }
  }
}

// Mid-fight evolution support (Onix → Steelix in chapter 2).
function maybeTransform(state, chapter) {
  if (state.boss.transformed) return;
  const tr = chapter.boss.transformTo;
  if (!tr) return;
  if (state.boss.hp / state.boss.maxHp <= (chapter.boss.transformAt || 0.5)) {
    state.boss.transformed = true;
    state.boss.anchorPokemonId = tr.anchorPokemonId;
    state.boss.displayName = tr.displayName;
    state.boss.types = tr.types;
    state.boss.baseAttack += tr.attackBonus || 0;
    state.boss.baseDefense += tr.defenseBonus || 0;
    logLine(state, tr.flavor, "story");
  }
}

// Phase advancement: when boss HP crosses a threshold, advance to the next phase.
function maybeAdvancePhase(state, chapter) {
  const ratio = state.boss.hp / state.boss.maxHp;
  const phases = chapter.boss.phases;
  for (let i = phases.length - 1; i > state.boss.phaseIndex; i--) {
    if (ratio <= phases[i].fromHpFraction) {
      applyPhase(state, i, chapter);
      return;
    }
  }
}

// ---------- Player actions ----------

export function playCard(state, side, handIndex, { replaceSlot = null } = {}) {
  if (state.winner) return { ok: false, reason: "Match is over." };
  if (state.activeSide !== side) return { ok: false, reason: "Not your turn." };
  const p = state.players[side];
  if (!p) return { ok: false, reason: "Bad side." };
  const card = p.hand[handIndex];
  if (!card) return { ok: false, reason: "No such card." };
  const cost = card.energyCost || 1;
  if (p.energy < cost) return { ok: false, reason: "Not enough energy." };

  let slot = -1;
  if (replaceSlot != null && p.field[replaceSlot]) {
    const dead = p.field[replaceSlot];
    p.discard.push(dead.card);
    logLine(state, `${p.displayName} swaps out ${dead.card.name} for ${card.name}.`, "play");
    slot = replaceSlot;
  } else {
    slot = p.field.findIndex((s) => s === null);
    if (slot < 0) return { ok: false, reason: "Field full — pick a slot to replace." };
  }
  p.field[slot] = instantiate(card);
  p.hand.splice(handIndex, 1);
  p.energy -= cost;
  logLine(state, `${p.displayName} sends out ${card.name}!`, "play");
  return { ok: true, slot, instance: p.field[slot] };
}

// Attack the boss (or a minion). target = { kind: "boss" } | { kind: "minion", index }
export function attack(state, side, fromSlot, target = { kind: "boss" }) {
  if (state.winner) return { ok: false, reason: "Match is over." };
  if (state.activeSide !== side) return { ok: false, reason: "Not your turn." };
  const p = state.players[side];
  const inst = p.field[fromSlot];
  if (!inst) return { ok: false, reason: "Empty slot." };
  if (inst.summoningSickness) return { ok: false, reason: "Summoning sickness." };
  if (inst.hasAttackedThisTurn) return { ok: false, reason: "Already attacked." };
  if (inst.currentHp <= 0) return { ok: false, reason: "Knocked out." };

  let damageOut;
  if (target.kind === "boss") {
    const defender = makeBossCard({
      displayName: state.boss.displayName,
      types: state.boss.types,
      maxHp: state.boss.hp,
      attack: state.boss.baseAttack,
      defense: state.boss.baseDefense,
    });
    const result = computeDamage(inst.card, defender, { rand: Math.random });
    state.boss.hp = Math.max(0, state.boss.hp - result.damage);
    damageOut = { ...result, targetKind: "boss" };
    logLine(
      state,
      `${inst.card.name} hits ${state.boss.displayName} for ${result.damage}${result.critical ? " CRIT" : ""}!`,
      "attack",
    );
    if (state.boss.hp <= 0) {
      state.winner = "team";
      state.phase = "over";
      logLine(state, `${state.boss.displayName} has been defeated!`, "win");
    }
  } else if (target.kind === "minion") {
    const minion = state.boss.minions[target.index];
    if (!minion) return { ok: false, reason: "No such minion." };
    const defender = { types: minion.types, cardHp: minion.currentHp, cardAttack: minion.attack, raw: { defense: 0, sp_defense: 0 } };
    const result = computeDamage(inst.card, defender, { rand: Math.random });
    minion.currentHp = Math.max(0, minion.currentHp - result.damage);
    damageOut = { ...result, targetKind: "minion", targetIndex: target.index };
    logLine(state, `${inst.card.name} hits ${minion.name} for ${result.damage}!`, "attack");
    if (minion.currentHp <= 0) {
      logLine(state, `${minion.name} fell.`, "ko");
      state.boss.minions.splice(target.index, 1);
    }
  }
  inst.hasAttackedThisTurn = true;
  return { ok: true, ...damageOut };
}

export function endTurn(state, side, chapter) {
  if (state.winner) return { ok: false, reason: "Match is over." };
  if (state.activeSide !== side) return { ok: false, reason: "Not your turn." };
  // p1 → p2 → boss → p1 …
  if (side === "p1") {
    state.activeSide = "p2";
    beginPlayerTurn(state, "p2");
  } else if (side === "p2") {
    state.activeSide = "boss";
    runBossTurn(state, chapter);
    if (!state.winner) {
      state.activeSide = "p1";
      state.turn += 1;
      beginPlayerTurn(state, "p1");
    }
  }
  return { ok: true };
}

function beginPlayerTurn(state, side) {
  const p = state.players[side];
  // Draw 1 if possible.
  if (p.deck.length) {
    const drawn = p.deck.shift();
    if (p.hand.length < 10) p.hand.push(drawn);
    else p.discard.push(drawn);
  }
  // +1 max energy each round, refill.
  if (p.maxEnergy < MAX_ENERGY) p.maxEnergy += 1;
  p.energy = p.maxEnergy;
  // Clear summoning sickness + per-turn flags.
  for (const inst of p.field) {
    if (!inst) continue;
    inst.summoningSickness = false;
    inst.hasAttackedThisTurn = false;
  }
  logLine(state, `${p.displayName}'s turn.`, "turn");
}

// ---------- Boss turn ----------

function runBossTurn(state, chapter) {
  maybeTransform(state, chapter);
  maybeAdvancePhase(state, chapter);

  if (state.boss.rechargingNext) {
    logLine(state, `${state.boss.displayName} is recharging…`, "story");
    state.boss.rechargingNext = false;
  } else {
    const pattern = state.boss._pattern || chapter.boss.phases[state.boss.phaseIndex].attackPattern;
    const moveKey = pattern[state.boss.moveIndex % pattern.length];
    state.boss.moveIndex += 1;
    const move = chapter.boss.moves[moveKey];
    if (move) executeBossMove(state, move, chapter);
  }

  // Minions also attack each turn (target alternating players).
  for (let i = 0; i < state.boss.minions.length; i++) {
    const m = state.boss.minions[i];
    if (m.summoningSickness) { m.summoningSickness = false; continue; }
    const targetSide = (state.turn + i) % 2 === 0 ? "p1" : "p2";
    dealAttackToPlayer(state, targetSide, m.attack, `${m.name} attacks ${state.players[targetSide].displayName}`);
  }

  // Check team-defeat.
  if (state.players.p1.trainerHp <= 0 && state.players.p2.trainerHp <= 0) {
    state.winner = "boss";
    state.phase = "over";
    logLine(state, `Both trainers have fallen. ${state.boss.displayName} stands triumphant.`, "loss");
  }
}

function executeBossMove(state, move, chapter) {
  logLine(state, `${state.boss.displayName} used ${move.name}!`, "boss-move");
  if (move.flavor) logLine(state, move.flavor, "story");

  if (move.selfHeal) {
    const before = state.boss.hp;
    state.boss.hp = Math.min(state.boss.maxHp, state.boss.hp + move.selfHeal);
    logLine(state, `${state.boss.displayName} recovered ${state.boss.hp - before} HP.`, "heal");
    return;
  }
  if (move.selfBuff) {
    state.boss.attackBonus = (state.boss.attackBonus || 0) + 2;
    logLine(state, `${state.boss.displayName}'s attack rose!`, "story");
    return;
  }
  const rawAttack = (state.boss.baseAttack + (state.boss.attackBonus || 0)) * (move.power || 1);
  if (move.target === "all") {
    // Hits a card on each player's field, plus splash to each trainer HP.
    for (const side of ["p1", "p2"]) {
      hitFrontline(state, side, rawAttack, chapter);
      dealAttackToPlayer(state, side, 2, `Splash damage`);
    }
  } else {
    // Pick the player with the most cards on field (boss focuses tank). Tie → p1.
    const targetSide = state.players.p1.field.filter(Boolean).length >= state.players.p2.field.filter(Boolean).length ? "p1" : "p2";
    hitFrontline(state, targetSide, rawAttack, chapter);
  }
  if (move.recharge) state.boss.rechargingNext = true;
}

function hitFrontline(state, side, rawAttack, chapter) {
  const p = state.players[side];
  const frontIdx = p.field.findIndex(Boolean);
  if (frontIdx < 0) {
    // No defender — hit player HP for half raw.
    const dmg = Math.max(1, Math.round(rawAttack / 2));
    p.trainerHp = Math.max(0, p.trainerHp - dmg);
    logLine(state, `${state.boss.displayName} bypasses ${p.displayName}'s defenses — ${dmg} damage!`, "boss-damage");
    return;
  }
  const inst = p.field[frontIdx];
  const defenseTerm = state.boss.ignoreDefense ? 0 : Math.round(((inst.card.raw?.defense || 0) + (inst.card.raw?.sp_defense || 0)) / 60);
  const dmg = Math.max(1, Math.round(rawAttack - defenseTerm));
  inst.currentHp = Math.max(0, inst.currentHp - dmg);
  logLine(state, `${inst.card.name} took ${dmg}!`, "boss-damage");
  if (inst.currentHp <= 0) {
    p.discard.push(inst.card);
    p.field[frontIdx] = null;
    logLine(state, `${inst.card.name} was knocked out!`, "ko");
    // Overflow damage → trainer HP.
    const overflow = Math.max(0, dmg - (inst.maxHp - 0));
    if (overflow > 0) {
      p.trainerHp = Math.max(0, p.trainerHp - overflow);
    }
  }
}

function dealAttackToPlayer(state, side, dmg, reason) {
  const p = state.players[side];
  p.trainerHp = Math.max(0, p.trainerHp - dmg);
  logLine(state, `${reason}: ${dmg} damage.`, "boss-damage");
}

// ---------- Solo AI partner (p2 controlled in solo mode) ----------

// Simple heuristic policy:
//   - Play strongest affordable card while field has empty slots
//   - Then attack boss with highest-cardAttack ready Pokémon
//   - Then end turn
// Returns an array of actions taken (for animation playback).
export function aiPartnerTurn(state, chapter, side = "p2") {
  const actions = [];
  if (state.activeSide !== side) return actions;
  const p = state.players[side];

  // 1) Play affordable cards while field has space.
  let safety = 0;
  while (safety++ < 8) {
    const emptySlot = p.field.findIndex((s) => s === null);
    if (emptySlot < 0) break;
    // Pick highest-cost-we-can-afford card in hand.
    let bestIdx = -1, bestCost = -1;
    for (let i = 0; i < p.hand.length; i++) {
      const c = p.hand[i];
      const cost = c.energyCost || 1;
      if (cost <= p.energy && cost > bestCost) {
        bestCost = cost; bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const r = playCard(state, side, bestIdx);
    if (!r.ok) break;
    actions.push({ kind: "play", slot: r.slot, cardName: p.field[r.slot]?.card?.name });
  }
  // 2) Attack with each ready Pokémon — target minion if any (clear board), else boss.
  for (let i = 0; i < p.field.length; i++) {
    const inst = p.field[i];
    if (!inst) continue;
    if (inst.summoningSickness || inst.hasAttackedThisTurn) continue;
    const target = state.boss.minions.length ? { kind: "minion", index: 0 } : { kind: "boss" };
    const r = attack(state, side, i, target);
    if (!r.ok) break;
    actions.push({ kind: "attack", fromSlot: i, target, damage: r.damage, critical: r.critical });
    if (state.winner) return actions;
  }
  // 3) End turn.
  const r = endTurn(state, side, chapter);
  if (r.ok) actions.push({ kind: "end-turn" });
  return actions;
}

// Convenience: a deterministic snapshot for rendering.
export function viewState(state) {
  return JSON.parse(JSON.stringify(state));
}
