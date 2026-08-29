import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { generateReference } from '../../common/reference.js';
import {
  type CreateSplitCommand,
  type CreateSplitResult,
  type PayShareFailureReason,
  type PayShareResult,
} from './dto/bill-split.types.js';

export interface BillSplitRow {
  id: string;
  reference: string;
  total_amount_poisha: string;
  description: string | null;
  status: string;
  created_at: Date;
  settled_at: Date | null;
  creator_id: string;
  creator_name: string;
  creator_email: string;
}

export interface BillSplitShareRow {
  id: string;
  bill_split_id: string;
  amount_poisha: string;
  status: string;
  created_at: Date;
  paid_at: Date | null;
  payer_id: string;
  payer_name: string;
  payer_email: string;
}

/** A share row joined with its parent split — the shape "bills I owe" needs. */
export interface OwedShareRow extends BillSplitShareRow {
  split_reference: string;
  split_total_amount_poisha: string;
  split_description: string | null;
  split_status: string;
  split_created_at: Date;
  creator_id: string;
  creator_name: string;
  creator_email: string;
}

/** Thrown inside the interactive transaction to force a rollback with a reason. */
class PayShareAbort extends Error {
  constructor(readonly reason: PayShareFailureReason) {
    super(reason);
  }
}

@Injectable()
export class BillSplitRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a split and all of its shares as one atomic unit — a split can
   * never exist half-described, with some shares written and others not.
   *
   * The only thing this needs the database for is confirming every named
   * participant actually exists and is active; everything else the service
   * already validated without a query (amount bounds, duplicates, the sum
   * check). See the model comment on BillSplit for why the sum check cannot
   * be a CHECK constraint instead.
   */
  async createSplit(command: CreateSplitCommand): Promise<CreateSplitResult> {
    const { creatorId, totalAmountPoisha, description, shares } = command;

    return await this.prisma.client.$transaction(async (tx): Promise<CreateSplitResult> => {
      const payerIds = shares.map((share) => share.payerId);
      const found = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "users" WHERE "id" = ANY(${payerIds}::uuid[]) AND "status" = 'ACTIVE'
      `;
      const foundIds = new Set(found.map((row) => row.id));
      if (payerIds.some((id) => !foundIds.has(id))) {
        return { ok: false, reason: 'PAYER_NOT_FOUND' };
      }

      const reference = generateReference('SPL');
      const split = await tx.billSplit.create({
        data: {
          reference,
          creatorId,
          totalAmountPoisha,
          description: description ?? null,
          status: 'OPEN',
        },
        select: { id: true },
      });

      await tx.billSplitShare.createMany({
        data: shares.map((share) => ({
          billSplitId: split.id,
          payerId: share.payerId,
          amountPoisha: share.amountPoisha,
        })),
      });

      return { ok: true, id: split.id, reference };
    });
  }

  /** Splits I created, newest first. */
  async findOwnedSplits(creatorId: string): Promise<BillSplitRow[]> {
    return await this.prisma.client.$queryRaw<BillSplitRow[]>`
      SELECT
        bs."id", bs."reference", bs."total_amount_poisha"::text AS total_amount_poisha,
        bs."description", bs."status"::text AS status, bs."created_at", bs."settled_at",
        bs."creator_id", u."display_name" AS creator_name, u."email" AS creator_email
      FROM "bill_splits" bs
      JOIN "users" u ON u."id" = bs."creator_id"
      WHERE bs."creator_id" = ${creatorId}::uuid
      ORDER BY bs."created_at" DESC
      LIMIT 100
    `;
  }

  /** One split by id, with creator info — used for the detail view and authorization. */
  async findSplitById(splitId: string): Promise<BillSplitRow | null> {
    const rows = await this.prisma.client.$queryRaw<BillSplitRow[]>`
      SELECT
        bs."id", bs."reference", bs."total_amount_poisha"::text AS total_amount_poisha,
        bs."description", bs."status"::text AS status, bs."created_at", bs."settled_at",
        bs."creator_id", u."display_name" AS creator_name, u."email" AS creator_email
      FROM "bill_splits" bs
      JOIN "users" u ON u."id" = bs."creator_id"
      WHERE bs."id" = ${splitId}::uuid
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  /** All shares belonging to the given splits, oldest first within each split. */
  async findSharesForSplitIds(splitIds: string[]): Promise<BillSplitShareRow[]> {
    if (splitIds.length === 0) return [];
    return await this.prisma.client.$queryRaw<BillSplitShareRow[]>`
      SELECT
        s."id", s."bill_split_id", s."amount_poisha"::text AS amount_poisha,
        s."status"::text AS status, s."created_at", s."paid_at",
        s."payer_id", u."display_name" AS payer_name, u."email" AS payer_email
      FROM "bill_split_shares" s
      JOIN "users" u ON u."id" = s."payer_id"
      WHERE s."bill_split_id" = ANY(${splitIds}::uuid[])
      ORDER BY s."created_at" ASC
    `;
  }

  /** "Bills I owe" — every share billed to me, across every split, newest first. */
  async findSharesOwedBy(payerId: string): Promise<OwedShareRow[]> {
    return await this.prisma.client.$queryRaw<OwedShareRow[]>`
      SELECT
        s."id", s."bill_split_id", s."amount_poisha"::text AS amount_poisha,
        s."status"::text AS status, s."created_at", s."paid_at",
        s."payer_id", payer."display_name" AS payer_name, payer."email" AS payer_email,
        bs."reference" AS split_reference,
        bs."total_amount_poisha"::text AS split_total_amount_poisha,
        bs."description" AS split_description,
        bs."status"::text AS split_status,
        bs."created_at" AS split_created_at,
        bs."creator_id",
        creator."display_name" AS creator_name, creator."email" AS creator_email
      FROM "bill_split_shares" s
      JOIN "bill_splits" bs ON bs."id" = s."bill_split_id"
      JOIN "users" payer   ON payer."id" = s."payer_id"
      JOIN "users" creator ON creator."id" = bs."creator_id"
      WHERE s."payer_id" = ${payerId}::uuid
      ORDER BY s."created_at" DESC
      LIMIT 100
    `;
  }

  /**
   * Pays one participant's share of a split.
   *
   * Same discipline as WalletRepository.acceptMoneyRequest: the share's state
   * transition and the money movement commit together, in one transaction —
   * if the payer can't afford it, the share must roll back to PENDING, not be
   * left half-settled. Balance rows are locked in ascending account-UUID
   * order, the same global discipline the transfer path uses, so a share
   * payment can never deadlock against an ordinary transfer.
   *
   * ---------------------------------------------------------------------------
   *  WHY THIS TAKES A LOCK THE TRANSFER PATH DELIBERATELY DOES NOT
   * ---------------------------------------------------------------------------
   * transfer.repository.ts explains at length why an *extra* `SELECT ... FOR
   * UPDATE` ahead of a balance-changing conditional UPDATE is redundant and
   * measurably harmful there: a single-row conditional UPDATE already takes
   * the lock and re-checks atomically, so a preceding SELECT just doubles the
   * lock-hold window for no benefit.
   *
   * That reasoning does not transfer to the check this method has to make:
   * "has every sibling share of this split now been paid?" is an aggregate
   * over *other* rows, and there is no single-row conditional UPDATE that can
   * express it. Under READ COMMITTED, two payers settling the last two
   * PENDING shares of the same split at the same moment could each run their
   * own "any siblings still PENDING?" check against a snapshot that predates
   * the other's still-uncommitted update — and both would (wrongly) conclude
   * the split isn't fully settled yet. Locking the parent `bill_splits` row
   * first serializes exactly that pair of transactions: the second one blocks
   * until the first commits, and only then re-reads the now-current state.
   *
   * This lock only ever contends with another payment against the *same*
   * split — one bill, N participants, each paying once — never with the
   * high-frequency global transfer path, so it does not reproduce the
   * deadlock risk that the transfer path's comment warns about.
   *
   * One consequence worth noting: because every payShare call for a split
   * already serializes behind that one lock, claiming this participant's
   * share below only needs a plain SELECT, not a second conditional UPDATE —
   * there is no concurrent writer left to race against once the lock is
   * held. See the settling UPDATE further down for the other lesson this
   * method's first draft got wrong (a CHECK constraint, not a race).
   */
  async payShare(params: { splitId: string; payerUserId: string }): Promise<PayShareResult> {
    const { splitId, payerUserId } = params;

    try {
      return await this.prisma.client.$transaction(
        async (tx): Promise<PayShareResult> => {
          const splitRows = await tx.$queryRaw<
            { id: string; creator_id: string; status: string }[]
          >`
            SELECT "id", "creator_id", "status"::text AS status
            FROM "bill_splits"
            WHERE "id" = ${splitId}::uuid
            FOR UPDATE
          `;
          const split = splitRows[0];
          if (split === undefined) {
            throw new PayShareAbort('NOT_FOUND');
          }

          // A plain SELECT, not a conditional UPDATE, is enough to claim this
          // share safely: every payShare call for this split already queues
          // behind the `FOR UPDATE` lock taken above, so no other transaction
          // can be mutating a sibling share's status concurrently. (See the
          // class header — this is the one lock doing double duty.) The
          // status flip itself happens in a single combined UPDATE further
          // down, alongside settled_transaction_id — see that UPDATE for why
          // it cannot be split into two statements the way this used to be.
          const shareRows = await tx.$queryRaw<
            { id: string; status: string; amount_poisha: string }[]
          >`
            SELECT "id", "status"::text AS status, "amount_poisha"::text AS amount_poisha
            FROM "bill_split_shares"
            WHERE "bill_split_id" = ${splitId}::uuid AND "payer_id" = ${payerUserId}::uuid
          `;
          const share = shareRows[0];
          if (share === undefined) {
            throw new PayShareAbort('NOT_FOUND');
          }
          if (share.status !== 'PENDING') {
            throw new PayShareAbort('NOT_PENDING');
          }
          if (split.status !== 'OPEN') {
            // Defensive only: unreachable today (no cancel path exists yet),
            // but a PENDING share on a non-OPEN split would mean the two
            // tables have already diverged — paying it would make that worse.
            throw new PayShareAbort('NOT_PENDING');
          }

          const amount = BigInt(share.amount_poisha);

          const accounts = await tx.$queryRaw<{ id: string; user_id: string; status: string }[]>`
            SELECT "id", "user_id", "status"::text AS status FROM "accounts"
            WHERE "user_id" IN (${payerUserId}::uuid, ${split.creator_id}::uuid)
          `;
          const payerAccount = accounts.find((account) => account.user_id === payerUserId);
          const creatorAccount = accounts.find((account) => account.user_id === split.creator_id);
          if (payerAccount === undefined || creatorAccount === undefined) {
            throw new PayShareAbort('NOT_FOUND');
          }
          if (payerAccount.status !== 'ACTIVE') {
            throw new PayShareAbort('PAYER_ACCOUNT_FROZEN');
          }
          if (creatorAccount.status !== 'ACTIVE') {
            throw new PayShareAbort('CREATOR_ACCOUNT_FROZEN');
          }

          const debit = async (): Promise<bigint> => {
            const rows = await tx.$queryRaw<{ balance_poisha: string }[]>`
              UPDATE "accounts"
                 SET "balance_poisha" = "balance_poisha" - ${amount}::bigint, "updated_at" = now()
               WHERE "id" = ${payerAccount.id}::uuid AND "status" = 'ACTIVE'
                 AND "balance_poisha" >= ${amount}::bigint
              RETURNING "balance_poisha"::text AS balance_poisha
            `;
            const row = rows[0];
            if (row === undefined) throw new PayShareAbort('INSUFFICIENT_FUNDS');
            return BigInt(row.balance_poisha);
          };
          const credit = async (): Promise<bigint> => {
            const rows = await tx.$queryRaw<{ balance_poisha: string }[]>`
              UPDATE "accounts"
                 SET "balance_poisha" = "balance_poisha" + ${amount}::bigint, "updated_at" = now()
               WHERE "id" = ${creatorAccount.id}::uuid AND "status" = 'ACTIVE'
              RETURNING "balance_poisha"::text AS balance_poisha
            `;
            const row = rows[0];
            if (row === undefined) throw new PayShareAbort('CREATOR_ACCOUNT_FROZEN');
            return BigInt(row.balance_poisha);
          };

          let payerAfter: bigint;
          let creatorAfter: bigint;
          if (payerAccount.id < creatorAccount.id) {
            payerAfter = await debit();
            creatorAfter = await credit();
          } else {
            creatorAfter = await credit();
            payerAfter = await debit();
          }

          const reference = generateReference('TXN');
          const transaction = await tx.transaction.create({
            data: {
              reference,
              type: 'TRANSFER',
              status: 'SUCCESS',
              amountPoisha: amount,
              senderAccountId: payerAccount.id,
              receiverAccountId: creatorAccount.id,
              note: 'Bill split settlement',
              completedAt: new Date(),
            },
            select: { id: true },
          });

          await tx.ledgerEntry.createMany({
            data: [
              {
                transactionId: transaction.id,
                accountId: payerAccount.id,
                direction: 'DEBIT',
                amountPoisha: amount,
                balanceAfterPoisha: payerAfter,
              },
              {
                transactionId: transaction.id,
                accountId: creatorAccount.id,
                direction: 'CREDIT',
                amountPoisha: amount,
                balanceAfterPoisha: creatorAfter,
              },
            ],
          });

          // One statement, setting status, paid_at, and settled_transaction_id
          // together. This is not a style choice: Postgres evaluates a CHECK
          // constraint at the end of the statement that touched the row, not
          // at commit, so a first UPDATE that set status = 'PAID' alone would
          // leave the row briefly (from the constraint's point of view,
          // permanently — the statement itself fails) missing the
          // settled_transaction_id that chk_bill_split_shares_settlement_shape
          // requires PAID rows to have, and Postgres would reject that UPDATE
          // outright with SQLSTATE 23514. There is no "fix it in the next
          // statement, same transaction" here: the constraint doesn't wait
          // for commit the way a foreign key can.
          await tx.billSplitShare.update({
            where: { id: share.id },
            data: { status: 'PAID', paidAt: new Date(), settledTransactionId: transaction.id },
          });

          // Count is a row count, not money — Number() is fine here (NFR-C
          // only bans it on amounts).
          const remaining = await tx.$queryRaw<{ count: string }[]>`
            SELECT count(*)::text AS count FROM "bill_split_shares"
            WHERE "bill_split_id" = ${splitId}::uuid AND "status" = 'PENDING'
          `;
          const splitSettled = Number(remaining[0]?.count ?? '0') === 0;
          if (splitSettled) {
            await tx.billSplit.update({
              where: { id: splitId },
              data: { status: 'SETTLED', settledAt: new Date() },
            });
          }

          return { ok: true, reference, payerBalancePoisha: payerAfter, splitSettled };
        },
        { isolationLevel: 'ReadCommitted', timeout: 10_000, maxWait: 10_000 },
      );
    } catch (error) {
      if (error instanceof PayShareAbort) {
        return { ok: false, reason: error.reason };
      }
      throw error;
    }
  }
}
