import axios from 'axios'

export function getErrorMessage(error: unknown, fallback: string): string {
  if (!axios.isAxiosError(error)) return fallback

  if (!error.response) {
    return 'Unable to reach the server. Check your connection and try again.'
  }

  // A 404 means the client called a path the API does not serve — a wiring
  // fault, not user error. Saying "review your details" would send the user
  // hunting for a mistake in a form that is perfectly valid.
  if (error.response.status === 404) {
    return 'This feature is not available yet (the server has no endpoint for it).'
  }

  const data: unknown = error.response.data
  if (typeof data === 'object' && data && 'message' in data) {
    const message = (data as { message: unknown }).message
    if (typeof message === 'string') return message
    // Nest returns an array of per-field validation messages. Showing all of
    // them beats showing the first: a registration can fail three rules at once
    // and fixing them one refresh at a time is miserable.
    if (Array.isArray(message)) {
      const parts = message.filter((m): m is string => typeof m === 'string')
      if (parts.length > 0) return parts.join(' ')
    }
  }

  return fallback
}
