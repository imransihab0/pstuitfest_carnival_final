import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillSplitService } from './bill-split.service.js';
import {
  BillSplitRepository,
  type BillSplitRow,
  type BillSplitShareRow,
} from './bill-split.repository.js';
import { type CreateShareInput } from './dto/bill-split.types.js';

/**
 * Unit tests for the domain layer, with the repository stubbed — same
 * division as transfer.service.spec.ts: this covers the decisions the
 * service makes without a database (amount bounds, duplicates, the sum
 * check, authorization on read), not locking or settlement, which are
 * database behaviours belonging to a repository-level or integration test.
 */

const TAKA = 100n;

describe('BillSplitService', () => {
  let service: BillSplitService;
  let repository: {
    createSplit: Mock;
    findOwnedSplits: Mock;
    findSplitById: Mock;
    findSharesForSplitIds: Mock;
    findSharesOwedBy: Mock;
    payShare: Mock;
  };

  const CREATOR = 'creator-user-id';
  const shares = (overrides: Partial<CreateShareInput>[] = []): CreateShareInput[] =>
    overrides.length > 0
      ? (overrides as CreateShareInput[])
      : [
          { payerId: 'payer-1', amountPoisha: 500n * TAKA },
          { payerId: 'payer-2', amountPoisha: 500n * TAKA },
        ];

  beforeEach(async () => {
    repository = {
      createSplit: vi.fn().mockResolvedValue({ ok: true, id: 'split-id', reference: 'SPL-ABC' }),
      findOwnedSplits: vi.fn().mockResolvedValue([]),
      findSplitById: vi.fn().mockResolvedValue(null),
      findSharesForSplitIds: vi.fn().mockResolvedValue([]),
      findSharesOwedBy: vi.fn().mockResolvedValue([]),
      payShare: vi.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [BillSplitService, { provide: BillSplitRepository, useValue: repository }],
    }).compile();

    service = moduleRef.get(BillSplitService);
  });

  // ---------------------------------------------------------------------------
  // create() — validated entirely before the database is touched
  // ---------------------------------------------------------------------------

  it('creates a split whose shares sum to the total', async () => {
    const result = await service.create(CREATOR, {
      totalAmountPoisha: 1000n * TAKA,
      shares: shares(),
    });

    expect(result).toEqual({ ok: true, id: 'split-id', reference: 'SPL-ABC' });
    expect(repository.createSplit).toHaveBeenCalledWith({
      creatorId: CREATOR,
      totalAmountPoisha: 1000n * TAKA,
      description: undefined,
      shares: shares(),
    });
  });

  it.each([
    ['zero', 0n],
    ['negative', -1n],
  ])(
    'rejects a %s total amount without touching the database',
    async (_label, totalAmountPoisha) => {
      const result = await service.create(CREATOR, { totalAmountPoisha, shares: shares() });

      expect(result).toEqual({ ok: false, reason: 'INVALID_AMOUNT' });
      expect(repository.createSplit).not.toHaveBeenCalled();
    },
  );

  it('rejects an empty share list', async () => {
    const result = await service.create(CREATOR, { totalAmountPoisha: 1000n * TAKA, shares: [] });

    expect(result).toEqual({ ok: false, reason: 'EMPTY_SHARES' });
    expect(repository.createSplit).not.toHaveBeenCalled();
  });

  it('rejects more than 50 participants', async () => {
    const many: CreateShareInput[] = Array.from({ length: 51 }, (_, i) => ({
      payerId: `payer-${i}`,
      amountPoisha: 1n,
    }));

    const result = await service.create(CREATOR, { totalAmountPoisha: 51n, shares: many });

    expect(result).toEqual({ ok: false, reason: 'TOO_MANY_SHARES' });
    expect(repository.createSplit).not.toHaveBeenCalled();
  });

  it('rejects a non-positive share amount', async () => {
    const result = await service.create(CREATOR, {
      totalAmountPoisha: 500n * TAKA,
      shares: [{ payerId: 'payer-1', amountPoisha: 0n }],
    });

    expect(result).toEqual({ ok: false, reason: 'INVALID_AMOUNT' });
    expect(repository.createSplit).not.toHaveBeenCalled();
  });

  it('rejects the creator billing themselves', async () => {
    const result = await service.create(CREATOR, {
      totalAmountPoisha: 500n * TAKA,
      shares: [{ payerId: CREATOR, amountPoisha: 500n * TAKA }],
    });

    expect(result).toEqual({ ok: false, reason: 'SELF_SHARE' });
    expect(repository.createSplit).not.toHaveBeenCalled();
  });

  it('rejects the same participant billed twice', async () => {
    const result = await service.create(CREATOR, {
      totalAmountPoisha: 1000n * TAKA,
      shares: [
        { payerId: 'payer-1', amountPoisha: 500n * TAKA },
        { payerId: 'payer-1', amountPoisha: 500n * TAKA },
      ],
    });

    expect(result).toEqual({ ok: false, reason: 'DUPLICATE_PAYER' });
    expect(repository.createSplit).not.toHaveBeenCalled();
  });

  it('rejects shares that do not sum to the declared total', async () => {
    const result = await service.create(CREATOR, {
      totalAmountPoisha: 1000n * TAKA,
      shares: [{ payerId: 'payer-1', amountPoisha: 400n * TAKA }],
    });

    expect(result).toEqual({ ok: false, reason: 'SHARE_TOTAL_MISMATCH' });
    expect(repository.createSplit).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // getDetail() — object-level authorization (FR-E): creator or a billed
  // participant only, never a bystander with a guessed id.
  // ---------------------------------------------------------------------------

  const splitRow = (overrides: Partial<BillSplitRow> = {}): BillSplitRow => ({
    id: 'split-id',
    reference: 'SPL-ABC',
    total_amount_poisha: (1000n * TAKA).toString(),
    description: null,
    status: 'OPEN',
    created_at: new Date('2026-08-29T06:00:00.000Z'),
    settled_at: null,
    creator_id: CREATOR,
    creator_name: 'Creator',
    creator_email: 'creator@example.com',
    ...overrides,
  });

  const shareRow = (overrides: Partial<BillSplitShareRow> = {}): BillSplitShareRow => ({
    id: 'share-id',
    bill_split_id: 'split-id',
    amount_poisha: (500n * TAKA).toString(),
    status: 'PENDING',
    created_at: new Date('2026-08-29T06:00:00.000Z'),
    paid_at: null,
    payer_id: 'payer-1',
    payer_name: 'Payer',
    payer_email: 'payer@example.com',
    ...overrides,
  });

  it('throws NotFoundException for an unknown split', async () => {
    repository.findSplitById.mockResolvedValue(null);

    await expect(service.getDetail('missing-id', CREATOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lets the creator view the split', async () => {
    repository.findSplitById.mockResolvedValue(splitRow());
    repository.findSharesForSplitIds.mockResolvedValue([shareRow()]);

    const detail = await service.getDetail('split-id', CREATOR);

    expect(detail.id).toBe('split-id');
    expect(detail.shares).toHaveLength(1);
  });

  it('lets a billed participant view the split', async () => {
    repository.findSplitById.mockResolvedValue(splitRow());
    repository.findSharesForSplitIds.mockResolvedValue([shareRow({ payer_id: 'payer-1' })]);

    const detail = await service.getDetail('split-id', 'payer-1');

    expect(detail.id).toBe('split-id');
  });

  it('refuses a bystander who is neither the creator nor a participant', async () => {
    repository.findSplitById.mockResolvedValue(splitRow());
    repository.findSharesForSplitIds.mockResolvedValue([shareRow({ payer_id: 'payer-1' })]);

    await expect(service.getDetail('split-id', 'someone-else')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
