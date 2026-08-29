import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ErrorState } from '../components/wallet/QueryState'
import { walletApi } from '../lib/api/walletApi'
import type { UserResult } from '../lib/api/walletTypes'
import { formatPoisha, takaToPoisha } from '../lib/money'
import { queryKeys } from '../lib/query'

type Intent = { requestee: UserResult; amountPoisha: string; amountInput: string; idempotencyKey: string; note: string }

export function RequestMoneyScreen() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<UserResult | null>(null)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [formError, setFormError] = useState('')

  const users = useQuery({
    queryKey: ['user-search', search],
    queryFn: () => walletApi.searchUsers(search.trim()),
    enabled: search.trim().length >= 2,
    staleTime: 30_000,
  })

  const requestMoney = useMutation({
    mutationFn: (currentIntent: Intent) => walletApi.createRequest({
      requesteeId: currentIntent.requestee.id,
      amountPoisha: currentIntent.amountPoisha,
      note: currentIntent.note,
      idempotencyKey: currentIntent.idempotencyKey,
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.requests })
      navigate('/requests')
    },
    onError: (error: any) => {
      setFormError(error?.response?.data?.message || 'Failed to create money request. Please try again.')
    }
  })

  function prepare(event: FormEvent) {
    event.preventDefault()
    const amountPoisha = takaToPoisha(amount)
    if (!selected) return setFormError('Select a user from the search results.')
    if (!amountPoisha) return setFormError('Enter a positive amount with no more than two decimal places.')
    setFormError('')
    requestMoney.mutate({ requestee: selected, amountPoisha, amountInput: amount, idempotencyKey: crypto.randomUUID(), note })
  }

  return (
    <section className="max-w-2xl" aria-labelledby="request-title">
      <p className="eyebrow">Money requests</p>
      <h1 id="request-title" className="page-title">Request money</h1>
      <p className="page-intro">Find a user, enter a BDT amount, and optionally add a note for your request.</p>
      {formError && <ErrorState message={formError} />}

      <form className="mt-8 space-y-8" onSubmit={prepare}>
        <div>
          <label className="field-label" htmlFor="user-search">Request from</label>
          <input id="user-search" className="field-input" value={search} onChange={(event) => { setSearch(event.target.value); setSelected(null) }} placeholder="Search by name, email, phone, or ID" autoComplete="off" />
          {users.isFetching && !selected && <p className="field-help">Searching…</p>}
          {users.data && search.length >= 2 && !selected && (
            <ul className="mt-2 divide-y divide-line border border-line">
              {users.data.map((user) => (
                <li key={user.id}>
                  <button type="button" className="flex min-h-14 w-full items-center justify-between bg-canvas px-4 text-left hover:bg-line" onClick={() => { setSelected(user) }}>
                    <span className="font-medium text-ink">{user.name}</span><span className="text-sm text-muted">{user.email}</span>
                  </button>
                </li>
              ))}
              {!users.data.length && <li className="p-4 text-sm text-muted">No matching users.</li>}
            </ul>
          )}
        </div>
        <div>
          <label className="field-label" htmlFor="request-amount">Amount</label>
          <div className="flex border border-line focus-within:border-ink focus-within:ring-1 focus-within:ring-ink">
            <span className="grid min-h-14 place-items-center border-r border-line px-4 font-semibold">৳</span>
            <input id="request-amount" className="money min-w-0 flex-1 border-0 px-4 text-xl outline-none" inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value) }} placeholder="0.00" />
          </div>
        </div>
        <div>
          <label className="field-label" htmlFor="request-note">Note (optional)</label>
          <input id="request-note" className="field-input" value={note} onChange={(event) => { setNote(event.target.value) }} placeholder="What is this for?" autoComplete="off" />
        </div>
        {selected && <div className="border-y border-line py-4 text-sm"><span className="text-muted">Requesting from </span><strong>{selected.name}</strong>{takaToPoisha(amount) && <span className="money float-right font-semibold">{formatPoisha(takaToPoisha(amount)!)}</span>}</div>}
        <button className="button-primary w-full sm:w-auto" type="submit" disabled={requestMoney.isPending}>{requestMoney.isPending ? 'Sending...' : 'Send request'}</button>
      </form>
    </section>
  )
}
