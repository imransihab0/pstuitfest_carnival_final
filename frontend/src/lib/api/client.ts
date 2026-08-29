import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { tokenStore } from '../auth/tokenStore'

const baseURL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

type RetryableRequest = InternalAxiosRequestConfig & { _retry?: boolean }
type RefreshResponse = { accessToken: string }

const refreshClient = axios.create({ baseURL, withCredentials: true })

export const apiClient = axios.create({
  baseURL,
  withCredentials: true,
  headers: { Accept: 'application/json' },
})

let refreshInFlight: Promise<string> | null = null

async function refreshAccessToken(): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = refreshClient
      .post<RefreshResponse>('/auth/refresh')
      .then(({ data }) => {
        tokenStore.setAccessToken(data.accessToken)
        return data.accessToken
      })
      .finally(() => {
        refreshInFlight = null
      })
  }

  return refreshInFlight
}

apiClient.interceptors.request.use((config) => {
  const accessToken = tokenStore.getAccessToken()

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
      const accessToken = await refreshAccessToken()
      request.headers.Authorization = `Bearer ${accessToken}`
      return apiClient(request)
    } catch (refreshError) {
      tokenStore.clearAccessToken()
      window.dispatchEvent(new CustomEvent('auth:session-expired'))
      return Promise.reject(refreshError)
    }
  },
)
