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
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { type Request } from 'express';
import { BillSplitService } from './bill-split.service.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { PinGuard, RequiresPin } from '../../auth/guards/pin.guard.js';
import { RateLimitGuard, RateLimit } from '../../common/guards/rate-limit.guard.js';
import { type AuthenticatedUser } from '../../auth/auth.types.js';

// -----------------------------------------------------------------------------
// DTOs
// -----------------------------------------------------------------------------

/** Amounts arrive as strings of digits — never JSON numbers, which are doubles. */
const POISHA_PATTERN = /^[0-9]{1,15}$/;

class ShareInputDto {
  @IsString()
  @MaxLength(64)
  payerId!: string;

  @Matches(POISHA_PATTERN, { message: 'amountPoisha must be a whole number of poisha.' })
  amountPoisha!: string;
}

export class CreateBillSplitDto {
  @Matches(POISHA_PATTERN, { message: 'totalAmountPoisha must be a whole number of poisha.' })
  totalAmountPoisha!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ShareInputDto)
  shares!: ShareInputDto[];
}

export class PayShareDto {
  /** Consumed and stripped by PinGuard before this DTO is validated. */
  @IsOptional()
  @Matches(/^[0-9]{6}$/)
  pin?: string;
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

@Controller('bill-splits')
@UseGuards(JwtAuthGuard, RateLimitGuard, PinGuard)
export class BillSplitController {
  constructor(private readonly billSplits: BillSplitService) {}

  @Get()
  async list(@Req() request: AuthedRequest) {
    return await this.billSplits.listMine(callerOf(request).sub);
  }

  @Get(':id')
  async detail(@Req() request: AuthedRequest, @Param('id') id: string) {
    return await this.billSplits.getDetail(id, callerOf(request).sub);
  }

  /**
   * Creating a split moves no money — same as creating a money request — so
   * this deliberately carries no @RequiresPin(). PIN authorization applies
   * where money actually moves: POST /bill-splits/:id/pay below.
   */
  @Post()
  @RateLimit({ scope: 'bill-splits:create', capacity: 20, refillPerSecond: 0.5, by: 'user' })
  async create(@Req() request: AuthedRequest, @Body() dto: CreateBillSplitDto) {
    const caller = callerOf(request);
    const result = await this.billSplits.create(caller.sub, {
      totalAmountPoisha: BigInt(dto.totalAmountPoisha),
      description: dto.description,
      shares: dto.shares.map((share) => ({
        payerId: share.payerId,
        amountPoisha: BigInt(share.amountPoisha),
      })),
    });

    if (!result.ok) {
      throw new BadRequestException({
        code: result.reason,
        message: messageForCreate(result.reason),
      });
    }
    return { id: result.id, reference: result.reference, status: 'OPEN' };
  }

  /**
   * Pays the caller's own share. Identified by split id, not share id — the
   * caller doesn't need to know their share's id, only which bill they're
   * settling. Exactly one PENDING share can exist per (split, payer) pair
   * (uq_bill_split_shares_split_payer), so this is unambiguous.
   */
  @Post(':id/pay')
  @RequiresPin()
  @RateLimit({ scope: 'bill-splits:pay', capacity: 20, refillPerSecond: 0.5, by: 'user' })
  @HttpCode(HttpStatus.OK)
  async pay(@Req() request: AuthedRequest, @Param('id') id: string, @Body() _dto: PayShareDto) {
    const caller = callerOf(request);
    const result = await this.billSplits.payShare(caller.sub, id);

    if (!result.ok) {
      if (result.reason === 'NOT_FOUND') {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'No share found for you on this split.',
        });
      }
      if (result.reason === 'NOT_PENDING') {
        throw new ForbiddenException({
          code: 'NOT_PENDING',
          message: 'This share is no longer pending.',
        });
      }
      if (result.reason === 'INSUFFICIENT_FUNDS') {
        throw new BadRequestException({
          code: 'INSUFFICIENT_FUNDS',
          message: 'Not enough balance to pay this share.',
        });
      }
      throw new BadRequestException({
        code: result.reason,
        message: 'This share could not be paid.',
      });
    }

    return {
      reference: result.reference,
      balancePoisha: result.payerBalancePoisha.toString(),
      splitSettled: result.splitSettled,
    };
  }
}

/** Safe, human-readable text for each machine-readable failure code (NFR-14). */
function messageForCreate(reason: string): string {
  switch (reason) {
    case 'INVALID_AMOUNT':
      return 'Enter an amount greater than zero.';
    case 'EMPTY_SHARES':
      return 'Add at least one person to split with.';
    case 'TOO_MANY_SHARES':
      return 'That is too many participants for one split.';
    case 'DUPLICATE_PAYER':
      return 'Each participant can only appear once.';
    case 'SELF_SHARE':
      return 'You cannot add yourself as a participant.';
    case 'SHARE_TOTAL_MISMATCH':
      return 'The shares must add up to the total amount exactly.';
    case 'PAYER_NOT_FOUND':
      return 'One of the participants could not be found.';
    default:
      return 'The split could not be created.';
  }
}
