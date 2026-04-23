import { describe, expect, it } from 'vitest';
import { type Config, type ConfigIssue, loadConfig } from '../../src/config.js';
import { ValidationError } from '../../src/core/errors.js';

const MINIMAL_ENV = {
  REDIS_URL: 'redis://localhost:6379/0',
  PROVIDERS: 'openai',
  DEFAULT_PROVIDER: 'openai',
  OPENAI_API_KEY: 'sk-test',
} as const;

const issuesOf = (fn: () => unknown): ConfigIssue[] => {
  try {
    fn();
    throw new Error('expected loadConfig to throw');
  } catch (e) {
    if (!(e instanceof ValidationError)) {
      throw new Error(`expected ValidationError, got ${(e as Error).constructor.name}`);
    }
    return (e.details?.issues as ConfigIssue[]) ?? [];
  }
};

describe('loadConfig', () => {
  it('accepts a valid minimal env and returns a typed Config', () => {
    const cfg: Config = loadConfig({ ...MINIMAL_ENV });
    expect(cfg.REDIS_URL).toBe('redis://localhost:6379/0');
    expect(cfg.PROVIDERS).toEqual(['openai']);
    expect(cfg.DEFAULT_PROVIDER).toBe('openai');
    expect(cfg.OPENAI_API_KEY).toBe('sk-test');
  });

  it('applies every documented default when only required vars are set', () => {
    const cfg = loadConfig({ ...MINIMAL_ENV });
    expect(cfg.PORT).toBe(8080);
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.MAX_IMAGE_BYTES).toBe(10_485_760);
    expect(cfg.RETRY_ATTEMPTS).toBe(0);
    expect(cfg.RETRY_BACKOFF_MS).toBe(250);
    expect(cfg.WORKER_CONCURRENCY).toBe(2);
    expect(cfg.JOB_RESULT_TTL_SECONDS).toBe(86_400);
    expect(cfg.JOB_MAX_ATTEMPTS).toBe(3);
    expect(cfg.REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(cfg.SSE_HEARTBEAT_MS).toBe(15_000);
    expect(cfg.TEMPLATES_DIR).toBe('/app/templates');
    expect(cfg.FALLBACK_CHAIN).toEqual([]);
  });

  it('coerces numeric env strings and trims CSV whitespace', () => {
    const cfg = loadConfig({
      ...MINIMAL_ENV,
      PORT: '9090',
      MAX_IMAGE_BYTES: '20971520',
      PROVIDERS: ' openai , anthropic ',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      FALLBACK_CHAIN: 'anthropic',
    });
    expect(cfg.PORT).toBe(9090);
    expect(cfg.MAX_IMAGE_BYTES).toBe(20_971_520);
    expect(cfg.PROVIDERS).toEqual(['openai', 'anthropic']);
    expect(cfg.FALLBACK_CHAIN).toEqual(['anthropic']);
  });

  it('throws ValidationError when REDIS_URL is missing', () => {
    const { REDIS_URL: _omit, ...env } = MINIMAL_ENV;
    const issues = issuesOf(() => loadConfig(env));
    expect(issues.map((i) => i.path)).toContain('REDIS_URL');
  });

  it('throws ValidationError when PROVIDERS is missing', () => {
    const { PROVIDERS: _omit, ...env } = MINIMAL_ENV;
    const issues = issuesOf(() => loadConfig(env));
    expect(issues.map((i) => i.path)).toContain('PROVIDERS');
  });

  it('rejects DEFAULT_PROVIDER that is not in PROVIDERS', () => {
    const issues = issuesOf(() =>
      loadConfig({
        ...MINIMAL_ENV,
        PROVIDERS: 'openai',
        DEFAULT_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'sk-ant',
      }),
    );
    const paths = issues.map((i) => i.path);
    expect(paths).toContain('DEFAULT_PROVIDER');
  });

  it('rejects FALLBACK_CHAIN entries outside PROVIDERS', () => {
    const issues = issuesOf(() =>
      loadConfig({
        ...MINIMAL_ENV,
        FALLBACK_CHAIN: 'anthropic',
      }),
    );
    const paths = issues.map((i) => i.path);
    expect(paths).toContain('FALLBACK_CHAIN.0');
  });

  it('rejects OPENAI_API_KEY missing when PROVIDERS includes openai', () => {
    const { OPENAI_API_KEY: _omit, ...env } = MINIMAL_ENV;
    const issues = issuesOf(() => loadConfig(env));
    expect(issues.map((i) => i.path)).toContain('OPENAI_API_KEY');
  });

  it('rejects AWS_REGION missing when PROVIDERS includes bedrock', () => {
    const issues = issuesOf(() =>
      loadConfig({
        REDIS_URL: 'redis://localhost:6379/0',
        PROVIDERS: 'bedrock',
        DEFAULT_PROVIDER: 'bedrock',
      }),
    );
    expect(issues.map((i) => i.path)).toContain('AWS_REGION');
  });

  it('rejects ANTHROPIC_API_KEY missing when anthropic is listed', () => {
    const issues = issuesOf(() =>
      loadConfig({
        ...MINIMAL_ENV,
        PROVIDERS: 'openai,anthropic',
      }),
    );
    expect(issues.map((i) => i.path)).toContain('ANTHROPIC_API_KEY');
  });

  it('rejects GOOGLE_GENERATIVE_AI_API_KEY missing when google is listed', () => {
    const issues = issuesOf(() =>
      loadConfig({
        ...MINIMAL_ENV,
        PROVIDERS: 'openai,google',
      }),
    );
    expect(issues.map((i) => i.path)).toContain('GOOGLE_GENERATIVE_AI_API_KEY');
  });

  it('rejects unknown provider names in PROVIDERS', () => {
    const issues = issuesOf(() =>
      loadConfig({
        ...MINIMAL_ENV,
        PROVIDERS: 'openai,sora',
      }),
    );
    expect(issues.some((i) => i.path.startsWith('PROVIDERS'))).toBe(true);
  });

  it('treats empty-string env values as unset and applies defaults', () => {
    const cfg = loadConfig({
      ...MINIMAL_ENV,
      PORT: '',
      LOG_LEVEL: '',
      FALLBACK_CHAIN: '',
    });
    expect(cfg.PORT).toBe(8080);
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.FALLBACK_CHAIN).toEqual([]);
  });

  it('rejects JOB_MAX_ATTEMPTS less than 1', () => {
    const issues = issuesOf(() => loadConfig({ ...MINIMAL_ENV, JOB_MAX_ATTEMPTS: '0' }));
    expect(issues.map((i) => i.path)).toContain('JOB_MAX_ATTEMPTS');
  });

  it('rejects non-numeric numeric env vars with the field path', () => {
    const issues = issuesOf(() => loadConfig({ ...MINIMAL_ENV, PORT: 'eighty-eighty' }));
    expect(issues.map((i) => i.path)).toContain('PORT');
  });

  it('defaults process.env when no argument is passed', () => {
    const prev = { ...process.env };
    try {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, MINIMAL_ENV);
      const cfg = loadConfig();
      expect(cfg.DEFAULT_PROVIDER).toBe('openai');
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, prev);
    }
  });
});
