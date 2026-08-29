import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { generateReference } from '../../common/reference.js';

/** Row shape shared by the dashboard and history endpoints. */
export interface ActivityRow {
  id: string;
  reference: string;
  amount_poisha: string;
  direction: 'CREDIT' | 'DEBIT';
  counterparty_name: string;
  note: string | null;
  status: string;
  created_at: Date;
}

export interface UserSearchRow {
  id: string;
  name: string;
  email: string;
}

export interface MoneyRequestRow {
  id: string;
  amount_poisha: string;
  note: string | null;
  status: string;
  created_at: Date;
  requester_id: string;
  requester_name: string;
  requester_email: string;
  requestee_id: string;
  requestee_name: string;
  requestee_email: string;
}

export type AcceptRequestOutcome =
  | { ok: true; reference: string; balancePoisha: bigint }
  | { ok: false; reason: 'NOT_FOUND' | 'NOT_PENDING' | 'NOT_YOURS' | 'INSUFFICIENT_FUNDS' };

@Injectable()
export class WalletRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAccountByUserId(userId: string): Promise<{ id: string; balancePoisha: bigint } | null> {
    const rows = await this.prisma.client.$queryRaw<{ id: string; balance: string }[]>`
      SELECT "id", "balance_poisha"::text AS balance
      FROM "accounts" WHERE "user_id" = ${userId}::uuid LIMIT 1
    `;
    const row = rows[0];
    return row === undefined ? null : { id: row.id, balancePoisha: BigInt(row.balance) };
  }

  /**
   * Transaction history for one account, newest first.
   *
   * Keyset pagination on `(created_at, id)` rather than OFFSET: an OFFSET scan
   * re-reads and discards every skipped row, so page 500 costs 500 pages of
   * work. With ten million users that is the difference between a fast endpoint
   * and one that degrades as history grows (NFR-D). The composite index
   * `(account_id, created_at DESC, id DESC)` serves this directly.
   *
   * `direction` is computed per row: the same transaction is a DEBIT to its
   * sender and a CREDIT to its receiver, so it depends on who is asking.
   */
  async listActivity(params: {
    accountId: string;
    limit: number;
    cursorCreatedAt?: Date | undefined;
    cursorId?: string | undefined;
    direction?: 'CREDIT' | 'DEBIT' | undefined;
    status?: string | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
  }): Promise<ActivityRow[]> {
    const {
      accountId,
      limit,
      cursorCreatedAt = null,
      cursorId = null,
      direction = null,
      status = null,
      from = null,
      to = null,
    } = params;

    return await this.prisma.client.$queryRaw<ActivityRow[]>`
      SELECT
        t."id",
        t."reference",
        t."amount_poisha"::text AS amount_poisha,
        CASE WHEN t."sender_account_id" = ${accountId}::uuid THEN 'DEBIT' ELSE 'CREDIT' END AS direction,
        COALESCE(
          CASE WHEN t."sender_account_id" = ${accountId}::uuid
               THEN receiver_user."display_name"
               ELSE sender_user."display_name" END,
          'PSTU Money'
        ) AS counterparty_name,
        t."note",
        t."status"::text AS status,
        t."created_at"
      FROM "transactions" t
      LEFT JOIN "accounts" sender_account   ON sender_account."id"   = t."sender_account_id"
      LEFT JOIN "users"    sender_user      ON sender_user."id"      = sender_account."user_id"
      LEFT JOIN "accounts" receiver_account ON receiver_account."id" = t."receiver_account_id"
      LEFT JOIN "users"    receiver_user    ON receiver_user."id"    = receiver_account."user_id"
      WHERE (t."sender_account_id" = ${accountId}::uuid OR t."receiver_account_id" = ${accountId}::uuid)
        AND (${status}::text IS NULL OR t."status"::text = ${status}::text)
        AND (${from}::timestamptz IS NULL OR t."created_at" >= ${from}::timestamptz)
        AND (${to}::timestamptz   IS NULL OR t."created_at" <= ${to}::timestamptz)
        AND (
          ${direction}::text IS NULL
          OR (${direction}::text = 'DEBIT'  AND t."sender_account_id"   = ${accountId}::uuid)
          OR (${direction}::text = 'CREDIT' AND t."receiver_account_id" = ${accountId}::uuid)
        )
        AND (
          ${cursorCreatedAt}::timestamptz IS NULL
          OR (t."created_at", t."id") < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
        )
      ORDER BY t."created_at" DESC, t."id" DESC
      LIMIT ${limit}
    `;
  }

  /**
   * User search (FR-05).
   *
   * Excludes the caller — offering to send money to yourself is a dead end the
   * transfer path would reject anyway.
   */
  async searchUsers(query: string, excludeUserId: string, limit = 10): Promise<UserSearchRow[]> {
    const like = `%${query.toLowerCase()}%`;
    return await this.prisma.client.$queryRaw<UserSearchRow[]>`
      SELECT u."id", u."display_name" AS name, u."email"
      FROM "users" u
      WHERE u."status" = 'ACTIVE'
        AND u."id" <> ${excludeUserId}::uuid
        AND (
          lower(u."username") LIKE ${like}
          OR lower(u."email") LIKE ${like}
          OR lower(u."display_name") LIKE ${like}
          OR u."phone" LIKE ${like}
        )
      ORDER BY u."display_name"
      LIMIT ${limit}
    `;
  }

  async listMoneyRequests(userId: string): Promise<MoneyRequestRow[]> {
    return await this.prisma.client.$queryRaw<MoneyRequestRow[]>`
      SELECT
        mr."id",
        mr."amount_poisha"::text AS amount_poisha,
        mr."note",
        mr."status"::text AS status,
        mr."created_at",
        requester."id"           AS requester_id,
        requester."display_name" AS requester_name,
        requester."email"        AS requester_email,
        requestee."id"           AS requestee_id,
        requestee."display_name" AS requestee_name,
        requestee."email"        AS requestee_email
      FROM "money_requests" mr
      JOIN "users" requester ON requester."id" = mr."requester_id"
      JOIN "users" requestee ON requestee."id" = mr."requestee_id"
      WHERE mr."requester_id" = ${userId}::uuid OR mr."requestee_id" = ${userId}::uuid
      ORDER BY mr."created_at" DESC
      LIMIT 100
    `;
  }

  async createMoneyRequest(params: {
    requesterId: string;
    requesteeId: string;
    amountPoisha: bigint;
    note?: string | undefined;
  }): Promise<{ id: string }> {
    return await this.prisma.client.moneyRequest.create({
      data: {
        reference: generateReference('REQ'),
        requesterId: params.requesterId,
        requesteeId: params.requesteeId,
        amountPoisha: params.amountPoisha,
        note: params.note ?? null,
        status: 'PENDING',
      },
      select: { id: true },
    });
  }

  async rejectMoneyRequest(
    requestId: string,
    requesteeId: string,
  ): Promise<'REJECTED' | 'NOT_FOUND' | 'NOT_PENDING'> {
    // Guarded by status so a double-click cannot transition an already-settled
    // request.
    const updated = await this.prisma.client.moneyRequest.updateMany({
      where: { id: requestId, requesteeId, status: 'PENDING' },
      data: { status: 'REJECTED', respondedAt: new Date() },
    });
    if (updated.count === 1) return 'REJECTED';

    const exists = await this.prisma.client.moneyRequest.findUnique({
      where: { id: requestId },
      select: { id: true },
    });
    return exists === null ? 'NOT_FOUND' : 'NOT_PENDING';
  }

  /**
   * Settles a money request: moves the money AND flips the request to ACCEPTED,
   * in **one** database transaction.
   *
   * The two must commit together. If the transfer committed and the status
   * update did not, the money would move and the request would still read
   * PENDING — so it could be accepted again. The `chk_money_requests_settlement_shape`
   * CHECK constraint enforces the same pairing at the database level.
   *
   * The status guard (`WHERE status = 'PENDING'`) is what makes a double-click
   * safe: the second attempt matches zero rows and aborts before any balance
   * moves.
   *
   * Balance rows are written in ascending account-UUID order, the same
   * discipline as the transfer path, so concurrent settlements cannot deadlock
   * against ordinary transfers.
   */
  async acceptMoneyRequest(params: {
    requestId: string;
    requesteeUserId: string;
  }): Promise<AcceptRequestOutcome> {
    const { requestId, requesteeUserId } = params;

    try {
      return await this.prisma.client.$transaction(
        async (tx): Promise<AcceptRequestOutcome> => {
          const claimed = await tx.$queryRaw<
            { amount_poisha: string; requester_id: string; requestee_id: string }[]
          >`
            UPDATE "money_requests"
               SET "status" = 'ACCEPTED', "responded_at" = now()
             WHERE "id" = ${requestId}::uuid
               AND "requestee_id" = ${requesteeUserId}::uuid
               AND "status" = 'PENDING'
            RETURNING "amount_poisha"::text AS amount_poisha,
                      "requester_id", "requestee_id"
          `;
          const request = claimed[0];
          if (request === undefined) {
            throw new SettlementAbort('NOT_PENDING');
          }

          const amount = BigInt(request.amount_poisha);

          const accounts = await tx.$queryRaw<{ id: string; user_id: string }[]>`
            SELECT "id", "user_id" FROM "accounts"
            WHERE "user_id" IN (${request.requester_id}::uuid, ${request.requestee_id}::uuid)
          `;
          const payer = accounts.find((a) => a.user_id === request.requestee_id);
          const payee = accounts.find((a) => a.user_id === request.requester_id);
          if (payer === undefined || payee === undefined) {
            throw new SettlementAbort('NOT_FOUND');
          }

          const debit = async (): Promise<bigint> => {
            const rows = await tx.$queryRaw<{ balance_poisha: string }[]>`
              UPDATE "accounts"
                 SET "balance_poisha" = "balance_poisha" - ${amount}::bigint, "updated_at" = now()
               WHERE "id" = ${payer.id}::uuid AND "status" = 'ACTIVE'
                 AND "balance_poisha" >= ${amount}::bigint
              RETURNING "balance_poisha"::text AS balance_poisha
            `;
            const row = rows[0];
            if (row === undefined) throw new SettlementAbort('INSUFFICIENT_FUNDS');
            return BigInt(row.balance_poisha);
          };
          const credit = async (): Promise<bigint> => {
            const rows = await tx.$queryRaw<{ balance_poisha: string }[]>`
              UPDATE "accounts"
                 SET "balance_poisha" = "balance_poisha" + ${amount}::bigint, "updated_at" = now()
               WHERE "id" = ${payee.id}::uuid AND "status" = 'ACTIVE'
              RETURNING "balance_poisha"::text AS balance_poisha
            `;
            const row = rows[0];
            if (row === undefined) throw new SettlementAbort('NOT_FOUND');
            return BigInt(row.balance_poisha);
          };

          let payerAfter: bigint;
          let payeeAfter: bigint;
          if (payer.id < payee.id) {
            payerAfter = await debit();
            payeeAfter = await credit();
          } else {
            payeeAfter = await credit();
            payerAfter = await debit();
          }

          const reference = generateReference('TXN');
          const transaction = await tx.transaction.create({
            data: {
              reference,
              type: 'TRANSFER',
              status: 'SUCCESS',
              amountPoisha: amount,
              senderAccountId: payer.id,
              receiverAccountId: payee.id,
              note: 'Money request settled',
              completedAt: new Date(),
            },
            select: { id: true },
          });

          await tx.ledgerEntry.createMany({
            data: [
              {
                transactionId: transaction.id,
                accountId: payer.id,
                direction: 'DEBIT',
                amountPoisha: amount,
                balanceAfterPoisha: payerAfter,
              },
              {
                transactionId: transaction.id,
                accountId: payee.id,
                direction: 'CREDIT',
                amountPoisha: amount,
                balanceAfterPoisha: payeeAfter,
              },
            ],
          });

          // Links the request to the transfer that settled it. The CHECK
          // constraint requires this for any ACCEPTED row.
          await tx.moneyRequest.update({
            where: { id: requestId },
            data: { settledTransactionId: transaction.id },
          });

          return { ok: true, reference, balancePoisha: payerAfter };
        },
        { isolationLevel: 'ReadCommitted', timeout: 10_000, maxWait: 10_000 },
      );
    } catch (error) {
      if (error instanceof SettlementAbort) {
        return { ok: false, reason: error.reason };
      }
      throw error;
    }
  }
}

class SettlementAbort extends Error {
  constructor(readonly reason: 'NOT_FOUND' | 'NOT_PENDING' | 'NOT_YOURS' | 'INSUFFICIENT_FUNDS') {
    super(reason);
  }
}
