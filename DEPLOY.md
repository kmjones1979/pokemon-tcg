# Deploying Pokémon TCG

This game is a long-lived Node + Socket.IO process with in-memory match state.
Pick a host that gives you a persistent process — pure-serverless platforms
will drop ongoing matches when they cold-start or scale.

## What you need before deploying

1. A **Supabase** project with both schema files applied:
   ```bash
   psql "$SUPABASE_POSTGRES_URL" -f scripts/schema.sql
   psql "$SUPABASE_POSTGRES_URL" -f scripts/schema-accounts.sql
   ```
2. The Pokédex seeded:
   ```bash
   node scripts/seed-pokedex.js
   ```
3. These environment variables in the deployment target:
   | name | required | what it is |
   |---|---|---|
   | `SUPABASE_URL` | ✅ | Project URL (`https://<ref>.supabase.co`) |
   | `SUPABASE_SERVICE_KEY` | ✅ | service_role JWT (server-only — never ship to browser) |
   | `SESSION_SECRET` | ✅ | 32+ random bytes hex; signs session cookies |
   | `RP_ID` | ✅ | Your domain hostname (e.g. `pokemon.example.com`) — **must match the URL users visit**, otherwise passkeys reject |
   | `ORIGIN` | ✅ | Full origin including scheme (e.g. `https://pokemon.example.com`) |
   | `RP_NAME` | optional | Friendly label shown in the OS passkey UI; defaults to `Pokémon TCG` |
   | `NODE_ENV` | optional | Set to `production` to silence the QR-code/LAN-IP banner |
   | `PORT` | optional | Honoured automatically; defaults to 3000 |

> **Passkey requirement:** `RP_ID` MUST be your final HTTPS domain. Chrome and
> Safari reject `localhost` and bare-IP RP IDs except in dev. Once deployed,
> users who registered against `localhost` will need to re-register against
> the real domain.

---

## Option A — Fly.io (recommended for this game)

A single small VM is the cleanest fit. Free allowance covers low traffic.

```bash
# from the repo root
fly launch --no-deploy
# choose: app name, region close to your players, NO database, NO redis
fly secrets set \
  SUPABASE_URL="https://<ref>.supabase.co" \
  SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
  SESSION_SECRET="$(node -e 'console.log(require(\"crypto\").randomBytes(32).toString(\"hex\"))')" \
  RP_ID="pokemon.example.com" \
  ORIGIN="https://pokemon.example.com"
fly deploy
fly certs add pokemon.example.com  # optional, for a custom domain
```

The `Dockerfile` in this repo handles the rest. Fly will keep one VM running;
clients reconnect through the 60s grace window if the VM restarts.

---

## Option B — Vercel (Fluid Compute)

Works for small audiences. Single-instance only; ongoing matches will drop on
deploy / cold-start. If you outgrow it, move shared state to Redis (see "scaling"
below).

```bash
yarn global add vercel
vercel link             # link the repo to a Vercel project
vercel env add SUPABASE_URL production
vercel env add SUPABASE_SERVICE_KEY production
vercel env add SESSION_SECRET production
vercel env add RP_ID production            # your apex domain, e.g. pokemon.example.com
vercel env add ORIGIN production           # https://pokemon.example.com
vercel deploy --prod
```

`vercel.ts` at the repo root configures the project: it deploys `server.js`
as a long-running Node function (Fluid Compute) and rewrites every request
through it. The static client modules under `client/` are cached at the edge.

> **Known limits — confirmed during this project's deploy:**
> - Solo play, passkey auth, collection viewer, deck builder, and rewards
>   all work fine. They're stateless HTTP.
> - **Multiplayer matchmaking does not work on Vercel without Redis.**
>   Vercel runs Fluid Compute as multiple per-region instances under
>   load — each instance has its own in-memory `rooms`/`queue` Map.
>   Two players who hit different instances will never be paired.
> - To make multiplayer work on Vercel: provision **Upstash Redis** from
>   the Marketplace, install `@socket.io/redis-adapter`, and move the
>   three Maps in `server-modules/multiplayer.js` into Redis keyspaces.
> - Easier alternative: deploy the same `server.js` to Fly.io with the
>   included `Dockerfile`. Single VM, one instance, multiplayer just works.
>   Use Vercel for the HTTP routes if you prefer; point the client's
>   Socket.IO connection to the Fly host explicitly.

---

## Option C — Any Docker host (Render, Railway, your own VPS)

The `Dockerfile` builds a self-contained image. Render and Railway will pick
it up automatically. For a VPS:

```bash
docker build -t pokemon-tcg .
docker run -d --name pokemon-tcg \
  -p 80:3000 \
  --env-file .env.production \
  --restart unless-stopped \
  pokemon-tcg
```

The slop-computer `pm2 start server.js` pattern also works on a plain Node
VPS — `node 24+` is the only host requirement.

---

## Scaling beyond one instance

When you want to run multiple instances behind a load balancer:

1. Add **Upstash Redis** from the Vercel Marketplace (free tier) or another
   managed Redis. The Marketplace gives you a `KV_REST_API_URL` /
   `KV_REST_API_TOKEN` pair auto-provisioned per env.
2. Install the Socket.IO Redis adapter:
   ```
   yarn add @socket.io/redis-adapter ioredis
   ```
3. In `server.js`, swap the in-memory `io` for the adapter (see the
   socket.io docs for the small wiring change).
4. Move `multiplayer.js`'s `rooms` / `queue` / `privateRooms` Maps into
   Redis. Each room key TTLs after match end + reconnect grace.

This is straightforward but not free of bugs — leave it for after you've
proven there's enough traffic to need it.

---

## Smoke-testing a deployment

After deploy, run these against your live URL to catch the common breakages:

```bash
# 1. Pokédex loaded?
curl https://YOUR_HOST/api/pokedex/size
# expect: {"size":1025}

# 2. Auth probe responds?
curl https://YOUR_HOST/auth/me
# expect: {"user":null}

# 3. End-to-end passkey flow (locally against the deployed URL):
node scripts/passkey-smoke.js https://YOUR_HOST
# expect: ✅ passkey smoke test passed
```

> The smoke scripts require the URL's hostname to match `RP_ID`. They won't
> work pointed at `https://*.vercel.app` preview URLs unless you also set
> `RP_ID` to that exact preview hostname.
