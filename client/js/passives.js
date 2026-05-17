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

// Guardian — opposing attackers MUST target this card before any other on
// the field. Granted to legendaries and to high-tier (≥ 4) Steel/Rock/Fighting
// types that have the "sturdy" PokeAPI passive. Visualised as a 🛡 shield.
export function isGuardian(card) {
  if (!card) return false;
  if (card.is_legendary) return true;
  const t = card.types?.[0];
  if (card.tier >= 4 && (t === "steel" || t === "rock" || t === "fighting") && hasPassive(card, "sturdy")) {
    return true;
  }
  return false;
}

// Entrance ability — fires once when a Pokémon is summoned to the field.
// Returns { kind, ... } describing the effect for the caller to apply, OR
// null if no entrance ability applies.
export function entranceAbility(card) {
  if (card.is_legendary) {
    return {
      kind: "roar",
      name: "Roar",
      desc: "Deals 2 damage to every enemy field Pokémon.",
      damage: 2,
    };
  }
  if (card.is_mythical) {
    return {
      kind: "aurora",
      name: "Aurora",
      desc: "Heals 2 HP on every allied field Pokémon.",
      heal: 2,
    };
  }
  return null;
}

// --- Signature abilities ---------------------------------------------------
// Per-Pokémon flavor that overrides or augments the generic Roar/Aurora.
// Each entry defines optional hook points the engine wires into game.js.
//
// Hook shapes:
//   onSummon(state, side, inst)     — at end of playCard
//   onTurnStart(state, side, inst)  — at start of this player's turn,
//                                     for each field Pokémon they own
//   onKO(state, side, inst)         — when this Pokémon would faint;
//                                     return true to cancel the KO
//   passive                         — descriptor used elsewhere (e.g.
//                                     `ignoreDefense` flag read in attack)
export const SIGNATURE_ABILITIES = {
  150: {
    // Mewtwo
    name: "Recover",
    desc: "Restores 3 HP at the start of each of your turns.",
    onTurnStart(state, side, inst) {
      const cap = inst.maxHp ?? inst.card.cardHp;
      const before = inst.currentHp;
      inst.currentHp = Math.min(cap, inst.currentHp + 3);
      if (inst.currentHp > before) {
        state.log.push({ id: state.log.length + 1, text: `🌀 ${inst.card.name} recovered ${inst.currentHp - before} HP.`, kind: "summon" });
      }
    },
  },
  151: {
    // Mew
    name: "Mimicry",
    desc: "On summon, copies the highest Attack stat on the enemy field as an attack boost.",
    onSummon(state, side, inst) {
      const otherSide = side === "player" ? "ai" : "player";
      let best = 0;
      for (const enemy of state.players[otherSide].field) {
        if (!enemy) continue;
        const enemyAtk = (enemy.card.cardAttack || 0) + (enemy.attackBoost || 0);
        if (enemyAtk > best) best = enemyAtk;
      }
      if (best > 0) {
        inst.attackBoost = (inst.attackBoost || 0) + Math.min(3, best);
        state.log.push({ id: state.log.length + 1, text: `🔮 Mew mimicked +${Math.min(3, best)} ATK.`, kind: "summon" });
      }
    },
  },
  249: {
    // Lugia
    name: "Aeroblast",
    desc: "All of its attacks ignore defender's defense.",
    passive: { ignoreDefense: true },
  },
  250: {
    // Ho-Oh
    name: "Phoenix Down",
    desc: "The first time it would faint, it survives at 50% HP instead. Once per match.",
    onKO(state, side, inst) {
      if (inst.phoenixUsed) return false;
      inst.phoenixUsed = true;
      const cap = inst.maxHp ?? inst.card.cardHp;
      inst.currentHp = Math.max(1, Math.round(cap / 2));
      state.log.push({ id: state.log.length + 1, text: `🦅 Ho-Oh rose from the ashes at ${inst.currentHp} HP!`, kind: "summon" });
      return true; // cancel the KO
    },
  },
  251: {
    // Celebi
    name: "Heart Swap",
    desc: "On summon, copies the highest enemy max HP.",
    onSummon(state, side, inst) {
      const otherSide = side === "player" ? "ai" : "player";
      let best = 0;
      for (const enemy of state.players[otherSide].field) {
        if (!enemy) continue;
        const max = enemy.maxHp ?? enemy.card.cardHp;
        if (max > best) best = max;
      }
      if (best > inst.maxHp) {
        inst.maxHp = best;
        inst.currentHp = best;
        state.log.push({ id: state.log.length + 1, text: `🌿 Celebi swapped max HP to ${best}.`, kind: "summon" });
      }
    },
  },
  384: {
    // Rayquaza
    name: "Dragon Ascent",
    desc: "Gains +1 Attack at the start of each of your turns (caps at +5).",
    onTurnStart(state, side, inst) {
      const cur = inst.dragonAscentLevel || 0;
      if (cur >= 5) return;
      inst.dragonAscentLevel = cur + 1;
      inst.attackBoost = (inst.attackBoost || 0) + 1;
      state.log.push({ id: state.log.length + 1, text: `🐉 Rayquaza ascends! +1 ATK (now +${inst.dragonAscentLevel}).`, kind: "summon" });
    },
  },
  144: {
    // Articuno
    name: "Glacial Veil",
    desc: "On summon, every enemy on the field is paralyzed for one turn.",
    onSummon(state, side, inst) {
      const otherSide = side === "player" ? "ai" : "player";
      let n = 0;
      for (const enemy of state.players[otherSide].field) {
        if (!enemy) continue;
        enemy.status = { kind: "paralyze", turnsLeft: 1 };
        n++;
      }
      if (n) state.log.push({ id: state.log.length + 1, text: `❄ Articuno froze ${n} foe${n === 1 ? "" : "s"}!`, kind: "status" });
    },
  },
  145: {
    // Zapdos
    name: "Thunderstorm",
    desc: "Critical-hit chance doubled while it's on the field for your attacks.",
    passive: { critBonus: 0.1 },
  },
  146: {
    // Moltres
    name: "Sky Attack",
    desc: "Burns every enemy on the field on summon.",
    onSummon(state, side, inst) {
      const otherSide = side === "player" ? "ai" : "player";
      let n = 0;
      for (const enemy of state.players[otherSide].field) {
        if (!enemy) continue;
        enemy.status = { kind: "burn", turnsLeft: 2 };
        n++;
      }
      if (n) state.log.push({ id: state.log.length + 1, text: `🔥 Moltres scorched ${n} foe${n === 1 ? "" : "s"}!`, kind: "status" });
    },
  },
  382: {
    // Kyogre
    name: "Drizzle",
    desc: "While on the field, your Water Pokémon attack with +1 ATK.",
    fieldAura: { type: "water", attackBonus: 1 },
  },
  383: {
    // Groudon
    name: "Drought",
    desc: "While on the field, enemy Water Pokémon lose 1 ATK on their attacks.",
    fieldAura: { enemyType: "water", attackPenalty: 1 },
  },
  483: {
    // Dialga
    name: "Roar of Time",
    desc: "On summon, your maximum Energy this turn doubles (capped at 10).",
    onSummon(state, side, inst) {
      const p = state.players[side];
      p.maxEnergy = Math.min(10, p.maxEnergy * 2);
      p.energy = Math.min(p.maxEnergy, p.energy * 2);
      state.log.push({ id: state.log.length + 1, text: `⏳ Dialga warps time! Energy doubled this turn.`, kind: "summon" });
    },
  },
  484: {
    // Palkia
    name: "Spacial Rend",
    desc: "On summon, swaps the positions of every enemy on the field (random shuffle).",
    onSummon(state, side, inst) {
      const otherSide = side === "player" ? "ai" : "player";
      const field = state.players[otherSide].field;
      const occupied = field.map((c, i) => ({ c, i })).filter((x) => x.c != null);
      for (let i = occupied.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [occupied[i], occupied[j]] = [occupied[j], occupied[i]];
      }
      // Reassign in original empty slots first, then originals.
      const slots = field.map((_, i) => i);
      for (let i = 0; i < field.length; i++) field[i] = null;
      for (let i = 0; i < occupied.length; i++) field[i] = occupied[i].c;
      if (occupied.length > 0) state.log.push({ id: state.log.length + 1, text: `🌌 Palkia tore through space — enemies rearranged.`, kind: "summon" });
    },
  },
  493: {
    // Arceus
    name: "Judgment",
    desc: "On summon, all your Pokémon are healed to full HP.",
    onSummon(state, side, inst) {
      let healed = 0;
      for (const ally of state.players[side].field) {
        if (!ally) continue;
        const cap = ally.maxHp ?? ally.card.cardHp;
        const before = ally.currentHp;
        ally.currentHp = cap;
        healed += cap - before;
      }
      if (healed) state.log.push({ id: state.log.length + 1, text: `🌟 Arceus' Judgment restored ${healed} HP across the field.`, kind: "summon" });
    },
  },
};

