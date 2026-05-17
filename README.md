# Pokémon TCG

A vanilla-JS 1v1 Pokémon card game. Vanilla JS modules in the browser, plain
Node on the server, no build step. Backed by Supabase for the 1,025-Pokémon
Pokédex and persistent user accounts. Deploys to Vercel (HTTP routes) with a
Dockerfile included for any persistent-process host (Fly.io / Render / VPS).

## Live

https://pokemon-tcg-five-lime.vercel.app

## Features

- Solo vs AI on Easy / Medium / Hard
- 6 trainers (Brock, Misty, Pikachu Fan, Erika, Sabrina, Lance) with
  passive abilities
- Every Pokémon has a free Basic attack plus a type-flavored Special
  (Fire → Inferno + Burn, Electric → Volt Shock + Paralyze, etc.)
- 18-type effectiveness chart (Gen 6+)
- Passkey accounts (WebAuthn), Supabase-backed
- Collection viewer + multi-deck builder
- Per-match reward drops (pick 1-of-3 winner / 1-of-2 loser)
- Achievements with toast notifications
- Match history, global leaderboard
- Multiplayer matchmaking + private 6-character room codes (with QR
  deep-link auto-join). Multiplayer needs a persistent-process host;
  see `DEPLOY.md`.

## Local development

```bash
yarn install
cp .env.example .env       # fill in your Supabase + SESSION_SECRET
node scripts/seed-pokedex.js
yarn start                 # node server.js — listens on :3000
```

Open `http://localhost:3000` (passkeys reject IP-based hosts).

## Tests

```bash
yarn test
```

62 node:test unit tests cover the type chart, damage formula, ability
system, sessions, deck-builder boundaries, and game flow. Headless
Playwright smoke scripts under `scripts/*-smoke.js` exercise the full
register → play → reward loop end-to-end.

## Deploy

See `DEPLOY.md`. TL;DR — `vercel deploy --prod` for HTTP routes, separate
persistent host (Fly.io with the included Dockerfile) for the Socket.IO
multiplayer server.

## License

PolyForm Noncommercial 1.0.0 — see `LICENSE`. Free for personal, hobby,
research, and noncommercial use. Commercial use is not permitted under
this license.
