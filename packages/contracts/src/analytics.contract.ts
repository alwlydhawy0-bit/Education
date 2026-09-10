import { z } from 'zod';

/**
 * Institutional analytics: what a request may say and what a response contains.
 *
 * EVERY SCHEMA IS `.strict()`. A field that arrives without being declared is a
 * 400 rather than a silent ignore — which matters more here than in most
 * domains, because the obvious thing a caller would try to smuggle in is an
 * `organizationId`.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO `organizationId` IN ANY REQUEST SCHEMA, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * Section 2B: "all reporting queries MUST enforce `organization_id` filters
 * derived directly from the authenticated user's auth context."
 *
 * The way to fail that is to accept an `organizationId` parameter and check it
 * against the caller's — which works until somebody adds a branch, or an
 * endpoint, or a "just for support staff" flag. The way to pass it structurally
 * is to have nowhere to put one. So the tenant is never a request field: it is
 * `app_actor_organization()`, resolved server-side from the session, and a
 * caller who sends `organizationId` gets a 400 telling them the field does not
 * exist.
 *
 * The same applies to `classId` on the at-risk endpoint. A teacher does not
 * name the classes they teach; the query already knows.
 */

/** ISO date, no time. The grain of the daily table. */
export const metricDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A metric date is YYYY-MM-DD');

/**
 * How far back a dashboard may look, in days.
 *
 * BOUNDED AT 366 because an unbounded range is a way to ask one endpoint for
 * every row a school has ever produced, and because a year is the longest span
 * anybody reads a daily trend over. The default of 30 is what a dashboard opens
 * on.
 */
export const trendDaysSchema = z.coerce.number().int().min(1).max(366).default(30);

/**
 * The mastery threshold below which a learner is "at risk".
 *
 * A REQUEST PARAMETER RATHER THAN A CONSTANT, because the number that decides
 * which children get called in for extra help is a professional judgement a
 * school makes, not one this platform makes for them. Bounded to a percentage
 * so it cannot be used to ask for "every learner" by passing 10000 — though
 * 100 legitimately means "everyone with any evidence", which is a teacher
 * asking to see their whole class ranked, and is allowed.
 */
export const masteryThresholdSchema = z.coerce.number().min(0).max(100).default(50);

export const schoolOverviewQuerySchema = z
  .object({
    days: trendDaysSchema,
  })
  .strict();

export const coursePerformanceQuerySchema = z
  .object({
    /**
     * Narrowing to ONE class the caller already has, not reaching for one they
     * do not. The policy decides it; this only filters an authorized list, and
     * an id the caller cannot see returns an empty list rather than an error.
     */
    classId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const atRiskQuerySchema = z
  .object({
    threshold: masteryThresholdSchema,
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

/**
 * What may be exported, and in which format.
 *
 * THE DATASET IS AN ENUM, NOT A TABLE NAME. A caller naming a table would be a
 * caller choosing what the query reads, and the distance from there to reading
 * a table nobody meant to expose is one careless interpolation. These three
 * names map to three fixed queries in the repository.
 *
 * `at_risk` IS ABSENT FROM THIS LIST ON PURPOSE. It is the one dataset about
 * named children, and a CSV of struggling minors is precisely the artefact that
 * ends up forwarded, left on a laptop, or attached to an email. A teacher can
 * read it on screen, where it is bounded by a session; there is no button that
 * turns it into a file. RISK-AN-05 records that this is a deliberate refusal
 * rather than an oversight.
 */
export const exportDatasetSchema = z.enum(['school_overview', 'course_performance']);

export const exportQuerySchema = z
  .object({
    dataset: exportDatasetSchema,
    format: z.enum(['csv', 'json']).default('csv'),
    days: trendDaysSchema,
  })
  .strict();

// --- Responses -------------------------------------------------------------

/**
 * One day of a school.
 *
 * `averageMasteryScore` IS NULLABLE ALL THE WAY THROUGH THE STACK — column,
 * DTO, CSV cell — and it is the only nullable number here. A school whose
 * learners have produced no gradeable evidence has no average; zero would read
 * as total failure to the person looking at it. Coercing it to 0 somewhere in
 * the middle is the kind of tidying that turns a missing value into a
 * defamatory one.
 */
export const dailySchoolMetricSchema = z
  .object({
    metricDate: z.string(),
    totalActiveStudents: z.number().int(),
    totalActiveTeachers: z.number().int(),
    lessonsCompleted: z.number().int(),
    quizzesAttempted: z.number().int(),
    averageMasteryScore: z.number().nullable(),
    aiTutorSessions: z.number().int(),
    updatedAt: z.string(),
  })
  .strict();

/**
 * The executive dashboard.
 *
 * NO `organizationId` IN THE RESPONSE. The caller has exactly one school and
 * already knows which; echoing the id back adds nothing a dashboard renders and
 * puts an internal key in a payload that gets pasted into support tickets.
 */
export const schoolOverviewResponseSchema = z
  .object({
    days: z.array(dailySchoolMetricSchema),
    totals: z
      .object({
        activeStudentsPeak: z.number().int(),
        lessonsCompleted: z.number().int(),
        quizzesAttempted: z.number().int(),
        aiTutorSessions: z.number().int(),
        masteryIndex: z.number().nullable(),
      })
      .strict(),
  })
  .strict();

export const coursePerformanceRowSchema = z
  .object({
    classId: z.string().uuid(),
    className: z.string(),
    courseId: z.string().uuid(),
    courseTitle: z.string(),
    enrollmentCount: z.number().int(),
    completionRatePct: z.number(),
    avgQuizScore: z.number().nullable(),
    flaggedStrugglingStudentsCount: z.number().int(),
    updatedAt: z.string(),
  })
  .strict();

export const coursePerformanceResponseSchema = z
  .object({ items: z.array(coursePerformanceRowSchema) })
  .strict();

/**
 * One learner a teacher should look at.
 *
 * THE NARROWEST PAYLOAD IN THE DOMAIN, and every absence is deliberate. There
 * is no list of the assessments they failed, no per-question breakdown, no
 * answers, no scores on individual attempts. Section 2B forbids leaking "raw
 * individual student responses", and the way to comply is not to filter them
 * out downstream but never to put them in the shape.
 *
 * What is here is the finding — this child, this index, this much evidence
 * behind it — which is what a teacher needs to decide who to talk to. The
 * evidence itself stays behind the assessment endpoints, where reaching it is
 * a deliberate act about one child rather than a scroll through a list.
 */
export const atRiskStudentSchema = z
  .object({
    studentId: z.string().uuid(),
    displayName: z.string(),
    classId: z.string().uuid(),
    courseId: z.string().uuid(),
    masteryIndex: z.number(),
    objectivesWithEvidence: z.number().int(),
  })
  .strict();

export const atRiskResponseSchema = z
  .object({
    threshold: z.number(),
    items: z.array(atRiskStudentSchema),
  })
  .strict();

export type SchoolOverviewQuery = z.infer<typeof schoolOverviewQuerySchema>;
export type CoursePerformanceQuery = z.infer<typeof coursePerformanceQuerySchema>;
export type AtRiskQuery = z.infer<typeof atRiskQuerySchema>;
export type ExportQuery = z.infer<typeof exportQuerySchema>;
export type ExportDataset = z.infer<typeof exportDatasetSchema>;
export type DailySchoolMetric = z.infer<typeof dailySchoolMetricSchema>;
export type CoursePerformanceRow = z.infer<typeof coursePerformanceRowSchema>;
export type AtRiskStudent = z.infer<typeof atRiskStudentSchema>;
