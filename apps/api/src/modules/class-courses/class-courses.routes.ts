import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  assignCourseRequestSchema,
  classCourseResponseSchema,
  enrolledCourseResponseSchema,
  idSchema,
  listClassCoursesQuerySchema,
  listMyCoursesQuerySchema,
} from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.ts';
import type { ActorContext, ClassCoursesService } from './class-courses.service.ts';
import type { ClassCourseRecord, EnrolledCourseRecord } from './class-courses.repository.ts';

const classParams = z.object({ id: idSchema }).strict();
const classCourseParams = z.object({ id: idSchema, courseId: idSchema }).strict();

/**
 * Responses are built field by field through a response schema.
 *
 * Nothing is spread from the record, so the authorization-only fields it
 * carries — the two organization ids and the class's state — cannot leak into
 * an API response by accident. `assignedBy` is likewise absent: who assigned a
 * course is recorded for audit, not published to the class.
 */
const toClassCourse = (r: ClassCourseRecord): unknown =>
  classCourseResponseSchema.parse({
    id: r.id,
    classId: r.classId,
    courseId: r.courseId,
    courseTitle: r.courseTitle,
    courseStatus: r.courseStatus,
    status: r.status,
    assignedAt: r.assignedAt.toISOString(),
    startsOn: r.startsOn,
    dueOn: r.dueOn,
  });

const toEnrolled = (r: EnrolledCourseRecord): unknown =>
  enrolledCourseResponseSchema.parse({
    courseId: r.courseId,
    classId: r.classId,
    className: r.className,
    title: r.title,
    summary: r.summary,
    levelId: r.levelId,
    curriculumId: r.curriculumId,
    assignedAt: r.assignedAt.toISOString(),
    startsOn: r.startsOn,
    dueOn: r.dueOn,
  });

export function registerClassCourseRoutes(
  app: FastifyInstance,
  classCourses: ClassCoursesService,
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

  app.post('/api/v1/classes/:id/courses', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = classParams.parse(request.params);
      const input = assignCourseRequestSchema.parse(request.body);
      const created = await classCourses.assign(contextOf(request), id, input);
      return reply.status(201).send(toClassCourse(created));
    },
  });

  app.get('/api/v1/classes/:id/courses', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = classParams.parse(request.params);
      const query = listClassCoursesQuerySchema.parse(request.query ?? {});
      const found = await classCourses.listForClass(contextOf(request), id, query);
      return reply.status(200).send({ items: found.map(toClassCourse) });
    },
  });

  /**
   * Withdrawal is addressed by (class, course) rather than by assignment id.
   *
   * That is the pairing the caller actually knows, and it removes a whole class
   * of mistake: an assignment id from another class cannot be actioned under a
   * class the caller happens to administer, because the lookup requires both to
   * match before authorization even runs.
   */
  app.delete('/api/v1/classes/:id/courses/:courseId', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id, courseId } = classCourseParams.parse(request.params);
      await classCourses.withdraw(contextOf(request), id, courseId);
      return reply.status(204).send();
    },
  });

  /**
   * The learner's own courses.
   *
   * No parameter names a user or a class: the scope is the session's actor and
   * their ACTIVE memberships, so there is nothing here through which a caller
   * could ask about somebody else.
   */
  app.get('/api/v1/me/courses', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const query = listMyCoursesQuerySchema.parse(request.query ?? {});
      const found = await classCourses.listMine(contextOf(request), query);
      return reply.status(200).send({ items: found.map(toEnrolled) });
    },
  });
}
