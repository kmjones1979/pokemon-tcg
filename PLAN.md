# pokemonbattle.xyz — Plan to 1 M Users

**Confirmed design constraint:** the game stays a trading card game. The
existing 1v1 engine, signature system, items, deck builder, and boss
phases are the foundation — every phase below preserves the TCG core
loop and only adds layers.

**North Star (every phase exits against these):**
- D1 retention ≥ 40 %
- K-factor ≥ 0.6
- Time-to-first-win ≤ 90 s

**Velocity contract:** each phase ≤ 2 weeks. Each phase ends with a
deploy + measured exit. Anything that doesn't move D1, K, or time-to-
first-win gets cut from the phase and deferred.

---

## Phase 0 — Foundations (this work, in flight)

- `AUDIT.md` ✓
- `PLAN.md` ✓ (this file)
- Approval gate.

---

## Phase 1 — The first 90 seconds + IP rebrand groundwork

**Why first.** Three of the seven biggest risks from the audit (IP,
sign-in wall, time-to-first-win) all converge here. Until first-win is
under 90 s, no shareability work matters because the funnel doesn't
reach it. And anything we ship past Phase 1 with real Pokémon assets is
work we'd have to redo after the rebrand.

**Scope (TCG-preserving):**

1. **Asset/string indirection layer.** Replace every direct sprite URL,
   creature name, and type icon with a lookup through a new
   `client/js/registry.js`. Two implementations behind one
   `THEME=pokemon|original` env flag — Pokémon stays default in dev,
   `original` ships to prod. Engine unchanged. Tests unchanged. Same
   damage math, same signatures (keyed by slug instead of dex id).
2. **Original creature roster (TCG-sized).** 16 starters split 4-per-
   type across an original 4-type chart (e.g. Embr / Tidal / Verdant /
   Volt), each with the same Basic + Special pattern. Placeholder art
   in a single committed style (one of: cursed-cute, paper-craft,
   vaporwave — I'll propose 3 mood boards with `ImagePreview` if you
   want before commit). Cost: ~16 hours of placeholder generation.
   Roster expands across later phases.
3. **Anonymous play.** Land → first match in one tap. localStorage-
   first state; passkey upgrade becomes optional after the first win.
   Migrate the existing achievement / collection / rewards stack to
   support guest profiles with merge-on-upgrade.
4. **Portrait-playable arena.** Stack the field rows vertically: rival
   top, your hand fan at the bottom, fields in the middle. Hand-lift
   toggle (already shipped) stays. Landscape can be an "enhanced" mode
   later; portrait is the source-of-truth layout.
5. **Auto-tuned first match.** Detect "first-ever match" via local
   state; the AI plays a slightly weaker policy (Easy-but-no-skip-
   attacks) and starts with a fixed beatable opening. Target win rate
   ~85 % within 6–9 turns for fresh accounts.
6. **Juiced first-win moment.** Screen shake, particle burst, fanfare,
   over-the-top victory screen, "share your win" CTA visible
   immediately. Re-use the existing badge + counter system.
7. **Performance budget.** Code-split: deck-builder, story, trading,
   daily-boss, achievements panel, leaderboard, mp lazy-loaded on
   demand. Inline critical CSS for the menu + arena chrome. Target
   critical JS ≤ 200 KB. Use a minimal esbuild step — still ESM-out,
   no framework adoption.
8. **Analytics from day one.** Wire PostHog (or self-host Plausible
   on the same Vercel project). Funnel events: `land → tap_play →
   first_turn → first_win → second_match → return_d1 → return_d7`.
   Plus per-feature events (share clicked, daily attempted, trade
   created). Feature-flag toggle to disable in dev.
9. **i18n shell.** All NEW copy lands in `i18n/en.json` from this
   phase forward. Existing copy migrates in batches as files get
   touched (no big-bang refactor).
10. **Open Graph + Twitter card meta tags.** Make the URL look pro
    on every paste — `og:image` is a static hero card for now,
    upgraded to per-result in Phase 2.

