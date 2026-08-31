import { conflict, forbidden, notFound } from '@edu/kernel';
import {
  type Action,
  type Actor,
  type AuthorizationContext,
  type ClassCourseAssignmentResource,
  type Decision,
  type Guarded,
  type PolicyEngine,
  type RelationshipSnapshot,
  type Resource,
} from '@edu/authz';
import { SecurityEventType } from '@edu/observability';
import type {
  AssignCourseRequest,
  ListClassCoursesQuery,
  ListMyCoursesQuery,
} from '@edu/contracts';
import type { Database, Tx } from '../../platform/db.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import {
  AlreadyAssignedError,
  AssignmentNotPermittedError,
  type ClassCourseRecord,
  type ClassCoursesRepository,
  type EnrolledCourseRecord,
} from './class-courses.repository.ts';

export interface ActorContext {
  readonly actor: Actor;
  readonly loadRelationships: () => Promise<RelationshipSnapshot>;
  readonly correlationId: string;
  readonly ip: string | null;
}

export interface ClassCoursesServiceDeps {
  readonly db: Database;
  readonly repository: ClassCoursesRepository;
  readonly engine: PolicyEngine;
  readonly securityEvents: SecurityEventRecorder;
}

export interface ClassCoursesService {
  assign(
    ctx: ActorContext,
    classId: string,
    input: AssignCourseRequest,
  ): Promise<ClassCourseRecord>;
  withdraw(ctx: ActorContext, classId: string, courseId: string): Promise<void>;
  listForClass(
    ctx: ActorContext,
    classId: string,
    query: ListClassCoursesQuery,
  ): Promise<ClassCourseRecord[]>;
  listMine(ctx: ActorContext, query: ListMyCoursesQuery): Promise<EnrolledCourseRecord[]>;
}

