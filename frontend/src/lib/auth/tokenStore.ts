const ACCESS_TOKEN_KEY = 'pstu-money.access-token'

export const tokenStore = {
  getAccessToken(): string | null {
    return window.localStorage.getItem(ACCESS_TOKEN_KEY)
  },

  setAccessToken(token: string): void {
    window.localStorage.setItem(ACCESS_TOKEN_KEY, token)
  },

  clearAccessToken(): void {
    window.localStorage.removeItem(ACCESS_TOKEN_KEY)
  },
}
