export type AuthUser = {
  id: string
  name: string
  email: string
}

export type AuthResponse = {
  accessToken: string
  user: AuthUser
}

export type LoginPayload = {
  email: string
  password: string
}

export type RegisterPayload = LoginPayload & {
  name: string
  pin: string
}
