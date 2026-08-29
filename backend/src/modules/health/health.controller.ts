import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { type Response } from 'express';
import { HealthService } from './health.service.js';
import { type HealthResponseDto } from './dto/health-response.dto.js';

/**
 * `GET /health`
 *
 * Transport only: parse the request, call the service, map the domain result
 * onto an HTTP status. No domain logic and no database access live here.
 *
 * Excluded from the global API prefix (see `main.ts`) so the path stays exactly
 * `/health` — probes and orchestrators should not have to track an API version.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthResponseDto> {
    const result = await this.healthService.check();

    // 503 only when the system of record is unreachable — that is the condition
    // under which a load balancer should stop sending this instance traffic.
    // A cache outage reports `degraded` with a 200: the service still works.
    response.status(
      result.dependencies.database.status === 'up' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE,
    );

    return result;
  }
}
