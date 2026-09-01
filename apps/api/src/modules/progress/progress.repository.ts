import { Guarded, type LessonProgressResource, type LessonProgressState } from '@edu/authz';
import {
  resolveSortColumn,
  resolveSortDirection,
  type ListProgressQuery,
  type ProgressStatus,
} from '@edu/contracts';
import type { Tx } from '../../platform/db.ts';

/**
 * Persistence for learner progress.
 *
 * THE ONE RULE THAT SHAPES EVERY QUERY HERE: nothing joins `lessons`.
 *
 * A learner removed from a class keeps their progress rows — that is the
 * retention rule — but they immediately stop being able to SEE the lesson,
 * because Task 006 narrowed content to what a class is currently assigned. A
 * join to `lessons` to fetch a title would therefore return zero rows and
 * silently erase the learner's own history from their own view. The same is
 * true for a verified guardian, who has no content access at all.
 *
 * So the names come from `app_lesson_label`, a SECURITY DEFINER helper, applied
 * as a LATERAL join. It discloses the lesson, unit and course NAMES to whoever
 * can already read the progress row, and nothing else — the body, objectives
 * and links stay behind the content policy.
 */

export interface ProgressRecord {
  readonly lessonId: string;
  readonly lessonTitle: string;
  readonly unitTitle: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly status: ProgressStatus;
  readonly completedAt: Date | null;
  readonly lastAccessedAt: Date;
  /**
   * The two authorization facts, carried for the policy and never serialized —
   * `progress.routes.ts` maps every field it returns through
   * `progressResponseSchema`, which does not include them.
   */
  readonly learnerId: string;
  readonly learnerOrganizationId: string | null;
}

interface ProgressRow {
  id: string;
  user_id: string;
  lesson_id: string;
  status: ProgressStatus;
  completed_at: Date | null;
  last_accessed_at: Date;
  lesson_title: string;
  unit_title: string;
  course_id: string;
  course_title: string;
  learner_organization_id: string | null;
  learner_may_study: boolean;
  observable_by_actor_as_teacher: boolean;
}

const toRecord = (row: ProgressRow): ProgressRecord => ({
  lessonId: row.lesson_id,
  lessonTitle: row.lesson_title,
  unitTitle: row.unit_title,
  courseId: row.course_id,
  courseTitle: row.course_title,
  status: row.status,
  completedAt: row.completed_at,
  lastAccessedAt: row.last_accessed_at,
  learnerId: row.user_id,
  learnerOrganizationId: row.learner_organization_id,
});

const toResource = (row: ProgressRow): LessonProgressResource => ({
  kind: 'lesson_progress',
  id: row.id,
  learnerId: row.user_id,
  learnerOrganizationId: row.learner_organization_id,
  lessonId: row.lesson_id,
  courseId: row.course_id,
  state: row.status as LessonProgressState,
  learnerMayStudy: row.learner_may_study,
  observableByActorAsTeacher: row.observable_by_actor_as_teacher,
});

/**
 * Every read carries the two facts the pure policy cannot derive, resolved in
 * the same statement as the row so the two can never disagree.
 *
 * `learner_may_study` is asked of the ROW'S SUBJECT via the definer helper,
 * which answers about the current actor — so it is meaningful only when the
 * actor IS the subject. That is exactly when it is consulted: writes. On a
 * third-party read the policy ignores it, which is the retention rule.
 */
const PROGRESS_SELECT = `SELECT p.id, p.user_id, p.lesson_id, p.status, p.completed_at,
              p.last_accessed_at,
              lb.lesson_title, lb.unit_title, lb.course_id, lb.course_title,
              app_user_organization(p.user_id) AS learner_organization_id,
              (p.user_id = app_current_actor() AND app_actor_may_study_lesson(p.lesson_id))
                AS learner_may_study,
              app_actor_observes_learner_lesson(p.user_id, p.lesson_id)
                AS observable_by_actor_as_teacher
         FROM lesson_progress p
         CROSS JOIN LATERAL app_lesson_label(p.lesson_id) lb`;

const PROGRESS_SORT = {
  lastAccessedAt: 'p.last_accessed_at',
  completedAt: 'p.completed_at',
  lessonTitle: 'lb.lesson_title',
} as const;

