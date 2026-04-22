# Ralph Fix Plan

> Last planned: 2026-04-22T00:03:56Z
> Source: docs/superpowers/specs/2026-04-21-retina-image-api-design.md

Task IDs are stable — never renumber. Each top-level task is sized for a single
ralph loop (~10–15 min of autonomous work) and should leave the repo in a
working state (lint + typecheck + existing tests green).

## High Priority

- [ ] **R02** Hono app skeleton + RetinaError hierarchy + core middleware + /healthz stub + logger
  - [ ] Create `src/core/errors.ts` with `RetinaError` base (`code`, `status`, `cause`, `details`) plus all 10 subclasses from spec §Error handling (`ValidationError`, `ImageTooLargeError`, `UnsupportedMediaTypeError`, `ImageFetchError`, `TemplateNotFoundError`, `JobNotFoundError`, `ProviderFailedError`, `ProviderTimeoutError`, `ProviderRateLimitError`, `RedisUnavailableError`, `InternalError`)
  - [ ] Create `src/logger.ts` exporting a pino JSON logger writing to stdout, level from parameter (wired to config in R13)
  - [x] Create `src/http/middleware/request-id.ts` — attach/echo `x-request-id`, generate uuid v4 when absent, bind into Hono context
  - [ ] Create `src/http/middleware/size-limit.ts` — reject when `Content-Length > MAX_IMAGE_BYTES` with `ImageTooLargeError` before buffering
  - [ ] Create `src/http/middleware/error.ts` — catch `RetinaError` → envelope `{error: {code, message, requestId, details}}` with `status`; catch unknown → `InternalError` 500 with stack logged
  - [ ] Create `src/http/routes/health.ts` — `GET /healthz` returns `{ok: true, redis: "down", providers: {}}` (stub; R14 adds real redis probe)
  - [x] Create `src/app.ts` exporting `buildApp(deps)` that composes middleware in order (request-id → size-limit → routes → error) and mounts `/healthz`
  - [ ] Vitest unit tests: every error class carries correct `code` and `status`, each middleware behavior, healthz shape, envelope shape on thrown RetinaError subclasses
  - [ ] Acceptance: `pnpm test:unit` passes; thrown `ValidationError` yields 400 JSON envelope with `x-request-id` header echoed
  - [ ] Depends on: R01

- [ ] **R03** Config loader with Zod (src/config.ts)
  - [ ] Define a Zod schema covering every env var in spec §Configuration (PORT, LOG_LEVEL, REDIS_URL, MAX_IMAGE_BYTES, PROVIDERS, DEFAULT_PROVIDER, DEFAULT_MODEL, FALLBACK_CHAIN, RETRY_ATTEMPTS, RETRY_BACKOFF_MS, AWS_REGION, AWS_ACCESS_KEY_ID/SECRET, OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, TEMPLATES_DIR, JOB_RESULT_TTL_SECONDS, JOB_MAX_ATTEMPTS, WORKER_CONCURRENCY, REQUEST_TIMEOUT_MS, SSE_HEARTBEAT_MS)
  - [ ] Apply defaults per spec (e.g. PORT=8080, MAX_IMAGE_BYTES=10485760, RETRY_ATTEMPTS=0, WORKER_CONCURRENCY=2)
  - [ ] Refinements: `DEFAULT_PROVIDER ∈ PROVIDERS`; `FALLBACK_CHAIN ⊆ PROVIDERS`; provider-key gating (if `bedrock` in PROVIDERS → AWS_REGION required; if `openai` → OPENAI_API_KEY; if `anthropic` → ANTHROPIC_API_KEY; if `google` → GOOGLE_GENERATIVE_AI_API_KEY); `JOB_MAX_ATTEMPTS >= 1`
  - [ ] Export `type Config` and `loadConfig(env = process.env): Config` throwing `ValidationError` with field paths on failure
  - [ ] Vitest unit tests: valid minimal config, missing REDIS_URL, missing PROVIDERS, DEFAULT_PROVIDER not in PROVIDERS, FALLBACK_CHAIN contains unlisted provider, missing OPENAI_API_KEY when openai listed, defaults populated when optional vars absent
  - [ ] Acceptance: `pnpm test:unit` covers 7+ config scenarios
  - [ ] Depends on: R01, R02

