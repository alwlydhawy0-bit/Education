import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  emptyQuerySchema,
  createListQuerySchema,
  createOrganizationRequestSchema,
  idSchema,
  organizationResponseSchema,
  updateOrganizationRequestSchema,
} from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.ts';
import type { ActorContext, OrganizationsService } from './organizations.service.ts';
import type { OrganizationRecord } from './organizations.repository.ts';

const organizationParamsSchema = z.object({ id: idSchema }).strict();

/** Pagination only: the result set is scoped by RLS, not by a query parameter. */
const listQuerySchema = createListQuerySchema({
  sortableFields: ['createdAt'],
  defaultSort: 'createdAt',
  defaultOrder: 'desc',
});

const toResponse = (organization: OrganizationRecord): unknown =>
  organizationResponseSchema.parse({
    id: organization.id,
    name: organization.name,
    createdAt: organization.createdAt.toISOString(),
  });

export function registerOrganizationRoutes(
  app: FastifyInstance,
  organizations: OrganizationsService,
): void {
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

  app.post('/api/v1/organizations', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const input = createOrganizationRequestSchema.parse(request.body);
      const created = await organizations.create(contextOf(request), input);
      return reply.status(201).send(toResponse(created));
    },
  });

  app.get('/api/v1/organizations', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { limit, offset } = listQuerySchema.parse(request.query ?? {});
      const found = await organizations.list(contextOf(request), limit, offset);
      return reply.status(200).send({ items: found.map(toResponse) });
    },
  });

  app.get('/api/v1/organizations/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      emptyQuerySchema.parse(request.query ?? {});
      const { id } = organizationParamsSchema.parse(request.params);
      return reply.status(200).send(toResponse(await organizations.get(contextOf(request), id)));
    },
  });

  app.patch('/api/v1/organizations/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = organizationParamsSchema.parse(request.params);
      const input = updateOrganizationRequestSchema.parse(request.body);
      const updated = await organizations.update(contextOf(request), id, input);
      return reply.status(200).send(toResponse(updated));
    },
  });
}
