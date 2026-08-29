import type { Transaction } from '../../lib/api/walletTypes'
import { formatPoisha } from '../../lib/money'

export function ActivityList({ transactions, emptyMessage = 'No activity yet.' }: { transactions: Transaction[]; emptyMessage?: string }) {
  if (!transactions.length) return <p className="empty-state">{emptyMessage}</p>

  return (
    <ul className="divide-y divide-line" aria-label="Activity">
      {transactions.map((transaction) => (
        <li className="grid grid-cols-[1fr_auto] gap-4 py-5" key={transaction.id}>
          <div className="min-w-0">
            <p className="truncate font-medium text-ink">{transaction.counterpartyName}</p>
            <p className="mt-1 truncate text-sm text-muted">
              {transaction.note || transaction.reference} · {new Date(transaction.createdAt).toLocaleString()}
            </p>
          </div>
          <div className="text-right">
            <p className="money font-medium text-ink">
              {transaction.direction === 'DEBIT' ? '−' : '+'}{formatPoisha(transaction.amountPoisha)}
            </p>
            <p className={`mt-1 text-xs uppercase tracking-wider ${transaction.status === 'FAILED' ? 'text-danger' : 'text-muted'}`}>
              {transaction.optimistic ? 'Sending…' : transaction.status.toLowerCase()}
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}
