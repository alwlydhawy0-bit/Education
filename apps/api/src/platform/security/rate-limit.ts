import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { SecurityEventType, type Logger } from '@edu/observability';
import type { SecurityEventRecorder } from './security-events.ts';

/**
 * Rate limiting policy catalogue.
 *
 * Limits live here as named data rather than as magic numbers scattered across
 * route definitions, so that the whole throttling posture can be reviewed on one
 * screen and changed in one place.
 *
 * ---------------------------------------------------------------------------
 * HONEST STATEMENT OF WHAT THIS IS
 *
 * This is a PER-PROCESS, IN-MEMORY limiter. It is NOT production-grade for a
 * multi-instance deployment:
 *
 *   - Counters are not shared between instances. With N instances behind a load
 *     balancer, the effective limit is N times the configured value.
 *   - Counters reset on restart, so a deploy clears every attacker's budget.
 *   - Keying is by socket address (`request.ip`) with `trustProxy: false`. That
 *     is correct for direct exposure and NOT correct behind a proxy, where
 *     every request would appear to come from the proxy. Introducing a proxy
 *     REQUIRES configuring `trustProxy` at the same time, or per-IP limiting
 *     silently becomes a single global limit.
 *
 * The production requirement is a shared store (Redis or equivalent) via the
 * plugin's `store` option. It is not implemented; see
 * docs/security/rate-limiting.md and RISK-RATE-01 in the threat model.
 * ---------------------------------------------------------------------------
 */

export interface RateLimitPolicy {
  /** Stable identifier, used in logs and security events. */
  readonly name: string;
  readonly max: number;
  readonly timeWindow: string;
  readonly rationale: string;
}

/**
 * Policies that are ACTUALLY WIRED to a route today. Every entry here is
 * enforced and covered by a test.
 */
export const RATE_LIMIT_POLICIES = {
  /** Applied to every route unless a route overrides it. */
  global: {
    name: 'global',
    max: 300,
    timeWindow: '1 minute',
    rationale:
      'Blunt ceiling on any single source. High enough not to affect a classroom sharing an IP.',
  },

  /**
   * The endpoint an attacker brute-forces. Deliberately far tighter than the
   * global limit, and tighter than registration, because a success here is an
   * account takeover.
   */
  authLogin: {
    name: 'auth.login',
    max: 10,
    timeWindow: '15 minutes',
    rationale: 'Credential stuffing and password brute force.',
  },

  /**
   * Registration is expensive (an Argon2 hash per call) and is the vector for
   * the account-enumeration weakness documented as RISK-ENUM-01, so the limit
   * doubles as the compensating control for it.
   */
  authRegister: {
    name: 'auth.register',
    max: 5,
    timeWindow: '15 minutes',
    rationale: 'Bulk account creation, Argon2 CPU exhaustion, email enumeration.',
  },
} as const satisfies Record<string, RateLimitPolicy>;

/**
 * Policies that are DECLARED BUT NOT ENFORCED, because the routes they would
 * protect do not exist yet.
 *
 * They are recorded here so the limit is decided alongside the feature rather
 * than bolted on afterwards. Nothing reads this object at runtime — it is
 * documentation with a type attached, and `tests/unit/rate-limit.test.ts`
 * asserts these are not mistaken for active policies.
 */
export const RESERVED_RATE_LIMIT_POLICIES = {
  passwordReset: {
    name: 'auth.password_reset',
    max: 5,
    timeWindow: '1 hour',
    rationale: 'Reset-token flooding and user harassment. No reset flow exists yet.',
  },
  aiRequest: {
    name: 'ai.request',
    max: 60,
    timeWindow: '1 hour',
    rationale: 'Provider cost is real money; must be per-actor, not per-IP. No AI exists yet.',
  },
  fileUpload: {
    name: 'file.upload',
    max: 20,
    timeWindow: '1 hour',
    rationale: 'Storage exhaustion and malware-scanner saturation. No upload route exists yet.',
  },
  expensiveOperation: {
    name: 'operation.expensive',
    max: 30,
    timeWindow: '1 hour',
    rationale: 'Report generation, bulk export, search. None exist yet.',
  },
} as const satisfies Record<string, RateLimitPolicy>;

/** Shape a route uses to opt into a named policy. */
export function routeLimit(policy: RateLimitPolicy): {
  rateLimit: { max: number; timeWindow: string };
} {
  return { rateLimit: { max: policy.max, timeWindow: policy.timeWindow } };
}

export interface RateLimitDeps {
  readonly enabled: boolean;
  readonly hardenedEnvironment: boolean;
  readonly securityEvents: SecurityEventRecorder;
  readonly logger: Logger;
}

export async function registerRateLimiting(
  app: FastifyInstance,
  deps: RateLimitDeps,
): Promise<void> {
  const { enabled, hardenedEnvironment, securityEvents, logger } = deps;

  if (!enabled) {
    // Config refuses this combination in production and staging, so reaching
    // here means development or a test.
    logger.warn('rate limiting is DISABLED — expected only in development and tests');
    return;
  }

  if (hardenedEnvironment) {
    // Loud, every boot, until a shared store exists. A quiet limitation is one
    // that gets forgotten.
    logger.warn(
      'rate limiting uses an in-process store; limits are per-instance and are NOT shared across replicas',
      { requirement: 'shared store (Redis or equivalent)', risk: 'RISK-RATE-01' },
    );
  }

  await app.register(rateLimit, {
    global: true,
    max: RATE_LIMIT_POLICIES.global.max,
    timeWindow: RATE_LIMIT_POLICIES.global.timeWindow,
    keyGenerator: (request) => request.ip,

    /**
     * Exceeding a limit is a security event, not just a 429.
     *
     * A burst from one source is how credential stuffing, scraping and
     * enumeration look from the server side, so it belongs in the audit trail
     * alongside authorization denials.
     *
     * This hook is synchronous, so the write is fire-and-forget; a failure to
     * record must never turn a 429 into a 500.
     */
    onExceeded: (request) => {
      void securityEvents
        .record({
          type: SecurityEventType.RATE_LIMIT_EXCEEDED,
          // Always null, and correctly so. This hook runs at `onRequest`, and
          // the session is not resolved until `preHandler` — so there is no
          // actor to attribute yet. Reading `request.actor` here would look like
          // per-actor attribution while silently always producing null.
          //
          // Rate limiting is keyed by IP for exactly the same reason: it must
          // work for unauthenticated traffic, which is most of the abuse. Actor
          // -scoped quotas (the reserved `ai.request` policy needs them) require
          // a limiter that runs after authentication.
          actorId: null,
          correlationId: request.correlationId,
          ip: request.ip,
          // Route pattern, never the concrete URL: a URL can contain identifiers
          // and query values we would rather not retain.
          detail: { method: request.method, route: request.routeOptions?.url ?? 'unknown' },
          occurredAt: new Date(),
        })
        .catch((error: unknown) => {
          logger.error('failed to record a rate-limit security event', { error });
        });
    },
  });
}
