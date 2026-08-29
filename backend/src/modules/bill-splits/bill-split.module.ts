import { Module } from '@nestjs/common';
import { BillSplitController } from './bill-split.controller.js';
import { BillSplitService } from './bill-split.service.js';
import { BillSplitRepository } from './bill-split.repository.js';

@Module({
  controllers: [BillSplitController],
  providers: [BillSplitService, BillSplitRepository],
})
export class BillSplitModule {}
