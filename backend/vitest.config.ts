import { defineConfig } from 'vitest/config';

/**
 * Unit tests — colocated with the code they cover, as `src/**\/*.spec.ts`.
 *
 * Decorator metadata (`emitDecoratorMetadata`), which Nest's DI needs to resolve
 * constructor dependencies, is picked up from tsconfig.json by Vite's oxc
 * transform. No extra transform configuration is required.
 */
export default defineConfig({
  resolve: {
    // Resolves the `@/*` alias declared in tsconfig.json.
    tsconfigPaths: true,
  },
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      exclude: ['src/generated/**', 'src/**/*.spec.ts', 'src/main.ts'],
    },
  },
});
