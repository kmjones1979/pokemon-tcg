// Pure, serializable state machine for the TCG mode. No DOM, no I/O — the same
// discipline as client/js/game.js, so this can later run server-side for PvP.
// Randomness goes through effects.js's module-level RNG (setRng for tests).

import { cardById, isBasic, isPokemon, isEnergy } from "./catalog.js";
import { canPayCost, applyCardEffect, shuffle, setRng, flipCoin } from "./effects.js";

export { setRng };

export const STARTING_HAND = 7;
export const BENCH_MAX = 5;
export const PRIZE_COUNT = 6;
const MULLIGAN_MAX = 25;

let _uid = 0;
const nextUid = () => `c${++_uid}`;

export const opponentOf = (side) => (side === "player" ? "ai" : "player");

// A "physical" card = a catalog def plus a unique uid, so multiple copies and
// specific cards (a particular attached Energy) can be moved around by identity.
function physical(id) {
  const def = cardById(id);
  return { ...def, uid: nextUid() };
}

function toInst(card, turn) {
  return {
    uid: card.uid, card,
    damage: 0, attached: [], under: [],
    enteredTurn: turn, evolvedThisTurn: false, status: null,
  };
}

function makeSide(name, deckIds) {
  return {
    name,
    deck: deckIds.map(physical),
    hand: [], discard: [], prizes: [],
    active: null, bench: [],
    energyAttachedThisTurn: false,
    supporterThisTurn: false,
    stadiumThisTurn: false,
    retreatedThisTurn: false,
  };
}

const log = (state, text) => { state.log.push({ text }); };

// --- in-play lookups ------------------------------------------------------

export function inPlay(s) { return s.active ? [s.active, ...s.bench] : [...s.bench]; }
export function findInst(s, uid) { return inPlay(s).find((i) => i && i.uid === uid) || null; }

// --- draw / search / discard ---------------------------------------------

function draw(state, sideKey, n = 1) {
  const s = state.players[sideKey];
  let drawn = 0;
  for (let i = 0; i < n && s.deck.length; i++) { s.hand.push(s.deck.shift()); drawn++; }
  return drawn;
}

function discardHand(state, sideKey) {
  const s = state.players[sideKey];
  s.discard.push(...s.hand);
  s.hand = [];
}

function searchToHand(state, sideKey, filter, count) {
  const s = state.players[sideKey];
  const match = (c) =>
    filter === "energy" ? isEnergy(c) :
    filter === "basic" ? isBasic(c) :
    filter === "pokemon" ? isPokemon(c) : false;
  const idxs = s.deck.map((c, i) => (match(c) ? i : -1)).filter((i) => i >= 0).slice(0, count);
  for (const i of idxs.sort((a, b) => b - a)) s.hand.push(s.deck.splice(i, 1)[0]);
  shuffle(s.deck);
  return idxs.length;
}

// --- healing / energy discard --------------------------------------------

function healInst(inst, amount) { if (inst) inst.damage = Math.max(0, inst.damage - amount); }

function mostDamaged(s) {
  return inPlay(s).filter((i) => i && i.damage > 0).sort((a, b) => b.damage - a.damage)[0] || null;
}

function discardEnergyFromInst(state, ownerKey, inst, amount) {
  const s = state.players[ownerKey];
  for (let i = 0; i < amount && inst.attached.length; i++) s.discard.push(inst.attached.pop());
}

// --- effect api (bridges the effects.js interpreter to this state) --------

function makeApi(state, sideKey, ctx) {
  const owner = (inst) => (inPlay(state.players.player).includes(inst) ? "player" : "ai");
  return {
    log: (t) => log(state, t),
    opponentOf,
    benchCount: (sd) => state.players[sd].bench.length,
    draw: (sd, n) => draw(state, sd, n),
    discardHand: (sd) => discardHand(state, sd),
    searchToHand: (sd, f, c) => searchToHand(state, sd, f, c),
    healChosen: (sd, amount) => healInst(ctx.targetInst || mostDamaged(state.players[sd]), amount),
    healInst,
    damageInst: (inst, amount) => dealDamage(state, owner(inst), inst, amount, opponentOf(owner(inst))),
    discardEnergyFromInst: (inst, amount) => discardEnergyFromInst(state, owner(inst), inst, amount),
    switchActive: (sd, benchIndex) => doSwitch(state, sd, benchIndex),
    setStatus: (inst, kind) => { if (inst) inst.status = { kind }; },
  };
}

