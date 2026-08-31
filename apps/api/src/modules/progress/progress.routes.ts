import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  idSchema,
  listProgressQuerySchema,
  progressResponseSchema,
  recordProgressRequestSchema,
} from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.ts';
import type { ActorContext, ProgressService } from './progress.service.ts';
import type { ProgressRecord } from './progress.repository.ts';

const lessonParams = z.object({ id: idSchema }).strict();
const classStudentParams = z.object({ id: idSchema, studentId: idSchema }).strict();
const childParams = z.object({ childId: idSchema }).strict();

/**
 * Built field by field through the response schema.
 *
 * `learnerId` and `learnerOrganizationId` ride on the record for the policy and
 * are NOT serialized. Leaving them out matters more here than elsewhere: on the
 * guardian and teacher views the learner is already known from the URL, and on
 * `/me/progress` it is the caller — so returning it would only ever be an
 * opportunity for a future bug to return the wrong one.
 */
const toResponse = (r: ProgressRecord): unknown =>
  progressResponseSchema.parse({
    lessonId: r.lessonId,
    lessonTitle: r.lessonTitle,
    unitTitle: r.unitTitle,
    courseId: r.courseId,
    courseTitle: r.courseTitle,
    status: r.status,
    completedAt: r.completedAt?.toISOString() ?? null,
    lastAccessedAt: r.lastAccessedAt.toISOString(),
  });

export function registerProgressRoutes(app: FastifyInstance, progress: ProgressService): void {
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

  /**
   * PUT, not POST: recording progress is idempotent. Sending `completed` twice
   * is the same request twice, and answers the same way both times.
   */
  app.put('/api/v1/lessons/:id/progress', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = lessonParams.parse(request.params);
      const input = recordProgressRequestSchema.parse(request.body);
      const saved = await progress.record(contextOf(request), id, input);
      return reply.status(200).send(toResponse(saved));
    },
  });

  /** The learner's own record. No parameter names a user. */
  app.get('/api/v1/me/progress', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const query = listProgressQuerySchema.parse(request.query ?? {});
      const found = await progress.listMine(contextOf(request), query);
      return reply.status(200).send({ items: found.map(toResponse) });
    },
  });

  /**
   * A teacher's or administrator's view of one student, in one class.
   *
   * Both ids are in the path because both are part of the authorization
   * question: the actor must have standing in that class, the student must be
   * enrolled in it, and the rows are restricted to the courses assigned to it.
   * A query parameter for either would invite a caller to vary one and probe.
   */
  app.get('/api/v1/classes/:id/students/:studentId/progress', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id, studentId } = classStudentParams.parse(request.params);
      const query = listProgressQuerySchema.parse(request.query ?? {});
      const found = await progress.listForStudentInClass(contextOf(request), id, studentId, query);
      return reply.status(200).send({ items: found.map(toResponse) });
    },
  });

  /** A verified guardian's view of one child. */
  app.get('/api/v1/guardians/children/:childId/progress', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { childId } = childParams.parse(request.params);
      const query = listProgressQuerySchema.parse(request.query ?? {});
      const found = await progress.listForChild(contextOf(request), childId, query);
      return reply.status(200).send({ items: found.map(toResponse) });
    },
  });
}