- [ ] **R04** Shared Zod request/response schemas (src/http/schemas.ts)
  - [ ] Export `ImageInput` as a Zod discriminated union of `{url: string}` and `{base64: string, mime: "image/png"|"image/jpeg"|"image/webp"|"image/gif"}`
  - [ ] Export `ProviderOptions` (`provider?`, `model?`, `fallback?: string[]`, `retries?: number`)
  - [ ] Export request schemas: `DescribeRequest`, `OCRRequest`, `ExtractRequest` (XOR `schema` vs `templateId` via `.superRefine`), `AnalyzeRequest` (Zod discriminated union on `task`), `JobsRequest` (same as analyze + optional `callbackUrl`)
  - [ ] Export matching response TS types
  - [ ] Vitest unit tests: one valid + one invalid shape per request schema, and XOR verification for `ExtractRequest`
  - [ ] Acceptance: all schemas referenced by route task imports compile with `strict` TS
  - [ ] Depends on: R01

- [ ] **R05** Image normalizer (src/core/image.ts)
  - [ ] Export `normalize(input, opts): Promise<{bytes: Uint8Array, mime: string}>` accepting URL, base64, or already-parsed multipart `{bytes, mime}`
  - [ ] URL path: `undici` `fetch` wrapped in `AbortSignal.timeout(10_000)`, stream body and abort once byte count exceeds `opts.maxBytes`, verify response `Content-Type` starts with `image/`
  - [ ] Base64 path: decode to Buffer, sniff magic bytes (PNG/JPEG/WEBP/GIF), throw `UnsupportedMediaTypeError` if declared mime does not match sniffed mime
  - [ ] Multipart path: validate `bytes.byteLength <= opts.maxBytes`, pass mime through
  - [ ] Throws `ImageFetchError` (URL 4xx/5xx/timeout), `ImageTooLargeError` (size cap), `UnsupportedMediaTypeError` (mime mismatch or non-image)
  - [ ] Vitest unit tests (using `undici` MockAgent): URL happy path, URL timeout, URL content-type image/jpeg happy, URL content-type text/html rejected, URL streaming cap aborts early; base64 happy, base64 mime mismatch; multipart happy, multipart too large
  - [ ] Acceptance: `pnpm test:unit` covers 9+ cases for `normalize()`
  - [ ] Depends on: R02, R04

- [ ] **R06** ProviderRouter + provider factory + OpenAI provider (first end-to-end)
  - [ ] Define `Provider` interface in `src/core/providers/index.ts` with methods `describe`, `ocr`, `extract` taking `{bytes, mime, prompt?, schema?, languages?}` and returning `{output, usage: {inputTokens, outputTokens}, model}`
  - [ ] Export `createProvider(config, name: string): Provider` factory keyed by `PROVIDERS` values
  - [ ] Create `src/core/providers/openai.ts` implementing `Provider` using `@ai-sdk/openai` (reads OPENAI_API_KEY, sensible default model constant flagged `TODO(spec-open-q): verify default model at implementation time`)
  - [ ] Create `src/core/provider-router.ts` with class `ProviderRouter(config, factory)` exposing `call(task, input, opts): Promise<{output, usage, provider, model}>`
  - [ ] Resolve primary provider: `opts.provider ?? config.DEFAULT_PROVIDER`
  - [ ] Resolve retries: `opts.retries ?? config.RETRY_ATTEMPTS`; resolve fallback chain: `opts.fallback ?? config.FALLBACK_CHAIN ?? []` (request-level **replaces** env, does not merge)
  - [ ] Attempt primary with exponential backoff (base `RETRY_BACKOFF_MS`); on exhaustion, iterate fallback chain in order, each with its own retry budget; collect `{provider, model, code, message}` per attempt
  - [ ] On total failure throw `ProviderFailedError` with `details.attempts`; forward `AbortSignal` into each ai-sdk call
  - [ ] Vitest unit tests with mocked provider: happy path, retry-then-succeed, exhaust-retries-no-fallback, fallback-succeeds-on-second, fallback-exhaustion populates attempts, request-level `retries:0` replaces env `RETRY_ATTEMPTS=3`, AbortSignal propagation
  - [ ] Acceptance: 7+ router unit tests pass
  - [ ] Depends on: R02, R03

