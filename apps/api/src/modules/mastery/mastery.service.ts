import { notFound } from '@edu/kernel';
import {
  Role,
  type Action,
  type Actor,
  type AuthorizationContext,
  type Guarded,
  type PolicyEngine,
  type RelationshipSnapshot,
} from '@edu/authz';
import { SecurityEventType } from '@edu/observability';
import type { CourseMastery, MasteryState, MasteryTally } from '@edu/contracts';
import type { Database } from '../../platform/db.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import type {
  EvidenceRecord,
  MasteryRepository,
  ObjectiveMasteryRecord,
} from './mastery.repository.ts';

export interface ActorContext {
  readonly actor: Actor;
  readonly loadRelationships: () => Promise<RelationshipSnapshot>;
  readonly correlationId: string;
  readonly ip: string | null;
}

export interface MasteryServiceDeps {
  readonly db: Database;
  readonly repository: MasteryRepository;
  readonly engine: PolicyEngine;
  readonly securityEvents: SecurityEventRecorder;
}

export interface MasteryService {
  courseForLearner(ctx: ActorContext, learnerId: string, courseId: string): Promise<CourseMastery>;
  myCourse(ctx: ActorContext, courseId: string): Promise<CourseMastery>;
  myObjectives(ctx: ActorContext): Promise<ObjectiveMasteryRecord[]>;
  objectivesForChild(ctx: ActorContext, childId: string): Promise<ObjectiveMasteryRecord[]>;
  courseForStudentInClass(
    ctx: ActorContext,
    classId: string,
    studentId: string,
    courseId: string,
  ): Promise<CourseMastery>;
  evidenceFor(ctx: ActorContext, learnerId: string, objectiveId: string): Promise<EvidenceRecord[]>;
}

/**
 * Rolls a set of objective states into counts.
 *
 * COUNTS, NOT AN AVERAGE, and the single percentage it does emit has one stated
 * meaning: the share at `demonstrated` or `mastered`. Averaging five ordinal
 * states onto a number requires weights nobody can defend, and it hides the
 * distinction a teacher most needs — whether a class is uniformly `developing`
 * or split between `no_evidence` and `mastered`.
 *
 * An empty set yields `null`, not `0`. A course with nothing to demonstrate is
 * unmeasurable, and reporting 0% would read as failure to a child who has done
 * nothing wrong.
 */
export function tally(states: readonly MasteryState[]): MasteryTally {
  const n = (state: MasteryState) => states.filter((s) => s === state).length;
  const demonstrated = n('demonstrated');
  const mastered = n('mastered');
  return {
    total: states.length,
    noEvidence: n('no_evidence'),
    attempted: n('attempted'),
    developing: n('developing'),
    demonstrated,
    mastered,
    demonstratedPercentage:
      states.length === 0
        ? null
        : Math.round(((demonstrated + mastered) / states.length) * 1000) / 10,
  };
}

/**
 * Groups flat objective rows into the course → unit → lesson shape.
 *
 * The rows arrive ordered by unit, lesson and objective position, so grouping
 * is a single pass that appends to the tail of whatever it is already building.
 * No lookup table, and therefore no place where a missing key would need a
 * non-null assertion to paper over it.
 */
export function assembleCourse(rows: readonly ObjectiveMasteryRecord[]): CourseMastery | null {
  const [first] = rows;
  if (first === undefined) return null;

  interface LessonAcc {
    lessonId: string;
    lessonTitle: string;
    unitId: string;
    unitTitle: string;
    lessonStatus: ObjectiveMasteryRecord['lessonStatus'];
    objectives: CourseMastery['units'][number]['lessons'][number]['objectives'];
    states: MasteryState[];
  }
  interface UnitAcc {
    unitId: string;
    unitTitle: string;
    position: number;
    lessons: LessonAcc[];
    states: MasteryState[];
  }

  const units: UnitAcc[] = [];

  for (const row of rows) {
    let unit = units.at(-1);
    if (unit === undefined || unit.unitId !== row.unitId) {
      unit = {
        unitId: row.unitId,
        unitTitle: row.unitTitle,
        position: row.unitPosition,
        lessons: [],
        states: [],
      };
      units.push(unit);
    }

    let lesson = unit.lessons.at(-1);
    if (lesson === undefined || lesson.lessonId !== row.lessonId) {
      lesson = {
        lessonId: row.lessonId,
        lessonTitle: row.lessonTitle,
        unitId: row.unitId,
        unitTitle: row.unitTitle,
        lessonStatus: row.lessonStatus,
        objectives: [],
        states: [],
      };
      unit.lessons.push(lesson);
    }

    lesson.objectives.push({
      objectiveId: row.objectiveId,
      statement: row.statement,
      position: row.position,
      lessonId: row.lessonId,
      lessonTitle: row.lessonTitle,
      mastery: row.mastery,
      evidenceCount: row.evidenceCount,
      lastEvidenceAt: row.lastEvidenceAt?.toISOString() ?? null,
    });
    lesson.states.push(row.mastery);
    unit.states.push(row.mastery);
  }

  // Lesson completion is counted over DISTINCT lessons, not objective rows —
  // otherwise a lesson with four objectives would count four times, and a course
  // would appear more complete the more finely its objectives were written.
  const lessons = units.flatMap((u) => u.lessons);

  return {
    courseId: first.courseId,
    courseTitle: first.courseTitle,
    units: units.map((u) => ({
      unitId: u.unitId,
      unitTitle: u.unitTitle,
      position: u.position,
      lessons: u.lessons.map((l) => ({
        lessonId: l.lessonId,
        lessonTitle: l.lessonTitle,
        unitId: l.unitId,
        unitTitle: l.unitTitle,
        lessonStatus: l.lessonStatus,
        objectives: l.objectives,
        tally: tally(l.states),
      })),
      tally: tally(u.states),
    })),
    tally: tally(rows.map((r) => r.mastery)),
    lessonsTotal: lessons.length,
    lessonsCompleted: lessons.filter((l) => l.lessonStatus === 'completed').length,
  };
}

