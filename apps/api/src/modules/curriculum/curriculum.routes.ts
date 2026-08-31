import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  courseResponseSchema,
  createCourseRequestSchema,
  createCurriculumRequestSchema,
  createEducationLevelRequestSchema,
  createLessonRequestSchema,
  createUnitRequestSchema,
  curriculumResponseSchema,
  educationLevelResponseSchema,
  idSchema,
  lessonResponseSchema,
  listChildrenQuerySchema,
  listCoursesQuerySchema,
  listCurriculaQuerySchema,
  reorderRequestSchema,
  unitResponseSchema,
  updateCourseRequestSchema,
  updateCurriculumRequestSchema,
  updateEducationLevelRequestSchema,
  updateLessonRequestSchema,
  updateUnitRequestSchema,
} from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.ts';
import type { ActorContext, CurriculumService } from './curriculum.service.ts';
import type {
  CourseRecord,
  CurriculumRecord,
  EducationLevelRecord,
  LessonRecord,
  UnitRecord,
} from './curriculum.repository.ts';

const idParams = z.object({ id: idSchema }).strict();

/**
 * Responses are built field by field through a response schema.
 *
 * Nothing is spread from the database row, so a column added later — an
 * internal note, a reviewer id, a moderation flag — cannot appear in an API
 * response by accident. `created_by` in particular is deliberately absent:
 * authorship is recorded for audit, not published to learners.
 */
const toLevel = (r: EducationLevelRecord): unknown =>
  educationLevelResponseSchema.parse({
    id: r.id,
    code: r.code,
    name: r.name,
    stage: r.stage,
    grade: r.grade,
    sortOrder: r.sortOrder,
  });

const toCurriculum = (r: CurriculumRecord): unknown =>
  curriculumResponseSchema.parse({
    id: r.id,
    organizationId: r.organizationId,
    code: r.code,
    name: r.name,
    description: r.description,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    publishedAt: r.publishedAt?.toISOString() ?? null,
  });

const toCourse = (r: CourseRecord): unknown =>
  courseResponseSchema.parse({
    id: r.id,
    organizationId: r.organizationId,
    curriculumId: r.curriculumId,
    levelId: r.levelId,
    title: r.title,
    summary: r.summary,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    publishedAt: r.publishedAt?.toISOString() ?? null,
  });

const toUnit = (r: UnitRecord): unknown =>
  unitResponseSchema.parse({
    id: r.id,
    courseId: r.courseId,
    position: r.position,
    title: r.title,
    summary: r.summary,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    publishedAt: r.publishedAt?.toISOString() ?? null,
  });

const toLesson = (r: LessonRecord): unknown =>
  lessonResponseSchema.parse({
    id: r.id,
    unitId: r.unitId,
    position: r.position,
    title: r.title,
    summary: r.summary,
    contentFormat: r.contentFormat,
    contentBody: r.contentBody,
    externalUrl: r.externalUrl,
    estimatedMinutes: r.estimatedMinutes,
    objectives: [...r.objectives],
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    publishedAt: r.publishedAt?.toISOString() ?? null,
  });