- [ ] **R07** Add Bedrock, Anthropic, Google providers
  - [ ] Create `src/core/providers/bedrock.ts` using `@ai-sdk/amazon-bedrock` (reads AWS_REGION; falls through to the default AWS credential chain so IAM roles work in prod; optional explicit access key)
  - [ ] Create `src/core/providers/anthropic.ts` using `@ai-sdk/anthropic` (reads ANTHROPIC_API_KEY)
  - [ ] Create `src/core/providers/google.ts` using `@ai-sdk/google` (reads GOOGLE_GENERATIVE_AI_API_KEY)
  - [ ] Register all three in the factory so `createProvider(config, name)` handles `bedrock|openai|anthropic|google`
  - [ ] Declare default model ID constants per provider (flag `TODO(spec-open-q): verify against current vision-capable SKUs at implementation time`)
  - [ ] Vitest unit tests: factory instantiates each provider with mocked env; missing required env throws `ValidationError` with field path
  - [ ] Acceptance: `createProvider(config, "bedrock" | "anthropic" | "google")` each return a Provider compatible with R06 interface
  - [ ] Depends on: R06

- [ ] **R08** Describe task + POST /v1/describe
  - [ ] Create `src/core/tasks/describe.ts` exposing `runDescribe(router, opts): Promise<DescribeResult>` that builds the provider call from `{bytes, mime, prompt?, maxTokens?}`
  - [ ] Create `src/http/routes/describe.ts` that Zod-validates body (R04), normalizes image (R05), calls router (R06), shapes response `{description, provider, model, usage}`
  - [ ] Wire route into `buildApp()` via a registrar function
  - [ ] Wrap the handler in `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` and map abort to `ProviderTimeoutError`
  - [ ] Vitest unit tests with mocked router: 200 happy path, 400 on malformed body, 413 on oversized image, 502 on `ProviderFailedError` with attempts in envelope
  - [ ] Acceptance: `POST /v1/describe` end-to-end unit test passes with mocked router + mocked undici (image URL fetch)
  - [ ] Depends on: R02, R04, R05, R06

- [ ] **R09** OCR task + POST /v1/ocr
  - [ ] Create `src/core/tasks/ocr.ts` exposing `runOcr(router, opts): Promise<OcrResult>` that prompts provider for full text with optional `languages: string[]` hint
  - [ ] Response shape `{text, blocks: [{text, bbox: null}], provider, model, usage}` — per spec `bbox` is always `null` in MVP
  - [ ] Create `src/http/routes/ocr.ts` wiring validation → normalize → router → response shape
  - [ ] Vitest unit tests: happy path with mocked provider, `languages` hint forwarded into provider prompt, empty-text response handled, 413 on oversize
  - [ ] Acceptance: blocks contract verified: `result.blocks.every(b => b.bbox === null)`
  - [ ] Depends on: R02, R04, R05, R06

- [ ] **R10** Template filesystem loader (src/core/templates.ts)
  - [ ] Export `loadTemplates(dir: string): TemplateRegistry` that reads `*.json` files from `TEMPLATES_DIR`
  - [ ] Each template file must match Zod schema `{id: string, version: string, description: string, schema: JsonSchema}` — malformed file aborts startup
  - [ ] Registry exposes `.get(id)` (throws `TemplateNotFoundError` on miss) and `.list()` (returns all templates)
  - [ ] Vitest unit tests using a temp dir: valid directory loads, invalid-JSON fails boot, schema-mismatch fails boot, unknown id throws, empty dir returns empty registry
  - [ ] Acceptance: `loadTemplates(path)` used at boot and by the extract route + templates routes
  - [ ] Depends on: R02, R03

