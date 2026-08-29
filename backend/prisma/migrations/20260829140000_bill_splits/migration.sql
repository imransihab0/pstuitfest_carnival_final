-- =============================================================================
--  Migration: bill splits — shared payments
-- =============================================================================
--  Part 1 mirrors what `prisma migrate dev` would generate from schema.prisma.
--  Part 2 is hand-written (see the note in the initial migration): CHECK
--  constraints Prisma cannot express. If this file is ever regenerated,
--  Part 2 must be carried across by hand — same rule as every migration here.
-- =============================================================================


-- =============================================================================
--  PART 1 — Schema
-- =============================================================================

-- CreateEnum
CREATE TYPE "BillSplitStatus" AS ENUM ('OPEN', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BillSplitShareStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED');

-- CreateTable
CREATE TABLE "bill_splits" (
    "id" UUID NOT NULL,
    "reference" VARCHAR(32) NOT NULL,
    "creator_id" UUID NOT NULL,
    "total_amount_poisha" BIGINT NOT NULL,
    "description" VARCHAR(255),
    "status" "BillSplitStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(6),

    CONSTRAINT "bill_splits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_split_shares" (
    "id" UUID NOT NULL,
    "bill_split_id" UUID NOT NULL,
    "payer_id" UUID NOT NULL,
    "amount_poisha" BIGINT NOT NULL,
    "status" "BillSplitShareStatus" NOT NULL DEFAULT 'PENDING',
    "settled_transaction_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ(6),

    CONSTRAINT "bill_split_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bill_splits_reference_key" ON "bill_splits"("reference");

-- CreateIndex
CREATE INDEX "bill_splits_creator_id_status_created_at_idx" ON "bill_splits"("creator_id", "status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "bill_split_shares_settled_transaction_id_key" ON "bill_split_shares"("settled_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_bill_split_shares_split_payer" ON "bill_split_shares"("bill_split_id", "payer_id");

-- CreateIndex
CREATE INDEX "bill_split_shares_payer_id_status_created_at_idx" ON "bill_split_shares"("payer_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "bill_split_shares_bill_split_id_idx" ON "bill_split_shares"("bill_split_id");

-- AddForeignKey
ALTER TABLE "bill_splits" ADD CONSTRAINT "bill_splits_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_split_shares" ADD CONSTRAINT "bill_split_shares_bill_split_id_fkey" FOREIGN KEY ("bill_split_id") REFERENCES "bill_splits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_split_shares" ADD CONSTRAINT "bill_split_shares_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_split_shares" ADD CONSTRAINT "bill_split_shares_settled_transaction_id_fkey" FOREIGN KEY ("settled_transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================
--  PART 2 — Hand-written integrity rules
-- =============================================================================

-- -----------------------------------------------------------------------------
--  2.1  bill_splits
-- -----------------------------------------------------------------------------

ALTER TABLE "bill_splits"
  ADD CONSTRAINT "chk_bill_splits_amount_positive"
  CHECK ("total_amount_poisha" > 0);

-- Makes "settled but no settlement time" unrepresentable, same discipline as
-- chk_money_requests_settlement_shape. CANCELLED is reserved (no endpoint
-- exposes it yet — see the enum comment in schema.prisma) and left
-- unconstrained here for the same reason MoneyRequestStatus.EXPIRED is.
ALTER TABLE "bill_splits"
  ADD CONSTRAINT "chk_bill_splits_settlement_shape"
  CHECK (
    ("status" = 'SETTLED' AND "settled_at" IS NOT NULL) OR
    ("status" = 'OPEN'    AND "settled_at" IS NULL) OR
    ("status" = 'CANCELLED')
  );


-- -----------------------------------------------------------------------------
--  2.2  bill_split_shares
-- -----------------------------------------------------------------------------

ALTER TABLE "bill_split_shares"
  ADD CONSTRAINT "chk_bill_split_shares_amount_positive"
  CHECK ("amount_poisha" > 0);

-- Mirrors chk_money_requests_settlement_shape: "paid but no settling
-- transaction" is exactly the bug this exists to make impossible.
ALTER TABLE "bill_split_shares"
  ADD CONSTRAINT "chk_bill_split_shares_settlement_shape"
  CHECK (
    ("status" = 'PAID'    AND "settled_transaction_id" IS NOT NULL AND "paid_at" IS NOT NULL) OR
    ("status" = 'PENDING' AND "settled_transaction_id" IS NULL     AND "paid_at" IS NULL) OR
    ("status" = 'CANCELLED' AND "settled_transaction_id" IS NULL)
  );

-- A participant cannot owe themselves a share. Unlike
-- chk_money_requests_not_self, this cannot be a same-table CHECK — the
-- creator lives on the parent bill_splits row, not on this one — so it is
-- enforced once, at creation, inside BillSplitRepository.createSplit's
-- transaction. Documented here so the gap is a deliberate, known one rather
-- than a silent omission.