/**
 * What the policy needs about a lesson nobody has recorded progress on yet.
 *
 * Answered through the definer helpers rather than by selecting from `lessons`,
 * for the same reason the reads avoid that join: a learner who may study a
 * lesson can always see it, but resolving the course id and the label through
 * the helpers keeps this path identical to every other and removes a case where
 * a future visibility change would break a write.
 */
export interface LessonFacts {
  readonly exists: boolean;
  readonly courseId: string | null;
  readonly mayStudy: boolean;
}

/**
 * What the service needs to answer "may this actor look at that student's
 * progress in that class?" — the question behind
 * `GET /classes/:id/students/:studentId/progress`.
 *
 * All four come from definer helpers rather than from `classes` and
 * `class_memberships` directly, so this module reads no table another module
 * owns. Answering structurally also means a `404` for an absent class, a class
 * the actor has no standing in, and a student who is not in it are literally
 * the same answer.
 */
export interface ClassObservationFacts {
  readonly classExists: boolean;
  readonly classOrganizationId: string | null;
  readonly actorTeachesClass: boolean;
  readonly studentIsMember: boolean;
}

export interface ProgressRepository {
  lessonFacts(tx: Tx, lessonId: string): Promise<LessonFacts>;
  classObservation(tx: Tx, classId: string, studentId: string): Promise<ClassObservationFacts>;
  find(tx: Tx, learnerId: string, lessonId: string): Promise<Guarded<ProgressRecord> | null>;
  /** Upserts the row and returns it. The status transition is checked by the caller. */
  record(
    tx: Tx,
    learnerId: string,
    lessonId: string,
    status: ProgressStatus,
  ): Promise<ProgressRecord>;
  listForLearner(
    tx: Tx,
    learnerId: string,
    query: ListProgressQuery,
  ): Promise<Guarded<ProgressRecord>[]>;
  /** A learner's progress restricted to the courses assigned to ONE class. */
  listForLearnerInClass(
    tx: Tx,
    learnerId: string,
    classId: string,
    query: ListProgressQuery,
  ): Promise<Guarded<ProgressRecord>[]>;
  /**
   * Records that the learner engaged with a lesson, WITHOUT advancing status.
   *
   * Added in Task 008 so that submitting an assessment leaves a mark on the
   * lesson's progress row. It satisfies the `LessonEngagementRecorder`
   * interface the assessment module declares; the two modules never import each
   * other, they are joined in `app.ts` (dependency rules 3 and 4).
   *
   * WHAT IT CANNOT DO, and why the signature has no status parameter:
   *
   *   - It cannot mark a lesson COMPLETE. Passing an assessment is evidence
   *     about one paper on one day, and inferring completion from it is exactly
   *     the mastery reasoning the platform does not do. Completion is a claim
   *     only the learner may author.
   *   - It cannot move a status backwards, or forwards. An existing row has
   *     only its timestamps touched, so a learner who had already completed the
   *     lesson stays completed and the forward-only trigger has nothing to
   *     refuse.
   *   - It cannot write for anybody else: `user_id` is the parameter the caller
   *     takes from the session, and the RLS insert policy requires it to equal
   *     `app_current_actor()` regardless.
   */
  noteEngagement(tx: Tx, learnerId: string, lessonId: string): Promise<void>;
}

async function readOne(tx: Tx, id: string): Promise<ProgressRecord | null> {
  const { rows } = await tx.query<ProgressRow>(`${PROGRESS_SELECT} WHERE p.id = $1`, [id]);
  const row = rows[0];
  return row ? toRecord(row) : null;
}

