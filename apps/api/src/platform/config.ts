import { z } from 'zod';
import { ALLOWED_AI_MODELS, DEFAULT_AI_MODEL } from './ai/models.ts';

/**
 * Centralized configuration.
 *
 * Configuration is parsed once, at startup, and the process REFUSES TO START if
 * anything is missing or malformed. Failing fast matters more than it looks: the
 * alternative is a server that boots happily with `COOKIE_SECURE=undefined` and
 * quietly serves session cookies over plaintext for a week before anyone
 * notices.
 *
 * Application code must never read `process.env` directly — everything comes
 * through `loadConfig`, and the architecture fitness tests enforce that.
 *
 * PUBLIC vs PRIVATE
 * -----------------
 * Everything parsed here is PRIVATE (server-only) by default. The only values
 * that may ever reach a browser are the ones listed in `toPublicConfig`, and
 * `assertNoPrivateLeakage` verifies at startup that no private value slipped
 * into that object. See docs/architecture/configuration.md.
 */

/**
 * Environments that must be configured as if they were production.
 *
 * `staging` is included deliberately. A staging environment holds real-shaped
 * data, is reachable over the network, and is exactly where "we'll tighten it
 * before launch" goes to die. Every safety refine below applies to both, so
 * adding an environment cannot silently open a hole.
 */
const HARDENED_ENVIRONMENTS = ['production', 'staging'] as const;

export const APP_ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

function isHardened(environment: AppEnvironment): boolean {
  return (HARDENED_ENVIRONMENTS as readonly string[]).includes(environment);
}

/**
 * Every environment variable the application reads. Anything not listed here is
 * ignored rather than silently becoming configuration.
 */
const CONFIG_KEYS = [
  'NODE_ENV',
  'PORT',
  'HOST',
  'DATABASE_URL',
  'DATABASE_POOL_MAX',
  'LOG_LEVEL',
  'ALLOWED_ORIGINS',
  'RATE_LIMIT_ENABLED',
  'SESSION_COOKIE_NAME',
  'REFRESH_COOKIE_NAME',
  'SESSION_TTL_HOURS',
  'REFRESH_TTL_DAYS',
  'EMAIL_VERIFICATION_TTL_HOURS',
  'PASSWORD_RESET_TTL_MINUTES',
  'MAX_FAILED_LOGINS',
  'LOCKOUT_MINUTES',
  'REQUIRE_VERIFIED_EMAIL_FOR_LOGIN',
  'SESSION_COOKIE_SECURE',
  /**
   * ── ADDED IN TASK 014, AND THE OMISSION WAS A BUG ────────────────────────
   *
   * Task 013 declared `AI_PROVIDER`, `AI_API_KEY` and `AI_TIMEOUT_MS` in the
   * schema and documented them as configurable — but never listed them here,
   * so `loadConfig` copied nothing into the candidate and every one of them
   * silently kept its default. The environment variable existed, the
   * documentation described it, and setting it did nothing.
   *
   * Nothing was exposed by it (the provider was always `none`, and a key that
   * is never read cannot leak), but "configuration that silently does not
   * apply" is exactly the failure this file exists to prevent, and it survived
   * a full task. Recorded as VULN-037; the fitness test in
   * `tests/unit/config.test.ts` now asserts that this list and the schema
   * describe the same keys, so the class is closed rather than the instance.
   */
  'AI_PROVIDER',
  'AI_API_KEY',
  'AI_MODEL',
  'AI_MAX_OUTPUT_TOKENS',
  'AI_TIMEOUT_MS',
] as const;

/**
 * Keys whose VALUES must never appear in anything sent to a client.
 *
 * Used by `assertNoPrivateLeakage` as a runtime backstop against a future edit
 * to `toPublicConfig` that adds a field without thinking about it.
 */
const SECRET_BEARING_KEYS = ['DATABASE_URL', 'AI_API_KEY'] as const;

