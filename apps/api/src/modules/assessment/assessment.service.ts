import { conflict, forbidden, notFound, validationFailed } from '@edu/kernel';
import {
  Role,
  type Action,
  type Actor,
  type AssessmentAttemptResource,
  type AuthorizationContext,
  type Decision,
  type Guarded,
  type LearningActivityResource,
  type PolicyEngine,
  type RelationshipSnapshot,
  type Resource,
} from '@edu/authz';
import { SecurityEventType } from '@edu/observability';
import type {
  AttemptQuestion,
  CreateActivityRequest,
  CreateQuestionRequest,
  ListActivitiesQuery,
  ListAttemptsQuery,
  SubmitAttemptRequest,
} from '@edu/contracts';
import type { Database, Tx } from '../../platform/db.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import { validateAnswerPayload } from './assessment.domain.ts';
import type {
  ActivityRecord,
  AssessmentRecord,
  AssessmentRepository,
  AttemptRecord,
} from './assessment.repository.ts';

export interface ActorContext {
  readonly actor: Actor;
  readonly loadRelationships: () => Promise<RelationshipSnapshot>;
  readonly correlationId: string;
  readonly ip: string | null;
}

/**
 * How this module tells the progress domain that a learner engaged with a
 * lesson.
 *
 * DEFINED HERE, IMPLEMENTED THERE, WIRED IN `app.ts`. Dependency rule 3 forbids
 * one module importing another's internals, and dependency rule 4 says the
 * composition root is where they meet — so the assessment module declares the
 * narrowest interface it needs and never learns that `lesson_progress` exists.
 *
 * The narrowness matters as much as the direction. This cannot mark a lesson
 * COMPLETE, and there is no parameter through which it could: submitting an
 * assessment is evidence of engagement, and treating a pass as completion would
 * be exactly the inference the task forbids. Progress remains a record the
 * learner authors about themselves; this only moves the "last seen" hand.
 */
export interface LessonEngagementRecorder {
  noteEngagement(tx: Tx, learnerId: string, lessonId: string): Promise<void>;
}

export interface AssessmentServiceDeps {
  readonly db: Database;
  readonly repository: AssessmentRepository;
  readonly engine: PolicyEngine;
  readonly securityEvents: SecurityEventRecorder;
  readonly progress: LessonEngagementRecorder;
}

export interface AssessmentService {
  createActivity(
    ctx: ActorContext,
    lessonId: string,
    input: CreateActivityRequest,
  ): Promise<ActivityRecord>;
  addQuestion(
    ctx: ActorContext,
    assessmentId: string,
    input: CreateQuestionRequest,
  ): Promise<{ questionId: string }>;
  setActivityStatus(
    ctx: ActorContext,
    id: string,
    status: 'published' | 'archived',
  ): Promise<ActivityRecord>;
  listActivities(
    ctx: ActorContext,
    lessonId: string,
    query: ListActivitiesQuery,
  ): Promise<ActivityRecord[]>;
  readActivity(ctx: ActorContext, id: string): Promise<ActivityRecord>;
  readAssessment(ctx: ActorContext, id: string): Promise<AssessmentRecord>;
  startAttempt(
    ctx: ActorContext,
    assessmentId: string,
  ): Promise<{ attempt: AttemptRecord; questions: AttemptQuestion[] }>;
  readAttempt(
    ctx: ActorContext,
    id: string,
  ): Promise<{ attempt: AttemptRecord; questions: AttemptQuestion[] }>;
  submitAttempt(ctx: ActorContext, id: string, input: SubmitAttemptRequest): Promise<AttemptRecord>;
  listMyAttempts(ctx: ActorContext, query: ListAttemptsQuery): Promise<AttemptRecord[]>;
  listAttemptsForStudentInClass(
    ctx: ActorContext,
    classId: string,
    studentId: string,
    query: ListAttemptsQuery,
  ): Promise<AttemptRecord[]>;
  listAttemptsForChild(
    ctx: ActorContext,
    childId: string,
    query: ListAttemptsQuery,
  ): Promise<AttemptRecord[]>;
}

