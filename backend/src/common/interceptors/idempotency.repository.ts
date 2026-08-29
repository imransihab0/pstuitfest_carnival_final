import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

export interface IdempotencyRecord {
  id: string;
  requestHash: string;
  state: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  responseStatus: number | null;
  responseBody: unknown;
}

export type ClaimResult =
  | { readonly outcome: 'CLAIMED'; readonly id: string }
  /** Someone else already holds this key. Their record is attached. */
  | { readonly outcome: 'EXISTS'; readonly record: IdempotencyRecord };

/**
 * Persistence for the idempotency interceptor.
 *
 * Repositories are the only layer permitted to invoke Prisma, so the
 * interceptor delegates here rather than holding a client of its own.
 */
@Injectable()
export class IdempotencyRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Attempts to claim a key, atomically.
   *
   * `INSERT ... ON CONFLICT DO NOTHING` is the whole mechanism: exactly one
   * concurrent caller inserts a row, and everyone else conflicts. A
   * "SELECT then INSERT if absent" sequence would be a race — two requests can
   * both find nothing and both proceed, which is precisely the double-spend
   * this interceptor exists to prevent.
   *
   * The loser reads back the winner's row in the same round trip.
   */
  async claim(params: {
    userId: string;
    key: string;
    operation: string;
    requestHash: string;
    ttlMs: number;
  }): Promise<ClaimResult> {
    const expiresAt = new Date(Date.now() + params.ttlMs);

    const inserted = await this.prisma.client.$queryRaw<{ id: string }[]>`
      INSERT INTO "idempotency_keys"
        ("id", "key", "user_id", "operation", "request_hash", "state", "created_at", "updated_at", "expires_at")
      VALUES
        (gen_random_uuid(), ${params.key}, ${params.userId}::uuid, ${params.operation},
         ${params.requestHash}, 'IN_PROGRESS', now(), now(), ${expiresAt})
      ON CONFLICT ("user_id", "key") DO NOTHING
      RETURNING "id"
    `;

    const row = inserted[0];
    if (row !== undefined) {
      return { outcome: 'CLAIMED', id: row.id };
    }

    const existing = await this.find(params.userId, params.key);
    if (existing === null) {
      // The row vanished between the conflict and this read — the holder rolled
      // back. Treat as claimable; the caller retries.
      return await this.claim(params);
    }
    return { outcome: 'EXISTS', record: existing };
  }

  async find(userId: string, key: string): Promise<IdempotencyRecord | null> {
    const row = await this.prisma.client.idempotencyKey.findUnique({
      where: { userId_key: { userId, key } },
      select: {
        id: true,
        requestHash: true,
        state: true,
        responseStatus: true,
        responseBody: true,
      },
    });
    if (row === null) return null;
    return {
      id: row.id,
      requestHash: row.requestHash,
      state: row.state,
      responseStatus: row.responseStatus,
      responseBody: row.responseBody,
    };
  }

  /** Stores the response so a later retry can be answered without re-running. */
  async complete(params: {
    id: string;
    responseStatus: number;
    responseBody: unknown;
  }): Promise<void> {
    await this.prisma.client.idempotencyKey.update({
      where: { id: params.id },
      data: {
        state: 'COMPLETED',
        responseStatus: params.responseStatus,
        responseBody: params.responseBody as never,
      },
    });
  }

  /**
   * Releases a claim after the handler threw.
   *
   * Deleted rather than marked FAILED: a failed request has produced no
   * durable effect, so the honest behaviour is to let an identical retry run
   * again. Keeping the row would pin the key to a failure forever and force the
   * client to invent a new one to recover.
   */
  async release(id: string): Promise<void> {
    await this.prisma.client.idempotencyKey.delete({ where: { id } }).catch(() => undefined);
  }
}
