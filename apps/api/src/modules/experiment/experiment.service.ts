import { forbidden, notFound, validationFailed } from '@edu/kernel';
import {
  type Action,
  type Actor,
  type AuthorizationContext,
  type Decision,
  type ExperimentSessionResource,
  type Guarded,
  type PolicyEngine,
  type RelationshipSnapshot,
  type Resource,
} from '@edu/authz';
import { SecurityEventType } from '@edu/observability';
import type {
  AppendArtifactRequest,
  ListLabSessionsQuery,
  PutExperimentRequest,
  SaveLabStateRequest,
  SubmitLabRequest,
  ValidationRule,
} from '@edu/contracts';
import type { Database, Tx } from '../../platform/db.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import { checkStatePayload } from './experiment.domain.ts';
import {
  SessionNotWritableError,
  type ArtifactRecord,
  type ExperimentRecord,
  type ExperimentRepository,
  type LabSessionRecord,
} from './experiment.repository.ts';

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
 * DEFINED HERE, IMPLEMENTED THERE, WIRED IN `app.ts` — the same shape the
 * assessment module declares, for the same reason: dependency rule 3 forbids
 * one module importing another's internals, so this one declares the narrowest
 * interface it needs and never learns that `lesson_progress` exists.
 *
 * The narrowness matters as much as the direction. This cannot mark a lesson
 * COMPLETE, and there is no parameter through which it could. Passing a lab is
 * not finishing a lesson; treating it as such would be the platform deciding
 * something about a child that the child did not say.
 */
export interface LessonEngagementRecorder {
  noteEngagement(tx: Tx, learnerId: string, lessonId: string): Promise<void>;
}

export interface ExperimentServiceDeps {
  readonly db: Database;
  readonly repository: ExperimentRepository;
  readonly engine: PolicyEngine;
  readonly securityEvents: SecurityEventRecorder;
  readonly progress: LessonEngagementRecorder;
}

export interface AuthoredExperiment {
  readonly experiment: ExperimentRecord;
  readonly rules: ValidationRule[];
}

export interface ExperimentService {
  putExperiment(
    ctx: ActorContext,
    activityId: string,
    input: PutExperimentRequest,
  ): Promise<AuthoredExperiment>;
  /**
   * Reads a lab.
   *
   * `rules` is null for anybody who is not authoring it — not an empty array,
   * because an empty array is a real configuration meaning "nothing to check"
   * and a learner must not be able to tell the two apart.
   */
  readExperiment(
    ctx: ActorContext,
    id: string,
  ): Promise<{ experiment: ExperimentRecord; rules: ValidationRule[] | null }>;

  startSession(
    ctx: ActorContext,
    experimentId: string,
  ): Promise<{ session: LabSessionRecord; experiment: ExperimentRecord }>;
  readSession(ctx: ActorContext, id: string): Promise<LabSessionRecord>;
  saveState(ctx: ActorContext, id: string, input: SaveLabStateRequest): Promise<LabSessionRecord>;
  submitSession(ctx: ActorContext, id: string, input: SubmitLabRequest): Promise<LabSessionRecord>;
  appendArtifact(
    ctx: ActorContext,
    sessionId: string,
    input: AppendArtifactRequest,
  ): Promise<ArtifactRecord>;
  listArtifacts(ctx: ActorContext, sessionId: string): Promise<ArtifactRecord[]>;

  listMySessions(ctx: ActorContext, query: ListLabSessionsQuery): Promise<LabSessionRecord[]>;
  listSessionsForStudentInClass(
    ctx: ActorContext,
    classId: string,
    studentId: string,
    query: ListLabSessionsQuery,
  ): Promise<LabSessionRecord[]>;
  listSessionsForChild(
    ctx: ActorContext,
    childId: string,
    query: ListLabSessionsQuery,
  ): Promise<LabSessionRecord[]>;
}

