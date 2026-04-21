# Retina — Image Understanding API Service

**Date:** 2026-04-21
**Status:** Draft — design approved, pending spec review
**Owner:** amit-t

## Goal

A self-hostable HTTP API service that performs image understanding — description, OCR, and structured extraction — backed by pluggable vision LLM providers through `ai-sdk`. Users deploy it as a container behind their own load balancer in their own VPC, pass their own provider credentials, and call a small set of REST endpoints. Drop-in: fork or pull the image, configure env vars, run.

## Non-goals

- Auth/authn/authz inside the service. The caller's ALB/API gateway handles that.
- Rate limiting inside the service. Upstream handles it.
- Multi-tenant billing, usage metering beyond the per-response `usage` echo.
- Image preprocessing pipelines beyond size validation and format normalization.
- Bounding-box OCR. The OCR endpoint returns full text; `blocks[].bbox` is reserved as `null` in MVP to keep the response shape stable for a future upgrade.
- A user-facing UI. This is an API only.

## Decisions

These were locked during brainstorming and drive the design below.

| # | Decision | Value |
|---|---|---|
| Q1 | Extraction surface | Freeform description + structured extraction + OCR |
| Q2 | Request pattern | Sync + async job queue |
| Q3 | Async job store | Redis |
| Q4 | Auth | None (ALB fronts) |
| Q5 | Providers | All `ai-sdk` vision providers: Bedrock, OpenAI, Anthropic, Google |
| Q6 | Image input | URL + base64 + multipart, default cap 10 MB, configurable |
| Q7 | Extraction schema source | Client-supplied ad-hoc + server-registered templates |
| Q8 | Rate limiting | None (upstream handles) |
| Q9 | Observability (MVP) | pino JSON logs to stdout; OpenTelemetry traces deferred to phase 2 |
| Q10 | Packaging (MVP) | Dockerfile + published GHCR image. Helm + Terraform phase 2 |
| Q11 | Testing | Unit (mocks) + replay (fixtures) + live (gated real calls) + e2e (HTTP+Redis) |
| Q12 | Config | Env vars only |
| Q13 | Templates (MVP) | Filesystem directory; admin API phase 2 |
| Q14 | Endpoint shape | Split per capability + unified `/v1/analyze` convenience |
| Q15 | Provider failure handling | Configurable: fail-fast default, opt-in retries + fallback chain |
| Q16 | Stack | Node (prod) + Hono + Zod, Bun for dev, pnpm, strict TS, Biome |
| Q17 | Async result lifecycle | Poll + webhook callback + SSE stream |
| — | Redis placement | External to container, reached via `REDIS_URL` |

## Architecture

A single Node process runs a Hono HTTP server and an in-process async worker loop, both sharing a Redis client. The container is stateless. All persistent state (jobs, results, pub/sub for SSE) lives in external Redis. Templates load from the filesystem at boot.

```
┌──────────────── retina container ────────────────┐
│                                                  │
│  HTTP (Hono)  ──►  Handlers  ──►  ProviderRouter │──► Bedrock / OpenAI / Anthropic / Google
│       │                │                         │     (via ai-sdk)
│       │                ▼                         │
│       │          JobStore  ◄── Worker loop       │
│       │           (Redis)                        │
│       ▼                │                         │
│    SSE hub  ◄── Redis pub/sub                    │
└──────────────────────────────────────────────────┘
             │
             ▼
        external Redis
```

Scaling: run more containers behind the same ALB. No shared in-process state across containers beyond Redis.

## Repository layout

