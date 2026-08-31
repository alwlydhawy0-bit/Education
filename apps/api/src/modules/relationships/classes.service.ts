import { conflict, forbidden, notFound } from '@edu/kernel';
import {
  type Action,
  type Actor,
  type AuthorizationContext,
  type Decision,
  type PolicyEngine,
  type RelationshipSnapshot,
  type Resource,
} from '@edu/authz';
import { SecurityEventType } from '@edu/observability';
import type {
  AddClassMemberRequest,
  AddTeacherRequest,
  CreateClassRequest,
  ListClassesQuery,
  UpdateClassRequest,
} from '@edu/contracts';
import type { Database, Tx } from '../../platform/db.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import type {
  ClassMemberRecord,
  ClassRecord,
  ClassTeacherRecord,
  ClassesRepository,
} from './classes.repository.ts';

export interface ActorContext {
  readonly actor: Actor;
  readonly loadRelationships: () => Promise<RelationshipSnapshot>;
  readonly correlationId: string;
  readonly ip: string | null;
}

export interface ClassesServiceDeps {
  readonly db: Database;
  readonly repository: ClassesRepository;
  readonly engine: PolicyEngine;
  readonly securityEvents: SecurityEventRecorder;
}

export interface ClassesService {
  create(ctx: ActorContext, input: CreateClassRequest): Promise<ClassRecord>;
  get(ctx: ActorContext, classId: string): Promise<ClassRecord>;
  list(ctx: ActorContext, query: ListClassesQuery): Promise<ClassRecord[]>;
  update(ctx: ActorContext, classId: string, input: UpdateClassRequest): Promise<ClassRecord>;
  archive(ctx: ActorContext, classId: string): Promise<ClassRecord>;

  listMembers(ctx: ActorContext, classId: string): Promise<ClassMemberRecord[]>;
  addMember(
    ctx: ActorContext,
    classId: string,
    input: AddClassMemberRequest,
  ): Promise<ClassMemberRecord>;
  removeMember(ctx: ActorContext, classId: string, userId: string): Promise<void>;

  listTeachers(ctx: ActorContext, classId: string): Promise<ClassTeacherRecord[]>;
  addTeacher(
    ctx: ActorContext,
    classId: string,
    input: AddTeacherRequest,
  ): Promise<ClassTeacherRecord>;
  removeTeacher(ctx: ActorContext, classId: string, assignmentId: string): Promise<void>;
}