- [ ] **R11** Extract task + POST /v1/extract (ad-hoc schema + template)
  - [ ] Create `src/core/tasks/extract.ts` exposing `runExtract(router, registry, opts)` that resolves JsonSchema from `opts.schema` OR `registry.get(opts.templateId).schema`, then calls provider in structured-output mode
  - [ ] Create `src/http/routes/extract.ts` Zod-validating XOR `schema` vs `templateId` (R04) and dispatching
  - [ ] Response: `{data, templateId: string | null, provider, model, usage}` (templateId populated when template path, null for ad-hoc)
  - [ ] Vitest unit tests: ad-hoc schema path, template path, unknown templateId → 404 `template_not_found`, neither schema nor templateId → 400 `invalid_request`, both set → 400
  - [ ] Acceptance: 5+ unit tests covering all extract branches
  - [ ] Depends on: R04, R05, R06, R10

- [ ] **R12** GET /v1/templates endpoints + POST /v1/analyze unified
  - [ ] Create `src/http/routes/templates.ts` mounting `GET /v1/templates` (returns `[{id, version, description}]`) and `GET /v1/templates/:id` (returns `{id, version, schema, description}` or 404)
  - [ ] Create `src/http/routes/analyze.ts` mounting `POST /v1/analyze` with Zod discriminated union on `task`, dispatching to `runDescribe`/`runOcr`/`runExtract`, response `{task, result}`
  - [ ] Wire both registrars into `buildApp()`
  - [ ] Vitest unit tests: templates list + detail + 404, analyze happy path for each task branch with mocked deps
  - [ ] Acceptance: 6+ unit tests covering templates and analyze routes
  - [ ] Depends on: R08, R09, R10, R11

- [ ] **R13** Bootstrap src/index.ts + @hono/node-server
  - [ ] `src/index.ts`: `loadConfig()` → `buildLogger(level)` → `createProvider` factory → `ProviderRouter` → `loadTemplates` → `buildApp({config, logger, router, templates})` → `serve({fetch: app.fetch, port: config.PORT})` via `@hono/node-server`
  - [ ] Startup banner logs a redacted config summary (redact AWS_*/OPENAI_API_KEY/ANTHROPIC_API_KEY/GOOGLE_*) at `info`
  - [ ] Config parse failure logs the Zod error and exits non-zero
  - [ ] `pnpm dev` runs via `tsx watch src/index.ts`; `pnpm build` emits `dist/` via `tsc`
  - [ ] Vitest integration-style test: build app with stub deps, call `app.fetch` for `/healthz`, assert 200 + JSON body
  - [ ] Acceptance: `PORT=8080 REDIS_URL=redis://localhost:6379/0 PROVIDERS=openai DEFAULT_PROVIDER=openai OPENAI_API_KEY=... pnpm dev` boots and `curl localhost:8080/healthz` returns 200
  - [ ] Depends on: R02, R03, R06

## Medium Priority

- [ ] **R14** Redis client + JobStore (src/jobs/store.ts)
  - [ ] Create `src/jobs/store.ts` with `JobStore(redis: IORedis)` wrapping the ioredis client
  - [ ] Keys per spec: `retina:job:<id>` (hash or JSON string), `retina:queue` (list), `retina:processing` (list), pub/sub channel `retina:job:<id>`
  - [ ] Methods: `enqueue(job)` (SET + LPUSH), `claim(blockSec)` (BRPOPLPUSH retina:queue retina:processing), `get(id)`, `update(id, patch)`, `complete(id, result, ttl)` (writes result + status + completedAt with `JOB_RESULT_TTL_SECONDS` TTL), `fail(id, error)`, `remove(id)` (LREM retina:processing), `publish(id, event)`, `subscribe(id, handler)` (uses a separate subscriber connection per ioredis best practice)
  - [ ] Update `/healthz` to report `redis: "up"|"down"` from `redis.status`
  - [ ] Vitest unit tests using `ioredis-mock` (or a testcontainer Redis): enqueue → claim → update → complete happy path; TTL applied; remove clears processing list; publish/subscribe delivers events
  - [ ] Acceptance: `pnpm test:unit` covers JobStore happy paths; healthz shows `redis: "up"` when client connected
  - [ ] Depends on: R02, R03

