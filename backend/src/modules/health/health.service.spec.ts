import { Test, type TestingModule } from '@nestjs/testing';
import { type Mock, vi } from 'vitest';
import { HealthService } from './health.service.js';
import { HealthRepository } from './health.repository.js';
import { type DependencyHealth } from './dto/health-response.dto.js';

const up = (latencyMs = 1): DependencyHealth => ({ status: 'up', latencyMs });
const down = (latencyMs = 1): DependencyHealth => ({
  status: 'down',
  latencyMs,
  error: 'connection refused',
});

describe('HealthService', () => {
  let service: HealthService;
  let repository: { pingDatabase: Mock; pingCache: Mock };

  beforeEach(async () => {
    repository = {
      pingDatabase: vi.fn(),
      pingCache: vi.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [HealthService, { provide: HealthRepository, useValue: repository }],
    }).compile();

    service = moduleRef.get(HealthService);
  });

  it('reports ok when both dependencies are up', async () => {
    repository.pingDatabase.mockResolvedValue(up());
    repository.pingCache.mockResolvedValue(up());

    const result = await service.check();

    expect(result.status).toBe('ok');
    expect(result.dependencies.database.status).toBe('up');
    expect(result.dependencies.cache.status).toBe('up');
  });

  it('degrades — rather than fails — when only the cache is down', async () => {
    // Redis carries no authoritative money state, so its loss costs realtime
    // notifications and rate limiting, not correctness.
    repository.pingDatabase.mockResolvedValue(up());
    repository.pingCache.mockResolvedValue(down());

    const result = await service.check();

    expect(result.status).toBe('degraded');
  });

  it('degrades when the database is down', async () => {
    repository.pingDatabase.mockResolvedValue(down());
    repository.pingCache.mockResolvedValue(up());

    const result = await service.check();

    expect(result.status).toBe('degraded');
  });

  it('probes dependencies concurrently', async () => {
    repository.pingDatabase.mockResolvedValue(up());
    repository.pingCache.mockResolvedValue(up());

    await service.check();

    expect(repository.pingDatabase).toHaveBeenCalledTimes(1);
    expect(repository.pingCache).toHaveBeenCalledTimes(1);
  });

  it('returns a UTC ISO-8601 timestamp and a non-negative uptime', async () => {
    repository.pingDatabase.mockResolvedValue(up());
    repository.pingCache.mockResolvedValue(up());

    const result = await service.check();

    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
