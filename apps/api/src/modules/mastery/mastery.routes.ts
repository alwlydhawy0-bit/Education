import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  courseMasterySchema,
  evidenceSummarySchema,
  idSchema,
  objectiveMasterySchema,
} from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.ts';
import type { ActorContext, MasteryService } from './mastery.service.ts';
import type { EvidenceRecord, ObjectiveMasteryRecord } from './mastery.repository.ts';

const courseParams = z.object({ id: idSchema }).strict();
const childParams = z.object({ childId: idSchema }).strict();
const objectiveParams = z.object({ id: idSchema }).strict();
const classStudentCourseParams = z
  .object({ id: idSchema, studentId: idSchema, courseId: idSchema })
  .strict();

/**
 * Every response is built FIELD BY FIELD through a `.strict()` schema.
 *
 * `learnerId`, `learnerOrganizationId` and `observableByActorAsTeacher` ride on
 * the record for the policy and are NEVER serialized. Leaving them out matters
 * here for the same reason it does in the progress module: on every one of
 * these routes the learner is already known, from the URL or the session, so
 * returning it could only ever be an opportunity for a future bug to return the
 * wrong one.
 */
const toObjective = (r: ObjectiveMasteryRecord): unknown =>
  objectiveMasterySchema.parse({
    objectiveId: r.objectiveId,
    statement: r.statement,
    position: r.position,
    lessonId: r.lessonId,
    lessonTitle: r.lessonTitle,
    mastery: r.mastery,
    evidenceCount: r.evidenceCount,
    lastEvidenceAt: r.lastEvidenceAt?.toISOString() ?? null,
  });

const toEvidence = (r: EvidenceRecord): unknown =>
  evidenceSummarySchema.parse({
    objectiveId: r.objectiveId,
    evidenceType: r.evidenceType,
    sourceKind: r.sourceKind,
    occurredAt: r.occurredAt.toISOString(),
  });

/**
 * Objectives, evidence and mastery.
 *
 * THERE IS NO WRITE ROUTE IN THIS FILE, and that is the whole security story.
 * No endpoint accepts a mastery state, a mastery score, an evidence row, an
 * evidence timestamp or an objective association — from anyone, including a
 * platform operator. Mastery is derived from evidence on every read, and
 * evidence is emitted by database triggers on educational events that already
 * passed every check the platform has.
 *
 * So "the client submitted MASTERED" is not a request that gets rejected here;
 * it is a request with nowhere to go.
 */
export function registerMasteryRoutes(app: FastifyInstance, mastery: MasteryService): void {
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

  /** The authenticated learner's own mastery across one course. */
  app.get('/api/v1/me/courses/:id/mastery', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = courseParams.parse(request.params);
      const found = await mastery.myCourse(contextOf(request), id);
      return reply.status(200).send(courseMasterySchema.parse(found));
    },
  });

  /**
   * Every objective the authenticated learner has evidence for.
   *
   * Scoped to objectives with evidence rather than every objective on the
   * platform: an unbounded catalogue walk is not a progress view, and the
   * learner's own record is what this endpoint is for.
   */
  app.get('/api/v1/me/objectives', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const found = await mastery.myObjectives(contextOf(request));
      return reply.status(200).send({ items: found.map(toObjective) });
    },
  });

  /**
   * The evidence behind ONE objective, for the authenticated learner.
   *
   * This is what makes a mastery state explainable rather than pronounced: a
   * learner can see the events it was derived from. It carries no mark — the
   * score stays behind Task 009's release rules, on the endpoints built for it.
   */
  app.get('/api/v1/me/objectives/:id/evidence', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = objectiveParams.parse(request.params);
      const ctx = contextOf(request);
      const found = await mastery.evidenceFor(ctx, ctx.actor.id, id);
      return reply.status(200).send({ items: found.map(toEvidence) });
    },
  });

  /** A verified guardian's view of one child's objectives. */
  app.get('/api/v1/guardians/children/:childId/objectives', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { childId } = childParams.parse(request.params);
      const found = await mastery.objectivesForChild(contextOf(request), childId);
      return reply.status(200).send({ items: found.map(toObjective) });
    },
  });

  /**
   * A teacher's or administrator's view of one student, in one class, on one
   * course.
   *
   * ALL THREE IDS ARE IN THE PATH because all three are part of the
   * authorization question: the actor must have standing in that class, the
   * student must be enrolled in it, and the course must be one the class
   * reaches. A query parameter for any of them would invite a caller to vary one
   * and probe.
   */
  app.get('/api/v1/classes/:id/students/:studentId/courses/:courseId/mastery', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id, studentId, courseId } = classStudentCourseParams.parse(request.params);
      const found = await mastery.courseForStudentInClass(
        contextOf(request),
        id,
        studentId,
        courseId,
      );
      return reply.status(200).send(courseMasterySchema.parse(found));
    },
  });
}
