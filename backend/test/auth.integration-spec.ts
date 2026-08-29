import { type ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuthRepository, SYSTEM_ACCOUNT_ID } from '../src/auth/auth.repository.js';
import { PinGuard, REQUIRES_PIN_KEY } from '../src/auth/guards/pin.guard.js';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard.js';
import { startTestDatabase, type TestDatabase } from './support/test-database.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long-for-hs256';

describe('Auth — registration, rotation, reuse detection, PIN gate', () => {
  let database: TestDatabase;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let auth: AuthService;
  let repo: AuthRepository;
  let jwt: JwtService;

  beforeAll(async () => {
    database = await startTestDatabase();

    moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: JWT_SECRET })],
      providers: [
        AuthService,
        AuthRepository,
        PrismaService,
        { provide: ConfigService, useValue: { get: () => database.connectionString } },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    await prisma.onModuleInit();
    auth = moduleRef.get(AuthService);
    repo = moduleRef.get(AuthRepository);
    jwt = moduleRef.get(JwtService);

    // The mint, at the fixed id registration debits.
    await prisma.client.account.create({
      data: { id: SYSTEM_ACCOUNT_ID, userId: null, accountType: 'SYSTEM', balancePoisha: 0n },
    });
  }, 180_000);

  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await moduleRef?.close();
    await database?.stop();
  });

  let counter = 0;
  const makeUser = () => {
    counter += 1;
    const s = `${Date.now()}${counter}`.slice(-11);
    return {
      email: `u${s}@example.com`,
      phone: `+8801${s.slice(-9)}`,
      username: `u${s}`,
      displayName: 'Test User',
      password: 'correct-horse-battery-staple',
      pin: '246810',
    };
  };

  // ===========================================================================
  //  Registration is atomic and ledger-backed
  // ===========================================================================

  it('creates user + account + CREDIT ledger entry atomically with ৳100,000', async () => {
    const dto = makeUser();
    const registered = await auth.register(dto);

    expect(registered.balancePoisha).toBe(10_000_000n);

    const entries = await prisma.client.ledgerEntry.findMany({
      where: { accountId: registered.accountId },
      select: { direction: true, amountPoisha: true, balanceAfterPoisha: true },
    });

    // Exactly one CREDIT explains the balance — not a bare UPDATE to a column.
    expect(entries).toHaveLength(1);
    expect(entries[0]?.direction).toBe('CREDIT');
    expect(entries[0]?.amountPoisha).toBe(10_000_000n);
    expect(entries[0]?.balanceAfterPoisha).toBe(10_000_000n);

    // The mint went negative by the same amount, so the books stay at zero.
    const invariant = await prisma.client.$queryRaw<{ is_balanced: boolean }[]>`
      SELECT is_balanced FROM v_money_invariant`;
    expect(invariant[0]?.is_balanced).toBe(true);
  });

  it('rolls the whole registration back when the user is a duplicate', async () => {
    const dto = makeUser();
    await auth.register(dto);

    const accountsBefore = await prisma.client.account.count();
    await expect(auth.register(dto)).rejects.toThrow();
    const accountsAfter = await prisma.client.account.count();

    // No orphan account, no unexplained money.
    expect(accountsAfter).toBe(accountsBefore);
    const invariant = await prisma.client.$queryRaw<{ is_balanced: boolean }[]>`
      SELECT is_balanced FROM v_money_invariant`;
    expect(invariant[0]?.is_balanced).toBe(true);
  });

  it('stores Argon2id digests, never plaintext', async () => {
    const dto = makeUser();
    const registered = await auth.register(dto);

    const row = await prisma.client.user.findUniqueOrThrow({
      where: { id: registered.userId },
      select: { passwordHash: true, pinHash: true },
    });

    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.pinHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toContain(dto.password);
    expect(row.pinHash).not.toContain(dto.pin);
    // Password and PIN are separate secrets with separate salts.
    expect(row.passwordHash).not.toBe(row.pinHash);
  });

  // ===========================================================================
  //  Login
  // ===========================================================================

  it('logs in with the right password and refuses the wrong one', async () => {
    const dto = makeUser();
    await auth.register(dto);

    const ok = await auth.login(dto.username, dto.password);
    expect(ok).not.toBeNull();
    expect(ok?.tokens.accessToken).toBeTruthy();
    expect(ok?.tokens.refreshToken).toBeTruthy();

    expect(await auth.login(dto.username, 'wrong-password')).toBeNull();
    expect(await auth.login('nobody-at-all', dto.password)).toBeNull();
  });

  it('issues an access token WITHOUT the pin claim (read access only)', async () => {
    const dto = makeUser();
    await auth.register(dto);
    const session = await auth.login(dto.username, dto.password);

    const claims = jwt.verify<{ pin?: true; sub: string }>(session!.tokens.accessToken);
    // A password login must not by itself authorise moving money.
    expect(claims.pin).toBeUndefined();
  });

  it('stores only the hash of a refresh token', async () => {
    const dto = makeUser();
    await auth.register(dto);
    const session = await auth.login(dto.username, dto.password);
    const raw = session!.tokens.refreshToken;

    const stored = await prisma.client.session.findFirst({
      where: { userId: session!.userId },
      select: { tokenHash: true },
    });

    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.tokenHash).not.toBe(raw);
  });

  // ===========================================================================
  //  Rotation + REUSE DETECTION
  // ===========================================================================

  it('rotates the refresh token and invalidates the old one', async () => {
    const dto = makeUser();
    await auth.register(dto);
    const session = await auth.login(dto.username, dto.password);
    const first = session!.tokens.refreshToken;

    const rotated = await auth.refresh(first);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    expect(rotated.tokens.refreshToken).not.toBe(first);

    // The new one works.
    const again = await auth.refresh(rotated.tokens.refreshToken);
    expect(again.ok).toBe(true);
  });

  it('revokes the ENTIRE family when a rotated token is presented again', async () => {
    const dto = makeUser();
    const registered = await auth.register(dto);
    const session = await auth.login(dto.username, dto.password);
    const stolen = session!.tokens.refreshToken;

    // Legitimate client rotates twice.
    const r1 = await auth.refresh(stolen);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = await auth.refresh(r1.tokens.refreshToken);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    const familyBefore = await prisma.client.session.findFirst({
      where: { userId: registered.userId },
      select: { familyId: true },
    });
    expect(await repo.countActiveSessions(familyBefore!.familyId)).toBe(1);

    // The attacker replays the ORIGINAL token, which was rotated long ago.
    const reuse = await auth.refresh(stolen);
    expect(reuse.ok).toBe(false);
    expect(reuse.ok === false && reuse.reason).toBe('REUSE_DETECTED');

    // Every session descended from that login is dead — including the current
    // one the attacker may also hold. Revoking only the replayed token would
    // leave the thief's rotated copy working.
    expect(await repo.countActiveSessions(familyBefore!.familyId)).toBe(0);

    const stillValid = await auth.refresh(r2.tokens.refreshToken);
    expect(stillValid.ok).toBe(false);
    expect(stillValid.ok === false && stillValid.reason).toBe('REVOKED');

    const rows = await prisma.client.session.findMany({
      where: { familyId: familyBefore!.familyId },
      select: { revocationReason: true },
    });
    expect(rows.some((r) => r.revocationReason === 'REUSE_DETECTED')).toBe(true);
  });

  it('treats two simultaneous refreshes of one token as reuse', async () => {
    const dto = makeUser();
    await auth.register(dto);
    const session = await auth.login(dto.username, dto.password);
    const token = session!.tokens.refreshToken;

    // Only one may win; the loser's rotation matched zero rows.
    const [a, b] = await Promise.all([auth.refresh(token), auth.refresh(token)]);
    const successes = [a, b].filter((r) => r.ok);
    expect(successes).toHaveLength(1);

    const failure = [a, b].find((r) => !r.ok);
    expect(failure?.ok === false && failure.reason).toBe('REUSE_DETECTED');
  });

  it('rejects an unknown or logged-out refresh token', async () => {
    expect((await auth.refresh('not-a-real-token')).ok).toBe(false);

    const dto = makeUser();
    await auth.register(dto);
    const session = await auth.login(dto.username, dto.password);
    const claims = jwt.verify<{ fam: string }>(session!.tokens.accessToken);

    await auth.logout(claims.fam);
    const after = await auth.refresh(session!.tokens.refreshToken);
    expect(after.ok).toBe(false);
    expect(after.ok === false && after.reason).toBe('REVOKED');
  });

  // ===========================================================================
  //  PIN
  // ===========================================================================

  it('issues a pin-bearing token for the right PIN and refuses the wrong one', async () => {
    const dto = makeUser();
    const registered = await auth.register(dto);
    const session = await auth.login(dto.username, dto.password);
    const claims = jwt.verify<{ fam: string }>(session!.tokens.accessToken);

    expect(await auth.verifyPin(registered.userId, claims.fam, '000000')).toBeNull();

    const verified = await auth.verifyPin(registered.userId, claims.fam, dto.pin);
    expect(verified).not.toBeNull();

    const pinClaims = jwt.verify<{ pin?: true }>(verified!.accessToken);
    expect(pinClaims.pin).toBe(true);
  });

  it('does not re-grant PIN authority on refresh', async () => {
    const dto = makeUser();
    const registered = await auth.register(dto);
    const session = await auth.login(dto.username, dto.password);
    const claims = jwt.verify<{ fam: string }>(session!.tokens.accessToken);

    await auth.verifyPin(registered.userId, claims.fam, dto.pin);
    const rotated = await auth.refresh(session!.tokens.refreshToken);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    // Rotation must not silently extend money-moving authority — the PIN grant
    // expires with its 15-minute token and is re-earned deliberately.
    const rotatedClaims = jwt.verify<{ pin?: true }>(rotated.tokens.accessToken);
    expect(rotatedClaims.pin).toBeUndefined();
  });

  // ===========================================================================
  //  PinGuard
  // ===========================================================================

  function contextFor(user: unknown): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
  }

  const guardWith = (requiresPin: boolean | undefined): PinGuard => {
    const reflector = {
      getAllAndOverride: (key: string) => (key === REQUIRES_PIN_KEY ? requiresPin : undefined),
    } as unknown as Reflector;
    // PinGuard now also accepts a PIN supplied with the request itself, so it
    // needs AuthService. These cases exercise the token-claim route only, hence
    // the stub.
    return new PinGuard(reflector, auth);
  };

  it('PinGuard blocks a JWT-only caller on a money-mutating route', async () => {
    const guard = guardWith(true);
    await expect(
      guard.canActivate(contextFor({ sub: 'u1', username: 'a', fam: 'f', pinVerified: false })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('PinGuard allows a PIN-verified caller', async () => {
    const guard = guardWith(true);
    await expect(
      guard.canActivate(contextFor({ sub: 'u1', username: 'a', fam: 'f', pinVerified: true })),
    ).resolves.toBe(true);
  });

  it('PinGuard fails closed when no user is attached', async () => {
    const guard = guardWith(true);
    await expect(guard.canActivate(contextFor(undefined))).rejects.toThrow(UnauthorizedException);
  });

  it('PinGuard ignores routes not marked @RequiresPin', async () => {
    const guard = guardWith(undefined);
    await expect(guard.canActivate(contextFor(undefined))).resolves.toBe(true);
  });

  it('PinGuard accepts a correct PIN supplied with the request, and rejects a wrong one', async () => {
    const dto = makeUser();
    const registered = await auth.register(dto);
    const guard = guardWith(true);

    const ctx = (pin: string): ExecutionContext =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            user: { sub: registered.userId, username: dto.username, fam: 'f', pinVerified: false },
            body: { pin },
          }),
        }),
        getHandler: () => () => undefined,
        getClass: () => class {},
      }) as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx(dto.pin))).resolves.toBe(true);
    await expect(guard.canActivate(ctx('000000'))).rejects.toThrow(ForbiddenException);
  });

  // ===========================================================================
  //  JwtAuthGuard
  // ===========================================================================

  it('JwtAuthGuard rejects a missing or forged bearer token', async () => {
    const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;
    const guard = new JwtAuthGuard(jwt, reflector);

    const ctx = (header?: string): ExecutionContext =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ header: () => header }) }),
        getHandler: () => () => undefined,
        getClass: () => class {},
      }) as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx(undefined))).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(ctx('Bearer not.a.jwt'))).rejects.toThrow(UnauthorizedException);
    // A token signed with the wrong key must not be accepted.
    const forged = new JwtService({ secret: 'a-different-secret-that-is-also-32-chars' }).sign({
      sub: 'attacker',
    });
    await expect(guard.canActivate(ctx(`Bearer ${forged}`))).rejects.toThrow(UnauthorizedException);
  });
});
