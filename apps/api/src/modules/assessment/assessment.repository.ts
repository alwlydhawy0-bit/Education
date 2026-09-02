import { Guarded, type AssessmentAttemptResource, type LearningActivityResource } from '@edu/authz';
import {
  resolveSortColumn,
  resolveSortDirection,
  type ActivityStatus,
  type ActivityType,
  type AttemptQuestion,
  type AttemptStatus,
  type CreateActivityRequest,
  type CreateQuestionRequest,
  type ListActivitiesQuery,
  type ListAttemptsQuery,
  type QuestionType,
  type ReviewPolicy,
} from '@edu/contracts';
import type { Tx } from '../../platform/db.ts';

/**
 * Persistence for activities, assessments and attempts.
 *
 * TWO RULES SHAPE EVERY QUERY IN THIS FILE.
 *
 * 1. NOTHING READS THE ANSWER KEY. `assessment_answer_keys` appears in exactly
 *    one statement below — the INSERT that writes it during authoring — and in
 *    no FROM or JOIN anywhere. `tests/architecture/dependency-rules.test.ts`
 *    asserts that mechanically, so the property survives people who have not
 *    read this comment. The key is compared inside the database by
 *    `app_score_attempt`, which the application role may not even execute.
 *
 * 2. NOTHING JOINS THE CONTENT TREE TO LABEL AN ATTEMPT. A learner keeps every
 *    attempt they submitted but loses sight of the assessment when their class
 *    membership ends, so a join to `assessments` for a title would return zero
 *    rows for exactly the learner whose history the retention rule protects.
 *    Titles come from `app_assessment_label`, a definer helper. This is the same
 *    defect as VULN-024, found again by probing migration 0019 before this file
 *    existed.
 *
 * Activities are different, and joining IS safe there: an activity is content,
 * and anybody who can read one can by definition read its lesson.
 */

export interface ActivityRecord {
  readonly id: string;
  readonly lessonId: string;
  readonly position: number;
  readonly activityType: ActivityType;
  readonly title: string;
  readonly instructions: string;
  readonly status: ActivityStatus;
  readonly assessmentId: string | null;
  readonly createdAt: Date;
}

export interface AssessmentRecord {
  readonly id: string;
  readonly activityId: string;
  readonly lessonId: string;
  readonly title: string;
  readonly instructions: string;
  readonly questionCount: number;
  readonly maxScore: number;
  readonly passingPercentage: number;
  readonly maxAttempts: number;
  readonly attemptsUsed: number;
  readonly reviewPolicy: ReviewPolicy;
}

export interface AttemptRecord {
  readonly id: string;
  readonly assessmentId: string;
  readonly assessmentTitle: string;
  readonly lessonId: string;
  readonly lessonTitle: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly attemptNumber: number;
  readonly status: AttemptStatus;
  readonly startedAt: Date;
  readonly submittedAt: Date | null;
  readonly score: number | null;
  readonly maxScore: number | null;
  readonly percentage: number | null;
  readonly passed: boolean | null;
  readonly passingPercentage: number;
  readonly released: boolean;
  readonly releasedAt: Date | null;
  readonly teacherComment: string | null;
}

/** One question of a released paper, as `app_attempt_review` returns it. */
export interface ReviewedQuestionRecord {
  readonly questionId: string;
  readonly position: number;
  readonly questionType: QuestionType;
  readonly prompt: string;
  readonly points: number;
  readonly awarded: number;
  readonly isCorrect: boolean;
  readonly selectedOptionIds: string[];
  readonly correctOptionIds: string[];
  readonly explanation: string;
  readonly options: Array<{ id: string; position: number; body: string }>;
}

/** What the policy needs about a lesson before any activity exists on it. */
export interface LessonAuthoringFacts {
  readonly exists: boolean;
  readonly courseId: string | null;
  readonly organizationId: string | null;
  readonly visible: boolean;
  readonly learnerReaches: boolean;
}

/**
 * The same four facts `progress` needs for the teacher view, asked the same way
 * through the same definer helpers — so "may this actor look at that student in
 * that class?" has one answer across both domains.
 */
export interface ClassObservationFacts {
  readonly classExists: boolean;
  readonly classOrganizationId: string | null;
  readonly actorTeachesClass: boolean;
  readonly studentIsMember: boolean;
}

