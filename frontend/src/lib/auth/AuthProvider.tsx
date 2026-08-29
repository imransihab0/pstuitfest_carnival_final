import { useCallback, useEffect, useMemo, useState, type PropsWithChildren } from 'react'
import { apiClient } from '../api/client'
import { AuthContext, type AuthStatus } from './AuthContext'
import type { AuthUser, LoginPayload, LoginResponse, RegisterPayload, RegisterResponse } from './authTypes'
import { setAccessToken, setRefreshToken } from './accessToken'

export function AuthProvider({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<AuthStatus>('anonymous')
  const [user, setUser] = useState<AuthUser | null>(null)

  const acceptSession = useCallback((session: LoginResponse) => {
    setAccessToken(session.accessToken)
    setRefreshToken(session.refreshToken)
    setUser({ id: session.userId, username: session.username, name: session.username })
    setStatus('authenticated')
  }, [])

  const clearSession = useCallback(() => {
    setAccessToken(null)
    setRefreshToken(null)
    setUser(null)
    setStatus('anonymous')
  }, [])

  useEffect(() => {
    window.addEventListener('auth:session-expired', clearSession)
    return () => window.removeEventListener('auth:session-expired', clearSession)
  }, [acceptSession, clearSession])

  const login = useCallback(async (payload: LoginPayload) => {
    const { data } = await apiClient.post<LoginResponse>('/auth/login', payload)
    acceptSession(data)
  }, [acceptSession])

  const register = useCallback(async (payload: RegisterPayload) => {
    await apiClient.post<RegisterResponse>('/auth/register', payload)
    const { data } = await apiClient.post<LoginResponse>('/auth/login', {
      identifier: payload.email,
      password: payload.password,
    } satisfies LoginPayload)
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
