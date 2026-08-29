import { defineConfig } from 'vitest/config';

/**
 * Integration tests — run against a **real PostgreSQL** booted in-process by
 * `embedded-postgres` (no Docker required).
 *
 * Separated from the unit and e2e suites because these are slow: each file
 * initialises a database cluster and applies migrations. `npm test` stays fast;
 * `npm run test:integration` is where the concurrency proof lives.
 */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.integration-spec.ts'],
    environment: 'node',
    // Each file boots its own cluster; running them in parallel would multiply
    // memory and port pressure for no gain.
    fileParallelism: false,
    // initdb + migrate is slow on a cold run.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
