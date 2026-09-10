import { Guarded, type AnalyticsReportResource } from '@edu/authz';
import type {
  AtRiskQuery,
  CoursePerformanceQuery,
  SchoolOverviewQuery,
} from '@edu/contracts';
import type { Tx } from '../../platform/db.ts';

/**
 * Reading the analytics tables.
 *
 * ---------------------------------------------------------------------------
 * EVERY QUERY CARRIES ITS OWN TENANT PREDICATE AS WELL AS RELYING ON RLS
 * ---------------------------------------------------------------------------
 *
 * This is VULN-056's lesson applied before it can happen again. In Task 013 the
 * public portfolio resolver carried no `WHERE` clause at all and let RLS match
 * the key; the reasoning was that two places deciding one thing is how they
 * come to disagree. Against a role with `BYPASSRLS` it returned any portfolio
 * to anybody.
 *
 * So every statement below says `organization_id = app_actor_organization()`
 * itself, in addition to the identical predicate in the RLS policy. It is the
 * SAME predicate from the SAME source — the session actor, resolved by the same
 * SQL helper — so the two cannot drift into disagreement; and if RLS were
 * dropped tomorrow these queries would still be bounded to one school.
 *
 * `app_actor_organization()` IS CALLED RATHER THAN PASSED. There is no
 * `$1 = organizationId` anywhere in this file, so no caller can point one of
 * these queries at a different school by handing it an argument. Section 2B
 * asks for a tenant "derived directly from the authenticated user's auth
 * context"; a function call to the session's own organization is that,
 * structurally, rather than a value somebody remembered to check.
 */

export interface DailyMetricRow {
  metric_date: string;
  total_active_students: number;
  total_active_teachers: number;
  lessons_completed: number;
  quizzes_attempted: number;
  average_mastery_score: string | null;
  ai_tutor_sessions: number;
  updated_at: Date;
}

export interface CoursePerformanceRowRaw {
  class_id: string;
  class_name: string;
  course_id: string;
  course_title: string;
  enrollment_count: number;
  completion_rate_pct: string;
  avg_quiz_score: string | null;
  flagged_struggling_students_count: number;
  updated_at: Date;
}

export interface AtRiskRowRaw {
  class_id: string;
  course_id: string;
  student_id: string;
  display_name: string;
  mastery_index: string;
  objectives_with_evidence: number;
}

/**
 * The two facts the policy needs, resolved together in one round trip.
 *
 * RESOLVED TOGETHER IS THE WHOLE POINT. `app_actor_is_org_admin()` answers only
 * "does this actor hold the admin role", anywhere, for anyone — that is the
 * established shape on this platform (0014) and it is safe only because every
 * caller pairs it with the tenant equality. Pairing them HERE, in the one place
 * that builds the resource, means the policy is never handed a bare "is an
 * admin" it could apply to the wrong school.
 *
 * A separate `actorIsOrgAdmin()` helper returning the unpaired boolean would be
 * a loaded gun on the shelf. There isn't one.
 */
export interface AnalyticsRepository {
  schoolResource(tx: Tx): Promise<AnalyticsReportResource>;
  classResource(tx: Tx, classId: string): Promise<AnalyticsReportResource>;
  dailyMetrics(tx: Tx, query: SchoolOverviewQuery): Promise<DailyMetricRow[]>;
  coursePerformance(
    tx: Tx,
    query: CoursePerformanceQuery,
  ): Promise<Guarded<CoursePerformanceRowRaw>[]>;
  atRisk(tx: Tx, query: AtRiskQuery): Promise<AtRiskRowRaw[]>;
}

