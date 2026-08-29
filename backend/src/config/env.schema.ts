import { z } from 'zod';

/**
 * Environment contract.
 *
 * Validated once at boot, and the process refuses to start if anything is
 * missing or malformed. A money service that boots with a half-configured
 * database URL and only discovers it on the first transfer is strictly worse
 * than one that refuses to start at all.
 *
 * Every variable here is mirrored in `backend/REQUIREMENTS.txt` and
 * `backend/.env.example`.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Port the HTTP server binds to. */
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /** Prefix applied to every route, e.g. /api/v1/health. */
  API_PREFIX: z.string().default('api/v1'),

  /** PostgreSQL connection string consumed by both Prisma and migrations. */
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
      'DATABASE_URL must be a postgresql:// connection string',
    ),

  /** Redis connection string — used for cache, rate limiting and socket fan-out. */
  REDIS_URL: z
    .string()
    .min(1, 'REDIS_URL is required')
    .refine(
      (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
      'REDIS_URL must be a redis:// connection string',
    ),

  /** Comma-separated list of allowed CORS origins, or `*` in development. */
  CORS_ORIGIN: z.string().default('*'),

  /**
   * Signing secret for access tokens. No default: a JWT secret that falls back
   * to a constant is a JWT secret an attacker already has.
   */
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters of high-entropy random data'),

  /** Structured-log verbosity. */
  LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']).default('log'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * `validate` hook for `ConfigModule`. Throws — and therefore aborts boot — with
 * every problem listed at once rather than one per restart.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(
      `Invalid environment configuration:\n${details}\n\n` +
        'See backend/REQUIREMENTS.txt for the full list of required variables.',
    );
  }

  return parsed.data;
}
