import { loadConfig } from '../../apps/api/src/platform/config.ts';
import { buildApp, type BuiltApp } from '../../apps/api/src/app.ts';
import { createLogger, createMemorySink, type LogRecord } from '@edu/observability';
import type { MailDelivery } from '../../apps/api/src/modules/identity/mail-delivery.ts';
import { TEST_APP_URL } from './env.ts';

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

export interface CapturedMail {
  readonly kind: 'email_verification' | 'password_reset';
  readonly to: string;
  readonly token: string;
}

export interface TestApp extends BuiltApp {
  readonly logs: LogRecord[];
  /**
   * Messages the app would have sent.
   *
   * Verification and reset tokens must never be returned over HTTP — anyone who
   * could trigger a reset would then be able to read the token and take the
   * account over. Capturing them at the mail port is how the flows stay testable
   * end to end without opening that hole.
   */
  readonly mail: CapturedMail[];
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

  const mail: CapturedMail[] = [];
  const capturingMail: MailDelivery = {
    async sendEmailVerification(to, token) {
      mail.push({ kind: 'email_verification', to, token });
    },
    async sendPasswordReset(to, token) {
      mail.push({ kind: 'password_reset', to, token });
    },
  };

  const built = await buildApp({
    config,
    logger: createLogger({ level: 'debug', sink }),
    mail: capturingMail,
  });
  return { ...built, logs: records, mail };
}

/** Headers a browser would send for a same-origin state-changing request. */
export const writeHeaders = { origin: TEST_ORIGIN, 'content-type': 'application/json' };

/**
 * For state-changing requests that carry no body (DELETE, logout). Declaring a
 * JSON content-type with an empty body is a malformed request, not a realistic
 * browser one.
 */
export const bodylessWriteHeaders = { origin: TEST_ORIGIN };

/** Extracts a named cookie value from a Set-Cookie header. */
export function cookieFrom(setCookie: string | string[] | undefined, name: string): string {
  const raw = Array.isArray(setCookie) ? setCookie.join('\n') : (setCookie ?? '');
  const match = new RegExp(`${name}=([^;\\s]+)`).exec(raw);
  if (!match?.[1]) throw new Error(`No "${name}" cookie in: ${raw}`);
  return match[1];
}

/** Extracts the access-token cookie value from a login response. */
export function sessionCookieFrom(setCookie: string | string[] | undefined): string {
  return cookieFrom(setCookie, 'edu_session');
}

/** Extracts the refresh-token cookie value from a login response. */
export function refreshCookieFrom(setCookie: string | string[] | undefined): string {
  return cookieFrom(setCookie, 'edu_refresh');
}
