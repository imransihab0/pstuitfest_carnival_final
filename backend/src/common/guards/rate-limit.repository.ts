import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../infrastructure/redis/redis.service.js';

export interface TokenBucketResult {
  readonly allowed: boolean;
  /** Whole tokens left after this attempt. */
  readonly remaining: number;
  /** Milliseconds until at least one token is available. 0 when allowed. */
  readonly retryAfterMs: number;
}

/**
 * Token-bucket rate limiter, evaluated inside Redis.
 *
 * The whole decision — read state, refill by elapsed time, test, consume, write
 * back, set TTL — runs as one Lua script. Redis executes scripts atomically, so
 * concurrent requests for the same bucket cannot interleave between the read
 * and the write. Doing the same arithmetic in Node with GET/SET around it would
 * be a read-modify-write race, and a rate limiter that can be beaten by
 * concurrency is not a rate limiter: it is exactly the burst case that matters.
 *
 * A token bucket rather than a fixed window because a fixed window lets a
 * client spend its whole quota at the end of one window and again at the start
 * of the next — double the intended rate, right at the boundary. The bucket
 * refills continuously, so the limit holds across any interval.
 *
 * Refill is computed from stored timestamps, never from a timer, so the limiter
 * is correct across process restarts and identical on every API instance
 * (NFR-D) — the state lives in Redis, not in memory.
 */
const TOKEN_BUCKET_SCRIPT = `
local key        = KEYS[1]
local capacity   = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])   -- tokens per millisecond
local nowMs      = tonumber(ARGV[3])
local cost       = tonumber(ARGV[4])
local ttlMs      = tonumber(ARGV[5])

local state    = redis.call('HMGET', key, 'tokens', 'updatedAt')
local tokens   = tonumber(state[1])
local updated  = tonumber(state[2])

if tokens == nil then
  tokens  = capacity
  updated = nowMs
end

-- Refill for elapsed time, capped at capacity.
local elapsed = math.max(0, nowMs - updated)
tokens = math.min(capacity, tokens + (elapsed * refillRate))

local allowed = 0
local retryAfterMs = 0

if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
else
  -- How long until the shortfall is refilled.
  retryAfterMs = math.ceil((cost - tokens) / refillRate)
end

redis.call('HSET', key, 'tokens', tokens, 'updatedAt', nowMs)
redis.call('PEXPIRE', key, ttlMs)

return { allowed, math.floor(tokens), retryAfterMs }
`;

@Injectable()
export class RateLimitRepository {
  private readonly logger = new Logger(RateLimitRepository.name);

  constructor(private readonly redis: RedisService) {}

  async consume(params: {
    bucketKey: string;
    capacity: number;
    refillPerSecond: number;
    cost?: number;
  }): Promise<TokenBucketResult> {
    const cost = params.cost ?? 1;
    const refillRatePerMs = params.refillPerSecond / 1000;
    // Keep the key alive well past a full refill so a returning client is not
    // handed a fresh full bucket the instant their old one expires.
    const ttlMs = Math.ceil((params.capacity / refillRatePerMs) * 2) + 60_000;

    try {
      const raw = (await this.redis
        .getClient()
        .eval(
          TOKEN_BUCKET_SCRIPT,
          1,
          params.bucketKey,
          String(params.capacity),
          String(refillRatePerMs),
          String(Date.now()),
          String(cost),
          String(ttlMs),
        )) as [number, number, number];

      return {
        allowed: raw[0] === 1,
        remaining: raw[1],
        retryAfterMs: raw[2],
      };
    } catch (error) {
      // Fail OPEN, deliberately.
      //
      // Redis holds no authoritative money state. If it is unreachable, the
      // choice is between rejecting every login attempt in the system and
      // temporarily losing brute-force protection. Locking every user out of a
      // working wallet is the larger harm, and the money path has its own
      // guards. This is logged loudly so the outage is visible rather than
      // silently tolerated.
      this.logger.error(
        `Rate limiter unavailable, failing open: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return { allowed: true, remaining: -1, retryAfterMs: 0 };
    }
  }

  /** Clears a bucket. Used after a successful login so one bad password does not linger. */
  async reset(bucketKey: string): Promise<void> {
    try {
      await this.redis.getClient().del(bucketKey);
    } catch {
      // Best effort; the bucket expires on its own.
    }
  }
}
