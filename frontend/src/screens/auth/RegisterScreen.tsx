import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AuthField } from '../../components/auth/AuthField'
import { getErrorMessage } from '../../lib/api/getErrorMessage'
import { useAuth } from '../../lib/auth/useAuth'

type Field = 'name' | 'email' | 'password' | 'pin' | 'confirmPin'
type FieldErrors = Partial<Record<Field, string>>

export function RegisterScreen() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    const email = String(form.get('email') ?? '').trim().toLowerCase()
    const password = String(form.get('password') ?? '')
    const pin = String(form.get('pin') ?? '')
    const confirmPin = String(form.get('confirmPin') ?? '')
    const nextErrors: FieldErrors = {}

    if (name.length < 2) nextErrors.name = 'Enter your full name.'
    if (!/^\S+@\S+\.\S+$/.test(email)) nextErrors.email = 'Enter a valid email address.'
    if (password.length < 8) nextErrors.password = 'Password must be at least 8 characters.'
    if (!/^\d{4}$/.test(pin)) nextErrors.pin = 'PIN must contain exactly 4 digits.'
    if (confirmPin !== pin) nextErrors.confirmPin = 'The PINs do not match.'
    setFieldErrors(nextErrors)
    setError('')
    if (Object.keys(nextErrors).length) return

    setSubmitting(true)
    try {
      await register({ name, email, password, pin })
      navigate('/', { replace: true })
    } catch (caught) {
      setError(getErrorMessage(caught, 'We could not create your account. Review your details and try again.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section aria-labelledby="register-title">
      <p className="eyebrow">Create your wallet</p>
      <h1 id="register-title" className="auth-title">Start with ৳100,000.00</h1>
      <p className="auth-intro">Your account is funded with simulated money when registration is complete.</p>

      {error && <div className="error-banner" role="alert">{error}</div>}

      <form className="mt-8 space-y-5" onSubmit={submit} noValidate>
        <AuthField id="register-name" name="name" label="Full name" autoComplete="name" placeholder="Your name" error={fieldErrors.name} />
        <AuthField id="register-email" name="email" label="Email address" type="email" autoComplete="email" placeholder="you@example.com" error={fieldErrors.email} />
        <AuthField id="register-password" name="password" label="Password" type="password" autoComplete="new-password" hint="Use at least 8 characters." error={fieldErrors.password} />
        <div className="grid gap-5 sm:grid-cols-2">
          <AuthField id="register-pin" name="pin" label="Transaction PIN" type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} pattern="[0-9]{4}" hint="Exactly 4 digits." error={fieldErrors.pin} />
          <AuthField id="register-confirm-pin" name="confirmPin" label="Confirm PIN" type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} pattern="[0-9]{4}" error={fieldErrors.confirmPin} />
        </div>
        <p className="text-xs leading-5 text-muted">Your transaction PIN authorizes money-moving actions. Do not reuse your password.</p>
        <button className="button-primary w-full" type="submit" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="mt-8 text-sm text-muted">
        Already registered?{' '}
        <Link className="font-semibold text-ink underline decoration-line underline-offset-4 hover:decoration-ink" to="/login">Sign in</Link>
      </p>
    </section>
  )
}