**Exit criteria (measured via analytics):**
- ≥ 70 % of new visitors reach their first turn within 30 s
- ≥ 50 % win their first match within 90 s of landing
- Critical JS path ≤ 200 KB gzipped
- Portrait mobile arena renders the full match loop without horizontal
  scroll or the "rotate your phone" prompt
- A single env flag swaps every creature asset/string to original IP

---

## Phase 2 — Shareability (the K-factor engine)

**Why second.** Phase 1 fixes the floor. Phase 2 turns every match into
a share artifact. No retention layer matters if there are zero shares.

1. **Wordle-style daily-boss launch.** Server endpoints + share string
   already deployed (gated). Enable the home-screen card. Localize the
   share text. Push the daily as the *primary* landing surface for
   visitors who've already played once.
2. **Highlight-card image generation.** Client-side canvas/HTMLToImage
   pipeline that produces a 1080×1350 PNG at end of every match:
   final board state, MVP card, badges, final HP bars, auto-caption
   pulled from a 200+ line pool. One-tap copy to clipboard / native
   share / X-Reddit-WhatsApp-Telegram intent links.
3. **Replay capture (sub-3 MB GIF/MP4).** Record the last 3–5 turns
   into an OffscreenCanvas → `mediabunny`-encoded MP4 (modern
   browsers) with a GIF fallback. Download + share.
4. **Deck codes.** Compress a 30-card deck into a short base62 string
   over 6–8 chars (10-bit ids × 30 fits in ~25 chars; with type-tier
   bucketing we can do better). Routes `/d/<code>` open the deck in
   the builder. Routes `/v/<code>` start a Friend Battle against that
   deck.
5. **OG per-result.** Server-rendered OG image for `/?d=<dayNumber>`
   and `/v/<code>` so iMessage/Discord previews show the boss/deck.
6. **TikTok-shaped replay export.** 9:16 portrait MP4 with the
   highlight card as a header overlay + auto-captions baked in.
7. **Friend challenge result loop.** When a friend plays your deck
   code, you get a notification (in-page now, push later in Phase 3).
   Result page shows you the head-to-head.

**Exit criteria:**
- ≥ 15 % of completed matches generate a share artifact (highlight or
  daily share string copied / shared)
- K-factor ≥ 0.3 (half the North Star — full target by Phase 5)
- Daily-boss DAU ≥ 30 % of weekly active users

---

## Phase 3 — Retention hooks

1. **PWA + offline.** Service worker caches the shell + last-played
   deck. Installable. Solo matches work without network. Massive
   D7 boost on mobile.
2. **Web push (opt-in).** "Your friend beat your deck", "Today's
   boss is live", "Your streak is about to break". Never aggressive.
3. **Daily streak with one weekly freeze.** Already partly built;
   add the forgiveness mechanic + streak counter visible on every
   screen.
4. **Battle-pass-style 30-day seasons (free).** Themed cosmetic
   unlocks per season. No paywall until Phase 7+ (intentional).
5. **Async PvP.** Snapshot every signed-in user's last 3 decks
   nightly; serve them as headless AI opponents in matchmaking when
   no live player is queued. Feels like PvP at 50 concurrent or
   50,000.
6. **Comeback mechanic.** Below 25 % trainer HP, your next card
   played costs −1 energy (floor 0). Tunable.
7. **Match-length governor.** Escalating fatigue past turn 12;
   shrinking max-field-size past turn 18. Targets 2–4 minute average.

**Exit criteria:**
- D1 retention ≥ 40 % (North Star)
- D7 retention ≥ 18 %
- Average match length 2.5–4 min

---

## Phase 4 — Memeability

1. **Voice/copy pass.** Win/loss/crit/KO/turn-start strings rewritten
   with attitude. 200+ critical-hit one-liner pool. Localized into
   en + 2 of {es, pt-br, ja, ko, de} based on Phase 1 analytics.