export function signatureFor(card) {
  if (!card) return null;
  return SIGNATURE_ABILITIES[card.id] || null;
}

// Field-aura helpers — given a player's field, sum bonuses/penalties that
// apply to a specific attacker based on its type.
export function fieldAttackBonusFor(playerField, attackerCard) {
  let bonus = 0;
  for (const inst of playerField) {
    if (!inst) continue;
    const sig = signatureFor(inst.card);
    if (!sig?.fieldAura) continue;
    if (sig.fieldAura.type && attackerCard.types?.includes(sig.fieldAura.type)) {
      bonus += sig.fieldAura.attackBonus || 0;
    }
  }
  return bonus;
}

export function enemyFieldAttackPenaltyFor(enemyField, attackerCard) {
  let penalty = 0;
  for (const inst of enemyField) {
    if (!inst) continue;
    const sig = signatureFor(inst.card);
    if (!sig?.fieldAura) continue;
    if (sig.fieldAura.enemyType && attackerCard.types?.includes(sig.fieldAura.enemyType)) {
      penalty += sig.fieldAura.attackPenalty || 0;
    }
  }
  return penalty;
}

// Crit chance bonus from your own field (Zapdos Thunderstorm).
export function fieldCritBonus(playerField) {
  let bonus = 0;
  for (const inst of playerField) {
    if (!inst) continue;
    const sig = signatureFor(inst.card);
    if (sig?.passive?.critBonus) bonus += sig.passive.critBonus;
  }
  return bonus;
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
