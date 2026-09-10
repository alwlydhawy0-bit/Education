import { forbidden, notFound } from '@edu/kernel';
import type {
  Action,
  Actor,
  AnalyticsReportResource,
  AuthorizationContext,
  PolicyEngine,
  RelationshipSnapshot,
} from '@edu/authz';
import { SecurityEventType } from '@edu/observability';
import type {
  AtRiskQuery,
  AtRiskStudent,
  CoursePerformanceQuery,
  CoursePerformanceRow,
  DailySchoolMetric,
  ExportQuery,
  SchoolOverviewQuery,
} from '@edu/contracts';
import type { Database } from '../../platform/db.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import { csvFilename, toCsv } from './csv-safety.ts';
import type { AnalyticsRepository } from './analytics.repository.ts';

export interface ActorContext {
  readonly actor: Actor;
  readonly loadRelationships: () => Promise<RelationshipSnapshot>;
  readonly correlationId: string;
  readonly ip: string | null;
}

export interface AnalyticsServiceDeps {
  readonly db: Database;
  readonly repository: AnalyticsRepository;
  readonly engine: PolicyEngine;
  readonly securityEvents: SecurityEventRecorder;
}

export interface SchoolOverview {
  readonly days: DailySchoolMetric[];
  readonly totals: {
    readonly activeStudentsPeak: number;
    readonly lessonsCompleted: number;
    readonly quizzesAttempted: number;
    readonly aiTutorSessions: number;
    readonly masteryIndex: number | null;
  };
}

export interface ExportedFile {
  readonly filename: string;
  readonly contentType: string;
  readonly body: string;
}

/**
 * The most rows an export will produce.
 *
 * BOUNDED, because an export is the one endpoint whose natural request is "all
 * of it" and whose output is assembled entirely in memory before a byte is
 * sent. A school with a thousand class-course pairs would otherwise build a
 * thousand-row string in a request handler.
 */
const EXPORT_ROW_CAP = 200;

export interface AnalyticsService {
  schoolOverview(ctx: ActorContext, query: SchoolOverviewQuery): Promise<SchoolOverview>;
  coursePerformance(
    ctx: ActorContext,
    query: CoursePerformanceQuery,
  ): Promise<CoursePerformanceRow[]>;
  atRisk(ctx: ActorContext, query: AtRiskQuery): Promise<AtRiskStudent[]>;
  exportReport(ctx: ActorContext, query: ExportQuery): Promise<ExportedFile>;
}

/**
 * Institutional analytics.
 *
 * ---------------------------------------------------------------------------
 * THE DECISION IS TAKEN BEFORE THE QUERY, NOT AFTER IT
 * ---------------------------------------------------------------------------
 *
 * Most services on this platform read a row, build a resource from it, and
 * decide. That order is right when the resource IS the row — the row carries
 * its owner, and you cannot ask about an owner you have not read.
 *
 * It is the wrong order here. An analytics report is an aggregate, so "read it
 * then decide" would mean computing a school's numbers and then deciding
 * whether the caller was allowed to have them. The numbers would exist, in
 * memory, in a process handling a request from somebody with no right to them —
 * one careless `return` away from being sent.
 *
 * So the resource is built FIRST, from the actor's own facts
 * (`app_actor_organization`, `app_actor_is_org_admin`, `app_actor_teaches_class`),
 * the policy decides on that, and the aggregate is never computed for a caller
 * who was going to be refused.
 *
 * The database still refuses independently — RLS on both tables, plus each
 * query's own tenant predicate — so this is the first of three gates, not the
 * only one.
 */
