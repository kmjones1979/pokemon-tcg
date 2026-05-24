// Story-mode chapter data + boss specs.
//
// Three regular chapters + one finale. Each chapter has:
//   id, name, locale (display), intro (narrative blurbs), boss spec,
//   reward shape (picks + biased types / guaranteed legendary).
//
// Bosses are NOT regular cards — they have phases (HP threshold → new
// behavior), scripted attack patterns, and AoE moves that hit both players.
// The story engine reads these specs and applies them.
//
// Server uses this to: build the boss "card", advance phases, and roll
// chapter-specific rewards. Client uses it to render intros + UI.

const CHAPTERS = [
  {
    id: "ch1_viridian",
    chapterNumber: 1,
    name: "Viridian Forest",
    locale: "VIRIDIAN FOREST",
    flavor: "A buzz rises from the canopy. The trees themselves seem to shift…",
    // Dark/dramatic legacy intro — kept as `intro_v1` for compatibility
    // with any older client that still reads the auto-timed lines.
    intro_v1: [
      "The forest grows still.",
      "Pidgey scatter. Caterpie freeze mid-crawl.",
      "Something massive lands behind you — its wings echoing like a storm.",
      "It's the Forest Tyrant — a Beedrill grown to monstrous size.",
    ],
    // Kid-friendly read-along, K-1 reading level. Each section becomes
    // one page in the read-along UI with a Read Aloud button.
    readAlong: [
      { id: "1", speaker: "narrator",  text: "It is a sunny day. You walk into the green forest. The trees are tall and the air is warm." },
      { id: "2", speaker: "pidgey",    text: "\"Look out!\" cried Pidgey. \"A big Beedrill lives here. He is very grumpy today!\"" },
      { id: "3", speaker: "narrator",  text: "Buzz! Buzz! A big Beedrill came down from the trees. He was as tall as a tree." },
      { id: "4", speaker: "caterpie",  text: "\"Please help us,\" said Caterpie. \"He is too big and too loud. We are scared.\"" },
      { id: "5", speaker: "narrator",  text: "You take a deep breath. You smile at your friends. It is time to be brave. Time to battle!" },
    ],
    enemyTrainerName: "Forest Tyrant",
    enemyAbility: "erika",
    boss: {
      // Anchored on Beedrill (#15) but stats are bespoke.
      anchorPokemonId: 15,
      displayName: "Forest Tyrant Beedrill",
      types: ["bug", "poison"],
      maxHp: 55,
      attack: 9,
      defense: 1,
      phases: [
        {
          // Phase 1 — opens with poison stinger pattern
          fromHpFraction: 1.0,
          attackPattern: ["sting", "sting", "twin-needle"],
          summonOnEntry: null,
        },
        {
          // Phase 2 — at 50% HP, summons swarm to defend itself
          fromHpFraction: 0.5,
          attackPattern: ["agility", "twin-needle", "swarm-strike"],
          summonOnEntry: { pokemonIds: [13, 13], note: "Beedrill calls in a swarm!" },
        },
      ],
      moves: {
        sting: { name: "Poison Sting", power: 1.0, target: "active", flavor: "Beedrill jabs with a venomous barb." },
        "twin-needle": { name: "Twin Needle", power: 1.3, target: "active", flavor: "A double-strike of needles!" },
        agility: { name: "Agility", power: 0, selfBuff: "speed", flavor: "Beedrill blurs into motion — its next strike will hit harder." },
        "swarm-strike": { name: "Swarm Strike", power: 1.4, target: "all", flavor: "The swarm descends on both trainers!" },
      },
    },
    reward: { picks: 3, themeType: "bug", guaranteedLegendary: false },
  },
  {
    id: "ch2_mt_moon",
    chapterNumber: 2,
    name: "Mt. Moon",
    locale: "MT. MOON · LEVEL B2",
    flavor: "Glowing moonstones illuminate cavern walls. Something stirs beneath the floor.",
    intro_v1: [
      "Your footsteps echo on damp stone.",
      "A low rumble. Then the ground itself splits open.",
      "An immense Onix coils up out of the rock — older than the mountain.",
      "Its eyes glow. It has not been disturbed in centuries.",
    ],
    readAlong: [
      { id: "1", speaker: "narrator",  text: "You go inside a big cave. Tiny moonstones glow on the walls. It is pretty and quiet." },
      { id: "2", speaker: "clefairy",  text: "\"Welcome!\" said Clefairy. \"Our friend Onix lives here. He has been sleeping for a long, long time.\"" },
      { id: "3", speaker: "narrator",  text: "The ground starts to shake. Up, up, up came a giant Onix made of rock. He stretched and looked at you." },
      { id: "4", speaker: "clefairy",  text: "\"Onix wants to play a game,\" said Clefairy. \"He wants to see if you are strong and brave.\"" },
      { id: "5", speaker: "narrator",  text: "You smile. You are ready. You can do this! Time to battle the rock friend!" },
    ],
    enemyTrainerName: "The Old One",
    enemyAbility: "brock",
    boss: {
      anchorPokemonId: 95,
      displayName: "Elder Onix",
      types: ["rock", "ground"],
      maxHp: 70,
      attack: 8,
      defense: 3,
      // Mid-fight evolution: at 50% HP, transforms into Steelix.
      transformAt: 0.5,
      transformTo: {
        anchorPokemonId: 208,
        displayName: "Awakened Steelix",
        types: ["steel", "ground"],
        attackBonus: 3,
        defenseBonus: 2,
        flavor: "The Onix's body sheathes itself in living steel — Steelix awakened!",
      },
      phases: [
        {
          fromHpFraction: 1.0,
          attackPattern: ["rock-throw", "rock-throw", "earthquake"],
          summonOnEntry: null,
        },
        {
          fromHpFraction: 0.5,
          attackPattern: ["iron-tail", "earthquake", "iron-tail"],
          summonOnEntry: null,
        },
      ],
      moves: {
        "rock-throw": { name: "Rock Throw", power: 1.0, target: "active", flavor: "A boulder is hurled at the active Pokémon." },
        earthquake: { name: "Earthquake", power: 1.2, target: "all", flavor: "The cavern shakes — everyone takes the hit!" },
        "iron-tail": { name: "Iron Tail", power: 1.5, target: "active", flavor: "A devastating metallic strike." },
      },
    },
    reward: { picks: 4, themeType: "rock", guaranteedLegendary: false },
  },
  {
    id: "ch3_cerulean_cave",
    chapterNumber: 3,
    name: "Cerulean Cave",
    locale: "CERULEAN CAVE · UNKNOWN DEPTH",
    flavor: "A psychic pressure thickens the air. Something brilliant — and angry — waits in the dark.",
    intro_v1: [
      "You feel it before you see it. Your thoughts go quiet.",
      "A figure floats in the chamber's center, eyes closed.",
      "Mewtwo opens its eyes.",
      "“So. The humans came after all.”",
    ],
    readAlong: [
      { id: "1", speaker: "narrator", text: "Deep inside the big cave, the air feels funny. Like a tickle in your brain. Something special is in here." },
      { id: "2", speaker: "narrator", text: "In the middle of the room, you see Mewtwo. He is floating in the air. His eyes are closed." },
      { id: "3", speaker: "mewtwo",   text: "\"Hello, little trainer,\" said Mewtwo. \"I have waited a long time to meet a brave friend like you.\"" },
      { id: "4", speaker: "mewtwo",   text: "\"Let us test our power,\" said Mewtwo. \"Show me what you have learned. Show me how kind and strong you are.\"" },
      { id: "5", speaker: "narrator", text: "You stand tall. Your Pokémon stand with you. Get ready — the battle begins!" },
    ],
    enemyTrainerName: "Mewtwo",
    enemyAbility: "sabrina",
    boss: {
      anchorPokemonId: 150,
      displayName: "Mewtwo",
      types: ["psychic"],
      maxHp: 80,
      attack: 10,
      defense: 2,
      phases: [
        {
          fromHpFraction: 1.0,
          attackPattern: ["confusion", "psybeam", "recover"],
          summonOnEntry: null,
        },
        {
          // Phase 2 at 50% — enters "Psystrike" mode. Attack doubles. Ignores defense.
          fromHpFraction: 0.5,
          attackPattern: ["psystrike", "psystrike", "mind-crush"],
          ignoreDefense: true,
          attackBonus: 4,
          summonOnEntry: { pokemonIds: [], note: "Mewtwo unleashes its true power — Psystrike awakened!" },
        },
      ],
      moves: {
        confusion: { name: "Confusion", power: 1.0, target: "active", flavor: "A wave of psychic distortion." },
        psybeam: { name: "Psybeam", power: 1.2, target: "active", flavor: "A focused beam of mental energy." },
        recover: { name: "Recover", power: 0, selfHeal: 6, flavor: "Mewtwo heals itself for 6 HP." },
        psystrike: { name: "Psystrike", power: 1.4, target: "active", flavor: "A physical pulse of pure psychic force." },
        "mind-crush": { name: "Mind Crush", power: 1.5, target: "all", flavor: "An overwhelming psychic detonation hits both trainers!" },
      },
    },
    reward: { picks: 4, themeType: "psychic", guaranteedLegendary: true },
  },
  {
    id: "finale_dragons_den",
    chapterNumber: 4,
    name: "Dragon's Den",
    locale: "DRAGON'S DEN · CHAMPION'S CHAMBER",
    isFinale: true,
    flavor: "The final trial. The Dragon Master awaits.",
    intro_v1: [
      "Wind howls through the chamber's tall windows.",
      "Lance stands at the far end, his cape settling.",
      "“You've come a long way, trainers. Show me what you've learned.”",
      "Behind him — Dragonite, eyes blazing. This is the final test.",
    ],
    readAlong: [
      { id: "1", speaker: "narrator",  text: "You climb up high to the Dragon's Den. The wind is strong. The view is so big. You can see the whole world!" },
      { id: "2", speaker: "narrator",  text: "Champion Lance is at the top. He is wearing a big red cape. He smiles when he sees you." },
      { id: "3", speaker: "lance",     text: "\"You made it!\" said Lance. \"You have come a very long way. You have read so many stories.\"" },
      { id: "4", speaker: "narrator",  text: "Behind Lance is a big, friendly Dragonite. Its wings go whoosh. Its eyes are kind but brave." },
      { id: "5", speaker: "lance",     text: "\"This is your last test,\" said Lance. \"Show me how much you have grown. We are all proud of you!\"" },
      { id: "6", speaker: "narrator",  text: "You take a big breath. Your Pokémon are by your side. You can win — let the final battle begin!" },
    ],
    enemyTrainerName: "Champion Lance",
    enemyAbility: "lance",
    boss: {
      anchorPokemonId: 149,
      displayName: "Lance's Dragonite",
      types: ["dragon", "flying"],
      maxHp: 100,
      attack: 11,
      defense: 3,
      phases: [
        {
          fromHpFraction: 1.0,
          attackPattern: ["dragon-claw", "hyper-beam", "dragon-claw"],
          summonOnEntry: null,
        },
        {
          fromHpFraction: 0.66,
          attackPattern: ["dragon-claw", "outrage", "thunder"],
          attackBonus: 2,
          summonOnEntry: { pokemonIds: [148, 148], note: "Lance sends out his Dragonair pair!" },
        },
        {
          // Final phase — devastating AoE
          fromHpFraction: 0.33,
          attackPattern: ["outrage", "draco-meteor", "outrage"],
          attackBonus: 4,
          ignoreDefense: true,
          summonOnEntry: { pokemonIds: [], note: "Dragonite enters a fury — its scales shimmer with rage!" },
        },
      ],
      moves: {
        "dragon-claw": { name: "Dragon Claw", power: 1.2, target: "active", flavor: "A swift dragon strike." },
        "hyper-beam": { name: "Hyper Beam", power: 1.6, target: "active", flavor: "A devastating beam — needs recharge next turn.", recharge: true },
        outrage: { name: "Outrage", power: 1.5, target: "active", flavor: "Dragonite thrashes in pure rage." },
        thunder: { name: "Thunder", power: 1.3, target: "active", flavor: "A bolt from the sky." },
        "draco-meteor": { name: "Draco Meteor", power: 1.7, target: "all", flavor: "Meteors crash on both trainers — devastating AoE!" },
      },
    },
    reward: { picks: 5, themeType: "dragon", guaranteedLegendary: true },
  },
];

function getChapter(id) {
  return CHAPTERS.find((c) => c.id === id) || null;
}

function chapterMeta() {
  return CHAPTERS.map((c) => ({
    id: c.id,
    chapterNumber: c.chapterNumber,
    name: c.name,
    locale: c.locale,
    flavor: c.flavor,
    isFinale: !!c.isFinale,
    bossDisplayName: c.boss.displayName,
    bossTypes: c.boss.types,
    bossMaxHp: c.boss.maxHp,
    reward: c.reward,
  }));
}

module.exports = { CHAPTERS, getChapter, chapterMeta };
