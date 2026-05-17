# pokemonbattle.xyz — Audit

End-to-end read of the codebase, sized against the 1M-user goal and the
North Star metrics (D1 retention ≥ 40%, K-factor ≥ 0.6, time-to-first-win
≤ 90 s).

## 1. Architecture snapshot

| Layer            | Tech                                       | Lines     |
| ---------------- | ------------------------------------------ | --------- |
| Client           | Vanilla JS ES modules, no build step       | ~12 k JS  |
| Styling          | Hand-written CSS, no framework             | ~4.7 k CSS|
| Server           | Express 5, Node 22                         | ~3.6 k    |
| Data             | Supabase (Postgres + Auth) — pooled        | —         |
| State (MP)       | Redis (`state-store.js`) + HTTP polling    | —         |
| Realtime         | Socket.IO present, used only for dev reload + the legacy multiplayer module (HTTP polling is the prod path) | — |
| Deploy           | Vercel Fluid Compute; Dockerfile available for persistent hosts | — |
| Tests            | `node --test`, 90 unit/integration cases   | —         |

**Total shipped to first paint:** index.html + 332 KB JS + 136 KB CSS +
Google Fonts + the QR generator UMD. No code-splitting, no service worker,
no compression beyond Vercel defaults. Asset budget per the brief is 1.5 MB
— we're under that today, but every new module ships eagerly.

## 2. What works well

### Game engine
- `client/js/game.js` is the single source of truth for rules. 90 passing
  unit tests cover the type chart, damage formula, ability/signature
  hooks, boss phases, and edge cases.
- The signature system (`client/js/passives.js`) is data-driven: 47 unique
  signatures keyed by national-dex id, each declaring optional `onSummon`,
  `onTurnStart`, `onKO`, `onKill`, `onPreHit`, `passive`, or `fieldAura`
  hooks. New signatures are pure data, no engine changes needed.
- Items, trainer abilities, status effects, mulligan, fatigue ticks,
  field auras, combo bonuses, theme-of-the-week, and crit chains are all
  composable inputs to one `computeDamage` function in `battle.js`.
- Story chapters (`shared/story-chapters.js`) reuse the 1v1 engine
  unchanged — proves the architecture is composable.

### Server-authoritative state
- All multiplayer flows route through `server-modules/multiplayer-http.js`
  with Redis-backed state, so any Vercel Lambda instance can serve any
  request without sticky sessions. Survived the earlier Socket.IO
  fragmentation pain.
- Atomic accept-and-swap on trades via `UPDATE … WHERE status='open'`.
- Anti-cheat sessions on solo/champion/story/daily ends (server tracks
  start, requires 30s min duration, rate-limits per user).

### Visual polish
- VS cinematic, rival personality taunts, holo legendary shimmer (transform-
  based for mobile perf), animated game-over counters, earned badges
  (PERFECT VICTORY etc.), Guardian shield + DEFENDER tag, hand fan,
  drag-to-attack, type-tinted slot glow on selection.

### Supabase migration flow
- `supabase/migrations/` checked in; `supabase/config.toml` committed; CLI
  link via `SUPABASE_ACCESS_TOKEN` env var. `supabase db push` applies
  changes to prod in one command. Two migrations land Wave 20–26 schema.

### Tests
- 90 passing assertions including AOE signatures, tank cards, boss phase
  rules, on-summon hooks, AI signature weighting, type-chart edge cases.

## 3. What's broken / fragile

### IP exposure — the existential risk
- Every Pokémon name, sprite URL (PokeAPI/Showdown CDNs), and cry audio
  is from Nintendo / The Pokémon Company. Trainer portraits, type
  effectiveness chart, the word "Pokémon" itself.
- A hobby-scale project rarely draws action below ~10 k DAU. We will
  exceed that on any successful viral spike. The C&D will arrive long
  before 1 M users — and once issued, the brand is unusable forever.
- Current architecture has no abstraction layer for assets/strings — they
  are inlined throughout `cards.js`, `main.js`, `arena.css`, and
  `story-chapters.js`.

### Time-to-first-win is far over 90s
Estimated path for a brand-new visitor right now:
1. Land on the page                                       ~2 s
2. Read landing copy / feature strip                      ~10 s
3. Decide to play → "Sign in" passkey prompt              ~15-30 s
4. Pick a trainer                                         ~10 s
5. Click "Battle as X"                                    instant
6. Wait for deck shuffle + VS cinematic                   ~3 s
7. Mulligan modal (decide which cards to swap)            ~15 s
8. Play through 8–15 turns of solo match                  3–7 min
9. Win                                                    🎉

**Total: 4–8 minutes**, with a sign-in gate, a mulligan that requires
context the player doesn't yet have, and a match that can drag if the AI
plays defensively.

### Mobile portrait is a churn screen
`<div class="landscape-prompt">Rotate your phone to landscape ⤺</div>`
shows on every portrait viewport. Per the brief, this is a "churn screen
— redesign so the core loop works in portrait." The arena assumes
horizontal field rows.

### No analytics
Zero instrumentation. PostHog / Plausible / GA / Vercel Analytics not
wired. We cannot measure:
- Land → tap-play conversion
- Drop-off at sign-in vs trainer pick vs mulligan
- First-match win rate
- D1/D7 retention
- Share-button click-through
- Which screens cause exits

**We cannot optimize what we can't see.** This must land in Phase 1.

### Sign-up wall blocks too many features
Story, trading, daily boss, rewards, quests, achievements, leaderboard,
match history — all require WebAuthn passkey login. Guests can play solo
vs AI only, and even that doesn't persist anything. Per the brief: "No
signup, no email, no tutorial wall. Land → tap → in a battle."

