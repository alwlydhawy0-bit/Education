import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createNoteRequestSchema,
  idSchema,
  listNotesQuerySchema,
  noteResponseSchema,
  updateNoteRequestSchema,
} from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.ts';
import type { ActorContext, NotebookService } from './notebook.service.ts';
import type { NoteRecord } from './notebook.repository.ts';

const noteParamsSchema = z.object({ id: idSchema }).strict();

function toResponse(note: NoteRecord): unknown {
  return noteResponseSchema.parse({
    id: note.id,
    ownerId: note.ownerId,
    title: note.title,
    body: note.body,
    visibility: note.visibility,
    state: note.state,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  });
}

export function registerNotebookRoutes(app: FastifyInstance, notebook: NotebookService): void {
  /** Builds the service-facing context from validated server state only. */
  function contextOf(request: Parameters<typeof requireActor>[0]): ActorContext {
    const actor = request.actor;
    if (!actor) throw new Error('unreachable: requireActor guarantees an actor');
    return {
      actor,
      loadRelationships: () => request.loadRelationships(),
      correlationId: request.correlationId,
      ip: request.ip,
    };
  }

  app.get('/api/v1/notes', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      // Strict: an unknown query parameter is a 400, never a silent no-op.
      const query = listNotesQuerySchema.parse(request.query ?? {});
      const notes = await notebook.list(contextOf(request), query);
      return reply.status(200).send({ items: notes.map(toResponse) });
    },
  });

  app.post('/api/v1/notes', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const input = createNoteRequestSchema.parse(request.body);
      const note = await notebook.create(contextOf(request), input);
      return reply.status(201).send(toResponse(note));
    },
  });

  // The three routes below all take an id from the URL. Each one goes through
  // `notebook.service`, which performs the object-level authorization check.
  // No route reads a note directly.
  app.get('/api/v1/notes/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = noteParamsSchema.parse(request.params);
      const note = await notebook.get(contextOf(request), id);
      return reply.status(200).send(toResponse(note));
    },
  });

  app.patch('/api/v1/notes/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = noteParamsSchema.parse(request.params);
      const input = updateNoteRequestSchema.parse(request.body);
      const note = await notebook.update(contextOf(request), id, input);
      return reply.status(200).send(toResponse(note));
    },
  });

  app.delete('/api/v1/notes/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = noteParamsSchema.parse(request.params);
      await notebook.remove(contextOf(request), id);
      return reply.status(204).send();
    },
  });
}
