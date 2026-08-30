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
 */
export function registerOriginGuard(app: FastifyInstance, allowedOrigins: readonly string[]): void {
  const allowed = new Set(allowedOrigins);

  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;

    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !allowed.has(origin)) {
      throw forbidden('Cross-origin request rejected');
    }
  });
}
