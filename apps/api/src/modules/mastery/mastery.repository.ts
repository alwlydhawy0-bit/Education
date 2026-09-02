import { Guarded, type ObjectiveProgressResource } from '@edu/authz';
import type { EvidenceType, MasteryState } from '@edu/contracts';
import type { Tx } from '../../platform/db.ts';

/**
 * Reads for objectives, evidence and mastery.
 *
 * THERE ARE NO WRITES IN THIS FILE, and there cannot be: `edu_app` holds only
 * SELECT on `objective_evidence` (migration 0021), so a write method here would
 * fail at the database with `permission denied` rather than doing anything.
 * Evidence is emitted by triggers on educational events that already happened.
 *
 * EVERY MASTERY STATE COMES FROM `app_objective_mastery`. There is no TypeScript
 * implementation of the rules and there must not be one: a second answer to
 * "what does this child understand?" would eventually disagree with the first,
 * about a real learner, in a way nobody would notice until a teacher acted on
 * it. Same reasoning as the scorer in 0019.
 */
export interface ObjectiveMasteryRecord {
  readonly objectiveId: string;
  readonly statement: string;
  readonly position: number;
  readonly lessonId: string;
  readonly lessonTitle: string;
  readonly unitId: string;
  readonly unitTitle: string;
  readonly unitPosition: number;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly mastery: MasteryState;
  readonly evidenceCount: number;
  readonly lastEvidenceAt: Date | null;
  readonly lessonStatus: 'not_started' | 'in_progress' | 'completed';
  /** Carried for the policy, never serialized. */
  readonly learnerId: string;
  readonly learnerOrganizationId: string | null;
  readonly observableByActorAsTeacher: boolean;
}

export interface EvidenceRecord {
  readonly objectiveId: string;
  readonly evidenceType: EvidenceType;
  readonly sourceKind: 'lesson_progress' | 'assessment_attempt';
  readonly occurredAt: Date;
  readonly learnerId: string;
  readonly learnerOrganizationId: string | null;
  readonly lessonId: string;
  readonly observableByActorAsTeacher: boolean;
}

export interface ClassObservationFacts {
  readonly classExists: boolean;
  readonly classOrganizationId: string | null;
  readonly actorTeachesClass: boolean;
  readonly studentIsMember: boolean;
}

interface MasteryRow {
  objective_id: string;
  statement: string;
  position: number;
  lesson_id: string;
  lesson_title: string;
  unit_id: string;
  unit_title: string;
  unit_position: number;
  course_id: string;
  course_title: string;
  mastery: MasteryState;
  evidence_count: string;
  last_evidence_at: Date | null;
  lesson_status: 'not_started' | 'in_progress' | 'completed';
  learner_organization_id: string | null;
  observable_by_actor_as_teacher: boolean;
}

/**
 * ONE STATEMENT FOR A WHOLE COURSE.
 *
 * The obvious shape — fetch objectives, then call `app_objective_mastery` per
 * row — is an N+1 against a function that itself queries two tables. A course
 * with fifteen lessons and sixty objectives would issue sixty-one round trips
 * to answer one page load. The lateral join keeps it to one, and the mastery
 * rule still lives in exactly one place: the function is called from SQL rather
 * than re-implemented here.
 *
 * `evidence_count` and `last_evidence_at` are computed with the SAME visibility
 * filter the function applies, so a learner is never told "3 pieces of evidence"
 * about a state derived from one. The filter is the Task 009 expression, for
 * the third time in this codebase — see the note in `app_objective_mastery`.
 */
const MASTERY_SELECT = `
  SELECT o.id AS objective_id, o.statement, o.position,
         l.id AS lesson_id, l.title AS lesson_title,
         u.id AS unit_id, u.title AS unit_title, u.position AS unit_position,
         c.id AS course_id, c.title AS course_title,
         app_objective_mastery($1, o.id) AS mastery,
         COALESCE(ev.n, 0) AS evidence_count,
         ev.last_at AS last_evidence_at,
         COALESCE(lp.status, 'not_started') AS lesson_status,
         app_user_organization($1) AS learner_organization_id,
         app_actor_observes_learner_lesson($1, l.id) AS observable_by_actor_as_teacher
    FROM learning_objectives o
    JOIN lessons l      ON l.id = o.lesson_id
    JOIN course_units u ON u.id = l.unit_id
    JOIN courses c      ON c.id = u.course_id
    LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1
    LEFT JOIN LATERAL (
      SELECT count(*) AS n, max(e.occurred_at) AS last_at
        FROM objective_evidence e
        LEFT JOIN assessment_attempts t
          ON e.source_kind = 'assessment_attempt' AND t.id = e.source_id
       WHERE e.user_id = $1
         AND e.objective_id = o.id
         AND (
           e.source_kind <> 'assessment_attempt'
           OR t.released_at IS NOT NULL
           OR NOT (e.user_id = app_current_actor() OR app_actor_guards(e.user_id))
         )
    ) ev ON true`;