export const progressRepository: ProgressRepository = {
  async lessonFacts(tx, lessonId) {
    const { rows } = await tx.query<{
      course_id: string | null;
      may_study: boolean;
    }>(`SELECT app_lesson_course($1) AS course_id, app_actor_may_study_lesson($1) AS may_study`, [
      lessonId,
    ]);
    const row = rows[0];
    if (!row) throw new Error('Fact query returned no row');
    return {
      // `app_lesson_course` answers NULL only when the lesson does not exist.
      exists: row.course_id !== null,
      courseId: row.course_id,
      mayStudy: row.may_study,
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

  async find(tx, learnerId, lessonId) {
    const { rows } = await tx.query<ProgressRow>(
      `${PROGRESS_SELECT} WHERE p.user_id = $1 AND p.lesson_id = $2`,
      [learnerId, lessonId],
    );
    const row = rows[0];
    if (!row) return null;
    return Guarded.of(toRecord(row), toResource(row));
  },

  async record(tx, learnerId, lessonId, status) {
    // ON CONFLICT makes this idempotent under a double-tap or a retry, and
    // atomic against two concurrent writes from the same learner.
    //
    // `completed_at` uses COALESCE so a completion timestamp is written ONCE and
    // never moved: re-sending `completed` keeps the original moment. The trigger
    // refuses any other attempt to change it.
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO lesson_progress (user_id, lesson_id, status, completed_at, last_accessed_at)
       VALUES ($1, $2, $3, CASE WHEN $3 = 'completed' THEN now() ELSE NULL END, now())
       ON CONFLICT (user_id, lesson_id) DO UPDATE
          SET status = EXCLUDED.status,
              completed_at = CASE
                WHEN EXCLUDED.status = 'completed'
                  THEN COALESCE(lesson_progress.completed_at, now())
                ELSE lesson_progress.completed_at
              END,
              last_accessed_at = now(),
              updated_at = now()
       RETURNING id`,
      [learnerId, lessonId, status],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('Upsert returned no row');
    // Read back in a SECOND statement: the LATERAL label join cannot see a row
    // the same statement is writing, and neither can the definer helpers. Same
    // reason as VULN-014.
    const saved = await readOne(tx, id);
    if (!saved) throw new Error('Recorded progress is not readable by its owner');
    return saved;
  },

  async listForLearner(tx, learnerId, query) {
    // Both come from exhaustive maps keyed by the schema's allow-list, never
    // from the request string.
    const column = resolveSortColumn(PROGRESS_SORT, query.sort);
    const direction = resolveSortDirection(query.order);
    const { rows } = await tx.query<ProgressRow>(
      `${PROGRESS_SELECT}
        WHERE p.user_id = $1
          AND ($4::text IS NULL OR p.status = $4)
          AND ($5::uuid IS NULL OR lb.course_id = $5)
        ORDER BY ${column} ${direction} NULLS LAST, p.lesson_id ASC
        LIMIT $2 OFFSET $3`,
      [learnerId, query.limit, query.offset, query.status ?? null, query.courseId ?? null],
    );
    return rows.map((row) => Guarded.of(toRecord(row), toResource(row)));
  },

  async noteEngagement(tx, learnerId, lessonId) {
    // `DO UPDATE ... SET last_accessed_at` rather than `DO NOTHING`, because a
    // returning learner's re-engagement is worth recording; and it touches no
    // status column, so `lesson_progress_guard` sees nothing to refuse even on
    // a row that is already `completed`.
    await tx.query(
      `INSERT INTO lesson_progress (user_id, lesson_id, status, last_accessed_at)
       VALUES ($1, $2, 'in_progress', now())
       ON CONFLICT (user_id, lesson_id) DO UPDATE
          SET last_accessed_at = now(), updated_at = now()`,
      [learnerId, lessonId],
    );
  },

  async listForLearnerInClass(tx, learnerId, classId, query) {
    const column = resolveSortColumn(PROGRESS_SORT, query.sort);
    const direction = resolveSortDirection(query.order);
    // Scoped to the courses assigned to THIS class, in SQL, in addition to the
    // policy. That is what makes the teacher view precise: a teacher who also
    // teaches another class cannot reach this learner's progress on a course
    // assigned only to that other class.
    //
    // `EXISTS` rather than a join, so a course assigned twice cannot duplicate
    // a progress row.
    const { rows } = await tx.query<ProgressRow>(
      `${PROGRESS_SELECT}
        WHERE p.user_id = $1
          AND EXISTS (
            SELECT 1 FROM class_course_assignments a
             WHERE a.class_id = $4 AND a.course_id = lb.course_id AND a.status = 'active'
          )
          AND ($5::text IS NULL OR p.status = $5)
          AND ($6::uuid IS NULL OR lb.course_id = $6)
        ORDER BY ${column} ${direction} NULLS LAST, p.lesson_id ASC
        LIMIT $2 OFFSET $3`,
      [learnerId, query.limit, query.offset, classId, query.status ?? null, query.courseId ?? null],
    );
    return rows.map((row) => Guarded.of(toRecord(row), toResource(row)));
  },
};
