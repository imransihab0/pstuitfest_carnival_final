let accessToken: string | null = null
let refreshToken: string | null = null

export function getAccessToken(): string | null {
  return accessToken
}

export function setAccessToken(token: string | null): void {
  accessToken = token
}

export function getRefreshToken(): string | null {
  return refreshToken
}

export function setRefreshToken(token: string | null): void {
  refreshToken = token
}
