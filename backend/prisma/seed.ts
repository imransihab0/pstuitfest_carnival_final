/**
 * Database seed — Money Movement Application
 * PSTU IT Carnival 2026
 *
 * Creates the SYSTEM account and a set of demo users, each funded with the
 * ৳100,000 registration credit (FR-A).
 *
 * Two properties this script is careful about, because they are the same
 * properties the running application has to get right:
 *
 *   1. Money is issued through the ledger, not poked into a balance column.
 *      Each signup credit is a real SIGNUP_BONUS transaction with a matching
 *      DEBIT on the SYSTEM account and CREDIT on the user's account. The books
 *      balance from the very first row, so `SELECT * FROM v_money_invariant`
 *      reads `is_balanced = true` immediately after seeding.
 *
 *   2. It is idempotent. Re-running it does not double-fund anyone and does not
 *      create a second SYSTEM account. Seeds get re-run by accident constantly;
 *      one that mints money on every run would quietly destroy the invariant
 *      the whole system is judged on.
 *
 * Every write for a single user happens inside one interactive transaction, so
 * a crash midway cannot leave an account funded without a ledger entry to
 * explain it.
 *
 * Run:  npm run prisma:seed          (or `npx prisma db seed`)
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

// -----------------------------------------------------------------------------
// Money
// -----------------------------------------------------------------------------

/** 1 taka = 100 poisha. All money is integer poisha. Never a float. */
const POISHA_PER_TAKA = 100n;

/** The registration credit: ৳100,000.00 → 10,000,000 poisha (FR-A). */
const SIGNUP_BONUS_POISHA = 100_000n * POISHA_PER_TAKA;

/** Fixed UUID so the mint is findable and re-seeding is idempotent. */
const SYSTEM_ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';

