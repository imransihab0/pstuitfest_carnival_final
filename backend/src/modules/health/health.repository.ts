import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { type DependencyHealth } from './dto/health-response.dto.js';

/**
 * The repository layer — the **only** layer permitted to invoke Prisma or the
 * Redis client. See the layer rules in `eslint.config.mjs`.
 *
 * Probes never throw: a dependency being down is a value the service layer
 * reasons about, not an exception it has to catch.
 */
@Injectable()
export class HealthRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Round-trips the cheapest possible statement to PostgreSQL. */
  async pingDatabase(): Promise<DependencyHealth> {
    return await this.probe(async () => {
      await this.prisma.client.$queryRaw`SELECT 1`;
    });
  }

  /** Round-trips a `PING` to Redis. */
  async pingCache(): Promise<DependencyHealth> {
    return await this.probe(async () => {
      await this.redis.ping();
    });
  }

  private async probe(run: () => Promise<void>): Promise<DependencyHealth> {
    const startedAt = process.hrtime.bigint();

    try {
      await run();
      return { status: 'up', latencyMs: this.elapsedMs(startedAt) };
    } catch (error) {
      return {
        status: 'down',
        latencyMs: this.elapsedMs(startedAt),
        // Message only — never the stack, the query, or the connection string.
        error: error instanceof Error ? error.message : 'unknown error',
      };
    }
  }

  private elapsedMs(startedAt: bigint): number {
    const elapsedNs = process.hrtime.bigint() - startedAt;
    return Number(elapsedNs / 1_000n) / 1_000;
  }
}
