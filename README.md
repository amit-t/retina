# retina
Self-hostable image understanding API. Bring your own LLM keys or Bedrock endpoint. The sensing layer for your app — image-to-text API you run inside your own VPC. Drop-in API service for image understanding — fork, deploy, ship.

## Local e2e Redis (without testcontainers)

`pnpm test:e2e` defaults to `@testcontainers/redis`, which spins up an
ephemeral Redis per run. For faster iteration during local development you
can instead launch a long-lived Redis via Docker Compose and point the e2e
suite at it via `REDIS_URL`:

```bash
# Start redis:7-alpine on localhost:6379 with a healthcheck
docker-compose -f docker-compose.test.yml up -d

# Run e2e against the compose-managed Redis
REDIS_URL=redis://localhost:6379/0 pnpm test:e2e

# Tear down when done
docker-compose -f docker-compose.test.yml down
```

The compose file declares a single `redis:7-alpine` service on port 6379
with a `redis-cli ping` healthcheck so `docker compose up --wait` blocks
until Redis is ready to accept connections.
