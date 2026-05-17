# pokemon-tcg — Plan toward 1M users (Pokémon kept as IP)

**North Star (every phase exits against these):**
- D1 retention ≥ 40%
- K-factor ≥ 0.6
- Time-to-first-win ≤ 90 s

**Velocity contract:** each phase ≤ 2 weeks, ends with deploy + measured
exit. Anything that doesn't move D1, K, or time-to-first-win gets cut
or deferred.

**Confirmed scope:** the game stays a trading card game. **The IP
rebrand is deferred for now** — Pokémon stays as the working IP. A
rebrand to original creatures will eventually happen; the registry
layer (`client/js/registry.js`) is already in place so that swap is
a one-flag flip when the time comes. The 1M number is the quality
bar we're building toward.

## Phase 1 decisions (approved 2026-05-17)

1. **Art direction:** Pokémon stays. Cursed-cute remains the option
   for a future flip if circumstances change; registry.js is in place
   to make that swap one-flag if it ever happens.
2. **Analytics:** Vercel Analytics (zero-config). Free pageviews +
   Web Vitals auto-tracked. Custom events ride `/api/track` beacon.
3. **Build step:** Minimal esbuild — ESM out, no framework. Enables
   code-splitting (lazy-load story / trading / deck-builder / puzzle /
   daily) + minification. (Not yet implemented — queued.)
4. **Guest merge:** Existing `users` schema is the merge target. On
   signup-from-guest, the client's localStorage state migrates into a
   new user row via `/me/migrate-guest`.

## Phase 1 — First 90 seconds (in flight)

✅ Shipped this session:
- Auto-tuned first match (forces Easy + balanced AI, skips mulligan,
  shows welcome hint).
- Juiced first-win moment (rainbow banner + 80-piece confetti).
- VS pre-match cinematic.
- i18n shell (`i18n/en.json` + `client/js/i18n.js`).
- Vercel Analytics + custom-event beacon (`/api/track`).
- OG + Twitter card meta on every shared URL.
- Hand auto-lowers when no card is affordable.
- Touch-friendly tap-to-peek for hand cards on mobile.
- Sticky damage previews on every enemy slot when an attacker is
  selected (touch-friendly).

🟡 Still to do for Phase 1:
- **esbuild pipeline** — code-split, lazy-load on demand, target ≤200KB
  critical JS. Smallest of the remaining items.
- **Portrait-playable arena** — drop the "rotate your phone" prompt;
  stack field rows vertically.
- **Anonymous play** — localStorage state model + `/me/migrate-guest`
  endpoint. Lets visitors play their first match without a passkey.

Exit criteria:
- ≥70% of new visitors reach first turn within 30s
- ≥50% win their first match within 90s of landing
- Critical JS path ≤200KB gzipped
- Portrait mobile arena renders full match loop without horizontal
  scroll or "rotate your phone" prompt

## Phase 2 — Shareability (K-factor engine)

✅ Daily Boss + Daily Puzzle shipped this session. Both have
Wordle-style share strings and leaderboards.

🟡 Still to do:
- **Highlight-card image generation** (1080×1350 PNG at end of every
  match — final board, MVP card, badges, auto-caption pulled from a
  200+ line pool).
- **Replay capture** (sub-3 MB GIF/MP4 of last 3-5 turns).
- **Deck codes** (`/d/<code>` opens a shared deck, `/v/<code>` runs
  Friend Battle against it).
- **TikTok 9:16 export** for the replay.

Exit: K-factor ≥ 0.3.

## Phase 3 — Retention hooks

- **PWA + offline.** Service worker caches shell + last deck.
- **Web push (opt-in).** "Today's boss is live", "Your friend beat
  your deck."
- **Daily streak with one weekly freeze.**
- **Battle-pass-style 30-day seasons (free).** Themed cosmetic unlocks.
- **Async PvP.** Snapshot every signed-in user's last 3 decks nightly;
  serve them as headless AI when no live player is queued.
- **Comeback mechanic.** Below 25% trainer HP, your next card play
  costs −1 energy.
- **Match-length governor.** Escalating fatigue past turn 12,
  shrinking max-field-size past turn 18. Target 2.5–4 min average.

Exit: D1 ≥ 40%, D7 ≥ 18%.

## Phase 4 — Memeability + mini-games

✅ Tier system + earned badges + rival taunts already in.

🟡 Coming:
- **Voice/copy pass.** Win/loss/crit/KO strings rewritten with
  attitude. 200+ critical-hit one-liner pool.
- **Reaction faces.** 4-6 animated frames per creature triggered by
  game events.
- **Cosmetics:** card backs / sleeves / board themes / victory
  animations.
- **Glitch moments.** 1% chance screen briefly inverts on perfect
  victory; rainbow lighting on 3-crit chains.
- **Card mastery tracker.** Each creature gains mastery XP as you
  KO with it; level 3 = +1 ATK + unique victory line.
- **Mini-games (approved):**
  - **Crit-timing micro-game** — sweet-spot tap bar on Special
    attacks. Pure client, ~1 day of work.
  - **Booster-pack opening** — tear/scratch/flip card-reveal
    animation replacing the reward modal.

## Phase 5 — Growth mechanics

- **Referrals.** Both inviter and invitee earn a cosmetic on the
  invitee's first win.
- **Creator mode.** Custom cards within safe templates; community
  vote weekly; top card rotates into live game for 7 days.
- **Weekly tournaments.** 64-player single-elim brackets with
  shareable bracket images.
- **TikTok creator pipeline.** API for content creators to grab
  pre-formatted match replays.

Exit: K-factor ≥ 0.6.

## Phase 7+ — Long tail

- **Multi-card trades** (deferred since trading shipped 1-for-1).
  Schema swap to `offered_card_ids int[]` + `wanted_card_ids int[]`
  with same atomic-swap pattern. Slot into a later wave.
- **Random match modifiers** (Fog, High Tide, Reverse, etc.).
- **Endless mode** + **Draft mode** for match variety.
- **Match-3 between matches** (deferred — weakest TCG tie-in).
- **Localized rosters per region** once growth markets warrant.

## Cross-cutting non-negotiables

- **Accessibility per phase.** Keyboard nav + screen-reader labels +
  reduced-motion respected on every new surface.
- **i18n.** All new copy lands in `i18n/en.json`. Migration of legacy
  hardcoded strings is incremental, file-by-file.
- **Feature flags.** New modes launch behind a flag so we can A/B
  test or kill duds without revert PRs.
- **No dark patterns.** No fake scarcity, forced ads, predatory
  monetization. The game wins on being fun.
