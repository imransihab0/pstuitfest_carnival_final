import axios from 'axios'

export function getErrorMessage(error: unknown, fallback: string): string {
  if (!axios.isAxiosError(error)) return fallback

  const data: unknown = error.response?.data
  if (typeof data === 'object' && data && 'message' in data) {
    const message = (data as { message: unknown }).message
    if (typeof message === 'string') return message
    if (Array.isArray(message) && typeof message[0] === 'string') return message[0]
  }

  return error.response ? fallback : 'Unable to reach the server. Check your connection and try again.'
}
