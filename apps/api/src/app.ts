import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { systemClock, type Clock } from '@edu/kernel';
import { createPolicyEngine } from '@edu/authz';
import { createLogger, SecurityEventType, stdoutJsonSink, type Logger } from '@edu/observability';
import type { AppConfig } from './platform/config.ts';
import { createDatabase, type Database } from './platform/db.ts';
import { createAuditWriter } from './platform/audit.ts';
import { registerRequestContext } from './platform/http/context.ts';
import { registerErrorHandler } from './platform/http/errors.ts';
import { registerOriginGuard } from './platform/http/origin-guard.ts';
import { registerAuthentication } from './platform/http/authentication.ts';
import { registerRateLimiting } from './platform/security/rate-limit.ts';
import { createSecurityEventRecorder } from './platform/security/security-events.ts';
import { createIdentityRepository } from './modules/identity/identity.repository.ts';
import { createIdentityService } from './modules/identity/identity.service.ts';
import { createLoggingMailDelivery, type MailDelivery } from './modules/identity/mail-delivery.ts';
import { registerIdentityRoutes } from './modules/identity/identity.routes.ts';
import { relationshipReader } from './modules/relationships/relationships.repository.ts';
import { notebookRepository } from './modules/notebook/notebook.repository.ts';
import { createNotebookService } from './modules/notebook/notebook.service.ts';
import { registerNotebookRoutes } from './modules/notebook/notebook.routes.ts';
import { usersRepository } from './modules/users/users.repository.ts';
import { createUsersService, roleAdministration } from './modules/users/users.service.ts';
import { registerUsersRoutes } from './modules/users/users.routes.ts';
import { organizationsRepository } from './modules/organizations/organizations.repository.ts';
import { createOrganizationsService } from './modules/organizations/organizations.service.ts';
import { registerOrganizationRoutes } from './modules/organizations/organizations.routes.ts';
import { classesRepository } from './modules/relationships/classes.repository.ts';
import { createClassesService } from './modules/relationships/classes.service.ts';
import { guardiansRepository } from './modules/relationships/guardians.repository.ts';
import { createGuardiansService } from './modules/relationships/guardians.service.ts';
import { progressRepository } from './modules/progress/progress.repository.ts';
import { createProgressService } from './modules/progress/progress.service.ts';
import { registerProgressRoutes } from './modules/progress/progress.routes.ts';
import { masteryRepository } from './modules/mastery/mastery.repository.ts';
import { createMasteryService } from './modules/mastery/mastery.service.ts';
import { registerMasteryRoutes } from './modules/mastery/mastery.routes.ts';
import { createAssistantRepository } from './modules/assistant/assistant.repository.ts';
import { createAssistantService } from './modules/assistant/assistant.service.ts';
import { registerAssistantRoutes } from './modules/assistant/assistant.routes.ts';
import { createGroundedComposer, type AiProvider } from './platform/ai/provider.ts';
import { assessmentRepository } from './modules/assessment/assessment.repository.ts';
import { createAssessmentService } from './modules/assessment/assessment.service.ts';
import { registerAssessmentRoutes } from './modules/assessment/assessment.routes.ts';
import { classCoursesRepository } from './modules/class-courses/class-courses.repository.ts';
import { createClassCoursesService } from './modules/class-courses/class-courses.service.ts';
import { registerClassCourseRoutes } from './modules/class-courses/class-courses.routes.ts';
import { curriculumRepository } from './modules/curriculum/curriculum.repository.ts';
import { createCurriculumService } from './modules/curriculum/curriculum.service.ts';
import { registerCurriculumRoutes } from './modules/curriculum/curriculum.routes.ts';
import { registerRelationshipRoutes } from './modules/relationships/relationships.routes.ts';

