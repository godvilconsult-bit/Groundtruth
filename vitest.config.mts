import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'apps/**/src/**/*.test.ts',
      'tools/**/*.test.mjs',
      // Requires a live database; skips itself when DATABASE_URL is unset.
      'db/test/**/*.test.mjs',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reportsOnly: false,
      reporter: ['text', 'lcov'],
      // The domain layer is the only place business rules live, and it has no
      // infrastructure excuses. It is held to a higher bar than anything else.
      include: ['packages/domain/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
