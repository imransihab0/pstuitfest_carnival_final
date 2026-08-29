import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthRepository } from './auth.repository.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { PinGuard } from './guards/pin.guard.js';
import { RateLimitGuard } from '../common/guards/rate-limit.guard.js';
import { RateLimitRepository } from '../common/guards/rate-limit.repository.js';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor.js';
import { IdempotencyRepository } from '../common/interceptors/idempotency.repository.js';
import { type Env } from '../config/env.schema.js';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: { issuer: 'pstu-carnival', audience: 'pstu-carnival-api' },
        verifyOptions: { issuer: 'pstu-carnival', audience: 'pstu-carnival-api' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRepository,
    JwtAuthGuard,
    PinGuard,
    RateLimitGuard,
    RateLimitRepository,
    IdempotencyInterceptor,
    IdempotencyRepository,
  ],
  exports: [AuthService, JwtAuthGuard, PinGuard, RateLimitGuard, IdempotencyInterceptor, JwtModule],
})
export class AuthModule {}
