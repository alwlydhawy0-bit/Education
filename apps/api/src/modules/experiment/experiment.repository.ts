import { Guarded, type ExperimentSessionResource, type LearningActivityResource } from '@edu/authz';
import {
  resolveSortColumn,
  resolveSortDirection,
  type ActivityStatus,
  type ArtifactType,
  type LabSessionStatus,
  type ListLabSessionsQuery,
  type PutExperimentRequest,
  type SimulationType,
  type StatePayload,
  type ValidationRule,
} from '@edu/contracts';
import type { Tx } from '../../platform/db.ts';
import { asStatePayload, fromRulesEnvelope, toRulesEnvelope } from './experiment.domain.ts';

/**
 * Persistence for labs, sessions and artifacts.
 *
 * THREE RULES SHAPE EVERY QUERY IN THIS FILE.
 *
 * 1. NOTHING READS THE VALIDATION RULES ON A LEARNER'S PATH.
 *    `experiment_validation_rules` appears in exactly two statements below —
 *    the upsert that writes them during authoring, and `readRulesForAuthor`,
 *    whose name says who it is for and whose rows RLS returns only to somebody
 *    holding `content:author` or `content:publish`. It appears in no FROM or
 *    JOIN on any session query. `tests/architecture/dependency-rules.test.ts`
 *    asserts that mechanically, so the property survives people who have not
 *    read this comment.
 *
 * 2. NOTHING JOINS THE CONTENT TREE TO LABEL A SESSION. A learner keeps every
 *    session they ran but loses sight of the lab when their class membership
 *    ends, so a join to `experiments` for a title would return zero rows for
 *    exactly the learner whose history the retention rule protects. Titles come
 *    from `app_experiment_label`, a definer helper. This is VULN-024's shape,
 *    and 0019's repository carries the same warning for the same reason.
 *
 * 3. NOTHING COMPUTES AN OUTCOME. `passed` and `status` are read, never
 *    written: the submit trigger assigns both from rules this process cannot
 *    read. The submit statement below sets `status = 'submitted'` and the
 *    trigger overwrites it — which is why the row is re-read afterwards rather
 *    than assumed.
 *
 * Labs themselves are different, and joining IS safe there: a lab is content,
 * and anybody who can read one can by definition read its lesson.
 */

export interface ExperimentRecord {
  readonly id: string;
  readonly activityId: string;
  readonly lessonId: string;
  readonly title: string;
  readonly instructions: string;
  readonly simulationType: SimulationType;
  readonly status: ActivityStatus;
  readonly initialConfig: StatePayload;
}

export interface LabSessionRecord {
  readonly id: string;
  readonly experimentId: string;
  readonly experimentTitle: string;
  readonly simulationType: SimulationType;
  readonly lessonId: string;
  readonly lessonTitle: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly status: LabSessionStatus;
  readonly currentState: StatePayload;
  readonly passed: boolean | null;
  readonly startedAt: Date;
  readonly submittedAt: Date | null;
  readonly completedAt: Date | null;
  readonly updatedAt: Date;
}

export interface ArtifactRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly artifactType: ArtifactType;
  readonly payload: StatePayload;
  readonly createdAt: Date;
}

/** What the policy needs about the ACTIVITY that carries a lab. */
export interface ActivityAuthoringFacts {
  readonly exists: boolean;
  readonly lessonId: string | null;
  readonly courseId: string | null;
  readonly organizationId: string | null;
  readonly activityType: string;
  readonly status: ActivityStatus;
  readonly lessonVisible: boolean;
  readonly learnerReaches: boolean;
}

export interface ClassObservationFacts {
  readonly classExists: boolean;
  readonly actorTeachesClass: boolean;
  readonly studentInClass: boolean;
}

interface ExperimentRow {
  id: string;
  activity_id: string;
  lesson_id: string;
  title: string;
  instructions: string;
  simulation_type: SimulationType;
  status: ActivityStatus;
  initial_config: unknown;
  course_id: string | null;
  organization_id: string | null;
  lesson_visible: boolean;
  learner_reaches: boolean;
  activity_type: string;
}

interface SessionRow {
  id: string;
  experiment_id: string;
  user_id: string;
  status: LabSessionStatus;
  current_state: unknown;
  passed: boolean | null;
  started_at: Date;
  submitted_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
  simulation_type: SimulationType;
  activity_title: string;
  lesson_id: string;
  lesson_title: string;
  course_id: string;
  course_title: string;
  learner_organization_id: string | null;
  learner_may_work: boolean;
  observable_by_actor_as_teacher: boolean;
}