// --- damage / KO / prizes -------------------------------------------------

// Deal `amount` to `inst` (owned by ownerKey). On KO, award a prize to
// `prizeTo` and auto-promote a Benched Pokémon.
function dealDamage(state, ownerKey, inst, amount, prizeTo) {
  if (!inst || amount <= 0) return;
  inst.damage += amount;
  if (inst.damage >= inst.card.hp) knockOut(state, ownerKey, inst, prizeTo);
}

function knockOut(state, ownerKey, inst, prizeTo) {
  const s = state.players[ownerKey];
  log(state, `${inst.card.name} was Knocked Out!`);
  s.discard.push(inst.card, ...inst.under, ...inst.attached);
  if (s.active === inst) s.active = null;
  else s.bench = s.bench.filter((i) => i !== inst);
  // Pokémon-EX / Mega EX award extra Prizes when Knocked Out (real TCG rule).
  const prizes = Math.max(1, inst.card.prizeValue || 1);
  for (let i = 0; i < prizes; i++) takePrize(state, prizeTo);
  if (!s.active) promoteBest(state, ownerKey);
}

function takePrize(state, sideKey) {
  const s = state.players[sideKey];
  if (!s.prizes.length) return;
  s.hand.push(s.prizes.pop());
  log(state, `${s.name} took a Prize card (${s.prizes.length} left).`);
}

// Auto-promote the highest-HP Benched Pokémon to Active (v1 keeps flow simple;
// manual promotion choice is a future nicety).
function promoteBest(state, sideKey) {
  const s = state.players[sideKey];
  if (s.active || !s.bench.length) return;
  s.bench.sort((a, b) => (b.card.hp - b.damage) - (a.card.hp - a.damage));
  s.active = s.bench.shift();
  log(state, `${s.name} promoted ${s.active.card.name} to Active.`);
}

function doSwitch(state, sideKey, benchIndex) {
  const s = state.players[sideKey];
  if (!s.active || !s.bench.length) return false;
  let idx = benchIndex;
  if (idx == null || !s.bench[idx]) {
    // Default: swap in the healthiest bench Pokémon.
    idx = s.bench.reduce((best, i, n, arr) =>
      (arr[n].card.hp - arr[n].damage) > (arr[best].card.hp - arr[best].damage) ? n : best, 0);
  }
  const incoming = s.bench.splice(idx, 1)[0];
  s.active.status = null; // Special Conditions clear when a Pokémon leaves the Active spot
  s.bench.push(s.active);
  s.active = incoming;
  return true;
}

// --- setup ----------------------------------------------------------------

function setupSide(state, sideKey) {
  const s = state.players[sideKey];
  shuffle(s.deck);
  // Opening hand with Basic-Pokémon mulligan.
  let tries = 0;
  do {
    s.deck.push(...s.hand); s.hand = [];
    shuffle(s.deck);
    draw(state, sideKey, STARTING_HAND);
    tries++;
  } while (!s.hand.some(isBasic) && tries < MULLIGAN_MAX);
  if (!s.hand.some(isBasic)) throw new Error(`${sideKey} deck has too few Basic Pokémon to open a hand`);

  // Place an Active: the highest-HP Basic in the opening hand.
  const basics = s.hand.filter(isBasic).sort((a, b) => b.hp - a.hp);
  const activeCard = basics[0];
  s.hand.splice(s.hand.indexOf(activeCard), 1);
  s.active = toInst(activeCard, 0);

  // Set 6 Prizes from the top of the remaining deck.
  for (let i = 0; i < PRIZE_COUNT && s.deck.length; i++) s.prizes.push(s.deck.shift());
}

