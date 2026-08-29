import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { type Env } from '../../config/env.schema.js';

/**
 * The PostgreSQL client.
 *
 * This is infrastructure, not domain logic. It is injected **only into
 * repositories** — the ESLint layer rules in `eslint.config.mjs` fail the build
 * if a controller or a service imports it.
 *
 * Composition rather than `extends PrismaClient`: Prisma 7's generated client
 * is a construct-signature interface, not a nominal class, so subclassing it
 * loses the instance types. Wrapping it also means the transaction helpers this
 * service will grow — explicit isolation levels, deterministic lock ordering
 * (NFR-A) — live in one place instead of being re-derived at every call site.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /** The Prisma client. Repositories use this; nothing else may. */
  readonly client: PrismaClient;

  constructor(configService: ConfigService<Env, true>) {
    const connectionString = configService.get('DATABASE_URL', { infer: true });

    // Prisma 7 connects through a driver adapter, which hands us the `pg` pool
    // directly. These settings are deliberate: the transfer path opens short,
    // contended transactions, so the failure mode to avoid is requests queueing
    // on connection acquisition and blowing the p95 budget (NFR-E) while the
    // database itself sits idle.
    const adapter = new PrismaPg({
      connectionString,
      // Sized for a single API instance. Horizontal scaling (NFR-D) multiplies
      // this by the instance count, which is the point at which PgBouncer goes
      // in front of Postgres rather than this number going up.
      max: 20,
      idleTimeoutMillis: 30_000,
      // Fail fast instead of hanging a request forever on an exhausted pool.
      connectionTimeoutMillis: 5_000,
    });

    this.client = new PrismaClient({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
    this.logger.log('PostgreSQL connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
    this.logger.log('PostgreSQL connection closed');
  }
}
