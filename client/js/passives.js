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
// the field. Visualised as a 🛡 shield + glowing ring around the card.
//
// Granted to:
//   - All legendaries (they're rare enough to be team anchors)
//   - All mythicals
//   - Tier ≥ 3 Steel / Rock / Fighting / Ground tanks (broader than before)
//   - Cards explicitly tagged via TANK_PASSIVES (PokeAPI ability names that
//     thematically scream "I block for the team")
const TANK_PASSIVES = new Set(["sturdy", "rough-skin", "iron-barbs", "stamina", "bulletproof", "rock-head"]);
const TANK_IDS = new Set([
  143, // Snorlax — the iconic wall
  131, // Lapras — chunky water tank
  208, // Steelix
  306, // Aggron
  411, // Bastiodon
  213, // Shuckle — the ultimate defender
  464, // Rhyperior
  248, // Tyranitar (already has Sandstorm, also a wall)
  389, // Torterra
  376, // Metagross (already Iron Defense, also Guardian)
]);
export function isGuardian(card) {
  if (!card) return false;
  if (card.is_legendary || card.is_mythical) return true;
  if (TANK_IDS.has(card.id)) return true;
  const t = card.types?.[0];
  if (card.tier >= 3 && (t === "steel" || t === "rock" || t === "fighting" || t === "ground")) {
    if (Array.isArray(card.abilities)) {
      for (const ab of card.abilities) if (TANK_PASSIVES.has(ab)) return true;
    }
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
      desc: "Heals 3 HP on every allied field Pokémon.",
      heal: 3,
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
    desc: "Its Special attacks ignore the defender's defense.",
    passive: { ignoreDefenseSpecial: true },
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

  // --- Gen 1 starters: flavor signature buffs --------------------------
  3: {
    name: "Solar Beam",
    desc: "Your Grass specials hit for +1 ATK while Venusaur is on the field.",
    fieldAura: { type: "grass", attackBonus: 1 },
  },
  6: {
    name: "Flamethrower",
    desc: "Your Fire specials hit for +1 ATK while Charizard is on the field.",
    fieldAura: { type: "fire", attackBonus: 1 },
  },
  9: {
    name: "Hydro Cannon",
    desc: "Your Water specials hit for +1 ATK while Blastoise is on the field.",
    fieldAura: { type: "water", attackBonus: 1 },
  },

  // --- Pseudo-legendaries + iconic rares -------------------------------
  248: {
    // Tyranitar
    name: "Sandstorm",
    desc: "Deals 1 damage to every enemy that isn't Rock or Ground at the start of your turn.",
    onTurnStart(state, side, inst) {
      const otherSide = side === "player" ? "ai" : "player";
      let hits = 0;
      for (let i = 0; i < state.players[otherSide].field.length; i++) {
        const enemy = state.players[otherSide].field[i];
        if (!enemy) continue;
        const types = enemy.card.types || [];
        if (types.includes("rock") || types.includes("ground")) continue;
        enemy.currentHp = Math.max(0, enemy.currentHp - 1);
        hits++;
        if (enemy.currentHp <= 0) {
          state.players[otherSide].discard.push(enemy.card);
          state.players[otherSide].field[i] = null;
          state.log.push({ id: state.log.length + 1, text: `${enemy.card.name} eroded in the Sandstorm.`, kind: "ko" });
        }
      }
      if (hits) state.log.push({ id: state.log.length + 1, text: `🌪 Tyranitar's Sandstorm hit ${hits} foe${hits === 1 ? "" : "s"}.`, kind: "status" });
    },
  },
  282: {
    // Gardevoir
    name: "Future Sight",
    desc: "On summon, a random enemy takes 4 psychic damage.",
    onSummon(state, side, inst) {
      const otherSide = side === "player" ? "ai" : "player";
      const targets = state.players[otherSide].field
        .map((c, i) => ({ c, i }))
        .filter((x) => x.c != null);
      if (targets.length === 0) return;
      const t = targets[Math.floor(Math.random() * targets.length)];
      t.c.currentHp = Math.max(0, t.c.currentHp - 4);
      state.log.push({ id: state.log.length + 1, text: `🔮 Gardevoir's Future Sight struck ${t.c.card.name} for 4.`, kind: "attack" });
      if (t.c.currentHp <= 0) {
        state.players[otherSide].discard.push(t.c.card);
        state.players[otherSide].field[t.i] = null;
        state.log.push({ id: state.log.length + 1, text: `${t.c.card.name} fainted!`, kind: "ko" });
      }
    },
  },
  376: {
    // Metagross
    name: "Iron Defense",
    desc: "Takes 1 less damage from every attack (minimum 1).",
    passive: { damageReduction: 1 },
  },
  445: {
    // Garchomp
    name: "Sand Force",
    desc: "Whenever it KOs an enemy, heals 2 HP.",
    onKill(state, side, inst) {
      const cap = inst.maxHp ?? inst.card.cardHp;
      const before = inst.currentHp;
      inst.currentHp = Math.min(cap, inst.currentHp + 2);
      if (inst.currentHp > before) {
        state.log.push({ id: state.log.length + 1, text: `🐉 Garchomp's Sand Force healed ${inst.currentHp - before}.`, kind: "summon" });
      }
    },
  },
  448: {
    // Lucario
    name: "Aura Sphere",
    desc: "Your special attacks cost 1 less Energy while Lucario is on the field.",
    fieldAura: { specialCostMod: -1 },
  },
  658: {
    // Greninja
    name: "Protean",
    desc: "On summon, copies the primary type of the strongest enemy on the field.",
    onSummon(state, side, inst) {
      const otherSide = side === "player" ? "ai" : "player";
      let best = null;
      for (const enemy of state.players[otherSide].field) {
        if (!enemy) continue;
        const atk = (enemy.card.cardAttack || 0) + (enemy.attackBoost || 0);
        if (!best || atk > best.atk) best = { atk, type: enemy.card.types?.[0] };
      }
      if (best?.type) {
        // Mutate this instance's `card` snapshot so attacks use the new primary type.
        inst.card = { ...inst.card, types: [best.type, ...(inst.card.types?.slice(1) || [])] };
        state.log.push({ id: state.log.length + 1, text: `🥷 Greninja's Protean shifted to ${best.type}.`, kind: "summon" });
      }
    },
  },
  487: {
    // Giratina
    name: "Shadow Force",
    desc: "Ignores the first attack that would hit it each match.",
    onPreHit(state, side, inst) {
      if (inst.shadowForceUsed) return false;
      inst.shadowForceUsed = true;
      state.log.push({ id: state.log.length + 1, text: `👻 Giratina phased out — Shadow Force blocked the attack!`, kind: "status" });
      return true;
    },
  },
  643: {
    // Reshiram
    name: "Blue Flare",
    desc: "While on the field, your Fire Pokémon attack with +1 ATK and apply Burn.",
    fieldAura: { type: "fire", attackBonus: 1, statusOnHit: "burn" },
  },
  644: {
    // Zekrom
    name: "Bolt Strike",
    desc: "While on the field, your Electric Pokémon attack with +1 ATK and apply Paralyze.",
    fieldAura: { type: "electric", attackBonus: 1, statusOnHit: "paralyze" },
  },
  716: {
    // Xerneas
    name: "Geomancy",
    desc: "On summon, every ally gains +3 HP (over max).",
    onSummon(state, side, inst) {
      let healed = 0;
      for (const ally of state.players[side].field) {
        if (!ally) continue;
        ally.maxHp = (ally.maxHp ?? ally.card.cardHp) + 3;
        ally.currentHp += 3;
        healed += 3;
      }
      if (healed) state.log.push({ id: state.log.length + 1, text: `🦌 Xerneas' Geomancy granted +3 max HP across the field.`, kind: "summon" });
    },
  },

  // --- Pseudo-legendary expansion --------------------------------------
  149: {
    // Dragonite
    name: "Multiscale",
    desc: "Takes half damage from any attack while at full HP.",
    passive: { multiscale: true },
  },
  373: {
    // Salamence
    name: "Moxie",
    desc: "Gains +1 ATK permanently every time it scores a KO.",
    onKill(state, side, inst) {
      inst.attackBoost = (inst.attackBoost || 0) + 1;
      state.log.push({ id: state.log.length + 1, text: `🐲 Salamence's Moxie kicked in. +1 ATK.`, kind: "summon" });
    },
  },
  635: {
    // Hydreigon
    name: "Dark Pulse",
    desc: "On summon, a random enemy takes 3 dark-type damage.",
    onSummon(state, side, inst) {
      const otherSide = side === "player" ? "ai" : "player";
      const targets = state.players[otherSide].field
        .map((c, i) => ({ c, i }))
        .filter((x) => x.c != null);
      if (!targets.length) return;
      const t = targets[Math.floor(Math.random() * targets.length)];
      t.c.currentHp = Math.max(0, t.c.currentHp - 3);
      state.log.push({ id: state.log.length + 1, text: `🌑 Hydreigon's Dark Pulse hit ${t.c.card.name} for 3.`, kind: "attack" });
      if (t.c.currentHp <= 0) {
        state.players[otherSide].discard.push(t.c.card);
        state.players[otherSide].field[t.i] = null;
        state.log.push({ id: state.log.length + 1, text: `${t.c.card.name} fainted!`, kind: "ko" });
      }
    },
  },
  778: {
    // Mimikyu
    name: "Disguise",
    desc: "The first attack that would deal damage to it does nothing.",
    onPreHit(state, side, inst) {
      if (inst.disguiseBroken) return false;
      inst.disguiseBroken = true;
      state.log.push({ id: state.log.length + 1, text: `👻 Mimikyu's Disguise shattered — no damage!`, kind: "status" });
      return true;
    },
  },
  // --- On-summon abilities (non-legendary) ----------------------------
  // Cards that trigger an effect the moment they hit the field. Adds
  // tactical depth — when to drop matters as much as which card.
  113: {
    // Chansey — Soft-Boiled: heal weakest ally on summon.
    name: "Soft-Boiled",
    desc: "On summon, fully heals your lowest-HP ally.",
    onSummon(state, side, inst) {
      const allies = state.players[side].field.filter((a) => a && a !== inst);
      if (!allies.length) return;
      const target = allies.reduce((a, b) => (a.currentHp / a.maxHp < b.currentHp / b.maxHp ? a : b));
      const before = target.currentHp;
      target.currentHp = target.maxHp;
      if (target.currentHp > before) {
        state.log.push({ id: state.log.length + 1, text: `💗 Chansey's Soft-Boiled restored ${target.card.name} to full HP.`, kind: "summon" });
      }
    },
  },
  36: {
    // Clefable — Moonlight: small heal across the board.
    name: "Moonlight",
    desc: "On summon, heals every ally for 2 HP.",
    onSummon(state, side, inst) {
      let healed = 0;
      for (const ally of state.players[side].field) {
        if (!ally || ally === inst) continue;
        const cap = ally.maxHp ?? ally.card.cardHp;
        const before = ally.currentHp;
        ally.currentHp = Math.min(cap, ally.currentHp + 2);
        healed += ally.currentHp - before;
      }
      if (healed) state.log.push({ id: state.log.length + 1, text: `🌙 Clefable's Moonlight healed ${healed} HP across the field.`, kind: "summon" });
    },
  },
  65: {
    // Alakazam — Psychic: deal 4 damage to the strongest enemy on summon.
    name: "Psychic",
    desc: "On summon, deals 4 damage to the enemy with the most current HP.",
    onSummon(state, side, inst) {
      const otherSide = side === "player" ? "ai" : "player";
      const enemies = state.players[otherSide].field
        .map((c, i) => ({ c, i }))
        .filter((x) => x.c != null);
      if (!enemies.length) return;
      const t = enemies.reduce((a, b) => (a.c.currentHp > b.c.currentHp ? a : b));
      t.c.currentHp = Math.max(0, t.c.currentHp - 4);
      state.log.push({ id: state.log.length + 1, text: `🔮 Alakazam's Psychic struck ${t.c.card.name} for 4.`, kind: "attack" });
      if (t.c.currentHp <= 0) {
        state.players[otherSide].discard.push(t.c.card);
        state.players[otherSide].field[t.i] = null;
        state.log.push({ id: state.log.length + 1, text: `${t.c.card.name} fainted!`, kind: "ko" });
      }
    },
  },
  124: {
    // Jynx — Lovely Kiss: sleep a random enemy on summon.
    name: "Lovely Kiss",
    desc: "On summon, puts a random enemy to sleep for 1 turn.",
    onSummon(state, side, inst) {
      const otherSide = side === "player" ? "ai" : "player";
      const enemies = state.players[otherSide].field.filter(Boolean);
      if (!enemies.length) return;
      const t = enemies[Math.floor(Math.random() * enemies.length)];
      t.status = { kind: "sleep", turnsLeft: 1 };
      state.log.push({ id: state.log.length + 1, text: `💋 Jynx kissed ${t.card.name} — they fell asleep!`, kind: "status" });
    },
  },
  25: {
    // Pikachu — Thunder Shock: chip 2 damage to a random enemy.
    name: "Thunder Shock",
    desc: "On summon, zaps a random enemy for 2 damage and may paralyze.",
    onSummon(state, side, inst) {
      const otherSide = side === "player" ? "ai" : "player";
      const enemies = state.players[otherSide].field
        .map((c, i) => ({ c, i }))
        .filter((x) => x.c != null);
      if (!enemies.length) return;
      const t = enemies[Math.floor(Math.random() * enemies.length)];
      t.c.currentHp = Math.max(0, t.c.currentHp - 2);
      if (Math.random() < 0.3) {
        t.c.status = { kind: "paralyze", turnsLeft: 1 };
        state.log.push({ id: state.log.length + 1, text: `⚡ Pikachu zapped ${t.c.card.name} for 2 — paralyzed!`, kind: "status" });
      } else {
        state.log.push({ id: state.log.length + 1, text: `⚡ Pikachu zapped ${t.c.card.name} for 2.`, kind: "attack" });
      }
      if (t.c.currentHp <= 0) {
        state.players[otherSide].discard.push(t.c.card);
        state.players[otherSide].field[t.i] = null;
        state.log.push({ id: state.log.length + 1, text: `${t.c.card.name} fainted!`, kind: "ko" });
      }
    },
  },
  78: {
    // Rapidash — Flame Charge: buff a random ally's attack this turn.
    name: "Flame Charge",
    desc: "On summon, grants a random ally +2 ATK permanently.",
    onSummon(state, side, inst) {
      const allies = state.players[side].field.filter((a) => a && a !== inst);
      if (!allies.length) return;
      const t = allies[Math.floor(Math.random() * allies.length)];
      t.attackBoost = (t.attackBoost || 0) + 2;
      state.log.push({ id: state.log.length + 1, text: `🔥 Rapidash's Flame Charge pumped ${t.card.name} up — +2 ATK.`, kind: "summon" });
    },
  },
  94: {
    // Gengar — Hex: a random enemy gets a 2-turn burn-like ghost curse.
    name: "Hex",
    desc: "On summon, curses a random enemy — they take 2 damage at the start of their next turn.",
    onSummon(state, side, inst) {
      const otherSide = side === "player" ? "ai" : "player";
      const enemies = state.players[otherSide].field.filter(Boolean);
      if (!enemies.length) return;
      const t = enemies[Math.floor(Math.random() * enemies.length)];
      // Burn does damage on tick — perfect for "ghost curse" semantically.
      t.status = { kind: "burn", turnsLeft: 2 };
      state.log.push({ id: state.log.length + 1, text: `👻 Gengar's Hex cursed ${t.card.name} — 2 damage per turn.`, kind: "status" });
    },
  },

  // --- New signatures (Wave 30d) for fan-favorite mons --------------------
  149: {
    // Dragonite — Outrage (rage scaling)
    name: "Outrage",
    desc: "Gains +1 ATK at the start of each turn until KO'd.",
    onTurnStart(state, side, inst) {
      inst.attackBoost = (inst.attackBoost || 0) + 1;
      state.log.push({ id: state.log.length + 1, text: `🐲 ${inst.card.name}'s Outrage flared — +1 ATK.`, kind: "summon" });
    },
  },
  468: {
    // Togekiss — Air Slash: 30% flinch chance baked in is hard; do
    // an on-summon heal-on-low-HP-allies instead. Fan-favorite.
    name: "Fairy Wind",
    desc: "On summon, heals every Fairy/Flying/Normal ally for 3 HP.",
    onSummon(state, side, inst) {
      const allies = state.players[side].field.filter((a) => a && a !== inst);
      let healed = 0;
      for (const ally of allies) {
        const types = ally.card?.types || [];
        if (!types.some((t) => ["fairy", "flying", "normal"].includes(t))) continue;
        const cap = ally.maxHp ?? ally.card.cardHp;
        const before = ally.currentHp;
        ally.currentHp = Math.min(cap, ally.currentHp + 3);
        healed += ally.currentHp - before;
      }
      if (healed) state.log.push({ id: state.log.length + 1, text: `🕊 Togekiss' Fairy Wind healed ${healed} HP across the field.`, kind: "summon" });
    },
  },
  208: {
    // Steelix — Sandstorm-style chip on Steel/Ground enemies
    name: "Sand Veil",
    desc: "While on the field, every attack against you takes a flat 1 damage off (minimum 1).",
    passive: { damageReduction: 1 },
  },
  571: {
    // Zoroark — Illusion: enemy gets random crit boost AGAINST it (high-risk attacker)
    name: "Illusion",
    desc: "On summon, copies the attack stat of the strongest enemy as a permanent boost.",
    onSummon(state, side, inst) {
      const otherSide = side === "player" ? "ai" : "player";
      let best = 0;
      for (const enemy of state.players[otherSide].field) {
        if (!enemy) continue;
        const atk = (enemy.card.cardAttack || 0) + (enemy.attackBoost || 0);
        if (atk > best) best = atk;
      }
      if (best > 0) {
        const gain = Math.min(3, Math.max(1, Math.round(best / 3)));
        inst.attackBoost = (inst.attackBoost || 0) + gain;
        state.log.push({ id: state.log.length + 1, text: `🦊 Zoroark's Illusion absorbed +${gain} ATK.`, kind: "summon" });
      }
    },
  },
  609: {
    // Chandelure — Soul Drain: heal on KO
    name: "Soul Drain",
    desc: "When it KOs an enemy, heals 3 HP and the strongest ally gains +1 ATK.",
    onKill(state, side, inst) {
      const cap = inst.maxHp ?? inst.card.cardHp;
      const before = inst.currentHp;
      inst.currentHp = Math.min(cap, inst.currentHp + 3);
      const allies = state.players[side].field.filter((a) => a && a !== inst);
      if (allies.length) {
        const best = allies.reduce((a, b) =>
          (b.card.cardAttack + (b.attackBoost || 0)) >
          (a.card.cardAttack + (a.attackBoost || 0)) ? b : a);
        best.attackBoost = (best.attackBoost || 0) + 1;
        state.log.push({ id: state.log.length + 1, text: `🔮 Chandelure drained — +${inst.currentHp - before} HP, +1 ATK to ${best.card.name}.`, kind: "summon" });
      } else {
        state.log.push({ id: state.log.length + 1, text: `🔮 Chandelure drained +${inst.currentHp - before} HP.`, kind: "summon" });
      }
    },
  },
  254: {
    // Sceptree (Sceptile) — Overgrow: Grass aura
    name: "Leaf Storm",
    desc: "While on the field, your Grass Pokémon attack with +1 ATK and apply burn 25%.",
    fieldAura: { type: "grass", attackBonus: 1, statusOnHit: "burn" },
  },

  // --- Crowd-control / board-clear signatures --------------------------
  // These shine when the OPPONENT has filled their field. The more of them
  // there are, the harder these hit — keeps a wide board from snowballing.
  130: {
    // Gyarados — Tsunami
    name: "Tsunami",
    desc: "On summon, deals 2 + (1 per enemy on field) damage to every enemy.",
    onSummon(state, side, inst) {
      const otherSide = side === "player" ? "ai" : "player";
      const enemies = state.players[otherSide].field.filter(Boolean);
      if (!enemies.length) return;
      const dmg = 2 + enemies.length;
      let hits = 0, kos = 0;
      for (let i = 0; i < state.players[otherSide].field.length; i++) {
        const e = state.players[otherSide].field[i];
        if (!e) continue;
        e.currentHp = Math.max(0, e.currentHp - dmg);
        hits++;
        if (e.currentHp <= 0) {
          state.players[otherSide].discard.push(e.card);
          state.players[otherSide].field[i] = null;
          kos++;
        }
      }
      state.log.push({ id: state.log.length + 1, text: `🌊 Gyarados' Tsunami struck ${hits} foe${hits === 1 ? "" : "s"} for ${dmg}${kos ? `; ${kos} KO'd` : ""}.`, kind: "attack" });
    },
  },
  186: {
    // Politoed — Drizzle / Rain Storm
    name: "Rain Storm",
    desc: "On summon, deals 1 damage to every enemy AND heals every ally for 1.",
    onSummon(state, side, inst) {
      const otherSide = side === "player" ? "ai" : "player";
      let hits = 0, healed = 0;
      for (let i = 0; i < state.players[otherSide].field.length; i++) {
        const e = state.players[otherSide].field[i];
        if (!e) continue;
        e.currentHp = Math.max(0, e.currentHp - 1);
        hits++;
        if (e.currentHp <= 0) {
          state.players[otherSide].discard.push(e.card);
          state.players[otherSide].field[i] = null;
        }
      }
      for (const ally of state.players[side].field) {
        if (!ally || ally === inst) continue;
        const cap = ally.maxHp ?? ally.card.cardHp;
        const before = ally.currentHp;
        ally.currentHp = Math.min(cap, ally.currentHp + 1);
        healed += ally.currentHp - before;
      }
      if (hits || healed) {
        state.log.push({ id: state.log.length + 1, text: `🌧 Politoed's Rain Storm — ${hits} enemies hit, ${healed} HP healed.`, kind: "attack" });
      }
    },
  },
  9: {
    // Blastoise — already has Hydro Cannon aura; add a wide attack pattern too
    name: "Hydro Pump",
    desc: "Your Water specials hit for +1 ATK. On summon, deals 3 damage to a random enemy.",
    fieldAura: { type: "water", attackBonus: 1 },
    onSummon(state, side, inst) {
      const otherSide = side === "player" ? "ai" : "player";
      const targets = state.players[otherSide].field
        .map((c, i) => ({ c, i }))
        .filter((x) => x.c != null);
      if (!targets.length) return;
      const t = targets[Math.floor(Math.random() * targets.length)];
      t.c.currentHp = Math.max(0, t.c.currentHp - 3);
      state.log.push({ id: state.log.length + 1, text: `💧 Blastoise's Hydro Pump hit ${t.c.card.name} for 3.`, kind: "attack" });
      if (t.c.currentHp <= 0) {
        state.players[otherSide].discard.push(t.c.card);
        state.players[otherSide].field[t.i] = null;
        state.log.push({ id: state.log.length + 1, text: `${t.c.card.name} fainted!`, kind: "ko" });
      }
    },
  },

  // --- New explicit "defender" signatures: bulwark + retribution -------
  143: {
    // Snorlax — Bulwark
    name: "Bulwark",
    desc: "Taunts opponents (must attack first) and takes 2 less damage from non-Fighting attacks.",
    passive: { damageReduction: 2 },
  },
  131: {
    // Lapras — Frozen Wall
    name: "Frozen Wall",
    desc: "Taunts opponents. Whenever it's attacked, the attacker is paralyzed for 1 turn.",
    onPreHit(state, side, inst, attackerInst) {
      // Apply a paralyze status to the attacker; do NOT block the hit.
      if (attackerInst && !attackerInst.status) {
        attackerInst.status = { kind: "paralyze", turnsLeft: 1 };
        state.log.push({ id: state.log.length + 1, text: `❄ Lapras' Frozen Wall paralyzed ${attackerInst.card.name}!`, kind: "status" });
      }
      return false; // don't cancel
    },
  },
  213: {
    // Shuckle — Living Fortress
    name: "Living Fortress",
    desc: "Takes a flat 3 less damage from every attack (minimum 1) and taunts.",
    passive: { damageReduction: 3 },
  },
  464: {
    // Rhyperior — Solid Rock
    name: "Solid Rock",
    desc: "Taunts opponents. Super-effective hits deal half their normal damage.",
    passive: { resistSuperEffective: true },
  },
  389: {
    // Torterra — Continent
    name: "Continent",
    desc: "Taunts. On summon, heals each ally for 2.",
    onSummon(state, side, inst) {
      let healed = 0;
      for (const ally of state.players[side].field) {
        if (!ally || ally === inst) continue;
        const cap = ally.maxHp ?? ally.card.cardHp;
        const before = ally.currentHp;
        ally.currentHp = Math.min(cap, ally.currentHp + 2);
        healed += ally.currentHp - before;
      }
      if (healed) state.log.push({ id: state.log.length + 1, text: `🌳 Torterra's Continent healed ${healed} HP across the field.`, kind: "summon" });
    },
  },

  887: {
    // Dragapult
    name: "Phantom Force",
    desc: "On summon, deals 2 ghost damage to two random enemies.",
    onSummon(state, side, inst) {
      const otherSide = side === "player" ? "ai" : "player";
      const targets = state.players[otherSide].field
        .map((c, i) => ({ c, i }))
        .filter((x) => x.c != null);
      const shots = Math.min(2, targets.length);
      for (let s = 0; s < shots; s++) {
        const pick = targets[Math.floor(Math.random() * targets.length)];
        pick.c.currentHp = Math.max(0, pick.c.currentHp - 2);
        state.log.push({ id: state.log.length + 1, text: `👻 Dragapult's Phantom Force hit ${pick.c.card.name} for 2.`, kind: "attack" });
        if (pick.c.currentHp <= 0) {
          state.players[otherSide].discard.push(pick.c.card);
          state.players[otherSide].field[pick.i] = null;
          state.log.push({ id: state.log.length + 1, text: `${pick.c.card.name} fainted!`, kind: "ko" });
        }
      }
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
