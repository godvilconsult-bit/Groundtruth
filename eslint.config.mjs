import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'apps/collector/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Node globals for plain-JS tooling. Declared explicitly rather than pulling in
  // the `globals` package for four names.
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
      },
    },
  },

  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
    },
  },

  /**
   * The dependency rule, enforced (DECISIONS.md D-001).
   *
   * `@groundtruth/domain` declares no dependencies, so a framework import already
   * fails to resolve at build time. This rule catches the same mistake earlier and
   * with a message that explains itself, and additionally blocks Node built-ins —
   * which WOULD resolve, and which are exactly how a domain layer quietly acquires
   * filesystem and network access.
   */
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*', 'pg', 'ioredis', 'bullmq', '@aws-sdk/*', 'typeorm', 'prisma'],
              message:
                'The domain layer must not import frameworks or infrastructure. ' +
                'Define a port in the application layer instead (ADR: Clean Architecture, D-001).',
            },
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'crypto', 'child_process'],
              message:
                'The domain layer must be unit-testable with no filesystem, no network ' +
                'and no clock. Inject what you need through a port.',
            },
            {
              group: ['../../*'],
              message: 'The domain layer must not reach outside its own package.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['**/*.test.ts', '**/*.test.mjs', 'tools/**/*.mjs'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
