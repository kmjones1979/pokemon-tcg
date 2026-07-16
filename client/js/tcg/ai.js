// Heuristic AI opponent for the TCG engine. One solid "medium" policy for v1.
//
// aiTakeTurn drives a whole turn, awaiting an optional `onStep` callback after
// each engine mutation so the board can animate the AI's moves one at a time
// (mirrors main.js's onAction stream for the legacy battler).

import * as engine from "./engine.js";

const inPlayList = (s) => (s.active ? [s.active, ...s.bench] : [...s.bench]);

// Expected damage of `move` from attacker → defender, including Weakness ×2,
// the Stadium attack bonus, and the average value of a coin-flip bonus.
export function estimateDamage(state, attacker, move, defender) {
  let d = move.damage || 0;
  const eff = move.effect;
  if (eff?.type === "coinFlipBonus") d += (eff.damage || 0) * 0.5;
  if (eff?.type === "plusPerEnergy") {
    const n = attacker.attached.filter((e) => !eff.energyType || e.energyType === eff.energyType).length;
    d += Math.max(0, n - (eff.ignore || 0)) * eff.per;
  }
  if (d > 0 && state.stadium?.effect?.type === "attackBonus") d += state.stadium.effect.amount;
  if (d > 0 && defender && defender.card.weak === attacker.card.type) d *= 2;
  return d;
}

// Best affordable attack index for the current Active, or -1.
function bestAttackIndex(state, side) {
  const s = state.players[side];
  const def = state.players[engine.opponentOf(side)].active;
  if (!s.active) return -1;
  const affordable = engine.affordableAttacks(s.active);
  let bestI = -1, bestD = -1;
  s.active.card.attacks.forEach((move, i) => {
    if (!affordable.includes(move)) return;
    const d = estimateDamage(state, s.active, move, def);
    // Prefer damage; break ties toward attacks that carry an effect.
    const score = d + (move.effect ? 0.1 : 0);
    if (score > bestD) { bestD = score; bestI = i; }
  });
  return bestI;
}

// Which of our Pokémon most wants the Energy drop: the Active if it's one
// Energy short of a stronger attack, else the Active by default.
function energyTarget(state, side) {
  const s = state.players[side];
  return s.active || s.bench[0] || null;
}

export async function aiTakeTurn(state, side = "ai", onStep = async () => {}) {
  const S = () => state.players[side];
  const step = async (label) => { await onStep({ text: label }); };
  const tryDo = async (fn, label) => { try { fn(); await step(label); return true; } catch { return false; } };

  if (state.winner || state.activePlayer !== side) return;

  // 1. Develop the Bench (keep ~3 Pokémon in play for resilience).
  for (let guard = 0; guard < 5 && S().bench.length < 3; guard++) {
    const i = S().hand.findIndex((c) => c.kind === "pokemon" && c.stage === "basic");
    if (i < 0) break;
    if (!(await tryDo(() => engine.playBasic(state, side, i), "develops the Bench"))) break;
  }

  // 2. Evolve wherever possible (Active first, then Bench).
  for (const inst of inPlayList(S())) {
    const hi = S().hand.findIndex((c) => engine.canEvolve(state, side, c, inst));
    if (hi >= 0) await tryDo(() => engine.evolve(state, side, hi, inst.uid), "evolves a Pokémon");
  }

  // 3. Dig for resources if the hand is thin (Supporter is once per turn).
  // Deck-aware: prefer Hop (draw 3) over Professor's Research (discard hand,
  // draw 7) so the AI doesn't burn through its own deck and self-deck-out,
  // and stop digging entirely once the deck runs low.
  if (S().hand.length <= 3 && !S().supporterThisTurn && S().deck.length > 10) {
    const hop = S().hand.findIndex((c) => c.id === "trainer-hop");
    const research = S().hand.findIndex((c) => c.id === "trainer-research");
    const pick = hop >= 0 ? hop : (S().hand.length <= 2 && S().deck.length > 15 ? research : -1);
    if (pick >= 0) await tryDo(() => engine.playTrainer(state, side, pick), "draws cards");
  }
  // Fetch a Basic to the bench if we have none benched and a ball in hand.
  if (S().bench.length === 0) {
    const ball = S().hand.findIndex((c) => c.id === "trainer-poke-ball" || c.id === "trainer-great-ball");
    if (ball >= 0) await tryDo(() => engine.playTrainer(state, side, ball), "searches its deck");
  }

  // 4. Attach one Energy (to the Active by default).
  if (!S().energyAttachedThisTurn) {
    const eIdx = S().hand.findIndex((c) => c.kind === "energy");
    const target = energyTarget(state, side);
    if (eIdx >= 0 && target) await tryDo(() => engine.attachEnergy(state, side, eIdx, target.uid), "attaches Energy");
  }

  // 5. Consider retreating a nearly-KO'd Active for a healthier benched Pokémon.
  if (!S().retreatedThisTurn && S().active && S().bench.length) {
    const a = S().active;
    const nearlyDead = a.damage >= a.card.hp - 20;
    const healthierBench = S().bench.some((b) => (b.card.hp - b.damage) > (a.card.hp - a.damage) + 40);
    if (nearlyDead && healthierBench && a.attached.length >= (a.card.retreat || 0)) {
      const idx = S().bench.reduce((best, b, n, arr) =>
        (arr[n].card.hp - arr[n].damage) > (arr[best].card.hp - arr[best].damage) ? n : best, 0);
      await tryDo(() => engine.retreat(state, side, idx), "retreats");
    }
  }

  // 6. Attack if allowed; otherwise end the turn.
  const atkI = state.noAttack ? -1 : bestAttackIndex(state, side);
  if (atkI >= 0) {
    await tryDo(() => engine.attack(state, side, atkI), "attacks");
  } else if (!state.winner) {
    engine.endTurn(state, side);
    await step("ends its turn");
  }
}
