import { loadConfig } from '../../apps/api/src/platform/config.js';
import { buildApp, type BuiltApp } from '../../apps/api/src/app.js';
import { createLogger, createMemorySink, type LogRecord } from '@edu/observability';
import { TEST_APP_URL } from './env.js';

/**
 * Builds the REAL application for security tests.
 *
 * Nothing is stubbed: the same composition root, the same Fastify plugins, the
 * same policy engine, the same database role the production server uses. A test
 * that mocked the authorization layer would prove nothing about it.
 *
 * Rate limiting is off by default here so that unrelated suites are not
 * throttled; the rate-limit suite builds its own app with it enabled.
 */
export const TEST_ORIGIN = 'http://localhost:5173';

export interface TestApp extends BuiltApp {
  readonly logs: LogRecord[];
}

export async function buildTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const { sink, records } = createMemorySink();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_APP_URL,
    ALLOWED_ORIGINS: TEST_ORIGIN,
    SESSION_COOKIE_SECURE: 'false',
    RATE_LIMIT_ENABLED: 'false',
    LOG_LEVEL: 'debug',
    ...overrides,
  });

  const built = await buildApp({
    config,
    logger: createLogger({ level: 'debug', sink }),
  });
  return { ...built, logs: records };
}

/** Headers a browser would send for a same-origin state-changing request. */
export const writeHeaders = { origin: TEST_ORIGIN, 'content-type': 'application/json' };

/**
 * For state-changing requests that carry no body (DELETE, logout). Declaring a
 * JSON content-type with an empty body is a malformed request, not a realistic
 * browser one.
 */
export const bodylessWriteHeaders = { origin: TEST_ORIGIN };

/** Extracts the session cookie value from a login response. */
export function sessionCookieFrom(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '');
  const match = /edu_session=([^;]+)/.exec(raw);
  if (!match?.[1]) throw new Error(`No session cookie in: ${raw}`);
  return match[1];
}
