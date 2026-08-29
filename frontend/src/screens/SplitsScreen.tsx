import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { PinEntryModal } from '../components/security/PinEntryModal'
import { ErrorState, LoadingState } from '../components/wallet/QueryState'
import { walletApi } from '../lib/api/walletApi'
import { getErrorMessage } from '../lib/api/getErrorMessage'
import type { BillSplit, OwedShare, UserResult } from '../lib/api/walletTypes'
import { formatPoisha, takaToPoisha } from '../lib/money'
import { queryKeys } from '../lib/query'

type ParticipantRowValue = { selected: UserResult | null; amount: string }
type ParticipantRow = { key: string } & ParticipantRowValue

function emptyRow(): ParticipantRow {
  return { key: crypto.randomUUID(), selected: null, amount: '' }
}

function ParticipantField({
  index,
  value,
  onChange,
  onRemove,
  canRemove,
}: {
  index: number
  value: ParticipantRowValue
  onChange: (next: ParticipantRowValue) => void
  onRemove: () => void
  canRemove: boolean
}) {
  const [search, setSearch] = useState(value.selected?.name ?? '')

  const users = useQuery({
    queryKey: ['user-search', search],
    queryFn: () => walletApi.searchUsers(search.trim()),
    enabled: search.trim().length >= 2 && !value.selected,
    staleTime: 30_000,
  })

  return (
    <div className="grid gap-3 border-b border-line py-5 sm:grid-cols-[1fr_10rem_auto] sm:items-start">
      <div>
        <label className="field-label" htmlFor={`participant-${index}`}>
          Participant {index + 1}
        </label>
        <input
          id={`participant-${index}`}
          className="field-input"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            onChange({ selected: null, amount: value.amount })
          }}
          placeholder="Search by name, email, phone, or ID"
          autoComplete="off"
        />
        {users.data && search.length >= 2 && !value.selected && (
          <ul className="mt-2 divide-y divide-line border border-line">
            {users.data.map((user) => (
              <li key={user.id}>
                <button
                  type="button"
                  className="flex min-h-12 w-full items-center justify-between bg-canvas px-4 text-left hover:bg-line"
                  onClick={() => {
                    setSearch(user.name)
                    onChange({ selected: user, amount: value.amount })
                  }}
                >
                  <span className="font-medium text-ink">{user.name}</span>
                  <span className="text-sm text-muted">{user.email}</span>
                </button>
              </li>
            ))}
            {!users.data.length && <li className="p-4 text-sm text-muted">No matching users.</li>}
          </ul>
        )}
      </div>
      <div>
        <label className="field-label" htmlFor={`amount-${index}`}>
          Share
        </label>
        <div className="flex border border-line focus-within:border-ink focus-within:ring-1 focus-within:ring-ink">
          <span className="grid min-h-12 place-items-center border-r border-line px-3 text-sm font-semibold">
            ৳
          </span>
          <input
            id={`amount-${index}`}
            className="money min-w-0 flex-1 border-0 px-3 text-base outline-none"
            inputMode="decimal"
            value={value.amount}
            onChange={(event) => onChange({ selected: value.selected, amount: event.target.value })}
            placeholder="0.00"
          />
        </div>
      </div>
      <button
        type="button"
        className="button-secondary mt-7"
        onClick={onRemove}
        disabled={!canRemove}
        aria-label={`Remove participant ${index + 1}`}
      >
        Remove
      </button>
    </div>
  )
}

function statusLabel(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase()
}

