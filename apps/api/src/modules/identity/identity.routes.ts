import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  currentUserResponseSchema,
  loginRequestSchema,
  registerRequestSchema,
} from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.js';
import type { IdentityService } from './identity.service.js';

export interface IdentityRoutesDeps {
  readonly identity: IdentityService;
  readonly cookieName: string;
  readonly cookieSecure: boolean;
}

export function registerIdentityRoutes(app: FastifyInstance, deps: IdentityRoutesDeps): void {
  const { identity, cookieName, cookieSecure } = deps;

  const cookieOptions = {
    // Not readable from JavaScript: an XSS bug cannot exfiltrate the session.
    httpOnly: true,
    // Not sent over plaintext. Enforced true in production by config.ts.
    secure: cookieSecure,
    // Not attached to cross-site requests at all — first CSRF layer.
    sameSite: 'strict',
    path: '/',
  } as const;

  app.post('/api/v1/auth/register', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const input = registerRequestSchema.parse(request.body);
      const { userId } = await identity.register(input, {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        correlationId: request.correlationId,
      });
      // Registration does NOT log the user in. Session issuance stays a single
      // code path (login), so there is one place where a session can be minted.
      return reply.status(201).send({ id: userId });
    },
  });

  app.post('/api/v1/auth/login', {
    // Tighter than the global limit: this is the endpoint an attacker
    // brute-forces. Keyed per IP by the global rate-limit plugin config.
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    handler: async (request, reply) => {
      const input = loginRequestSchema.parse(request.body);
      const { token, expiresAt } = await identity.login(input, {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        correlationId: request.correlationId,
      });
      return reply
        .setCookie(cookieName, token, { ...cookieOptions, expires: expiresAt })
        .status(204)
        .send();
    },
  });

  app.post('/api/v1/auth/logout', {
    handler: async (request, reply) => {
      const token = request.cookies[cookieName];
      if (token) {
        await identity.logout(token, {
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          correlationId: request.correlationId,
        });
      }
      // Always clear the cookie and always return 204, whether or not a valid
      // session was present. Logout must not report whether a token was real.
      return reply.clearCookie(cookieName, cookieOptions).status(204).send();
    },
  });

  app.get('/api/v1/auth/me', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const actor = request.actor;
      if (!actor) throw new Error('unreachable: requireActor guarantees an actor');

      const resolved = await identity.authenticate(request.cookies[cookieName] ?? '');
      if (!resolved) throw new Error('unreachable: the session resolved during authentication');

      // The response is parsed through the contract on the way OUT as well.
      // Because the schema is `.strict()`, a column accidentally added to the
      // query (a password hash, say) becomes a loud 500 rather than a silent
      // disclosure.
      const body = currentUserResponseSchema.parse({
        id: resolved.session.userId,
        email: resolved.session.email,
        displayName: resolved.session.displayName,
        roles: resolved.session.roles,
        locale: resolved.session.locale,
        organizationId: resolved.session.organizationId,
      });
      return reply.status(200).send(body);
    },
  });
}

export const identityRouteSchemas = { registerRequestSchema, loginRequestSchema, z };