### Asset shipping
- 332 KB of JS in a single `main.js` import graph. Mobile first paint on
  4G needs <1.5 MB total and ideally <300 KB JS critical path.
- No code-splitting. The deck builder, story mode, trading, achievements
  all ship eagerly even when the player just wants one quick match.
- Google Fonts blocking. The "Press Start 2P" pixel font is used in lots
  of UI chrome — but it's network-fetched, not subset, no `font-display`
  override.
- No service worker, no PWA manifest. Not installable, no offline play.

### No i18n
All copy is hardcoded in English string literals. The brief calls out
ES / PT-BR / JA / KO / DE as priority growth markets. Adding i18n later
requires touching every UI file.

### Accessibility gaps
Five `aria-*` / `role=*` / `prefers-reduced-motion` references across the
entire codebase. The brief requires keyboard nav, screen-reader labels on
critical UI, colorblind-safe palette, reduced-motion respect.

### Shareability holes
- Daily Boss server endpoints + share string exist but the UI is gated.
- No highlight image generation (1080×1350 share card).
- No replay GIF/MP4 export.
- No deck codes for sharing builds.
- Spectate links exist but have no rich preview.
- No Open Graph / Twitter card meta tags on the landing page.

### Match length variance
Average match likely 4–6 minutes vs a 2–4 minute target. Mulligan + a
60s/turn timer can drag it out further. No escalating damage past turn
N, no shrinking board.

### Async PvP missing
Real-time matchmaking only. At low concurrency (zero other players in
the queue) the multiplayer mode is effectively dead. Async PvP (face
another player's AI-piloted deck) is the standard solution for "feels
like PvP, works at any concurrency."

### Single-file size hotspots
- `client/js/main.js` is 2,533 lines. Owns rendering, click handlers,
  state syncing for MP, mulligan, drag-to-attack, items, achievements
  toasts, MVP recap. Splitting will speed up future work + enable code-
  splitting for first paint.
- `client/css/arena.css` is 2,929 lines. Same story.

## 4. What's missing entirely

| Brief callout                          | Status   |
| -------------------------------------- | -------- |
| Mobile portrait core loop              | ❌       |
| Time-to-first-win ≤ 90 s               | ❌       |
| Anonymous play, optional sign-in       | ❌ (signup wall) |
| Auto-tuned first match                 | ❌       |
| Highlight cards (1080×1350)            | ❌       |
| Replay GIFs                            | ❌       |
| Wordle-style daily share               | ⚠ (server done, UI gated) |
| Shareable deck codes                   | ❌       |
| Open Graph / Twitter cards             | ❌       |
| Voice/copy attitude                    | ⚠ (some — rival taunts) |
| Reaction faces                         | ❌       |
| Quotable critical-hit one-liners       | ⚠ (1–2 lines today, want 200+) |
| Cosmetics: card backs / sleeves / themes | ❌     |
| Glitch-cool moments (1% inverts etc.)  | ❌       |
| Comeback mechanics                     | ❌       |
| Streak freeze (forgiveness)            | ❌       |
| Battle-pass seasons                    | ❌       |
| Async PvP                              | ❌       |
| Friend challenges                      | ⚠ (room codes, no result loop) |
| Web push                               | ❌       |
| PWA + offline                          | ❌       |
| Feature flags                          | ❌       |
| Analytics (funnel)                     | ❌       |
| Referrals                              | ❌       |
| Creator mode (custom cards)            | ❌       |
| TikTok-ready (9:16 replays)            | ❌       |
| Tournaments                            | ❌       |
| i18n (en.json + locales)               | ❌       |
| Keyboard + screen-reader + colorblind  | ❌       |

## 5. Biggest risks ranked

1. **IP — existential.** Any organic viral spike triggers it before 1 M
   users. Cost of inaction: brand becomes unusable; rebuilding from a
   dead URL is 10× harder than launching on the original.
2. **Mobile portrait churn screen.** Mobile is 60–70 % of TikTok-driven
   traffic. "Rotate your phone" loses the user instantly.
3. **No analytics.** Every Phase 1 decision will be a guess. The cost of
   not measuring compounds — wrong instincts get baked into the product.
4. **Sign-in wall.** Pre-account play loses the funnel between land and
   first-match.
5. **Time-to-first-win.** A 4-minute path versus a 90-second target.
6. **Shareability gap.** No artifact escapes the page after a match.
   K-factor near zero today.
7. **Asset budget creep.** No code-splitting means every new feature
   slows the first paint. 1.5 MB ceiling won't hold past Phase 2 if we
   keep shipping eagerly.

## 6. What's safe to keep

- The 1v1 game engine + 47 signatures + items + boss phases.
- The Supabase schema + auth + collection / decks / achievements / quests /
  trading / daily-boss tables. Migrations are CLI-managed now.
- The HTTP-polling multiplayer architecture.
- The arena visual language (slot glow, holo, drag-to-attack) — moves to
  portrait with layout-only changes, not engine work.

## 7. Open architectural questions for the plan

1. **Do we keep the no-build-step Vanilla JS ethos?** It's fast to ship
   but blocks code-splitting + minification. Recommend a minimal esbuild
   pass that emits ESM chunks — still no framework, still readable, but
   gets us under the 300 KB critical-path bar.
2. **Asset/string abstraction strategy.** Single registry vs i18n keys
   vs build-time substitution? Recommend i18n keys + asset map keyed by
   creature slug — same indirection serves both rebrand and locales.
3. **Anonymous vs accountful state model.** localStorage-first with
   optional cloud sync after first win? Simpler than gating features.
4. **Async PvP implementation.** Snapshot the user's last 3 decks, run
   them as headless AI for incoming "queue" requests? Avoids real-time
   match-making minimum-viable-concurrency.
