export type AuthUser = {
  id: string
  username: string
  name: string
}

export type LoginResponse = {
  userId: string
  username: string
  accessToken: string
  refreshToken: string
  accessTokenExpiresIn: number
  refreshTokenExpiresAt: string
  pinVerified: boolean
}

export type LoginPayload = {
  identifier: string
  password: string
}

export type RegisterPayload = {
  email: string
  phone: string
  username: string
  displayName: string
  password: string
  pin: string
}

export type RegisterResponse = {
  userId: string
  username: string
  balancePoisha: string
}

export type RefreshResponse = {
  accessToken: string
  refreshToken: string
  accessTokenExpiresIn: number
  refreshTokenExpiresAt: string
}
