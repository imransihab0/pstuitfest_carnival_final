import { Injectable } from '@nestjs/common';
import { HealthRepository } from './health.repository.js';
import { type HealthResponseDto, type HealthStatus } from './dto/health-response.dto.js';

/**
 * Domain logic for the health check. Holds no database or cache client of its
 * own — it asks the repository and decides what the answers mean.
 */
@Injectable()
export class HealthService {
  private readonly version: string = process.env['npm_package_version'] ?? '0.1.0';

  constructor(private readonly healthRepository: HealthRepository) {}

  async check(): Promise<HealthResponseDto> {
    // Probed concurrently: a slow dependency should not serialise behind another.
    const [database, cache] = await Promise.all([
      this.healthRepository.pingDatabase(),
      this.healthRepository.pingCache(),
    ]);

    return {
      status: this.resolveStatus(database.status === 'up', cache.status === 'up'),
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      version: this.version,
      dependencies: { database, cache },
    };
  }

  /**
   * PostgreSQL is the system of record: without it no transfer can be committed,
   * so losing it means the service is not healthy. Redis is a cache and a
   * fan-out channel — losing it costs realtime notifications and rate limiting,
   * not correctness, so it degrades the service rather than failing it.
   */
  private resolveStatus(databaseUp: boolean, cacheUp: boolean): HealthStatus {
    if (!databaseUp) {
      return 'degraded';
    }

    return cacheUp ? 'ok' : 'degraded';
  }
}