2. **Reaction faces.** 4–6 animated reaction faces per creature for
   key events (smug, devastated, copium, etc.). Frozen-frame
   exports are the meme payload.
3. **Cosmetic cards: backs, sleeves, board themes, victory anims.**
   Unlocked via streak / boss clears / daily completion. Some
   serious, some absurd (Comic Sans "W" card back).
4. **Glitch moments.** 1 % chance the screen briefly inverts on a
   perfect victory. Rainbow lighting on a 3-crit chain. Subtle
   spawn variations that people screenshot and quote.
5. **Card mastery tracker.** Each creature gains "mastery XP" as you
   KO with it; at level 3 it gets a permanent +1 ATK and a unique
   victory line. Long-tail engagement hook.

**Exit criteria:**
- Highlight-card share images include reactions ≥ 40 % of the time
- Cosmetic unlock rate ≥ 25 % of D7-returning users

---

## Phase 5 — Growth mechanics

1. **Referral with mutual reward.** Both inviter and invitee earn a
   cosmetic on the invitee's first win. Tracked via the same short-
   code system as deck codes.
2. **Creator mode.** Custom cards within safe templates (constrained
   HP/ATK + signature pool). Community vote weekly; top card rotates
   into the live game for 7 days.
3. **Weekly tournaments.** 64-player single-elim brackets with
   shareable bracket images. Auto-generated rounds. Optional Discord
   integration.
4. **TikTok creator partnership pipeline.** API for content creators
   to grab pre-formatted match replays.

**Exit criteria:**
- K-factor ≥ 0.6 (North Star)
- Creator-mode cards from ≥ 100 unique authors / week
- Tournament participation ≥ 2 % of WAU

---

## Phase 6 — Scale + monetization (only after K ≥ 0.6 sustained)

- Cosmetic-only monetization (cosmetics, season passes). No card
  power for sale.
- CDN-served creature assets (currently inlined PNGs).
- Database read replicas if Supabase read load > 30 % of plan.
- Anti-cheat hardening (server-authoritative ranked, rate limits,
  bot detection).

---

## Phase 7+ — Long tail

- Multi-card trades (open question from the trade flow — answered
  here: yes, defer to this phase). Schema swap to `offered_card_ids
  int[]` + `wanted_card_ids int[]` with same atomic-swap pattern.
- Card-image generation for individual creatures (shareable
  "this is my favorite mon" cards).
- Localized rosters per region.
- Esports support (replays, brackets, observer mode).

---

## Cross-cutting non-negotiables (every phase)

- **No real Pokémon assets after Phase 1.** Hard gate at the deploy
  stage — CI check that fails the build if `THEME=pokemon` reaches
  prod after the rebrand ships.
- **Accessibility.** Each phase adds keyboard nav + screen-reader
  labels for the surfaces it touches. Reduced-motion respected on
  every new animation. Colorblind palette tested.
- **i18n.** All new copy lands in `i18n/en.json`. Localization unblocks
  once Phase 1 ships the shell.
- **Feature flags.** Every new mode launches behind a flag so we can
  A/B test or kill duds without revert PRs.
- **No dark patterns.** No fake scarcity timers, no forced ads, no
  predatory monetization.

---

## What I need from you to start Phase 1

1. **Approval of the rebrand approach + creature style choice.** I'll
   propose 3 visual-mood-board sketches via `ImagePreview` once
   approved.
2. **Analytics provider preference.** PostHog (hosted), Plausible
   (self-hostable), or Vercel Analytics (built-in)?
3. **Approval to add a minimal esbuild step** (still ESM, still
   no-framework, just enables code-splitting + minification).
4. **Confirmation to keep the existing supabase schema as the
   guest-merge target** (i.e., when a guest signs up post-first-win,
   we migrate their localStorage state into their new user row).

Once those four are answered I start Phase 1 in small commits, each
independently shippable.
