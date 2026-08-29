import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller.js';
import { WalletService } from './wallet.service.js';
import { WalletRepository } from './wallet.repository.js';
import { TransferModule } from '../transfers/transfer.module.js';

@Module({
  imports: [TransferModule],
  controllers: [WalletController],
  providers: [WalletService, WalletRepository],
})
export class WalletModule {}