export function createExperimentService(deps: ExperimentServiceDeps): ExperimentService {
  const { db, repository, engine, securityEvents, progress } = deps;

  async function emit(
    ctx: ActorContext,
    type: SecurityEventType,
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
   * Never a title, never a state payload, never a rule, and — obviously — never
   * anything from the answer key. A denial record that carried the thing it
   * refused would be a way to read it, and the audit trail is more widely
   * readable than the lab is.
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
   * Structural bounds on a client payload, BEFORE it reaches the database.
   *
   * The Zod schema has already capped the byte length; this catches the shapes
   * a byte cap cannot — deeply nested and densely populated — because those cost
   * a JSON parser and a jsonb build rather than costing bytes. Reported as
   * `payload.too_large` because that is what it is, even though the bytes were
   * within bounds.
   */
  async function guardPayload(
    ctx: ActorContext,
    resourceId: string,
    field: string,
    value: unknown,
  ): Promise<void> {
    const rejection = checkStatePayload(value);
    if (!rejection) return;
    await emit(ctx, SecurityEventType.PAYLOAD_TOO_LARGE, {
      resourceKind: 'experiment_session',
      resourceId,
      field,
      reason: rejection.reason,
      limit: rejection.limit,
    });
    throw validationFailed(`The ${field} payload was rejected: ${rejection.reason}`);
  }

  /**
   * The write pipeline for a session, shared by save and submit.
   *
   * Both authorize the SAME resource with DIFFERENT actions, and both have to
   * cope with the same race: the policy says yes, and RLS then matches zero
   * rows because the learner lost the lesson in between. That is not an error —
   * it is exactly what §3's instant state isolation feels like from inside a
   * request — so it becomes a 404 with an event, never a 500.
   */
  async function writeSession(
    ctx: ActorContext,
    tx: Tx,
    id: string,
    action: 'experiment_session:save' | 'experiment_session:submit',
    write: (session: LabSessionRecord) => Promise<LabSessionRecord>,
  ): Promise<LabSessionRecord> {
    const session = await authorize(
      ctx,
      await repository.findSession(tx, id),
      action,
      'experiment_session',
      id,
    );
    try {
      return await write(session);
    } catch (error) {
      if (error instanceof SessionNotWritableError) {
        await emit(ctx, SecurityEventType.LAB_STATE_WRITE_REFUSED, {
          resourceKind: 'experiment_session',
          resourceId: id,
          action,
        });
        throw notFound();
      }
      throw error;
    }
  }

  return {
    async putExperiment(ctx, activityId, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const facts = await repository.activityAuthoringFacts(tx, activityId);
        if (!facts.exists || facts.lessonId === null || facts.courseId === null) {
          await recordDenial(
            ctx,
            'learning_activity:update',
            'learning_activity',
            activityId,
            'activity_absent',
          );
          throw notFound();
        }

        await decide(ctx, 'learning_activity:update', {
          kind: 'learning_activity',
          id: activityId,
          lessonId: facts.lessonId,
          courseId: facts.courseId,
          organizationId: facts.organizationId,
          activityType: facts.activityType as 'simulation',
          status: facts.status,
          lessonVisible: facts.lessonVisible,
          learnerReachesLesson: facts.learnerReaches,
        });

        // Checked HERE as well as by the database trigger, so an author gets a
        // 422 naming the problem rather than a constraint violation. The trigger
        // remains the real gate — this is the message, not the rule.
        if (facts.activityType !== 'simulation' && facts.activityType !== 'experiment') {
          throw validationFailed('Only a simulation or experiment activity can carry a lab');
        }
        if (facts.status !== 'draft') {
          throw validationFailed('A published lab cannot be changed');
        }

        await guardPayload(ctx, activityId, 'initialConfig', input.initialConfig);

        const experiment = await repository.putExperiment(tx, activityId, input);
        await emit(ctx, SecurityEventType.CONTENT_UPDATED, {
          resourceKind: 'experiment',
          resourceId: experiment.id,
          activityId,
          simulationType: experiment.simulationType,
          // The COUNT of rules, never the rules. How many checks a lab applies
          // is operationally useful; what they check is the answer.
          ruleCount: input.rules.length,
          organizationId: facts.organizationId,
        });

        const rules = await repository.readRulesForAuthor(tx, experiment.id);
        return { experiment, rules: rules ?? [] };
      });
    },

    async readExperiment(ctx, id) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const experiment = await authorize(
          ctx,
          await repository.findExperiment(tx, id),
          'learning_activity:read',
          'learning_activity',
          id,
        );
        // NOT gated on a role in TypeScript. The rules row comes back only if
        // the RLS select policy hands it over, which it does for an author or a
        // publisher in the same school and for nobody else. Deciding it here as
        // well would be a second rule that could disagree with the first, and
        // the looser of the two would win.
        const rules = await repository.readRulesForAuthor(tx, experiment.id);
        return { experiment, rules };
      });
    },

    async startSession(ctx, experimentId) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const guarded = await repository.findExperiment(tx, experimentId);
        if (!guarded) {
          await recordDenial(
            ctx,
            'experiment_session:start',
            'experiment_session',
            experimentId,
            'experiment_absent',
          );
          throw notFound();
        }
        const activity = guarded.resource;
        if (activity.kind !== 'learning_activity') {
          throw new Error('unreachable: a lab resolves to its activity');
        }

        // The resource is the session that WOULD be created. Its id is
        // synthetic because nothing exists yet; the policy never uses an id to
        // decide, only to label the decision.
        const intent: ExperimentSessionResource = {
          kind: 'experiment_session',
          id: `${experimentId}:new`,
          learnerId: ctx.actor.id,
          learnerOrganizationId: ctx.actor.organizationId,
          experimentId,
          lessonId: activity.lessonId,
          state: 'in_progress',
          learnerMayWork: activity.learnerReachesLesson && activity.status === 'published',
          observableByActorAsTeacher: false,
        };
        await decide(ctx, 'experiment_session:start', intent);

        // The scene is handed out under `learning_activity:read`, decided
        // separately from the start above. Starting a lab and being shown its
        // contents are two disclosures, and a learner who may do one is not
        // automatically entitled to the other — the policy says so twice
        // rather than the handler assuming it once.
        const experiment = guarded.unwrap(
          await decide(ctx, 'learning_activity:read', activity),
          'learning_activity:read',
        );

        // RESUMES rather than duplicates. The partial unique index permits one
        // live session per learner per lab, so a second start would be a
        // constraint violation surfacing as a 500 — and from the learner's side,
        // reopening a lab they left open is the obvious thing to have happen.
        const live = await repository.findLiveSession(tx, experimentId, ctx.actor.id);
        if (live) {
          const resumed = live.unwrap(
            await decide(ctx, 'experiment_session:read', live.resource),
            'experiment_session:read',
          );
          return { session: resumed, experiment };
        }

        const session = await repository.startSession(tx, experimentId, ctx.actor.id);
        await progress.noteEngagement(tx, ctx.actor.id, activity.lessonId);
        await emit(ctx, SecurityEventType.LAB_SESSION_STARTED, {
          resourceKind: 'experiment_session',
          resourceId: session.id,
          experimentId,
          lessonId: activity.lessonId,
        });
        return { session, experiment };
      });
    },

    async readSession(ctx, id) {
      return db.withActor(ctx.actor.id, async (tx) =>
        authorize(
          ctx,
          await repository.findSession(tx, id),
          'experiment_session:read',
          'experiment_session',
          id,
        ),
      );
    },

    async saveState(ctx, id, input) {
      await guardPayload(ctx, id, 'currentState', input.currentState);
      return db.withActor(ctx.actor.id, async (tx) =>
        writeSession(ctx, tx, id, 'experiment_session:save', () =>
          repository.saveState(tx, id, input.currentState),
        ),
      );
    },

    async submitSession(ctx, id, input) {
      await guardPayload(ctx, id, 'currentState', input.currentState);
      return db.withActor(ctx.actor.id, async (tx) => {
        const saved = await writeSession(ctx, tx, id, 'experiment_session:submit', () =>
          repository.submitSession(tx, id, input.currentState),
        );
        await progress.noteEngagement(tx, ctx.actor.id, saved.lessonId);
        await emit(ctx, SecurityEventType.LAB_SUBMITTED, {
          resourceKind: 'experiment_session',
          resourceId: saved.id,
          experimentId: saved.experimentId,
          lessonId: saved.lessonId,
          // The STATUS, which says whether the database accepted the work. Not
          // the state that produced it, and not a copy of the rules it met.
          status: saved.status,
        });
        return saved;
      });
    },

    async appendArtifact(ctx, sessionId, input) {
      await guardPayload(ctx, sessionId, 'payload', input.payload);
      return db.withActor(ctx.actor.id, async (tx) => {
        // Authorized as `:save`, not as a fourth action. Appending telemetry to
        // your own live session is the same authority as saving state into it —
        // it is available at the same moments, to the same person, and refused
        // by the same RLS clause. A separate action would be a second rule for
        // one authority.
        await authorize(
          ctx,
          await repository.findSession(tx, sessionId),
          'experiment_session:save',
          'experiment_session',
          sessionId,
        );
        try {
          return await repository.appendArtifact(
            tx,
            sessionId,
            input.artifactType,
            input.payload,
          );
        } catch (error) {
          if (error instanceof SessionNotWritableError) {
            await emit(ctx, SecurityEventType.LAB_STATE_WRITE_REFUSED, {
              resourceKind: 'experiment_session',
              resourceId: sessionId,
              action: 'experiment_session:save',
            });
            throw notFound();
          }
          throw error;
        }
      });
    },

    async listArtifacts(ctx, sessionId) {
      return db.withActor(ctx.actor.id, async (tx) => {
        await authorize(
          ctx,
          await repository.findSession(tx, sessionId),
          'experiment_session:read',
          'experiment_session',
          sessionId,
        );
        return repository.listArtifacts(tx, sessionId);
      });
    },

    async listMySessions(ctx, query) {
      return db.withActor(ctx.actor.id, async (tx) =>
        keepReadable(
          ctx,
          await repository.listSessionsForLearner(tx, ctx.actor.id, query),
          'experiment_session:list',
        ),
      );
    },

    async listSessionsForStudentInClass(ctx, classId, studentId, query) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const facts = await repository.classObservation(tx, classId, studentId);
        // The class and the membership are checked BEFORE the rows are read, so
        // a teacher cannot use a class they teach as a lens onto a student who
        // is not in it. Every answer below is the same 404, because which of the
        // three failed is itself information about somebody else's roster.
        if (!facts.classExists || !facts.actorTeachesClass || !facts.studentInClass) {
          await recordDenial(
            ctx,
            'experiment_session:list',
            'class',
            classId,
            'not_a_shared_class',
          );
          throw notFound();
        }
        return keepReadable(
          ctx,
          await repository.listSessionsForLearnerInClass(tx, studentId, classId, query),
          'experiment_session:list',
        );
      });
    },

    async listSessionsForChild(ctx, childId, query) {
      const relationships = await ctx.loadRelationships();
      // VERIFIED guardianships only — the snapshot has already dropped pending
      // and revoked claims. Checked here so a guardian of nobody gets the same
      // 404 as a guardian of somebody else, rather than an empty list that
      // confirms the child id exists.
      if (!relationships.guardianOf.includes(childId)) {
        await recordDenial(ctx, 'experiment_session:list', 'user', childId, 'not_a_guardian');
        throw notFound();
      }
      return db.withActor(ctx.actor.id, async (tx) =>
        keepReadable(
          ctx,
          await repository.listSessionsForLearner(tx, childId, query),
          'experiment_session:list',
        ),
      );
    },
  };
}