export function createClassCoursesService(deps: ClassCoursesServiceDeps): ClassCoursesService {
  const { db, repository, engine, securityEvents } = deps;

  async function recordDenial(
    ctx: ActorContext,
    action: Action,
    resourceId: string,
    reason: string,
  ): Promise<void> {
    await securityEvents.record({
      type: SecurityEventType.AUTHZ_DENIED,
      actorId: ctx.actor.id,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
      detail: { action, resourceKind: 'class_course_assignment', resourceId, reason },
      occurredAt: new Date(),
    });
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

  async function decide(ctx: ActorContext, action: Action, resource: Resource): Promise<Decision> {
    const authContext: AuthorizationContext = {
      actor: ctx.actor,
      relationships: await ctx.loadRelationships(),
    };
    const decision = engine.decide(authContext, action, resource);
    if (decision.effect !== 'allow') {
      await recordDenial(ctx, action, resource.id, decision.reason);
      if (decision.effect === 'deny' && decision.disclosure === 'reveal') throw forbidden();
      throw notFound();
    }
    return decision;
  }

  /** The single gate for reaching one existing assignment. */
  async function authorize(
    ctx: ActorContext,
    guarded: Guarded<ClassCourseRecord> | null,
    action: Action,
    id: string,
  ): Promise<ClassCourseRecord> {
    if (!guarded) {
      // An assignment that does not exist and one RLS hid are indistinguishable
      // to the caller — deliberately — but the probe is still recorded.
      await recordDenial(ctx, action, id, 'absent_or_not_visible');
      throw notFound();
    }
    const decision = await decide(ctx, action, guarded.resource);
    return guarded.unwrap(decision, action);
  }

  /**
   * Builds the resource for an assignment that does not exist yet.
   *
   * The facts come from the SECURITY DEFINER helpers rather than from a SELECT,
   * because a caller may legitimately be entitled to assign a GLOBAL course
   * they cannot see through the content policy. Asking structurally is also
   * what makes the application and the trigger agree — they consult the same
   * functions.
   *
   * A class or course that does not exist yields `404` before the policy runs.
   * That is the same answer as "exists but you may not touch it", so no id is
   * confirmed either way.
   */
  async function prospective(
    ctx: ActorContext,
    tx: Tx,
    classId: string,
    courseId: string,
  ): Promise<ClassCourseAssignmentResource> {
    const facts = await repository.facts(tx, classId, courseId);
    if (!facts.classExists) {
      await recordDenial(ctx, 'class_course_assignment:create', classId, 'class_absent');
      throw notFound();
    }
    if (!facts.courseExists || facts.courseStatus === null) {
      await recordDenial(ctx, 'class_course_assignment:create', courseId, 'course_absent');
      throw notFound();
    }
    return {
      kind: 'class_course_assignment',
      id: `${classId}:${courseId}`,
      classId,
      classOrganizationId: facts.classOrganizationId,
      courseId,
      courseOrganizationId: facts.courseOrganizationId,
      courseStatus: facts.courseStatus,
      classIsActive: facts.classIsActive,
      state: 'active',
    };
  }

  return {
    async assign(ctx, classId, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const resource = await prospective(ctx, tx, classId, input.courseId);
        await decide(ctx, 'class_course_assignment:create', resource);

        try {
          const created = await repository.insert(tx, {
            classId,
            courseId: input.courseId,
            assignedBy: ctx.actor.id,
            startsOn: input.startsOn,
            dueOn: input.dueOn,
          });
          // Recorded with BOTH parties, because this is the moment a class's
          // learners gain access to a body of content.
          await emit(ctx, SecurityEventType.COURSE_ASSIGNED_TO_CLASS, {
            assignmentId: created.id,
            classId,
            courseId: input.courseId,
          });
          return created;
        } catch (error) {
          if (error instanceof AlreadyAssignedError) {
            throw conflict('That course is already assigned to this class');
          }
          if (error instanceof AssignmentNotPermittedError) {
            // The database refused something the policy allowed. That is a
            // disagreement between the two gates, so it is surfaced rather than
            // smoothed over — and recorded, because it should never happen.
            await recordDenial(
              ctx,
              'class_course_assignment:create',
              `${classId}:${input.courseId}`,
              'refused_by_database_after_policy_allowed',
            );
            throw conflict('That course cannot be assigned to this class');
          }
          throw error;
        }
      });
    },

    async withdraw(ctx, classId, courseId) {
      await db.withActor(ctx.actor.id, async (tx) => {
        const guarded = await repository.findActive(tx, classId, courseId);
        const existing = await authorize(
          ctx,
          guarded,
          'class_course_assignment:remove',
          `${classId}:${courseId}`,
        );
        // The URL's class must be the assignment's class. `findActive` already
        // pairs them, so this cannot currently diverge — asserting it here
        // keeps that true if the lookup is ever widened.
        if (existing.classId !== classId) {
          await recordDenial(
            ctx,
            'class_course_assignment:remove',
            existing.id,
            'assignment_belongs_to_another_class',
          );
          throw notFound();
        }

        if (!(await repository.withdraw(tx, existing.id))) throw notFound();
        await emit(ctx, SecurityEventType.COURSE_WITHDRAWN_FROM_CLASS, {
          assignmentId: existing.id,
          classId,
          courseId,
        });
      });
    },

    async listForClass(ctx, classId, query) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const rows = await repository.listForClass(tx, classId, query);
        const authContext: AuthorizationContext = {
          actor: ctx.actor,
          relationships: await ctx.loadRelationships(),
        };
        // RLS scopes the rows; the policy is then run over every one of them.
        //
        // The second pass is deliberately redundant. Without it a listing would
        // rest on RLS alone — and listings are the endpoints that return the
        // most rows, so they are the last place to have one gate (VULN-017).
        //
        // An empty result is returned for a class the caller cannot reach at
        // all, rather than a 404. The two are indistinguishable to the caller:
        // a class with no assignments and a class they may not see both answer
        // `{ items: [] }`.
        return rows.filter(
          (row) =>
            engine.decide(authContext, 'class_course_assignment:list', {
              kind: 'class_course_assignment',
              id: row.id,
              classId: row.classId,
              classOrganizationId: row.classOrganizationId,
              courseId: row.courseId,
              courseOrganizationId: row.courseOrganizationId,
              courseStatus: row.courseStatus,
              classIsActive: row.classIsActive,
              state: row.status,
            }).effect === 'allow',
        );
      });
    },

    async listMine(ctx, query) {
      // Scoped by the actor's own id in SQL, and by RLS, and by nothing the
      // request can influence: there is no parameter here naming a user or a
      // class. A teacher legitimately gets an empty list — they reach a class's
      // courses through `GET /classes/:id/courses`, not through this.
      return db.withActor(ctx.actor.id, (tx) => repository.listForLearner(tx, ctx.actor.id, query));
    },
  };
}
