import { useEffect, useId, useRef, useState, type FormEvent } from 'react'

type PinEntryModalProps = {
  open: boolean
  title?: string
  description?: string
  submitting?: boolean
  error?: string
  onConfirm: (pin: string) => void | Promise<void>
  onCancel: () => void
}

export function PinEntryModal({
  open,
  title = 'Confirm with your PIN',
  description = 'Enter your 4-digit transaction PIN to authorize this action.',
  submitting = false,
  error,
  onConfirm,
  onCancel,
}: PinEntryModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [pin, setPin] = useState('')
  const descriptionId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (open && !dialog.open) {
      setPin('')
      dialog.showModal()
      requestAnimationFrame(() => inputRef.current?.focus())
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (/^\d{4}$/.test(pin)) void onConfirm(pin)
  }

  return (
    <dialog
      ref={dialogRef}
      aria-describedby={descriptionId}
      className="m-auto w-[calc(100%-2rem)] max-w-md border border-line bg-canvas p-0 text-charcoal backdrop:bg-ink/70"
      onCancel={(event) => {
        if (submitting) event.preventDefault()
        else onCancel()
      }}
      onClose={() => {
        if (open && !submitting) onCancel()
      }}
    >
      <form className="p-6 sm:p-8" onSubmit={submit}>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Authorization</p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight text-ink">{title}</h2>
        <p id={descriptionId} className="mt-3 text-sm leading-6 text-muted">{description}</p>

        <label className="mt-7 block text-sm font-medium" htmlFor="transaction-pin">Transaction PIN</label>
        <input
          ref={inputRef}
          id="transaction-pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          pattern="[0-9]{4}"
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
          className={`money mt-2 min-h-14 w-full border bg-canvas px-4 text-center text-2xl tracking-[0.5em] outline-none focus:border-ink focus:ring-1 focus:ring-ink ${error ? 'border-danger' : 'border-line'}`}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'pin-modal-error' : undefined}
          disabled={submitting}
        />
        {error && <p id="pin-modal-error" className="mt-2 text-sm text-danger" role="alert">{error}</p>}

        <div className="mt-8 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button className="button-secondary" type="button" onClick={onCancel} disabled={submitting}>Cancel</button>
          <button className="button-primary" type="submit" disabled={submitting || pin.length !== 4}>
            {submitting ? 'Confirming…' : 'Confirm'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
