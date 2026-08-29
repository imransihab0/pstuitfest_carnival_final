import type { InputHTMLAttributes } from 'react'

type AuthFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string
  error?: string
  hint?: string
}

export function AuthField({ label, error, hint, id, ...props }: AuthFieldProps) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined

  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-charcoal" htmlFor={id}>{label}</label>
      <input
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        className={`min-h-12 w-full rounded-none border bg-canvas px-4 text-base text-ink outline-none transition-colors placeholder:text-muted focus:border-ink focus:ring-1 focus:ring-ink ${error ? 'border-danger' : 'border-line'}`}
        {...props}
      />
      {hint && <p id={`${id}-hint`} className="mt-2 text-xs leading-5 text-muted">{hint}</p>}
      {error && <p id={`${id}-error`} className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  )
}