export function createTcgGame({ playerDeckIds, aiDeckIds, playerName = "You", aiName = "Rival", firstPlayer } = {}) {
  const state = {
    turn: 0,
    phase: "setup",
    winner: null,
    stadium: null,
    firstPlayer: firstPlayer || (Math.random() < 0.5 ? "player" : "ai"),
    activePlayer: null,
    noAttack: false,        // true only on the very first turn of the game
    log: [],
    players: { player: makeSide(playerName, playerDeckIds), ai: makeSide(aiName, aiDeckIds) },
  };
  setupSide(state, "player");
  setupSide(state, "ai");
  beginTurn(state, state.firstPlayer);
  return state;
}

// --- turn flow ------------------------------------------------------------

function beginTurn(state, sideKey) {
  if (state.winner) return;
  state.turn += 1;
  state.activePlayer = sideKey;
  state.noAttack = state.turn === 1; // only the first player's first turn
  const s = state.players[sideKey];
  s.energyAttachedThisTurn = false;
  s.supporterThisTurn = false;
  s.stadiumThisTurn = false;
  s.retreatedThisTurn = false;
  for (const inst of inPlay(s)) inst.evolvedThisTurn = false;

  // Stadium start-of-turn heal (applies to the turn player's Active).
  if (state.stadium?.effect?.type === "startTurnHeal" && s.active) healInst(s.active, state.stadium.effect.amount);

  // Draw for turn; a player who cannot draw loses (deck-out).
  if (s.deck.length === 0) {
    log(state, `${s.name} could not draw — deck-out!`);
    setWinner(state, opponentOf(sideKey));
    return;
  }
  draw(state, sideKey, 1);
  state.phase = "main";
  log(state, `— Turn ${state.turn}: ${s.name} —`);
}

function setWinner(state, sideKey) {
  state.winner = sideKey;
  state.phase = "over";
  log(state, `${state.players[sideKey].name} wins!`);
}

export function checkWinner(state) {
  if (state.winner) return state.winner;
  for (const side of ["player", "ai"]) {
    if (state.players[side].prizes.length === 0) { setWinner(state, side); return side; }
  }
  for (const side of ["player", "ai"]) {
    const s = state.players[side];
    if (!s.active && s.bench.length === 0) { setWinner(state, opponentOf(side)); return opponentOf(side); }
  }
  return null;
}

// --- guards ---------------------------------------------------------------

function assertActive(state, sideKey) {
  if (state.phase !== "main") throw new Error(`Not in main phase (${state.phase})`);
  if (state.activePlayer !== sideKey) throw new Error(`Not ${sideKey}'s turn`);
}

// --- player actions -------------------------------------------------------

export function attachEnergy(state, sideKey, handIndex, targetUid) {
  assertActive(state, sideKey);
  const s = state.players[sideKey];
  const card = s.hand[handIndex];
  if (!card || !isEnergy(card)) throw new Error("Not an Energy card");
  if (s.energyAttachedThisTurn) throw new Error("Already attached Energy this turn");
  const target = findInst(s, targetUid) || s.active;
  if (!target) throw new Error("No Pokémon to attach to");
  s.hand.splice(handIndex, 1);
  target.attached.push(card);
  s.energyAttachedThisTurn = true;
  log(state, `${s.name} attached ${card.name} to ${target.card.name}.`);
  return true;
}

export function playBasic(state, sideKey, handIndex) {
  assertActive(state, sideKey);
  const s = state.players[sideKey];
  const card = s.hand[handIndex];
  if (!card || !isBasic(card)) throw new Error("Not a Basic Pokémon");
  if (s.bench.length >= BENCH_MAX) throw new Error("Bench is full");
  s.hand.splice(handIndex, 1);
  s.bench.push(toInst(card, state.turn));
  log(state, `${s.name} played ${card.name} to the Bench.`);
  return true;
}

