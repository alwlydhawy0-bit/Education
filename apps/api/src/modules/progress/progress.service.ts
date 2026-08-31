import { conflict, forbidden, notFound } from '@edu/kernel';
import {
  Role,
  type Action,
  type Actor,
  type AuthorizationContext,
  type Decision,
  type Guarded,
  type LessonProgressResource,
  type PolicyEngine,
  type RelationshipSnapshot,
  type Resource,
} from '@edu/authz';
import { SecurityEventType } from '@edu/observability';
import type { ListProgressQuery, ProgressStatus, RecordProgressRequest } from '@edu/contracts';
import type { Database } from '../../platform/db.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import { isForwardTransition } from './progress.domain.ts';
import type { ProgressRecord, ProgressRepository } from './progress.repository.ts';

export interface ActorContext {
  readonly actor: Actor;
  readonly loadRelationships: () => Promise<RelationshipSnapshot>;
  readonly correlationId: string;
  readonly ip: string | null;
}

export interface ProgressServiceDeps {
  readonly db: Database;
  readonly repository: ProgressRepository;
  readonly engine: PolicyEngine;
  readonly securityEvents: SecurityEventRecorder;
}

export interface ProgressService {
  record(
    ctx: ActorContext,
    lessonId: string,
    input: RecordProgressRequest,
  ): Promise<ProgressRecord>;
  listMine(ctx: ActorContext, query: ListProgressQuery): Promise<ProgressRecord[]>;
  listForStudentInClass(
    ctx: ActorContext,
    classId: string,
    studentId: string,
    query: ListProgressQuery,
  ): Promise<ProgressRecord[]>;
  listForChild(
    ctx: ActorContext,
    childId: string,
    query: ListProgressQuery,
  ): Promise<ProgressRecord[]>;
}

export function createProgressService(deps: ProgressServiceDeps): ProgressService {
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
      // The lesson and the learner are ids, never titles or content. A denial
      // record must not become a way to read what it just refused.
      detail: { action, resourceKind: 'lesson_progress', resourceId, reason },
      occurredAt: new Date(),
    });
  }

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

  /**
   * Runs the policy over every row a query returned and keeps the allows.
   *
   * RLS already scoped the result set. This pass is deliberately redundant —
   * without it a listing would rest on RLS alone, and listings are the
   * endpoints that return the most rows, which is the last place to have one
   * gate (VULN-017). Each row is unwrapped with its OWN decision, so a decision
   * made about one learner cannot release another's record.
   */
  async function keepReadable(
    ctx: ActorContext,
    guarded: readonly Guarded<ProgressRecord>[],
  ): Promise<ProgressRecord[]> {
    const authContext: AuthorizationContext = {
      actor: ctx.actor,
      relationships: await ctx.loadRelationships(),
    };
    const visible: ProgressRecord[] = [];
    for (const row of guarded) {
      const decision = engine.decide(authContext, 'lesson_progress:list', row.resource);
      if (decision.effect === 'allow') {
        visible.push(row.unwrap(decision, 'lesson_progress:list'));
      }
    }
    return visible;
  }

  return {
    async record(ctx, lessonId, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const facts = await repository.lessonFacts(tx, lessonId);
        if (!facts.exists || facts.courseId === null) {
          // An absent lesson and one the actor may not study answer the same
          // way, so a 404 here confirms nothing.
          await recordDenial(ctx, 'lesson_progress:record', lessonId, 'lesson_absent');
          throw notFound();
        }

        const existing = await repository.find(tx, ctx.actor.id, lessonId);
        const current: ProgressStatus = existing
          ? (existing.resource as LessonProgressResource).state
          : 'not_started';

        const resource: LessonProgressResource = {
          kind: 'lesson_progress',
          id: existing ? existing.resource.id : `${ctx.actor.id}:${lessonId}`,
          learnerId: ctx.actor.id,
          learnerOrganizationId: ctx.actor.organizationId,
          lessonId,
          courseId: facts.courseId,
          state: current,
          learnerMayStudy: facts.mayStudy,
          // Irrelevant to a write, and false rather than absent so the resource
          // is never half-built.
          observableByActorAsTeacher: false,
        };
        await decide(ctx, 'lesson_progress:record', resource);

        if (!isForwardTransition(current, input.status)) {
          // Refused by the trigger too. Answering here turns it into a clear
          // 409 rather than a 500 from a constraint the client cannot see.
          throw conflict(`Progress cannot move from ${current} back to ${input.status}`);
        }

        return repository.record(tx, ctx.actor.id, lessonId, input.status);
      });
    },

    async listMine(ctx, query) {
      // Scoped by the actor's own id in SQL, by RLS, and by the policy. No
      // parameter here names a user.
      return db.withActor(ctx.actor.id, async (tx) =>
        keepReadable(ctx, await repository.listForLearner(tx, ctx.actor.id, query)),
      );
    },

    async listForStudentInClass(ctx, classId, studentId, query) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const facts = await repository.classObservation(tx, classId, studentId);

        // THREE ways to get the same 404, deliberately: the class does not
        // exist, the actor has no standing in it, or the student is not in it.
        // A caller must not be able to tell which, or the endpoint becomes a
        // way to probe class rosters.
        const mayObserveClass =
          facts.actorTeachesClass ||
          (ctx.actor.roles.includes(Role.ADMIN) &&
            ctx.actor.organizationId !== null &&
            facts.classOrganizationId === ctx.actor.organizationId);

        if (!facts.classExists || !mayObserveClass || !facts.studentIsMember) {
          await recordDenial(
            ctx,
            'lesson_progress:list',
            `${classId}:${studentId}`,
            'class_or_student_not_observable',
          );
          throw notFound();
        }

        // Scoped in SQL to the courses assigned to THIS class, then filtered by
        // the policy row by row. The SQL scoping is what makes the view precise;
        // the policy is what makes it hold if the SQL were ever loosened.
        return keepReadable(
          ctx,
          await repository.listForLearnerInClass(tx, studentId, classId, query),
        );
      });
    },

    async listForChild(ctx, childId, query) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const relationships = await ctx.loadRelationships();
        // Only VERIFIED guardianships reach the snapshot — a pending or revoked
        // claim is filtered out before any policy sees it (Task 003).
        if (!relationships.guardianOf.includes(childId)) {
          await recordDenial(ctx, 'lesson_progress:list', childId, 'not_a_verified_guardian');
          throw notFound();
        }
        return keepReadable(ctx, await repository.listForLearner(tx, childId, query));
      });
    },
  };
}
