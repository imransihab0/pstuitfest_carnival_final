import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.schema.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { TransferModule } from './modules/transfers/transfer.module.js';
import { AuthModule } from './auth/auth.module.js';
import { WalletModule } from './modules/wallet/wallet.module.js';
import { BillSplitModule } from './modules/bill-splits/bill-split.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      envFilePath: ['.env.local', '.env'],
    }),

    // Infrastructure adapters — global, injected only into repositories.
    PrismaModule,
    RedisModule,

    // Feature modules.
    AuthModule,
    HealthModule,
    TransferModule,
    WalletModule,
    BillSplitModule,
  ],
})
export class AppModule {}