export function canEvolve(state, sideKey, card, target) {
  if (!card || card.kind !== "pokemon" || card.stage === "basic") return false;
  if (!target || card.from !== target.card.id) return false;
  if (target.enteredTurn >= state.turn) return false; // not the turn it entered
  if (state.turn === 1) return false;                  // no evolving on turn 1
  if (target.evolvedThisTurn) return false;
  return true;
}

export function evolve(state, sideKey, handIndex, targetUid) {
  assertActive(state, sideKey);
  const s = state.players[sideKey];
  const card = s.hand[handIndex];
  const target = findInst(s, targetUid);
  if (!canEvolve(state, sideKey, card, target)) throw new Error("Illegal evolution");
  s.hand.splice(handIndex, 1);
  target.under.push(target.card);
  target.card = card;
  target.evolvedThisTurn = true;
  target.status = null; // evolving removes Special Conditions (none in v1)
  log(state, `${s.name} evolved into ${card.name}.`);
  return true;
}

export function playTrainer(state, sideKey, handIndex, opts = {}) {
  assertActive(state, sideKey);
  const s = state.players[sideKey];
  const card = s.hand[handIndex];
  if (!card || !["item", "supporter", "stadium"].includes(card.kind)) throw new Error("Not a Trainer card");
  if (card.kind === "supporter" && s.supporterThisTurn) throw new Error("Already played a Supporter this turn");
  if (card.kind === "stadium" && s.stadiumThisTurn) throw new Error("Already played a Stadium this turn");

  if (card.kind === "stadium") {
    if (state.stadium?.card?.id === card.id) throw new Error("That Stadium is already in play");
    if (state.stadium) state.players[state.stadium.owner].discard.push(state.stadium.card);
    s.hand.splice(handIndex, 1);
    state.stadium = { card, owner: sideKey };
    s.stadiumThisTurn = true;
    log(state, `${s.name} played Stadium: ${card.name}.`);
    return true;
  }

  const ctx = { side: sideKey, targetInst: opts.targetUid ? findInst(s, opts.targetUid) : null };
  s.hand.splice(handIndex, 1);
  applyCardEffect(card.effect, makeApi(state, sideKey, ctx), ctx);
  s.discard.push(card);
  if (card.kind === "supporter") s.supporterThisTurn = true;
  log(state, `${s.name} played ${card.name}.`);
  checkWinner(state);
  return true;
}

// A Pokémon can attack/retreat unless it is Asleep or Paralyzed.
export function canAct(inst) {
  const k = inst?.status?.kind;
  return !(k === "sleep" || k === "paralyze");
}

export function retreat(state, sideKey, benchIndex) {
  assertActive(state, sideKey);
  const s = state.players[sideKey];
  if (s.retreatedThisTurn) throw new Error("Already retreated this turn");
  if (!s.active) throw new Error("No Active Pokémon");
  if (!canAct(s.active)) throw new Error(`${s.active.card.name} can't retreat (${s.active.status.kind}).`);
  const cost = s.active.card.retreat || 0;
  if (s.active.attached.length < cost) throw new Error("Not enough Energy to retreat");
  if (!s.bench[benchIndex]) throw new Error("No such Benched Pokémon");
  discardEnergyFromInst(state, sideKey, s.active, cost);
  doSwitch(state, sideKey, benchIndex);
  s.retreatedThisTurn = true;
  s.active.status = null; // retreating removes Special Conditions (none in v1)
  log(state, `${s.name} retreated to ${s.active.card.name}.`);
  return true;
}

export function affordableAttacks(inst) {
  if (!inst) return [];
  return inst.card.attacks.filter((a) => canPayCost(inst.attached, a.cost));
}

