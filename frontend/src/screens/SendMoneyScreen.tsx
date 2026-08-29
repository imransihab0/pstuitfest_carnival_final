import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { PinEntryModal } from '../components/security/PinEntryModal'
import { ErrorState } from '../components/wallet/QueryState'
import { walletApi } from '../lib/api/walletApi'
import type { AccountSummary, UserResult } from '../lib/api/walletTypes'
import { formatPoisha, takaToPoisha } from '../lib/money'
import { queryKeys } from '../lib/query'

type Intent = { recipient: UserResult; amountPoisha: string; amountInput: string; idempotencyKey: string }

export function SendMoneyScreen() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<UserResult | null>(null)
  const [amount, setAmount] = useState('')
  const [intent, setIntent] = useState<Intent | null>(null)
  const [formError, setFormError] = useState('')

  const users = useQuery({
    queryKey: ['user-search', search],
    queryFn: () => walletApi.searchUsers(search.trim()),
    enabled: search.trim().length >= 2,
    staleTime: 30_000,
  })

  const transfer = useMutation({
    mutationFn: ({ pin, currentIntent }: { pin: string; currentIntent: Intent }) => walletApi.sendMoney({
      recipientId: currentIntent.recipient.id,
      amountPoisha: currentIntent.amountPoisha,
      pin,
      idempotencyKey: currentIntent.idempotencyKey,
    }),
    onMutate: async ({ currentIntent }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.dashboard })
      const previous = queryClient.getQueryData<AccountSummary>(queryKeys.dashboard)
      if (previous) {
        queryClient.setQueryData<AccountSummary>(queryKeys.dashboard, {
          balancePoisha: (BigInt(previous.balancePoisha) - BigInt(currentIntent.amountPoisha)).toString(),
          recentActivity: [{
            id: `optimistic-${currentIntent.idempotencyKey}`,
            reference: currentIntent.idempotencyKey,
            amountPoisha: currentIntent.amountPoisha,
            direction: 'DEBIT',
            counterpartyName: currentIntent.recipient.name,
            status: 'PENDING',
            createdAt: new Date().toISOString(),
            optimistic: true,
          }, ...previous.recentActivity],
        })
      }
      return { previous }
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.dashboard, context.previous)
    },
    onSuccess: (data) => {
      queryClient.setQueryData<AccountSummary>(queryKeys.dashboard, (current) => ({
        balancePoisha: data.balancePoisha,
        recentActivity: current
          ? [data.transaction, ...current.recentActivity.filter((item) => !item.optimistic && item.id !== data.transaction.id)]
          : [data.transaction],
      }))
      void queryClient.invalidateQueries({ queryKey: ['transactions'] })
      setIntent(null)
      setSelected(null)
      setAmount('')
      setSearch('')
    },
  })

  function prepare(event: FormEvent) {
    event.preventDefault()
    const amountPoisha = takaToPoisha(amount)
    if (!selected) return setFormError('Select a recipient from the search results.')
    if (!amountPoisha) return setFormError('Enter a positive amount with no more than two decimal places.')
    setFormError('')
    setIntent({ recipient: selected, amountPoisha, amountInput: amount, idempotencyKey: crypto.randomUUID() })
  }

  function resetIntent() {
    if (!transfer.isPending) setIntent(null)
  }

  return (
    <section className="max-w-2xl" aria-labelledby="send-title">
      <p className="eyebrow">Transfer</p>
      <h1 id="send-title" className="page-title">Send money</h1>
      <p className="page-intro">Find a recipient, enter a BDT amount, then authorize it with your transaction PIN.</p>
      {formError && <ErrorState message={formError} />}

      <form className="mt-8 space-y-8" onSubmit={prepare}>
        <div>
          <label className="field-label" htmlFor="recipient-search">Recipient</label>
          <input id="recipient-search" className="field-input" value={search} onChange={(event) => { setSearch(event.target.value); setSelected(null); setIntent(null) }} placeholder="Search by name, email, phone, or ID" autoComplete="off" />
          {users.isFetching && <p className="field-help">Searching…</p>}
          {users.data && search.length >= 2 && (
            <ul className="mt-2 divide-y divide-line border border-line">
              {users.data.map((user) => (
                <li key={user.id}>
                  <button type="button" className={`flex min-h-14 w-full items-center justify-between px-4 text-left hover:bg-line ${selected?.id === user.id ? 'bg-line' : 'bg-canvas'}`} onClick={() => { setSelected(user); setIntent(null) }}>
                    <span className="font-medium text-ink">{user.name}</span><span className="text-sm text-muted">{user.email}</span>
                  </button>
                </li>
              ))}
              {!users.data.length && <li className="p-4 text-sm text-muted">No matching users.</li>}
            </ul>
          )}
        </div>
        <div>
          <label className="field-label" htmlFor="send-amount">Amount</label>
          <div className="flex border border-line focus-within:border-ink focus-within:ring-1 focus-within:ring-ink">
            <span className="grid min-h-14 place-items-center border-r border-line px-4 font-semibold">৳</span>
            <input id="send-amount" className="money min-w-0 flex-1 border-0 px-4 text-xl outline-none" inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); setIntent(null) }} placeholder="0.00" />
          </div>
          <p className="field-help">Converted to integer poisha before submission. Floating-point arithmetic is never used.</p>
        </div>
        {selected && <div className="border-y border-line py-4 text-sm"><span className="text-muted">Sending to </span><strong>{selected.name}</strong>{takaToPoisha(amount) && <span className="money float-right font-semibold">{formatPoisha(takaToPoisha(amount)!)}</span>}</div>}
        <button className="button-primary w-full sm:w-auto" type="submit">Review and confirm</button>
      </form>

      <PinEntryModal
        open={Boolean(intent)}
        title="Authorize transfer"
        description={intent ? `Send ${formatPoisha(intent.amountPoisha)} to ${intent.recipient.name}.` : undefined}
        submitting={transfer.isPending}
        error={transfer.isError ? 'Transfer failed. Check your PIN or balance, then retry. The same idempotency key will be reused.' : undefined}
        onCancel={resetIntent}
        onConfirm={(pin) => {
          if (intent) transfer.mutate({ pin, currentIntent: intent })
        }}
      />
    </section>
  )
}
