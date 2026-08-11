import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'apps/**/src/**/*.test.ts',
      'apps/**/src/**/*.test.tsx',
      'tools/**/*.test.mjs',
      // Requires a live database; skips itself when DATABASE_URL is unset.
      'db/test/**/*.test.mjs',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reportsOnly: false,
      reporter: ['text', 'lcov'],
      // Business rules live in packages/, and they have no infrastructure excuses:
      // no database, no network, no clock. Held to a higher bar than app code.
      // `v1.ts` is the specification document itself — data, not logic — so its
      // coverage number would measure nothing; its correctness is asserted by
      // v1.test.ts through checkPublishable instead.
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', 'packages/spec/src/v1.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
