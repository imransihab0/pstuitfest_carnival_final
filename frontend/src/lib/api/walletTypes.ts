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