/** Display helper. Formatting happens only at the edge — this is the edge. */
function formatTaka(poisha: bigint): string {
  const negative = poisha < 0n;
  const abs = negative ? -poisha : poisha;
  const taka = abs / POISHA_PER_TAKA;
  const fraction = abs % POISHA_PER_TAKA;
  const grouped = taka.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}৳${grouped}.${fraction.toString().padStart(2, '0')}`;
}

// -----------------------------------------------------------------------------
// Passwords
// -----------------------------------------------------------------------------

/**
 * scrypt from the Node standard library — a real memory-hard KDF, no dependency.
 *
 * NOTE FOR THE AUTH MODULE: this format (`scrypt$N$r$p$salt$hash`, all hex) is
 * what seeded users are stored with. Whatever the auth module adopts must either
 * verify this format or the database must be re-seeded, otherwise the demo
 * accounts below will exist but be unable to log in.
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function hashPassword(plaintext: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(plaintext, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('hex'),
    derived.toString('hex'),
  ].join('$');
}

/** Exported alongside the hasher so the format is verifiably round-trippable. */
export function verifyPassword(plaintext: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, hashHex] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(plaintext, Buffer.from(saltHex, 'hex'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// -----------------------------------------------------------------------------
// References
// -----------------------------------------------------------------------------

const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

/** Public, shareable transaction/request identifier, e.g. "TXN-7GH2K9QW". */
function makeReference(prefix: string, length = 10): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) {
    out += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  }
  return `${prefix}-${out}`;
}

// -----------------------------------------------------------------------------
// Demo data
// -----------------------------------------------------------------------------

/**
 * Shared password for every demo account. Development fixture only — the plain
 * text is committed on purpose so the demo is reproducible, and nothing here is
 * ever loaded outside a local database.
 */
const DEMO_PASSWORD = 'Carnival#2026';

interface DemoUser {
  email: string;
  phone: string;
  username: string;
  displayName: string;
}

const DEMO_USERS: readonly DemoUser[] = [
  {
    email: 'alice@example.com',
    phone: '+8801700000001',
    username: 'alice',
    displayName: 'Alice Rahman',
  },
  {
    email: 'bob@example.com',
    phone: '+8801700000002',
    username: 'bob',
    displayName: 'Bob Hossain',
  },
  {
    email: 'carol@example.com',
    phone: '+8801700000003',
    username: 'carol',
    displayName: 'Carol Akter',
  },
  {
    email: 'dan@example.com',
    phone: '+8801700000004',
    username: 'dan',
    displayName: 'Dan Chowdhury',
  },
  {
    email: 'erin@example.com',
    phone: '+8801700000005',
    username: 'erin',
    displayName: 'Erin Islam',
  },
];

// -----------------------------------------------------------------------------
// Seed
// -----------------------------------------------------------------------------

function createClient(): PrismaClient {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error(
      'DATABASE_URL is not set. Copy backend/.env.example to backend/.env, or export it inline.',
    );
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const prisma = createClient();

/**
 * Ensures the single SYSTEM account exists. This is the mint: its balance is the
 * negative of every taka issued, which is what makes the zero-sum invariant
 * hold. A partial unique index guarantees a second one can never be created.
 */
async function ensureSystemAccount(): Promise<string> {
  // Looked up by type, not by the canonical id: the database permits exactly one
  // SYSTEM account, so if one already exists under a different id (a restored
  // dump, a hand-run fixture) that is the mint, and creating another would fail
  // the unique index anyway. Return whichever one is real.
  const existing = await prisma.account.findFirst({ where: { accountType: 'SYSTEM' } });
  if (existing !== null) {
    console.log(
      `  system account already present (${existing.id}) — balance ${formatTaka(existing.balancePoisha)}`,
    );
    return existing.id;
  }

  const created = await prisma.account.create({
    data: {
      id: SYSTEM_ACCOUNT_ID,
      userId: null,
      accountType: 'SYSTEM',
      balancePoisha: 0n,
    },
  });
  console.log(`  system account created (${created.id})`);
  return created.id;
}

/**
 * Registers one demo user and issues their signup credit.
 *
 * The user row, their account, the SIGNUP_BONUS transaction, both ledger entries
 * and both balance updates commit as **one transaction** — the same guarantee
 * FR-A requires of real registration. There is no window in which an account
 * exists with an unexplained balance.
 */
async function seedUser(demo: DemoUser, systemAccountId: string): Promise<'created' | 'skipped'> {
  const existing = await prisma.user.findUnique({ where: { email: demo.email } });
  if (existing !== null) {
    return 'skipped';
  }

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: demo.email,
        phone: demo.phone,
        username: demo.username,
        displayName: demo.displayName,
        passwordHash: hashPassword(DEMO_PASSWORD),
        status: 'ACTIVE',
      },
    });

    const account = await tx.account.create({
      data: { userId: user.id, balancePoisha: 0n, accountType: 'USER' },
    });

    const transaction = await tx.transaction.create({
      data: {
        reference: makeReference('TXN'),
        type: 'SIGNUP_BONUS',
        status: 'SUCCESS',
        amountPoisha: SIGNUP_BONUS_POISHA,
        senderAccountId: systemAccountId,
        receiverAccountId: account.id,
        note: 'Welcome bonus',
        completedAt: new Date(),
      },
    });

    // Move the money. Both updates return the post-update row, so the
    // `balance_after_poisha` written to the ledger is the real committed value
    // rather than something recomputed and hoped to match.
    const systemAfter = await tx.account.update({
      where: { id: systemAccountId },
      data: { balancePoisha: { decrement: SIGNUP_BONUS_POISHA } },
    });
    const userAfter = await tx.account.update({
      where: { id: account.id },
      data: { balancePoisha: { increment: SIGNUP_BONUS_POISHA } },
    });

    // Double entry: one DEBIT, one CREDIT, equal magnitude. Amounts are always
    // positive — direction carries the sign.
    await tx.ledgerEntry.createMany({
      data: [
        {
          transactionId: transaction.id,
          accountId: systemAccountId,
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
        body: `Your account has been credited with ${formatTaka(SIGNUP_BONUS_POISHA)}.`,
        // Amounts cross JSON as strings: a JSON number is a double, which would
        // reintroduce exactly the float problem the schema exists to avoid.
        payload: { amountPoisha: SIGNUP_BONUS_POISHA.toString(), reference: transaction.reference },
        transactionId: transaction.id,
      },
    });
  });

  return 'created';
}

/**
 * One outstanding money request, so the request tables are not empty on a fresh
 * demo. No money moves — a request is a claim, and settling it is the
 * application's job, not the seed's.
 */
async function seedMoneyRequest(): Promise<'created' | 'skipped'> {
  const [requester, requestee] = await Promise.all([
    prisma.user.findUnique({ where: { email: 'carol@example.com' } }),
    prisma.user.findUnique({ where: { email: 'dan@example.com' } }),
  ]);
  if (requester === null || requestee === null) return 'skipped';

  const existing = await prisma.moneyRequest.findFirst({
    where: { requesterId: requester.id, requesteeId: requestee.id, status: 'PENDING' },
  });
  if (existing !== null) return 'skipped';

  await prisma.moneyRequest.create({
    data: {
      reference: makeReference('REQ'),
      requesterId: requester.id,
      requesteeId: requestee.id,
      amountPoisha: 1_200n * POISHA_PER_TAKA,
      note: 'Lunch last Friday',
      status: 'PENDING',
    },
  });
  return 'created';
}

/**
 * The seed asserts the invariant it claims to preserve. If seeding ever breaks
 * the books, this fails the command rather than leaving a quietly corrupt
 * database for someone to discover during the demo.
 */
async function assertInvariant(): Promise<void> {
  const accounts = await prisma.account.findMany({
    select: { accountType: true, balancePoisha: true },
  });

  const total = accounts.reduce((sum, a) => sum + a.balancePoisha, 0n);
  const users = accounts
    .filter((a) => a.accountType === 'USER')
    .reduce((sum, a) => sum + a.balancePoisha, 0n);
  const system = accounts
    .filter((a) => a.accountType === 'SYSTEM')
    .reduce((sum, a) => sum + a.balancePoisha, 0n);

  console.log('\n  Invariant check');
  console.log(`    user balances    ${formatTaka(users)}`);
  console.log(`    system balance   ${formatTaka(system)}`);
  console.log(`    total            ${formatTaka(total)}`);

  if (total !== 0n) {
    throw new Error(
      `INVARIANT VIOLATED: account balances sum to ${total.toString()} poisha, expected 0. ` +
        'Money was created or destroyed during seeding.',
    );
  }
  console.log('    ✓ books balance to zero');

  const negative = await prisma.account.count({
    where: { accountType: 'USER', balancePoisha: { lt: 0n } },
  });
  if (negative > 0) {
    throw new Error(`INVARIANT VIOLATED: ${negative} user account(s) have a negative balance.`);
  }
  console.log('    ✓ no negative user balances');
}

async function main(): Promise<void> {
  console.log('Seeding Money Movement Application\n');

  console.log('  System account');
  const systemAccountId = await ensureSystemAccount();

  console.log('\n  Demo users');
  let created = 0;
  let skipped = 0;
  for (const demo of DEMO_USERS) {
    // Sequential on purpose: each signup debits the shared SYSTEM account, and
    // running them concurrently would contend on that single row for no gain.
    const outcome = await seedUser(demo, systemAccountId);
    if (outcome === 'created') {
      created += 1;
      console.log(
        `    + ${demo.username.padEnd(6)} ${demo.email.padEnd(22)} ${formatTaka(SIGNUP_BONUS_POISHA)}`,
      );
    } else {
      skipped += 1;
      console.log(`    = ${demo.username.padEnd(6)} already present, left untouched`);
    }
  }
  console.log(`    ${created} created, ${skipped} unchanged`);

  console.log('\n  Money requests');
  const request = await seedMoneyRequest();
  console.log(
    `    ${request === 'created' ? '+ carol → dan  ৳1,200.00 (pending)' : '= pending request already present'}`,
  );

  await assertInvariant();

  if (created > 0) {
    console.log(`\n  Demo login password for every seeded account: ${DEMO_PASSWORD}`);
  }
  console.log('\nSeed complete.\n');
}

try {
  await main();
} catch (error) {
  console.error('\nSeed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
