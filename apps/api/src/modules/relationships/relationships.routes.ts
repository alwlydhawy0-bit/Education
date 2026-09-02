import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  emptyQuerySchema,
  addClassMemberRequestSchema,
  addTeacherRequestSchema,
  classMemberResponseSchema,
  classResponseSchema,
  classTeacherResponseSchema,
  createClassRequestSchema,
  createGuardianLinkRequestSchema,
  createListQuerySchema,
  guardianLinkResponseSchema,
  idSchema,
  listClassesQuerySchema,
  updateClassRequestSchema,
} from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.ts';
import type { ActorContext, ClassesService } from './classes.service.ts';
import type { GuardiansService } from './guardians.service.ts';
import type { ClassMemberRecord, ClassRecord, ClassTeacherRecord } from './classes.repository.ts';
import type { GuardianLinkRecord } from './guardians.repository.ts';

const classParamsSchema = z.object({ id: idSchema }).strict();
const classMemberParamsSchema = z.object({ id: idSchema, userId: idSchema }).strict();
const classTeacherParamsSchema = z.object({ id: idSchema, assignmentId: idSchema }).strict();
const linkParamsSchema = z.object({ id: idSchema }).strict();
const userParamsSchema = z.object({ id: idSchema }).strict();

const pageQuerySchema = createListQuerySchema({
  sortableFields: ['createdAt'],
  defaultSort: 'createdAt',
  defaultOrder: 'desc',
});

const toClass = (record: ClassRecord): unknown =>
  classResponseSchema.parse({
    id: record.id,
    organizationId: record.organizationId,
    name: record.name,
    academicTerm: record.academicTerm,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
  });

const toMember = (record: ClassMemberRecord): unknown =>
  classMemberResponseSchema.parse({
    id: record.id,
    classId: record.classId,
    userId: record.userId,
    displayName: record.displayName,
    roleInClass: record.roleInClass,
    status: record.status,
    joinedAt: record.joinedAt.toISOString(),
  });

const toTeacher = (record: ClassTeacherRecord): unknown =>
  classTeacherResponseSchema.parse({
    id: record.id,
    classId: record.classId,
    teacherId: record.teacherId,
    displayName: record.displayName,
    roleInClass: record.roleInClass,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
  });

const toLink = (record: GuardianLinkRecord): unknown =>
  guardianLinkResponseSchema.parse({
    id: record.id,
    guardianId: record.guardianId,
    childId: record.childId,
    relationshipType: record.relationshipType,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    verifiedAt: record.verifiedAt?.toISOString() ?? null,
  });

export function registerRelationshipRoutes(
  app: FastifyInstance,
  classes: ClassesService,
  guardians: GuardiansService,
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

  // --- Classes -----------------------------------------------------------
  app.post('/api/v1/classes', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const input = createClassRequestSchema.parse(request.body);
      const created = await classes.create(contextOf(request), input);
      return reply.status(201).send(toClass(created));
    },
  });

  app.get('/api/v1/classes', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const query = listClassesQuerySchema.parse(request.query ?? {});
      const found = await classes.list(contextOf(request), query);
      return reply.status(200).send({ items: found.map(toClass) });
    },
  });

  app.get('/api/v1/classes/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      emptyQuerySchema.parse(request.query ?? {});
      const { id } = classParamsSchema.parse(request.params);
      return reply.status(200).send(toClass(await classes.get(contextOf(request), id)));
    },
  });

  app.patch('/api/v1/classes/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = classParamsSchema.parse(request.params);
      const input = updateClassRequestSchema.parse(request.body);
      return reply.status(200).send(toClass(await classes.update(contextOf(request), id, input)));
    },
  });

  app.post('/api/v1/classes/:id/archive', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = classParamsSchema.parse(request.params);
      return reply.status(200).send(toClass(await classes.archive(contextOf(request), id)));
    },
  });

  // --- Student roster ----------------------------------------------------
  app.get('/api/v1/classes/:id/members', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      emptyQuerySchema.parse(request.query ?? {});
      const { id } = classParamsSchema.parse(request.params);
      const members = await classes.listMembers(contextOf(request), id);
      return reply.status(200).send({ items: members.map(toMember) });
    },
  });

  app.post('/api/v1/classes/:id/members', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = classParamsSchema.parse(request.params);
      const input = addClassMemberRequestSchema.parse(request.body);
      const created = await classes.addMember(contextOf(request), id, input);
      return reply.status(201).send(toMember(created));
    },
  });

  app.delete('/api/v1/classes/:id/members/:userId', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id, userId } = classMemberParamsSchema.parse(request.params);
      await classes.removeMember(contextOf(request), id, userId);
      return reply.status(204).send();
    },
  });

  // --- Teacher roster ----------------------------------------------------
  app.get('/api/v1/classes/:id/teachers', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      emptyQuerySchema.parse(request.query ?? {});
      const { id } = classParamsSchema.parse(request.params);
      const teachers = await classes.listTeachers(contextOf(request), id);
      return reply.status(200).send({ items: teachers.map(toTeacher) });
    },
  });

  app.post('/api/v1/classes/:id/teachers', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = classParamsSchema.parse(request.params);
      const input = addTeacherRequestSchema.parse(request.body);
      const created = await classes.addTeacher(contextOf(request), id, input);
      return reply.status(201).send(toTeacher(created));
    },
  });

  app.delete('/api/v1/classes/:id/teachers/:assignmentId', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id, assignmentId } = classTeacherParamsSchema.parse(request.params);
      await classes.removeTeacher(contextOf(request), id, assignmentId);
      return reply.status(204).send();
    },
  });

  // --- Guardian links ----------------------------------------------------
  app.post('/api/v1/guardian-links', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const input = createGuardianLinkRequestSchema.parse(request.body);
      await guardians.requestLink(contextOf(request), input);
      // Always 202, whether or not the child exists and whether or not a claim
      // already existed: anything else makes this an existence oracle.
      return reply.status(202).send();
    },
  });

  app.get('/api/v1/guardian-links', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { limit, offset } = pageQuerySchema.parse(request.query ?? {});
      const links = await guardians.listForSelf(contextOf(request), limit, offset);
      return reply.status(200).send({ items: links.map(toLink) });
    },
  });

  app.get('/api/v1/users/:id/guardian-links', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = userParamsSchema.parse(request.params);
      const { limit, offset } = pageQuerySchema.parse(request.query ?? {});
      const links = await guardians.listForUser(contextOf(request), id, limit, offset);
      return reply.status(200).send({ items: links.map(toLink) });
    },
  });

  app.post('/api/v1/guardian-links/:id/verify', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = linkParamsSchema.parse(request.params);
      return reply.status(200).send(toLink(await guardians.verify(contextOf(request), id)));
    },
  });

  app.post('/api/v1/guardian-links/:id/revoke', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = linkParamsSchema.parse(request.params);
      await guardians.revoke(contextOf(request), id);
      return reply.status(204).send();
    },
  });
}
