import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { generateReference } from '../common/reference.js';
import { SIGNUP_BONUS_POISHA } from '../common/money.js';

export interface UserCredentials {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  pinHash: string | null;
  status: string;
}

export interface SessionRow {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revocationReason: string | null;
}

/** The mint. Fixed id, created by the seed; every issued taka originates here. */
export const SYSTEM_ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Creates a user, their account, and the ৳100,000 signup credit — atomically.
   *
   * Everything commits together or nothing does (FR-A). There is no window in
   * which a user exists without an account, or an account holds a balance no
   * ledger entry explains.
   *
   * The credit is issued as a real SIGNUP_BONUS transaction with a DEBIT on the
   * SYSTEM account and a CREDIT on the new one — not a bare UPDATE to a balance
   * column. That is what keeps `SUM(balance_poisha) = 0` true from the user's
   * very first row, and what makes the balance reproducible by replaying the
   * ledger.
   */
  async createUserWithSeededAccount(params: {
    email: string;
    phone: string;
    username: string;
    displayName: string;
    passwordHash: string;
    pinHash: string;
  }): Promise<{ userId: string; accountId: string; balancePoisha: bigint }> {
    try {
      return await this.createUserWithSeededAccountUnsafe(params);
    } catch (error) {
      // Uniqueness is enforced by the database, not by a pre-flight SELECT — a
      // check-then-insert would let two simultaneous signups both pass. So the
      // constraint violation is the normal path for a duplicate, and it must be
      // translated into a clear 409 rather than surfacing as an opaque 500.
      const field = uniqueViolationField(error);
      if (field !== null) {
        throw new ConflictException({
          code: 'ALREADY_REGISTERED',
          message: `That ${field} is already registered. Try signing in instead.`,
          field,
        });
      }
      throw error;
    }
  }

  private async createUserWithSeededAccountUnsafe(params: {
    email: string;
    phone: string;
    username: string;
    displayName: string;
    passwordHash: string;
    pinHash: string;
  }): Promise<{ userId: string; accountId: string; balancePoisha: bigint }> {
    return await this.prisma.client.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: params.email.toLowerCase(),
          phone: params.phone,
          username: params.username.toLowerCase(),
          displayName: params.displayName,
          passwordHash: params.passwordHash,
          pinHash: params.pinHash,
          status: 'ACTIVE',
        },
        select: { id: true },
      });

      const account = await tx.account.create({
        data: { userId: user.id, balancePoisha: 0n, accountType: 'USER' },
        select: { id: true },
      });

      const transaction = await tx.transaction.create({
        data: {
          reference: generateReference('TXN'),
          type: 'SIGNUP_BONUS',
          status: 'SUCCESS',
          amountPoisha: SIGNUP_BONUS_POISHA,
          senderAccountId: SYSTEM_ACCOUNT_ID,
          receiverAccountId: account.id,
          note: 'Welcome bonus',
          completedAt: new Date(),
        },
        select: { id: true },
      });

      // The mint goes negative by exactly what it issued.
      const systemAfter = await tx.account.update({
        where: { id: SYSTEM_ACCOUNT_ID },
        data: { balancePoisha: { decrement: SIGNUP_BONUS_POISHA } },
        select: { balancePoisha: true },
      });
      const userAfter = await tx.account.update({
        where: { id: account.id },
        data: { balancePoisha: { increment: SIGNUP_BONUS_POISHA } },
        select: { balancePoisha: true },
      });

      await tx.ledgerEntry.createMany({
        data: [
          {
            transactionId: transaction.id,
            accountId: SYSTEM_ACCOUNT_ID,
            direction: 'DEBIT',
            amountPoisha: SIGNUP_BONUS_POISHA,
            balanceAfterPoisha: systemAfter.balancePoisha,
          },
          {
            transactionId: transaction.id,
            accountId: account.id,
            direction: 'CREDIT',
            amountPoisha: SIGNUP_BONUS_POISHA,
            balanceAfterPoisha: userAfter.balancePoisha,
          },
        ],
      });

      await tx.notification.create({
        data: {
          userId: user.id,
          type: 'SIGNUP_BONUS',
          title: 'Welcome to the carnival wallet',
          body: 'Your account has been credited with ৳100,000.00.',
          payload: { amountPoisha: SIGNUP_BONUS_POISHA.toString() },
          transactionId: transaction.id,
        },
      });

      return {
        userId: user.id,
        accountId: account.id,
        balancePoisha: userAfter.balancePoisha,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Credentials
  // ---------------------------------------------------------------------------

  /** Looks a user up by email, username or phone — all case-insensitive (FR-05). */
  async findByIdentifier(identifier: string): Promise<UserCredentials | null> {
    const rows = await this.prisma.client.$queryRaw<UserCredentials[]>`
      SELECT "id", "username", "email",
             "password_hash" AS "passwordHash",
             "pin_hash"      AS "pinHash",
             "status"::text  AS "status"
      FROM "users"
      WHERE lower("email") = lower(${identifier})
         OR lower("username") = lower(${identifier})
         OR "phone" = ${identifier}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async findCredentialsById(userId: string): Promise<UserCredentials | null> {
    const rows = await this.prisma.client.$queryRaw<UserCredentials[]>`
      SELECT "id", "username", "email",
             "password_hash" AS "passwordHash",
             "pin_hash"      AS "pinHash",
             "status"::text  AS "status"
      FROM "users" WHERE "id" = ${userId}::uuid
    `;
    return rows[0] ?? null;
  }

  // ---------------------------------------------------------------------------
  // Sessions / refresh tokens
  // ---------------------------------------------------------------------------

  async createSession(params: {
    userId: string;
    familyId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string | undefined;
    ipAddress?: string | undefined;
  }): Promise<{ id: string }> {
    return await this.prisma.client.session.create({
      data: {
        userId: params.userId,
        familyId: params.familyId,
        tokenHash: params.tokenHash,
        expiresAt: params.expiresAt,
        userAgent: params.userAgent ?? null,
        ipAddress: params.ipAddress ?? null,
      },
      select: { id: true },
    });
  }

  async findSessionByTokenHash(tokenHash: string): Promise<SessionRow | null> {
    const row = await this.prisma.client.session.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        familyId: true,
        expiresAt: true,
        revokedAt: true,
        revocationReason: true,
      },
    });
    if (row === null) return null;
    return { ...row, revocationReason: row.revocationReason };
  }

  /**
   * Rotates a refresh token: mints the successor and marks the presented one
   * ROTATED, in one transaction.
   *
   * Atomic on purpose. If the new session committed but the old one stayed
   * live, two valid refresh tokens would exist at once and reuse detection
   * would be meaningless. If the old were revoked without the new committing,
   * the user would be logged out by a successful refresh.
   *
   * The `WHERE revoked_at IS NULL` guard makes rotation itself race-safe: two
   * concurrent refreshes with the same token, and only one updates a row. The
   * loser sees zero rows and is treated as reuse.
   */
  async rotateSession(params: {
    currentSessionId: string;
    userId: string;
    familyId: string;
    newTokenHash: string;
    expiresAt: Date;
    userAgent?: string | undefined;
    ipAddress?: string | undefined;
  }): Promise<{ id: string } | null> {
    return await this.prisma.client.$transaction(async (tx) => {
      const claimed = await tx.$executeRaw`
        UPDATE "sessions"
           SET "revoked_at" = now(), "revocation_reason" = 'ROTATED'
         WHERE "id" = ${params.currentSessionId}::uuid
           AND "revoked_at" IS NULL
      `;
      if (claimed === 0) {
        return null;
      }

      const created = await tx.session.create({
        data: {
          userId: params.userId,
          familyId: params.familyId,
          tokenHash: params.newTokenHash,
          expiresAt: params.expiresAt,
          userAgent: params.userAgent ?? null,
          ipAddress: params.ipAddress ?? null,
        },
        select: { id: true },
      });

      await tx.session.update({
        where: { id: params.currentSessionId },
        data: { replacedById: created.id },
      });

      return created;
    });
  }

  /**
   * Revokes every session in a family.
   *
   * Called on reuse detection. Refusing only the replayed token would leave the
   * thief's rotated copy working — the point is that once we know a token
   * leaked, nothing descended from that login can be trusted.
   */
  async revokeFamily(familyId: string, reason: 'REUSE_DETECTED' | 'LOGGED_OUT'): Promise<number> {
    const result = await this.prisma.client.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revocationReason: reason },
    });
    return result.count;
  }

  async countActiveSessions(familyId: string): Promise<number> {
    return await this.prisma.client.session.count({
      where: { familyId, revokedAt: null },
    });
  }
}

/**
 * Maps a unique-constraint violation onto the field a user can act on.
 *
 * Both the plain unique indexes and the case-insensitive functional ones
 * (uq_users_email_lower, uq_users_username_lower) are covered — a user who
 * signs up with "Alice@..." after "alice@..." exists must get the same clear
 * message, not a different error.
 */
function uniqueViolationField(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;

  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  const text = typeof message === 'string' ? message : '';

  const isUnique = code === 'P2002' || code === '23505' || text.includes('23505');
  if (!isUnique) return null;

  const haystack = `${text} ${JSON.stringify((error as { meta?: unknown }).meta ?? {})}`;
  if (/email/i.test(haystack)) return 'email address';
  if (/username/i.test(haystack)) return 'username';
  if (/phone/i.test(haystack)) return 'phone number';
  return 'account detail';
}