interface ArtifactRow {
  id: string;
  session_id: string;
  artifact_type: ArtifactType;
  payload: unknown;
  created_at: Date;
}

const toExperiment = (row: ExperimentRow): ExperimentRecord => ({
  id: row.id,
  activityId: row.activity_id,
  lessonId: row.lesson_id,
  title: row.title,
  instructions: row.instructions,
  simulationType: row.simulation_type,
  status: row.status,
  initialConfig: asStatePayload(row.initial_config),
});

/**
 * A lab is authorized as the ACTIVITY that carries it — there is no
 * `experiment` resource kind, because a lab has no lifecycle of its own.
 */
const toActivityResource = (row: ExperimentRow): LearningActivityResource => ({
  kind: 'learning_activity',
  id: row.activity_id,
  lessonId: row.lesson_id,
  courseId: row.course_id ?? row.lesson_id,
  organizationId: row.organization_id,
  activityType: row.activity_type as LearningActivityResource['activityType'],
  status: row.status,
  lessonVisible: row.lesson_visible,
  learnerReachesLesson: row.learner_reaches,
});

const toSession = (row: SessionRow): LabSessionRecord => ({
  id: row.id,
  experimentId: row.experiment_id,
  experimentTitle: row.activity_title,
  simulationType: row.simulation_type,
  lessonId: row.lesson_id,
  lessonTitle: row.lesson_title,
  courseId: row.course_id,
  courseTitle: row.course_title,
  status: row.status,
  currentState: asStatePayload(row.current_state),
  passed: row.passed,
  startedAt: row.started_at,
  submittedAt: row.submitted_at,
  completedAt: row.completed_at,
  updatedAt: row.updated_at,
});

const toSessionResource = (row: SessionRow): ExperimentSessionResource => ({
  kind: 'experiment_session',
  id: row.id,
  learnerId: row.user_id,
  learnerOrganizationId: row.learner_organization_id,
  experimentId: row.experiment_id,
  lessonId: row.lesson_id,
  state: row.status,
  learnerMayWork: row.learner_may_work,
  observableByActorAsTeacher: row.observable_by_actor_as_teacher,
});

const EXPERIMENT_SELECT = `SELECT e.id, e.activity_id, e.simulation_type, e.initial_config,
              a.lesson_id, a.title, a.instructions, a.status, a.activity_type,
              app_lesson_course(a.lesson_id) AS course_id,
              app_course_organization(app_lesson_course(a.lesson_id)) AS organization_id,
              app_actor_sees_lesson(a.lesson_id) AS lesson_visible,
              app_actor_may_study_lesson(a.lesson_id) AS learner_reaches
         FROM experiments e
         JOIN learning_activities a ON a.id = e.activity_id`;

/**
 * Every session read carries the two facts the pure policy cannot derive,
 * resolved in the same statement as the row so the two can never disagree.
 *
 * `learner_may_work` is asked of the ROW'S SUBJECT, and the definer helpers
 * answer about the CURRENT actor — so it is meaningful only when the actor IS
 * the subject, which is exactly when the policy consults it: writes. On a
 * third-party read the policy ignores it, which is the retention rule.
 *
 * The breadcrumb comes from `app_experiment_label` rather than a join, per
 * rule 2 above.
 */
const SESSION_SELECT = `SELECT s.id, s.experiment_id, s.user_id, s.status, s.current_state,
              s.passed, s.started_at, s.submitted_at, s.completed_at, s.updated_at,
              lb.activity_title, lb.lesson_id, lb.lesson_title, lb.course_id, lb.course_title,
              lb.simulation_type,
              app_user_organization(s.user_id) AS learner_organization_id,
              (s.user_id = app_current_actor()
                 AND app_actor_sees_experiment(s.experiment_id)
                 AND app_actor_may_study_lesson(lb.lesson_id)) AS learner_may_work,
              app_actor_observes_learner_lesson(s.user_id, lb.lesson_id)
                AS observable_by_actor_as_teacher
         FROM experiment_sessions s
         CROSS JOIN LATERAL app_experiment_label(s.experiment_id) lb`;

const SESSION_SORT = {
  startedAt: 's.started_at',
  submittedAt: 's.submitted_at',
  updatedAt: 's.updated_at',
} as const;

export interface ExperimentRepository {
  activityAuthoringFacts(tx: Tx, activityId: string): Promise<ActivityAuthoringFacts>;
  classObservation(tx: Tx, classId: string, studentId: string): Promise<ClassObservationFacts>;

