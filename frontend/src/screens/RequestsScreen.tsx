import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { PinEntryModal } from '../components/security/PinEntryModal'
import { ErrorState, LoadingState } from '../components/wallet/QueryState'
import { walletApi } from '../lib/api/walletApi'
import type { MoneyRequest, RequestsResponse } from '../lib/api/walletTypes'
import { formatPoisha } from '../lib/money'
import { queryKeys } from '../lib/query'

import { Link } from 'react-router-dom'

type RequestAction = { request: MoneyRequest; action: 'accept' | 'reject'; idempotencyKey?: string }

export function RequestsScreen() {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: queryKeys.requests, queryFn: walletApi.requests })
  const [tab, setTab] = useState<'incoming' | 'outgoing'>('incoming')
  const [pendingAction, setPendingAction] = useState<RequestAction | null>(null)

  const mutation = useMutation({
    mutationFn: ({ action, request, pin, idempotencyKey }: RequestAction & { pin?: string }) =>
      walletApi.updateRequest(request.id, action, pin, idempotencyKey),
    onMutate: async ({ request, action }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.requests })
      const previous = queryClient.getQueryData<RequestsResponse>(queryKeys.requests)
      queryClient.setQueryData<RequestsResponse>(queryKeys.requests, (current) => current ? {
        ...current,
        incoming: current.incoming.map((item) => item.id === request.id
          ? { ...item, status: action === 'accept' ? 'ACCEPTED' : 'REJECTED' }
          : item),
      } : current)
      return { previous }
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.requests, context.previous)
    },
    onSuccess: (data) => {
      queryClient.setQueryData<RequestsResponse>(queryKeys.requests, (current) => current ? {
        ...current,
        incoming: current.incoming.map((item) => item.id === data.request.id ? data.request : item),
      } : current)
      setPendingAction(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      void queryClient.invalidateQueries({ queryKey: ['transactions'] })
    },
  })

  function act(request: MoneyRequest, action: 'accept' | 'reject') {
    if (action === 'accept') {
      setPendingAction({ request, action, idempotencyKey: crypto.randomUUID() })
    } else {
      mutation.mutate({ request, action })
    }
  }

  if (query.isLoading) return <LoadingState label="Loading requests…" />
  if (query.isError || !query.data) return <ErrorState message="We could not load your requests." onRetry={() => void query.refetch()} />

  const requests = query.data[tab]

  return (
    <section aria-labelledby="requests-title">
      <p className="eyebrow">Money requests</p>
      <div className="flex items-center justify-between">
        <h1 id="requests-title" className="page-title">Requests inbox</h1>
        <Link to="/requests/new" className="button-primary">Request money</Link>
      </div>
      <div className="mt-8 flex border-b border-line" role="tablist" aria-label="Request direction">
        {(['incoming', 'outgoing'] as const).map((value) => (
          <button key={value} role="tab" aria-selected={tab === value} className={`min-h-12 border-b-2 px-5 text-sm font-semibold capitalize ${tab === value ? 'border-ink text-ink' : 'border-transparent text-muted'}`} onClick={() => setTab(value)}>{value}</button>
        ))}
      </div>
      {!requests.length ? <p className="empty-state">No {tab} requests.</p> : (
        <ul className="divide-y divide-line">
          {requests.map((request) => {
            const person = tab === 'incoming' ? request.requester : request.requestee
            return (
              <li className="grid gap-4 py-6 md:grid-cols-[1fr_auto] md:items-center" key={request.id}>
                <div>
                  <p className="font-semibold text-ink">{person.name}</p>
                  <p className="mt-1 text-sm text-muted">{request.note || 'No note'} · {new Date(request.createdAt).toLocaleDateString()}</p>
                  <p className="money mt-3 text-xl font-semibold">{formatPoisha(request.amountPoisha)}</p>
                </div>
                {tab === 'incoming' && request.status === 'PENDING' ? (
                  <div className="flex gap-3">
                    <button className="button-secondary" disabled={mutation.isPending} onClick={() => act(request, 'reject')}>Decline</button>
                    <button className="button-primary" disabled={mutation.isPending} onClick={() => act(request, 'accept')}>Accept</button>
                  </div>
                ) : <span className="text-xs font-semibold uppercase tracking-widest text-muted">{request.status}</span>}
              </li>
            )
          })}
        </ul>
      )}
      <PinEntryModal
        open={Boolean(pendingAction)}
        title="Accept money request"
        description={pendingAction ? `Pay ${formatPoisha(pendingAction.request.amountPoisha)} to ${pendingAction.request.requester.name}.` : undefined}
        submitting={mutation.isPending}
        error={mutation.isError ? 'The request could not be accepted. Check your PIN or balance and retry.' : undefined}
        onCancel={() => !mutation.isPending && setPendingAction(null)}
        onConfirm={(pin) => {
          if (pendingAction) mutation.mutate({ ...pendingAction, pin })
        }}
      />
    </section>
  )
}