```
retina/
├── src/
│   ├── index.ts              # bootstrap: load config, build app, start worker + server
│   ├── config.ts             # env parsing + Zod schema
│   ├── app.ts                # Hono app composition
│   ├── http/
│   │   ├── routes/
│   │   │   ├── describe.ts
│   │   │   ├── ocr.ts
│   │   │   ├── extract.ts
│   │   │   ├── analyze.ts    # unified endpoint
│   │   │   ├── jobs.ts       # POST/GET/SSE
│   │   │   ├── templates.ts  # GET list/detail (read-only in MVP)
│   │   │   └── health.ts
│   │   ├── middleware/
│   │   │   ├── request-id.ts
│   │   │   ├── error.ts
│   │   │   └── size-limit.ts
│   │   └── schemas.ts        # shared Zod request/response schemas
│   ├── core/
│   │   ├── image.ts          # URL/base64/multipart normalizer → bytes + mime
│   │   ├── provider-router.ts
│   │   ├── providers/
│   │   │   ├── index.ts      # factory keyed by PROVIDERS env
│   │   │   ├── bedrock.ts
│   │   │   ├── openai.ts
│   │   │   ├── anthropic.ts
│   │   │   └── google.ts
│   │   ├── tasks/
│   │   │   ├── describe.ts
│   │   │   ├── ocr.ts
│   │   │   └── extract.ts
│   │   └── templates.ts      # fs loader, schema validation via Zod
│   ├── jobs/
│   │   ├── store.ts          # Redis: enqueue, claim, update, result TTL
│   │   ├── worker.ts         # polling loop, retries, publish events
│   │   └── sse.ts            # subscribe by jobId, fan events to clients
│   └── logger.ts             # pino
├── test/
│   ├── unit/                 # mocked provider boundary
│   ├── replay/               # undici MockAgent + recorded fixtures
│   ├── e2e/                  # Hono + real Redis via testcontainers
│   └── live/                 # real provider, gated by INTEGRATION=1
├── Dockerfile
├── docker-compose.test.yml   # Redis for CI e2e
├── .github/workflows/ci.yml  # lint, typecheck, unit/replay/e2e, build, publish image
├── .github/workflows/live.yml# on-demand + nightly real-provider run
├── biome.json
├── tsconfig.json             # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
├── package.json              # pnpm, Node prod, Bun dev scripts
└── README.md
```

## Configuration

All configuration is via environment variables. Config is parsed via Zod at boot; invalid config aborts startup with a typed error.

| Var | Required | Default | Notes |
|---|---|---|---|
| `PORT` | no | `8080` | |
| `LOG_LEVEL` | no | `info` | `trace` / `debug` / `info` / `warn` / `error` |
| `REDIS_URL` | **yes** | — | `redis://host:6379/0` |
| `MAX_IMAGE_BYTES` | no | `10485760` | 10 MB |
| `PROVIDERS` | **yes** | — | comma list: `bedrock,openai,anthropic,google` |
| `DEFAULT_PROVIDER` | **yes** | — | must be in `PROVIDERS` |
| `DEFAULT_MODEL` | no | per-provider default | e.g. `anthropic.claude-sonnet-4` |
| `FALLBACK_CHAIN` | no | — | ordered list of providers |
| `RETRY_ATTEMPTS` | no | `0` | per-provider retries; `0` = fail-fast |
| `RETRY_BACKOFF_MS` | no | `250` | base for exponential backoff |
| `AWS_REGION` | if bedrock | — | IAM role preferred in prod |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | optional | — | fallback to default AWS chain |
| `OPENAI_API_KEY` | if openai | — | |
| `ANTHROPIC_API_KEY` | if anthropic | — | |
| `GOOGLE_GENERATIVE_AI_API_KEY` | if google | — | |
| `TEMPLATES_DIR` | no | `/app/templates` | filesystem path with `*.json` |
| `JOB_RESULT_TTL_SECONDS` | no | `3600` | Redis TTL for completed job records |
| `JOB_MAX_ATTEMPTS` | no | `3` | worker-level retries |
| `WORKER_CONCURRENCY` | no | `2` | in-process concurrent worker count |
| `REQUEST_TIMEOUT_MS` | no | `60000` | sync request deadline |
| `SSE_HEARTBEAT_MS` | no | `15000` | SSE keepalive interval |

## API contracts

All requests and responses are JSON unless the request uses `multipart/form-data` for image upload. Responses always carry `x-request-id`, echoed from the request if provided, generated otherwise.

### Shared types

```ts
type ImageInput =
  | { url: string }
  | { base64: string; mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }
  // OR multipart/form-data with an `image` file field

type ProviderOptions = {
  provider?: string
  model?: string
  fallback?: string[]
  retries?: number
}
```

### `POST /v1/describe`

Request: `{ image: ImageInput, prompt?: string, maxTokens?: number } & ProviderOptions`
Response:
```json
{
  "description": "string",
  "provider": "bedrock",
  "model": "anthropic.claude-sonnet-4",
  "usage": { "inputTokens": 1234, "outputTokens": 87 }
}
```

### `POST /v1/ocr`

Request: `{ image: ImageInput, languages?: string[] } & ProviderOptions`
Response:
```json
{
  "text": "full OCR text",
  "blocks": [{ "text": "...", "bbox": null }],
  "provider": "...",
  "model": "...",
  "usage": {}
}
```

`blocks[].bbox` is always `null` in MVP. The field is reserved for a future upgrade that returns geometric layout when supported.

### `POST /v1/extract`

Request, one of:
- `{ image: ImageInput, schema: JsonSchema } & ProviderOptions` — ad-hoc schema
- `{ image: ImageInput, templateId: string } & ProviderOptions` — server-registered template