- [ ] **R15** Worker loop (src/jobs/worker.ts)
  - [ ] Create `src/jobs/worker.ts` exposing `startWorkers({config, store, router, tasks, logger})` that spawns `WORKER_CONCURRENCY` coroutines
  - [ ] Each coroutine loops: `claim()` (blocking BRPOPLPUSH), update `status: "running"` + bump `attempts`, publish `status:running`, dispatch to `tasks.describe|ocr|extract` based on job payload, on success `complete()` + publish `completed`, on failure either requeue with exponential backoff (if `attempts < JOB_MAX_ATTEMPTS`) or `fail()` + publish `failed`
  - [ ] Terminal state removes id from `retina:processing` via `LREM`
  - [ ] Return `{shutdown(): Promise<void>}` handle that stops claiming new jobs and waits for in-flight to drain
  - [ ] Vitest unit tests with mocked JobStore + mocked task runners: success, retry-then-succeed, exhaustion-fails, publish event ordering, LREM on terminal state, shutdown drains in-flight
  - [ ] Acceptance: 6+ worker unit tests pass; async `describe` job goes queued→running→completed with published events
  - [ ] Depends on: R06, R14 (reuses task modules from R08/R09/R11)

- [ ] **R16** Callback webhook dispatcher (src/jobs/callback.ts)
  - [ ] Create `src/jobs/callback.ts` exporting `postCallback(url, payload, {retries: 3, timeoutMs: 5000, backoffMs: 250})` doing fire-and-forget POST via `undici.fetch`
  - [ ] Each attempt uses `AbortSignal.timeout(timeoutMs)`; exponential backoff between retries; final giveup logs at `warn`
  - [ ] Invoked from R15 worker only on successful `complete` (per spec §Data flow Async step 4); callback failure does NOT mutate job state
  - [ ] Vitest unit tests (undici MockAgent): first-try success, retry-then-success on 500, timeout treated as failure, giveup after 3 retries
  - [ ] Acceptance: worker logs `callback_ok` on success and `callback_giveup` on exhaustion without failing the job
  - [ ] Depends on: R15

- [ ] **R17** Jobs enqueue + get endpoints (src/http/routes/jobs.ts)
  - [ ] Create `src/http/routes/jobs.ts` mounting `POST /v1/jobs` and `GET /v1/jobs/:id`
  - [ ] POST: validate body via R04 `JobsRequest` (same shape as sync + optional `callbackUrl: string`), normalize image (R05), JobStore.enqueue, respond HTTP 202 `{jobId, status: "queued"}`
  - [ ] GET: JobStore.get, return `{jobId, status, attempts, createdAt, completedAt, result, error}`; throw `JobNotFoundError` → 404 on miss
  - [ ] Wire registrar into `buildApp()`; index.ts passes JobStore into deps
  - [ ] Vitest unit tests: enqueue shape + Redis writes verified via mocked JobStore, GET returns each status, GET unknown id → 404
  - [ ] Acceptance: `POST /v1/jobs` returns 202 JSON `{jobId, status: "queued"}`; Redis list `retina:queue` length increases by 1
  - [ ] Depends on: R04, R05, R14

- [ ] **R18** SSE stream endpoint (src/jobs/sse.ts + jobs route)
  - [ ] Create `src/jobs/sse.ts` exposing `streamJob(jobId, store): ReadableStream<Uint8Array>` that writes SSE headers, sends current state as the first event, subscribes to `retina:job:<id>` and forwards messages as `data:` events, emits heartbeat comment `: ping\n\n` every `SSE_HEARTBEAT_MS`
  - [ ] Close stream on terminal event (`completed` or `failed`) or client disconnect (abort on `c.req.raw.signal`)
  - [ ] Mount `GET /v1/jobs/:id/stream` in `src/http/routes/jobs.ts` wiring Hono's streaming response helper
  - [ ] Event types (MVP): `status`, `completed`, `failed` (no `progress` — reserved for Phase 2)
  - [ ] Vitest unit tests with fake timers + mocked JobStore: first event is current state, forwarded events, terminal close, heartbeat cadence, subscriber cleanup on disconnect
  - [ ] Acceptance: `curl -N http://localhost:8080/v1/jobs/<id>/stream` receives current state immediately, then status/completed events, then closes
  - [ ] Depends on: R14, R17

