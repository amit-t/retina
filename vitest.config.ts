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