Response:
```json
{
  "data": { },
  "templateId": "invoice-v1",
  "provider": "...",
  "model": "...",
  "usage": {}
}
```
`templateId` is `null` when an ad-hoc `schema` is used.

### `POST /v1/analyze`

Unified convenience endpoint.
Request: `{ image: ImageInput, task: "describe" | "ocr" | "extract", ...taskSpecific } & ProviderOptions`
Response: `{ task, result }` where `result` matches the dedicated endpoint response for that task.

### `POST /v1/jobs`

Enqueue an async job. Request: `{ task, ...taskSpecific, callbackUrl?: string } & ProviderOptions`.
Response (HTTP 202):
```json
{ "jobId": "uuid", "status": "queued" }
```

### `GET /v1/jobs/:id`

```json
{
  "jobId": "uuid",
  "status": "queued" | "running" | "completed" | "failed",
  "attempts": 1,
  "createdAt": "ISO-8601",
  "completedAt": "ISO-8601 | null",
  "result": { },
  "error": { "code": "...", "message": "..." }
}
```

### `GET /v1/jobs/:id/stream`

Server-Sent Events. Sends current state immediately on connect, then one event per state transition.

Event types: `status`, `progress`, `completed`, `failed`. The stream closes on a terminal event or client disconnect. Heartbeat comments every `SSE_HEARTBEAT_MS`.

### `GET /v1/templates`

`[{ id, version, description }]`

### `GET /v1/templates/:id`

`{ id, version, schema, description }`

### `GET /healthz`

```json
{
  "ok": true,
  "redis": "up" | "down",
  "providers": { "bedrock": "configured", "openai": "configured" }
}
```

### Error envelope

All non-2xx responses use:
```json
{
  "error": {
    "code": "provider_failed",
    "message": "human-readable",
    "requestId": "...",
    "details": {}
  }
}
```

`details.attempts` is populated when a fallback chain was tried: `[{ provider, model, code, message }]`.

## Data flow

### Sync request

1. `request-id` middleware attaches/echoes `x-request-id`.
2. `size-limit` middleware rejects `Content-Length > MAX_IMAGE_BYTES` before buffering.
3. Route handler Zod-validates the body.
4. `core/image.ts` normalizes to `{ bytes, mime }`:
   - URL: `fetch` with 10 s `AbortController`, streaming cap at `MAX_IMAGE_BYTES`, verifies `Content-Type`.
   - base64: decode, sniff mime, verify declared mime matches.
   - multipart: stream the `image` field, cap at `MAX_IMAGE_BYTES`.
5. `tasks/<task>.ts` builds a provider-agnostic call (prompt + optional Zod/JsonSchema).
6. `ProviderRouter.call(opts)`:
   - resolve provider (request override → `DEFAULT_PROVIDER`)
   - attempt; on failure, retry up to `RETRY_ATTEMPTS` with exponential backoff
   - on exhaustion, try next provider in `fallback`/`FALLBACK_CHAIN`
   - return `{ output, usage, provider, model }`
7. Handler shapes the response.
8. Error middleware catches `RetinaError` subclasses and emits the error envelope.

Client disconnect: the controller's `AbortSignal` is forwarded into the `ai-sdk` call, cancelling the provider request.

### Async job

1. `POST /v1/jobs` validates and normalizes the image identically to the sync path.
2. `JobStore.enqueue(job)`:
   - `SET retina:job:<id>` → `{status: "queued", payload, attempts: 0, createdAt}`
   - `LPUSH retina:queue <id>`
3. Response `202 { jobId }`.

4. Worker loop (`WORKER_CONCURRENCY` coroutines):
   - `BRPOPLPUSH retina:queue retina:processing` — blocking claim with work-in-progress list.
   - Load job state. `JobStore.update(id, { status: "running", attempts: attempts+1 })`. Publish `status:running` to `retina:job:<id>`.
   - Run the same task code path as sync.
   - On success: store `result` with `JOB_RESULT_TTL_SECONDS` TTL; set `status=completed`, `completedAt`; publish `completed`; if `callbackUrl` set, POST the result (fire-and-forget, 3 retries, 5 s timeout).
   - On failure: if `attempts < JOB_MAX_ATTEMPTS`, requeue with exponential backoff. Else set `status=failed`, attach `error`, publish `failed`.
   - `LREM retina:processing 1 <id>` on terminal state.

5. `GET /v1/jobs/:id` reads state from Redis.

6. `GET /v1/jobs/:id/stream`:
   - Write SSE headers.
   - Send current state as the first event.
   - `SUBSCRIBE retina:job:<id>`; forward messages as SSE events.
   - Heartbeat every `SSE_HEARTBEAT_MS`.
   - Close on terminal event or client disconnect.

