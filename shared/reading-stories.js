// Read-along stories for young readers (K–2 level).
//
// Distinct from the battle-based Story Mode in server-modules/story.js
// — those run combat encounters; this is a quiet reading experience
// designed to help kids practice. Each story has 4-6 sections of short
// sentences, repeated patterns, and high-frequency vocabulary.
//
// Audio: each section names a `speaker` (Pokémon name). When the
// ElevenLabs TTS pipeline runs (slice 5b), it generates an MP3 per
// section using a voice ID assigned to the speaker, then caches the
// public URL in `audioUrl`. Until then `audioUrl` is null and the
// UI hides the "Read aloud" button gracefully.

const READING_STORIES = [
  {
    id: "pikachus-lost-berry",
    title: "Pikachu's Lost Berry",
    cover: { pokemonId: 25, glyph: "⚡", themeType: "electric" },
    estimatedMinutes: 4,
    readingLevel: "K-1",
    summary: "Pikachu loses a special berry and friends help find it.",
    sections: [
      {
        id: "1",
        speaker: "narrator",
        text: "Pikachu had a special berry. It was big. It was red. It was sweet.",
        audioUrl: null,
      },
      {
        id: "2",
        speaker: "pikachu",
        text: "\"My berry!\" said Pikachu. \"I lost my berry! Where did it go?\"",
        audioUrl: null,
      },
      {
        id: "3",
        speaker: "squirtle",
        text: "Squirtle came to help. \"Don't worry, Pikachu! I will look in the lake. Berries float!\"",
        audioUrl: null,
      },
      {
        id: "4",
        speaker: "bulbasaur",
        text: "Bulbasaur came to help. \"I will look in the tall grass. Berries hide!\"",
        audioUrl: null,
      },
      {
        id: "5",
        speaker: "charmander",
        text: "Charmander came to help. \"I will look near the warm rocks. Berries roll!\"",
        audioUrl: null,
      },
      {
        id: "6",
        speaker: "narrator",
        text: "They all looked and looked. Then Pikachu sat down — and ouch! Pikachu was sitting on the berry the whole time! Everyone laughed.",
        audioUrl: null,
      },
    ],
  },
  {
    id: "the-brave-bug-catcher",
    title: "The Brave Caterpie",
    cover: { pokemonId: 10, glyph: "🐛", themeType: "bug" },
    estimatedMinutes: 4,
    readingLevel: "K-1",
    summary: "A small Caterpie shows that brave comes in all sizes.",
    sections: [
      {
        id: "1",
        speaker: "narrator",
        text: "Caterpie was small. Caterpie was slow. But Caterpie was brave.",
        audioUrl: null,
      },
      {
        id: "2",
        speaker: "pidgey",
        text: "Pidgey flew down. \"Caterpie, you are too small to climb the big tree! Stay here with me.\"",
        audioUrl: null,
      },
      {
        id: "3",
        speaker: "caterpie",
        text: "\"I can do it,\" said Caterpie. \"Slow and small is still strong.\"",
        audioUrl: null,
      },
      {
        id: "4",
        speaker: "narrator",
        text: "Up went Caterpie. One leaf. Two leaves. Three leaves. Up, up, up to the very top.",
        audioUrl: null,
      },
      {
        id: "5",
        speaker: "caterpie",
        text: "\"I made it!\" said Caterpie. The sun was warm. The view was big. Caterpie smiled.",
        audioUrl: null,
      },
    ],
  },
  {
    id: "snorlaxs-big-nap",
    title: "Snorlax's Big Nap",
    cover: { pokemonId: 143, glyph: "💤", themeType: "normal" },
    estimatedMinutes: 5,
    readingLevel: "1-2",
    summary: "Snorlax sleeps on the path. Friends find a kind way to help.",
    sections: [
      {
        id: "1",
        speaker: "narrator",
        text: "Snorlax was tired. Very, very tired. Snorlax took a nap. Right in the middle of the path!",
        audioUrl: null,
      },
      {
        id: "2",
        speaker: "jigglypuff",
        text: "\"Oh no,\" said Jigglypuff. \"I cannot get past. Snorlax is so big!\"",
        audioUrl: null,
      },
      {
        id: "3",
        speaker: "clefairy",
        text: "\"Do not push,\" said Clefairy. \"Do not yell. Snorlax is tired. Snorlax needs rest.\"",
        audioUrl: null,
      },
      {
        id: "4",
        speaker: "jigglypuff",
        text: "\"What can we do?\" asked Jigglypuff. Clefairy smiled. \"We can sing a soft song. We can wait. Friends are kind.\"",
        audioUrl: null,
      },
      {
        id: "5",
        speaker: "narrator",
        text: "So they sang. And they waited. And when Snorlax woke up, Snorlax said thank you, and moved off the path.",
        audioUrl: null,
      },
      {
        id: "6",
        speaker: "narrator",
        text: "Rest is good. Patience is good. Being kind is the best of all.",
        audioUrl: null,
      },
    ],
  },
];

// Lookup helpers — keep the API tiny so callers don't reach into the
// raw array shape (which we may want to evolve later, e.g. lazy-load
// from JSON).
function listStories() {
  return READING_STORIES.map((s) => ({
    id: s.id,
    title: s.title,
    cover: s.cover,
    estimatedMinutes: s.estimatedMinutes,
    readingLevel: s.readingLevel,
    summary: s.summary,
    sectionCount: s.sections.length,
  }));
}

function getStory(id) {
  return READING_STORIES.find((s) => s.id === id) || null;
}

// All distinct speakers across every story. Useful for the TTS
// generation script (slice 5b) so it knows which voice IDs to allocate.
function allSpeakers() {
  const set = new Set();
  for (const s of READING_STORIES) {
    for (const sec of s.sections) {
      if (sec.speaker) set.add(sec.speaker);
    }
  }
  return [...set].sort();
}

module.exports = {
  READING_STORIES,
  listStories,
  getStory,
  allSpeakers,
};
