# Replay tests

> Layer 2 of the Retina testing ladder (see `.ralph/constitution.md`
> §Testing ladder). Replay tests exercise the full describe / ocr /
> extract pipeline — from `buildApp()` through `ProviderRouter` into the
> concrete `@ai-sdk/*` providers — but intercept every outbound HTTP
> request with `undici` `MockAgent` so the suite is offline, deterministic,
> and safe to run in CI without credentials.

## Layout

```
test/replay/
├── README.md               — this file
├── setup.ts                — MockAgent bootstrap + fixture loader
├── record.ts               — CLI that regenerates fixtures against real
│                             provider HTTP (gated on RECORD=1)
├── describe.spec.ts        — POST /v1/describe for bedrock/openai/anthropic/google
└── fixtures/
    ├── bedrock/describe-basic.json
    ├── openai/describe-basic.json
    ├── anthropic/describe-basic.json
    └── google/describe-basic.json
```

Each fixture is a captured HTTP exchange:

```jsonc
{
  "provider": "openai",
  "task": "describe",
  "model": "gpt-4o",
  "request":  { "origin": "...", "method": "POST", "path": "/v1/..." },
  "response": { "status": 200, "headers": { ... }, "body": { ... } }
}
```

`request.path` is matched against the outgoing `fetch()` URL's pathname
(already percent-encoded). Origins pin the host Netflix-style so a typo
in a provider base URL fails fast instead of silently falling through to
the real internet — `MockAgent.disableNetConnect()` enforces this.

## Running

```bash
pnpm test:replay
```

This is wired as a Vitest project in `vitest.config.ts` scoped to
`test/replay/**`. The suite runs on every PR per the testing ladder and
has no network or credential requirements.

## Writing a new replay test

1. Pick a fixture name (`ocr-basic`, `extract-invoice`, ...).
2. Start with a plausible handwritten fixture under
   `fixtures/<provider>/<name>.json` — or jump straight to step 5 if you
   already have credentials.
3. Call `beginReplay()` from `./setup.ts` in a `beforeEach`, load the
   fixture via `loadFixture(provider, name)`, then `ctx.intercept(fx)`.
4. Drive the request through `buildApp()` (same as the describe spec).
5. Once credentials are in place, regenerate the fixture from real HTTP
   via `record.ts` (below) to keep the committed body true to life.

## Regenerating fixtures

Fixtures are deliberately committed so CI never needs provider creds. To
refresh them against the real wire format:

```bash
RECORD=1 \
  OPENAI_API_KEY=sk-... \
  ANTHROPIC_API_KEY=sk-ant-... \
  GOOGLE_GENERATIVE_AI_API_KEY=... \
  AWS_REGION=us-east-1 \
  AWS_ACCESS_KEY_ID=... \
  AWS_SECRET_ACCESS_KEY=... \
  pnpm tsx test/replay/record.ts
```

Gating notes:

- `RECORD=1` is required — the script refuses to run otherwise. This
  prevents accidental billed invocations from an unrelated `pnpm test`
  run.
- Each provider is only regenerated when its credential(s) are present.
  Missing creds skip that provider (logged to stderr) rather than fail
  the entire run — partial refreshes are supported.
- The recorder refuses to write a fixture whose response body contains
  suspicious credential-shaped strings (e.g. `sk-...`, `AKIA...`,
  `Bearer ...`). Redact the body by hand and re-run if this trips.

After recording, commit the updated `fixtures/**.json` alongside the spec
update that prompted the refresh.

## Provider URL matrix

For reference when reviewing fixtures or debugging an unmatched
interception:

| Provider  | Origin                                                   | Describe path                                     |
|-----------|----------------------------------------------------------|---------------------------------------------------|
| openai    | `https://api.openai.com`                                 | `/v1/responses`                                   |
| anthropic | `https://api.anthropic.com`                              | `/v1/messages`                                    |
| google    | `https://generativelanguage.googleapis.com`              | `/v1beta/models/<model>:generateContent`          |
| bedrock   | `https://bedrock-runtime.<region>.amazonaws.com`         | `/model/<url-encoded-model-id>/converse`          |

See each provider module in `src/core/providers/` for the exact model
defaults; the fixtures pin the default model unless the spec exercises
an override.
