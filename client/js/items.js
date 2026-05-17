// In-match items. Each player starts every match with a small kit of
// single-use items. They add tactical depth without requiring deck-builder
// changes or any new server tables.
//
// Pure module — no DOM, no state mutation outside the input state object.

export const ITEM_DEFS = {
  potion: {
    id: "potion",
    name: "Potion",
    desc: "Heal one of your Pokémon for 4 HP.",
    icon: "🧪",
    cost: 1,
    target: "ownField",
  },
  energy: {
    id: "energy",
    name: "Energy Crystal",
    desc: "Gain +2 Energy this turn (caps at your max).",
    icon: "💎",
    cost: 0,
    target: "none",
  },
  switch: {
    id: "switch",
    name: "Switch",
    desc: "Recall one of your Pokémon back to your hand.",
    icon: "🔄",
    cost: 0,
    target: "ownField",
  },
  revive: {
    id: "revive",
    name: "Revive",
    desc: "Bring back your most recently KO'd Pokémon at 50% HP.",
    icon: "✨",
    cost: 3,
    target: "none",
  },
  luckyDraw: {
    id: "luckyDraw",
    name: "Lucky Draw",
    desc: "Draw 2 cards from your deck.",
    icon: "🎴",
    cost: 1,
    target: "none",
  },
};

export function defaultKit() {
  return [
    { id: "potion", uses: 1 },
    { id: "energy", uses: 1 },
    { id: "switch", uses: 1 },
    { id: "revive", uses: 1 },
    { id: "luckyDraw", uses: 1 },
  ];
}

export function itemDef(id) {
  return ITEM_DEFS[id] || null;
}

// Apply an item against the state. Returns { ok, reason?, ... }.
// `target` is interpreted by item: ownField → slot index; none → ignored.
export function useItem(state, side, itemId, target) {
  if (state.winner) return { ok: false, reason: "Game over" };
  if (state.activePlayer !== side) return { ok: false, reason: "Not your turn" };
  if (state.phase !== "main") return { ok: false, reason: "Wrong phase" };

  const p = state.players[side];
  if (!p.items) p.items = defaultKit();
  const slot = p.items.find((i) => i.id === itemId);
  if (!slot || slot.uses <= 0) return { ok: false, reason: "Item depleted" };
  const def = ITEM_DEFS[itemId];
  if (!def) return { ok: false, reason: "Unknown item" };
  if (p.energy < def.cost) return { ok: false, reason: `Need ${def.cost} Energy` };

  let result = { ok: true, itemId, name: def.name, icon: def.icon };

  switch (itemId) {
    case "potion": {
      const inst = p.field[target];
      if (!inst) return { ok: false, reason: "Pick a Pokémon" };
      const before = inst.currentHp;
      const cap = inst.maxHp ?? inst.card.cardHp;
      inst.currentHp = Math.min(cap, inst.currentHp + 4);
      result.healed = inst.currentHp - before;
      result.targetSlot = target;
      state.log.push({ id: state.log.length + 1, text: `🧪 ${inst.card.name} healed ${result.healed} HP.`, kind: "status" });
      break;
    }
    case "energy": {
      const before = p.energy;
      p.energy = Math.min(p.maxEnergy, p.energy + 2);
      result.gained = p.energy - before;
      state.log.push({ id: state.log.length + 1, text: `💎 Energy Crystal: +${result.gained} Energy.`, kind: "summon" });
      break;
    }
    case "switch": {
      const inst = p.field[target];
      if (!inst) return { ok: false, reason: "Pick a Pokémon" };
      p.field[target] = null;
      p.hand.push(inst.card);
      result.recalled = inst.card.name;
      result.targetSlot = target;
      state.log.push({ id: state.log.length + 1, text: `🔄 Recalled ${inst.card.name} to hand.`, kind: "summon" });
      break;
    }
    case "revive": {
      // Bring back the most-recently-discarded Pokémon at 50% max HP.
      const lastIdx = p.discard.length - 1;
      if (lastIdx < 0) return { ok: false, reason: "No Pokémon to revive" };
      const emptyIdx = p.field.findIndex((s) => s == null);
      if (emptyIdx < 0) return { ok: false, reason: "Field is full" };
      const card = p.discard.pop();
      const reviveHp = Math.max(1, Math.round(card.cardHp / 2));
      const inst = {
        instanceId: "revive-" + Date.now(),
        card,
        currentHp: reviveHp,
        maxHp: card.cardHp,
        summoningSickness: true,
        status: null,
        attackBoost: card.shinyLevel || 0,
        level: card.shinyLevel || 0,
      };
      p.field[emptyIdx] = inst;
      result.revivedCard = card.name;
      result.targetSlot = emptyIdx;
      state.log.push({ id: state.log.length + 1, text: `✨ ${card.name} revived at ${reviveHp} HP!`, kind: "summon" });
      break;
    }
    case "luckyDraw": {
      let drew = 0;
      const drawn = [];
      for (let i = 0; i < 2; i++) {
        if (p.deck.length === 0) break;
        if (p.hand.length >= 10) break;
        const c = p.deck.shift();
        p.hand.push(c);
        drawn.push(c.name);
        drew++;
      }
      if (drew === 0) return { ok: false, reason: "Hand full or deck empty" };
      result.drew = drew;
      result.drawnNames = drawn;
      state.log.push({ id: state.log.length + 1, text: `🎴 Lucky Draw: drew ${drawn.join(", ")}.`, kind: "summon" });
      break;
    }
  }

  p.energy -= def.cost;
  slot.uses -= 1;
  return result;
}
