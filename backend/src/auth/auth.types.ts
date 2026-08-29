/** Claims carried by the access token. */
export interface AccessTokenClaims {
  /** User id. */
  readonly sub: string;
  readonly username: string;
  /** Session family, so an access token can be tied back to its login. */
  readonly fam: string;
  /**
   * Whether the caller has completed PIN verification in this session.
   *
   * Access tokens are issued WITHOUT this. A password login grants read access;
   * moving money requires a second factor the user knows (FR-E). See PinGuard.
   */
  readonly pin?: true;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresIn: number;
  readonly refreshTokenExpiresAt: Date;
}

export interface AuthenticatedUser {
  readonly sub: string;
  readonly username: string;
  readonly fam: string;
  readonly pinVerified: boolean;
}

export type RefreshOutcome =
  | { readonly ok: true; readonly tokens: TokenPair }
  /**
   * A token that had already been rotated was presented again. Either it was
   * stolen or replayed, and we cannot tell which — so the whole family is
   * revoked and everyone re-authenticates.
   */
  | { readonly ok: false; readonly reason: 'REUSE_DETECTED' }
  | { readonly ok: false; readonly reason: 'INVALID' }
  | { readonly ok: false; readonly reason: 'EXPIRED' }
  | { readonly ok: false; readonly reason: 'REVOKED' };

export interface RegisterCommand {
  readonly email: string;
  readonly phone: string;
  readonly username: string;
  readonly displayName: string;
  readonly password: string;
  readonly pin: string;
}

export interface RegisteredUser {
  readonly userId: string;
  readonly accountId: string;
  readonly username: string;
  readonly balancePoisha: bigint;
}
