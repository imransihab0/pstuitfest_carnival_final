import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { getAccessToken, setAccessToken } from '../auth/accessToken'
import type { AuthResponse } from '../auth/authTypes'

const baseURL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

type RetryableRequest = InternalAxiosRequestConfig & { _retry?: boolean }
const refreshClient = axios.create({ baseURL, withCredentials: true })

export const apiClient = axios.create({
  baseURL,
  withCredentials: true,
  headers: { Accept: 'application/json' },
})

let refreshInFlight: Promise<AuthResponse> | null = null

export async function refreshSession(): Promise<AuthResponse> {
  if (!refreshInFlight) {
    refreshInFlight = refreshClient
      .post<AuthResponse>('/auth/refresh')
      .then(({ data }) => {
        setAccessToken(data.accessToken)
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
      window.dispatchEvent(new CustomEvent('auth:session-expired'))
      return Promise.reject(refreshError)
    }
  },
)
