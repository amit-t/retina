# Ralph Agent Configuration

Project-specific build/test/run commands for the **retina** image understanding
API service. Keep this file in sync with `package.json` scripts as they land
via `R01`.

## Prerequisites

- Node 20+
- pnpm 9+ (`corepack enable && corepack prepare pnpm@latest --activate`)
- Docker + Docker Compose (for e2e Redis via testcontainers, or the
  `docker-compose.test.yml` fallback)

## Install

```bash
pnpm install --frozen-lockfile
```

## Build

```bash
# Strict typecheck (no emit)
pnpm typecheck

# Production build — emits dist/
pnpm build
```

## Lint + format

```bash
# CI-mode check (fails on any diff)
pnpm biome ci

# Auto-fix
pnpm lint
pnpm format
```

## Test

```bash
# Full suite (unit + replay + e2e); live is gated separately
pnpm test

# Individual layers
pnpm test:unit
pnpm test:replay
pnpm test:e2e

# Live integration (real providers; requires creds)
INTEGRATION=1 pnpm test:live
```

See `.ralph/constitution.md` §Testing ladder for what each layer covers.

## Run (local dev)

```bash
# Required env for a minimal local boot
export REDIS_URL=redis://localhost:6379/0
export PROVIDERS=openai
export DEFAULT_PROVIDER=openai
export OPENAI_API_KEY=sk-...

pnpm dev                           # tsx watch src/index.ts
```

## Run (production container)

```bash
docker build -t retina:local .
docker run --rm -p 8080:8080 \
  -e REDIS_URL=redis://host.docker.internal:6379/0 \
  -e PROVIDERS=openai,anthropic \
  -e DEFAULT_PROVIDER=openai \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  retina:local
```

## Local e2e Redis

```bash
# Start a Redis container for e2e without testcontainers
docker-compose -f docker-compose.test.yml up -d
REDIS_URL=redis://localhost:6379/0 pnpm test:e2e
docker-compose -f docker-compose.test.yml down
```

## Definition of done for a ralph loop

Before a task is marked complete, these MUST all pass (see
`.ralph/constitution.md` §Definition of done):

1. `pnpm biome ci`
2. `pnpm typecheck`
3. `pnpm test:unit`
4. `pnpm test:replay` (once R19 lands)
5. `pnpm test:e2e` (once R20 lands)

## Protected files (NEVER modify)

- `.ralph/` (entire directory)
- `.ralphrc`

Deleting or overwriting these breaks ralph and halts autonomous development.
