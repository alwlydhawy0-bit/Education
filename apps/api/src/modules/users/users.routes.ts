import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  adminUpdateUserRequestSchema,
  adminUserResponseSchema,
  assignRoleRequestSchema,
  createListQuerySchema,
  idSchema,
  profileResponseSchema,
  updateProfileRequestSchema,
} from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.ts';
import type { ActorContext, UsersService } from './users.service.ts';
import type { ProfileRecord, UserRecord } from './users.repository.ts';

const userParamsSchema = z.object({ id: idSchema }).strict();

/**
 * Admin listing accepts pagination only.
 *
 * There is deliberately no `organizationId` filter: the organization comes from
 * the session, so no caller can point the listing at another school. Adding one
 * later would need a policy change, not just a query change.
 */
const adminListQuerySchema = createListQuerySchema({
  sortableFields: ['createdAt'],
  defaultSort: 'createdAt',
  defaultOrder: 'desc',
});

function toProfileResponse(profile: ProfileRecord): unknown {
  return profileResponseSchema.parse({
    userId: profile.userId,
    displayName: profile.displayName,
    fullName: profile.fullName,
    avatarUrl: profile.avatarUrl,
    bio: profile.bio,
    locale: profile.locale,
    updatedAt: profile.updatedAt.toISOString(),
  });
}

function toUserResponse(user: UserRecord, roles: string[]): unknown {
  // Validated on the way OUT: because the schema is strict, a field
  // accidentally added to the record (a password hash, say) becomes a loud 500
  // rather than a silent disclosure.
  return adminUserResponseSchema.parse({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    organizationId: user.organizationId,
    emailVerified: user.emailVerified,
    roles,
    createdAt: user.createdAt.toISOString(),
  });
}

export function registerUsersRoutes(app: FastifyInstance, users: UsersService): void {
  function contextOf(request: FastifyRequest): ActorContext {
    const actor = request.actor;
    if (!actor) throw new Error('unreachable: requireActor guarantees an actor');
    return {
      actor,
      loadRelationships: () => request.loadRelationships(),
      correlationId: request.correlationId,
      ip: request.ip,
    };
  }

  // --- Own profile ---------------------------------------------------------
  app.get('/api/v1/profile', {
    preHandler: requireActor,
    handler: async (request, reply) =>
      reply.status(200).send(toProfileResponse(await users.getOwnProfile(contextOf(request)))),
  });

  app.patch('/api/v1/profile', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const input = updateProfileRequestSchema.parse(request.body);
      const updated = await users.updateOwnProfile(contextOf(request), input);
      return reply.status(200).send(toProfileResponse(updated));
    },
  });

  // --- Another user's profile, subject to relationship authorization -------
  app.get('/api/v1/users/:id/profile', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = userParamsSchema.parse(request.params);
      const profile = await users.getProfile(contextOf(request), id);
      return reply.status(200).send(toProfileResponse(profile));
    },
  });

  // --- Administration ------------------------------------------------------
  app.get('/api/v1/admin/users', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { limit, offset } = adminListQuerySchema.parse(request.query ?? {});
      const ctx = contextOf(request);
      const found = await users.listUsers(ctx, limit, offset);
      // Roles are fetched per user rather than joined, so each one still passes
      // through the same authorization path as a direct read.
      const items = await Promise.all(
        found.map(async (user) => {
          const grants = await users.listGrants(ctx, user.id);
          return toUserResponse(user, [...new Set(grants.map((g) => g.role))]);
        }),
      );
      return reply.status(200).send({ items });
    },
  });

  app.get('/api/v1/admin/users/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = userParamsSchema.parse(request.params);
      const ctx = contextOf(request);
      const user = await users.getUser(ctx, id);
      const grants = await users.listGrants(ctx, id);
      return reply.status(200).send(toUserResponse(user, [...new Set(grants.map((g) => g.role))]));
    },
  });

  app.patch('/api/v1/admin/users/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = userParamsSchema.parse(request.params);
      const { status } = adminUpdateUserRequestSchema.parse(request.body);
      const ctx = contextOf(request);
      const updated = await users.setUserStatus(ctx, id, status);
      const grants = await users.listGrants(ctx, id);
      return reply
        .status(200)
        .send(toUserResponse(updated, [...new Set(grants.map((g) => g.role))]));
    },
  });

  app.post('/api/v1/admin/users/:id/roles', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = userParamsSchema.parse(request.params);
      const input = assignRoleRequestSchema.parse(request.body);
      await users.assignRole(contextOf(request), id, input);
      return reply.status(204).send();
    },
  });

  app.delete('/api/v1/admin/users/:id/roles', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = userParamsSchema.parse(request.params);
      const input = assignRoleRequestSchema.parse(request.body);
      await users.revokeRole(contextOf(request), id, input);
      return reply.status(204).send();
    },
  });
}
