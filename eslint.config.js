// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

/**
 * Lint baseline for the platform.
 *
 * Beyond ordinary code quality, this config carries a small number of
 * ARCHITECTURAL rules. The full dependency-rule enforcement lives in the
 * architecture fitness tests (tests/architecture/*.test.ts) because those can
 * express module-boundary rules that ESLint cannot express well for relative
 * imports. What lives here are the rules ESLint expresses better: keeping the
 * pure packages free of infrastructure, and banning known-unsafe APIs.
 */

/** Infrastructure that must never be imported by pure domain/policy packages. */
const INFRASTRUCTURE_MODULES = [
  'pg',
  'postgres',
  'fastify',
  'node:fs',
  'node:fs/promises',
  'fs',
  'node:http',
  'node:https',
  'node:child_process',
  'child_process',
  'node:net',
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'apps/web/dist/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    plugins: { import: importPlugin },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // --- Correctness / safety -------------------------------------------
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-param-reassign': 'error',

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Import hygiene: a cycle between modules is an architecture smell and
      // makes future extraction of a domain into its own service impossible.
      'import/no-cycle': ['error', { maxDepth: Infinity }],
      'import/no-self-import': 'error',
    },
  },

  // --- Pure packages: no infrastructure, no I/O ---------------------------
  // The policy engine in particular must stay a pure function of its inputs so
  // that authorization decisions are exhaustively unit-testable without a
  // database, a network, or a clock.
  {
    files: ['packages/authz/**/*.ts', 'packages/contracts/**/*.ts', 'packages/kernel/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: INFRASTRUCTURE_MODULES.map((name) => ({
            name,
            message:
              'Pure packages (authz/contracts/kernel) must not depend on infrastructure. ' +
              'Accept the data you need as a parameter instead; the caller performs the I/O.',
          })),
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Pure packages must not perform network I/O.' },
      ],
    },
  },

  // Tests may reach for infrastructure and may use `any` when constructing
  // deliberately malformed input to prove validation rejects it.
  {
    files: ['**/*.test.ts', '**/tests/**/*.ts', 'tools/**/*.ts', 'db/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-imports': 'off',
      'no-console': 'off',
    },
  },
);