- [ ] **R19** Replay test infrastructure + one describe fixture per provider
  - [ ] Create `test/replay/setup.ts` wiring `undici` MockAgent as the global dispatcher during replay tests
  - [ ] Record one fixture file per provider at `test/replay/fixtures/<provider>/describe-basic.json` (for bedrock, openai, anthropic, google) containing the captured HTTP exchange
  - [ ] Create `test/replay/describe.spec.ts` that exercises `POST /v1/describe` across all four providers via replay
  - [ ] Add `test/replay/record.ts` CLI (gated by `RECORD=1` + real creds) that regenerates fixtures by calling the real provider — documented in `test/replay/README.md`
  - [ ] Add a `pnpm test:replay` vitest project scoped to `test/replay/**`
  - [ ] Acceptance: `pnpm test:replay` passes and exercises all four providers against fixtures
  - [ ] Depends on: R08

- [ ] **R20** E2E test infrastructure + jobs lifecycle test
  - [ ] Create `test/e2e/setup.ts` as vitest globalSetup: start Hono via `@hono/node-server` on a random free port, start Redis via `@testcontainers/redis`, export base URL + REDIS_URL for tests
  - [ ] Create `test/e2e/jobs-lifecycle.spec.ts`: POST /v1/jobs (provider stubbed via undici MockAgent) → poll GET /v1/jobs/:id through queued→running→completed → open SSE in parallel and assert event sequence → stand up an in-test HTTP echo server and assert the callback POST arrives with the result → assert Redis TTL on the completed result key
  - [ ] Add a `pnpm test:e2e` vitest project scoped to `test/e2e/**`
  - [ ] Acceptance: `pnpm test:e2e` passes using a testcontainer Redis with the full async lifecycle exercised
  - [ ] Depends on: R13, R15, R16, R17, R18

- [ ] **R21** Live integration test scaffold (test/live/)
  - [ ] Create `test/live/setup.ts` mirroring e2e setup but WITHOUT MockAgent (real provider HTTP)
  - [ ] Create one smoke test per provider under `test/live/<provider>-describe.spec.ts` that sends a real describe request against a small public image
  - [ ] Each test uses `describe.skipIf(!process.env.INTEGRATION || !process.env.<PROVIDER_KEY>)` so missing creds skip rather than fail
  - [ ] Add a `pnpm test:live` vitest project scoped to `test/live/**`
  - [ ] Acceptance: `INTEGRATION=1 OPENAI_API_KEY=... pnpm test:live` exercises at least the OpenAI smoke test against the real API
  - [ ] Depends on: R08, R20

- [ ] **R22** Dockerfile (multi-stage Node 20 prod base, non-root)
  - [ ] Stage 1 `builder`: `node:20-alpine`, `corepack enable`, copy manifests, `pnpm install --frozen-lockfile`, copy sources, `pnpm build` (emits dist)
  - [ ] Stage 2 `runner`: `node:20-alpine`, copy `dist`, `package.json`, `pnpm-lock.yaml`, install prod deps with `pnpm install --prod --frozen-lockfile`, `USER node`, `EXPOSE 8080`, `HEALTHCHECK` curling `/healthz`, `CMD ["node", "dist/index.js"]`
  - [ ] Create `.dockerignore` excluding `node_modules/`, `test/`, `.git/`, `.ralph/`, `docs/`, `graphify-out/`, `.github/`, `coverage/`
  - [ ] Acceptance: `docker build -t retina:test .` succeeds; `docker run --rm -e REDIS_URL=... -e PROVIDERS=openai -e DEFAULT_PROVIDER=openai -e OPENAI_API_KEY=test retina:test` boots and `/healthz` responds
  - [ ] Depends on: R13

- [ ] **R23** docker-compose.test.yml for local e2e
  - [ ] Create `docker-compose.test.yml` declaring a `redis:7-alpine` service on 6379 with a healthcheck (`redis-cli ping`)
  - [ ] Add a README note showing `docker-compose -f docker-compose.test.yml up -d` + `REDIS_URL=redis://localhost:6379/0 pnpm test:e2e` as an alternative to testcontainers for local dev
  - [ ] Acceptance: `docker-compose -f docker-compose.test.yml up -d` launches healthy Redis; `pnpm test:e2e` can be pointed at it by setting `REDIS_URL`
  - [ ] Depends on: R22

## Low Priority