/** PostgreSQL error codes the database raises through the guards in 0019. */
const INTEGRITY_VIOLATION = '23000';
const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';

function pgCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

export function createAssessmentService(deps: AssessmentServiceDeps): AssessmentService {
  const { db, repository, engine, securityEvents, progress } = deps;

  async function emit(
    ctx: ActorContext,
    type: (typeof SecurityEventType)[keyof typeof SecurityEventType],
    detail: Record<string, unknown>,
  ): Promise<void> {
    await securityEvents.record({
      type,
      actorId: ctx.actor.id,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
      detail,
      occurredAt: new Date(),
    });
  }

  /**
   * Every denial is recorded with IDS ONLY.
   *
   * Never a title, never a prompt, never a selected option, and — obviously —
   * never anything from the key. A denial record that carried the thing it
   * refused would be a way to read it, and the audit trail is more widely
   * readable than the assessment is.
   */
  async function recordDenial(
    ctx: ActorContext,
    action: Action,
    resourceKind: string,
    resourceId: string,
    reason: string,
  ): Promise<void> {
    await emit(ctx, SecurityEventType.AUTHZ_DENIED, {
      action,
      resourceKind,
      resourceId,
      reason,
    });
  }

  async function authContextOf(ctx: ActorContext): Promise<AuthorizationContext> {
    return { actor: ctx.actor, relationships: await ctx.loadRelationships() };
  }

  async function decide(ctx: ActorContext, action: Action, resource: Resource): Promise<Decision> {
    const decision = engine.decide(await authContextOf(ctx), action, resource);
    if (decision.effect !== 'allow') {
      await recordDenial(ctx, action, resource.kind, resource.id, decision.reason);
      if (decision.effect === 'deny' && decision.disclosure === 'reveal') throw forbidden();
      throw notFound();
    }
    return decision;
  }

  /**
   * The by-id pipeline, in one place: resolve, decide, unwrap.
   *
   * `Guarded.unwrap` re-checks that the decision was made for THIS id and THIS
   * action, so a handler cannot authorize one object and return another. An
   * absent row and a refused one answer the same way.
   */
  async function authorize<T>(
    ctx: ActorContext,
    guarded: Guarded<T> | null,
    action: Action,
    resourceKind: string,
    resourceId: string,
  ): Promise<T> {
    if (!guarded) {
      await recordDenial(ctx, action, resourceKind, resourceId, 'not_found');
      throw notFound();
    }
    const decision = await decide(ctx, action, guarded.resource);
    return guarded.unwrap(decision, action);
  }

  /**
   * Runs the policy over every row a query returned and keeps the allows.
   *
   * RLS already scoped the result set; this pass is deliberately redundant.
   * Without it a listing would rest on RLS alone, and listings return the most
   * rows, which is the last place to have a single gate (VULN-017). Each row is
   * unwrapped with its OWN decision, so a decision about one learner cannot
   * release another's record.
   */
  async function keepReadable<T>(
    ctx: ActorContext,
    guarded: readonly Guarded<T>[],
    action: Action,
  ): Promise<T[]> {
    const authContext = await authContextOf(ctx);
    const visible: T[] = [];
    for (const row of guarded) {
      const decision = engine.decide(authContext, action, row.resource);
      if (decision.effect === 'allow') visible.push(row.unwrap(decision, action));
    }
    return visible;
  }

  /**
   * Resolves an assessment to the ACTIVITY that governs it, and authorizes
   * against that.
   *
   * There is no separate assessment policy, on purpose: an assessment has no
   * lifecycle of its own, so a second rule could only ever disagree with the
   * first about whether a child may see it.
   */
  async function authorizeAssessmentActivity(
    ctx: ActorContext,
    tx: Tx,
    assessmentId: string,
    action: Action,
  ): Promise<ActivityRecord> {
    return authorize(
      ctx,
      await repository.findActivityForAssessment(tx, assessmentId),
      action,
      'learning_activity',
      assessmentId,
    );
  }

  return {
    async createActivity(ctx, lessonId, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const facts = await repository.lessonAuthoringFacts(tx, lessonId);
        if (!facts.exists || facts.courseId === null) {
          await recordDenial(ctx, 'learning_activity:create', 'lesson', lessonId, 'lesson_absent');
          throw notFound();
        }

        // The resource is the activity that WOULD be created. Its id is
        // synthetic because nothing exists yet; the policy never uses an id to
        // decide, only to label the decision.
        const resource: LearningActivityResource = {
          kind: 'learning_activity',
          id: `${lessonId}:new`,
          lessonId,
          courseId: facts.courseId,
          organizationId: facts.organizationId,
          activityType: input.activityType,
          status: 'draft',
          lessonVisible: facts.visible,
          learnerReachesLesson: facts.learnerReaches,
        };
        await decide(ctx, 'learning_activity:create', resource);

        const created = await repository.createActivity(tx, lessonId, ctx.actor.id, input);
        await emit(ctx, SecurityEventType.CONTENT_CREATED, {
          resourceKind: 'learning_activity',
          resourceId: created.id,
          activityType: created.activityType,
          organizationId: facts.organizationId,
        });
        return created;
      });
    },

    async addQuestion(ctx, assessmentId, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        // Adding a question is AUTHORING the activity's content, gated on
        // `content:author` — not on `content:publish`. The policy additionally
        // refuses it once the activity has left draft, and the database refuses
        // it again in `assessment_content_is_draft_only`.
        const activity = await authorizeAssessmentActivity(
          ctx,
          tx,
          assessmentId,
          'learning_activity:update',
        );
        if (activity.activityType !== 'assessment') {
          throw validationFailed('That activity does not carry an assessment');
        }

        try {
          const questionId = await repository.addQuestion(tx, assessmentId, input);
          await emit(ctx, SecurityEventType.CONTENT_UPDATED, {
            resourceKind: 'learning_activity',
            resourceId: activity.id,
            // The question ID only. Never the prompt, never the options, and
            // never which of them is correct.
            questionId,
          });
          return { questionId };
        } catch (error) {
          if (pgCode(error) === INTEGRITY_VIOLATION) {
            throw conflict(messageOf(error));
          }
          throw error;
        }
      });
    },

    async setActivityStatus(ctx, id, status) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const action: Action =
          status === 'published' ? 'learning_activity:publish' : 'learning_activity:archive';
        await authorize(
          ctx,
          await repository.findActivity(tx, id),
          action,
          'learning_activity',
          id,
        );

        let updated: ActivityRecord;
        try {
          updated = await repository.setActivityStatus(tx, id, status);
        } catch (error) {
          if (pgCode(error) === INTEGRITY_VIOLATION) {
            // Publication validation: an assessment whose questions cannot be
            // scored fairly. A 409 with the database's own message, which names
            // no question and no answer.
            throw conflict(messageOf(error));
          }
          throw error;
        }

        await emit(
          ctx,
          status === 'published'
            ? SecurityEventType.CONTENT_PUBLISHED
            : SecurityEventType.CONTENT_ARCHIVED,
          { resourceKind: 'learning_activity', resourceId: id, activityType: updated.activityType },
        );
        return updated;
      });
    },

    async listActivities(ctx, lessonId, query) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const facts = await repository.lessonAuthoringFacts(tx, lessonId);
        if (!facts.exists || !facts.visible) {
          // A lesson the actor cannot see and one that does not exist answer
          // the same way, so the endpoint cannot be used to probe for lessons.
          await recordDenial(ctx, 'learning_activity:list', 'lesson', lessonId, 'lesson_absent');
          throw notFound();
        }
        return keepReadable(
          ctx,
          await repository.listActivities(tx, lessonId, query),
          'learning_activity:list',
        );
      });
    },

    async readActivity(ctx, id) {
      return db.withActor(ctx.actor.id, async (tx) =>
        authorize(
          ctx,
          await repository.findActivity(tx, id),
          'learning_activity:read',
          'learning_activity',
          id,
        ),
      );
    },

    async readAssessment(ctx, id) {
      return db.withActor(ctx.actor.id, async (tx) => {
        await authorizeAssessmentActivity(ctx, tx, id, 'learning_activity:read');
        const assessment = await repository.loadAssessment(tx, id, ctx.actor.id);
        if (!assessment) throw notFound();
        // METADATA ONLY. The questions are handed out when an attempt is
        // started, not here — which bounds question-bank harvesting by the
        // attempt limit rather than leaving it open to anyone who can see the
        // assessment.
        return assessment;
      });
    },

    async startAttempt(ctx, assessmentId) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const activity = await authorizeAssessmentActivity(
          ctx,
          tx,
          assessmentId,
          'learning_activity:read',
        );
        if (activity.activityType !== 'assessment' || activity.assessmentId === null) {
          throw notFound();
        }

        const facts = await repository.lessonAuthoringFacts(tx, activity.lessonId);
        // The resource for the START decision. `learnerMayAttempt` combines the
        // activity being published with the learner reaching its lesson through
        // a class — the two conditions RLS checks independently on the insert.
        const resource: AssessmentAttemptResource = {
          kind: 'assessment_attempt',
          id: `${ctx.actor.id}:${assessmentId}`,
          learnerId: ctx.actor.id,
          learnerOrganizationId: ctx.actor.organizationId,
          assessmentId,
          lessonId: activity.lessonId,
          state: 'in_progress',
          learnerMayAttempt: activity.status === 'published' && facts.learnerReaches,
          observableByActorAsTeacher: false,
        };
        await decide(ctx, 'assessment_attempt:start', resource);

        let attempt: AttemptRecord;
        try {
          attempt = await repository.startAttempt(tx, assessmentId, ctx.actor.id);
        } catch (error) {
          const code = pgCode(error);
          if (code === INTEGRITY_VIOLATION) {
            // The attempt limit, enforced by the trigger over a definer count.
            // Worth its own event: repeated re-attempts at one assessment is
            // the shape of probing for the key rather than of studying.
            await emit(ctx, SecurityEventType.ASSESSMENT_ATTEMPT_LIMIT_EXCEEDED, {
              assessmentId,
            });
            throw conflict('The attempt limit for this assessment has been reached');
          }
          if (code === UNIQUE_VIOLATION) {
            // Two concurrent starts computed the same attempt number. A retry
            // is the right answer, and it is the client's to make.
            throw conflict('Another attempt was started at the same moment; please retry');
          }
          throw error;
        }

        await emit(ctx, SecurityEventType.ASSESSMENT_ATTEMPT_STARTED, {
          assessmentId,
          attemptId: attempt.id,
          attemptNumber: attempt.attemptNumber,
        });

        return { attempt, questions: await repository.questionsFor(tx, assessmentId) };
      });
    },

    async readAttempt(ctx, id) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const guarded = await repository.findAttempt(tx, id);
        const attempt = await authorize(
          ctx,
          guarded,
          'assessment_attempt:read',
          'assessment_attempt',
          id,
        );

        /**
         * The PAPER goes back only to the attempt's owner, and only while the
         * attempt is still in progress.
         *
         * Two separate reasons, both about disclosure rather than convenience:
         * a teacher, guardian or administrator reading a result has no need for
         * the question bank and should not be handed one; and a finished
         * attempt stops disclosing the paper at all, so a learner cannot mine
         * questions by re-reading old attempts once their allowance is spent.
         *
         * Read from the RESOURCE, not from the record — the resource is the
         * server's copy of the authorization-relevant attributes, and it is
         * what the decision was made about.
         */
        const resource = guarded?.resource as AssessmentAttemptResource | undefined;
        const isOwnAndOpen =
          resource?.learnerId === ctx.actor.id && attempt.status === 'in_progress';
        const questions = isOwnAndOpen
          ? await repository.questionsFor(tx, attempt.assessmentId)
          : [];
        return { attempt, questions };
      });
    },

    async submitAttempt(ctx, id, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const attempt = await authorize(
          ctx,
          await repository.findAttempt(tx, id),
          'assessment_attempt:submit',
          'assessment_attempt',
          id,
        );

        const questions = await repository.questionsFor(tx, attempt.assessmentId);
        const { rows, violations } = validateAnswerPayload(questions, input);

        if (violations.length > 0) {
          // A payload no interface can produce. Reported, then refused — and
          // refused independently by the database if this check were removed.
          await emit(ctx, SecurityEventType.ASSESSMENT_SUSPICIOUS_SUBMISSION, {
            attemptId: id,
            assessmentId: attempt.assessmentId,
            // The KINDS of violation and how many. Never the ids that were
            // sent, which would put a probed question id into the audit trail.
            violations: violations.map((v) => v.kind),
          });
          throw validationFailed('The submitted answers do not match this assessment');
        }

        await repository.recordAnswers(tx, id, rows);
        let submitted: AttemptRecord;
        try {
          submitted = await repository.submitAttempt(tx, id);
        } catch (error) {
          if (pgCode(error) === INTEGRITY_VIOLATION || pgCode(error) === FK_VIOLATION) {
            throw conflict(messageOf(error));
          }
          throw error;
        }

        /**
         * Progress integration: engagement, and nothing more.
         *
         * The lesson is touched, never completed. Passing an assessment is
         * evidence about one paper on one day; treating it as "this learner has
         * finished this lesson" would be an inference the platform is not
         * entitled to make, and marking a lesson complete is a claim only the
         * learner may author (migration 0018).
         *
         * Inside the same transaction, as the same actor, so RLS applies
         * identically — the write succeeds precisely because the learner still
         * reaches the lesson, which they must in order to have submitted at all.
         */
        await progress.noteEngagement(tx, ctx.actor.id, attempt.lessonId);

        await emit(ctx, SecurityEventType.ASSESSMENT_SUBMITTED, {
          attemptId: id,
          assessmentId: attempt.assessmentId,
          attemptNumber: submitted.attemptNumber,
          // The OUTCOME, not the answers. A pass flag in the audit trail is
          // what makes "was this mark computed, or written?" answerable; the
          // selections are not recorded here at all.
          passed: submitted.passed,
        });
        return submitted;
      });
    },

    async listMyAttempts(ctx, query) {
      // Scoped by the actor's own id in SQL, by RLS, and by the policy. No
      // parameter here names a user.
      return db.withActor(ctx.actor.id, async (tx) =>
        keepReadable(
          ctx,
          await repository.listAttemptsForLearner(tx, ctx.actor.id, query),
          'assessment_attempt:list',
        ),
      );
    },

    async listAttemptsForStudentInClass(ctx, classId, studentId, query) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const facts = await repository.classObservation(tx, classId, studentId);

        // THREE ways to the same 404, deliberately: the class does not exist,
        // the actor has no standing in it, or the student is not in it. A
        // caller must not be able to tell which, or the endpoint becomes a way
        // to probe class rosters.
        const mayObserveClass =
          facts.actorTeachesClass ||
          (ctx.actor.roles.includes(Role.ADMIN) &&
            ctx.actor.organizationId !== null &&
            facts.classOrganizationId === ctx.actor.organizationId);

        if (!facts.classExists || !mayObserveClass || !facts.studentIsMember) {
          await recordDenial(
            ctx,
            'assessment_attempt:list',
            'assessment_attempt',
            `${classId}:${studentId}`,
            'class_or_student_not_observable',
          );
          throw notFound();
        }

        return keepReadable(
          ctx,
          await repository.listAttemptsForLearnerInClass(tx, studentId, classId, query),
          'assessment_attempt:list',
        );
      });
    },

    async listAttemptsForChild(ctx, childId, query) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const relationships = await ctx.loadRelationships();
        // Only VERIFIED guardianships reach the snapshot; a pending or revoked
        // claim is filtered out before any policy sees it (Task 003).
        if (!relationships.guardianOf.includes(childId)) {
          await recordDenial(
            ctx,
            'assessment_attempt:list',
            'assessment_attempt',
            childId,
            'not_a_verified_guardian',
          );
          throw notFound();
        }
        return keepReadable(
          ctx,
          await repository.listAttemptsForLearner(tx, childId, query),
          'assessment_attempt:list',
        );
      });
    },
  };
}
