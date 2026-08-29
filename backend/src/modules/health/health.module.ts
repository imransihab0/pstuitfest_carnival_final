import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { HealthRepository } from './health.repository.js';

/**
 * Reference implementation of the layering every future module follows:
 * controller -> service -> repository -> infrastructure.
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService, HealthRepository],
})
export class HealthModule {}
