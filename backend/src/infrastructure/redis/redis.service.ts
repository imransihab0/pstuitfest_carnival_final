import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { type Env } from '../../config/env.schema.js';

/**
 * The Redis client.
 *
 * Reserved for cache, rate limiting and — per NFR-D — pub/sub fan-out of
 * realtime notifications once more than one API instance is running. Like
 * {@link PrismaService} this is infrastructure and is injected only into
 * repositories.
 *
 * Redis is explicitly **not** part of the money path: no balance, ledger entry
 * or idempotency record is ever authoritative in Redis. Losing the cache
 * entirely must never change a balance.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(configService: ConfigService<Env, true>) {
    const url = configService.get('REDIS_URL', { infer: true });

    this.client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });

    this.client.on('error', (error: Error) => {
      // Logged rather than thrown: a cache outage degrades the service, it does
      // not make it incorrect.
      this.logger.error(`Redis client error: ${error.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    this.logger.log('Redis connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
    this.logger.log('Redis connection closed');
  }

  /** Raw client, for repositories that need commands not wrapped here. */
  getClient(): Redis {
    return this.client;
  }

  /** Liveness probe. Returns the server's `PONG`. */
  async ping(): Promise<string> {
    return await this.client.ping();
  }
}
