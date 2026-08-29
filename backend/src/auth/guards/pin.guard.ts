import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request } from 'express';
import { type AuthenticatedUser } from '../auth.types.js';
import { AuthService } from '../auth.service.js';

export const REQUIRES_PIN_KEY = 'requires_pin';

/**
 * Marks an endpoint as money-mutating: a verified PIN is required, not just a
 * valid login.
 *
 * ```ts
 * @Post('transfers')
 * @RequiresPin()
 * async transfer() { ... }
 * ```
 *
 * Apply this to **every** endpoint that can move money — transfers, accepting a
 * money request, anything that debits an account. A JWT alone is read access.
 */
export const RequiresPin = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRES_PIN_KEY, true);

/**
 * Enforces PIN verification on money-mutating routes.
 *
 * The security model this exists for: an access token can leak — via a shared
 * device, an XSS bug, a proxy log, a screenshot. If a leaked token were enough
 * to drain an account, the blast radius of any one of those mistakes would be
 * the user's entire balance. Requiring a second, separately-hashed secret that
 * only the user knows means a stolen token buys the attacker a look at the
 * balance, not the money.
 *
 * The PIN grant lives in the access token's `pin` claim, so it expires with the
 * token (15 minutes) and cannot be extended by refreshing — rotation
 * deliberately never re-grants it.
 *
 * The claim is read from the **verified** token via `request.user`, populated by
 * JwtAuthGuard. It is never read from a header or body, which a caller could
 * simply assert for themselves.
 */
@Injectable()
export class PinGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiresPin = this.reflector.getAllAndOverride<boolean>(REQUIRES_PIN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiresPin !== true) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser; body?: Record<string, unknown> }>();
    const user = request.user;

    if (user === undefined) {
      // PinGuard must run after JwtAuthGuard. If there is no authenticated user
      // we fail closed rather than assuming the route was meant to be public.
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Authentication required.',
      });
    }

    // Route 1: the access token already carries a verified PIN claim, earned
    // via POST /auth/pin/verify.
    if (user.pinVerified) return true;

    // Route 2: the PIN accompanies this single request. Verified here, against
    // the stored Argon2id digest, and never trusted as a bare assertion.
    //
    // Supporting both is deliberate. A per-action PIN prompt is the interaction
    // users actually expect from a wallet, and forcing a separate
    // /auth/pin/verify round trip first would either add latency to every
    // transfer or push clients into caching a money-moving grant for longer
    // than the action needs it. This route grants authority for exactly one
    // request.
    const submittedPin = request.body?.pin;
    if (typeof submittedPin === 'string' && /^[0-9]{6}$/.test(submittedPin)) {
      const ok = await this.authService.checkPin(user.sub, submittedPin);
      if (ok) {
        // Remove it before the handler runs: the PIN must not reach a DTO, a
        // log line, or the idempotency request hash.
        delete request.body?.pin;
        return true;
      }
      throw new ForbiddenException({
        code: 'INVALID_PIN',
        message: 'Incorrect PIN.',
      });
    }

    throw new ForbiddenException({
      code: 'PIN_VERIFICATION_REQUIRED',
      message: 'Verify your transaction PIN before moving money.',
    });
  }
}