export function createAnalyticsService(deps: AnalyticsServiceDeps): AnalyticsService {
  const { db, repository, engine, securityEvents } = deps;

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
   * Decides, records a denial, and translates the disclosure into an HTTP shape.
   *
   * A DENIAL IS RECORDED WITH THE RULE NAME AND NO NUMBERS. Somebody probing
   * for another school's dashboard should leave a trace; the trace should not
   * contain the school's figures.
   */
  async function decide(
    ctx: ActorContext,
    action: Action,
    resource: AnalyticsReportResource,
  ): Promise<void> {
    const authContext: AuthorizationContext = {
      actor: ctx.actor,
      relationships: await ctx.loadRelationships(),
    };
    const decision = engine.decide(authContext, action, resource);
    if (decision.effect === 'allow') return;

    await emit(ctx, SecurityEventType.AUTHZ_DENIED, {
      action,
      resourceKind: resource.kind,
      resourceId: resource.id,
      reason: decision.reason,
    });
    if (decision.disclosure === 'reveal') throw forbidden(explain(decision.reason));
    throw notFound();
  }

  /**
   * Turns a policy reason into something a colleague can act on.
   *
   * ONLY FOR `reveal` DENIALS, so it can never disclose what a `hide` denial is
   * concealing. Both messages here name the RIGHT PERSON to ask rather than
   * just saying no — a teacher told "this is an administrator's report" knows
   * what to do next, and a head teacher told the named list belongs to teachers
   * knows the list exists and who holds it.
   */
  function explain(reason: string): string {
    if (reason.endsWith('.not_an_administrator')) {
      return 'School-wide analytics are available to school administrators';
    }
    if (reason.endsWith('.at_risk_is_for_teachers')) {
      return 'Named at-risk lists are available to the teachers of each class';
    }
    return 'Forbidden';
  }

  const asNumber = (value: string | null): number | null =>
    value === null ? null : Number(value);

  /**
   * The second gate over the course-performance list.
   *
   * RLS AND THE TENANT PREDICATE HAVE ALREADY FILTERED THESE ROWS, and running
   * the policy again over them is the same discipline the community feed uses:
   * a list that contains rows about OTHER PEOPLE'S classes by construction is
   * exactly where a single gate is least affordable.
   *
   * A row the policy declines is dropped rather than raising. An administrator
   * opening their dashboard is not probing, and a 403 on one row of a list is
   * not something a page can do anything with.
   *
   * ONE HELPER, TWO CALLERS — the read endpoint and the export — so the export
   * cannot come to admit a row the read would refuse.
   */
  async function admitCourseRows(
    ctx: ActorContext,
    tx: Parameters<AnalyticsRepository['coursePerformance']>[0],
    query: CoursePerformanceQuery,
  ): Promise<CoursePerformanceRow[]> {
    const authContext: AuthorizationContext = {
      actor: ctx.actor,
      relationships: await ctx.loadRelationships(),
    };
    const action: Action = 'analytics_report:read_courses';
    const guarded = await repository.coursePerformance(tx, query);

    const admitted: CoursePerformanceRow[] = [];
    for (const candidate of guarded) {
      const decision = engine.decide(authContext, action, candidate.resource);
      if (decision.effect !== 'allow') continue;
      const row = candidate.unwrap(decision, action);
      admitted.push({
        classId: row.class_id,
        className: row.class_name,
        courseId: row.course_id,
        courseTitle: row.course_title,
        enrollmentCount: row.enrollment_count,
        completionRatePct: Number(row.completion_rate_pct),
        avgQuizScore: asNumber(row.avg_quiz_score),
        flaggedStrugglingStudentsCount: row.flagged_struggling_students_count,
        updatedAt: row.updated_at.toISOString(),
      });
    }
    return admitted;
  }

  return {
    async schoolOverview(ctx, query) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const resource = await repository.schoolResource(tx);
        await decide(ctx, 'analytics_report:read_school', resource);

        const rows = await repository.dailyMetrics(tx, query);
        const days: DailySchoolMetric[] = rows.map((row) => ({
          metricDate: row.metric_date,
          totalActiveStudents: row.total_active_students,
          totalActiveTeachers: row.total_active_teachers,
          lessonsCompleted: row.lessons_completed,
          quizzesAttempted: row.quizzes_attempted,
          averageMasteryScore: asNumber(row.average_mastery_score),
          aiTutorSessions: row.ai_tutor_sessions,
          updatedAt: row.updated_at.toISOString(),
        }));

        await emit(ctx, SecurityEventType.ANALYTICS_REPORT_READ, {
          grain: 'school',
          days: days.length,
        });

        return { days, totals: summarize(days) };
      });
    },

    async coursePerformance(ctx, query) {
      return db.withActor(ctx.actor.id, async (tx) => {
        /**
         * THE DECISION DEPENDS ON WHETHER A CLASS WAS NAMED.
         *
         * With `classId`, the caller is asking about ONE class and the resource
         * is that class — so an administrator of another school, or a teacher
         * who does not teach it, is refused with 404 before any row is read.
         *
         * Without it, they are asking for their own authorized list, and the
         * resource is the school. RLS and the tenant predicate then bound the
         * rows; a teacher's list contains only classes they teach because
         * `analytics_course_performance_select` says so.
         */
        const resource = query.classId
          ? await repository.classResource(tx, query.classId)
          : await repository.schoolResource(tx);

        // NAMING A CLASS IS AUTHORIZED UP FRONT; asking for your own list is
        // not, because there is nothing yet to be refused about. An unnamed
        // request returns whatever both gates admit, which for a teacher is the
        // classes they teach and for an administrator is their school — and
        // refusing it outright would mean a teacher could never open the page.
        if (query.classId) {
          await decide(ctx, 'analytics_report:read_courses', resource);
        }

        const items = await admitCourseRows(ctx, tx, query);
        await emit(ctx, SecurityEventType.ANALYTICS_REPORT_READ, {
          grain: 'class',
          rows: items.length,
        });
        return items;
      });
    },

    async atRisk(ctx, query) {
      return db.withActor(ctx.actor.id, async (tx) => {
        /**
         * THE RESOURCE IS BUILT SO THAT AN ADMINISTRATOR IS REFUSED.
         *
         * `at_risk` has no class parameter — a teacher does not name the classes
         * they teach — so the resource is the school, with `actorTeachesClass`
         * resolved as "does this actor teach ANY class here". That is what lets
         * the policy tell an administrator (who teaches none) from a teacher.
         *
         * The function underneath refuses independently: `app_analytics_at_risk`
         * starts from `app_actor_teaches_class`, so an administrator who somehow
         * reached it would still get an empty set. Two gates, and the policy is
         * the one that can explain itself.
         */
        const resource = await repository.schoolResource(tx);
        const { rows: teaches } = await tx.query<{ any_class: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM teacher_assignments ta
              JOIN classes c ON c.id = ta.class_id
             WHERE ta.teacher_id = app_current_actor()
               AND ta.status = 'active' AND c.status = 'active') AS any_class`,
        );
        await decide(ctx, 'analytics_report:at_risk', {
          ...resource,
          grain: 'class',
          actorTeachesClass: teaches[0]?.any_class === true,
        });

        const found = await repository.atRisk(tx, query);
        await emit(ctx, SecurityEventType.ANALYTICS_REPORT_READ, {
          grain: 'at_risk',
          rows: found.length,
          threshold: query.threshold,
        });

        return found.map((row) => ({
          studentId: row.student_id,
          displayName: row.display_name,
          classId: row.class_id,
          courseId: row.course_id,
          masteryIndex: Number(row.mastery_index),
          objectivesWithEvidence: row.objectives_with_evidence,
        }));
      });
    },

    async exportReport(ctx, query) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const resource = await repository.schoolResource(tx);
        await decide(ctx, 'analytics_report:export', {
          ...resource,
          grain: query.dataset === 'school_overview' ? 'school' : 'class',
        });

        const { headers, rows, stem } = await gatherExport(ctx, tx, query);

        await emit(ctx, SecurityEventType.ANALYTICS_EXPORTED, {
          dataset: query.dataset,
          format: query.format,
          rows: rows.length,
        });

        if (query.format === 'json') {
          return {
            filename: `${stem}.json`,
            contentType: 'application/json; charset=utf-8',
            // A JSON export needs no formula neutralization — nothing parses a
            // JSON string as an expression — but it needs the same authorization
            // and the same audit event, which is why it shares this path.
            body: JSON.stringify({
              headers,
              rows: rows.map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i]]))),
            }),
          };
        }

        return {
          filename: csvFilename(stem),
          // `text/csv` with an explicit charset, and the route adds
          // `Content-Disposition: attachment` so a browser saves rather than
          // renders — a rendered CSV is a place for content sniffing to matter.
          contentType: 'text/csv; charset=utf-8',
          body: toCsv(headers, rows),
        };
      });
    },
  };

  /**
   * Builds the rows for an export THROUGH THE SAME PATH THE READS USE.
   *
   * Not a second set of queries. An export that assembled its own SQL would be
   * a second place deciding what a school's report contains, and the two would
   * drift — most likely in the direction of the export being wider, because it
   * is the one nobody looks at on screen.
   */
  async function gatherExport(
    ctx: ActorContext,
    tx: Parameters<AnalyticsRepository['dailyMetrics']>[0],
    query: ExportQuery,
  ): Promise<{ headers: string[]; rows: unknown[][]; stem: string }> {
    if (query.dataset === 'school_overview') {
      const rows = await repository.dailyMetrics(tx, { days: query.days });
      return {
        stem: 'school-overview',
        headers: [
          'metric_date',
          'total_active_students',
          'total_active_teachers',
          'lessons_completed',
          'quizzes_attempted',
          'average_mastery_score',
          'ai_tutor_sessions',
        ],
        rows: rows.map((row) => [
          row.metric_date,
          row.total_active_students,
          row.total_active_teachers,
          row.lessons_completed,
          row.quizzes_attempted,
          asNumber(row.average_mastery_score),
          row.ai_tutor_sessions,
        ]),
      };
    }

    const items = await admitCourseRows(ctx, tx, {
      limit: EXPORT_ROW_CAP,
      offset: 0,
    });
    return {
      stem: 'course-performance',
      headers: [
        'class_name',
        'course_title',
        'enrollment_count',
        'completion_rate_pct',
        'avg_quiz_score',
        'flagged_struggling_students_count',
      ],
      // NO IDENTIFIERS IN THE EXPORT. A compliance report is read by people, and
      // a class name says more to them than a uuid does; a uuid, meanwhile, is a
      // thing to try against other endpoints once the file has travelled out of
      // the platform. `class_name` and `course_title` are user-supplied text,
      // which is exactly why every cell goes through the CSV sanitizer.
      rows: items.map((row) => [
        row.className,
        row.courseTitle,
        row.enrollmentCount,
        row.completionRatePct,
        row.avgQuizScore,
        row.flaggedStrugglingStudentsCount,
      ]),
    };
  }
}

/**
 * The headline figures.
 *
 * `activeStudentsPeak` IS A PEAK, NOT A SUM. Adding daily active counts across
 * a month produces a number larger than the school's roll, which a dashboard
 * will happily render as "total active students" — and it is the single most
 * common lie an engagement dashboard tells. The peak is a real quantity: the
 * most learners who were active on any one day.
 *
 * `masteryIndex` IS THE LATEST, NOT AN AVERAGE OF AVERAGES. Mastery is
 * cumulative state; averaging thirty daily snapshots of it would weight
 * February against today for no reason anybody could explain to a head teacher.
 * Days with no evidence are null and contribute nothing.
 */
function summarize(days: readonly DailySchoolMetric[]): SchoolOverview['totals'] {
  const withMastery = days.filter((d) => d.averageMasteryScore !== null);
  return {
    activeStudentsPeak: days.reduce((max, d) => Math.max(max, d.totalActiveStudents), 0),
    lessonsCompleted: days.reduce((sum, d) => sum + d.lessonsCompleted, 0),
    quizzesAttempted: days.reduce((sum, d) => sum + d.quizzesAttempted, 0),
    aiTutorSessions: days.reduce((sum, d) => sum + d.aiTutorSessions, 0),
    // `days` arrives newest-first from the repository.
    masteryIndex: withMastery[0]?.averageMasteryScore ?? null,
  };
}
