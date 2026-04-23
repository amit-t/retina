/**
 * Filesystem-backed template registry.
 *
 * Extraction templates are plain `*.json` files living under
 * `TEMPLATES_DIR` (spec §Configuration). Each file is a Zod-validated
 * `Template` record carrying the JSON Schema the `extract` task hands to
 * the provider in structured-output mode (R11):
 *
 *   { id: string, version: string, description: string, schema: JsonSchema }
 *
 * `loadTemplates(dir)` walks the directory once at boot, aborts startup on
 * any malformed file (invalid JSON, Zod mismatch, duplicate id, unreadable
 * entry) via `ValidationError`, and returns an immutable `TemplateRegistry`
 * handle. The MVP is explicitly read-only — the spec §Phase 2 backlog
 * reserves a runtime admin API (`POST/PUT/DELETE /v1/templates`) backed by
 * Redis that would replace this loader; until then, operators rebuild the
 * container image to ship new templates.
 *
 * Registry semantics:
 *  - `get(id)` → full `Template` (including `schema`); missing id throws
 *    `TemplateNotFoundError` so the extract route (R11) and the template
 *    detail endpoint (R12a) surface a consistent 404 envelope.
 *  - `list()` → `TemplateSummary[]` (no schema) matching the wire shape
 *    returned by `GET /v1/templates` (spec §API contracts).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { TemplateNotFoundError, ValidationError } from './errors';

/**
 * JSON Schema document attached to a template. Deep-structural validity
 * as a JSON Schema draft is the provider's concern (ai-sdk passes it into
 * structured-output mode); at this layer we only require a JSON object.
 * Mirrors `JsonSchemaObject` in `src/http/schemas.ts`.
 */
export const JsonSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchema>;

/** Zod shape every template file on disk must satisfy. */
export const TemplateSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  schema: JsonSchema,
});
export type Template = z.infer<typeof TemplateSchema>;

/** Wire shape returned by `GET /v1/templates` (R12a). */
export interface TemplateSummary {
  id: string;
  version: string;
  description: string;
}

export interface TemplateRegistry {
  /** Return the full template for `id` or throw `TemplateNotFoundError`. */
  get(id: string): Template;
  /** Return all registered templates as `{id, version, description}` summaries. */
  list(): TemplateSummary[];
}

/**
 * Read every `*.json` file under `dir`, validate against `TemplateSchema`,
 * and return an immutable `TemplateRegistry`. Any malformed file —
 * unreadable entry, non-JSON, schema mismatch, duplicate id — throws
 * `ValidationError` so the bootstrap banner (R13) can render the failing
 * file and exit non-zero. An empty or template-free directory returns a
 * registry whose `list()` yields `[]`; this is a valid operating mode.
 *
 * Non-`*.json` entries are silently skipped so operators can drop a
 * `README.md` (R27) next to templates without tripping the loader.
 */
export function loadTemplates(dir: string): TemplateRegistry {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (cause) {
    throw new ValidationError(`Templates directory unreadable: ${dir}`, {
      cause,
      details: { dir },
    });
  }

  const templates = new Map<string, Template>();
  // Sort for deterministic registration order so duplicate-id and list()
  // ordering is stable across filesystems.
  for (const entry of [...entries].sort()) {
    if (!entry.endsWith('.json')) continue;
    const filepath = join(dir, entry);

    let raw: string;
    try {
      raw = readFileSync(filepath, 'utf8');
    } catch (cause) {
      throw new ValidationError(`Template file unreadable: ${filepath}`, {
        cause,
        details: { file: filepath },
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new ValidationError(`Template file is not valid JSON: ${filepath}`, {
        cause,
        details: { file: filepath },
      });
    }

    const result = TemplateSchema.safeParse(parsed);
    if (!result.success) {
      throw new ValidationError(`Template file failed schema validation: ${filepath}`, {
        cause: result.error,
        details: {
          file: filepath,
          issues: result.error.issues.map((issue) => ({
            path: issue.path.map((p) => String(p)).join('.'),
            message: issue.message,
          })),
        },
      });
    }

    const template = result.data;
    const existing = templates.get(template.id);
    if (existing) {
      throw new ValidationError(`Duplicate template id: ${template.id}`, {
        details: { id: template.id, file: filepath },
      });
    }
    templates.set(template.id, template);
  }

  return {
    get(id: string): Template {
      const template = templates.get(id);
      if (!template) {
        throw new TemplateNotFoundError(`Template "${id}" not found`, {
          details: { id, available: [...templates.keys()] },
        });
      }
      return template;
    },
    list(): TemplateSummary[] {
      return [...templates.values()].map(({ id, version, description }) => ({
        id,
        version,
        description,
      }));
    },
  };
}
