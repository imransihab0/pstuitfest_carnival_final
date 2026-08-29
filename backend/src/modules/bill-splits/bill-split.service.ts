import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  BillSplitRepository,
  type BillSplitRow,
  type BillSplitShareRow,
  type OwedShareRow,
} from './bill-split.repository.js';
import { isTransferableAmount } from '../../common/money.js';
import {
  type CreateShareInput,
  type CreateSplitResult,
  type PayShareResult,
} from './dto/bill-split.types.js';

/** A sanity bound, not a business rule — turns an absurd request into a clean rejection. */
const MAX_SHARES_PER_SPLIT = 50;

export interface BillSplitShareDto {
  id: string;
  amountPoisha: string;
  status: string;
  createdAt: string;
  paidAt: string | null;
  payer: { id: string; name: string; email: string };
}

export interface BillSplitDto {
  id: string;
  reference: string;
  totalAmountPoisha: string;
  description: string | null;
  status: string;
  createdAt: string;
  settledAt: string | null;
  creator: { id: string; name: string; email: string };
  shares: BillSplitShareDto[];
}

export interface OwedShareDto {
  id: string;
  amountPoisha: string;
  status: string;
  createdAt: string;
  paidAt: string | null;
  split: {
    id: string;
    reference: string;
    totalAmountPoisha: string;
    description: string | null;
    status: string;
    createdAt: string;
    creator: { id: string; name: string; email: string };
  };
}

function toShareDto(row: BillSplitShareRow): BillSplitShareDto {
  return {
    id: row.id,
    amountPoisha: row.amount_poisha,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    paidAt: row.paid_at?.toISOString() ?? null,
    payer: { id: row.payer_id, name: row.payer_name, email: row.payer_email },
  };
}

function toSplitDto(split: BillSplitRow, shares: BillSplitShareRow[]): BillSplitDto {
  return {
    id: split.id,
    reference: split.reference,
    totalAmountPoisha: split.total_amount_poisha,
    description: split.description,
    status: split.status,
    createdAt: split.created_at.toISOString(),
    settledAt: split.settled_at?.toISOString() ?? null,
    creator: { id: split.creator_id, name: split.creator_name, email: split.creator_email },
    shares: shares.map(toShareDto),
  };
}

function toOwedShareDto(row: OwedShareRow): OwedShareDto {
  return {
    id: row.id,
    amountPoisha: row.amount_poisha,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    paidAt: row.paid_at?.toISOString() ?? null,
    split: {
      id: row.bill_split_id,
      reference: row.split_reference,
      totalAmountPoisha: row.split_total_amount_poisha,
      description: row.split_description,
      status: row.split_status,
      createdAt: row.split_created_at.toISOString(),
      creator: { id: row.creator_id, name: row.creator_name, email: row.creator_email },
    },
  };
}

@Injectable()
export class BillSplitService {
  constructor(private readonly billSplitRepository: BillSplitRepository) {}

  /**
   * Creates a split. All the validation that does not need the database
   * happens here, before any query runs — the division of labour matches
   * TransferService.executeTransfer: cheap checks in the service, checks that
   * genuinely need a query (does every participant exist?) in the repository.
   */
  async create(
    creatorId: string,
    input: {
      totalAmountPoisha: bigint;
      description?: string | undefined;
      shares: CreateShareInput[];
    },
  ): Promise<CreateSplitResult> {
    const { totalAmountPoisha, shares } = input;

    if (!isTransferableAmount(totalAmountPoisha)) {
      return { ok: false, reason: 'INVALID_AMOUNT' };
    }
    if (shares.length === 0) {
      return { ok: false, reason: 'EMPTY_SHARES' };
    }
    if (shares.length > MAX_SHARES_PER_SPLIT) {
      return { ok: false, reason: 'TOO_MANY_SHARES' };
    }

    const seenPayers = new Set<string>();
    let sum = 0n;
    for (const share of shares) {
      if (share.amountPoisha <= 0n) {
        return { ok: false, reason: 'INVALID_AMOUNT' };
      }
      if (share.payerId === creatorId) {
        return { ok: false, reason: 'SELF_SHARE' };
      }
      if (seenPayers.has(share.payerId)) {
        return { ok: false, reason: 'DUPLICATE_PAYER' };
      }
      seenPayers.add(share.payerId);
      sum += share.amountPoisha;
    }

    // The whole point of a split: the shares must account for the total
    // exactly. Not <=, not >= — a leftover or an overcharge is a client bug,
    // and rounding it away would be exactly the silent poisha-drift NFR-C
    // exists to prevent.
    if (sum !== totalAmountPoisha) {
      return { ok: false, reason: 'SHARE_TOTAL_MISMATCH' };
    }

    return await this.billSplitRepository.createSplit({
      creatorId,
      totalAmountPoisha,
      description: input.description,
      shares,
    });
  }

  /** "Splits I created" and "bills I owe" — the two views the UI renders. */
  async listMine(userId: string): Promise<{ owned: BillSplitDto[]; owedByMe: OwedShareDto[] }> {
    const owned = await this.billSplitRepository.findOwnedSplits(userId);
    const shares = await this.billSplitRepository.findSharesForSplitIds(
      owned.map((split) => split.id),
    );

    const sharesBySplitId = new Map<string, BillSplitShareRow[]>();
    for (const share of shares) {
      const list = sharesBySplitId.get(share.bill_split_id);
      if (list) list.push(share);
      else sharesBySplitId.set(share.bill_split_id, [share]);
    }

    const owedRows = await this.billSplitRepository.findSharesOwedBy(userId);

    return {
      owned: owned.map((split) => toSplitDto(split, sharesBySplitId.get(split.id) ?? [])),
      owedByMe: owedRows.map(toOwedShareDto),
    };
  }

  /** Object-level authorization: only the creator or a billed participant may view a split (FR-E). */
  async getDetail(splitId: string, userId: string): Promise<BillSplitDto> {
    const split = await this.billSplitRepository.findSplitById(splitId);
    if (split === null) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Split not found.' });
    }

    const shares = await this.billSplitRepository.findSharesForSplitIds([splitId]);
    const isParticipant =
      split.creator_id === userId || shares.some((share) => share.payer_id === userId);
    if (!isParticipant) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'You are not part of this split.',
      });
    }

    return toSplitDto(split, shares);
  }

  async payShare(userId: string, splitId: string): Promise<PayShareResult> {
    return await this.billSplitRepository.payShare({ splitId, payerUserId: userId });
  }
}
