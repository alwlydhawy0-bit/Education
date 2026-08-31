/**
 * Client configuration — PUBLIC values only.
 *
 * Everything in this file ends up inside a JavaScript bundle that any visitor
 * can download and read. There is no such thing as a secret here.
 *
 * TWO LAYERS KEEP SERVER SECRETS OUT
 *
 *   1. Vite only exposes variables prefixed `VITE_`. Server-only values (the
 *      database connection string, cookie and origin settings) are simply not
 *      present in `import.meta.env`, so they cannot leak by accident — the
 *      build tool enforces it, not our discipline.
 *
 *   2. This module is the only place the app reads `import.meta.env`, and the
 *      architecture fitness tests assert that. A feature reading it directly
 *      could reintroduce an unvalidated value.
 *
 * THE RULE: if a value would be damaging in the hands of an anonymous visitor,
 * it does not belong here — it belongs behind an authenticated API call.
 *
 * Note what is deliberately absent: the API base URL is a same-origin relative
 * path, so there is no host to configure; and the session cookie name is never
 * needed because the cookie is HttpOnly and the browser attaches it on its own.
 */

const ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;
type Environment = (typeof ENVIRONMENTS)[number];

export interface ClientConfig {
  readonly environment: Environment;
  readonly apiVersion: 'v1';
  /** Enables developer-facing diagnostics. Never gates a security control. */
  readonly verboseErrors: boolean;
}

function readEnvironment(raw: unknown): Environment {
  return typeof raw === 'string' && (ENVIRONMENTS as readonly string[]).includes(raw)
    ? (raw as Environment)
    : // Unknown or absent means treat it as the strictest option. Guessing
      // "development" would turn a misconfigured production build into a
      // chattier one.
      'production';
}

const environment = readEnvironment(import.meta.env.MODE);

export const clientConfig: ClientConfig = Object.freeze({
  environment,
  apiVersion: 'v1',
  verboseErrors: environment === 'development' || environment === 'test',
});
