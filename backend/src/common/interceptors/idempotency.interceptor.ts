import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
  SetMetadata,
  HttpException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { Observable, from, of, switchMap } from 'rxjs';
import { IdempotencyRepository } from './idempotency.repository.js';

/** Marks a route as requiring idempotent handling. */
export const IDEMPOTENT_KEY = 'idempotent';
export const Idempotent = (): MethodDecorator => SetMetadata(IDEMPOTENT_KEY, true);

/** How long a stored response stays replayable. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Canonical JSON: object keys sorted recursively.
 *
 * `{a:1,b:2}` and `{b:2,a:1}` are the same request, and an honest client that
 * happens to serialise them differently must not be told it has a conflict.
 * Arrays keep their order — `[1,2]` genuinely is not `[2,1]`.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalise((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  // bigint has no JSON representation; render it the way the API does.
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * Fingerprint of the request: method + route + canonical body.
 *
 * The route is included so one key cannot be reused across different
 * operations, and the body so that a key replayed with different content is
 * detectable rather than silently served the original response.
 */
export function hashRequest(method: string, route: string, body: unknown): string {
  const canonical = JSON.stringify({ method, route, body: canonicalise(body) });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Makes mutating money-movement routes safe to retry (NFR-B).
 *
 * The contract:
 *
 *   miss                      → claim the key, run the handler, store the response
 *   hit + matching hash + done→ replay the stored response, do not re-run
 *   hit + matching hash + busy→ 409, the original is still in flight
 *   hit + different hash      → 409, the client reused a key for a new request
 *
 * The guarantee comes from the `UNIQUE (user_id, key)` index, not from the
 * lookup: two duplicates arriving simultaneously both attempt the insert, and
 * the database decides which one wins. A check-then-insert would let both
 * proceed.
 *
 * Note this is HTTP-level protection. `TransferService` performs the same
 * deduplication *inside* its database transaction, which is what actually makes
 * the money movement exactly-once. This interceptor spares the work and gives a
 * consistent response; it is not the sole line of defence, and removing the
 * service-level check would not be safe just because this exists.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly repository: IdempotencyRepository,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isIdempotent = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isIdempotent !== true) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request & { user?: { sub?: string } }>();
    const response = context.switchToHttp().getResponse<Response>();

    const key = request.header('Idempotency-Key');
    const userId = request.user?.sub;

    // Unauthenticated or unkeyed requests are not this interceptor's business.
    // The route's auth guard handles the former; the latter is a client that
    // opted out of retry safety, which the route's own DTO validation may
    // reject if the key is mandatory.
    if (key === undefined || key === '' || userId === undefined) {
      return next.handle();
    }

    const route = `${request.method} ${(request.route as { path?: string } | undefined)?.path ?? request.path}`;
    const requestHash = hashRequest(request.method, route, request.body);

    return from(this.claimAndRun(userId, key, route, requestHash, response, next));
  }

  private async claimAndRun(
    userId: string,
    key: string,
    operation: string,
    requestHash: string,
    response: Response,
    next: CallHandler,
  ): Promise<unknown> {
    const claim = await this.repository.claim({
      userId,
      key,
      operation,
      requestHash,
      ttlMs: DEFAULT_TTL_MS,
    });

    if (claim.outcome === 'EXISTS') {
      return this.replay(claim.record, requestHash, response);
    }

    try {
      const body = await firstValueOf(next.handle());
      await this.repository.complete({
        id: claim.id,
        responseStatus: response.statusCode,
        responseBody: serialiseForStorage(body),
      });
      return body;
    } catch (error) {
      // The handler failed and produced no durable effect, so the key is
      // released and an identical retry is allowed to run. Pinning the key to a
      // failure would force the client to mint a new one just to recover.
      await this.repository.release(claim.id);
      throw error;
    }
  }

  private replay(
    record: {
      requestHash: string;
      state: string;
      responseStatus: number | null;
      responseBody: unknown;
    },
    requestHash: string,
    response: Response,
  ): unknown {
    if (record.requestHash !== requestHash) {
      // Serving the stored response here would let a user believe their ৳500
      // transfer succeeded when the stored one was ৳50.
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message:
          'This Idempotency-Key was already used with a different request. ' +
          'Use a new key for a new operation.',
      });
    }

    if (record.state !== 'COMPLETED') {
      // The original is still running. Answering now would mean guessing its
      // outcome; 409 tells the client to retry rather than inventing a result.
      throw new ConflictException({
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message: 'A request with this Idempotency-Key is still being processed. Retry shortly.',
      });
    }

    this.logger.debug(`Replaying stored response for key (hash ${requestHash.slice(0, 8)})`);
    response.status(record.responseStatus ?? 200);
    response.setHeader('Idempotent-Replay', 'true');
    return record.responseBody;
  }
}

/** Reads the single value an HTTP handler observable emits. */
function firstValueOf(source: Observable<unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    source.subscribe({
      next: (value) => {
        settled = true;
        resolve(value);
      },
      error: reject,
      complete: () => {
        if (!settled) resolve(undefined);
      },
    });
  });
}

/**
 * Prepares a handler result for storage as JSON.
 *
 * `bigint` becomes a string rather than a JSON number, because a JSON number is
 * a double — storing a balance as one would reintroduce exactly the float
 * problem the rest of the system is built to avoid (NFR-C).
 */
function serialiseForStorage(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as unknown;
}

/** Re-exported so route handlers can throw the same shape. */
export { ConflictException, HttpException, of, switchMap };