interface ActivityRow {
  id: string;
  lesson_id: string;
  position: number;
  activity_type: ActivityType;
  title: string;
  instructions: string;
  status: ActivityStatus;
  assessment_id: string | null;
  created_at: Date;
  course_id: string | null;
  organization_id: string | null;
  lesson_visible: boolean;
  learner_reaches: boolean;
}

interface AttemptRow {
  id: string;
  assessment_id: string;
  user_id: string;
  attempt_number: number;
  status: AttemptStatus;
  started_at: Date;
  submitted_at: Date | null;
  score: number | null;
  max_score: number | null;
  percentage: string | null;
  passed: boolean | null;
  activity_title: string;
  lesson_id: string;
  lesson_title: string;
  course_id: string;
  course_title: string;
  passing_percentage: number;
  learner_organization_id: string | null;
  learner_may_attempt: boolean;
  observable_by_actor_as_teacher: boolean;
  released_at: Date | null;
  teacher_comment: string | null;
}

const toActivity = (row: ActivityRow): ActivityRecord => ({
  id: row.id,
  lessonId: row.lesson_id,
  position: row.position,
  activityType: row.activity_type,
  title: row.title,
  instructions: row.instructions,
  status: row.status,
  assessmentId: row.assessment_id,
  createdAt: row.created_at,
});

const toActivityResource = (row: ActivityRow): LearningActivityResource => ({
  kind: 'learning_activity',
  id: row.id,
  lessonId: row.lesson_id,
  // `app_lesson_course` answers null only for a lesson that does not exist, and
  // a row cannot reference one. The fallback keeps the resource total.
  courseId: row.course_id ?? row.lesson_id,
  organizationId: row.organization_id,
  activityType: row.activity_type,
  status: row.status,
  lessonVisible: row.lesson_visible,
  learnerReachesLesson: row.learner_reaches,
});

const toAttempt = (row: AttemptRow): AttemptRecord => ({
  id: row.id,
  assessmentId: row.assessment_id,
  assessmentTitle: row.activity_title,
  lessonId: row.lesson_id,
  lessonTitle: row.lesson_title,
  courseId: row.course_id,
  courseTitle: row.course_title,
  attemptNumber: row.attempt_number,
  status: row.status,
  startedAt: row.started_at,
  submittedAt: row.submitted_at,
  // THE MARKS ARE REDACTED IN SQL, not here — `marks_visible` is computed in
  // the query and these columns already arrive null when the reader must not
  // see them. This mapping only carries that through, so a future change to the
  // DTO cannot re-expose a withheld score: the value never left the database.
  score: row.score,
  maxScore: row.max_score,
  // `numeric` arrives as a string from `pg`; parsing here keeps the boundary in
  // one place rather than in every consumer.
  percentage: row.percentage === null ? null : Number(row.percentage),
  passed: row.passed,
  passingPercentage: row.passing_percentage,
  released: row.released_at !== null,
  releasedAt: row.released_at,
  teacherComment: row.teacher_comment,
});

const toAttemptResource = (row: AttemptRow): AssessmentAttemptResource => ({
  kind: 'assessment_attempt',
  id: row.id,
  learnerId: row.user_id,
  learnerOrganizationId: row.learner_organization_id,
  assessmentId: row.assessment_id,
  lessonId: row.lesson_id,
  state: row.status,
  released: row.released_at !== null,
  learnerMayAttempt: row.learner_may_attempt,
  observableByActorAsTeacher: row.observable_by_actor_as_teacher,
});

const ACTIVITY_SELECT = `SELECT a.id, a.lesson_id, a.position, a.activity_type, a.title,
              a.instructions, a.status, a.created_at,
              s.id AS assessment_id,
              app_lesson_course(a.lesson_id) AS course_id,
              app_course_organization(app_lesson_course(a.lesson_id)) AS organization_id,
              app_actor_sees_lesson(a.lesson_id) AS lesson_visible,
              app_actor_may_study_lesson(a.lesson_id) AS learner_reaches
         FROM learning_activities a
         LEFT JOIN assessments s ON s.activity_id = a.id`;

