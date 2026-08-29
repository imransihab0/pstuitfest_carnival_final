export type Direction = 'CREDIT' | 'DEBIT'
export type TransactionStatus = 'SUCCESS' | 'PENDING' | 'FAILED'

export type Transaction = {
  id: string
  reference: string
  amountPoisha: string
  direction: Direction
  counterpartyName: string
  note?: string | null
  status: TransactionStatus
  createdAt: string
  optimistic?: boolean
}

export type AccountSummary = {
  balancePoisha: string
  recentActivity: Transaction[]
}

export type UserResult = { id: string; name: string; email: string }

export type MoneyRequestStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED'
export type MoneyRequest = {
  id: string
  amountPoisha: string
  note?: string | null
  status: MoneyRequestStatus
  requester: UserResult
  requestee: UserResult
  createdAt: string
}

export type RequestsResponse = { incoming: MoneyRequest[]; outgoing: MoneyRequest[] }
export type TransactionsPage = { items: Transaction[]; nextCursor: string | null }

export type BillSplitShareStatus = 'PENDING' | 'PAID' | 'CANCELLED'
export type BillSplitStatus = 'OPEN' | 'SETTLED' | 'CANCELLED'

export type BillSplitShare = {
  id: string
  amountPoisha: string
  status: BillSplitShareStatus
  createdAt: string
  paidAt: string | null
  payer: UserResult
}

export type BillSplit = {
  id: string
  reference: string
  totalAmountPoisha: string
  description: string | null
  status: BillSplitStatus
  createdAt: string
  settledAt: string | null
  creator: UserResult
  shares: BillSplitShare[]
}

export type OwedShare = {
  id: string
  amountPoisha: string
  status: BillSplitShareStatus
  createdAt: string
  paidAt: string | null
  split: {
    id: string
    reference: string
    totalAmountPoisha: string
    description: string | null
    status: BillSplitStatus
    createdAt: string
    creator: UserResult
  }
}

export type BillSplitsResponse = { owned: BillSplit[]; owedByMe: OwedShare[] }
