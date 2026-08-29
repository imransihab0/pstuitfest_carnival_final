import { useCallback, useEffect, useMemo, useState, type PropsWithChildren } from 'react'
import { apiClient, refreshSession } from '../api/client'
import { AuthContext, type AuthStatus } from './AuthContext'
import type { AuthResponse, AuthUser, LoginPayload, RegisterPayload } from './authTypes'
import { setAccessToken } from './accessToken'

export function AuthProvider({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<AuthUser | null>(null)

  const acceptSession = useCallback((session: AuthResponse) => {
    setAccessToken(session.accessToken)
    setUser(session.user)
    setStatus('authenticated')
  }, [])

  const clearSession = useCallback(() => {
    setAccessToken(null)
    setUser(null)
    setStatus('anonymous')
  }, [])

  useEffect(() => {
    void refreshSession().then(acceptSession).catch(clearSession)

    window.addEventListener('auth:session-expired', clearSession)
    return () => window.removeEventListener('auth:session-expired', clearSession)
  }, [acceptSession, clearSession])

  const login = useCallback(async (payload: LoginPayload) => {
    const { data } = await apiClient.post<AuthResponse>('/auth/login', payload)
    acceptSession(data)
  }, [acceptSession])

  const register = useCallback(async (payload: RegisterPayload) => {
    const { data } = await apiClient.post<AuthResponse>('/auth/register', payload)
    acceptSession(data)
  }, [acceptSession])

  const logout = useCallback(async () => {
    try {
      await apiClient.post('/auth/logout')
    } finally {
      clearSession()
    }
  }, [clearSession])

  const value = useMemo(
    () => ({ status, user, login, register, logout }),
    [status, user, login, register, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
