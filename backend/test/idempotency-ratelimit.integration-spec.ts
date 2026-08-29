import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { IdempotencyRepository } from '../src/common/interceptors/idempotency.repository.js';
import { hashRequest } from '../src/common/interceptors/idempotency.interceptor.js';
import { RateLimitRepository } from '../src/common/guards/rate-limit.repository.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * Real PostgreSQL + real Redis.
 *
 * Both mechanisms under test are database/Redis behaviours — a unique-index
 * conflict and an atomic Lua script. Mocking either would test the mock.
 */
describe('Idempotency + rate limiting', () => {
  let database: TestDatabase;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let idempotency: IdempotencyRepository;
  let rateLimit: RateLimitRepository;
  let redisAvailable = false;

  const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';

  beforeAll(async () => {
    database = await startTestDatabase();

    // Skip the Redis suite gracefully if no server is reachable.
    try {
      const probe = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await probe.connect();
      await probe.ping();
      await probe.quit();
      redisAvailable = true;
    } catch {
      redisAvailable = false;
    }

    moduleRef = await Test.createTestingModule({
      providers: [
        PrismaService,
        RedisService,
        IdempotencyRepository,
        RateLimitRepository,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === 'DATABASE_URL' ? database.connectionString : REDIS_URL),
          },
        },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    await prisma.onModuleInit();
    if (redisAvailable) {
      await moduleRef.get(RedisService).onModuleInit();
    }
    idempotency = moduleRef.get(IdempotencyRepository);
    rateLimit = moduleRef.get(RateLimitRepository);
  }, 180_000);

  afterAll(async () => {
    // moduleRef.close() runs the lifecycle hooks, which closes Redis and
    // Prisma; closing them by hand first would double-close.
    await moduleRef?.close();
    await database?.stop();
  });

  let counter = 0;
  async function createUser(): Promise<string> {
    counter += 1;
    const suffix = `${Date.now()}${counter}`;
    const user = await prisma.client.user.create({
      data: {
        email: `idem${suffix}@example.com`,
        phone: `+8801${suffix.slice(-9)}`,
        username: `idem${suffix}`,
        displayName: 'Idem User',
        passwordHash: 'argon2$test',
      },
      select: { id: true },
    });
    return user.id;
  }

  // ===========================================================================
  //  1. Dedupe — a completed key replays instead of re-running
  // ===========================================================================

  it('replays a completed key instead of re-executing', async () => {
    const userId = await createUser();
    const key = randomUUID();
    const hash = hashRequest('POST', 'POST /transfers', { to: 'bob', amountPoisha: '50000' });

    const first = await idempotency.claim({
      userId,
      key,
      operation: 'POST /transfers',
      requestHash: hash,
      ttlMs: 60_000,
    });
    expect(first.outcome).toBe('CLAIMED');

    await idempotency.complete({
      id: first.outcome === 'CLAIMED' ? first.id : '',
      responseStatus: 201,
      responseBody: { reference: 'TXN-ONCE' },
    });

    const second = await idempotency.claim({
      userId,
      key,
      operation: 'POST /transfers',
      requestHash: hash,
      ttlMs: 60_000,
    });

    expect(second.outcome).toBe('EXISTS');
    if (second.outcome === 'EXISTS') {
      expect(second.record.state).toBe('COMPLETED');
      expect(second.record.requestHash).toBe(hash);
      expect(second.record.responseBody).toEqual({ reference: 'TXN-ONCE' });
    }
  });

  // ===========================================================================
  //  2. Mismatch — same key, different body
  // ===========================================================================

  it('surfaces a hash mismatch when a key is reused with a different body', async () => {
    const userId = await createUser();
    const key = randomUUID();

    const original = hashRequest('POST', 'POST /transfers', { to: 'bob', amountPoisha: '5000' });
    const different = hashRequest('POST', 'POST /transfers', { to: 'bob', amountPoisha: '500000' });
    expect(original).not.toBe(different);

    await idempotency.claim({
      userId,
      key,
      operation: 'POST /transfers',
      requestHash: original,
      ttlMs: 60_000,
    });

    const replay = await idempotency.claim({
      userId,
      key,
      operation: 'POST /transfers',
      requestHash: different,
      ttlMs: 60_000,
    });

    // The stored hash differs from the presented one — the interceptor turns
    // this into a 409 rather than serving the original response.
    expect(replay.outcome).toBe('EXISTS');
    if (replay.outcome === 'EXISTS') {
      expect(replay.record.requestHash).toBe(original);
      expect(replay.record.requestHash).not.toBe(different);
    }
  });

  it('treats key order in the body as irrelevant', () => {
    // An honest client that serialises the same request with different key
    // order must not be told it has a conflict.
    const a = hashRequest('POST', 'POST /transfers', { to: 'bob', amountPoisha: '5000' });
    const b = hashRequest('POST', 'POST /transfers', { amountPoisha: '5000', to: 'bob' });
    expect(a).toBe(b);

    // Nested too.
    const c = hashRequest('POST', '/x', { outer: { z: 1, a: 2 } });
    const d = hashRequest('POST', '/x', { outer: { a: 2, z: 1 } });
    expect(c).toBe(d);

    // Array order still matters — [1,2] is genuinely not [2,1].
    expect(hashRequest('POST', '/x', { xs: [1, 2] })).not.toBe(
      hashRequest('POST', '/x', { xs: [2, 1] }),
    );
  });

  // ===========================================================================
  //  3. Concurrent race — duplicates arriving before either completes
  // ===========================================================================

  it('lets exactly one of 20 simultaneous duplicates claim the key', async () => {
    const userId = await createUser();
    const key = randomUUID();
    const hash = hashRequest('POST', 'POST /transfers', { to: 'carol', amountPoisha: '25000' });

    // All 20 fire before any completes — the case a check-then-insert would
    // get wrong, and the one the prompt asks to be tested.
    const results = await Promise.all(
      Array.from(
        { length: 20 },
        async () =>
          await idempotency.claim({
            userId,
            key,
            operation: 'POST /transfers',
            requestHash: hash,
            ttlMs: 60_000,
          }),
      ),
    );

    const claimed = results.filter((r) => r.outcome === 'CLAIMED');
    const existed = results.filter((r) => r.outcome === 'EXISTS');

    expect(claimed).toHaveLength(1);
    expect(existed).toHaveLength(19);

    // The 19 losers all saw the winner's IN_PROGRESS record — the interceptor
    // answers them 409 rather than guessing an outcome.
    for (const loser of existed) {
      if (loser.outcome === 'EXISTS') {
        expect(loser.record.state).toBe('IN_PROGRESS');
        expect(loser.record.requestHash).toBe(hash);
      }
    }

    const rows = await prisma.client.idempotencyKey.count({ where: { userId, key } });
    expect(rows).toBe(1);
  }, 60_000);

  it('releases the key when the handler fails, so a retry can run', async () => {
    const userId = await createUser();
    const key = randomUUID();
    const hash = hashRequest('POST', '/x', { a: 1 });

    const first = await idempotency.claim({
      userId,
      key,
      operation: '/x',
      requestHash: hash,
      ttlMs: 60_000,
    });
    expect(first.outcome).toBe('CLAIMED');

    await idempotency.release(first.outcome === 'CLAIMED' ? first.id : '');

    // A failed request produced no durable effect, so an identical retry is
    // allowed rather than being pinned to the failure forever.
    const retry = await idempotency.claim({
      userId,
      key,
      operation: '/x',
      requestHash: hash,
      ttlMs: 60_000,
    });
    expect(retry.outcome).toBe('CLAIMED');
  });

  // ===========================================================================
  //  4. Rate limit trips
  // ===========================================================================

  it('trips the token bucket after the burst is spent', async () => {
    if (!redisAvailable) {
      console.warn('Redis unavailable — skipping rate-limit assertions');
      return;
    }

    const bucketKey = `ratelimit:test:${randomUUID()}`;
    const opts = { bucketKey, capacity: 5, refillPerSecond: 0.05 };

    const outcomes = [];
    for (let i = 0; i < 7; i += 1) {
      outcomes.push(await rateLimit.consume(opts));
    }

    // 5 tokens in the bucket → first 5 pass, the rest are refused.
    expect(outcomes.slice(0, 5).every((r) => r.allowed)).toBe(true);
    expect(outcomes.slice(5).every((r) => !r.allowed)).toBe(true);

    const refused = outcomes[5];
    expect(refused?.retryAfterMs).toBeGreaterThan(0);
    expect(refused?.remaining).toBe(0);
  });

  it('holds the limit under concurrent requests', async () => {
    if (!redisAvailable) return;

    const bucketKey = `ratelimit:test:${randomUUID()}`;
    // Fired simultaneously: the Lua script's atomicity is the whole point. A
    // read-modify-write in Node would let far more than 5 through here.
    const results = await Promise.all(
      Array.from(
        { length: 40 },
        async () => await rateLimit.consume({ bucketKey, capacity: 5, refillPerSecond: 0.05 }),
      ),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.filter((r) => !r.allowed)).toHaveLength(35);
  });

  it('refills over time', async () => {
    if (!redisAvailable) return;

    const bucketKey = `ratelimit:test:${randomUUID()}`;
    // 10 tokens/second → one token back every 100ms.
    const opts = { bucketKey, capacity: 2, refillPerSecond: 10 };

    expect((await rateLimit.consume(opts)).allowed).toBe(true);
    expect((await rateLimit.consume(opts)).allowed).toBe(true);
    expect((await rateLimit.consume(opts)).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await rateLimit.consume(opts)).allowed).toBe(true);
  });

  it('keeps separate buckets separate', async () => {
    if (!redisAvailable) return;

    const a = `ratelimit:test:${randomUUID()}`;
    const b = `ratelimit:test:${randomUUID()}`;
    const opts = { capacity: 1, refillPerSecond: 0.01 };

    expect((await rateLimit.consume({ ...opts, bucketKey: a })).allowed).toBe(true);
    expect((await rateLimit.consume({ ...opts, bucketKey: a })).allowed).toBe(false);
    // Exhausting one user's bucket must not affect anyone else's.
    expect((await rateLimit.consume({ ...opts, bucketKey: b })).allowed).toBe(true);
  });
});