export function attack(state, sideKey, attackIndex) {
  assertActive(state, sideKey);
  if (state.noAttack) throw new Error("The player going first cannot attack on turn 1");
  const s = state.players[sideKey];
  const o = state.players[opponentOf(sideKey)];
  if (!s.active) throw new Error("No Active Pokémon");
  if (!o.active) throw new Error("No target");
  const move = s.active.card.attacks[attackIndex];
  if (!move) throw new Error("No such attack");
  if (!canPayCost(s.active.attached, move.cost)) throw new Error("Not enough Energy for that attack");
  if (!canAct(s.active)) throw new Error(`${s.active.card.name} is ${s.active.status.kind} and can't attack.`);

  const ctx = { side: sideKey, attacker: s.active, defender: o.active, attackName: move.name };
  const api = makeApi(state, sideKey, ctx);

  // Confusion: flip before attacking. Tails hurts the confused Pokémon and the
  // attack fails, but the turn still ends.
  if (s.active.status?.kind === "confuse") {
    if (flipCoin() === "tails") {
      log(state, `${s.active.card.name} is confused — it hurt itself!`);
      dealDamage(state, sideKey, s.active, 30, opponentOf(sideKey));
      checkWinner(state);
      endTurn(state, sideKey);
      return true;
    }
    log(state, `${s.active.card.name} pushed through its confusion.`);
  }

  // A damage-modifier effect is read BEFORE dealing damage (and must not run
  // again afterwards); every other effect is an after-effect run once post-KO.
  const DMG_MODIFIERS = ["coinFlipBonus", "plusPerEnergy", "damagePerBenchOpp"];
  const isModifier = move.effect && DMG_MODIFIERS.includes(move.effect.type);

  let dmg = move.damage || 0;
  if (isModifier) dmg += applyCardEffect(move.effect, api, ctx).bonusDamage || 0;
  if (dmg > 0 && state.stadium?.effect?.type === "attackBonus") dmg += state.stadium.effect.amount;

  // Weakness (×2). Resistance is deferred.
  if (dmg > 0 && o.active.card.weak && o.active.card.weak === s.active.card.type) {
    dmg *= 2;
    log(state, `It's super effective! (Weakness ×2)`);
  }

  log(state, `${s.active.card.name} used ${move.name}${dmg > 0 ? ` for ${dmg}` : ""}.`);
  if (dmg > 0) dealDamage(state, opponentOf(sideKey), o.active, dmg, sideKey);

  // Post-damage attack effects (recoil, self-heal, energy discard, switch).
  if (move.effect && !isModifier) applyCardEffect(move.effect, api, ctx);

  checkWinner(state);
  endTurn(state, sideKey);
  return true;
}

// Pokémon Checkup, run between turns: Poison and Burn damage the Active,
// Sleep/Burn may end on a coin flip, and Paralysis wears off the ending
// player's Active (so it lasts through exactly one of their turns).
function checkup(state, endingSide) {
  for (const side of ["player", "ai"]) {
    const a = state.players[side].active;
    if (!a || !a.status) continue;
    const k = a.status.kind;
    if (k === "poison") { log(state, `${a.card.name} is hurt by poison.`); dealDamage(state, side, a, 10, opponentOf(side)); }
    else if (k === "burn") {
      log(state, `${a.card.name} is hurt by its burn.`);
      dealDamage(state, side, a, 20, opponentOf(side));
      if (a.status && flipCoin() === "heads") { a.status = null; log(state, `${a.card.name}'s burn healed.`); }
    } else if (k === "sleep") {
      if (flipCoin() === "heads") { a.status = null; log(state, `${a.card.name} woke up.`); }
    }
  }
  const ea = state.players[endingSide].active;
  if (ea && ea.status?.kind === "paralyze") { ea.status = null; log(state, `${ea.card.name} is no longer paralyzed.`); }
}

export function endTurn(state, sideKey) {
  if (state.winner) return;
  if (state.activePlayer !== sideKey) return;
  checkup(state, sideKey);
  if (checkWinner(state)) return;
  beginTurn(state, opponentOf(sideKey));
}

// Alias for ending the turn without attacking.
export const passTurn = endTurn;

export function promoteActive(state, sideKey, benchIndex) {
  const s = state.players[sideKey];
  if (s.active || !s.bench[benchIndex]) return false;
  s.active = s.bench.splice(benchIndex, 1)[0];
  return true;
}