export function createClassesService(deps: ClassesServiceDeps): ClassesService {
  const { db, repository, engine, securityEvents } = deps;

  async function recordDenial(
    ctx: ActorContext,
    action: Action,
    resourceKind: string,
    resourceId: string,
    reason: string,
  ): Promise<void> {
    await securityEvents.record({
      type: SecurityEventType.AUTHZ_DENIED,
      actorId: ctx.actor.id,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
      detail: { action, resourceKind, resourceId, reason },
      occurredAt: new Date(),
    });
  }

  async function denyToError(
    ctx: ActorContext,
    decision: Decision,
    resourceKind: string,
  ): Promise<never> {
    await recordDenial(ctx, decision.action, resourceKind, decision.resourceId, decision.reason);
    if (decision.effect === 'deny' && decision.disclosure === 'reveal') throw forbidden();
    throw notFound();
  }

  async function decide(
    ctx: ActorContext,
    action: Action,
    resource: Resource,
    resourceKind: string,
  ): Promise<Decision> {
    const authContext: AuthorizationContext = {
      actor: ctx.actor,
      relationships: await ctx.loadRelationships(),
    };
    const decision = engine.decide(authContext, action, resource);
    if (decision.effect !== 'allow') await denyToError(ctx, decision, resourceKind);
    return decision;
  }

  /**
   * The single gate for reaching one class.
   *
   * Every roster operation resolves the class through here first, so "may this
   * actor touch this class at all?" is answered in one place rather than at each
   * call site.
   */
  async function authorizeClass(
    ctx: ActorContext,
    tx: Tx,
    classId: string,
    action: Action,
  ): Promise<ClassRecord> {
    const guarded = await repository.findById(tx, classId);
    if (!guarded) {
      // A class that does not exist and one RLS hid are indistinguishable to the
      // caller — by design — but the probe is still recorded.
      await recordDenial(ctx, action, 'class', classId, 'absent_or_not_visible');
      throw notFound();
    }
    const decision = await decide(ctx, action, guarded.resource, 'class');
    return guarded.unwrap(decision, action);
  }

  const emit = (
    ctx: ActorContext,
    type: SecurityEventType,
    detail: Record<string, unknown>,
  ): Promise<void> =>
    securityEvents.record({
      type,
      actorId: ctx.actor.id,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
      detail,
      occurredAt: new Date(),
    });

  return {
    async create(ctx, input) {
      const organizationId = ctx.actor.organizationId;
      if (organizationId === null) {
        await recordDenial(ctx, 'class:create', 'class', 'new', 'actor.no_organization');
        throw notFound();
      }

      // Authorized against a prospective class in the ACTOR'S OWN organization.
      // The request has no organization field, so a cross-tenant create is not
      // expressible, and RLS refuses one independently.
      await decide(
        ctx,
        'class:create',
        { kind: 'class', id: 'new', organizationId, state: 'active' },
        'class',
      );

      return db.withActor(ctx.actor.id, async (tx) => {
        const created = await repository.insert(tx, organizationId, input.name, input.academicTerm);
        await emit(ctx, SecurityEventType.CLASS_CREATED, {
          classId: created.id,
          organizationId,
        });
        return created;
      });
    },

    async get(ctx, classId) {
      return db.withActor(ctx.actor.id, (tx) => authorizeClass(ctx, tx, classId, 'class:read'));
    },

    async list(ctx, query) {
      // RLS scopes the result to classes the actor teaches, is enrolled in, or
      // administers within their own organization — and then `classPolicy` is
      // applied to every row that comes back.
      //
      // The second pass is deliberately redundant. Without it a listing would
      // rest on RLS alone, and the "two independent gates" claim would be false
      // for the endpoint that returns the most rows. It is a no-op whenever RLS
      // is doing its job.
      return db.withActor(ctx.actor.id, async (tx) => {
        const rows = await repository.list(tx, query);
        const authContext: AuthorizationContext = {
          actor: ctx.actor,
          relationships: await ctx.loadRelationships(),
        };
        return rows.filter(
          (row) =>
            engine.decide(authContext, 'class:list', {
              kind: 'class',
              id: row.id,
              organizationId: row.organizationId,
              state: row.status,
            }).effect === 'allow',
        );
      });
    },

    async update(ctx, classId, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        await authorizeClass(ctx, tx, classId, 'class:update');
        const updated = await repository.applyUpdate(tx, classId, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.academicTerm !== undefined ? { academicTerm: input.academicTerm } : {}),
        });
        if (!updated) throw notFound();
        await emit(ctx, SecurityEventType.CLASS_UPDATED, { classId });
        return updated;
      });
    },

    async archive(ctx, classId) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const before = await authorizeClass(ctx, tx, classId, 'class:archive');
        const archived = await repository.archive(tx, classId);
        if (!archived) throw conflict('Class is already archived');

        // Archiving revokes every teacher's derived access to the students in
        // this class, so it is a security-relevant event, not just bookkeeping.
        await emit(ctx, SecurityEventType.CLASS_ARCHIVED, {
          classId,
          organizationId: before.organizationId,
        });
        return { ...before, status: 'archived' as const };
      });
    },

    // --- Roster: students --------------------------------------------------
    async listMembers(ctx, classId) {
      return db.withActor(ctx.actor.id, async (tx) => {
        // TWO gates, and the second is the one that matters. Being able to read
        // the class is not enough: an enrolled student passes `class:read` and
        // must still be refused the roster. `memberUserId: null` names the
        // roster as a whole, which only a teacher of the class or an
        // administrator of its organization may enumerate.
        const klass = await authorizeClass(ctx, tx, classId, 'class:read');
        await decide(
          ctx,
          'class_membership:list',
          {
            kind: 'class_membership',
            id: classId,
            classId,
            classOrganizationId: klass.organizationId,
            memberUserId: null,
            state: 'active',
          },
          'class_membership',
        );
        return repository.listMembers(tx, classId);
      });
    },

    async addMember(ctx, classId, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const klass = await authorizeClass(ctx, tx, classId, 'class:read');
        await decide(
          ctx,
          'class_membership:manage',
          {
            kind: 'class_membership',
            id: `${classId}:${input.userId}`,
            classId,
            classOrganizationId: klass.organizationId,
            memberUserId: input.userId,
            state: 'active',
          },
          'class_membership',
        );

        // Only an ACTIVE membership is a conflict. Someone removed earlier is
        // re-enrolled as a NEW row (migration 0015), so their previous spell on
        // the roster stays intact as history rather than being reopened.
        const existing = await repository.findActiveMembership(tx, classId, input.userId);
        if (existing) throw conflict('User is already on this class roster');

        const created = await repository.addMember(tx, classId, input.userId, input.roleInClass);
        // Enrolling a student widens who can read their shared work, so it is
        // recorded with both parties.
        await emit(ctx, SecurityEventType.CLASS_MEMBER_ADDED, {
          classId,
          memberUserId: input.userId,
          roleInClass: input.roleInClass,
        });
        return created;
      });
    },

    async removeMember(ctx, classId, userId) {
      await db.withActor(ctx.actor.id, async (tx) => {
        const klass = await authorizeClass(ctx, tx, classId, 'class:read');
        const existing = await repository.findActiveMembership(tx, classId, userId);
        if (!existing) throw notFound();

        await decide(
          ctx,
          'class_membership:manage',
          {
            kind: 'class_membership',
            id: existing.id,
            classId,
            classOrganizationId: klass.organizationId,
            memberUserId: userId,
            state: 'active',
          },
          'class_membership',
        );

        const removed = await repository.endMembership(tx, existing.id);
        if (!removed) throw notFound();
        await emit(ctx, SecurityEventType.CLASS_MEMBER_REMOVED, {
          classId,
          memberUserId: userId,
        });
      });
    },

    // --- Roster: teachers --------------------------------------------------
    async listTeachers(ctx, classId) {
      return db.withActor(ctx.actor.id, async (tx) => {
        await authorizeClass(ctx, tx, classId, 'class:read');
        return repository.listTeachers(tx, classId);
      });
    },

    async addTeacher(ctx, classId, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const klass = await authorizeClass(ctx, tx, classId, 'class:read');

        // Assignment is an administrator's act. The policy refuses teachers
        // outright, including for themselves, because "teacher of this class" is
        // what grants access to every enrolled student's shared work.
        await decide(
          ctx,
          'teacher_assignment:create',
          {
            kind: 'teacher_assignment',
            id: `${classId}:${input.teacherId}`,
            classId,
            classOrganizationId: klass.organizationId,
            teacherId: input.teacherId,
            state: 'active',
          },
          'teacher_assignment',
        );

        if (await repository.findActiveAssignment(tx, classId, input.teacherId)) {
          throw conflict('Teacher is already assigned to this class');
        }

        const created = await repository.addTeacher(
          tx,
          classId,
          input.teacherId,
          input.roleInClass,
        );
        await emit(ctx, SecurityEventType.TEACHER_ASSIGNED, {
          classId,
          teacherId: input.teacherId,
          roleInClass: input.roleInClass,
        });
        return created;
      });
    },

    async removeTeacher(ctx, classId, assignmentId) {
      await db.withActor(ctx.actor.id, async (tx) => {
        await authorizeClass(ctx, tx, classId, 'class:read');

        const guarded = await repository.findAssignment(tx, assignmentId);
        if (!guarded || guarded.resource.kind !== 'teacher_assignment') {
          await recordDenial(
            ctx,
            'teacher_assignment:remove',
            'teacher_assignment',
            assignmentId,
            'absent_or_not_visible',
          );
          throw notFound();
        }
        // The assignment must belong to the class named in the URL: without
        // this, an assignment id from another class would be actioned under a
        // class the caller happens to administer.
        if (guarded.resource.classId !== classId) {
          await recordDenial(
            ctx,
            'teacher_assignment:remove',
            'teacher_assignment',
            assignmentId,
            'assignment_belongs_to_another_class',
          );
          throw notFound();
        }

        const decision = await decide(
          ctx,
          'teacher_assignment:remove',
          guarded.resource,
          'teacher_assignment',
        );
        const assignment = guarded.unwrap(decision, 'teacher_assignment:remove');

        const removed = await repository.endAssignment(tx, assignmentId);
        if (!removed) throw notFound();
        await emit(ctx, SecurityEventType.TEACHER_UNASSIGNED, {
          classId,
          teacherId: assignment.teacherId,
        });
      });
    },
  };
}
