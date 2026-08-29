import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { getAccessToken, getRefreshToken, setAccessToken, setRefreshToken } from '../auth/accessToken'
import type { RefreshResponse } from '../auth/authTypes'

const baseURL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1'

type RetryableRequest = InternalAxiosRequestConfig & { _retry?: boolean }
const refreshClient = axios.create({ baseURL, withCredentials: true })

export const apiClient = axios.create({
  baseURL,
  withCredentials: true,
  headers: { Accept: 'application/json' },
})

let refreshInFlight: Promise<RefreshResponse> | null = null

export async function refreshSession(): Promise<RefreshResponse> {
  const refreshToken = getRefreshToken()
  if (!refreshToken) throw new Error('No refresh token is available.')

  if (!refreshInFlight) {
    refreshInFlight = refreshClient
      .post<RefreshResponse>('/auth/refresh', { refreshToken })
      .then(({ data }) => {
        setAccessToken(data.accessToken)
        setRefreshToken(data.refreshToken)
        return data
      })
      .finally(() => {
        refreshInFlight = null
      })
  }

  return refreshInFlight
}

apiClient.interceptors.request.use((config) => {
  const accessToken = getAccessToken()

  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`
  }

  return config
})

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const request = error.config as RetryableRequest | undefined

    if (error.response?.status !== 401 || !request || request._retry) {
      return Promise.reject(error)
    }

    request._retry = true

    try {
      const session = await refreshSession()
      request.headers.Authorization = `Bearer ${session.accessToken}`
      return apiClient(request)
    } catch (refreshError) {
      setAccessToken(null)
      setRefreshToken(null)
      window.dispatchEvent(new CustomEvent('auth:session-expired'))
      return Promise.reject(refreshError)
    }
  },
)