export function createMasteryService(deps: MasteryServiceDeps): MasteryService {
  const { db, repository, engine, securityEvents } = deps;

  /**
   * Every denial is recorded with IDS ONLY.
   *
   * Never an objective statement, never a lesson title, never a mastery state.
   * A denial record that carried the thing it refused would be a way to read it,
   * and the audit trail is more widely readable than a child's record is.
   */
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
      detail: { action, resourceKind: 'objective_progress', resourceId, reason },
      occurredAt: new Date(),
    });
  }

  /**
   * Runs the policy over every row and keeps the allows.
   *
   * RLS already scoped the result set and `app_objective_mastery` already
   * re-asked the question itself. This third pass is deliberately redundant:
   * without it a listing would rest on the database alone, and listings return
   * the most rows, which is the last place to have one gate (VULN-017). Each row
   * is decided on its OWN resource, so a decision about one learner can never
   * release another's record.
   */
  async function keepReadable<T>(ctx: ActorContext, guarded: readonly Guarded<T>[]): Promise<T[]> {
    const authContext: AuthorizationContext = {
      actor: ctx.actor,
      relationships: await ctx.loadRelationships(),
    };
    const visible: T[] = [];
    for (const row of guarded) {
      const decision = engine.decide(authContext, 'objective_progress:list', row.resource);
      if (decision.effect === 'allow') {
        // `unwrap` re-checks that the decision names THIS resource and THIS
        // action. A mismatch is the signature of an IDOR bug and throws.
        visible.push(row.unwrap(decision, 'objective_progress:list'));
      }
    }
    return visible;
  }

  /** The shared body of every course view, after the caller's standing is settled. */
  async function assembleFor(
    ctx: ActorContext,
    learnerId: string,
    courseId: string,
  ): Promise<CourseMastery> {
    return db.withActor(ctx.actor.id, async (tx) => {
      if (!(await repository.courseExists(tx, courseId))) {
        await recordDenial(ctx, 'objective_progress:list', courseId, 'course_absent');
        throw notFound();
      }
      const rows = await keepReadable(
        ctx,
        await repository.masteryForCourse(tx, learnerId, courseId),
      );
      const assembled = assembleCourse(rows);
      if (!assembled) {
        // Either the course has no objectives, or none of its rows survived the
        // policy. The two are indistinguishable to the caller ON PURPOSE: a
        // reader without standing must not learn that a course exists and is
        // populated, and one with standing over an empty course gets the same
        // 404 rather than a confusing empty shell.
        await recordDenial(ctx, 'objective_progress:list', courseId, 'no_readable_objectives');
        throw notFound();
      }
      return assembled;
    });
  }

  return {
    async myCourse(ctx, courseId) {
      // The learner is the SESSION. No parameter here names a user.
      return assembleFor(ctx, ctx.actor.id, courseId);
    },

    async courseForLearner(ctx, learnerId, courseId) {
      return assembleFor(ctx, learnerId, courseId);
    },

    async myObjectives(ctx) {
      return db.withActor(ctx.actor.id, async (tx) =>
        keepReadable(ctx, await repository.masteryForLearner(tx, ctx.actor.id)),
      );
    },

    async objectivesForChild(ctx, childId) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const relationships = await ctx.loadRelationships();
        // Only VERIFIED guardianships reach the snapshot; a pending or revoked
        // claim is filtered out before any policy sees it (Task 003).
        if (!relationships.guardianOf.includes(childId)) {
          await recordDenial(ctx, 'objective_progress:list', childId, 'not_a_verified_guardian');
          throw notFound();
        }
        return keepReadable(ctx, await repository.masteryForLearner(tx, childId));
      });
    },

    async courseForStudentInClass(ctx, classId, studentId, courseId) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const facts = await repository.classObservation(tx, classId, studentId);

        // THREE ways to the same 404, deliberately: the class does not exist,
        // the actor has no standing in it, or the student is not in it. A caller
        // must not be able to tell which, or the endpoint becomes a way to probe
        // class rosters. Same rule as the progress module.
        const mayObserveClass =
          facts.actorTeachesClass ||
          (ctx.actor.roles.includes(Role.ADMIN) &&
            ctx.actor.organizationId !== null &&
            facts.classOrganizationId === ctx.actor.organizationId);

        if (!facts.classExists || !mayObserveClass || !facts.studentIsMember) {
          await recordDenial(
            ctx,
            'objective_progress:list',
            `${classId}:${studentId}`,
            'class_or_student_not_observable',
          );
          throw notFound();
        }
        return assembleFor(ctx, studentId, courseId);
      });
    },

    async evidenceFor(ctx, learnerId, objectiveId) {
      return db.withActor(ctx.actor.id, async (tx) =>
        keepReadable(ctx, await repository.evidenceForObjective(tx, learnerId, objectiveId)),
      );
    },
  };
}