const configSchema = z
  .object({
    NODE_ENV: z.enum(APP_ENVIRONMENTS).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default('127.0.0.1'),

    // PRIVATE. Contains credentials. Never logged, never exposed.
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
     * refine below makes disabling it in a hardened environment impossible, so
     * this flag exists for test isolation, not as an operational escape hatch.
     */
    RATE_LIMIT_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    /**
     * The AI provider, and the ONLY switch that turns the assistant on.
     *
     * `none` is the default and is a first-class mode, not a broken one: the
     * assistant answers from retrieved course material through a deterministic
     * local composer. That is what makes the whole pipeline — authorization,
     * retrieval, citation validation, refusal — testable and shippable without
     * a vendor account, and it means a missing key degrades the answer's
     * fluency rather than degrading its SECURITY.
     *
     * No provider is named here beyond the enum. The application talks to
     * `AiProvider`, never to a vendor SDK.
     */
    AI_PROVIDER: z.enum(['none', 'anthropic']).default('none'),

    /**
     * Which model the adapter uses. SERVER-SIDE, ALLOWLISTED, VALIDATED AT BOOT.
     *
     * There is deliberately no request field for this and never will be: a
     * caller who could name the model could name an expensive one, or one whose
     * behaviour has not been reviewed, on somebody else's bill. The allowlist
     * lives in `platform/ai/models.ts`, and an unrecognised value is a startup
     * failure — the only place a configuration mistake costs nothing.
     */
    AI_MODEL: z.enum(ALLOWED_AI_MODELS).default(DEFAULT_AI_MODEL),

    /**
     * The hard ceiling on what one answer may generate.
     *
     * THE PRIMARY COST AND SIZE CONTROL, and the only one that acts before the
     * money is spent: the response cannot exceed it, so an unexpectedly
     * enormous answer cannot exhaust memory, blow the response payload, or run
     * up a bill. The default is sized for a lesson answer with citations, not
     * for an essay; the range is validated so neither a zero nor a six-figure
     * value can be typed in by accident.
     */
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(8_192).default(2_048),

    /**
     * PRIVATE. A provider credential.
     *
     * Listed in `SECRET_BEARING_KEYS`, so the redacting logger and the
     * configuration summary treat it exactly like `DATABASE_URL`. It is read
     * ONLY by the server; there is deliberately no `VITE_` counterpart, and
     * `tests/architecture/deployment-config.test.ts` asserts no AI key can
     * reach the browser bundle.
     */
    AI_API_KEY: z.string().optional(),

    /**
     * How long the assistant waits for a provider before giving up.
     *
     * Short on purpose. A learner staring at a spinner is a worse outcome than
     * an honest "try again", and a long timeout holds a connection and a
     * rate-limit slot while it waits.
     */
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),

    SESSION_COOKIE_NAME: z.string().default('edu_session'),
    REFRESH_COOKIE_NAME: z.string().default('edu_refresh'),

    /**
     * Access-token lifetime. Short by design: the refresh token carries
     * longevity, and a short access token bounds how long a leaked one is
     * useful. Kept in hours rather than minutes so the default is still
     * comfortable for a school day.
     */
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),

    /** Refresh-token lifetime, in days. Rotated on every use. */
    REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

    EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(48),
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),

    /** Failed attempts before an account locks. */
    MAX_FAILED_LOGINS: z.coerce.number().int().min(3).max(50).default(10),
    LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

    /**
     * Whether an unverified address blocks login.
     *
     * Defaults FALSE, deliberately. Turning this on without working mail
     * delivery locks every user out permanently — a worse failure than the risk
     * it addresses. It must be enabled in the same change that configures a mail
     * provider. See docs/security/limitations.md.
     */
    REQUIRE_VERIFIED_EMAIL_FOR_LOGIN: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    /** Set false ONLY for local plaintext development. */
    SESSION_COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  })
  .strict()
  .refine((c) => !(isHardened(c.NODE_ENV) && c.RATE_LIMIT_ENABLED === false), {
    message: 'RATE_LIMIT_ENABLED must not be false in production or staging — refusing to start.',
    path: ['RATE_LIMIT_ENABLED'],
  })
  .refine((c) => !(isHardened(c.NODE_ENV) && c.SESSION_COOKIE_SECURE === false), {
    message: 'SESSION_COOKIE_SECURE must be true in production or staging — refusing to start.',
    path: ['SESSION_COOKIE_SECURE'],
  })
  .refine(
    (c) => !isHardened(c.NODE_ENV) || c.ALLOWED_ORIGINS.every((o) => o.startsWith('https://')),
    {
      message: 'All ALLOWED_ORIGINS must be https:// in production or staging — refusing to start.',
      path: ['ALLOWED_ORIGINS'],
    },
  )
  .refine((c) => !isHardened(c.NODE_ENV) || c.ALLOWED_ORIGINS.length > 0, {
    message: 'ALLOWED_ORIGINS must not be empty in production or staging — refusing to start.',
    path: ['ALLOWED_ORIGINS'],
  })
  .refine((c) => c.AI_PROVIDER === 'none' || (c.AI_API_KEY ?? '').trim() !== '', {
    /**
     * A named provider with no credential is a server that boots fine and then
     * fails on a child's first question. Refusing at startup turns a silent
     * runtime outage into a loud deployment error, which is the trade this
     * whole file exists to make.
     *
     * The message names the VARIABLE, never a value — this string can end up in
     * a log or a console.
     */
    message: 'AI_API_KEY is required when AI_PROVIDER is not "none" — refusing to start.',
    path: ['AI_API_KEY'],
  })
  .refine((c) => !isHardened(c.NODE_ENV) || c.LOG_LEVEL !== 'debug', {
    // Debug logging in a hardened environment increases the volume of
    // request-shaped detail written to disk, and with it the chance that
    // something private is retained far longer than intended.
    message: 'LOG_LEVEL must not be "debug" in production or staging — refusing to start.',
    path: ['LOG_LEVEL'],
  });