const toMastery = (row: MasteryRow, learnerId: string): ObjectiveMasteryRecord => ({
  objectiveId: row.objective_id,
  statement: row.statement,
  position: row.position,
  lessonId: row.lesson_id,
  lessonTitle: row.lesson_title,
  unitId: row.unit_id,
  unitTitle: row.unit_title,
  unitPosition: row.unit_position,
  courseId: row.course_id,
  courseTitle: row.course_title,
  mastery: row.mastery,
  evidenceCount: Number(row.evidence_count),
  lastEvidenceAt: row.last_evidence_at,
  lessonStatus: row.lesson_status,
  learnerId,
  learnerOrganizationId: row.learner_organization_id,
  observableByActorAsTeacher: row.observable_by_actor_as_teacher,
});

const toResource = (r: ObjectiveMasteryRecord): ObjectiveProgressResource => ({
  kind: 'objective_progress',
  id: `${r.learnerId}:${r.objectiveId}`,
  learnerId: r.learnerId,
  learnerOrganizationId: r.learnerOrganizationId,
  objectiveId: r.objectiveId,
  lessonId: r.lessonId,
  observableByActorAsTeacher: r.observableByActorAsTeacher,
});

export interface MasteryRepository {
  classObservation(tx: Tx, classId: string, studentId: string): Promise<ClassObservationFacts>;
  courseExists(tx: Tx, courseId: string): Promise<boolean>;
  masteryForCourse(
    tx: Tx,
    learnerId: string,
    courseId: string,
  ): Promise<Guarded<ObjectiveMasteryRecord>[]>;
  masteryForLearner(tx: Tx, learnerId: string): Promise<Guarded<ObjectiveMasteryRecord>[]>;
  evidenceForObjective(
    tx: Tx,
    learnerId: string,
    objectiveId: string,
  ): Promise<Guarded<EvidenceRecord>[]>;
}

