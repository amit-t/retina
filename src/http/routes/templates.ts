/**
 * `GET /v1/templates` and `GET /v1/templates/:id` — template metadata.
 *
 * Read-only endpoints that expose the filesystem-backed template registry
 * (R10, loaded at bootstrap from `TEMPLATES_DIR`). Together they let
 * operators and API clients discover what extraction templates the server
 * has on disk and fetch the JSON Schema attached to any one of them.
 *
 * Wire shapes (spec §API contracts):
 *
 *   GET /v1/templates      →  200  [{id, version, description}]
 *   GET /v1/templates/:id  →  200  {id, version, description, schema}
 *                         |   404  { error: { code: "template_not_found", … } }
 *
 * The list endpoint intentionally omits `schema` — schemas can be large
 * and callers discovering the catalog rarely need them. The detail
 * endpoint returns the full record including `schema` so clients can
 * validate locally or echo the shape back in an `/v1/extract` call via
 * `templateId`.
 *
 * 404 handling: missing ids throw `TemplateNotFoundError` from the
 * registry (`src/core/templates.ts` + `src/core/errors.ts`). The shared
 * error middleware (R02e) shapes the envelope and attaches the request
 * id, so this route constructs no envelopes of its own (constitution
 * invariant #7).
 *
 * The registry is effectively immutable for the lifetime of the process
 * — the MVP ships no runtime admin API for templates; operators rebuild
 * the container image to publish a new one. A future `POST/PUT/DELETE
 * /v1/templates` surface is reserved for Phase 2 (spec §Phase 2 roadmap).
 */

import { Hono } from 'hono';
import type { Template, TemplateRegistry, TemplateSummary } from '../../core/templates.js';

export interface TemplatesRouteDeps {
  templates: TemplateRegistry;
}

/**
 * Build the templates route. Exposed as a factory so `buildApp()` can
 * mount it only when a concrete `TemplateRegistry` (R10) has been
 * supplied, keeping zero-wiring test harnesses that never exercise the
 * template catalog self-contained.
 */
export function createTemplatesRoute(deps: TemplatesRouteDeps): Hono {
  const app = new Hono();

  app.get('/v1/templates', (c) => {
    const summaries: TemplateSummary[] = deps.templates.list();
    return c.json(summaries);
  });

  app.get('/v1/templates/:id', (c) => {
    // Registry.get() throws TemplateNotFoundError on miss; the shared
    // error middleware turns that into a 404 `template_not_found`
    // envelope. Nothing to do here beyond forward the id.
    const template: Template = deps.templates.get(c.req.param('id'));
    return c.json(template);
  });

  return app;
}
