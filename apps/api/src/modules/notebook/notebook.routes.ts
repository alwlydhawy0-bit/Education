import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  emptyQuerySchema,
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
const lessonParamsSchema = z.object({ lessonId: idSchema }).strict();

function toResponse(note: NoteRecord): unknown {
  return noteResponseSchema.parse({
    id: note.id,
    ownerId: note.ownerId,
    title: note.title,
    body: note.body,
    visibility: note.visibility,
    state: note.state,
    notebookId: note.notebookId,
    courseId: note.courseId,
    unitId: note.unitId,
    lessonId: note.lessonId,
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
      emptyQuerySchema.parse(request.query ?? {});
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

  // --- The `/me` workspace family ---------------------------------------
  //
  // THE SAME SERVICE, UNDER THE PATH THE WORKSPACE READS FROM. Task 010 names
  // `/me/notes`; the platform already served the identical resource at
  // `/api/v1/notes` with the identical authorization funnel. Registering a
  // second implementation would be two write paths to one table and two places
  // for the ownership rule to drift, so these are aliases over one service
  // rather than a parallel module.
  //
  // The `/me` prefix is not decoration: it says in the URL what every one of
  // these routes enforces in code — the subject is the session, and no path or
  // query parameter names a user.

  app.get('/api/v1/me/notes', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const query = listNotesQuerySchema.parse(request.query ?? {});
      const notes = await notebook.list(contextOf(request), query);
      return reply.status(200).send({ items: notes.map(toResponse) });
    },
  });

  /**
   * Every note a learner anchored to one lesson.
   *
   * A dedicated route rather than `?lessonId=` — which also exists — because it
   * is the request the lesson page actually makes, and because a path segment
   * makes the scope obvious in an access log.
   */
  app.get('/api/v1/me/notes/lesson/:lessonId', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { lessonId } = lessonParamsSchema.parse(request.params);
      const query = listNotesQuerySchema.parse(request.query ?? {});
      const notes = await notebook.list(contextOf(request), { ...query, lessonId });
      return reply.status(200).send({ items: notes.map(toResponse) });
    },
  });

  app.post('/api/v1/me/notes', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const input = createNoteRequestSchema.parse(request.body);
      const note = await notebook.create(contextOf(request), input);
      return reply.status(201).send(toResponse(note));
    },
  });

  app.get('/api/v1/me/notes/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      emptyQuerySchema.parse(request.query ?? {});
      const { id } = noteParamsSchema.parse(request.params);
      const note = await notebook.get(contextOf(request), id);
      return reply.status(200).send(toResponse(note));
    },
  });

  /**
   * PUT, and it MERGES rather than replaces.
   *
   * Task 010 asks for `PUT /me/notes/:id`; the platform's update contract is
   * partial. A true replace would let a client blank a field it never read —
   * an older tab that does not know about `lessonId` would silently unanchor
   * the note on its next save — so the semantics stay partial and the method
   * follows the task. `PATCH` is registered alongside for callers that expect
   * the more accurate verb, and both reach the same handler.
   */
  for (const method of ['PUT', 'PATCH'] as const) {
    app.route({
      method,
      url: '/api/v1/me/notes/:id',
      preHandler: requireActor,
      handler: async (request, reply) => {
        const { id } = noteParamsSchema.parse(request.params);
        const input = updateNoteRequestSchema.parse(request.body);
        const note = await notebook.update(contextOf(request), id, input);
        return reply.status(200).send(toResponse(note));
      },
    });
  }

  app.delete('/api/v1/me/notes/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = noteParamsSchema.parse(request.params);
      await notebook.remove(contextOf(request), id);
      return reply.status(204).send();
    },
  });
}