## Error handling

All errors flow through a single error middleware that maps typed errors → HTTP status + stable `error.code`.

```ts
class RetinaError extends Error {
  code: string
  status: number
  cause?: unknown
  details?: Record<string, unknown>
}
```

| Class | Status | Code | When |
|---|---|---|---|
| `ValidationError` | 400 | `invalid_request` | Zod parse failure |
| `ImageTooLargeError` | 413 | `image_too_large` | body exceeds `MAX_IMAGE_BYTES` |
| `UnsupportedMediaTypeError` | 415 | `unsupported_media_type` | mime not image/* |
| `ImageFetchError` | 400 | `image_fetch_failed` | URL fetch 4xx / timeout |
| `TemplateNotFoundError` | 404 | `template_not_found` | unknown `templateId` |
| `JobNotFoundError` | 404 | `job_not_found` | unknown jobId |
| `ProviderFailedError` | 502 | `provider_failed` | all providers + retries exhausted |
| `ProviderTimeoutError` | 504 | `provider_timeout` | `REQUEST_TIMEOUT_MS` hit |
| `ProviderRateLimitError` | 429 | `provider_rate_limited` | provider upstream rate limit; `Retry-After` when provider supplies it |
| `RedisUnavailableError` | 503 | `redis_unavailable` | Redis connection broken on async path |
| `InternalError` | 500 | `internal_error` | unexpected; logged with stack |

`ProviderFailedError.details.attempts = [{ provider, model, code, message }]` so the caller sees why each link in the fallback chain failed.

Sync requests are wrapped in `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`. Async jobs are not time-capped per-job — the worker stays on one job until the provider returns or errors.

## Testing strategy

### Layers

- **unit/** — pure modules in isolation. Mock `ai-sdk` at the boundary. Covers prompt construction, template loading and Zod validation, error mapping, config parsing, image normalizer paths (URL / base64 / multipart, size limit, mime sniffing).
- **replay/** — fixture-based integration. `undici` `MockAgent` replays recorded provider HTTP responses from `test/replay/fixtures/<provider>/<case>.json`. Fixtures are regenerated on demand by a gated script that hits real providers (requires creds).
- **e2e/** — boot full app in `vitest` setup: Hono on a random port, Redis via `@testcontainers/redis`. Exercise `/v1/describe`, full `/v1/jobs` lifecycle, SSE subscribe, callback POST (captured by an in-test fake HTTP server). Provider layer stubbed via `MockAgent`. Asserts wiring: middleware order, Redis keys and TTLs, worker claim/release semantics, SSE event ordering, heartbeat cadence.
- **live/** — same shape as e2e but `MockAgent` disabled; real Bedrock/OpenAI/Anthropic/Google calls. Gated by `INTEGRATION=1` + credentials. Run via `workflow_dispatch` and nightly on `main`; excluded from PR gate.

### Tooling

- **Vitest** — Node + Bun compatible runner.
- **undici MockAgent** — HTTP interception for provider calls.
- **@testcontainers/redis** — Redis for e2e.
- Coverage via v8 provider; CI fails below 80 % on `src/**` excluding `src/index.ts`.

### CI

`.github/workflows/ci.yml` on every PR:

1. `pnpm biome ci` (lint + format)
2. `pnpm tsc --noEmit` (strict typecheck)
3. `pnpm test:unit`
4. `pnpm test:replay`
5. `pnpm test:e2e` (Redis as service)
6. `pnpm build` (production bundle)
7. On tag `v*`: build image, push to GHCR.

`.github/workflows/live.yml` runs `workflow_dispatch` and nightly on `main`.

## Phase 2

Not in scope for MVP, called out to avoid re-litigation:

- OpenTelemetry traces + Prometheus metrics (`/metrics`)
- Helm chart
- Terraform module for ECS/Fargate + ALB reference deployment
- Runtime template admin API (`POST/PUT/DELETE /v1/templates`) backed by Redis
- Per-key rate limiting / global provider-budget cap
- Bounding-box OCR when a provider supplies reliable coords
- Worker/server split via `RETINA_MODE=serve|worker|both`

## Open questions for implementation planning

- Which Hono multipart parser to use — `hono/multipart` is streaming but limited; `@hono/node-server` raw stream access may be needed for hard size cap enforcement on multipart uploads.
- Preferred Redis client: `ioredis` (feature-complete, battle-tested) vs `node-redis` (official, slimmer). Both support pub/sub + BRPOPLPUSH.
- Default model IDs per provider — needs a current pass against each provider's vision-capable SKUs at implementation time.
