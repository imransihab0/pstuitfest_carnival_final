import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { type Request } from 'express';
import { AuthService } from './auth.service.js';
import { Public } from './guards/jwt-auth.guard.js';
import {
  RateLimitGuard,
  RateLimit,
  CREDENTIAL_RATE_LIMIT,
} from '../common/guards/rate-limit.guard.js';
import { LoginDto, RefreshDto, RegisterDto, VerifyPinDto } from './dto/auth.dto.js';
import { type AuthenticatedUser } from './auth.types.js';
import { poishaToJson } from '../common/money.js';

@Controller('auth')
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Public()
  @RateLimit({ scope: 'auth:register', capacity: 3, refillPerSecond: 0.01, by: 'ip' })
  async register(@Body() dto: RegisterDto) {
    const user = await this.authService.register(dto);
    return {
      userId: user.userId,
      username: user.username,
      // Amounts cross the API as strings, never JSON numbers (NFR-C).
      balancePoisha: poishaToJson(user.balancePoisha),
    };
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @RateLimit(CREDENTIAL_RATE_LIMIT)
  async login(@Body() dto: LoginDto, @Req() request: Request) {
    const result = await this.authService.login(dto.identifier, dto.password, {
      userAgent: request.header('user-agent'),
      ipAddress: request.ip,
    });

    if (result === null) {
      // One message for every failure mode, so the response cannot be used to
      // discover which usernames exist.
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid credentials.',
      });
    }

    return {
      userId: result.userId,
      username: result.username,
      ...result.tokens,
      // Read access only. Moving money needs POST /auth/pin/verify.
      pinVerified: false,
    };
  }

  @Post('pin/verify')
  @HttpCode(HttpStatus.OK)
  @RateLimit(CREDENTIAL_RATE_LIMIT)
  async verifyPin(
    @Body() dto: VerifyPinDto,
    @Req() request: Request & { user?: AuthenticatedUser },
  ) {
    const user = request.user;
    if (user === undefined) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Login required.' });
    }

    const result = await this.authService.verifyPin(user.sub, user.fam, dto.pin);
    if (result === null) {
      throw new UnauthorizedException({ code: 'INVALID_PIN', message: 'Incorrect PIN.' });
    }

    return { ...result, pinVerified: true };
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @RateLimit({ scope: 'auth:refresh', capacity: 30, refillPerSecond: 0.5, by: 'ip' })
  async refresh(@Body() dto: RefreshDto, @Req() request: Request) {
    const outcome = await this.authService.refresh(dto.refreshToken, {
      userAgent: request.header('user-agent'),
      ipAddress: request.ip,
    });

    if (!outcome.ok) {
      // Reuse detection is reported distinctly so the client can tell the user
      // their session was ended for safety rather than silently expiring.
      const code =
        outcome.reason === 'REUSE_DETECTED' ? 'SESSION_REVOKED_REUSE_DETECTED' : 'INVALID_REFRESH';
      throw new UnauthorizedException({
        code,
        message:
          outcome.reason === 'REUSE_DETECTED'
            ? 'This session was ended because a refresh token was reused. Please sign in again.'
            : 'Invalid or expired refresh token.',
      });
    }

    return outcome.tokens;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() request: Request & { user?: AuthenticatedUser }) {
    const user = request.user;
    if (user !== undefined) {
      await this.authService.logout(user.fam);
    }
  }
}
