# Long-lived process container — single small VM is the cleanest fit for
# this game's Socket.IO + in-memory match state pattern. Used by Fly.io,
# Render, Railway, Hetzner, or any "run this image" PaaS.

FROM node:24-alpine
WORKDIR /app

# Copy lockfile + package.json first so dependency layers cache well.
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production

# Bring in the rest of the source.
COPY . .

# Vercel-style port detection: respect $PORT if the host sets it.
ENV PORT=3000
EXPOSE 3000

# Run the server directly. The slop-computer pattern uses pm2 in production
# for restart-on-crash, but `node` is fine on hosts that auto-restart the
# container (Fly's `restart_policy = "always"`, Render's default behavior).
CMD ["node", "server.js"]
