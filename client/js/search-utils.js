// Pure search/filter helpers for the Pokédex overlay and the deck
// list. Kept DOM-free so tests can exercise the matching logic without
// standing up a browser. Both filters share the same normalization
// path so a user typing "char" matches Pokémon names, dex IDs, types,
// and (for decks) deck names + contained Pokémon names.
//
// Tokenization:
//   "Char.lizard / fire" → ["char", "lizard", "fire"]
//   - lowercases
//   - strips non-alphanumeric so "char." matches "char"
//   - splits on whitespace, slashes, dashes
//   - drops empty tokens
// A row matches if every token appears as a substring of any of its
// haystack strings (AND semantics) — type "fire char" finds Charmander
// without requiring the user to know the exact column order.

export function normalizeQuery(q) {
  if (q == null) return [];
  return String(q)
    .toLowerCase()
    .split(/[\s/\-_,]+/)
    .map((tok) => tok.replace(/[^a-z0-9]+/g, ""))
    .filter(Boolean);
}

// Returns true if every token in `tokens` is a substring of at least
// one of the haystack strings.
export function matchesAllTokens(tokens, haystacks) {
  if (!tokens.length) return true;
  const hay = haystacks
    .filter((s) => s != null)
    .map((s) => String(s).toLowerCase());
  for (const tok of tokens) {
    if (!hay.some((h) => h.includes(tok))) return false;
  }
  return true;
}

// Filter pokedex entries (rows from /me/pokedex) by a free-text query.
// Each row has: { id, name, types?: [], generation, ... }.
// Matching against: name, padded dex id, types, generation label.
export function filterPokedexEntries(entries, query) {
  const tokens = normalizeQuery(query);
  if (!tokens.length) return entries;
  return entries.filter((r) => {
    const dexId = String(r.id || "");
    const padded = dexId.padStart(3, "0");
    const types = Array.isArray(r.types) ? r.types : [];
    const haystacks = [
      r.name, dexId, padded,
      `gen${r.generation || ""}`,
      ...types,
    ];
    return matchesAllTokens(tokens, haystacks);
  });
}

// Filter saved decks by query. `pokedexById` maps Pokémon id → card
// shape so we can search by contained-Pokémon name. A deck matches if:
//   - its name contains the query, OR
//   - any Pokémon in card_ids matches by name/type
// Multi-token queries are AND'd — "fire pikachu" finds decks that
// match BOTH (e.g. a fire-themed deck that also includes Pikachu).
export function filterDecks(decks, pokedexById, query) {
  const tokens = normalizeQuery(query);
  if (!tokens.length) return decks;
  return decks.filter((d) => {
    const ids = Array.isArray(d.card_ids) ? d.card_ids : [];
    const haystacks = [d.name || ""];
    for (const id of ids) {
      const card = pokedexById?.get?.(id) || null;
      if (!card) continue;
      haystacks.push(card.name);
      if (Array.isArray(card.types)) haystacks.push(...card.types);
    }
    return matchesAllTokens(tokens, haystacks);
  });
}
