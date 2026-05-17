// Asset/string indirection layer — the foundation for the IP rebrand.
//
// Today every Pokémon name, sprite URL, cry audio URL, and trainer
// portrait is inlined throughout the codebase. To swap the entire game
// to original IP without rewriting every call site, all those lookups
// will route through this registry.
//
// The active theme is chosen by the `theme` field in the export. Flip
// to "original" once the cursed-cute roster (16 creatures) is ready;
// today only "pokemon" is implemented and the export is a thin
// pass-through.
//
// CI guardrail: once `original` ships, a deploy-time check fails the
// build if `theme === "pokemon"` ever reaches the prod branch.

const THEME = (() => {
  // Read from a build-time env var when available (esbuild can inline
  // process.env.GAME_THEME via --define). Falls back to "pokemon" so
  // current builds keep working.
  if (typeof process !== "undefined" && process.env && process.env.GAME_THEME) {
    return process.env.GAME_THEME;
  }
  // Client-side toggle for testing the original-IP roster locally
  // before it's the default.
  try {
    const q = new URLSearchParams(location.search);
    if (q.get("theme")) return q.get("theme");
    const stored = localStorage.getItem("pokemon-tcg-theme");
    if (stored) return stored;
  } catch {}
  return "pokemon";
})();

// Pokémon theme — pass-through. Names, sprites, cries come from the
// Supabase pokedex / PokeAPI CDN as they do today.
const POKEMON_THEME = {
  id: "pokemon",
  // Display name for a card. card.name from the pokedex.
  cardName(card) { return card?.name || "Unknown"; },
  // Front sprite URL. card.sprite_front from the pokedex.
  cardSpriteUrl(card) { return card?.sprite_front || null; },
  // Cry audio URL. card.cry_url from the pokedex.
  cardCryUrl(card)   { return card?.cry_url || null; },
  // Type icon string (emoji today).  See cards.js TYPE_GLYPH.
  // (Indirection unused yet — added so future theme can override.)
  typeIcon(type) { return null; },
  // Trainer portrait override (null = use existing sprite URL).
  trainerSpriteUrl(trainerId) { return null; },
  // Family / game-mode display strings. UI copy that depends on
  // theme branding goes here.  Empty for pass-through.
  strings: {},
};

// Original-IP theme (cursed-cute roster) — STUB. Will replace POKEMON_THEME
// as the default once the 16-creature roster lands.  Today this is a copy
// of the pass-through so flipping the flag doesn't break anything.
const ORIGINAL_THEME = {
  id: "original",
  cardName(card)        { return card?.name || "Unknown"; },
  cardSpriteUrl(card)   { return card?.sprite_front || null; },
  cardCryUrl(card)      { return null; }, // no audio yet for original IP
  typeIcon(type)        { return null; },
  trainerSpriteUrl(id)  { return null; },
  strings: {},
};

const THEMES = { pokemon: POKEMON_THEME, original: ORIGINAL_THEME };

export const theme = THEMES[THEME] || POKEMON_THEME;
export const themeId = theme.id;

// Convenience helpers — call sites import these instead of touching
// the theme object directly. New helpers added here whenever a new
// kind of asset starts varying across themes.
export const cardName       = (card) => theme.cardName(card);
export const cardSpriteUrl  = (card) => theme.cardSpriteUrl(card);
export const cardCryUrl     = (card) => theme.cardCryUrl(card);
export const typeIcon       = (type) => theme.typeIcon(type);
export const trainerSpriteUrlForTheme = (id) => theme.trainerSpriteUrl(id);
