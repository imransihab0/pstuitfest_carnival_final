import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AuthField } from '../../components/auth/AuthField'
import { getErrorMessage } from '../../lib/api/getErrorMessage'
import { useAuth } from '../../lib/auth/useAuth'

type FieldErrors = Partial<Record<'identifier' | 'password', string>>

export function LoginScreen() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const identifier = String(form.get('identifier') ?? '').trim()
    const password = String(form.get('password') ?? '')
    const nextErrors: FieldErrors = {}

    if (!identifier) nextErrors.identifier = 'Enter your email, username, or phone.'
    if (!password) nextErrors.password = 'Enter your password.'
    setFieldErrors(nextErrors)
    setError('')
    if (Object.keys(nextErrors).length) return

    setSubmitting(true)
    try {
      await login({ identifier, password })
      const destination = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/'
      navigate(destination, { replace: true })
    } catch (caught) {
      setError(getErrorMessage(caught, 'Email or password is incorrect.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section aria-labelledby="login-title">
      <p className="eyebrow">Welcome back</p>
      <h1 id="login-title" className="auth-title">Sign in to your wallet</h1>
      <p className="auth-intro">Use your email, username, or phone and your account password.</p>

      {error && <div className="error-banner" role="alert">{error}</div>}

      <form className="mt-8 space-y-5" onSubmit={submit} noValidate>
        <AuthField id="login-identifier" name="identifier" label="Email, username, or phone" autoComplete="username" placeholder="you@example.com" error={fieldErrors.identifier} />
        <AuthField id="login-password" name="password" label="Password" type="password" autoComplete="current-password" error={fieldErrors.password} />
        <button className="button-primary w-full" type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="mt-8 text-sm text-muted">
        New to PSTU Money?{' '}
        <Link className="font-semibold text-ink underline decoration-line underline-offset-4 hover:decoration-ink" to="/register">Create an account</Link>
      </p>
    </section>
  )
}
