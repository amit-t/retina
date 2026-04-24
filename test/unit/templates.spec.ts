import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TemplateNotFoundError, ValidationError } from '../../src/core/errors';
import { loadTemplates } from '../../src/core/templates';

const validInvoice = {
  id: 'invoice-v1',
  version: '1.0.0',
  description: 'Invoice extraction schema',
  schema: {
    type: 'object',
    properties: { total: { type: 'number' } },
  },
};

const validReceipt = {
  id: 'receipt-v1',
  version: '2.1.3',
  description: 'Retail receipt schema',
  schema: {
    type: 'object',
    properties: { merchant: { type: 'string' } },
  },
};

describe('loadTemplates', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'retina-templates-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads valid templates and exposes them via get() and list()', () => {
    writeFileSync(join(dir, 'invoice.json'), JSON.stringify(validInvoice));
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify(validReceipt));

    const registry = loadTemplates(dir);

    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.map((t) => t.id).sort()).toEqual(['invoice-v1', 'receipt-v1']);

    // Summaries omit the schema — matches the `GET /v1/templates` wire shape.
    for (const summary of list) {
      expect(summary).not.toHaveProperty('schema');
      expect(summary).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          version: expect.any(String),
          description: expect.any(String),
        }),
      );
    }

    const invoice = registry.get('invoice-v1');
    expect(invoice).toEqual(validInvoice);
    expect(invoice.schema).toEqual(validInvoice.schema);

    const receipt = registry.get('receipt-v1');
    expect(receipt.version).toBe('2.1.3');
    expect(receipt.description).toBe('Retail receipt schema');
  });

  it('empty directory yields an empty registry', () => {
    const registry = loadTemplates(dir);
    expect(registry.list()).toEqual([]);
    expect(() => registry.get('anything')).toThrow(TemplateNotFoundError);
  });

  it('ignores non-*.json files in the directory', () => {
    writeFileSync(join(dir, 'invoice.json'), JSON.stringify(validInvoice));
    writeFileSync(join(dir, 'README.md'), '# templates');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');

    const registry = loadTemplates(dir);
    expect(registry.list().map((t) => t.id)).toEqual(['invoice-v1']);
  });

  it('invalid JSON aborts startup with ValidationError', () => {
    writeFileSync(join(dir, 'broken.json'), '{ not json');

    const err = (() => {
      try {
        loadTemplates(dir);
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(ValidationError);
    const details = (err as ValidationError).details as { file: string };
    expect(details.file).toBe(join(dir, 'broken.json'));
    expect((err as ValidationError).message).toMatch(/not valid JSON/);
  });

  it('schema-mismatch aborts startup with ValidationError carrying Zod issues', () => {
    // Missing `version` and `description`, schema is a string not an object.
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ id: 'bad-v1', schema: 'not-an-object' }));

    const err = (() => {
      try {
        loadTemplates(dir);
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(ValidationError);
    const details = (err as ValidationError).details as {
      file: string;
      issues: Array<{ path: string; message: string }>;
    };
    expect(details.file).toBe(join(dir, 'bad.json'));
    expect(details.issues.length).toBeGreaterThan(0);
    const paths = details.issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['version']));
    expect(paths).toEqual(expect.arrayContaining(['description']));
    expect(paths).toEqual(expect.arrayContaining(['schema']));
  });

  it('get() throws TemplateNotFoundError with details on unknown id', () => {
    writeFileSync(join(dir, 'invoice.json'), JSON.stringify(validInvoice));
    const registry = loadTemplates(dir);

    const err = (() => {
      try {
        registry.get('missing-v9');
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(TemplateNotFoundError);
    const terr = err as TemplateNotFoundError;
    expect(terr.code).toBe('template_not_found');
    expect(terr.status).toBe(404);
    const details = terr.details as { id: string; available: string[] };
    expect(details.id).toBe('missing-v9');
    expect(details.available).toEqual(['invoice-v1']);
  });

  it('duplicate template id aborts startup with ValidationError', () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(validInvoice));
    writeFileSync(join(dir, 'b.json'), JSON.stringify(validInvoice));

    expect(() => loadTemplates(dir)).toThrow(ValidationError);
  });

  it('unreadable directory aborts startup with ValidationError', () => {
    const missing = join(dir, 'does-not-exist');
    const err = (() => {
      try {
        loadTemplates(missing);
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(ValidationError);
    const details = (err as ValidationError).details as { dir: string };
    expect(details.dir).toBe(missing);
  });
});