export function registerCurriculumRoutes(
  app: FastifyInstance,
  curriculum: CurriculumService,
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

  // --- Education levels ---------------------------------------------------
  app.get('/api/v1/education-levels', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const levels = await curriculum.listLevels(contextOf(request));
      return reply.status(200).send({ items: levels.map(toLevel) });
    },
  });

  app.post('/api/v1/education-levels', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const input = createEducationLevelRequestSchema.parse(request.body);
      const created = await curriculum.createLevel(contextOf(request), input);
      return reply.status(201).send(toLevel(created));
    },
  });

  app.patch('/api/v1/education-levels/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = updateEducationLevelRequestSchema.parse(request.body);
      const updated = await curriculum.updateLevel(contextOf(request), id, input);
      return reply.status(200).send(toLevel(updated));
    },
  });

  // --- Curricula ----------------------------------------------------------
  app.post('/api/v1/curricula', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const input = createCurriculumRequestSchema.parse(request.body);
      const created = await curriculum.createCurriculum(contextOf(request), input);
      return reply.status(201).send(toCurriculum(created));
    },
  });

  app.get('/api/v1/curricula', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const query = listCurriculaQuerySchema.parse(request.query ?? {});
      const found = await curriculum.listCurricula(contextOf(request), query);
      return reply.status(200).send({ items: found.map(toCurriculum) });
    },
  });

  app.get('/api/v1/curricula/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      return reply
        .status(200)
        .send(toCurriculum(await curriculum.getCurriculum(contextOf(request), id)));
    },
  });

  app.patch('/api/v1/curricula/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = updateCurriculumRequestSchema.parse(request.body);
      return reply
        .status(200)
        .send(toCurriculum(await curriculum.updateCurriculum(contextOf(request), id, input)));
    },
  });

  app.post('/api/v1/curricula/:id/publish', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const updated = await curriculum.setCurriculumStatus(contextOf(request), id, 'published');
      return reply.status(200).send(toCurriculum(updated));
    },
  });

  app.post('/api/v1/curricula/:id/archive', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const updated = await curriculum.setCurriculumStatus(contextOf(request), id, 'archived');
      return reply.status(200).send(toCurriculum(updated));
    },
  });

  app.delete('/api/v1/curricula/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      await curriculum.deleteCurriculum(contextOf(request), id);
      return reply.status(204).send();
    },
  });

  // --- Courses ------------------------------------------------------------
  app.post('/api/v1/courses', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const input = createCourseRequestSchema.parse(request.body);
      const created = await curriculum.createCourse(contextOf(request), input);
      return reply.status(201).send(toCourse(created));
    },
  });

  app.get('/api/v1/courses', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const query = listCoursesQuerySchema.parse(request.query ?? {});
      const found = await curriculum.listCourses(contextOf(request), query);
      return reply.status(200).send({ items: found.map(toCourse) });
    },
  });

  app.get('/api/v1/courses/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      return reply.status(200).send(toCourse(await curriculum.getCourse(contextOf(request), id)));
    },
  });

  app.patch('/api/v1/courses/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = updateCourseRequestSchema.parse(request.body);
      return reply
        .status(200)
        .send(toCourse(await curriculum.updateCourse(contextOf(request), id, input)));
    },
  });

  app.post('/api/v1/courses/:id/publish', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const updated = await curriculum.setCourseStatus(contextOf(request), id, 'published');
      return reply.status(200).send(toCourse(updated));
    },
  });

  app.post('/api/v1/courses/:id/archive', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const updated = await curriculum.setCourseStatus(contextOf(request), id, 'archived');
      return reply.status(200).send(toCourse(updated));
    },
  });

  app.delete('/api/v1/courses/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      await curriculum.deleteCourse(contextOf(request), id);
      return reply.status(204).send();
    },
  });

  // --- Units --------------------------------------------------------------
  app.get('/api/v1/courses/:id/units', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const query = listChildrenQuerySchema.parse(request.query ?? {});
      const units = await curriculum.listUnits(contextOf(request), id, query);
      return reply.status(200).send({ items: units.map(toUnit) });
    },
  });

  app.post('/api/v1/courses/:id/units', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = createUnitRequestSchema.parse(request.body);
      const created = await curriculum.createUnit(contextOf(request), id, input);
      return reply.status(201).send(toUnit(created));
    },
  });

  app.put('/api/v1/courses/:id/units/order', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = reorderRequestSchema.parse(request.body);
      const units = await curriculum.reorderUnits(contextOf(request), id, input);
      return reply.status(200).send({ items: units.map(toUnit) });
    },
  });

  app.get('/api/v1/units/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      return reply.status(200).send(toUnit(await curriculum.getUnit(contextOf(request), id)));
    },
  });

  app.patch('/api/v1/units/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = updateUnitRequestSchema.parse(request.body);
      return reply
        .status(200)
        .send(toUnit(await curriculum.updateUnit(contextOf(request), id, input)));
    },
  });

  app.post('/api/v1/units/:id/publish', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const updated = await curriculum.setUnitStatus(contextOf(request), id, 'published');
      return reply.status(200).send(toUnit(updated));
    },
  });

  app.post('/api/v1/units/:id/archive', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const updated = await curriculum.setUnitStatus(contextOf(request), id, 'archived');
      return reply.status(200).send(toUnit(updated));
    },
  });

  app.delete('/api/v1/units/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      await curriculum.deleteUnit(contextOf(request), id);
      return reply.status(204).send();
    },
  });

  // --- Lessons ------------------------------------------------------------
  app.get('/api/v1/units/:id/lessons', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const query = listChildrenQuerySchema.parse(request.query ?? {});
      const lessons = await curriculum.listLessons(contextOf(request), id, query);
      return reply.status(200).send({ items: lessons.map(toLesson) });
    },
  });

  app.post('/api/v1/units/:id/lessons', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = createLessonRequestSchema.parse(request.body);
      const created = await curriculum.createLesson(contextOf(request), id, input);
      return reply.status(201).send(toLesson(created));
    },
  });

  app.put('/api/v1/units/:id/lessons/order', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = reorderRequestSchema.parse(request.body);
      const lessons = await curriculum.reorderLessons(contextOf(request), id, input);
      return reply.status(200).send({ items: lessons.map(toLesson) });
    },
  });

  app.get('/api/v1/lessons/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      return reply.status(200).send(toLesson(await curriculum.getLesson(contextOf(request), id)));
    },
  });

  app.patch('/api/v1/lessons/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = updateLessonRequestSchema.parse(request.body);
      return reply
        .status(200)
        .send(toLesson(await curriculum.updateLesson(contextOf(request), id, input)));
    },
  });

  app.post('/api/v1/lessons/:id/publish', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const updated = await curriculum.setLessonStatus(contextOf(request), id, 'published');
      return reply.status(200).send(toLesson(updated));
    },
  });

  app.post('/api/v1/lessons/:id/archive', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const updated = await curriculum.setLessonStatus(contextOf(request), id, 'archived');
      return reply.status(200).send(toLesson(updated));
    },
  });

  app.delete('/api/v1/lessons/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      await curriculum.deleteLesson(contextOf(request), id);
      return reply.status(204).send();
    },
  });
}
