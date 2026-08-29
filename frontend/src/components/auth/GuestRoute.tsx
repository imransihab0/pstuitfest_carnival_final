import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../../lib/auth/useAuth'
import { AuthLoader } from './AuthLoader'

export function GuestRoute() {
  const { status } = useAuth()

  if (status === 'loading') return <AuthLoader />
  if (status === 'authenticated') return <Navigate to="/" replace />
  return <Outlet />
}
