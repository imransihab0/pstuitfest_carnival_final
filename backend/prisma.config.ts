import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * As of Prisma 7 the datasource URL may no longer live in `schema.prisma`. It is
 * declared here for the CLI (migrate, studio, db push); the *application's*
 * runtime connection is created separately through a driver adapter in
 * `src/infrastructure/prisma/prisma.service.ts`.
 *
 * Both read the same `DATABASE_URL`, so there is one source of truth for where
 * the database is — the difference is only who opens the connection.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // `tsx`, not bare `node`. Node's native type stripping does not remap the
    // TypeScript-style `./client.js` import specifier onto the `client.ts` file
    // that Prisma actually generates, so `node prisma/seed.ts` fails to resolve
    // the client. tsx handles that remapping.
    seed: 'npx tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
