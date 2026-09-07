import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { rateLimited } from '@edu/kernel';
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
  /**
   * Refresh is legitimate but frequent. The limit is generous enough for normal
   * rotation and tight enough that grinding stolen refresh tokens is slow.
   */
  authRefresh: {
    name: 'auth.refresh',
    max: 60,
    timeWindow: '15 minutes',
    rationale: 'Refresh-token grinding and rotation abuse.',
  },

  /**
   * Reset is the classic harassment and enumeration endpoint: unlimited
   * requests mean unlimited emails to a victim's inbox.
   */
  passwordReset: {
    name: 'auth.password_reset',
    max: 5,
    timeWindow: '1 hour',
    rationale: 'Reset-token flooding, inbox harassment, and account enumeration.',
  },

  /**
   * Starting an assessment attempt.
   *
   * The abuse this bounds is answer-key probing: start an attempt, submit a
   * guess, read the score, vary one answer, repeat. It is a SECONDARY control
   * and the number reflects that honestly.
   *
   * The primary control is the per-assessment attempt limit, which is per
   * LEARNER and enforced by a database trigger over a definer count. This
   * limiter is keyed by IP (see the header) and a classroom shares one, so a
   * limit tight enough to stop a determined grinder would also stop a class of
   * thirty sitting a test together. 200 in fifteen minutes leaves a full class
   * ample room while cutting a scripted grinder from the global 300/minute to
   * roughly 13/minute.
   */
  assessmentAttempt: {
    name: 'assessment.attempt',
    max: 200,
    timeWindow: '15 minutes',
    rationale: 'Answer-key probing through repeated attempts. Secondary to the per-learner limit.',
  },

  /**
   * Submitting an attempt. Scoring runs a query per question inside a trigger,
   * so a submission is also the most expensive request in this domain.
   */
  assessmentSubmit: {
    name: 'assessment.submit',
    max: 200,
    timeWindow: '15 minutes',
    rationale: 'Repeated scoring is the expensive half of answer-key probing.',
  },

  /**
   * A question to the learning assistant (Task 013).
   *
   * PROMOTED FROM `RESERVED_RATE_LIMIT_POLICIES`, where it was declared with the
   * note "must be per-actor, not per-IP" — and it now is. This is the ONLY
   * policy on the platform keyed by the authenticated actor rather than by IP,
   * and the reason is that the abuse and the cost are both per-person: a
   * classroom of thirty sharing one address must not exhaust each other's
   * quota, and one learner scripting a loop must not be able to spend the
   * school's provider budget behind a shared NAT.
   *
   * 60 an hour is roughly one a minute — generous for somebody studying, and
   * far below what an automated loop wants. It is a COST and ABUSE control, not
   * a correctness one: nothing about authorization depends on it.
   */
  aiRequest: {
    name: 'ai.request',
    max: 60,
    timeWindow: '1 hour',
    rationale: 'Provider cost is real money. Keyed per actor so a shared IP is not a shared quota.',
  },

  /**
   * Starting a lab session (Task 009).
   *
   * THIS LIMITER CARRIES MORE WEIGHT THAN ITS ASSESSMENT COUNTERPART, and the
   * reason is a deliberate product difference rather than an oversight. An
   * assessment has `max_attempts`, enforced per learner by a database trigger.
   * A LAB HAS NO ATTEMPT LIMIT AND SHOULD NOT: "keep adjusting it until the
   * circuit works" is the pedagogy, not a loophole in it, and a lab that locked
   * a child out after three tries would be a worse lab.
   *
   * So this is the only bound on how many sessions one source can open. It is
   * still a SECONDARY control — what it protects is platform cost, not the
   * validation rules, which stay hidden whatever a learner does: a submission
   * answers "not yet", never "the voltage must be 5". A scripted grinder learns
   * one bit per submission about a lab it is already allowed to attempt.
   *
   * Keyed by IP like every policy but `ai.request`, and a classroom shares one,
   * so the number has to fit thirty children starting labs in a double period.
   */
  labSessionStart: {
    name: 'lab.session_start',
    max: 200,
    timeWindow: '15 minutes',
    rationale: 'The only bound on session creation: a lab has no attempt limit, by design.',
  },

  /**
   * Submitting a lab.
   *
   * Marking runs `app_experiment_rule_holds` once per rule inside a trigger, so
   * a submission is the most expensive request in this domain — the same shape
   * of cost as `assessment.submit`, and bounded the same way.
   */
  labSubmit: {
    name: 'lab.submit',
    max: 200,
    timeWindow: '15 minutes',
    rationale: 'Marking is the expensive half of a lab, and repeated marking is how it is abused.',
  },

  /**
   * Registering a workspace artifact (Task 010).
   *
   * The quota is the real control and it is enforced in the database, so this
   * bounds something different: the RATE at which rows are created, which the
   * quota does not touch at all. A learner could register a million one-byte
   * artifacts and stay comfortably inside 256 MiB while filling the table.
   *
   * Keyed by IP like every policy but `ai.request`, so the number has to leave
   * a classroom room to work in.
   */
  workspaceArtifact: {
    name: 'workspace.artifact',
    max: 120,
    timeWindow: '15 minutes',
    rationale: 'Row-count abuse, which a byte quota does not bound.',
  },

  /**
   * One turn of an AI tutor conversation (Task 012).
   *
   * KEYED PER ACTOR, like `aiRequest`, and for the same reason: a classroom of
   * thirty behind one school NAT must not share a quota, and one learner
   * scripting a loop must not be able to spend the school's provider budget
   * from behind it.
   *
   * TIGHTER THAN `aiRequest` (40 an hour against 60), because a conversation
   * turn costs more than a single question does: it carries retrieved passages
   * AND up to ten replayed turns, so the same number of requests buys the
   * provider considerably more text to read. The limit is on the expensive
   * thing rather than on the visible one.
   *
   * It is a COST and ABUSE control, not a correctness one. Nothing about
   * authorization depends on it, and the security suite asserts the boundaries
   * hold with rate limiting switched off entirely.
   */
  tutorMessage: {
    name: 'tutor.message',
    max: 40,
    timeWindow: '1 hour',
    rationale: 'A conversation turn carries sources and history, so it costs more than a question.',
  },

  /**
   * Starting a tutor conversation (Task 012).
   *
   * Cheap in itself — a row and a scope check — but it is the operation that
   * MULTIPLIES the expensive one: without a bound, a script could open a
   * thousand conversations and spend a fresh message budget in each. Bounding
   * creation is what stops the per-conversation cost being unbounded in
   * aggregate.
   */
  tutorConversation: {
    name: 'tutor.conversation',
    max: 30,
    timeWindow: '1 hour',
    rationale: 'Bounds the multiplier on the per-turn budget rather than the row cost.',
  },

  /**
   * Rebuilding a course's knowledge-base index (Task 011).
   *
   * THE MOST EXPENSIVE REQUEST ON THE PLATFORM: it reads every published lesson
   * of a course, chunks all of them and embeds every chunk. With a vendor
   * embedding provider that is also the only route that spends money per
   * paragraph rather than per request.
   *
   * Tight, and it can afford to be — re-indexing is an editorial action taken
   * by a handful of staff after a course changes, not something a classroom
   * does. A limit that would obstruct thirty children does not apply here.
   */
  knowledgeIndex: {
    name: 'knowledge.index',
    max: 20,
    timeWindow: '1 hour',
    rationale: 'Whole-course read, chunk and embed. Editorial frequency, provider cost.',
  },

  /**
   * Asking the knowledge base a question.
   *
   * Bounds embedding cost and the vector scan, both of which are per-request
   * rather than per-actor. Keyed by IP like every policy but `ai.request`, so
   * the number has to leave a classroom working room — a lesson where thirty
   * children each ask a few questions must not exhaust it.
   */
  knowledgeRetrieve: {
    name: 'knowledge.retrieve',
    max: 300,
    timeWindow: '15 minutes',
    rationale: 'One embedding call and one vector scan per question.',
  },

  /** Guessing a verification token is the attack this bounds. */
  /**
   * THE PUBLIC PORTFOLIO RESOLVER — the only unauthenticated route on this
   * platform that reads children's content.
   *
   * Tighter than every other read policy, and keyed by IP because there is no
   * actor to key by. Two things make this the route that needs a number:
   *
   *   - A `public_slug` is a GUESSABLE NAME, not a secret. Somebody walking the
   *     namespace — `/portfolios/share/ahmed`, `/omar`, `/sara` — is enumerating
   *     children's public pages, and the only thing standing between them and
   *     doing it quickly is this limit.
   *
   *   - Every miss is a database round trip that runs RLS over four tables, so
   *     an unauthenticated caller can spend the platform's CPU without ever
   *     logging in.
   *
   * A share token is 256 bits and not worth guessing at any rate, so the number
   * is set for the slug case. 60 in 15 minutes leaves a classroom of learners
   * opening each other's shared links comfortable room while making a walk of
   * the namespace take a very long time.
   */
  publicPortfolio: {
    name: 'portfolio.public',
    max: 60,
    timeWindow: '15 minutes',
    rationale: 'Slug enumeration against an unauthenticated route serving minors\' pages.',
  },

  /** Creating or editing a project. Row-count abuse, as with artifacts. */
  projectWrite: {
    name: 'project.write',
    max: 120,
    timeWindow: '15 minutes',
    rationale: 'Row-count abuse on a table with no byte quota to bound it.',
  },

  /**
   * Posting to a forum.
   *
   * Generous, because posting is what the forum is FOR and a learner who writes
   * too much is a teacher's problem rather than a security one. What this bounds
   * is a script, not a chatty child.
   */
  forumPost: {
    name: 'forum.post',
    max: 60,
    timeWindow: '15 minutes',
    rationale: 'Automated flooding of a class feed. Not aimed at ordinary use.',
  },

  /**
   * REPORTING A POST — TIGHTER THAN POSTING, which looks backwards and is not.
   *
   * Reporting is the route that can be turned against a person. Filing enough
   * reports buries a moderation queue so that real ones are not read, and that
   * is an attack on every child in the school rather than on one. The
   * one-report-per-person index in 0029 makes piling onto a single post
   * structurally impossible; this bounds the broader flood.
   *
   * Set low enough to make burying a queue slow and high enough that a child
   * having a genuinely bad afternoon can report everything that happened.
   */
  contentReport: {
    name: 'moderation.report',
    max: 20,
    timeWindow: '15 minutes',
    rationale: 'Burying a moderation queue so genuine reports go unread.',
  },

  /** Moderation actions. Staff-only, so this is a runaway-script bound. */
  moderationAction: {
    name: 'moderation.action',
    max: 200,
    timeWindow: '15 minutes',
    rationale: 'A stuck client replaying moderation writes.',
  },

  authVerifyEmail: {
    name: 'auth.verify_email',
    max: 20,
    timeWindow: '1 hour',
    rationale: 'Brute-forcing a verification token.',
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

/**
 * A limiter keyed by the AUTHENTICATED ACTOR rather than by IP address.
 *
 * WHY THIS EXISTS AT ALL. The plugin's limiter runs at `onRequest`, which is
 * before the session is resolved at `preHandler` — so `request.actor` is always
 * null there, and a `keyGenerator` reading it would look like per-actor
 * attribution while silently keying everything under one bucket. The note in
 * `onExceeded` below has said so since Task 008; Task 013 is the first feature
 * that actually needs the thing it describes.
 *
 * WHY THE ASSISTANT NEEDS IT AND OTHER ROUTES DO NOT. Provider calls cost real
 * money per request, and a classroom shares one public address. An IP-keyed
 * quota would mean thirty learners in one room exhausting each other's budget,
 * while one learner scripting a loop from home gets the whole allowance to
 * themselves. Both failures are backwards.
 *
 * THIS IS NOT A SECOND RATE-LIMITING ARCHITECTURE. It uses the same policy
 * objects, the same `ratelimit.exceeded` event and the same 429, and it runs
 * IN ADDITION to the global IP limiter rather than instead of it — an
 * unauthenticated flood is still stopped before it reaches here.
 *
 * IT SHARES THE HONEST LIMITATION stated at the top of this file: the counters
 * are in-process, so with N instances the effective limit is N times the
 * configured value (RISK-RATE-01). For a cost control that means the bill can
 * be N times the intended ceiling, which is recorded rather than glossed.
 */
export function actorRateLimiter(
  policy: RateLimitPolicy,
  deps: { readonly enabled: boolean; readonly securityEvents: SecurityEventRecorder },
): preHandlerAsyncHookHandler {
  const windowMs = parseWindow(policy.timeWindow);
  // Keyed by actor id. Entries are pruned on read rather than by a timer, so
  // there is no interval to leak and an idle process holds nothing.
  const hits = new Map<string, number[]>();

  return async function enforce(request: FastifyRequest): Promise<void> {
    if (!deps.enabled) return;

    const actor = request.actor;
    // No actor means `requireActor` has not run or has already refused. Either
    // way this hook is not the place to decide authentication, so it defers —
    // it must be registered AFTER `requireActor`, which is what the route does.
    if (!actor) return;

    const now = Date.now();
    const recent = (hits.get(actor.id) ?? []).filter((at) => now - at < windowMs);

    if (recent.length >= policy.max) {
      hits.set(actor.id, recent);
      // Recorded WITH the actor id — the one thing the IP-keyed limiter cannot
      // do, and the reason a per-actor quota is worth having in the audit trail
      // as well as in the response.
      await deps.securityEvents.record({
        type: SecurityEventType.RATE_LIMIT_EXCEEDED,
        actorId: actor.id,
        correlationId: request.correlationId,
        ip: request.ip,
        detail: { policy: policy.name, route: request.routeOptions?.url ?? 'unknown' },
        occurredAt: new Date(),
      });
      throw rateLimited();
    }

    recent.push(now);
    hits.set(actor.id, recent);
  };
}

/** `"1 hour"`, `"15 minutes"`, `"30 seconds"` as milliseconds. */
function parseWindow(window: string): number {
  const match = /^(\d+)\s*(second|minute|hour)s?$/.exec(window.trim());
  if (!match) throw new Error(`Unsupported rate-limit window: "${window}"`);
  const amount = Number(match[1]);
  const unit = match[2];
  const scale = unit === 'second' ? 1_000 : unit === 'minute' ? 60_000 : 3_600_000;
  return amount * scale;
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
