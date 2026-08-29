import { defineConfig } from 'vitest/config';

/** End-to-end tests — real HTTP through a booted Nest app, in `test/`. */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    environment: 'node',
    // Money-path e2e tests will assert on shared database state; running the
    // files sequentially keeps them from racing each other rather than the
    // code under test.
    fileParallelism: false,
  },
});
