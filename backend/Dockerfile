# syntax=docker/dockerfile:1

###############################################################################
# Stage 1 — dependencies
###############################################################################
FROM node:24-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
# `npm ci` when a lockfile is present (reproducible), `npm install` otherwise so
# a fresh clone that has not installed yet still builds.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

###############################################################################
# Stage 2 — build
###############################################################################
FROM node:24-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma client must be generated before tsc runs — the build imports its types.
#
# `prisma generate` does not contact the database, but prisma.config.ts resolves
# DATABASE_URL eagerly and aborts if it is unset. A build-scoped placeholder
# satisfies that without baking a real connection string into any layer: this
# value exists only in this stage, is never copied into the runtime image, and
# the actual URL arrives from the environment at boot. Keeping the config strict
# (rather than defaulting it) means `prisma migrate` still fails with "missing
# DATABASE_URL" instead of a confusing connection error.
RUN DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" \
    npx prisma generate
RUN npm run build

# Drop dev dependencies from the tree we are about to copy forward.
RUN npm prune --omit=dev

###############################################################################
# Stage 3 — runtime
###############################################################################
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Needed by the compose healthcheck and by `wait-for` style entrypoints.
RUN apk add --no-cache curl

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma ./prisma

# Run unprivileged. `node` (uid 1000) ships with the base image.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

CMD ["node", "dist/main.js"]
