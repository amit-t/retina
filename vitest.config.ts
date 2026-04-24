import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**'],
      exclude: ['src/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.{spec,test}.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'replay',
          include: ['test/replay/**/*.{spec,test}.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.{spec,test}.ts'],
          // R20 — globalSetup boots a Redis testcontainer + Hono server on
          // a random free port and exports RETINA_E2E_{BASE_URL,REDIS_URL,
          // JOBS_READY} for the lifecycle spec. Scoped to the e2e project
          // so `pnpm test:unit` stays docker-free.
          globalSetup: ['./test/e2e/setup.ts'],
          // Lifecycle polling + testcontainer boot push past the 5 s
          // default; 60 s matches the container startup timeout in
          // setup.ts.
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'live',
          include: ['test/live/**/*.{spec,test}.ts'],
        },
      },
    ],
  },
});
