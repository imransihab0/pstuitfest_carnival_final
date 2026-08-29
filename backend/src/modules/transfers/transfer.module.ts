import { Module } from '@nestjs/common';
import { TransferService } from './transfer.service.js';
import { TransferRepository } from './transfer.repository.js';

/**
 * No controller yet — the HTTP surface arrives with the auth module, since
 * every transfer endpoint needs an authenticated caller (the sender is taken
 * from the session token, never from the request body).
 */
@Module({
  providers: [TransferService, TransferRepository],
  exports: [TransferService],
})
export class TransferModule {}
