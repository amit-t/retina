# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# Stage 1 — builder: install all deps (incl. dev) and compile TS → dist/
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true

WORKDIR /app

# Enable pnpm via corepack (pinned by packageManager in package.json)
RUN corepack enable

# Copy manifests first for better layer caching
COPY package.json pnpm-lock.yaml ./

# Install full dependency graph (incl. dev) from the frozen lockfile
RUN pnpm install --frozen-lockfile

# Copy sources and build
COPY tsconfig.json ./
COPY src ./src

RUN pnpm build

# -----------------------------------------------------------------------------
# Stage 2 — runner: minimal image, prod-only deps, non-root, healthcheck
# -----------------------------------------------------------------------------
FROM node:20-alpine AS runner

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PORT=8080

WORKDIR /app

# curl is required for the HEALTHCHECK; corepack enables pnpm
RUN apk add --no-cache curl \
    && corepack enable

# Copy manifests + compiled output from the builder
COPY --chown=node:node package.json pnpm-lock.yaml ./
COPY --chown=node:node --from=builder /app/dist ./dist

# Install production dependencies only, deterministically
RUN pnpm install --prod --frozen-lockfile \
    && chown -R node:node /app

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "dist/index.js"]
