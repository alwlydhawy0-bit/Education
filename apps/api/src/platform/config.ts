import { z } from 'zod';

/**
 * Configuration is parsed once, at startup, and the process REFUSES TO START if
 * anything is missing or malformed.
 *
 * Failing fast matters more than it looks: the alternative is a server that
 * boots happily with `COOKIE_SECURE=undefined` and quietly serves session
 * cookies over plaintext for a week before anyone notices.
 *
 * There are no defaults for security-relevant values in production. Where a
 * default exists it is the SAFE one, and `refine` blocks the unsafe combination
 * outright rather than warning about it.
 */
const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default('127.0.0.1'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),

    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    /** Absolute origin(s) permitted to make state-changing requests. */
    ALLOWED_ORIGINS: z
      .string()
      .default('http://localhost:5173')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),

    /**
     * Rate limiting is ON by default and can only be disabled explicitly. The
     * production refine below makes disabling it in production impossible, so
     * this flag exists for test isolation, not as an operational escape hatch.
     */
    RATE_LIMIT_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    SESSION_COOKIE_NAME: z.string().default('edu_session'),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
    /** Set false ONLY for local plaintext development. */
    SESSION_COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  })
  .strict()
  .refine((c) => !(c.NODE_ENV === 'production' && c.RATE_LIMIT_ENABLED === false), {
    message: 'RATE_LIMIT_ENABLED must not be false in production — refusing to start.',
    path: ['RATE_LIMIT_ENABLED'],
  })
  .refine((c) => !(c.NODE_ENV === 'production' && c.SESSION_COOKIE_SECURE === false), {
    message: 'SESSION_COOKIE_SECURE must be true in production — refusing to start.',
    path: ['SESSION_COOKIE_SECURE'],
  })
  .refine(
    (c) => c.NODE_ENV !== 'production' || c.ALLOWED_ORIGINS.every((o) => o.startsWith('https://')),
    {
      message: 'All ALLOWED_ORIGINS must be https:// in production — refusing to start.',
      path: ['ALLOWED_ORIGINS'],
    },
  );

export type AppConfig = Readonly<z.infer<typeof configSchema>>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Only the keys we know about are read. An unexpected EDU_* variable is
  // ignored rather than silently becoming configuration.
  const candidate: Record<string, unknown> = {};
  for (const key of [
    'NODE_ENV',
    'PORT',
    'HOST',
    'DATABASE_URL',
    'DATABASE_POOL_MAX',
    'LOG_LEVEL',
    'ALLOWED_ORIGINS',
    'RATE_LIMIT_ENABLED',
    'SESSION_COOKIE_NAME',
    'SESSION_TTL_HOURS',
    'SESSION_COOKIE_SECURE',
  ]) {
    if (env[key] !== undefined) candidate[key] = env[key];
  }

  const parsed = configSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return Object.freeze(parsed.data);
}