export type AppConfig = Readonly<z.infer<typeof configSchema>>;

/**
 * The subset of configuration that is safe to hand to a browser.
 *
 * Deliberately tiny. A value belongs here only if a client genuinely needs it
 * AND leaking it to an anonymous visitor is harmless. When in doubt, it does not
 * belong here.
 *
 * Note what is absent: the session cookie name (the cookie is HttpOnly, so the
 * browser attaches it without JavaScript ever naming it), anything about the
 * database, and anything about internal hosts or ports.
 */
export interface PublicConfig {
  readonly environment: AppEnvironment;
  readonly apiVersion: 'v1';
}

export function toPublicConfig(config: AppConfig): PublicConfig {
  return Object.freeze({ environment: config.NODE_ENV, apiVersion: 'v1' as const });
}

/**
 * Runtime backstop: proves no private value is reachable through the public
 * config object.
 *
 * `toPublicConfig` is an allow-list, which is the real control. This exists
 * because allow-lists are edited by people in a hurry, and a future field added
 * without thought (`databaseUrl` "just for a debug banner") should fail loudly at
 * startup rather than ship.
 */
export function assertNoPrivateLeakage(config: AppConfig, publicConfig: PublicConfig): void {
  const serialized = JSON.stringify(publicConfig);
  for (const key of SECRET_BEARING_KEYS) {
    const value = config[key];
    if (typeof value === 'string' && value.length > 0 && serialized.includes(value)) {
      throw new Error(
        `Public configuration contains the value of ${key}. This would expose a server-only secret to every client. Refusing to start.`,
      );
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const candidate: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    if (env[key] !== undefined) candidate[key] = env[key];
  }

  const parsed = configSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  const config = Object.freeze(parsed.data);
  // Checked on every boot, in every environment, so a leak cannot reach
  // production by only being tested in development.
  assertNoPrivateLeakage(config, toPublicConfig(config));
  return config;
}
