import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { vi } from 'vitest';
import request from 'supertest';
import { HealthController } from '../src/modules/health/health.controller.js';
import { HealthService } from '../src/modules/health/health.service.js';
import { HealthRepository } from '../src/modules/health/health.repository.js';

/**
 * Exercises the real HTTP layer — routing, the passthrough status mapping and
 * the response shape — with the repository stubbed out. The repository is the
 * only layer that touches Postgres or Redis, so stubbing it is exactly what
 * makes this runnable without a live database.
 *
 * That is the layering paying for itself, not a testing shortcut.
 */
describe('GET /health (e2e)', () => {
  let app: INestApplication;
  const repository = {
    pingDatabase: vi.fn(),
    pingCache: vi.fn(),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [HealthService, { provide: HealthRepository, useValue: repository }],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 200 and status ok when every dependency is up', async () => {
    repository.pingDatabase.mockResolvedValue({ status: 'up', latencyMs: 1.2 });
    repository.pingCache.mockResolvedValue({ status: 'up', latencyMs: 0.4 });

    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toMatchObject({
      status: 'ok',
      dependencies: {
        database: { status: 'up' },
        cache: { status: 'up' },
      },
    });
    expect(typeof response.body.uptimeSeconds).toBe('number');
    expect(typeof response.body.version).toBe('string');
  });

  it('returns 200 and status degraded when only the cache is down', async () => {
    repository.pingDatabase.mockResolvedValue({ status: 'up', latencyMs: 1.1 });
    repository.pingCache.mockResolvedValue({
      status: 'down',
      latencyMs: 2.5,
      error: 'connection refused',
    });

    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body.status).toBe('degraded');
  });

  it('returns 503 when the database is unreachable', async () => {
    repository.pingDatabase.mockResolvedValue({
      status: 'down',
      latencyMs: 30,
      error: 'connection refused',
    });
    repository.pingCache.mockResolvedValue({ status: 'up', latencyMs: 0.5 });

    const response = await request(app.getHttpServer()).get('/health').expect(503);

    expect(response.body.status).toBe('degraded');
  });

  it('never leaks internal detail in the response', async () => {
    repository.pingDatabase.mockResolvedValue({
      status: 'down',
      latencyMs: 30,
      error: 'connection refused',
    });
    repository.pingCache.mockResolvedValue({ status: 'up', latencyMs: 0.5 });

    const response = await request(app.getHttpServer()).get('/health');
    const body = JSON.stringify(response.body);

    expect(body).not.toMatch(/postgresql:\/\//);
    expect(body).not.toMatch(/password/i);
    expect(body).not.toMatch(/\bat\s+\w+\s+\(/); // stack frame
  });
});

/**
 * `main.ts` applies a global API prefix but excludes `health` from it, so probes
 * hit `/health` rather than a versioned path. That exclusion is easy to drop by
 * accident when the prefix is later changed, and nothing else would catch it —
 * the container healthcheck and any orchestrator probe would just start
 * failing.
 */
describe('GET /health — global prefix exclusion (e2e)', () => {
  let app: INestApplication;
  const repository = {
    pingDatabase: vi.fn(),
    pingCache: vi.fn(),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [HealthService, { provide: HealthRepository, useValue: repository }],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirrors main.ts.
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    await app.init();
  });

  // Set per-test, not at declaration: `vi.resetAllMocks()` in the block above is
  // global, so an implementation attached once at module scope would already
  // have been cleared by the time these tests run.
  beforeEach(() => {
    repository.pingDatabase.mockResolvedValue({ status: 'up', latencyMs: 1 });
    repository.pingCache.mockResolvedValue({ status: 'up', latencyMs: 1 });
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the unprefixed path', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
  });

  it('does not serve the prefixed path', async () => {
    await request(app.getHttpServer()).get('/api/v1/health').expect(404);
  });
});
