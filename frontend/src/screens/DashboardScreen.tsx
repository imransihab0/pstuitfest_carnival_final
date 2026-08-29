import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ActivityList } from '../components/wallet/ActivityList'
import { AnimatedBalance } from '../components/wallet/AnimatedBalance'
import { ErrorState, LoadingState } from '../components/wallet/QueryState'
import { walletApi } from '../lib/api/walletApi'
import { queryKeys } from '../lib/query'

export function DashboardScreen() {
  const query = useQuery({ queryKey: queryKeys.dashboard, queryFn: walletApi.dashboard })

  if (query.isLoading) return <LoadingState label="Loading your wallet…" />
  if (query.isError || !query.data) return <ErrorState message="We could not load your wallet." onRetry={() => void query.refetch()} />

  return (
    <div>
      <section className="border-b border-line pb-10" aria-labelledby="balance-title">
        <p id="balance-title" className="eyebrow">Available balance</p>
        <p className="money mt-4 text-4xl font-semibold tracking-tight text-ink sm:text-6xl">
          <AnimatedBalance balancePoisha={query.data.balancePoisha} />
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link className="button-primary" to="/send">Send money</Link>
          <Link className="button-secondary" to="/requests">View requests</Link>
        </div>
      </section>

      <section className="pt-10" aria-labelledby="activity-title">
        <div className="flex items-end justify-between gap-4">
          <div><p className="eyebrow">Ledger</p><h1 id="activity-title" className="mt-2 text-2xl font-semibold text-ink">Recent activity</h1></div>
          <Link className="text-sm font-semibold underline decoration-line underline-offset-4" to="/history">Full statement</Link>
        </div>
        <div className="mt-5"><ActivityList transactions={query.data.recentActivity.slice(0, 8)} /></div>
      </section>
    </div>
  )
}