/**
 * WHO MAY SEE THE MARKS, decided in SQL.
 *
 * A released attempt is visible to everyone who may read it. An UNRELEASED one
 * shows its marks to a teacher or an administrator — they have to see what they
 * are deciding about — but not to the learner or their guardian, who are the
 * people the withholding is for.
 *
 * Written as a CASE in the projection rather than as a filter in TypeScript, so
 * a withheld score never crosses the process boundary at all. Row-level
 * security cannot hide a column; this is the equivalent, done where it cannot
 * be forgotten by a serializer.
 */
const MARKS_VISIBLE = `(t.released_at IS NOT NULL
        OR NOT (t.user_id = app_current_actor() OR app_actor_guards(t.user_id)))`;

/**
 * Every attempt read carries the two facts the pure policy cannot derive,
 * resolved in the same statement as the row so the two can never disagree.
 *
 * `learner_may_attempt` is asked of the ROW'S SUBJECT, and the definer helpers
 * answer about the CURRENT actor — so it is meaningful only when the actor is
 * the subject, which is exactly when the policy consults it: writes. On a
 * third-party read the policy ignores it, which is the retention rule.
 */
const ATTEMPT_SELECT = `SELECT t.id, t.assessment_id, t.user_id, t.attempt_number, t.status,
              t.started_at, t.submitted_at,
              CASE WHEN ${MARKS_VISIBLE} THEN t.score      END AS score,
              CASE WHEN ${MARKS_VISIBLE} THEN t.max_score  END AS max_score,
              CASE WHEN ${MARKS_VISIBLE} THEN t.percentage END AS percentage,
              CASE WHEN ${MARKS_VISIBLE} THEN t.passed     END AS passed,
              t.released_at, t.teacher_comment,
              lb.activity_title, lb.lesson_id, lb.lesson_title,
              lb.course_id, lb.course_title, lb.passing_percentage,
              app_user_organization(t.user_id) AS learner_organization_id,
              (t.user_id = app_current_actor()
                 AND app_actor_sees_assessment(t.assessment_id)
                 AND app_actor_may_study_lesson(lb.lesson_id)) AS learner_may_attempt,
              app_actor_observes_learner_lesson(t.user_id, lb.lesson_id)
                AS observable_by_actor_as_teacher
         FROM assessment_attempts t
         CROSS JOIN LATERAL app_assessment_label(t.assessment_id) lb`;

const ATTEMPT_SORT = {
  startedAt: 't.started_at',
  submittedAt: 't.submitted_at',
  attemptNumber: 't.attempt_number',
} as const;

const ACTIVITY_SORT = {
  position: 'a.position',
  createdAt: 'a.created_at',
} as const;

export interface AssessmentRepository {
  lessonAuthoringFacts(tx: Tx, lessonId: string): Promise<LessonAuthoringFacts>;
  classObservation(tx: Tx, classId: string, studentId: string): Promise<ClassObservationFacts>;

  createActivity(
    tx: Tx,
    lessonId: string,
    createdBy: string,
    input: CreateActivityRequest,
  ): Promise<ActivityRecord>;
  findActivity(tx: Tx, id: string): Promise<Guarded<ActivityRecord> | null>;
  findActivityForAssessment(tx: Tx, assessmentId: string): Promise<Guarded<ActivityRecord> | null>;
  listActivities(
    tx: Tx,
    lessonId: string,
    query: ListActivitiesQuery,
  ): Promise<Guarded<ActivityRecord>[]>;
  setActivityStatus(tx: Tx, id: string, status: ActivityStatus): Promise<ActivityRecord>;
  addQuestion(tx: Tx, assessmentId: string, input: CreateQuestionRequest): Promise<string>;

  loadAssessment(tx: Tx, assessmentId: string, learnerId: string): Promise<AssessmentRecord | null>;
  questionsFor(tx: Tx, assessmentId: string): Promise<AttemptQuestion[]>;