export const masteryRepository: MasteryRepository = {
  async classObservation(tx, classId, studentId) {
    const { rows } = await tx.query<{
      class_exists: boolean;
      class_organization_id: string | null;
      actor_teaches: boolean;
      student_is_member: boolean;
    }>(
      `SELECT app_class_organization_of($1) IS NOT NULL AS class_exists,
              app_class_organization_of($1) AS class_organization_id,
              app_actor_teaches_class($1) AS actor_teaches,
              app_user_is_member_of_class($2, $1) AS student_is_member`,
      [classId, studentId],
    );
    const row = rows[0];
    return {
      classExists: row?.class_exists ?? false,
      classOrganizationId: row?.class_organization_id ?? null,
      actorTeachesClass: row?.actor_teaches ?? false,
      studentIsMember: row?.student_is_member ?? false,
    };
  },

  async courseExists(tx, courseId) {
    // Through the definer helper, so "does it exist" and "may I see it" stay
    // separate questions — the policy answers the second.
    const { rows } = await tx.query<{ present: boolean }>(
      `SELECT app_course_status($1) IS NOT NULL AS present`,
      [courseId],
    );
    return rows[0]?.present ?? false;
  },

  async masteryForCourse(tx, learnerId, courseId) {
    const { rows } = await tx.query<MasteryRow>(
      `${MASTERY_SELECT} WHERE c.id = $2 ORDER BY u.position, l.position, o.position`,
      [learnerId, courseId],
    );
    return rows
      .map((row) => toMastery(row, learnerId))
      .map((record) => Guarded.of(record, toResource(record)));
  },

  async masteryForLearner(tx, learnerId) {
    // DRIVEN OFF THE EVIDENCE, and labelled through a definer — not joined to
    // the content tree like `masteryForCourse` above.
    //
    // The difference is the retention rule. A verified guardian has NO content
    // access at all, and a learner who leaves a class loses theirs, so a join to
    // `lessons`/`course_units`/`courses` returns zero rows for exactly the two
    // readers this endpoint exists to serve. A guardian would be told their
    // child had demonstrated nothing. `app_objective_label` (0021) is the same
    // answer `app_lesson_label` gave in 0018, one level down, and it discloses
    // names rather than content.
    //
    // A COURSE view still joins, because enumerating every objective of a course
    // legitimately requires seeing the course. The retained record is this
    // endpoint; the catalogue walk is the other one.
    const { rows } = await tx.query<MasteryRow>(
      `SELECT e.objective_id,
              lbl.statement, lbl.objective_position AS position,
              lbl.lesson_id, lbl.lesson_title,
              lbl.unit_id, lbl.unit_title, lbl.unit_position,
              lbl.course_id, lbl.course_title,
              app_objective_mastery($1, e.objective_id) AS mastery,
              count(*) FILTER (WHERE e.countable) AS evidence_count,
              max(e.occurred_at) FILTER (WHERE e.countable) AS last_evidence_at,
              COALESCE(lp.status, 'not_started') AS lesson_status,
              app_user_organization($1) AS learner_organization_id,
              app_actor_observes_learner_lesson($1, lbl.lesson_id)
                AS observable_by_actor_as_teacher
         FROM (
           SELECT ev.objective_id, ev.occurred_at,
                  (
                    ev.source_kind <> 'assessment_attempt'
                    OR t.released_at IS NOT NULL
                    OR NOT (ev.user_id = app_current_actor() OR app_actor_guards(ev.user_id))
                  ) AS countable
             FROM objective_evidence ev
             LEFT JOIN assessment_attempts t
               ON ev.source_kind = 'assessment_attempt' AND t.id = ev.source_id
            WHERE ev.user_id = $1
         ) e
         CROSS JOIN LATERAL app_objective_label(e.objective_id) lbl
         LEFT JOIN lesson_progress lp ON lp.lesson_id = lbl.lesson_id AND lp.user_id = $1
        GROUP BY e.objective_id, lbl.statement, lbl.objective_position, lbl.lesson_id,
                 lbl.lesson_title, lbl.unit_id, lbl.unit_title, lbl.unit_position,
                 lbl.course_id, lbl.course_title, lp.status
        ORDER BY lbl.course_title, lbl.unit_position, lbl.lesson_title, lbl.objective_position`,
      [learnerId],
    );
    return rows
      .map((row) => toMastery(row, learnerId))
      .map((record) => Guarded.of(record, toResource(record)));
  },

  async evidenceForObjective(tx, learnerId, objectiveId) {
    // No score column is selected, and none exists to select: the evidence table
    // holds the event, not the mark. A percentage here would be a second door to
    // a result Task 009 may still be withholding.
    const { rows } = await tx.query<{
      objective_id: string;
      evidence_type: EvidenceType;
      source_kind: 'lesson_progress' | 'assessment_attempt';
      occurred_at: Date;
      lesson_id: string;
      learner_organization_id: string | null;
      observable_by_actor_as_teacher: boolean;
    }>(
      `SELECT e.objective_id, e.evidence_type, e.source_kind, e.occurred_at,
              o.lesson_id,
              app_user_organization(e.user_id) AS learner_organization_id,
              app_actor_observes_learner_lesson(e.user_id, o.lesson_id)
                AS observable_by_actor_as_teacher
         FROM objective_evidence e
         JOIN learning_objectives o ON o.id = e.objective_id
        WHERE e.user_id = $1 AND e.objective_id = $2
          AND (
            e.source_kind <> 'assessment_attempt'
            OR EXISTS (
              SELECT 1 FROM assessment_attempts t
               WHERE t.id = e.source_id AND t.released_at IS NOT NULL
            )
            OR NOT (e.user_id = app_current_actor() OR app_actor_guards(e.user_id))
          )
        ORDER BY e.occurred_at`,
      [learnerId, objectiveId],
    );
    return rows.map((row) =>
      Guarded.of<EvidenceRecord>(
        {
          objectiveId: row.objective_id,
          evidenceType: row.evidence_type,
          sourceKind: row.source_kind,
          occurredAt: row.occurred_at,
          learnerId,
          learnerOrganizationId: row.learner_organization_id,
          lessonId: row.lesson_id,
          observableByActorAsTeacher: row.observable_by_actor_as_teacher,
        },
        {
          kind: 'objective_progress',
          id: `${learnerId}:${row.objective_id}`,
          learnerId,
          learnerOrganizationId: row.learner_organization_id,
          objectiveId: row.objective_id,
          lessonId: row.lesson_id,
          observableByActorAsTeacher: row.observable_by_actor_as_teacher,
        },
      ),
    );
  },
};
