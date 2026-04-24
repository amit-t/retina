# retina

Self-hostable HTTP API for image understanding — **describe**, **OCR**, and
**structured extraction** — backed by pluggable vision LLM providers (Bedrock,
OpenAI, Anthropic, Google) through [`ai-sdk`](https://sdk.vercel.ai/).

Drop-in: fork or pull the image, configure env vars, run. Bring your own LLM
keys. The sensing layer for your app — image-to-text API you run inside your
own VPC.

- **Spec of record:** [docs/superpowers/specs/2026-04-21-retina-image-api-design.md](docs/superpowers/specs/2026-04-21-retina-image-api-design.md)
- **License:** MIT

## Quickstart

A new operator should be up and running in four steps.

### 1. Start Redis

Retina keeps all durable state (jobs, results, SSE pub/sub) in external Redis.
It is **not** bundled in the container image.

```bash
docker run -d --name retina-redis -p 6379:6379 redis:7-alpine
```

### 2. Run retina

Minimal single-provider boot against OpenAI:

```bash
docker run --rm -p 8080:8080 \
  -e REDIS_URL=redis://host.docker.internal:6379/0 \
  -e PROVIDERS=openai \
  -e DEFAULT_PROVIDER=openai \
  -e OPENAI_API_KEY=sk-... \
  ghcr.io/amit-t/retina:latest
```

### 3. Verify the service

```bash
curl -s http://localhost:8080/healthz | jq
# { "ok": true, "redis": "up", "providers": { "openai": "configured" } }
```

### 4. Send your first request

```bash
curl -s http://localhost:8080/v1/describe \
  -H 'content-type: application/json' \
  -d '{
    "image": { "url": "https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png" },
    "prompt": "Describe the scene in one sentence."
  }' | jq
```

You should receive `{ description, provider, model, usage }`.

## Environment variables

Parsed via Zod at boot — any invalid value aborts startup with a typed error.
See `src/config.ts`.

### Required

| Var | Example | Notes |
|---|---|---|
| `REDIS_URL` | `redis://host:6379/0` | External Redis URL. |
| `PROVIDERS` | `openai,anthropic` | Comma list from `bedrock,openai,anthropic,google`. |
| `DEFAULT_PROVIDER` | `openai` | Must be in `PROVIDERS`. |

### Required per provider

| Var | When | Example |
|---|---|---|
| `OPENAI_API_KEY` | `openai` ∈ `PROVIDERS` | `sk-...` |
| `ANTHROPIC_API_KEY` | `anthropic` ∈ `PROVIDERS` | `sk-ant-...` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | `google` ∈ `PROVIDERS` | `AIza...` |
| `AWS_REGION` | `bedrock` ∈ `PROVIDERS` | `us-east-1` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | optional if `bedrock` ∈ `PROVIDERS` | Falls back to default AWS credential chain (IAM role preferred in prod). |

### Optional

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | HTTP listener port. |
| `LOG_LEVEL` | `info` | `trace` / `debug` / `info` / `warn` / `error`. |
| `MAX_IMAGE_BYTES` | `10485760` | 10 MB cap on request body image. |
| `DEFAULT_MODEL` | per-provider | e.g. `anthropic.claude-sonnet-4`. |
| `FALLBACK_CHAIN` | — | Ordered provider list tried after the primary fails. |
| `RETRY_ATTEMPTS` | `0` | Per-provider retries. `0` = fail-fast. |
| `RETRY_BACKOFF_MS` | `250` | Base for exponential backoff. |
| `TEMPLATES_DIR` | `/app/templates` | Filesystem path with `*.json` extraction templates. |
| `JOB_RESULT_TTL_SECONDS` | `3600` | Redis TTL for completed job records. |
| `JOB_MAX_ATTEMPTS` | `3` | Worker-level retries across a job. |
| `WORKER_CONCURRENCY` | `2` | In-process concurrent workers. |
| `REQUEST_TIMEOUT_MS` | `60000` | Sync request deadline. Async jobs are not time-capped. |
| `SSE_HEARTBEAT_MS` | `15000` | SSE keepalive interval. |

Request-level `ProviderOptions` (`provider`, `model`, `fallback`, `retries`)
on a request body **replace** the env-level defaults for that request — they
do not merge.

## API

Full contracts live in the [spec](docs/superpowers/specs/2026-04-21-retina-image-api-design.md#api-contracts).
This section shows the shapes you will reach for day-one.

All responses include `x-request-id`, echoed from the request if supplied,
generated otherwise. Non-2xx responses share the envelope
`{ error: { code, message, requestId, details? } }`.

### `POST /v1/describe` — freeform description

URL input:

```bash
curl -s http://localhost:8080/v1/describe \
  -H 'content-type: application/json' \
  -d '{
    "image": { "url": "https://example.com/cat.jpg" },
    "prompt": "One sentence.",
    "maxTokens": 128
  }'
```

Base64 input:

```bash
B64=$(base64 < ./cat.png | tr -d '\n')
curl -s http://localhost:8080/v1/describe \
  -H 'content-type: application/json' \
  -d "{
    \"image\": { \"base64\": \"${B64}\", \"mime\": \"image/png\" },
    \"prompt\": \"One sentence.\"
  }"
```

Response:

```json
{
  "description": "A tabby cat perched on a windowsill.",
  "provider": "openai",
  "model": "gpt-4o",
  "usage": { "inputTokens": 1234, "outputTokens": 87 }
}
```

### `POST /v1/ocr` — full-text OCR

```bash
curl -s http://localhost:8080/v1/ocr \
  -H 'content-type: application/json' \
  -d '{ "image": { "url": "https://example.com/receipt.jpg" }, "languages": ["en"] }'
```

### `POST /v1/extract` — structured extraction

Ad-hoc JsonSchema or server-registered `templateId` (never both):

```bash
curl -s http://localhost:8080/v1/extract \
  -H 'content-type: application/json' \
  -d '{ "image": { "url": "https://example.com/invoice.pdf" }, "templateId": "invoice-v1" }'
```

### `POST /v1/analyze` — unified convenience endpoint

```bash
curl -s http://localhost:8080/v1/analyze \
  -H 'content-type: application/json' \
  -d '{ "image": { "url": "https://example.com/x.png" }, "task": "describe" }'
```

### `POST /v1/jobs` — enqueue async job

```bash
curl -s http://localhost:8080/v1/jobs \
  -H 'content-type: application/json' \
  -d '{
    "task": "describe",
    "image": { "url": "https://example.com/cat.jpg" },
    "callbackUrl": "https://my-service/hooks/retina"
  }'
# 202 { "jobId": "…", "status": "queued" }
```

### `GET /v1/jobs/:id` — poll job state

```bash
curl -s http://localhost:8080/v1/jobs/<jobId>
```

Returns `{ jobId, status, attempts, createdAt, completedAt, result, error }`.

### `GET /v1/jobs/:id/stream` — Server-Sent Events

```bash
curl -N http://localhost:8080/v1/jobs/<jobId>/stream
```

The stream sends current state immediately, then one event per state
transition. Event types: `status`, `completed`, `failed`. Heartbeat comments
every `SSE_HEARTBEAT_MS`. Closes on a terminal event or client disconnect.

### `GET /v1/templates`, `GET /v1/templates/:id`

Lists and fetches extraction templates loaded from `TEMPLATES_DIR`.

### `GET /healthz`

```json
{ "ok": true, "redis": "up", "providers": { "openai": "configured" } }
```

## Phase 2 roadmap

The MVP intentionally excludes the following. They are tracked as deferred
and will not be picked up by the autonomous ralph loop until explicitly
promoted. See the Phase 2 block in
[`.ralph/fix_plan.md`](.ralph/fix_plan.md#phase-2-deferred-do-not-pick-up):

- OpenTelemetry traces + Prometheus `/metrics`
- Helm chart for Kubernetes deployments
- Terraform module for ECS/Fargate + ALB reference deployment
- Runtime template admin API (`POST/PUT/DELETE /v1/templates`) backed by Redis
- Per-key rate limiting / global provider-budget cap
- Worker/server split via `RETINA_MODE=serve|worker|both`
- Bounding-box OCR (populate `blocks[].bbox`) once a provider supplies reliable coords
- SSE `progress` event type once a provider can emit intermediate progress

## Contributing

Retina is developed via [**ralph**](https://github.com/amit-t/ralph) — an
autonomous loop that picks one atomic task per iteration from
[`.ralph/fix_plan.md`](.ralph/fix_plan.md) and ships it end-to-end.

Human contributors follow the same workflow:

1. Pick a top-level unchecked task from `.ralph/fix_plan.md` (`R01..R28`).
   Tasks carry stable IDs — never renumber. Honor the `Depends on:` chain.
2. Read [`.ralph/constitution.md`](.ralph/constitution.md) before making
   structural changes. Its 11 architecture invariants are load-bearing.
3. Implement the task in a branch scoped to that single task.
4. Run the full gate **before committing** (see
   [`.ralph/AGENT.md`](.ralph/AGENT.md)):

   ```bash
   pnpm biome ci
   pnpm typecheck
   pnpm test:unit
   pnpm test:replay   # once R19 lands
   pnpm test:e2e      # once R20 lands
   ```

5. Move the task's checkbox into the `## Completed` section of
   `.ralph/fix_plan.md` (preserving its `**Rxx**` ID) in the same commit.
6. Commit with a message referencing both the R-ID and the spec section,
   e.g. `feat(R08): POST /v1/describe — spec §API contracts`.

Protected paths — never modified outside a dedicated governance task:

- `.ralph/` (entire directory)
- `.ralphrc`

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
