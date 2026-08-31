import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  currentUserV2Schema,
  forgotPasswordRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
  resetPasswordRequestSchema,
  verifyEmailRequestSchema,
} from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.ts';
import { RATE_LIMIT_POLICIES, routeLimit } from '../../platform/security/rate-limit.ts';
import type { IdentityService, IssuedSession, RequestMeta } from './identity.service.ts';

export interface IdentityRoutesDeps {
  readonly identity: IdentityService;
  readonly cookieName: string;
  readonly refreshCookieName: string;
  readonly cookieSecure: boolean;
}

/** Path the refresh cookie is scoped to. Must match the refresh route exactly. */
const REFRESH_PATH = '/api/v1/auth/refresh';

export function registerIdentityRoutes(app: FastifyInstance, deps: IdentityRoutesDeps): void {
  const { identity, cookieName, refreshCookieName, cookieSecure } = deps;

  const baseCookie = {
    // Not readable from JavaScript: an XSS bug cannot exfiltrate the session.
    httpOnly: true,
    // Not sent over plaintext. Forced true in production/staging by config.
    secure: cookieSecure,
    // Not attached to cross-site requests at all — the first CSRF layer.
    sameSite: 'strict',
  } as const;

  const accessCookie = { ...baseCookie, path: '/' } as const;

  /**
   * The refresh cookie is scoped to the refresh endpoint alone.
   *
   * The browser therefore does not attach the long-lived credential to ordinary
   * API calls, so it is absent from the vast majority of requests, logs and
   * proxies. Narrowing exposure costs nothing here because only one endpoint
   * ever needs it.
   */
  const refreshCookie = { ...baseCookie, path: REFRESH_PATH } as const;

  const metaOf = (request: {
    ip: string;
    headers: Record<string, unknown>;
    correlationId: string;
  }): RequestMeta => ({
    ip: request.ip,
    userAgent:
      typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    correlationId: request.correlationId,
  });

  function setSessionCookies(reply: FastifyReply, session: IssuedSession): FastifyReply {
    return reply
      .setCookie(cookieName, session.accessToken, { ...accessCookie, expires: session.expiresAt })
      .setCookie(refreshCookieName, session.refreshToken, {
        ...refreshCookie,
        expires: session.refreshExpiresAt,
      });
  }

  app.post('/api/v1/auth/register', {
    config: routeLimit(RATE_LIMIT_POLICIES.authRegister),
    handler: async (request, reply) => {
      const input = registerRequestSchema.parse(request.body);
      const { userId } = await identity.register(input, metaOf(request));
      // Registration does NOT log the user in: session issuance stays a single
      // code path, so there is one place where a session can be minted.
      return reply.status(201).send({ id: userId });
    },
  });

  app.post('/api/v1/auth/login', {
    config: routeLimit(RATE_LIMIT_POLICIES.authLogin),
    handler: async (request, reply) => {
      const input = loginRequestSchema.parse(request.body);
      const session = await identity.login(input, metaOf(request));
      return setSessionCookies(reply, session).status(204).send();
    },
  });

  app.post(REFRESH_PATH, {
    config: routeLimit(RATE_LIMIT_POLICIES.authRefresh),
    handler: async (request, reply) => {
      const token = request.cookies[refreshCookieName];
      if (!token) {
        // Same shape as an invalid token: no distinction between "you sent
        // nothing" and "what you sent is dead".
        return reply.status(401).send({
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Session is no longer valid',
            correlationId: request.correlationId,
          },
        });
      }
      const session = await identity.refresh(token, metaOf(request));
      return setSessionCookies(reply, session).status(204).send();
    },
  });

  app.post('/api/v1/auth/logout', {
    handler: async (request, reply) => {
      const token = request.cookies[cookieName];
      if (token) await identity.logout(token, metaOf(request));
      // Always clear both cookies and always return 204, whether or not a valid
      // session was present: logout must not report whether a token was real.
      return reply
        .clearCookie(cookieName, accessCookie)
        .clearCookie(refreshCookieName, refreshCookie)
        .status(204)
        .send();
    },
  });

  app.post('/api/v1/auth/logout-all', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const actor = request.actor;
      if (!actor) throw new Error('unreachable: requireActor guarantees an actor');
      await identity.logoutAll(actor.id, metaOf(request));
      return reply
        .clearCookie(cookieName, accessCookie)
        .clearCookie(refreshCookieName, refreshCookie)
        .status(204)
        .send();
    },
  });

  app.post('/api/v1/auth/verify-email', {
    config: routeLimit(RATE_LIMIT_POLICIES.authVerifyEmail),
    handler: async (request, reply) => {
      const { token } = verifyEmailRequestSchema.parse(request.body);
      await identity.verifyEmail(token, metaOf(request));
      return reply.status(204).send();
    },
  });

  app.post('/api/v1/auth/forgot-password', {
    config: routeLimit(RATE_LIMIT_POLICIES.passwordReset),
    handler: async (request, reply) => {
      const { email } = forgotPasswordRequestSchema.parse(request.body);
      await identity.requestPasswordReset(email, metaOf(request));
      // Always 202, whether or not the address exists. Unlike registration,
      // this endpoint can be non-enumerating at no cost, so it is.
      return reply.status(202).send();
    },
  });

  app.post('/api/v1/auth/reset-password', {
    config: routeLimit(RATE_LIMIT_POLICIES.passwordReset),
    handler: async (request, reply) => {
      const { token, password } = resetPasswordRequestSchema.parse(request.body);
      await identity.resetPassword(token, password, metaOf(request));
      // Every session was revoked with the password change, so the caller must
      // log in again. Clearing the cookies here makes that state consistent.
      return reply
        .clearCookie(cookieName, accessCookie)
        .clearCookie(refreshCookieName, refreshCookie)
        .status(204)
        .send();
    },
  });

  app.get('/api/v1/auth/me', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const actor = request.actor;
      const identity = request.actorIdentity;
      if (!actor || !identity) {
        throw new Error('unreachable: requireActor guarantees an actor and its identity');
      }

      // Parsed through the contract on the way OUT as well. Because the schema
      // is strict, a field accidentally added to the actor (a password hash,
      // say) becomes a loud 500 rather than a silent disclosure.
      const body = currentUserV2Schema.parse({
        id: actor.id,
        email: identity.email,
        displayName: identity.displayName,
        roles: actor.roles,
        grants: actor.grants,
        permissions: actor.permissions,
        locale: identity.locale,
        organizationId: actor.organizationId,
        emailVerified: actor.emailVerified,
      });
      return reply.status(200).send(body);
    },
  });
}