  /** Upserts the lab body AND its rules together. Draft activities only. */
  putExperiment(tx: Tx, activityId: string, input: PutExperimentRequest): Promise<ExperimentRecord>;
  findExperiment(tx: Tx, id: string): Promise<Guarded<ExperimentRecord> | null>;
  findExperimentByActivity(tx: Tx, activityId: string): Promise<Guarded<ExperimentRecord> | null>;
  /**
   * The answer key. Returns null when RLS declines to hand it over, which is
   * what a learner gets — not an empty list, which would be indistinguishable
   * from a lab that has no rules.
   */
  readRulesForAuthor(tx: Tx, experimentId: string): Promise<ValidationRule[] | null>;

  startSession(tx: Tx, experimentId: string, learnerId: string): Promise<LabSessionRecord>;
  findLiveSession(
    tx: Tx,
    experimentId: string,
    learnerId: string,
  ): Promise<Guarded<LabSessionRecord> | null>;
  findSession(tx: Tx, id: string): Promise<Guarded<LabSessionRecord> | null>;
  saveState(tx: Tx, sessionId: string, state: StatePayload): Promise<LabSessionRecord>;
  submitSession(tx: Tx, sessionId: string, state: StatePayload): Promise<LabSessionRecord>;
  appendArtifact(
    tx: Tx,
    sessionId: string,
    artifactType: ArtifactType,
    payload: StatePayload,
  ): Promise<ArtifactRecord>;
  listArtifacts(tx: Tx, sessionId: string): Promise<ArtifactRecord[]>;

  listSessionsForLearner(
    tx: Tx,
    learnerId: string,
    query: ListLabSessionsQuery,
  ): Promise<Guarded<LabSessionRecord>[]>;
  listSessionsForLearnerInClass(
    tx: Tx,
    learnerId: string,
    classId: string,
    query: ListLabSessionsQuery,
  ): Promise<Guarded<LabSessionRecord>[]>;
}

async function readExperiment(tx: Tx, id: string): Promise<ExperimentRecord | null> {
  const { rows } = await tx.query<ExperimentRow>(`${EXPERIMENT_SELECT} WHERE e.id = $1`, [id]);
  const row = rows[0];
  return row ? toExperiment(row) : null;
}

async function readSession(tx: Tx, id: string): Promise<LabSessionRecord | null> {
  const { rows } = await tx.query<SessionRow>(`${SESSION_SELECT} WHERE s.id = $1`, [id]);
  const row = rows[0];
  return row ? toSession(row) : null;
}

