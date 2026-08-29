import { useInfiniteQuery } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { ErrorState, LoadingState } from '../components/wallet/QueryState'
import { walletApi } from '../lib/api/walletApi'
import { formatPoisha } from '../lib/money'
import { queryKeys } from '../lib/query'

type Filters = { direction: string; status: string; from: string; to: string }
const initialFilters: Filters = { direction: '', status: '', from: '', to: '' }

export function HistoryScreen() {
  const [filters, setFilters] = useState<Filters>(initialFilters)
  const [applied, setApplied] = useState<Filters>(initialFilters)
  const query = useInfiniteQuery({
    queryKey: queryKeys.transactions(applied),
    queryFn: ({ pageParam }) => walletApi.transactions({ cursor: pageParam, ...applied }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })
  const transactions = query.data?.pages.flatMap((page) => page.items) ?? []

  function apply(event: FormEvent) {
    event.preventDefault()
    setApplied(filters)
  }

  return (
    <section aria-labelledby="history-title">
      <p className="eyebrow">Ledger statement</p>
      <h1 id="history-title" className="page-title">Transaction history</h1>
      <form className="mt-8 grid gap-4 border-y border-line py-5 sm:grid-cols-2 lg:grid-cols-5 lg:items-end" onSubmit={apply}>
        <label className="text-sm font-medium">Direction<select className="field-input mt-2" value={filters.direction} onChange={(event) => setFilters({ ...filters, direction: event.target.value })}><option value="">All</option><option value="CREDIT">Incoming</option><option value="DEBIT">Outgoing</option></select></label>
        <label className="text-sm font-medium">Status<select className="field-input mt-2" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">All</option><option value="SUCCESS">Success</option><option value="PENDING">Pending</option><option value="FAILED">Failed</option></select></label>
        <label className="text-sm font-medium">From<input className="field-input mt-2" type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
        <label className="text-sm font-medium">To<input className="field-input mt-2" type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
        <button className="button-primary" type="submit">Apply filters</button>
      </form>

      {query.isLoading ? <LoadingState label="Loading statement…" /> : query.isError ? <ErrorState message="We could not load your statement." onRetry={() => void query.refetch()} /> : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[48rem] border-collapse text-left text-sm">
            <caption className="sr-only">Transaction ledger statement</caption>
            <thead><tr className="border-b border-ink text-xs uppercase tracking-widest text-muted"><th className="px-2 py-3 font-semibold">Date</th><th className="px-2 py-3 font-semibold">Reference / counterparty</th><th className="px-2 py-3 font-semibold">Status</th><th className="px-2 py-3 text-right font-semibold">Debit</th><th className="px-2 py-3 text-right font-semibold">Credit</th></tr></thead>
            <tbody className="divide-y divide-line">
              {transactions.map((transaction) => (
                <tr key={transaction.id}>
                  <td className="whitespace-nowrap px-2 py-5 text-muted">{new Date(transaction.createdAt).toLocaleString()}</td>
                  <td className="px-2 py-5"><p className="font-medium text-ink">{transaction.counterpartyName}</p><p className="mt-1 text-xs text-muted">{transaction.reference}{transaction.note ? ` · ${transaction.note}` : ''}</p></td>
                  <td className={`px-2 py-5 text-xs font-semibold uppercase tracking-wider ${transaction.status === 'FAILED' ? 'text-danger' : 'text-muted'}`}>{transaction.status}</td>
                  <td className="money whitespace-nowrap px-2 py-5 text-right">{transaction.direction === 'DEBIT' ? formatPoisha(transaction.amountPoisha) : '—'}</td>
                  <td className="money whitespace-nowrap px-2 py-5 text-right">{transaction.direction === 'CREDIT' ? formatPoisha(transaction.amountPoisha) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!transactions.length && <p className="empty-state">No transactions match these filters.</p>}
          {query.hasNextPage && <div className="mt-6 text-center"><button className="button-secondary" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading…' : 'Load more'}</button></div>}
        </div>
      )}
    </section>
  )
}
