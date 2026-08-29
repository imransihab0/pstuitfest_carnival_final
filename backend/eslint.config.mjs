// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Layered-architecture enforcement.
 *
 * The layering rule for this service is:
 *
 *   Controller  ->  Service  ->  Repository  ->  Prisma / Redis
 *
 * Each layer may only talk to the one directly beneath it. Crucially,
 * **repositories are the only place Prisma is ever invoked** — a service that
 * reaches past its repository into the database is the single easiest way to
 * end up with a balance mutation that sits outside a transaction boundary.
 *
 * These rules turn that convention into a build failure instead of a code-review
 * comment. `import type` is not exempted: a service that needs a Prisma model
 * type is a service that has been handed a persistence concern, and the fix is
 * for the repository to return a domain shape.
 */

/** Import restrictions applied to the controller layer. */
const CONTROLLER_RESTRICTIONS = {
  patterns: [
    {
      group: ['**/*.repository', '**/*.repository.js', '**/repositories/*'],
      message:
        'Controllers must not touch repositories. Route the call through a service — ' +
        'domain logic and transaction boundaries belong in the service layer.',
    },
    {
      group: [
        '@prisma/client',
        '**/prisma.service',
        '**/prisma.service.js',
        '**/infrastructure/prisma/*',
        '**/generated/prisma/*',
      ],
      message:
        'Controllers must never invoke Prisma. Database access is confined to the repository layer.',
    },
    {
      group: ['ioredis', '**/redis.service', '**/redis.service.js', '**/infrastructure/redis/*'],
      message:
        'Controllers must not talk to Redis directly. Go through a service, then a repository.',
    },
  ],
};

/** Import restrictions applied to the service (domain logic) layer. */
const SERVICE_RESTRICTIONS = {
  patterns: [
    {
      group: [
        '@prisma/client',
        '**/prisma.service',
        '**/prisma.service.js',
        '**/infrastructure/prisma/*',
        '**/generated/prisma/*',
      ],
      message:
        'Services must not invoke Prisma directly — repositories are the only place Prisma is used. ' +
        'If you need a Prisma type here, return a domain type from the repository instead.',
    },
    {
      group: ['ioredis', '**/redis.service', '**/redis.service.js', '**/infrastructure/redis/*'],
      message:
        'Services must not use the Redis client directly. Wrap the access in a repository.',
    },
  ],
};

export default tseslint.config(
  {
    name: 'ignores',
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'src/generated/**'],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    name: 'base',
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest },
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Decorator-heavy framework code trips these constantly for no benefit.
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',

      // `any` defeats the point of the strict tsconfig; keep it loud.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // Unhandled promises in a money path lose writes silently.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  /* ------------------------------------------------------------------ *
   * Layer boundaries                                                    *
   * ------------------------------------------------------------------ */

  {
    name: 'layer/controller',
    files: ['src/**/*.controller.ts'],
    rules: {
      'no-restricted-imports': ['error', CONTROLLER_RESTRICTIONS],
    },
  },

  {
    name: 'layer/service',
    // Infrastructure adapters (PrismaService, RedisService) are *themselves* the
    // database and cache clients, so the restriction cannot apply to them.
    files: ['src/**/*.service.ts'],
    ignores: ['src/infrastructure/**'],
    rules: {
      'no-restricted-imports': ['error', SERVICE_RESTRICTIONS],
    },
  },

  {
    name: 'layer/money-arithmetic',
    // Guards NFR-C: money is integer-only, in the minor unit (poisha).
    // Tightened to the money modules once they exist.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'round',
          message:
            'Money is integer-only (NFR-C). Rounding in the money path can create or destroy value — ' +
            'if this is genuinely not a monetary value, disable this rule on the line with a reason.',
        },
        {
          object: 'Number',
          property: 'parseFloat',
          message: 'Money is integer-only (NFR-C). Parse amounts to integer minor units instead.',
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'Money is integer-only (NFR-C). Parse amounts to integer minor units instead.',
        },
      ],
    },
  },

  {
    name: 'tests',
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      'no-restricted-imports': 'off',
    },
  },

  // Must stay last: turns off every stylistic rule Prettier owns.
  eslintConfigPrettier,
);
