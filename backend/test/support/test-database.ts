import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * A real PostgreSQL, booted in-process for integration tests.
 *
 * Why a real database rather than a mock: the properties under test here —
 * `SELECT ... FOR UPDATE` blocking, deterministic lock ordering, unique-index
 * serialisation of concurrent duplicates, CHECK constraints — are *database*
 * behaviours. A mocked Prisma client would assert that we called the right
 * methods, which is precisely not the question. The interesting failure mode is
 * "two transactions interleaved in a way we did not anticipate", and only a
 * real engine can produce it.
 *
 * `embedded-postgres` ships actual PostgreSQL binaries, so this needs no Docker
 * and no installed server — which matters for a hackathon where the demo
 * machine is not the dev machine.
 *
 * Each instance gets its own data directory and port, so test files can run
 * without colliding.
 */
export interface TestDatabase {
  readonly connectionString: string;
  stop(): Promise<void>;
}

/** Ports are randomised to avoid collisions with a developer's local Postgres. */
function pickPort(): number {
  return 55_000 + Math.floor(Math.random() * 5_000);
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const dataDir = mkdtempSync(join(tmpdir(), 'carnival-pg-'));
  const port = pickPort();
  const user = 'carnival';
  const password = 'carnival_test';
  const database = 'carnival_test';

  const postgres = new EmbeddedPostgres({
    databaseDir: dataDir,
    user,
    password,
    port,
    persistent: false,
  });

  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase(database);

  const connectionString = `postgresql://${user}:${password}@127.0.0.1:${port}/${database}?schema=public`;

  // Apply the real migration — including Part 2 of migration.sql, the
  // hand-written CHECK constraints and the ledger immutability trigger. Testing
  // against a schema that was not built by the migration would prove nothing
  // about what actually ships.
  execFileSync(
    process.execPath,
    [join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: connectionString },
      stdio: 'pipe',
    },
  );

  return {
    connectionString,
    async stop(): Promise<void> {
      await postgres.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
