import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request, type Response } from 'express';
import { RateLimitRepository } from './rate-limit.repository.js';

export interface RateLimitOptions {
  /** Bucket size — the largest burst allowed. */
  readonly capacity: number;
  /** Sustained rate, tokens per second. */
  readonly refillPerSecond: number;
  /** Namespace, so unrelated routes never share a bucket. */
  readonly scope: string;
  /**
   * What to count against.
   *   'ip'        — anonymous routes (login: the attacker chooses the username)
   *   'user'      — authenticated routes
   *   'user+ip'   — both must have budget
   *   'identifier'— a field in the body, e.g. the account being logged into
   */
  readonly by?: 'ip' | 'user' | 'user+ip' | 'identifier';
  /** Body field for `by: 'identifier'`. */
  readonly identifierField?: string;
}

export const RATE_LIMIT_KEY = 'rate_limit';

type RateLimitedRequest = Request & { user?: { sub?: string } | undefined };

/**
 * Applies a token bucket to a route.
 *
 * @example
 *   \@RateLimit({ scope: 'auth:login', capacity: 5, refillPerSecond: 0.1, by: 'ip' })
 */
export const RateLimit = (options: RateLimitOptions): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_KEY, options);

/**
 * Preset for credential checks — login and PIN verification.
 *
 * 5 attempts, refilling at one per 20 seconds (0.05/s). Tuned so a person who
 * mistypes a password three times notices nothing, while an attacker gets ~3
 * guesses a minute sustained — useless for brute force against even a weak PIN,
 * and combined with Argon2id on the server side, thoroughly so.
 */
export const CREDENTIAL_RATE_LIMIT: RateLimitOptions = {
  scope: 'auth:credentials',
  capacity: 5,
  refillPerSecond: 0.05,
  by: 'user+ip',
};

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly repository: RateLimitRepository,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (options === undefined) return true;

    const request = context.switchToHttp().getRequest<RateLimitedRequest>();
    const response = context.switchToHttp().getResponse<Response>();

    const bucketKey = `ratelimit:${options.scope}:${this.subjectOf(options, request)}`;

    const result = await this.repository.consume({
      bucketKey,
      capacity: options.capacity,
      refillPerSecond: options.refillPerSecond,
    });

    response.setHeader('RateLimit-Limit', options.capacity);
    response.setHeader('RateLimit-Remaining', Math.max(0, result.remaining));

    if (!result.allowed) {
      const retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
      response.setHeader('Retry-After', retryAfterSeconds);
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: `Too many attempts. Try again in ${retryAfterSeconds}s.`,
          retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  /**
   * Derives the bucket subject.
   *
   * For credential routes this is user+IP rather than IP alone: bucketing only
   * by IP lets one attacker behind a shared NAT lock out every legitimate user
   * on that address, and bucketing only by username lets a distributed attacker
   * spread guesses across IPs freely. Requiring both to have budget closes the
   * first hole without opening the second.
   */
  private subjectOf(options: RateLimitOptions, request: RateLimitedRequest): string {
    const ip = request.ip ?? request.socket?.remoteAddress ?? 'unknown-ip';
    const userId = request.user?.sub;

    switch (options.by ?? 'ip') {
      case 'ip':
        return `ip:${ip}`;
      case 'user':
        return `user:${userId ?? `anon:${ip}`}`;
      case 'identifier': {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const field = options.identifierField ?? 'identifier';
        const value = body[field];
        const identifier =
          typeof value === 'string' && value.length > 0 ? value.toLowerCase() : `anon:${ip}`;
        return `id:${identifier}`;
      }
      case 'user+ip':
      default: {
        if (userId !== undefined) return `user:${userId}`;
        // Unauthenticated (login): fall back to the submitted identifier plus
        // the IP, so guessing one account from many IPs and many accounts from
        // one IP are both limited.
        const body = (request.body ?? {}) as Record<string, unknown>;
        const raw = body['identifier'] ?? body['email'] ?? body['username'];
        const identifier = typeof raw === 'string' ? raw.toLowerCase() : 'unknown';
        return `ip:${ip}|id:${identifier}`;
      }
    }
  }
}