  startAttempt(tx: Tx, assessmentId: string, learnerId: string): Promise<AttemptRecord>;
  findAttempt(tx: Tx, id: string): Promise<Guarded<AttemptRecord> | null>;
  recordAnswers(
    tx: Tx,
    attemptId: string,
    rows: ReadonlyArray<readonly [questionId: string, optionId: string]>,
  ): Promise<void>;
  submitAttempt(tx: Tx, attemptId: string): Promise<AttemptRecord>;
  /** The marked paper. Empty when the attempt is not released to this reader. */
  reviewFor(tx: Tx, attemptId: string): Promise<ReviewedQuestionRecord[]>;
  /**
   * Records the release. Returns the attempt as it now stands.
   *
   * IDEMPOTENT: the RLS release policy carries `released_at IS NULL` in its
   * USING clause, so a second release matches zero rows and changes nothing
   * rather than erroring. The caller treats that as success.
   */
  releaseAttempt(tx: Tx, attemptId: string, comment: string | null): Promise<AttemptRecord>;
  listAttemptsForLearner(
    tx: Tx,
    learnerId: string,
    query: ListAttemptsQuery,
  ): Promise<Guarded<AttemptRecord>[]>;
  listAttemptsForLearnerInClass(
    tx: Tx,
    learnerId: string,
    classId: string,
    query: ListAttemptsQuery,
  ): Promise<Guarded<AttemptRecord>[]>;
}

async function readActivity(tx: Tx, id: string): Promise<ActivityRecord | null> {
  const { rows } = await tx.query<ActivityRow>(`${ACTIVITY_SELECT} WHERE a.id = $1`, [id]);
  const row = rows[0];
  return row ? toActivity(row) : null;
}

async function readAttempt(tx: Tx, id: string): Promise<AttemptRecord | null> {
  const { rows } = await tx.query<AttemptRow>(`${ATTEMPT_SELECT} WHERE t.id = $1`, [id]);
  const row = rows[0];
  return row ? toAttempt(row) : null;
}

/**
 * How many options a learner must select, from the question TYPE alone.
 *
 * Never from the key. Publishing "this multiple-choice question has two correct
 * answers" would narrow the guess space for free, so a multiple-choice question
 * says only "one or more".
 */
function selectionLimitFor(type: QuestionType): number | null {
  return type === 'multiple_choice' ? null : 1;
}

