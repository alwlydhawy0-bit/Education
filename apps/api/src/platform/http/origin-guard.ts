import type { FastifyInstance } from 'fastify';
import { forbidden } from '@edu/kernel';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for a cookie-authenticated API.
 *
 * The session cookie is `SameSite=Strict`, which already blocks the classic
 * cross-site form post. This is the second layer, because SameSite alone is a
 * browser-behaviour dependency and has had bypasses: every state-changing
 * request must additionally carry an `Origin` header naming an allow-listed
 * origin.
 *
 * A missing Origin on a state-changing request is REJECTED rather than allowed.
 * Modern browsers always send it on cross-origin and on same-origin
 * POST/PUT/DELETE, so the only callers this breaks are non-browser clients —
 * which should be using a token, not a cookie. Defaulting to "allow when
 * absent" is the mistake that makes most Origin checks decorative.
 *
 * WHY `preHandler` AND NOT `onRequest`
 * ------------------------------------
 * Fastify guarantees that every `onRequest` hook runs before any `preHandler`.
 * The rate limiter is an `onRequest` hook, so putting this check at `preHandler`
 * guarantees a rejected request has already been COUNTED.
 *
 * With this check at `onRequest` it ran first (plugin hooks are appended when
 * the plugin loads, not when it is registered), so an attacker could send
 * unlimited requests simply by setting a wrong Origin header: each was a cheap
 * 403, none was ever counted, and the flood was invisible to the rate-limit
 * signal. `tests/security/rate-limiting.test.ts` fails if this moves back.
 *
 * The cost is that the body is parsed before rejection. That is bounded by the
 * 256 KiB body limit and is a good trade for making the flood visible — and no
 * handler runs, so nothing is mutated either way.
 */
export function registerOriginGuard(app: FastifyInstance, allowedOrigins: readonly string[]): void {
  const allowed = new Set(allowedOrigins);

  app.addHook('preHandler', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;

    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !allowed.has(origin)) {
      throw forbidden('Cross-origin request rejected');
    }
  });
}