- [ ] **R24** CI pipeline `.github/workflows/ci.yml`
  - [ ] Trigger on `pull_request`, `push` to main, and tag `v*`
  - [ ] Jobs in order: `setup` (checkout + pnpm + cache) → `lint` (`pnpm biome ci`) → `typecheck` (`pnpm typecheck`) → `test:unit` → `test:replay` → `test:e2e` (with `services: redis: image: redis:7-alpine`) → `build`
  - [ ] On tag `v*`: build + push image to `ghcr.io/<owner>/retina:<tag>` and `:latest` using `docker/build-push-action`
  - [ ] Fail below 80 % coverage on `src/**` excluding `src/index.ts`
  - [ ] Acceptance: every PR runs the full matrix; pushing a `v0.0.1` tag publishes a GHCR image
  - [ ] Depends on: R20, R22

- [ ] **R25** Live CI pipeline `.github/workflows/live.yml`
  - [ ] Trigger on `workflow_dispatch` and `schedule: cron: "0 6 * * *"` (nightly)
  - [ ] Inject provider creds from GitHub Secrets: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, AWS role via OIDC
  - [ ] Run `INTEGRATION=1 pnpm test:live`
  - [ ] Jobs fail only when live tests fail (not on skip-due-to-missing-creds)
  - [ ] Acceptance: nightly run produces a green CI badge; manual `workflow_dispatch` runs on demand
  - [ ] Depends on: R21

- [ ] **R26** README quickstart
  - [ ] Replace current stub README with a Quickstart showing `docker run` command + required env vars, env var reference table (required vs optional), `curl` examples for `/v1/describe` (URL and base64), `/v1/jobs` + `/v1/jobs/:id/stream` SSE, `/healthz`, and a link to `docs/superpowers/specs/2026-04-21-retina-image-api-design.md`
  - [ ] Include a "Phase 2 roadmap" section pointing at `.ralph/fix_plan.md` Phase 2 section
  - [ ] Include contributing pointer (ralph workflow + tests before commit)
  - [ ] Acceptance: README opens with a 4-step quickstart that a new user can follow end-to-end
  - [ ] Depends on: R22

- [ ] **R27** Seeded example templates (/app/templates/)
  - [ ] Create `templates/invoice-v1.json` with `{id: "invoice-v1", version: "1.0.0", description, schema}` where schema is a realistic invoice JsonSchema: `{vendor, invoiceNumber, issueDate, lineItems: [{description, quantity, unitPrice, total}], subtotal, tax, total, currency}`
  - [ ] Create `templates/receipt-v1.json` with `{id: "receipt-v1", version: "1.0.0", description, schema}` covering `{merchant, timestamp, items: [{description, quantity, price}], total, paymentMethod}`
  - [ ] Create `templates/README.md` documenting template file shape + naming convention + how to add new ones
  - [ ] Acceptance: both templates pass `loadTemplates()` without error; `GET /v1/templates` returns both
  - [ ] Depends on: R10

- [ ] **R28** Graceful shutdown (src/index.ts + worker + redis)
  - [ ] Trap `SIGTERM` and `SIGINT` in `src/index.ts` — stop accepting new HTTP requests (`server.close()`), call `worker.shutdown()` to drain in-flight jobs, disconnect ioredis publisher + subscriber + main clients, `process.exit(0)` on clean drain
  - [ ] Add env `SHUTDOWN_TIMEOUT_MS` (default 30000) to config; force exit(1) if drain does not finish within the window
  - [ ] In-flight jobs: either finish and publish terminal event, or be requeued on timeout (so a replacement container picks them up)
  - [ ] Vitest integration-style test: start server, submit async job, send SIGTERM mid-run, assert clean exit code 0 and either `completed` event or job back in `retina:queue`
  - [ ] Acceptance: `docker stop` yields a clean exit code with no leaked jobs in `retina:processing`
  - [ ] Depends on: R13, R15

## Phase 2 (deferred, do not pick up)

These are called out here only as reference. Do NOT add ralph tasks for these
until the user explicitly promotes them.

