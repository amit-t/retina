# Live integration suite (R21)

Real-network smoke tests that exercise each provider (`openai`, `anthropic`,
`google`, `bedrock`) end-to-end through `POST /v1/describe` against the
actual backend service.

Unlike `test/replay/` (which uses recorded fixtures via `undici` MockAgent)
and `test/e2e/` (which MockAgents the provider but uses a real Redis
container), the live suite installs **no** HTTP mocks — every request
leaves the box.

## When it runs

Live specs are gated by `describe.skipIf(...)`, never by `test.fail`.
Missing creds **skip**; broken creds **fail**.

| Spec                           | Required env                                                   |
| ------------------------------ | -------------------------------------------------------------- |
| `openai-describe.spec.ts`      | `INTEGRATION` + `OPENAI_API_KEY`                               |
| `anthropic-describe.spec.ts`   | `INTEGRATION` + `ANTHROPIC_API_KEY`                            |
| `google-describe.spec.ts`      | `INTEGRATION` + `GOOGLE_GENERATIVE_AI_API_KEY`                 |
| `bedrock-describe.spec.ts`     | `INTEGRATION` + `AWS_REGION` (plus AWS creds resolvable by SDK) |

`INTEGRATION=1` is the master switch. With `INTEGRATION` unset every spec
skips, so `pnpm test:live` is safe to leave in CI for non-credentialed
pipelines.

## Running one provider

```bash
INTEGRATION=1 OPENAI_API_KEY=sk-... pnpm test:live
```

This is the acceptance case for task R21: the OpenAI smoke runs against
the real API, the other three providers skip.

## Running all providers

```bash
INTEGRATION=1 \
  OPENAI_API_KEY=sk-... \
  ANTHROPIC_API_KEY=sk-ant-... \
  GOOGLE_GENERATIVE_AI_API_KEY=... \
  AWS_REGION=us-west-2 \
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  pnpm test:live
```

The nightly GitHub Actions workflow (`R25` — `.github/workflows/live.yml`)
wires these secrets automatically.

## Model overrides

Each spec honours an optional `<PROVIDER>_MODEL` env var so operators can
pin a specific SKU without editing code:

- `OPENAI_MODEL`, `ANTHROPIC_MODEL`, `GOOGLE_MODEL`, `BEDROCK_MODEL`

When unset the per-provider default in `src/core/providers/<provider>.ts`
wins (see the `*_DEFAULT_MODEL_ID` constants).

## Sample image

The smokes POST an inline base64 1×1 red PNG (`SAMPLE_PNG_BASE64` in
`setup.ts`). That keeps the suite hermetic: the only egress is from the
provider SDK to its backend, never from retina fetching an image URL.

Every supported vision model returns a (usually terse) description for a
single-pixel image, which is all a smoke needs to prove that credentials,
provider wiring, and response shaping all line up.

## Relationship to other layers

See `.ralph/constitution.md` §Testing ladder for the full taxonomy. In
short:

1. **unit** (`test/unit/`) — no network, no Redis; one module at a time.
2. **replay** (`test/replay/`) — MockAgent + recorded fixtures per provider.
3. **e2e** (`test/e2e/`) — MockAgent provider + real Redis testcontainer +
   async job lifecycle.
4. **live** (this directory) — real provider + optional Redis; gated by
   `INTEGRATION`.
