import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { type Request } from 'express';
import { WalletService } from './wallet.service.js';
import { WalletRepository } from './wallet.repository.js';
import { TransferService } from '../transfers/transfer.service.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { PinGuard, RequiresPin } from '../../auth/guards/pin.guard.js';
import { RateLimitGuard, RateLimit } from '../../common/guards/rate-limit.guard.js';
import { type AuthenticatedUser } from '../../auth/auth.types.js';

// -----------------------------------------------------------------------------
// DTOs
// -----------------------------------------------------------------------------

/** Amounts arrive as strings of digits — never JSON numbers, which are doubles. */
const POISHA_PATTERN = /^[0-9]{1,15}$/;

export class SendMoneyDto {
  @IsString()
  @MaxLength(64)
  recipientId!: string;

  @Matches(POISHA_PATTERN, { message: 'amountPoisha must be a whole number of poisha.' })
  amountPoisha!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;

  /** Consumed and stripped by PinGuard before this DTO is validated. */
  @IsOptional()
  @Matches(/^[0-9]{6}$/)
  pin?: string;
}

export class CreateRequestDto {
  @IsString()
  @MaxLength(64)
  requesteeId!: string;

  @Matches(POISHA_PATTERN, { message: 'amountPoisha must be a whole number of poisha.' })
  amountPoisha!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

export class RespondRequestDto {
  @IsOptional()
  @Matches(/^[0-9]{6}$/)
  pin?: string;
}

export class HistoryQueryDto {
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @IsString() direction?: 'CREDIT' | 'DEBIT';
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
}

// -----------------------------------------------------------------------------

type AuthedRequest = Request & { user?: AuthenticatedUser };

/** Identity always comes from the verified token, never from the request body. */
function callerOf(request: AuthedRequest): AuthenticatedUser {
  const user = request.user;
  if (user === undefined) {
    throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Login required.' });
  }
  return user;
}

@Controller()
@UseGuards(JwtAuthGuard, RateLimitGuard, PinGuard)
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly walletRepository: WalletRepository,
    private readonly transfers: TransferService,
  ) {}

  @Get('accounts/me/summary')
  async summary(@Req() request: AuthedRequest) {
    return await this.wallet.summary(callerOf(request).sub);
  }

  @Get('transactions')
  async history(@Req() request: AuthedRequest, @Query() query: HistoryQueryDto) {
    return await this.wallet.history(callerOf(request).sub, query);
  }

  @Get('users/search')
  async search(@Req() request: AuthedRequest, @Query('q') q = '') {
    return await this.wallet.searchUsers(q, callerOf(request).sub);
  }

  // ---------------------------------------------------------------------------
  // Money movement
  // ---------------------------------------------------------------------------

  /**
   * Note there is deliberately **no** IdempotencyInterceptor on this route.
   *
   * `TransferService` already claims the same `Idempotency-Key` *inside* the
   * money transaction, which is the stronger guarantee — it makes the money
   * movement exactly-once rather than merely the HTTP response. Running both
   * meant two layers claiming one key with two different request hashes, and
   * the inner one correctly rejected the outer one's claim as a conflict.
   *
   * The interceptor remains the right tool for money-mutating routes that do
   * not have transaction-level deduplication of their own.
   */
  @Post('transfers')
  @RequiresPin()
  @RateLimit({ scope: 'transfers', capacity: 20, refillPerSecond: 0.5, by: 'user' })
  @HttpCode(HttpStatus.CREATED)
  async transfer(@Req() request: AuthedRequest, @Body() dto: SendMoneyDto) {
    const caller = callerOf(request);

    const idempotencyKey = request.header('Idempotency-Key');
    if (idempotencyKey === undefined || idempotencyKey === '') {
      // Required, not optional: without it a retried transfer is a second
      // transfer, and the client cannot tell the difference (NFR-B).
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'An Idempotency-Key header is required for transfers.',
      });
    }

    const result = await this.transfers.executeTransfer({
      senderUserId: caller.sub,
      receiver: { kind: 'userId', value: dto.recipientId },
      amountPoisha: BigInt(dto.amountPoisha),
      idempotencyKey,
      note: dto.note,
    });

    if (!result.ok) {
      throw new BadRequestException({ code: result.reason, message: messageFor(result.reason) });
    }

    const summary = await this.wallet.summary(caller.sub);
    return {
      transaction: summary.recentActivity[0] ?? null,
      balancePoisha: result.senderBalancePoisha.toString(),
      reference: result.reference,
    };
  }

  // ---------------------------------------------------------------------------
  // Money requests
  // ---------------------------------------------------------------------------

  @Get('money-requests')
  async listRequests(@Req() request: AuthedRequest) {
    return await this.wallet.listRequests(callerOf(request).sub);
  }

  @Post('money-requests')
  @RateLimit({ scope: 'requests:create', capacity: 20, refillPerSecond: 0.5, by: 'user' })
  async createRequest(@Req() request: AuthedRequest, @Body() dto: CreateRequestDto) {
    const caller = callerOf(request);
    if (dto.requesteeId === caller.sub) {
      throw new BadRequestException({ code: 'SELF_REQUEST', message: 'You cannot bill yourself.' });
    }
    const created = await this.walletRepository.createMoneyRequest({
      requesterId: caller.sub,
      requesteeId: dto.requesteeId,
      amountPoisha: BigInt(dto.amountPoisha),
      note: dto.note,
    });
    return { id: created.id, status: 'PENDING' };
  }

  /**
   * Accepting a request performs a fully validated transfer — the same balance
   * check, atomicity and ledger entries as a direct send. A request is never a
   * shortcut around a transfer rule (FR-C).
   */
  @Post('money-requests/:id/accept')
  @RequiresPin()
  @RateLimit({ scope: 'requests:accept', capacity: 20, refillPerSecond: 0.5, by: 'user' })
  @HttpCode(HttpStatus.OK)
  async acceptRequest(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
    @Body() _dto: RespondRequestDto,
  ) {
    const caller = callerOf(request);
    const outcome = await this.walletRepository.acceptMoneyRequest({
      requestId: id,
      requesteeUserId: caller.sub,
    });

    if (!outcome.ok) {
      if (outcome.reason === 'NOT_FOUND') {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Request not found.' });
      }
      if (outcome.reason === 'INSUFFICIENT_FUNDS') {
        throw new BadRequestException({
          code: 'INSUFFICIENT_FUNDS',
          message: 'Not enough balance to settle this request.',
        });
      }
      throw new ForbiddenException({
        code: outcome.reason,
        message: 'This request is no longer pending.',
      });
    }

    const requests = await this.wallet.listRequests(caller.sub);
    return {
      request: requests.incoming.find((r) => r.id === id) ?? null,
      balancePoisha: outcome.balancePoisha.toString(),
      reference: outcome.reference,
    };
  }

  @Post('money-requests/:id/reject')
  @HttpCode(HttpStatus.OK)
  async rejectRequest(@Req() request: AuthedRequest, @Param('id') id: string) {
    const caller = callerOf(request);
    const outcome = await this.walletRepository.rejectMoneyRequest(id, caller.sub);

    if (outcome === 'NOT_FOUND') {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Request not found.' });
    }
    if (outcome === 'NOT_PENDING') {
      throw new ForbiddenException({
        code: 'NOT_PENDING',
        message: 'This request is no longer pending.',
      });
    }

    const requests = await this.wallet.listRequests(caller.sub);
    return { request: requests.incoming.find((r) => r.id === id) ?? null };
  }
}

/** Safe, human-readable text for each machine-readable failure code (NFR-14). */
function messageFor(reason: string): string {
  switch (reason) {
    case 'INSUFFICIENT_FUNDS':
      return 'Not enough balance for this transfer.';
    case 'SELF_TRANSFER':
      return 'You cannot send money to yourself.';
    case 'RECEIVER_NOT_FOUND':
      return 'That recipient could not be found.';
    case 'INVALID_AMOUNT':
      return 'Enter an amount greater than zero.';
    case 'LIMIT_EXCEEDED':
      return 'That amount is above the per-transaction limit.';
    default:
      return 'The transfer could not be completed.';
  }
}
