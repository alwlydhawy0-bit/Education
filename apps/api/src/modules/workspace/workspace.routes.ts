import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createNotebookRequestSchema,
  emptyQuerySchema,
  idSchema,
  listArtifactsQuerySchema,
  listNotebooksQuerySchema,
  notebookResponseSchema,
  registerArtifactRequestSchema,
  storageQuotaResponseSchema,
  studentArtifactResponseSchema,
  updateNotebookRequestSchema,
} from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.ts';
import { RATE_LIMIT_POLICIES, routeLimit } from '../../platform/security/rate-limit.ts';
import type { ActorContext, WorkspaceService } from './workspace.service.ts';
import type { NotebookRecord, StudentArtifactRecord } from './workspace.repository.ts';

const idParams = z.object({ id: idSchema }).strict();

/**
 * Every response is built FIELD BY FIELD through a `.strict()` schema.
 *
 * The habit matters more here than almost anywhere: these rows carry a minor's
 * private filing, and a spread of a repository record would hand back
 * `organization_id` and anything a future column adds. There is nothing to
 * leak because there is nowhere for it to go.
 */
const toNotebook = (n: NotebookRecord): unknown =>
  notebookResponseSchema.parse({
    id: n.id,
    ownerId: n.ownerId,
    title: n.title,
    description: n.description,
    noteCount: n.noteCount,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  });

const toArtifact = (a: StudentArtifactRecord): unknown =>
  studentArtifactResponseSchema.parse({
    id: a.id,
    ownerId: a.ownerId,
    noteId: a.noteId,
    sessionId: a.sessionId,
    artifactType: a.artifactType,
    storageKey: a.storageKey,
    declaredContentType: a.declaredContentType,
    originalFilename: a.originalFilename,
    byteSize: a.byteSize,
    metadata: a.metadata,
    createdAt: a.createdAt.toISOString(),
  });

export function registerWorkspaceRoutes(app: FastifyInstance, workspace: WorkspaceService): void {
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

  // --- Notebooks ---------------------------------------------------------
  //
  // EVERY ROUTE IN THIS FILE IS UNDER `/me`, and none of them takes a user id
  // in the path, the query or the body. That is the structural half of the
  // IDOR defence for this domain: there is no parameter for an attacker to put
  // somebody else's id into, so the only way to reach another learner's
  // workspace is to guess a resource id — which the policy then refuses with a
  // 404 that does not confirm the guess.

  app.post('/api/v1/me/notebooks', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const input = createNotebookRequestSchema.parse(request.body);
      const created = await workspace.createNotebook(contextOf(request), input);
      return reply.status(201).send(toNotebook(created));
    },
  });

  app.get('/api/v1/me/notebooks', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const query = listNotebooksQuerySchema.parse(request.query ?? {});
      const found = await workspace.listNotebooks(contextOf(request), query);
      return reply.status(200).send({ items: found.map(toNotebook) });
    },
  });

  app.get('/api/v1/me/notebooks/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      emptyQuerySchema.parse(request.query ?? {});
      const { id } = idParams.parse(request.params);
      const found = await workspace.readNotebook(contextOf(request), id);
      return reply.status(200).send(toNotebook(found));
    },
  });

  /** PUT and PATCH both merge, for the reason given on `/me/notes/:id`. */
  for (const method of ['PUT', 'PATCH'] as const) {
    app.route({
      method,
      url: '/api/v1/me/notebooks/:id',
      preHandler: requireActor,
      handler: async (request, reply) => {
        const { id } = idParams.parse(request.params);
        const input = updateNotebookRequestSchema.parse(request.body);
        const saved = await workspace.updateNotebook(contextOf(request), id, input);
        return reply.status(200).send(toNotebook(saved));
      },
    });
  }

  /**
   * Deleting a notebook does NOT delete the notes in it.
   *
   * A composite foreign key sets their `notebook_id` to null and leaves the
   * writing alone. Deleting a folder is a filing action; losing a term's
   * revision notes because somebody tidied up is not a thing a learner should
   * be able to do by accident.
   */
  app.delete('/api/v1/me/notebooks/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      await workspace.deleteNotebook(contextOf(request), id);
      return reply.status(204).send();
    },
  });

  // --- Artifacts ---------------------------------------------------------

  /**
   * REGISTERS METADATA. IT DOES NOT ACCEPT BYTES.
   *
   * `docs/security/file-security.md` makes "never serve unscanned content" a
   * non-negotiable, and this platform has no scanner, no quarantine bucket and
   * no storage adapter. So this reserves a tenant-scoped key and accounts for
   * the space, and there is deliberately no upload route and no download route
   * to pair with it. When the pipeline exists it has somewhere correct to write.
   *
   * The storage key is DERIVED by a database trigger from the owner, their
   * organization and the row's id. The request has no field for a path or a
   * URL, so there is nothing for a caller to point at another tenant's prefix.
   */
  app.post('/api/v1/me/artifacts', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.workspaceArtifact),
    handler: async (request, reply) => {
      const input = registerArtifactRequestSchema.parse(request.body);
      const created = await workspace.registerArtifact(contextOf(request), input);
      return reply.status(201).send(toArtifact(created));
    },
  });

  app.get('/api/v1/me/artifacts', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const query = listArtifactsQuerySchema.parse(request.query ?? {});
      const found = await workspace.listArtifacts(contextOf(request), query);
      return reply.status(200).send({ items: found.map(toArtifact) });
    },
  });

  app.get('/api/v1/me/artifacts/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      emptyQuerySchema.parse(request.query ?? {});
      const { id } = idParams.parse(request.params);
      const found = await workspace.readArtifact(contextOf(request), id);
      return reply.status(200).send(toArtifact(found));
    },
  });

  app.delete('/api/v1/me/artifacts/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      await workspace.deleteArtifact(contextOf(request), id);
      return reply.status(204).send();
    },
  });

  /**
   * The learner's own allowance.
   *
   * Their own, and only their own: the service passes `ctx.actor.id` and there
   * is no parameter here that could carry another id. Knowing how full your own
   * drawer is discloses nothing about anyone else's.
   */
  app.get('/api/v1/me/storage', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      emptyQuerySchema.parse(request.query ?? {});
      const quota = await workspace.quota(contextOf(request));
      return reply.status(200).send(storageQuotaResponseSchema.parse(quota));
    },
  });
}
