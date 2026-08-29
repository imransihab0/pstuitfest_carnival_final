import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { type Request } from 'express';
import { type AccessTokenClaims, type AuthenticatedUser } from '../auth.types.js';

export const IS_PUBLIC_KEY = 'is_public';
/** Opts a route out of authentication. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Verifies the bearer access token and attaches the caller to the request.
 *
 * The identity used by every downstream layer comes from **this token only**.
 * A `userId` in a request body is never trusted as proof of anything — that is
 * the difference between authentication and a suggestion (FR-E).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();

    const header = request.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Missing bearer token.',
      });
    }

    try {
      const claims = await this.jwt.verifyAsync<AccessTokenClaims>(header.slice(7));
      request.user = {
        sub: claims.sub,
        username: claims.username,
        fam: claims.fam,
        pinVerified: claims.pin === true,
      };
      return true;
    } catch {
      // Never leak whether the token was malformed, expired or forged.
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Invalid or expired token.',
      });
    }
  }
}
