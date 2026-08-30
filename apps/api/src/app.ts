import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { systemClock, type Clock } from '@edu/kernel';
import { createPolicyEngine } from '@edu/authz';
import { createLogger, stdoutJsonSink, type Logger } from '@edu/observability';
import type { AppConfig } from './platform/config.js';
import { createDatabase, type Database } from './platform/db.js';
import { createAuditWriter } from './platform/audit.js';
import { registerRequestContext } from './platform/http/context.js';
import { registerErrorHandler } from './platform/http/errors.js';
import { registerOriginGuard } from './platform/http/origin-guard.js';
import { registerAuthentication } from './platform/http/authentication.js';
import { createIdentityRepository } from './modules/identity/identity.repository.js';
import { createIdentityService } from './modules/identity/identity.service.js';
import { registerIdentityRoutes } from './modules/identity/identity.routes.js';
import { relationshipReader } from './modules/relationships/relationships.repository.js';
import { notebookRepository } from './modules/notebook/notebook.repository.js';
import { createNotebookService } from './modules/notebook/notebook.service.js';
import { registerNotebookRoutes } from './modules/notebook/notebook.routes.js';

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
  // context -> security headers -> origin guard -> cookies -> rate limit ->
  // authentication -> routes.
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

  registerOriginGuard(app, config.ALLOWED_ORIGINS);

  await app.register(cookie, {});

  if (config.RATE_LIMIT_ENABLED) {
    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: '1 minute',
      // Keyed on the socket address. With trustProxy false this cannot be
      // spoofed by a header; behind a real proxy, trustProxy must be configured
      // together with this.
      keyGenerator: (request) => request.ip,
    });
  }

  registerErrorHandler(app, logger);

  // --- Domain wiring ------------------------------------------------------
  const audit = createAuditWriter(db, logger);
  const engine = createPolicyEngine();

  const identityRepository = createIdentityRepository(db);
  const identity = createIdentityService({
    repository: identityRepository,
    audit,
    clock,
    sessionTtlHours: config.SESSION_TTL_HOURS,
  });

  const notebook = createNotebookService({
    db,
    repository: notebookRepository,
    engine,
    audit,
  });

  registerAuthentication(app, {
    identity,
    relationships: relationshipReader,
    db,
    audit,
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
    cookieSecure: config.SESSION_COOKIE_SECURE,
  });
  registerNotebookRoutes(app, notebook);

  return { app, db };
}