- [ ] Observability: OpenTelemetry traces + Prometheus `/metrics`
- [ ] Helm chart for Kubernetes deployments
- [ ] Terraform module for ECS/Fargate + ALB reference deployment
- [ ] Runtime template admin API (`POST/PUT/DELETE /v1/templates`) backed by Redis
- [ ] Per-key rate limiting / global provider-budget cap
- [ ] Worker/server split via `RETINA_MODE=serve|worker|both`
- [ ] Bounding-box OCR: populate `blocks[].bbox` when a provider supplies reliable coords
- [ ] SSE `progress` event type once a provider can emit intermediate progress

## Completed

- [x] Project enabled for Ralph
- [x] **R01** Scaffold pnpm + strict TypeScript + Biome + Vitest + tsconfig
  - [x] Create `package.json` declaring `packageManager: pnpm`, Node >=20 engines, scripts `dev` (tsx watch), `build` (tsc emit to `dist`), `typecheck` (`tsc --noEmit`), `lint` (`biome check .`), `format` (`biome format --write .`), `test`, `test:unit`, `test:replay`, `test:e2e`, `test:live`
  - [x] Declare runtime deps: `hono`, `@hono/node-server`, `zod`, `pino`, `ai`, `@ai-sdk/openai`, `@ai-sdk/amazon-bedrock`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `ioredis`, `undici`
  - [x] Declare dev deps: `typescript`, `@types/node`, `tsx`, `vitest`, `@vitest/coverage-v8`, `@biomejs/biome`, `ioredis-mock`, `@testcontainers/redis`
  - [x] Create `tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`, `outDir: dist`, `rootDir: src`
  - [x] Create `biome.json` (2-space indent, single quotes, trailing commas `all`, `organizeImports` on, lint recommended + TS rules)
  - [x] Create `vitest.config.ts` with 4 project layers (unit/replay/e2e/live) each scoped by `test/<layer>/**`, coverage provider `v8`, threshold 80% on `src/**` excluding `src/index.ts`
  - [x] Update `.gitignore` to ignore `node_modules/`, `dist/`, `coverage/`, `.vitest-cache/`
  - [x] Stub `src/index.ts` with `process.exit(0)` placeholder
  - [x] Acceptance: `pnpm install` succeeds, `pnpm typecheck` passes, `pnpm biome ci` passes, `pnpm test` runs (0 tests OK)
  - [x] Depends on: —

## Notes

Technical constraints and decisions pulled forward from the spec so tasks can
execute without re-reading it:

- **Sync attempt budget**: `(1 + retries) × (1 + fallback.length)` provider
  invocations in the worst case. Request-level `retries`/`fallback` **replace**
  env-level values (do not merge). See R06.
- **Async retry is outer**: `JOB_MAX_ATTEMPTS` wraps the whole sync attempt
  budget above — a single async job can make `JOB_MAX_ATTEMPTS × (1+retries) ×
  (1+fallback.length)` provider calls in the worst case. See R15.
- **Callback is success-only**: worker posts the result on `complete` with 3
  retries + 5 s timeout; failure never notifies via callback (callers must
  poll or subscribe SSE). Spec §Data flow Async step 4. See R16.
- **OCR bbox is reserved**: `blocks[].bbox` is always `null` in MVP. Do not
  invent values. See R09.
- **Coverage floor**: 80 % on `src/**` excluding `src/index.ts`. See R01
  `vitest.config.ts`.
- **Healthcheck composition**: `/healthz` is a stub in R02 (redis: "down")
  and upgraded in R14 to report real client status. Keep the endpoint
  registered throughout.
- **Request-level timeout**: sync handlers use `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`
  mapped to `ProviderTimeoutError`. Async jobs are NOT time-capped per job.
- **Default model IDs** (per-provider): declared as constants in R06/R07 with
  a `TODO(spec-open-q)` marker; re-verify current vision SKUs at implementation
  time (spec §Open questions).

Open implementation questions carried forward from the spec:

- **Hono multipart parser**: `hono/multipart` is streaming but limited; raw
  stream access via `@hono/node-server` may be needed to hard-cap multipart
  uploads at `MAX_IMAGE_BYTES`. Decide inside R05 when implementing the
  multipart path.
- **Redis client**: `ioredis` is pre-selected (battle-tested, full pub/sub +
  `BRPOPLPUSH` support). Spec lists `node-redis` as an alternative — only
  switch if a blocker surfaces during R14.