function CreateSplitForm() {
  const queryClient = useQueryClient()
  const [description, setDescription] = useState('')
  const [totalAmount, setTotalAmount] = useState('')
  const [rows, setRows] = useState<ParticipantRow[]>([emptyRow()])
  const [formError, setFormError] = useState('')

  const create = useMutation({
    mutationFn: walletApi.createBillSplit,
    onSuccess: () => {
      setDescription('')
      setTotalAmount('')
      setRows([emptyRow()])
      setFormError('')
      void queryClient.invalidateQueries({ queryKey: queryKeys.billSplits })
    },
    onError: (error) => setFormError(getErrorMessage(error, 'The split could not be created.')),
  })

  function updateRow(key: string, next: ParticipantRowValue) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...next } : row)))
  }

  function removeRow(key: string) {
    setRows((current) => (current.length > 1 ? current.filter((row) => row.key !== key) : current))
  }

  // A live preview only — not the source of truth. An unparsable amount
  // contributes 0 here; submit() below validates every row for real and
  // reports the specific problem rather than relying on this total to catch it.
  const totalPoisha = takaToPoisha(totalAmount)
  const sharesSumPoisha = rows.reduce((sum, row) => {
    const poisha = row.amount ? takaToPoisha(row.amount) : null
    return poisha ? sum + BigInt(poisha) : sum
  }, 0n)
  const totalsMatch = totalPoisha !== null && BigInt(totalPoisha) === sharesSumPoisha

  function submit(event: FormEvent) {
    event.preventDefault()
    setFormError('')

    if (totalPoisha === null) {
      setFormError('Enter a total amount greater than zero.')
      return
    }
    const participants = rows.filter((row) => row.selected !== null || row.amount !== '')
    if (participants.length === 0) {
      setFormError('Add at least one person to split with.')
      return
    }
    const shares: { payerId: string; amountPoisha: string }[] = []
    for (const row of participants) {
      if (!row.selected) {
        setFormError('Select a person from the search results for every row.')
        return
      }
      const amount = takaToPoisha(row.amount)
      if (!amount) {
        setFormError('Enter a positive share amount for every participant.')
        return
      }
      shares.push({ payerId: row.selected.id, amountPoisha: amount })
    }
    if (!totalsMatch) {
      setFormError('The shares must add up to the total amount exactly.')
      return
    }

    create.mutate({ totalAmountPoisha: totalPoisha, description: description.trim() || undefined, shares })
  }

  return (
    <form className="mt-8 space-y-6" onSubmit={submit}>
      {formError && <ErrorState message={formError} />}

      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <label className="field-label" htmlFor="split-total">
            Total amount
          </label>
          <div className="flex border border-line focus-within:border-ink focus-within:ring-1 focus-within:ring-ink">
            <span className="grid min-h-14 place-items-center border-r border-line px-4 font-semibold">৳</span>
            <input
              id="split-total"
              className="money min-w-0 flex-1 border-0 px-4 text-xl outline-none"
              inputMode="decimal"
              value={totalAmount}
              onChange={(event) => setTotalAmount(event.target.value)}
              placeholder="0.00"
            />
          </div>
        </div>
        <div>
          <label className="field-label" htmlFor="split-description">
            What's it for? (optional)
          </label>
          <input
            id="split-description"
            className="field-input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Dinner, trip, rent…"
            maxLength={255}
          />
        </div>
      </div>

      <div>
        {rows.map((row, index) => (
          <ParticipantField
            key={row.key}
            index={index}
            value={row}
            onChange={(next) => updateRow(row.key, next)}
            onRemove={() => removeRow(row.key)}
            canRemove={rows.length > 1}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <button type="button" className="button-secondary" onClick={() => setRows((current) => [...current, emptyRow()])}>
          Add participant
        </button>
        <p className="text-sm text-muted">
          Shares: <span className={`money font-semibold ${totalsMatch ? 'text-ink' : 'text-danger'}`}>{formatPoisha(sharesSumPoisha ?? 0n)}</span>
          {' of '}
          <span className="money font-semibold text-ink">{formatPoisha(totalPoisha ?? 0n)}</span>
        </p>
      </div>

      <button className="button-primary w-full sm:w-auto" type="submit" disabled={create.isPending}>
        {create.isPending ? 'Creating…' : 'Create split'}
      </button>
    </form>
  )
}

function OwnedSplitCard({ split }: { split: BillSplit }) {
  return (
    <li className="border-b border-line py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-semibold text-ink">{split.description || split.reference}</p>
          <p className="mt-1 text-sm text-muted">
            {split.reference} · {new Date(split.createdAt).toLocaleDateString()}
          </p>
        </div>
        <div className="text-right">
          <p className="money text-xl font-semibold">{formatPoisha(split.totalAmountPoisha)}</p>
          <span className="text-xs font-semibold uppercase tracking-widest text-muted">{statusLabel(split.status)}</span>
        </div>
      </div>
      <ul className="mt-4 space-y-2">
        {split.shares.map((share) => (
          <li key={share.id} className="flex items-center justify-between text-sm">
            <span className="text-charcoal">{share.payer.name}</span>
            <span className="flex items-center gap-3">
              <span className="money">{formatPoisha(share.amountPoisha)}</span>
              <span
                className={`text-xs font-semibold uppercase tracking-wider ${share.status === 'PAID' ? 'text-muted' : 'text-ink'}`}
              >
                {statusLabel(share.status)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </li>
  )
}

function OwedShareRow({ owed, onPay }: { owed: OwedShare; onPay: (owed: OwedShare) => void }) {
  return (
    <li className="grid gap-4 border-b border-line py-6 md:grid-cols-[1fr_auto] md:items-center">
      <div>
        <p className="font-semibold text-ink">{owed.split.creator.name}</p>
        <p className="mt-1 text-sm text-muted">
          {owed.split.description || owed.split.reference} · {new Date(owed.createdAt).toLocaleDateString()}
        </p>
        <p className="money mt-3 text-xl font-semibold">{formatPoisha(owed.amountPoisha)}</p>
      </div>
      {owed.status === 'PENDING' ? (
        <button className="button-primary" onClick={() => onPay(owed)}>
          Pay my share
        </button>
      ) : (
        <span className="text-xs font-semibold uppercase tracking-widest text-muted">{statusLabel(owed.status)}</span>
      )}
    </li>
  )
}

export function SplitsScreen() {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: queryKeys.billSplits, queryFn: walletApi.billSplits })
  const [pendingPay, setPendingPay] = useState<OwedShare | null>(null)

  const pay = useMutation({
    mutationFn: ({ owed, pin }: { owed: OwedShare; pin: string }) => walletApi.payBillSplitShare(owed.split.id, pin),
    onSuccess: () => {
      setPendingPay(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.billSplits })
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      void queryClient.invalidateQueries({ queryKey: ['transactions'] })
    },
  })

  return (
    <section aria-labelledby="splits-title">
      <p className="eyebrow">Shared payments</p>
      <h1 id="splits-title" className="page-title">
        Split a bill
      </h1>
      <p className="page-intro">
        Create a bill, add the people who owe a part of it, and collect each share as a normal, fully authorized
        payment. Once every share is paid, the bill is settled.
      </p>

      <CreateSplitForm />

      <div className="mt-14">
        <h2 className="text-xl font-semibold tracking-tight text-ink">Splits I created</h2>
        {query.isLoading ? (
          <LoadingState label="Loading splits…" />
        ) : query.isError || !query.data ? (
          <ErrorState message="We could not load your splits." onRetry={() => void query.refetch()} />
        ) : query.data.owned.length === 0 ? (
          <p className="empty-state">You haven't created a split yet.</p>
        ) : (
          <ul className="mt-4">
            {query.data.owned.map((split) => (
              <OwnedSplitCard key={split.id} split={split} />
            ))}
          </ul>
        )}
      </div>

      <div className="mt-14">
        <h2 className="text-xl font-semibold tracking-tight text-ink">Bills I owe</h2>
        {query.isLoading ? null : query.isError || !query.data ? null : query.data.owedByMe.length === 0 ? (
          <p className="empty-state">Nobody has billed you for a split yet.</p>
        ) : (
          <ul className="mt-4">
            {query.data.owedByMe.map((owed) => (
              <OwedShareRow key={owed.id} owed={owed} onPay={setPendingPay} />
            ))}
          </ul>
        )}
      </div>

      <PinEntryModal
        open={Boolean(pendingPay)}
        title="Authorize payment"
        description={pendingPay ? `Pay ${formatPoisha(pendingPay.amountPoisha)} to ${pendingPay.split.creator.name}.` : undefined}
        submitting={pay.isPending}
        error={pay.isError ? getErrorMessage(pay.error, 'This share could not be paid. Check your PIN or balance and retry.') : undefined}
        onCancel={() => !pay.isPending && setPendingPay(null)}
        onConfirm={(pin) => {
          if (pendingPay) pay.mutate({ owed: pendingPay, pin })
        }}
      />
    </section>
  )
}
