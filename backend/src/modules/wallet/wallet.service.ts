import { Injectable, NotFoundException } from '@nestjs/common';
import { WalletRepository, type ActivityRow } from './wallet.repository.js';

/** Wire shape consumed by the frontend. Amounts are strings, never JSON numbers. */
export interface ActivityDto {
  id: string;
  reference: string;
  amountPoisha: string;
  direction: 'CREDIT' | 'DEBIT';
  counterpartyName: string;
  note: string | null;
  status: string;
  createdAt: string;
}

function toActivityDto(row: ActivityRow): ActivityDto {
  return {
    id: row.id,
    reference: row.reference,
    // Already a string out of the database (selected as ::text) so it never
    // passes through a JS number (NFR-C).
    amountPoisha: row.amount_poisha,
    direction: row.direction,
    counterpartyName: row.counterparty_name,
    note: row.note,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Cursor for keyset pagination: the timestamp and id of the last row returned.
 * Base64 only to keep it opaque — clients should not construct these by hand.
 */
function encodeCursor(row: ActivityRow): string {
  return Buffer.from(`${row.created_at.toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor?: string): { createdAt: Date; id: string } | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (iso === undefined || id === undefined) return null;
    const createdAt = new Date(iso);
    return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
  } catch {
    return null;
  }
}

/** An unset filter arrives as an omitted query param OR an empty string — both mean "no filter". */
function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** Rejects blanks and unparseable dates the same way: as "no filter", never as a crash. */
function parseDateFilter(value: string | undefined): Date | undefined {
  const raw = blankToUndefined(value);
  if (raw === undefined) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

@Injectable()
export class WalletService {
  constructor(private readonly walletRepository: WalletRepository) {}

  private async requireAccount(userId: string): Promise<{ id: string; balancePoisha: bigint }> {
    const account = await this.walletRepository.findAccountByUserId(userId);
    if (account === null) {
      throw new NotFoundException({ code: 'ACCOUNT_NOT_FOUND', message: 'No wallet found.' });
    }
    return account;
  }

  async summary(userId: string): Promise<{ balancePoisha: string; recentActivity: ActivityDto[] }> {
    const account = await this.requireAccount(userId);
    const rows = await this.walletRepository.listActivity({ accountId: account.id, limit: 8 });
    return {
      balancePoisha: account.balancePoisha.toString(),
      recentActivity: rows.map(toActivityDto),
    };
  }

  async history(
    userId: string,
    params: {
      cursor?: string | undefined;
      direction?: 'CREDIT' | 'DEBIT' | undefined;
      status?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<{ items: ActivityDto[]; nextCursor: string | null }> {
    const account = await this.requireAccount(userId);
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
    const cursor = decodeCursor(params.cursor);

    // Fetch one extra row: its presence is how we know another page exists,
    // without a second COUNT query over a growing table.
    const rows = await this.walletRepository.listActivity({
      accountId: account.id,
      limit: limit + 1,
      cursorCreatedAt: cursor?.createdAt,
      cursorId: cursor?.id,
      direction: blankToUndefined(params.direction) as 'CREDIT' | 'DEBIT' | undefined,
      status: blankToUndefined(params.status),
      from: parseDateFilter(params.from),
      to: parseDateFilter(params.to),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map(toActivityDto),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
    };
  }

  async searchUsers(query: string, callerUserId: string) {
    const trimmed = query.trim();
    // Refuse to enumerate the whole user table on an empty query.
    if (trimmed.length < 2) return [];
    return await this.walletRepository.searchUsers(trimmed, callerUserId);
  }

  async listRequests(userId: string) {
    const rows = await this.walletRepository.listMoneyRequests(userId);
    const shape = (r: (typeof rows)[number]) => ({
      id: r.id,
      amountPoisha: r.amount_poisha,
      note: r.note,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      requester: { id: r.requester_id, name: r.requester_name, email: r.requester_email },
      requestee: { id: r.requestee_id, name: r.requestee_name, email: r.requestee_email },
    });

    return {
      incoming: rows.filter((r) => r.requestee_id === userId).map(shape),
      outgoing: rows.filter((r) => r.requester_id === userId).map(shape),
    };
  }
}
