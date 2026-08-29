import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuthRepository } from './auth.repository.js';
import {
  type AccessTokenClaims,
  type RefreshOutcome,
  type RegisterCommand,
  type RegisteredUser,
  type TokenPair,
} from './auth.types.js';

/**
 * Argon2id parameters.
 *
 * Argon2id (not Argon2i or Argon2d) because it is the variant designed to
 * resist both side-channel and GPU/ASIC attacks, and it is what OWASP
 * recommends for password storage.
 *
 * 19 MiB and 2 passes is the OWASP minimum configuration. Memory cost is what
 * actually defeats parallel cracking hardware: a GPU with thousands of cores
 * cannot give each one 19 MiB, so throughput collapses in a way that raising
 * iteration count alone would not achieve.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly authRepository: AuthRepository,
    private readonly jwt: JwtService,
  ) {}

  // ---------------------------------------------------------------------------
  // Hashing
  // ---------------------------------------------------------------------------

  static async hash(secret: string): Promise<string> {
    // argon2.hash is typed as returning Buffer when `raw: true`; we never set
    // it, so the encoded-string overload is the real return type.
    return await argon2.hash(secret, ARGON2_OPTIONS);
  }

  /**
   * Verifies a secret against a stored digest.
   *
   * `argon2.verify` is constant-time with respect to the digest, and never
   * throws on a mismatch — a thrown error here means a malformed hash, which is
   * treated as a failed verification rather than a 500.
   */
  private static async verify(digest: string, secret: string): Promise<boolean> {
    try {
      return await argon2.verify(digest, secret);
    } catch {
      return false;
    }
  }

  /**
   * Refresh tokens are stored as SHA-256, not Argon2.
   *
   * Deliberate difference from passwords. A refresh token is 256 bits of
   * cryptographic randomness, so there is no dictionary to attack and no
   * benefit to a slow KDF — the only property needed is that a database leak
   * yields nothing usable. Running Argon2 on every refresh would add ~50ms to a
   * hot path for no security gain. Passwords and PINs are low-entropy and
   * human-chosen, which is exactly when a slow memory-hard KDF matters.
   */
  private static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  async register(command: RegisterCommand): Promise<RegisteredUser> {
    const [passwordHash, pinHash] = await Promise.all([
      AuthService.hash(command.password),
      AuthService.hash(command.pin),
    ]);

    const created = await this.authRepository.createUserWithSeededAccount({
      email: command.email,
      phone: command.phone,
      username: command.username,
      displayName: command.displayName,
      passwordHash,
      pinHash,
    });

    return {
      userId: created.userId,
      accountId: created.accountId,
      username: command.username.toLowerCase(),
      balancePoisha: created.balancePoisha,
    };
  }

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  /**
   * Verifies credentials and starts a session.
   *
   * Returns `null` for every failure mode — unknown user, wrong password,
   * suspended account — so the response cannot be used to enumerate which
   * usernames exist.
   */
  async login(
    identifier: string,
    password: string,
    context: { userAgent?: string | undefined; ipAddress?: string | undefined } = {},
  ): Promise<{ tokens: TokenPair; userId: string; username: string } | null> {
    const user = await this.authRepository.findByIdentifier(identifier);

    if (user === null) {
      // Hash anyway. Returning immediately would make "unknown user" measurably
      // faster than "wrong password", turning response time into a user
      // enumeration oracle.
      await AuthService.verify(
        '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$RdescudvJCsgt3ub+b+dWRWJTmaaJObG',
        password,
      );
      return null;
    }

    const passwordOk = await AuthService.verify(user.passwordHash, password);
    if (!passwordOk || user.status !== 'ACTIVE') {
      return null;
    }

    const tokens = await this.issueTokens(
      { userId: user.id, username: user.username, familyId: randomUUID() },
      context,
    );

    return { tokens, userId: user.id, username: user.username };
  }

  // ---------------------------------------------------------------------------
  // PIN
  // ---------------------------------------------------------------------------

  /**
   * Verifies the transaction PIN and issues an access token carrying `pin: true`.
   *
   * A password login alone grants read access only. Moving money needs this
   * second factor, so a stolen access token cannot drain an account (FR-E).
   */
  async verifyPin(
    userId: string,
    familyId: string,
    pin: string,
  ): Promise<{ accessToken: string; expiresIn: number } | null> {
    const user = await this.authRepository.findCredentialsById(userId);
    if (user?.pinHash == null || user.status !== 'ACTIVE') {
      return null;
    }

    const ok = await AuthService.verify(user.pinHash, pin);
    if (!ok) return null;

    const claims: AccessTokenClaims = {
      sub: user.id,
      username: user.username,
      fam: familyId,
      pin: true,
    };

    return {
      accessToken: await this.jwt.signAsync(claims, { expiresIn: ACCESS_TOKEN_TTL_SECONDS }),
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  /**
   * Verifies a PIN without issuing a token. Used by PinGuard when the PIN
   * accompanies a single money-moving request.
   */
  async checkPin(userId: string, pin: string): Promise<boolean> {
    const user = await this.authRepository.findCredentialsById(userId);
    if (user?.pinHash == null || user.status !== 'ACTIVE') return false;
    return await AuthService.verify(user.pinHash, pin);
  }

  // ---------------------------------------------------------------------------
  // Refresh with rotation and reuse detection
  // ---------------------------------------------------------------------------

  /**
   * Exchanges a refresh token for a new pair, rotating the old one out.
   *
   * **Reuse detection.** Presenting a token that has already been rotated means
   * either it was stolen and the thief is using it, or the legitimate client
   * replayed it. We cannot tell which, and the safe reading is theft — so the
   * entire session family is revoked and everyone re-authenticates.
   *
   * Revoking only the presented token would be useless: the attacker who stole
   * it has, by now, a *rotated* successor that would keep working. The family
   * is the unit of trust precisely because compromise cannot be localised to
   * one token.
   */
  async refresh(
    refreshToken: string,
    context: { userAgent?: string | undefined; ipAddress?: string | undefined } = {},
  ): Promise<RefreshOutcome> {
    const tokenHash = AuthService.hashToken(refreshToken);
    const session = await this.authRepository.findSessionByTokenHash(tokenHash);

    if (session === null) {
      return { ok: false, reason: 'INVALID' };
    }

    if (session.revokedAt !== null) {
      if (session.revocationReason === 'ROTATED') {
        // The signature of a leaked token.
        const revoked = await this.authRepository.revokeFamily(session.familyId, 'REUSE_DETECTED');
        this.logger.warn(
          `Refresh token reuse detected for user ${session.userId}; ` +
            `revoked ${revoked} session(s) in family ${session.familyId}`,
        );
        return { ok: false, reason: 'REUSE_DETECTED' };
      }
      return { ok: false, reason: 'REVOKED' };
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      return { ok: false, reason: 'EXPIRED' };
    }

    const user = await this.authRepository.findCredentialsById(session.userId);
    if (user?.status !== 'ACTIVE') {
      return { ok: false, reason: 'REVOKED' };
    }

    const newRefreshToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    const rotated = await this.authRepository.rotateSession({
      currentSessionId: session.id,
      userId: session.userId,
      familyId: session.familyId,
      newTokenHash: AuthService.hashToken(newRefreshToken),
      expiresAt,
      ...context,
    });

    if (rotated === null) {
      // Another refresh with the same token won the race between our read and
      // our write. That is reuse.
      await this.authRepository.revokeFamily(session.familyId, 'REUSE_DETECTED');
      return { ok: false, reason: 'REUSE_DETECTED' };
    }

    const claims: AccessTokenClaims = {
      sub: user.id,
      username: user.username,
      fam: session.familyId,
      // Rotation never re-grants PIN authority; the user re-verifies to move money.
    };

    return {
      ok: true,
      tokens: {
        accessToken: await this.jwt.signAsync(claims, { expiresIn: ACCESS_TOKEN_TTL_SECONDS }),
        refreshToken: newRefreshToken,
        accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshTokenExpiresAt: expiresAt,
      },
    };
  }

  /** Ends a session family. */
  async logout(familyId: string): Promise<void> {
    await this.authRepository.revokeFamily(familyId, 'LOGGED_OUT');
  }

  // ---------------------------------------------------------------------------

  private async issueTokens(
    params: { userId: string; username: string; familyId: string },
    context: { userAgent?: string | undefined; ipAddress?: string | undefined },
  ): Promise<TokenPair> {
    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    await this.authRepository.createSession({
      userId: params.userId,
      familyId: params.familyId,
      tokenHash: AuthService.hashToken(refreshToken),
      expiresAt,
      ...context,
    });

    const claims: AccessTokenClaims = {
      sub: params.userId,
      username: params.username,
      fam: params.familyId,
    };

    return {
      accessToken: await this.jwt.signAsync(claims, { expiresIn: ACCESS_TOKEN_TTL_SECONDS }),
      refreshToken,
      accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresAt: expiresAt,
    };
  }
}