export const assessmentRepository: AssessmentRepository = {
  async lessonAuthoringFacts(tx, lessonId) {
    const { rows } = await tx.query<{
      course_id: string | null;
      organization_id: string | null;
      visible: boolean;
      learner_reaches: boolean;
    }>(
      `SELECT app_lesson_course($1) AS course_id,
              app_course_organization(app_lesson_course($1)) AS organization_id,
              app_actor_sees_lesson($1) AS visible,
              app_actor_may_study_lesson($1) AS learner_reaches`,
      [lessonId],
    );
    const row = rows[0];
    if (!row) throw new Error('Fact query returned no row');
    return {
      // `app_lesson_course` answers null only when the lesson does not exist.
      exists: row.course_id !== null,
      courseId: row.course_id,
      organizationId: row.organization_id,
      visible: row.visible,
      learnerReaches: row.learner_reaches,
    };
  },

  async classObservation(tx, classId, studentId) {
    const { rows } = await tx.query<{
      class_org: string | null;
      teaches: boolean;
      is_member: boolean;
    }>(
      `SELECT app_class_organization_of($1) AS class_org,
              app_actor_teaches_class($1)   AS teaches,
              app_user_is_member_of_class($2, $1) AS is_member`,
      [classId, studentId],
    );
    const row = rows[0];
    if (!row) throw new Error('Fact query returned no row');
    return {
      // A class always belongs to a school, so a null organization means the
      // class does not exist.
      classExists: row.class_org !== null,
      classOrganizationId: row.class_org,
      actorTeachesClass: row.teaches,
      studentIsMember: row.is_member,
    };
  },

  async createActivity(tx, lessonId, createdBy, input) {
    // Position is SERVER-ASSIGNED from the current maximum, never accepted from
    // the request — two authors cannot race for slot 3, and a client cannot
    // reorder somebody else's work by claiming a position.
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO learning_activities (lesson_id, position, activity_type, title, instructions, created_by)
       VALUES ($1,
               (SELECT coalesce(max(position), 0) + 1 FROM learning_activities WHERE lesson_id = $1),
               $2, $3, $4, $5)
       RETURNING id`,
      [lessonId, input.activityType, input.title, input.instructions, createdBy],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('Activity insert returned no row');

    if (input.assessment) {
      await tx.query(
        `INSERT INTO assessments (activity_id, passing_percentage, max_attempts, review_policy)
         VALUES ($1, $2, $3, $4)`,
        [
          id,
          input.assessment.passingPercentage,
          input.assessment.maxAttempts,
          input.assessment.reviewPolicy,
        ],
      );
    }

    // Read back in a SECOND statement: the definer helpers in ACTIVITY_SELECT
    // cannot see a row the same statement is writing. Same reason as VULN-014.
    const saved = await readActivity(tx, id);
    if (!saved) throw new Error('The created activity is not readable by its author');
    return saved;
  },

  async findActivity(tx, id) {
    const { rows } = await tx.query<ActivityRow>(`${ACTIVITY_SELECT} WHERE a.id = $1`, [id]);
    const row = rows[0];
    if (!row) return null;
    return Guarded.of(toActivity(row), toActivityResource(row));
  },

  async findActivityForAssessment(tx, assessmentId) {
    // The assessment's authorization resource IS its activity, because they
    // share one lifecycle. Resolving it here rather than in the service keeps
    // the two from ever being authorized separately.
    const { rows } = await tx.query<ActivityRow>(`${ACTIVITY_SELECT} WHERE s.id = $1`, [
      assessmentId,
    ]);
    const row = rows[0];
    if (!row) return null;
    return Guarded.of(toActivity(row), toActivityResource(row));
  },

  async listActivities(tx, lessonId, query) {
    const column = resolveSortColumn(ACTIVITY_SORT, query.sort);
    const direction = resolveSortDirection(query.order);
    const { rows } = await tx.query<ActivityRow>(
      `${ACTIVITY_SELECT}
        WHERE a.lesson_id = $1
          AND ($4::text IS NULL OR a.activity_type = $4)
        ORDER BY ${column} ${direction}, a.id ASC
        LIMIT $2 OFFSET $3`,
      [lessonId, query.limit, query.offset, query.activityType ?? null],
    );
    return rows.map((row) => Guarded.of(toActivity(row), toActivityResource(row)));
  },

  async setActivityStatus(tx, id, status) {
    // The lifecycle timestamps are derived from the status here, so a caller
    // cannot set one without the other and produce a row the CHECK constraints
    // would reject — or, worse, one they would accept but that means nothing.
    await tx.query(
      `UPDATE learning_activities
          SET status = $2,
              published_at = CASE WHEN $2 = 'published' THEN now() ELSE published_at END,
              archived_at  = CASE WHEN $2 = 'archived'  THEN now() ELSE archived_at  END,
              updated_at = now()
        WHERE id = $1`,
      [id, status],
    );
    const saved = await readActivity(tx, id);
    if (!saved) throw new Error('The updated activity is not readable');
    return saved;
  },

  async addQuestion(tx, assessmentId, input) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO assessment_questions (assessment_id, position, question_type, prompt, points, explanation)
       VALUES ($1,
               (SELECT coalesce(max(position), 0) + 1 FROM assessment_questions WHERE assessment_id = $1),
               $2, $3, $4, $5)
       RETURNING id`,
      [assessmentId, input.questionType, input.prompt, input.points, input.explanation],
    );
    const questionId = rows[0]?.id;
    if (!questionId) throw new Error('Question insert returned no row');

    const { rows: optionRows } = await tx.query<{ id: string; position: number }>(
      `INSERT INTO assessment_options (question_id, position, body)
       SELECT $1, ordinality, body
         FROM unnest($2::text[]) WITH ORDINALITY AS t(body, ordinality)
       RETURNING id, position`,
      [questionId, input.options],
    );

    // The key is written from INDEXES the author supplied into the option list
    // they supplied in the same request. There is no path by which it could
    // name another question's option — and the composite foreign key on
    // `assessment_answer_keys` refuses one anyway.
    const byPosition = new Map(optionRows.map((o) => [o.position, o.id]));
    const correctIds = input.correctOptions.map((index) => {
      const id = byPosition.get(index + 1);
      if (!id) throw new Error('Correct option index does not name an inserted option');
      return id;
    });

    await tx.query(
      `INSERT INTO assessment_answer_keys (question_id, option_id)
       SELECT $1, unnest($2::uuid[])`,
      [questionId, correctIds],
    );

    return questionId;
  },

  async loadAssessment(tx, assessmentId, learnerId) {
    // `questionCount` and `maxScore` are aggregates over the questions the
    // caller can already see, so they disclose nothing the questions do not.
    const { rows } = await tx.query<{
      id: string;
      activity_id: string;
      lesson_id: string;
      title: string;
      instructions: string;
      question_count: string;
      max_score: string;
      passing_percentage: number;
      max_attempts: number;
      attempts_used: number;
      review_policy: ReviewPolicy;
    }>(
      `SELECT s.id, s.activity_id, a.lesson_id, a.title, a.instructions,
              (SELECT count(*)            FROM assessment_questions q WHERE q.assessment_id = s.id) AS question_count,
              (SELECT coalesce(sum(q.points), 0) FROM assessment_questions q WHERE q.assessment_id = s.id) AS max_score,
              s.passing_percentage, s.max_attempts, s.review_policy,
              app_attempt_count(s.id, $2) AS attempts_used
         FROM assessments s
         JOIN learning_activities a ON a.id = s.activity_id
        WHERE s.id = $1`,
      [assessmentId, learnerId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      activityId: row.activity_id,
      lessonId: row.lesson_id,
      title: row.title,
      instructions: row.instructions,
      questionCount: Number(row.question_count),
      maxScore: Number(row.max_score),
      passingPercentage: row.passing_percentage,
      maxAttempts: row.max_attempts,
      attemptsUsed: row.attempts_used,
      // Told to the learner BEFORE they sit, so a client can say "your teacher
      // releases these results" up front. It discloses nothing about the paper
      // or the mark — only when the mark will be shown.
      reviewPolicy: row.review_policy,
    };
  },

  async questionsFor(tx, assessmentId) {
    // NOTE THE COLUMN LIST. There is no join to `assessment_answer_keys` and no
    // column that could carry correctness. A learner receives the prompt, the
    // options and how many to pick — nothing that narrows which one is right.
    const { rows } = await tx.query<{
      id: string;
      position: number;
      question_type: QuestionType;
      prompt: string;
      points: number;
      options: Array<{ id: string; position: number; body: string }> | null;
    }>(
      `SELECT q.id, q.position, q.question_type, q.prompt, q.points,
              (
                SELECT json_agg(json_build_object('id', o.id, 'position', o.position, 'body', o.body)
                                ORDER BY o.position)
                  FROM assessment_options o
                 WHERE o.question_id = q.id
              ) AS options
         FROM assessment_questions q
        WHERE q.assessment_id = $1
        ORDER BY q.position ASC`,
      [assessmentId],
    );
    return rows.map((row) => ({
      id: row.id,
      position: row.position,
      questionType: row.question_type,
      prompt: row.prompt,
      points: row.points,
      selectionLimit: selectionLimitFor(row.question_type),
      options: row.options ?? [],
    }));
  },

  async startAttempt(tx, assessmentId, learnerId) {
    // Only two columns are supplied. The attempt number, the status, the start
    // time and the entire result block are assigned by
    // `assessment_attempt_start_guard`, so there is nothing here for a caller
    // to influence even if this code were wrong.
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1, $2) RETURNING id`,
      [assessmentId, learnerId],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('Attempt insert returned no row');
    const saved = await readAttempt(tx, id);
    if (!saved) throw new Error('The created attempt is not readable by its owner');
    return saved;
  },

  async findAttempt(tx, id) {
    const { rows } = await tx.query<AttemptRow>(`${ATTEMPT_SELECT} WHERE t.id = $1`, [id]);
    const row = rows[0];
    if (!row) return null;
    return Guarded.of(toAttempt(row), toAttemptResource(row));
  },

  async recordAnswers(tx, attemptId, rows) {
    if (rows.length === 0) return;
    // Two parallel arrays rather than a built VALUES list: the option ids are
    // client-supplied, and they stay parameters all the way down.
    await tx.query(
      `INSERT INTO assessment_attempt_answers (attempt_id, question_id, option_id)
       SELECT $1, q, o FROM unnest($2::uuid[], $3::uuid[]) AS t(q, o)`,
      [attemptId, rows.map((r) => r[0]), rows.map((r) => r[1])],
    );
  },

  async submitAttempt(tx, attemptId) {
    // THE ENTIRE SUBMISSION STATEMENT. No score, no percentage, no pass flag,
    // no timestamp — the application does not compute a result and has nothing
    // to send. `assessment_attempt_submit_guard` derives every one of them from
    // `app_score_attempt`, which this role may not execute.
    await tx.query(`UPDATE assessment_attempts SET status = 'submitted' WHERE id = $1`, [
      attemptId,
    ]);
    const saved = await readAttempt(tx, attemptId);
    if (!saved) throw new Error('The submitted attempt is not readable by its owner');
    return saved;
  },

  async reviewFor(tx, attemptId) {
    // `app_attempt_review` re-checks BOTH the release and the readership itself
    // — it is granted to `edu_app`, so an id alone must buy nothing. The options
    // are joined here because the review needs their text to be legible, and
    // they are already readable by anyone who can see the assessment.
    const { rows } = await tx.query<{
      question_id: string;
      question_position: number;
      question_type: QuestionType;
      prompt: string;
      explanation: string;
      points: number;
      awarded: number;
      is_correct: boolean;
      selected_option_ids: string[];
      correct_option_ids: string[];
      options: Array<{ id: string; position: number; body: string }> | null;
    }>(
      `SELECT r.*,
              (
                SELECT json_agg(json_build_object('id', o.id, 'position', o.position, 'body', o.body)
                                ORDER BY o.position)
                  FROM assessment_options o WHERE o.question_id = r.question_id
              ) AS options
         FROM app_attempt_review($1) r
        ORDER BY r.question_position ASC`,
      [attemptId],
    );
    return rows.map((row) => ({
      questionId: row.question_id,
      position: row.question_position,
      questionType: row.question_type,
      prompt: row.prompt,
      points: row.points,
      awarded: row.awarded,
      isCorrect: row.is_correct,
      selectedOptionIds: row.selected_option_ids,
      correctOptionIds: row.correct_option_ids,
      explanation: row.explanation,
      options: row.options ?? [],
    }));
  },

  async releaseAttempt(tx, attemptId, comment) {
    // The ENTIRE release statement. `released_at` is overwritten by the trigger
    // with the server clock, so a caller cannot backdate one, and every other
    // column must be byte-identical or the trigger refuses the update outright.
    await tx.query(
      `UPDATE assessment_attempts
          SET released_at = now(), released_by = app_current_actor(), teacher_comment = $2
        WHERE id = $1`,
      [attemptId, comment],
    );
    const saved = await readAttempt(tx, attemptId);
    if (!saved) throw new Error('The released attempt is not readable');
    return saved;
  },

  async listAttemptsForLearner(tx, learnerId, query) {
    const column = resolveSortColumn(ATTEMPT_SORT, query.sort);
    const direction = resolveSortDirection(query.order);
    const { rows } = await tx.query<AttemptRow>(
      `${ATTEMPT_SELECT}
        WHERE t.user_id = $1
          AND ($4::uuid IS NULL OR t.assessment_id = $4)
          AND ($5::text IS NULL OR t.status = $5)
        ORDER BY ${column} ${direction} NULLS LAST, t.id ASC
        LIMIT $2 OFFSET $3`,
      [learnerId, query.limit, query.offset, query.assessmentId ?? null, query.status ?? null],
    );
    return rows.map((row) => Guarded.of(toAttempt(row), toAttemptResource(row)));
  },

  async listAttemptsForLearnerInClass(tx, learnerId, classId, query) {
    const column = resolveSortColumn(ATTEMPT_SORT, query.sort);
    const direction = resolveSortDirection(query.order);
    // Scoped in SQL to the courses assigned to THIS class, in addition to the
    // policy. That is what makes the teacher view precise: a teacher who also
    // teaches another class cannot reach this learner's attempts at an
    // assessment belonging only to that other class.
    const { rows } = await tx.query<AttemptRow>(
      `${ATTEMPT_SELECT}
        WHERE t.user_id = $1
          AND EXISTS (
            SELECT 1 FROM class_course_assignments ca
             WHERE ca.class_id = $4 AND ca.course_id = lb.course_id AND ca.status = 'active'
          )
          AND ($5::uuid IS NULL OR t.assessment_id = $5)
          AND ($6::text IS NULL OR t.status = $6)
        ORDER BY ${column} ${direction} NULLS LAST, t.id ASC
        LIMIT $2 OFFSET $3`,
      [
        learnerId,
        query.limit,
        query.offset,
        classId,
        query.assessmentId ?? null,
        query.status ?? null,
      ],
    );
    return rows.map((row) => Guarded.of(toAttempt(row), toAttemptResource(row)));
  },
};
