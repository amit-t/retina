# Graph Report - .  (2026-04-23)

## Corpus Check
- 17 files · ~9,225 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 70 nodes · 60 edges · 22 communities detected
- Extraction: 87% EXTRACTED · 13% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]

## God Nodes (most connected - your core abstractions)
1. `Retina` - 7 edges
2. `buildApp()` - 6 edges
3. `requestId()` - 3 edges
4. `sizeLimit()` - 3 edges
5. `createErrorHandler()` - 3 edges
6. `buildApp()` - 2 edges
7. `buildApp()` - 2 edges
8. `buildApp()` - 2 edges
9. `ImageTooLargeError` - 2 edges
10. `createLogger()` - 2 edges

## Surprising Connections (you probably didn't know these)
- `buildApp()` --calls--> `requestId()`  [INFERRED]
  test/unit/http/middleware/request-id.spec.ts → src/http/middleware/request-id.ts
- `buildApp()` --calls--> `sizeLimit()`  [INFERRED]
  test/unit/http/middleware/size-limit.test.ts → src/http/middleware/size-limit.ts
- `buildApp()` --calls--> `createErrorHandler()`  [INFERRED]
  test/unit/http/middleware/error.spec.ts → src/http/middleware/error.ts
- `buildApp()` --calls--> `createLogger()`  [INFERRED]
  src/app.ts → src/logger.ts
- `buildApp()` --calls--> `sizeLimit()`  [INFERRED]
  src/app.ts → src/http/middleware/size-limit.ts

## Communities

### Community 0 - "Community 0"
Cohesion: 0.2
Nodes (3): createErrorHandler(), buildApp(), ImageTooLargeError

### Community 1 - "Community 1"
Cohesion: 0.2
Nodes (5): buildApp(), createHealthRoute(), createLogger(), requestId(), buildApp()

### Community 2 - "Community 2"
Cohesion: 0.22
Nodes (9): Bedrock endpoint, Bring your own LLM keys, Drop-in API service for image understanding, Image-to-text API, Image understanding, Retina, Self-hostable image understanding API, Sensing layer for your app (+1 more)

### Community 3 - "Community 3"
Cohesion: 0.4
Nodes (2): ImageFetchError, ProviderRateLimitError

### Community 4 - "Community 4"
Cohesion: 0.5
Nodes (0): 

### Community 5 - "Community 5"
Cohesion: 0.5
Nodes (2): sizeLimit(), buildApp()

### Community 6 - "Community 6"
Cohesion: 0.67
Nodes (0): 

### Community 7 - "Community 7"
Cohesion: 1.0
Nodes (1): RedisUnavailableError

### Community 8 - "Community 8"
Cohesion: 1.0
Nodes (1): JobNotFoundError

### Community 9 - "Community 9"
Cohesion: 1.0
Nodes (1): UnsupportedMediaTypeError

### Community 10 - "Community 10"
Cohesion: 1.0
Nodes (1): InternalError

### Community 11 - "Community 11"
Cohesion: 1.0
Nodes (1): ImageTooLargeError

### Community 12 - "Community 12"
Cohesion: 1.0
Nodes (1): RetinaError

### Community 13 - "Community 13"
Cohesion: 1.0
Nodes (1): ProviderTimeoutError

### Community 14 - "Community 14"
Cohesion: 1.0
Nodes (1): ProviderFailedError

### Community 15 - "Community 15"
Cohesion: 1.0
Nodes (1): ValidationError

### Community 16 - "Community 16"
Cohesion: 1.0
Nodes (1): TemplateNotFoundError

### Community 17 - "Community 17"
Cohesion: 1.0
Nodes (0): 

### Community 18 - "Community 18"
Cohesion: 1.0
Nodes (0): 

### Community 19 - "Community 19"
Cohesion: 1.0
Nodes (0): 

### Community 20 - "Community 20"
Cohesion: 1.0
Nodes (0): 

### Community 21 - "Community 21"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **7 isolated node(s):** `Self-hostable image understanding API`, `Bring your own LLM keys`, `Bedrock endpoint`, `Sensing layer for your app`, `Your own VPC` (+2 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 7`** (2 nodes): `RedisUnavailableError`, `.constructor()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 8`** (2 nodes): `JobNotFoundError`, `.constructor()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 9`** (2 nodes): `UnsupportedMediaTypeError`, `.constructor()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 10`** (2 nodes): `InternalError`, `.constructor()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 11`** (2 nodes): `ImageTooLargeError`, `.constructor()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 12`** (2 nodes): `RetinaError`, `.constructor()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 13`** (2 nodes): `ProviderTimeoutError`, `.constructor()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 14`** (2 nodes): `ProviderFailedError`, `.constructor()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 15`** (2 nodes): `ValidationError`, `.constructor()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 16`** (2 nodes): `TemplateNotFoundError`, `.constructor()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 17`** (1 nodes): `vitest.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 18`** (1 nodes): `logger.spec.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 19`** (1 nodes): `errors.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 20`** (1 nodes): `health.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 21`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `buildApp()` connect `Community 1` to `Community 0`, `Community 5`?**
  _High betweenness centrality (0.083) - this node is a cross-community bridge._
- **Why does `createErrorHandler()` connect `Community 0` to `Community 1`?**
  _High betweenness centrality (0.062) - this node is a cross-community bridge._
- **Are the 5 inferred relationships involving `buildApp()` (e.g. with `createLogger()` and `requestId()`) actually correct?**
  _`buildApp()` has 5 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `requestId()` (e.g. with `buildApp()` and `buildApp()`) actually correct?**
  _`requestId()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `sizeLimit()` (e.g. with `buildApp()` and `buildApp()`) actually correct?**
  _`sizeLimit()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `createErrorHandler()` (e.g. with `buildApp()` and `buildApp()`) actually correct?**
  _`createErrorHandler()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Self-hostable image understanding API`, `Bring your own LLM keys`, `Bedrock endpoint` to the rest of the system?**
  _7 weakly-connected nodes found - possible documentation gaps or missing edges._