// Short TTS clips that play during battle events (attack lands, KO,
// match win, etc.). Generated via the same ElevenLabs+Supabase pipeline
// as Reading Mode stories; clips are cached in Supabase Storage so each
// match playback is free.
//
// Multiple variants per event so playback doesn't feel robotic — the
// client picks one at random per fire.
//
// Event taxonomy (matched against engine signals):
//   hit          — any attack that connects (every turn → fires often)
//   super        — multiplier > 1.5 OR critical hit
//   weak         — multiplier < 1
//   ko           — defender's currentHp hit 0
//   win          — state.winner set to "player"
//   loss         — state.winner set to "ai"
//   spell-freeze — Freeze spell cast
//   spell-heal   — Heal spell cast
//   spell-evolve — Evolve spell cast
//   spell-aoe    — AOE spell cast

const EMOTE_BASE_ID = "e_";

const BATTLE_EMOTES = [
  // hit (frequent — keep 4 variants so it's not robotic)
  { id: "hit-1",   event: "hit",   text: "Pow!",        voiceKey: "energetic" },
  { id: "hit-2",   event: "hit",   text: "Bam!",        voiceKey: "energetic" },
  { id: "hit-3",   event: "hit",   text: "Got ya!",     voiceKey: "energetic" },
  { id: "hit-4",   event: "hit",   text: "Take that!",  voiceKey: "energetic" },

  // super effective (less frequent — 2 variants)
  { id: "super-1", event: "super", text: "Super effective!", voiceKey: "narrator" },
  { id: "super-2", event: "super", text: "Critical hit!",    voiceKey: "narrator" },

  // weak hit
  { id: "weak-1",  event: "weak",  text: "Not very effective...", voiceKey: "narrator" },

  // KO
  { id: "ko-1",    event: "ko",    text: "Fainted!",        voiceKey: "narrator" },
  { id: "ko-2",    event: "ko",    text: "Knocked out!",    voiceKey: "energetic" },

  // Match outcome
  { id: "win-1",   event: "win",   text: "Victory!",        voiceKey: "energetic" },
  { id: "win-2",   event: "win",   text: "Awesome win!",    voiceKey: "energetic" },
  { id: "loss-1",  event: "loss",  text: "Good game!",      voiceKey: "narrator" },

  // Spell flavour — one clip per active effect so the audio shifts
  // with the gameplay instead of replaying the same "spell cast" line.
  { id: "spell-freeze-1", event: "spell-freeze", text: "Frozen solid!",     voiceKey: "narrator" },
  { id: "spell-heal-1",   event: "spell-heal",   text: "All better!",       voiceKey: "energetic" },
  { id: "spell-evolve-1", event: "spell-evolve", text: "It evolved!",       voiceKey: "narrator" },
  { id: "spell-aoe-1",    event: "spell-aoe",    text: "Earthquake!",       voiceKey: "narrator" },
  // Slice 6 spells:
  { id: "spell-bolt-1",         event: "spell-bolt",         text: "Lightning bolt!", voiceKey: "narrator" },
  { id: "spell-sleep-1",        event: "spell-sleep-powder", text: "Sleepy time!",    voiceKey: "energetic" },
  { id: "spell-cleanse-1",      event: "spell-cleanse",      text: "All clean!",      voiceKey: "energetic" },
  { id: "spell-surge-1",        event: "spell-surge",        text: "Power up!",       voiceKey: "energetic" },
  { id: "spell-scout-1",        event: "spell-scout",        text: "Card draw!",      voiceKey: "energetic" },
  { id: "spell-phoenix-1",      event: "spell-phoenix",      text: "Rise again!",     voiceKey: "narrator" },
  // Slice 7 spells:
  { id: "spell-burn-1",         event: "spell-burn",         text: "On fire!",         voiceKey: "energetic" },
  { id: "spell-shield-1",       event: "spell-shield",       text: "Shields up!",      voiceKey: "energetic" },
  { id: "spell-mass-heal-1",    event: "spell-mass-heal",    text: "Everyone heal!",   voiceKey: "energetic" },
  { id: "spell-power-strike-1", event: "spell-power-strike", text: "Power strike!",    voiceKey: "energetic" },
  { id: "spell-counter-1",      event: "spell-counter",      text: "Counter ready!",   voiceKey: "narrator" },
  { id: "spell-stop-time-1",    event: "spell-stop-time",    text: "Time stop!",       voiceKey: "narrator" },
  // Slice 8 spells:
  { id: "spell-confusion-1",    event: "spell-confusion",    text: "Confused!",        voiceKey: "energetic" },
  { id: "spell-storm-1",        event: "spell-storm",        text: "Storm strike!",    voiceKey: "narrator" },
  { id: "spell-burst-1",        event: "spell-burst",        text: "Burst!",           voiceKey: "energetic" },
  { id: "spell-brave-strike-1", event: "spell-brave-strike", text: "Brave strike!",    voiceKey: "energetic" },
  { id: "spell-refresh-1",      event: "spell-refresh",      text: "Refreshed!",       voiceKey: "energetic" },
  { id: "spell-drain-1",        event: "spell-drain",        text: "Life drain!",      voiceKey: "narrator" },
];

const EMOTE_VOICES = {
  // Same voice IDs used in scripts/generate-tts.js — verified accessible
  // on the project's ElevenLabs tier via /v1/voices.
  // Both keys map to kid-feeling voices so battle reactions sound like a
  // child playing the game, not a corporate announcer:
  //   energetic = "Pow!", "Got ya!" — bouncy + playful
  //   narrator  = "Super effective!", "Knocked out!" — excited kid announcing
  energetic: "cgSgspJ2msm6clMCkdW9", // Jessica — playful, bright, warm
  narrator:  "FGY2WhTYpPnrIDTdsKH5", // Laura — enthusiast, quirky (kid-announcer)
};

function listEmotes() {
  return BATTLE_EMOTES;
}

function emotesForEvent(event) {
  return BATTLE_EMOTES.filter((e) => e.event === event);
}

function emoteEvents() {
  return [...new Set(BATTLE_EMOTES.map((e) => e.event))].sort();
}

module.exports = {
  BATTLE_EMOTES,
  EMOTE_VOICES,
  EMOTE_BASE_ID,
  listEmotes,
  emotesForEvent,
  emoteEvents,
};