export const experimentRepository: ExperimentRepository = {
  async activityAuthoringFacts(tx, activityId) {
    const { rows } = await tx.query<{
      lesson_id: string;
      course_id: string | null;
      organization_id: string | null;
      activity_type: string;
      status: ActivityStatus;
      lesson_visible: boolean;
      learner_reaches: boolean;
    }>(
      `SELECT a.lesson_id, a.activity_type, a.status,
              app_lesson_course(a.lesson_id) AS course_id,
              app_course_organization(app_lesson_course(a.lesson_id)) AS organization_id,
              app_actor_sees_lesson(a.lesson_id) AS lesson_visible,
              app_actor_may_study_lesson(a.lesson_id) AS learner_reaches
         FROM learning_activities a
        WHERE a.id = $1`,
      [activityId],
    );
    const row = rows[0];
    if (!row) {
      return {
        exists: false,
        lessonId: null,
        courseId: null,
        organizationId: null,
        activityType: 'assessment',
        status: 'draft',
        lessonVisible: false,
        learnerReaches: false,
      };
    }
    return {
      exists: true,
      lessonId: row.lesson_id,
      courseId: row.course_id,
      organizationId: row.organization_id,
      activityType: row.activity_type,
      status: row.status,
      lessonVisible: row.lesson_visible,
      learnerReaches: row.learner_reaches,
    };
  },

  async classObservation(tx, classId, studentId) {
    const { rows } = await tx.query<{
      class_org: string | null;
      teaches: boolean;
      is_member: boolean;
    }>(
      `SELECT app_class_organization_of($1)      AS class_org,
              app_actor_teaches_class($1)        AS teaches,
              app_user_is_member_of_class($2, $1) AS is_member`,
      [classId, studentId],
    );
    const row = rows[0];
    if (!row) throw new Error('Fact query returned no row');
    return {
      // A class always belongs to a school, so a null organization means the
      // class does not exist. Asked through a definer helper rather than a
      // SELECT on `classes`, which RLS would filter — making a class the actor
      // cannot see indistinguishable from one that does not exist, and turning
      // "you do not teach this class" into "no such class".
      classExists: row.class_org !== null,
      actorTeachesClass: row.teaches,
      studentInClass: row.is_member,
    };
  },

  async putExperiment(tx, activityId, input) {
    // ONE STATEMENT PAIR IN ONE TRANSACTION. The scene and the rules must never
    // exist apart: a lab with a scene and no rules row cannot be published, and
    // the author would have no way to tell why.
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO experiments (activity_id, simulation_type, initial_config)
       VALUES ($1, $2, $3)
       ON CONFLICT (activity_id) DO UPDATE
         SET simulation_type = EXCLUDED.simulation_type,
             initial_config  = EXCLUDED.initial_config,
             updated_at      = now()
       RETURNING id`,
      [activityId, input.simulationType, JSON.stringify(input.initialConfig)],
    );
    const experimentId = rows[0]?.id;
    if (!experimentId) throw new Error('The lab was not written');

    await tx.query(
      `INSERT INTO experiment_validation_rules (experiment_id, rules)
       VALUES ($1, $2)
       ON CONFLICT (experiment_id) DO UPDATE
         SET rules = EXCLUDED.rules, updated_at = now()`,
      [experimentId, JSON.stringify(toRulesEnvelope(input.rules))],
    );

    const saved = await readExperiment(tx, experimentId);
    if (!saved) throw new Error('The saved lab is not readable');
    return saved;
  },

  async findExperiment(tx, id) {
    const { rows } = await tx.query<ExperimentRow>(`${EXPERIMENT_SELECT} WHERE e.id = $1`, [id]);
    const row = rows[0];
    return row ? Guarded.of(toExperiment(row), toActivityResource(row)) : null;
  },

  async findExperimentByActivity(tx, activityId) {
    const { rows } = await tx.query<ExperimentRow>(
      `${EXPERIMENT_SELECT} WHERE e.activity_id = $1`,
      [activityId],
    );
    const row = rows[0];
    return row ? Guarded.of(toExperiment(row), toActivityResource(row)) : null;
  },

  async readRulesForAuthor(tx, experimentId) {
    const { rows } = await tx.query<{ rules: unknown }>(
      `SELECT v.rules FROM experiment_validation_rules v WHERE v.experiment_id = $1`,
      [experimentId],
    );
    const row = rows[0];
    // No row means RLS refused, OR the lab has no rules row at all. Both are
    // "you get nothing", and the caller must not turn either into an empty list
    // — an empty list is a real configuration meaning "nothing to check".
    return row ? fromRulesEnvelope(row.rules) : null;
  },

  async startSession(tx, experimentId, learnerId) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO experiment_sessions (experiment_id, user_id) VALUES ($1, $2) RETURNING id`,
      [experimentId, learnerId],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('The lab session was not created');
    const saved = await readSession(tx, id);
    if (!saved) throw new Error('The new lab session is not readable');
    return saved;
  },

  async findLiveSession(tx, experimentId, learnerId) {
    const { rows } = await tx.query<SessionRow>(
      `${SESSION_SELECT}
        WHERE s.experiment_id = $1 AND s.user_id = $2 AND s.status = 'in_progress'`,
      [experimentId, learnerId],
    );
    const row = rows[0];
    return row ? Guarded.of(toSession(row), toSessionResource(row)) : null;
  },

  async findSession(tx, id) {
    const { rows } = await tx.query<SessionRow>(`${SESSION_SELECT} WHERE s.id = $1`, [id]);
    const row = rows[0];
    return row ? Guarded.of(toSession(row), toSessionResource(row)) : null;
  },

  async saveState(tx, sessionId, state) {
    // No `status` in the SET list. A save cannot finish a lab, and the column is
    // not named here so a future edit cannot make it one by accident.
    const { rowCount } = await tx.query(
      `UPDATE experiment_sessions SET current_state = $2, updated_at = now() WHERE id = $1`,
      [sessionId, JSON.stringify(state)],
    );
    if ((rowCount ?? 0) === 0) {
      // RLS declined: the learner has lost the lesson since the policy ran, or
      // the session is no longer live. §3's instant state isolation, arriving as
      // silence rather than as an error, which is why it is checked.
      throw new SessionNotWritableError();
    }
    const saved = await readSession(tx, sessionId);
    if (!saved) throw new Error('The saved lab session is not readable');
    return saved;
  },

  async submitSession(tx, sessionId, state) {
    // `status = 'submitted'` is a REQUEST, not an outcome. The submit trigger
    // marks the state against rules this process cannot read and overwrites
    // both `status` and `passed`, which is why the row is re-read below rather
    // than assumed.
    const { rowCount } = await tx.query(
      `UPDATE experiment_sessions
          SET current_state = $2, status = 'submitted', updated_at = now()
        WHERE id = $1`,
      [sessionId, JSON.stringify(state)],
    );
    if ((rowCount ?? 0) === 0) throw new SessionNotWritableError();
    const saved = await readSession(tx, sessionId);
    if (!saved) throw new Error('The submitted lab session is not readable');
    return saved;
  },

  async appendArtifact(tx, sessionId, artifactType, payload) {
    let rows: ArtifactRow[];
    try {
      ({ rows } = await tx.query<ArtifactRow>(
        `INSERT INTO experiment_artifacts (session_id, artifact_type, payload)
         VALUES ($1, $2, $3)
         RETURNING id, session_id, artifact_type, payload, created_at`,
        [sessionId, artifactType, JSON.stringify(payload)],
      ));
    } catch (error) {
      // An INSERT the RLS check refuses RAISES rather than matching zero rows,
      // so this is the shape the session updates express with a rowCount test.
      // Both are the same event — the actor may not write here — and both must
      // reach the caller as that rather than as an internal fault.
      //
      // Under correct policy this is unreachable: `experiment_session:save`
      // has already refused. It exists because a defect-injection round
      // downgraded that authorization to `:read` and the refusal came back as a
      // 500, which is the wrong answer to the right question.
      if (isRlsRefusal(error)) throw new SessionNotWritableError();
      throw error;
    }
    const row = rows[0];
    if (!row) throw new Error('The artifact was not written');
    return {
      id: row.id,
      sessionId: row.session_id,
      artifactType: row.artifact_type,
      payload: asStatePayload(row.payload),
      createdAt: row.created_at,
    };
  },

  async listArtifacts(tx, sessionId) {
    const { rows } = await tx.query<ArtifactRow>(
      `SELECT id, session_id, artifact_type, payload, created_at
         FROM experiment_artifacts
        WHERE session_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT 500`,
      [sessionId],
    );
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      artifactType: row.artifact_type,
      payload: asStatePayload(row.payload),
      createdAt: row.created_at,
    }));
  },

  async listSessionsForLearner(tx, learnerId, query) {
    const column = resolveSortColumn(SESSION_SORT, query.sort);
    const direction = resolveSortDirection(query.order);
    const { rows } = await tx.query<SessionRow>(
      `${SESSION_SELECT}
        WHERE s.user_id = $1
          AND ($4::uuid IS NULL OR s.experiment_id = $4)
          AND ($5::text IS NULL OR s.status = $5)
        ORDER BY ${column} ${direction} NULLS LAST, s.id ASC
        LIMIT $2 OFFSET $3`,
      [learnerId, query.limit, query.offset, query.experimentId ?? null, query.status ?? null],
    );
    return rows.map((row) => Guarded.of(toSession(row), toSessionResource(row)));
  },

  async listSessionsForLearnerInClass(tx, learnerId, classId, query) {
    const column = resolveSortColumn(SESSION_SORT, query.sort);
    const direction = resolveSortDirection(query.order);
    // Scoped in SQL to the courses assigned to THIS class, in addition to the
    // policy. That is what makes the teacher view precise: a teacher who also
    // teaches another class cannot reach this learner's sessions at a lab
    // belonging only to that other class.
    const { rows } = await tx.query<SessionRow>(
      `${SESSION_SELECT}
        WHERE s.user_id = $1
          AND EXISTS (
            SELECT 1 FROM class_course_assignments ca
             WHERE ca.class_id = $4 AND ca.course_id = lb.course_id AND ca.status = 'active'
          )
          AND ($5::uuid IS NULL OR s.experiment_id = $5)
          AND ($6::text IS NULL OR s.status = $6)
        ORDER BY ${column} ${direction} NULLS LAST, s.id ASC
        LIMIT $2 OFFSET $3`,
      [
        learnerId,
        query.limit,
        query.offset,
        classId,
        query.experimentId ?? null,
        query.status ?? null,
      ],
    );
    return rows.map((row) => Guarded.of(toSession(row), toSessionResource(row)));
  },
};

/** PostgreSQL's SQLSTATE for a row rejected by a row-security policy. */
const RLS_VIOLATION = '42501';

function isRlsRefusal(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === RLS_VIOLATION
  );
}

/**
 * A write the database accepted the shape of and Row Level Security then
 * matched zero rows for.
 *
 * Its own error type because it is NOT an internal fault and must not surface
 * as a 500: it is the ordinary outcome of a learner losing access between the
 * policy decision and the write, which is precisely what §3's instant state
 * isolation is supposed to feel like.
 */
export class SessionNotWritableError extends Error {
  constructor() {
    super('The lab session is no longer writable by this actor');
    this.name = 'SessionNotWritableError';
  }
}
