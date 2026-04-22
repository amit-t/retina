# Retina Constitution

> Authoritative charter for ralph-driven development. Every ralph loop must
> honor this file. If a task in `.ralph/fix_plan.md` conflicts with this
> constitution, the constitution wins — amend the task first.

## Mission

Retina is a **self-hostable HTTP API service for image understanding** —
description, OCR, and structured extraction — backed by pluggable vision LLM
providers via `ai-sdk`. Operators deploy it as a container behind their own
load balancer in their own VPC, pass their own provider credentials, and call
a small set of REST endpoints.

## Non-goals

Items explicitly outside MVP scope. Do not add ralph tasks for these.

- Auth / authn / authz inside the service (the caller's ALB/API gateway does this).
- Rate limiting inside the service (upstream does this).
- Multi-tenant billing or usage metering beyond the per-response `usage` echo.
- Image preprocessing beyond size validation and format normalization.
- Bounding-box OCR. The OCR endpoint returns full text; `blocks[].bbox` is
  always `null` in MVP, reserved for Phase 2.
- User-facing UI — this is an API only.

## Stack decisions

| Dimension | Choice |
|---|---|
| Runtime | Node 20+ (production) |
| HTTP framework | Hono |
| Validation | Zod |
| Logger | pino (JSON to stdout) |
| LLM abstraction | `ai-sdk` (`ai` + `@ai-sdk/openai` + `@ai-sdk/amazon-bedrock` + `@ai-sdk/anthropic` + `@ai-sdk/google`) |
| Job queue / state | Redis (`ioredis`) |
| Server | `@hono/node-server` |
| Dev runtime | Bun via `tsx` (dev) |
| Package manager | pnpm |
| Language | TypeScript (strict) |
| Lint + format | Biome |
| Test runner | Vitest |
| HTTP mock | `undici` MockAgent |
| E2E Redis | `@testcontainers/redis` |
| Container base | `node:20-alpine` |
| Config | Environment variables only (Zod-validated) |

## Architecture invariants

These are load-bearing. Breaking any of them requires an explicit amendment to
this constitution.

1. **Stateless container**. A retina process holds no persistent state across
   restarts. All durable state lives in external Redis (jobs, results,
   pub/sub for SSE). Templates are loaded from the filesystem at boot.
2. **External Redis**. Redis is reached via `REDIS_URL` and is NOT bundled
   inside the container image. Deployments supply it.
3. **No in-service auth**. No auth middleware, no token verification, no user
   model. Every request is treated as trusted because the ALB/API gateway
   fronted it.
4. **No in-service rate limiting**. No token buckets, no per-key quotas.
   Upstream handles this.
5. **`ai-sdk` is the provider abstraction**. All provider calls go through
   `ai-sdk`. Do NOT call provider SDKs directly from task/route code.
6. **Typed error envelope**. All non-2xx responses share the shape
   `{error: {code, message, requestId, details?}}`. All thrown errors inside
   `src/` must be subclasses of `RetinaError`. Unknown errors are mapped to
   `InternalError` 500 by the error middleware.
7. **Single error middleware**. There is exactly one error-mapping layer
   (`src/http/middleware/error.ts`). Route handlers throw; they do not
   construct envelopes.
8. **Request-level options REPLACE env-level options**. `ProviderOptions`
   (`provider`, `model`, `fallback`, `retries`) on a request body replace the
   env-level defaults for that request — they do not merge or extend.
9. **Structured logging**. Every log line is JSON. Every request-scoped log
   includes the `requestId`.
10. **Sync requests are time-capped** via `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`
    and mapped to `ProviderTimeoutError`. Async jobs are NOT time-capped
    per-job (the worker stays on one job until the provider returns).
11. **Callback webhooks are success-only**. Async-job callbacks fire only
    when a job reaches `completed` state. Failure notification is via polling
    or SSE.

## Code style

- **TypeScript strict mode**: `strict: true`, `noUncheckedIndexedAccess: true`,
  `exactOptionalPropertyTypes: true`. Target ES2022, module ESNext,
  moduleResolution bundler.
- **Biome** is the single source of truth for lint + format. Config lives in
  `biome.json`. 2-space indent, single quotes, `organizeImports` on.
- **Zod-validated config**. All environment variables are parsed via a Zod
  schema at boot; invalid config aborts startup with a typed error.
- **Vitest** is the only test runner. No jest, no mocha.
- **Comments**: default to zero. Only add a comment when the WHY is
  non-obvious (a hidden constraint, a subtle invariant, a workaround for a
  specific bug). Do not write docstrings that restate what well-named
  identifiers already convey.
- **Error handling**: throw typed `RetinaError` subclasses inside `src/`; let
  the error middleware shape the HTTP response. Do not construct error
  envelopes inside handlers.
- **Imports**: use named exports. Avoid default exports. Avoid `require`.
- **No `any`, no `@ts-ignore`, no `as unknown as`** except at genuine external
  boundaries (HTTP body parsing, Redis reply types). When unavoidable, add a
  one-line comment explaining why.

## Protected paths

Never modify these under any refactoring, cleanup, or restructuring task.
They are ralph's control plane.

- `.ralph/` (entire directory and all contents)
- `.ralphrc`

Files you MAY update through the dedicated ralph loops:

- `.ralph/fix_plan.md` — append completed checkboxes as tasks land.
- `.ralph/constitution.md` — amend only via a deliberate governance task.
- `.ralph/AGENT.md` — update when build/test/run commands genuinely change.

## Testing ladder

Every feature moves up this ladder. Do NOT skip layers.

1. **unit/** — pure modules in isolation. Mock `ai-sdk` at the boundary.
   Covers prompt construction, template loading, Zod validation, error
   mapping, config parsing, image normalizer branches. Runs on every PR,
   every commit.
2. **replay/** — fixture-based provider integration. `undici` MockAgent
   replays recorded provider HTTP from `test/replay/fixtures/<provider>/`.
   Fixtures are regenerated on demand by `test/replay/record.ts` (gated by
   `RECORD=1` + real creds). Runs on every PR.
3. **e2e/** — full app boot via `@hono/node-server` on a random port + Redis
   via `@testcontainers/redis`. Exercises the async lifecycle, SSE, callback
   webhook via in-test fake HTTP server. Provider layer stubbed via
   MockAgent. Runs on every PR.
4. **live/** — same shape as e2e but with MockAgent disabled and real
   provider HTTP. Gated by `INTEGRATION=1` and credential presence. Runs on
   `workflow_dispatch` and nightly on `main` — NOT on PR.

**Coverage floor**: 80 % on `src/**` excluding `src/index.ts`. Below this CI
fails.

## Definition of done for a ralph loop

Before a ralph loop may mark a task complete and commit, ALL of the following
must pass locally:

1. `pnpm biome ci` — lint + format clean.
2. `pnpm typecheck` (`tsc --noEmit`) — strict typecheck clean.
3. `pnpm test:unit` — unit tests green.
4. `pnpm test:replay` — replay tests green (once R19 exists).
5. `pnpm test:e2e` — e2e tests green (once R20 exists).
6. The completed task's checkbox in `.ralph/fix_plan.md` is checked AND moved
   to the `## Completed` section (preserving its `**Rxx**` ID).
7. Commit is made with a descriptive message referencing the R-ID and the
   spec section (e.g. `feat(R08): POST /v1/describe — spec §API contracts`).

Tasks that cannot meet this bar are left `in_progress`; the ralph loop must
NOT batch partial work across commits.

## Governance

Amendments to this constitution require a deliberate ralph task that edits
`.ralph/constitution.md` and nothing else. Drifting a rule silently across
multiple implementation commits is not permitted.