/**
 * Composition root.
 *
 * This is the ONLY file that knows about every module. Modules do not import
 * each other's internals; they are wired together here, through the interfaces
 * each one exports. That is what makes a domain extractable later: to move
 * `notebook` into its own service you replace its construction here, and
 * nothing inside `identity` changes.
 *
 * Everything is passed in explicitly — no singletons, no module-level state, no
 * service locator. The practical payoff is testability: the integration tests
 * build the same app with a test database and a fixed clock by calling this
 * function with different options.
 */
export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly database?: Database;
  readonly logger?: Logger;
  readonly clock?: Clock;
  /**
   * Overrides outbound email. Tests inject a capturing implementation so that
   * verification and reset tokens never have to be exposed over HTTP to be
   * testable — which would itself be an account-takeover vulnerability.
   */
  readonly mail?: MailDelivery;
  /**
   * Overrides the AI provider. Same purpose as `mail` above, and the same
   * precedent: some guarantees can only be proved by observing what a
   * collaborator RECEIVES.
   *
   * The one this exists for is negative — that a request refused by
   * authorization never reaches a provider at all. Over HTTP that is otherwise
   * invisible: a 404 looks identical whether the provider was skipped or
   * called and ignored, and the difference is the whole property. A counting
   * provider makes it observable.
   *
   * Production never passes this; `app.ts` selects the provider from
   * configuration when it is absent.
   */
  readonly aiProvider?: AiProvider;
}

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly db: Database;
}

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const { config } = options;

  const logger = options.logger ?? createLogger({ level: config.LOG_LEVEL, sink: stdoutJsonSink });
  const clock = options.clock ?? systemClock;
  const db =
    options.database ??
    createDatabase({
      connectionString: config.DATABASE_URL,
      poolMax: config.DATABASE_POOL_MAX,
    });

  const isHardenedEnvironment = config.NODE_ENV === 'production' || config.NODE_ENV === 'staging';

  const app = Fastify({
    // Fastify's own logger is disabled: all logging goes through the redacting
    // logger in @edu/observability, so there is exactly one path to the log
    // stream and exactly one place redaction can be bypassed (nowhere).
    logger: false,
    // Trust the proxy for `request.ip` only when configured to. Getting this
    // wrong makes per-IP rate limiting trivially bypassable via X-Forwarded-For.
    trustProxy: false,
    // Bounds request size before any parsing happens.
    bodyLimit: 256 * 1024,
  });

  // --- Order matters below. -----------------------------------------------
  //
  //   onRequest:   context -> security headers -> RATE LIMIT
  //   preHandler:  origin guard -> authentication
  //   then:        routes
  //
  // Fastify runs every `onRequest` hook before any `preHandler`, so the rate
  // limiter necessarily sees a request before the origin guard can reject it.
  // That ordering is deliberate: with the guard first, a request carrying a bad
  // Origin was rejected before ever being counted, so an attacker could flood
  // the server indefinitely just by sending a wrong Origin header and never
  // appear in the rate-limit signal.
  //
  // Registration order alone would NOT have achieved this: hooks added inside a
  // Fastify plugin (the rate limiter) are appended when the plugin loads, not
  // when it is registered, so a synchronously-added `onRequest` hook wins
  // regardless. The lifecycle guarantee is what makes this robust.
  registerRequestContext(app);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // No inline script, no eval. The web client is built, not inlined.
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    // The API serves JSON, never documents; refuse to be framed or sniffed.
    frameguard: { action: 'deny' },
    noSniff: true,
    referrerPolicy: { policy: 'no-referrer' },
    hsts:
      config.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  // Security-event plumbing is built first: the rate limiter records an event
  // when a limit is exceeded, so it needs the recorder before it registers.
  //
  // The audit writer is wrapped by the recorder and is not passed anywhere else
  // — the recorder is the only writer, which is what makes repeated-denial
  // detection see every denial.
  const audit = createAuditWriter(db, logger);
  const securityEvents = createSecurityEventRecorder({ audit, logger });

  await registerRateLimiting(app, {
    enabled: config.RATE_LIMIT_ENABLED,
    hardenedEnvironment: isHardenedEnvironment,
    securityEvents,
    logger,
  });

  registerOriginGuard(app, config.ALLOWED_ORIGINS);

  await app.register(cookie, {});

  registerErrorHandler(app, logger, securityEvents);

  // Record the security posture this process actually booted with.
  //
  // The configuration loader REFUSES these combinations in production and
  // staging, so in practice this fires only in development and tests. It exists
  // so that "which posture was this instance running?" is answerable from the
  // audit trail rather than from someone's memory of the deployment.
  const deviations = describeSecurityPostureDeviations(config);
  if (deviations.length > 0) {
    await securityEvents.record({
      type: SecurityEventType.SECURITY_CONFIG_DEVIATION,
      actorId: null,
      correlationId: 'boot',
      ip: null,
      detail: { environment: config.NODE_ENV, deviations },
      occurredAt: clock.now(),
    });
  }

  // --- Domain wiring ------------------------------------------------------
  const engine = createPolicyEngine();

  const identityRepository = createIdentityRepository(db);
  const identity = createIdentityService({
    repository: identityRepository,
    securityEvents,
    // No mail provider exists. `LoggingMailDelivery` records that a message
    // would have been sent and deliberately never logs the token.
    mail: options.mail ?? createLoggingMailDelivery(logger),
    clock,
    options: {
      sessionTtlHours: config.SESSION_TTL_HOURS,
      refreshTtlDays: config.REFRESH_TTL_DAYS,
      emailVerificationTtlHours: config.EMAIL_VERIFICATION_TTL_HOURS,
      passwordResetTtlMinutes: config.PASSWORD_RESET_TTL_MINUTES,
      maxFailedLogins: config.MAX_FAILED_LOGINS,
      lockoutMinutes: config.LOCKOUT_MINUTES,
      requireVerifiedEmailForLogin: config.REQUIRE_VERIFIED_EMAIL_FOR_LOGIN,
    },
  });

  const users = createUsersService({
    db,
    repository: usersRepository,
    roles: roleAdministration,
    engine,
    securityEvents,
  });

  const organizations = createOrganizationsService({
    db,
    repository: organizationsRepository,
    engine,
    securityEvents,
  });

  const classes = createClassesService({
    db,
    repository: classesRepository,
    engine,
    securityEvents,
  });

  const guardians = createGuardiansService({
    db,
    repository: guardiansRepository,
    engine,
    securityEvents,
  });

  const curriculum = createCurriculumService({
    db,
    repository: curriculumRepository,
    engine,
    securityEvents,
  });

  const classCourses = createClassCoursesService({
    db,
    repository: classCoursesRepository,
    engine,
    securityEvents,
  });

  const progress = createProgressService({
    db,
    repository: progressRepository,
    engine,
    securityEvents,
  });

  const mastery = createMasteryService({
    db,
    repository: masteryRepository,
    engine,
    securityEvents,
  });

  /**
   * The AI provider, selected once, here, and nowhere else.
   *
   * `none` selects the deterministic grounded composer — a real offline answer
   * composer, not a stub that returns a fixture. It keeps the whole pipeline
   * (authorization, retrieval, citation validation, refusal, quota) live and
   * testable with no vendor account, which is why it stays the default and why
   * the entire automated suite runs on it.
   *
   * THE VENDOR SDK IS IMPORTED LAZILY, and that is not a performance tweak. A
   * static import would load a vendor's code into every process this platform
   * runs — migrations, tests, a deployment configured with `none` — none of
   * which has any business holding it. With a dynamic import, a deployment that
   * has not opted in never loads the SDK at all, and the credential check in
   * `config.ts` has already refused to boot if a provider was named without a
   * key.
   *
   * Adding a second vendor means one more arm and one more sibling adapter.
   * Nothing else in the application changes, because nothing else knows a
   * provider exists.
   */
  const aiProvider = await (async (): Promise<AiProvider> => {
    if (options.aiProvider) return options.aiProvider;
    if (config.AI_PROVIDER === 'none') return createGroundedComposer();

    const apiKey = config.AI_API_KEY;
    if (apiKey === undefined || apiKey === '') {
      // Unreachable: the configuration schema already refuses to start when a
      // provider is named without a credential. Kept as a narrowing that is
      // also a second gate — an adapter constructed with an empty key would
      // fail on a child's first question instead of at boot, and this is the
      // last place that can still be a startup error.
      throw new Error('AI_PROVIDER is set but AI_API_KEY is missing — refusing to start.');
    }

    const { createAnthropicAdapter } = await import('./platform/ai/anthropic.adapter.ts');
    return createAnthropicAdapter({
      apiKey,
      model: config.AI_MODEL,
      maxOutputTokens: config.AI_MAX_OUTPUT_TOKENS,
      timeoutMs: config.AI_TIMEOUT_MS,
      baseURL: config.AI_BASE_URL,
    });
  })();

  const assistant = createAssistantService({
    db,
    repository: createAssistantRepository(),
    engine,
    securityEvents,
    provider: aiProvider,
    timeoutMs: config.AI_TIMEOUT_MS,
  });

  const assessment = createAssessmentService({
    db,
    repository: assessmentRepository,
    engine,
    securityEvents,
    /**
     * The one place the assessment domain and the progress domain meet.
     *
     * `assessment` declares a `LessonEngagementRecorder` it needs; `progress`
     * happens to satisfy it. Neither imports the other — dependency rule 3
     * forbids it and rule 4 says this file is where they are joined — and the
     * interface is narrow enough that submitting an assessment can only touch
     * a lesson's "last seen", never claim it was completed.
     */
    progress: { noteEngagement: progressRepository.noteEngagement },
  });

  const notebook = createNotebookService({
    db,
    repository: notebookRepository,
    engine,
    securityEvents,
  });

  registerAuthentication(app, {
    identity,
    relationships: relationshipReader,
    db,
    securityEvents,
    cookieName: config.SESSION_COOKIE_NAME,
  });

  // --- Routes -------------------------------------------------------------
  app.get('/api/v1/health', async () =>
    // Deliberately says nothing about version, dependencies, or database state.
    // A health endpoint is unauthenticated, so it must not become a
    // reconnaissance surface.
    ({ status: 'ok' }),
  );

  registerIdentityRoutes(app, {
    identity,
    cookieName: config.SESSION_COOKIE_NAME,
    refreshCookieName: config.REFRESH_COOKIE_NAME,
    cookieSecure: config.SESSION_COOKIE_SECURE,
  });
  registerNotebookRoutes(app, notebook);
  registerUsersRoutes(app, users);
  registerOrganizationRoutes(app, organizations);
  registerRelationshipRoutes(app, classes, guardians);
  registerCurriculumRoutes(app, curriculum);
  registerClassCourseRoutes(app, classCourses);
  registerProgressRoutes(app, progress);
  registerMasteryRoutes(app, mastery);
  registerAssessmentRoutes(app, assessment);
  registerAssistantRoutes(app, {
    assistant,
    securityEvents,
    rateLimitEnabled: config.RATE_LIMIT_ENABLED,
  });

  return { app, db };
}

/**
 * Security-relevant settings that differ from the safe defaults.
 *
 * Kept as a pure function so the boot-time event is testable without starting a
 * server.
 */
export function describeSecurityPostureDeviations(config: AppConfig): string[] {
  const deviations: string[] = [];
  if (!config.RATE_LIMIT_ENABLED) deviations.push('rate_limiting_disabled');
  if (!config.SESSION_COOKIE_SECURE) deviations.push('insecure_session_cookie');
  if (config.LOG_LEVEL === 'debug') deviations.push('debug_logging');
  if (config.ALLOWED_ORIGINS.some((origin) => origin.startsWith('http://'))) {
    deviations.push('plaintext_allowed_origin');
  }
  return deviations;
}