export const analyticsRepository: AnalyticsRepository = {
  async schoolResource(tx) {
    const { rows } = await tx.query<{ organization_id: string | null; is_admin: boolean }>(
      `SELECT app_actor_organization() AS organization_id,
              (app_actor_is_org_admin() AND app_actor_organization() IS NOT NULL) AS is_admin`,
    );
    const row = rows[0];
    return {
      kind: 'analytics_report',
      // A synthetic descriptor, not a row key — see the resource's declaration.
      id: `school:${row?.organization_id ?? 'none'}`,
      grain: 'school',
      organizationId: row?.organization_id ?? null,
      classId: null,
      actorIsOrgAdmin: row?.is_admin === true,
      // A school-wide report has no class, and a teacher has no claim on it.
      actorTeachesClass: null,
    };
  },

  async classResource(tx, classId) {
    const { rows } = await tx.query<{
      organization_id: string | null;
      is_admin: boolean;
      teaches: boolean;
    }>(
      `SELECT app_actor_organization() AS organization_id,
              (app_actor_is_org_admin()
                 AND app_actor_organization() IS NOT NULL
                 AND app_class_organization($1) = app_actor_organization()) AS is_admin,
              app_actor_teaches_class($1) AS teaches`,
      [classId],
    );
    const row = rows[0];
    return {
      kind: 'analytics_report',
      id: `class:${classId}`,
      grain: 'class',
      organizationId: row?.organization_id ?? null,
      classId,
      // NOTE THE THIRD CONJUNCT, absent from `schoolResource` because there is
      // no class there: an administrator is an administrator OF THIS CLASS'S
      // SCHOOL, not of any school. Without it, an admin of school A asking
      // about a class in school B would be told they administer it — and the
      // only thing left refusing them would be RLS.
      actorIsOrgAdmin: row?.is_admin === true,
      actorTeachesClass: row?.teaches === true,
    };
  },

  async dailyMetrics(tx, query) {
    const { rows } = await tx.query<DailyMetricRow>(
      `SELECT metric_date::text AS metric_date,
              total_active_students, total_active_teachers,
              lessons_completed, quizzes_attempted,
              average_mastery_score::text AS average_mastery_score,
              ai_tutor_sessions, updated_at
         FROM analytics_daily_school_metrics
        WHERE organization_id = app_actor_organization()
          AND app_actor_organization() IS NOT NULL
          AND metric_date > (CURRENT_DATE - $1::integer)
        ORDER BY metric_date DESC`,
      [query.days],
    );
    return rows;
  },

  async coursePerformance(tx, query) {
    /**
     * The join to `classes` and `courses` is for NAMES, and it is worth saying
     * why that is safe here when the same shape has bitten this platform three
     * times (VULN-054, VULN-055, and the rule enforced in Task 014).
     *
     * A join added to fetch a display value is an access predicate whether or
     * not anybody meant it as one: if the joined table's RLS hides a row, the
     * outer row disappears too. That was fatal on the public portfolio path,
     * which runs with NO ACTOR, so `users` admitted nothing.
     *
     * Here every caller is staff of this school, and `classes_select` and
     * `courses_select` already admit exactly the classes and courses such a
     * caller can see. The join can therefore only ever narrow to the same set
     * the analytics policy would allow — and the tenant predicate below does
     * not depend on it. `tests/integration/rls-analytics.test.ts` asserts a row
     * survives the join for both an administrator and a teacher, so a future
     * narrowing of `courses_select` fails loudly rather than silently emptying
     * the dashboard.
     */
    const { rows } = await tx.query<CoursePerformanceRowRaw>(
      `SELECT p.class_id, c.name AS class_name,
              p.course_id, co.title AS course_title,
              p.enrollment_count,
              p.completion_rate_pct::text AS completion_rate_pct,
              p.avg_quiz_score::text AS avg_quiz_score,
              p.flagged_struggling_students_count,
              p.updated_at
         FROM analytics_course_performance p
         JOIN classes c ON c.id = p.class_id
         JOIN courses co ON co.id = p.course_id
        WHERE p.organization_id = app_actor_organization()
          AND app_actor_organization() IS NOT NULL
          AND ($3::uuid IS NULL OR p.class_id = $3)
        ORDER BY c.name ASC, co.title ASC, p.class_id, p.course_id
        LIMIT $1 OFFSET $2`,
      [query.limit, query.offset, query.classId ?? null],
    );
    return rows.map((row) =>
      Guarded.of(row, {
        kind: 'analytics_report',
        id: `class:${row.class_id}:course:${row.course_id}`,
        grain: 'class',
        organizationId: null,
        classId: row.class_id,
        // Rows reaching here already passed the tenant predicate AND RLS, so
        // the administrator disjunct is satisfied by construction. The policy
        // re-derives the teacher disjunct per row.
        actorIsOrgAdmin: true,
        actorTeachesClass: null,
      } satisfies AnalyticsReportResource),
    );
  },

  async atRisk(tx, query) {
    /**
     * NO TENANT PREDICATE HERE, AND THAT IS NOT AN OMISSION.
     *
     * `app_analytics_at_risk` takes its authorization INSIDE the function: it
     * starts from `app_actor_teaches_class(...)`, so it can only ever return
     * learners in classes the calling actor actively teaches. There is no
     * unbounded form of it to bound — a tenant filter on top would be filtering
     * a set that is already narrower than one school.
     *
     * The reason this differs from the two queries above is that those read
     * TABLES, which have rows for every school and need a predicate to pick
     * one. This reads a FUNCTION whose first CTE is the predicate.
     */
    const { rows } = await tx.query<AtRiskRowRaw>(
      `SELECT class_id, course_id, student_id, display_name,
              mastery_index::text AS mastery_index, objectives_with_evidence
         FROM app_analytics_at_risk($1::numeric)
        LIMIT $2`,
      [query.threshold, query.limit],
    );
    return rows;
  },
};
