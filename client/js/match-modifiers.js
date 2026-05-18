// Random match modifiers — roll at match start. 30% of matches get
// one of these twists; the other 70% are vanilla so the modifiers
// stay rare enough to feel special.
//
// Effects are applied by mutating state at match-start (createGame
// has already run by the time the modifier rolls). All modifiers
// are symmetric — both sides get the buff or debuff — so they add
// variety without unbalancing.
//
// Names + icons are surfaced via the VS cinematic subtitle and a
// small banner on the first turn.

export const MODIFIERS = [
  {
    id: "fast-start",
    name: "Fast Start",
    icon: "⚡",
    desc: "Both sides start with +1 max energy.",
    apply(state) {
      for (const side of ["player", "ai"]) {
        state.players[side].maxEnergy = Math.min(10, state.players[side].maxEnergy + 1);
        state.players[side].energy    = Math.min(state.players[side].maxEnergy, state.players[side].energy + 1);
      }
    },
  },
  {
    id: "glass-cannon",
    name: "Glass Cannon",
    icon: "💥",
    desc: "All damage dealt is amplified by 50%.",
    apply(state) {
      state.modifier_damageMult = 1.5;
    },
  },
  {
    id: "iron-wall",
    name: "Iron Wall",
    icon: "🛡",
    desc: "All damage dealt is reduced by 30%. Long, tactical fights.",
    apply(state) {
      state.modifier_damageMult = 0.7;
    },
  },
  {
    id: "type-storm-fire",
    name: "Fire Storm",
    icon: "🔥",
    desc: "Fire attacks deal +2 ATK all match.",
    apply(state) {
      state.modifier_typeAtkBonus = { type: "fire", bonus: 2 };
    },
  },
  {
    id: "type-storm-water",
    name: "Tidal Storm",
    icon: "🌊",
    desc: "Water attacks deal +2 ATK all match.",
    apply(state) {
      state.modifier_typeAtkBonus = { type: "water", bonus: 2 };
    },
  },
  {
    id: "type-storm-electric",
    name: "Thunder Storm",
    icon: "⚡",
    desc: "Electric attacks deal +2 ATK all match.",
    apply(state) {
      state.modifier_typeAtkBonus = { type: "electric", bonus: 2 };
    },
  },
  {
    id: "last-stand",
    name: "Last Stand",
    icon: "🪦",
    desc: "Comeback kicks in earlier — at 40% HP instead of 25%.",
    apply(state) {
      state.modifier_comebackThreshold = 0.4;
      // effectiveCost reads this per-player so it survives any cloning.
      for (const side of ["player", "ai"]) {
        state.players[side]._comebackThreshold = 0.4;
      }
    },
  },
  {
    id: "crit-carnival",
    name: "Crit Carnival",
    icon: "🎯",
    desc: "Base crit chance doubled (10% → 20%).",
    apply(state) {
      state.modifier_critBoost = 0.10;
    },
  },
  {
    id: "lucky-draws",
    name: "Lucky Draws",
    icon: "🎴",
    desc: "Every match-start hand gets +1 card.",
    apply(state) {
      // Already-shuffled — pull one more from each deck onto each hand.
      for (const side of ["player", "ai"]) {
        const p = state.players[side];
        if (p.deck.length > 0 && p.hand.length < 10) {
          p.hand.push(p.deck.shift());
        }
      }
    },
  },
];

// Picks a modifier with `chance` probability (0..1). Returns null if
// nothing was rolled. Pure function — caller passes its own rand for
// determinism in tests.
export function rollModifier(rand = Math.random, chance = 0.3) {
  if (rand() >= chance) return null;
  const idx = Math.floor(rand() * MODIFIERS.length);
  return MODIFIERS[idx] || MODIFIERS[0];
}

// Apply a chosen modifier to state. Safe to call with null (no-op).
// Returns the modifier (or null) so callers can log/display it.
export function applyModifier(state, modifier) {
  if (!state || !modifier) return null;
  try {
    modifier.apply(state);
    state.modifierActive = { id: modifier.id, name: modifier.name, icon: modifier.icon };
    state.log?.push?.({
      id: (state.log.length || 0) + 1,
      text: `${modifier.icon} ${modifier.name} — ${modifier.desc}`,
      kind: "modifier",
    });
  } catch (err) {
    console.warn("[match-modifier] apply failed:", err);
  }
  return modifier;
}
