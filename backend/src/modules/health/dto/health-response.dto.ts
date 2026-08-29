/** Status of a single downstream dependency. */
export type DependencyStatus = 'up' | 'down';

/** Overall health verdict for the service. */
export type HealthStatus = 'ok' | 'degraded';

export interface DependencyHealth {
  status: DependencyStatus;
  /** Round-trip time of the probe, in milliseconds. */
  latencyMs: number;
  /** Present only when `status` is `down`. Safe, non-leaky summary. */
  error?: string;
}

/**
 * Response body of `GET /health`.
 *
 * Deliberately free of internal detail — no connection strings, driver
 * versions, hostnames or stack traces (NFR-14). It is a probe endpoint that may
 * be publicly reachable, so it says whether the service works, not how it is
 * built.
 */
export interface HealthResponseDto {
  status: HealthStatus;
  /** ISO-8601, UTC. */
  timestamp: string;
  /** Seconds since process start. */
  uptimeSeconds: number;
  version: string;
  dependencies: {
    database: DependencyHealth;
    cache: DependencyHealth;
  };
}
