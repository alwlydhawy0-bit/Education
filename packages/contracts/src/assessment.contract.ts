import { z } from 'zod';
import { idSchema } from './common.ts';
import { createListQuerySchema } from './query.ts';

/**
 * Contracts for learning activities, assessments and attempts.
 *
 * Read the REQUEST schemas for what is absent rather than what is present.
 * Every one is `.strict()`, so a field not listed is a 400 rather than a
 * silently-ignored value that some future code path starts trusting.
 *
 * NOT ACCEPTED FROM A CLIENT, ANYWHERE IN THIS FILE:
 *
 *   learnerId / userId  — the learner is the session, on every route.
 *   attemptNumber       — assigned by a database trigger from a definer count.
 *   score / maxScore    — computed by the database on submission.
 *   percentage / passed — likewise.
 *   submittedAt         — the server clock. A client-supplied submission time is
 *                         a client writing history.
 *   isCorrect           — a client does not get to say what is right, and the
 *                         server never asks.
 *
 * There is no schema in this file that carries a CORRECT ANSWER outbound. The
 * key has no response shape at all, which is the point at which a serializer
 * bug becomes impossible rather than merely unlikely: there is nothing to
 * serialize it into.
 */

export const activityTypeSchema = z.enum([
  'assessment',
  'practice',
  'exercise',
  'simulation',
  'experiment',
  'research_task',
]);
export type ActivityType = z.infer<typeof activityTypeSchema>;

export const activityStatusSchema = z.enum(['draft', 'published', 'archived']);
export type ActivityStatus = z.infer<typeof activityStatusSchema>;

export const questionTypeSchema = z.enum(['single_choice', 'multiple_choice', 'true_false']);
export type QuestionType = z.infer<typeof questionTypeSchema>;

export const attemptStatusSchema = z.enum(['in_progress', 'submitted']);
export type AttemptStatus = z.infer<typeof attemptStatusSchema>;

/** Matches `learning_activities_instructions_ck`; the DB CHECK is the backstop. */
export const ACTIVITY_INSTRUCTIONS_MAX_CHARS = 8_000;

// --- Authoring -----------------------------------------------------------

/**
 * Creating an activity.
 *
 * `status` is absent: content is born a draft, decided by the server, refused
 * independently by the policy and by the RLS insert check. `position` is absent
 * for the same reason it is on lessons — ordering is server-assigned, so two
 * authors cannot race for slot 3.
 *
 * The assessment configuration is nested and REQUIRED when the type is
 * `assessment`, refined below. Creating the activity and its assessment in one
 * request is what keeps them from ever existing apart.
 */
export const reviewPolicySchema = z.enum(['on_submission', 'on_release']);
export type ReviewPolicy = z.infer<typeof reviewPolicySchema>;

/**
 * The assessment half of the request above, and of the response below.
 *
 * Frozen at publication: once the owning activity leaves draft, none of these
 * values can be changed (`assessments_config_draft_only`, migration 0020).
 * Moving a pass mark or a review policy after papers have been sat re-decides
 * an outcome the learner has already been given.
 */
export const assessmentConfigSchema = z
  .object({
    /**
     * When the learner may see their result.
     *
     * `on_submission` (the default) releases the attempt in the same statement
     * that scores it — the Task 008 behaviour, unchanged. `on_release`
     * withholds the marks and the paper until a teacher or an administrator
     * decides otherwise.
     *
     * Only two values, because only two are needed. "After a date" would put an
     * authorization rule inside a clock, which this platform already refused
     * for `startsOn`/`dueOn` in Task 006.
     */
    reviewPolicy: reviewPolicySchema.default('on_submission'),
    passingPercentage: z.number().int().min(0).max(100).default(50),
    /**
     * No "unlimited" value is offered, and that is a security decision rather
     * than a missing feature. An assessment a learner may attempt without bound
     * is an answer-key oracle: submit, read the score, vary one answer, repeat.
     * The attempt limit is the primary control against that; rate limiting is
     * only secondary, because it is per-IP and a classroom shares an IP.
     */
    maxAttempts: z.number().int().min(1).max(50).default(1),
  })
  .strict();
export type AssessmentConfig = z.infer<typeof assessmentConfigSchema>;

export const createActivityRequestSchema = z
  .object({
    activityType: activityTypeSchema,
    title: z.string().trim().min(1).max(200),
    instructions: z.string().max(ACTIVITY_INSTRUCTIONS_MAX_CHARS).default(''),
    assessment: assessmentConfigSchema.optional(),
  })
  .strict()
  .refine((v) => (v.activityType === 'assessment') === (v.assessment !== undefined), {
    message: 'assessment configuration is required for, and only for, activityType "assessment"',
    path: ['assessment'],
  });
export type CreateActivityRequest = z.infer<typeof createActivityRequestSchema>;

/**
 * Adding a question, with its options and its key, in ONE request.
 *
 * Deliberately atomic. Three separate endpoints would mean a window in which a
 * question existed with options but no key — and a question with no key is one
 * the scorer must refuse to award, which is a state worth not having at all.
 *
 * `correctOptions` is a list of INDEXES into `options`, not identifiers. The
 * option ids do not exist yet when the request is written, and indexes make the
 * key impossible to point at another question's option by construction.
 */
export const createQuestionRequestSchema = z
  .object({
    questionType: questionTypeSchema,
    prompt: z.string().trim().min(1).max(4000),
    /**
     * Why the answer is what it is. Shown during review, to everyone who
     * reviews this assessment — so it must never contain a remark about a
     * particular learner. Per-learner feedback is `teacherComment` on the
     * attempt, which is a different field with a different audience.
     */
    explanation: z.string().max(4000).default(''),
    points: z.number().int().min(1).max(100).default(1),
    options: z.array(z.string().trim().min(1).max(1000)).min(2).max(10),
    correctOptions: z.array(z.number().int().min(0).max(9)).min(1).max(10),
  })
  .strict()
  .refine((v) => v.correctOptions.every((i) => i < v.options.length), {
    message: 'every correctOptions index must name an option',
    path: ['correctOptions'],
  })
  .refine((v) => new Set(v.correctOptions).size === v.correctOptions.length, {
    message: 'correctOptions must not repeat an index',
    path: ['correctOptions'],
  })
  .refine((v) => v.questionType !== 'true_false' || v.options.length === 2, {
    message: 'a true/false question has exactly two options',
    path: ['options'],
  })
  .refine(
    (v) =>
      !(v.questionType === 'single_choice' || v.questionType === 'true_false') ||
      v.correctOptions.length === 1,
    {
      message: 'a single-choice or true/false question has exactly one correct option',
      path: ['correctOptions'],
    },
  )
  .refine(
    (v) => v.questionType !== 'multiple_choice' || v.correctOptions.length < v.options.length,
    {
      // A question where every option is correct cannot be got wrong, so it adds
      // marks without measuring anything. Refused here and again at publication.
      message: 'a multiple-choice question must have at least one incorrect option',
      path: ['correctOptions'],
    },
  );
export type CreateQuestionRequest = z.infer<typeof createQuestionRequestSchema>;

/**
 * The body of a request that carries no data: starting an attempt, publishing,
 * archiving.
 *
 * An EMPTY `.strict()` object rather than no schema at all, and the difference
 * is the platform's mass-assignment defence. A route that simply never reads
 * `request.body` ignores `{"userId": "<someone else>"}` silently — which looks
 * identical, today, to trusting it. The failure mode is a later change that
 * starts reading a field callers have already been sending unchallenged.
 *
 * Rejecting it makes the contract say out loud that these routes take nothing
 * from the client but the URL and the session. Found by a security test that
 * expected a 400 and got a 201; see VULN-028.
 */
export const emptyRequestSchema = z.object({}).strict();
export type EmptyRequest = z.infer<typeof emptyRequestSchema>;

// --- Responses -----------------------------------------------------------

export const activityResponseSchema = z
  .object({
    id: idSchema,
    lessonId: idSchema,
    position: z.number().int(),
    activityType: activityTypeSchema,
    title: z.string(),
    instructions: z.string(),
    status: activityStatusSchema,
    /** Present only for `assessment` activities. */
    assessmentId: idSchema.nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ActivityResponse = z.infer<typeof activityResponseSchema>;

/**
 * An assessment's metadata. NOT its questions.
 *
 * Questions are handed out only when an attempt is STARTED, or when re-reading
 * an attempt still in progress. That bounds question-bank harvesting by the
 * attempt limit instead of leaving it open to anyone who can see the
 * assessment — and it costs nothing, because a learner who is not attempting
 * has no use for the paper.
 */
export const assessmentResponseSchema = z
  .object({
    id: idSchema,
    activityId: idSchema,
    lessonId: idSchema,
    title: z.string(),
    instructions: z.string(),
    questionCount: z.number().int(),
    maxScore: z.number().int(),
    passingPercentage: z.number().int(),
    maxAttempts: z.number().int(),
    /** How many of them this caller has already used. Server-derived. */
    attemptsUsed: z.number().int(),
    /** Lets a client say "results are released by your teacher" up front. */
    reviewPolicy: reviewPolicySchema,
  })
  .strict();
export type AssessmentResponse = z.infer<typeof assessmentResponseSchema>;

/**
 * A question as a LEARNER receives it.
 *
 * `options` carry an id and a body. There is no `isCorrect`, no `correct`, no
 * `answer`, and no field that could hold one — the correct set lives in a
 * different table with a policy no learner can satisfy, and it has no path into
 * this shape.
 */
export const attemptQuestionSchema = z
  .object({
    id: idSchema,
    position: z.number().int(),
    questionType: questionTypeSchema,
    prompt: z.string(),
    points: z.number().int(),
    /**
     * How many options the learner must pick. Derived from the question TYPE,
     * never from the key: `single_choice` and `true_false` are 1, and
     * `multiple_choice` is null, meaning "one or more". Publishing the size of
     * a multiple-choice key would narrow the guess space, so it is not
     * published.
     */
    selectionLimit: z.number().int().nullable(),
    options: z.array(
      z.object({ id: idSchema, position: z.number().int(), body: z.string() }).strict(),
    ),
  })
  .strict();
export type AttemptQuestion = z.infer<typeof attemptQuestionSchema>;

/**
 * An attempt.
 *
 * The result block is null while in progress and populated after submission —
 * mirroring the database CHECK that makes half a result unrepresentable, so no
 * client has to handle one either.
 */
export const attemptResponseSchema = z
  .object({
    id: idSchema,
    assessmentId: idSchema,
    assessmentTitle: z.string(),
    lessonId: idSchema,
    lessonTitle: z.string(),
    courseId: idSchema,
    courseTitle: z.string(),
    attemptNumber: z.number().int(),
    status: attemptStatusSchema,
    startedAt: z.string().datetime(),
    submittedAt: z.string().datetime().nullable(),
    score: z.number().int().nullable(),
    maxScore: z.number().int().nullable(),
    percentage: z.number().nullable(),
    passed: z.boolean().nullable(),
    passingPercentage: z.number().int(),
    /**
     * Whether the learner may see the marks above. When false, `score`,
     * `percentage` and `passed` arrive NULL for the learner and their guardian —
     * redacted in SQL, not here.
     */
    released: z.boolean(),
    releasedAt: z.string().datetime().nullable(),
  })
  .strict();
export type AttemptResponse = z.infer<typeof attemptResponseSchema>;

/** An in-progress attempt, with the paper attached. */
export const attemptWithQuestionsSchema = z
  .object({ attempt: attemptResponseSchema, questions: z.array(attemptQuestionSchema) })
  .strict();
export type AttemptWithQuestions = z.infer<typeof attemptWithQuestionsSchema>;

// --- Submission ----------------------------------------------------------

/**
 * The whole paper, in one request.
 *
 * A single-shot submission rather than incremental saving, deliberately: there
 * is then no state in which an attempt holds answers but no result, and no
 * "modify my saved answers" path to secure. Answers are written and scored
 * inside one transaction.
 *
 * `selectedOptionIds` may be empty, which is how a learner leaves a question
 * unanswered. An omitted question means the same thing; both score zero.
 *
 * The bounds are the response bounds: at most 100 questions per assessment and
 * 10 options per question, matching what publication validation permits. A
 * payload beyond them cannot correspond to any real assessment, so it is
 * refused before it reaches the database — and reported as a suspicious
 * submission rather than as a validation nicety.
 */
export const submitAttemptRequestSchema = z
  .object({
    answers: z
      .array(
        z
          .object({
            questionId: idSchema,
            selectedOptionIds: z.array(idSchema).max(10),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .refine((v) => new Set(v.answers.map((a) => a.questionId)).size === v.answers.length, {
    message: 'a question may appear at most once',
    path: ['answers'],
  });
export type SubmitAttemptRequest = z.infer<typeof submitAttemptRequestSchema>;

// --- Review and release --------------------------------------------------

/**
 * ONE question, marked, as a reviewer receives it.
 *
 * This is the only shape in the platform that legitimately carries correct
 * answers, and it exists only for a RELEASED attempt. Two things about it are
 * deliberate:
 *
 *   - There is no `attemptId`, `learnerId` or score on it. Whose paper this is
 *     was decided by the route and the policy; repeating it here would create a
 *     second place for the two to disagree.
 *   - `correctOptionIds` is populated by a database function that re-checks
 *     both release and readership itself. The serializer is the last gate, not
 *     the only one.
 */
export const reviewedQuestionSchema = z
  .object({
    questionId: idSchema,
    position: z.number().int(),
    questionType: questionTypeSchema,
    prompt: z.string(),
    points: z.number().int(),
    awarded: z.number().int(),
    isCorrect: z.boolean(),
    /** What this learner chose. Empty when they left the question unanswered. */
    selectedOptionIds: z.array(idSchema),
    correctOptionIds: z.array(idSchema),
    /** Authored guidance. Empty string when the author wrote none. */
    explanation: z.string(),
    options: z.array(
      z.object({ id: idSchema, position: z.number().int(), body: z.string() }).strict(),
    ),
  })
  .strict();
export type ReviewedQuestion = z.infer<typeof reviewedQuestionSchema>;

/**
 * The whole review: the result, plus the marked paper.
 *
 * `questions` is a LIST THAT CAN BE EMPTY, and that is not a degenerate case —
 * it is what an unreleased attempt looks like to a teacher who is deciding
 * whether to release it. The result block is always present for a reader who
 * got this far; the paper is not.
 */
export const attemptReviewSchema = z
  .object({
    attempt: attemptResponseSchema,
    released: z.boolean(),
    releasedAt: z.string().datetime().nullable(),
    /** Per-learner remarks from the releasing teacher. Null when none. */
    teacherComment: z.string().nullable(),
    questions: z.array(reviewedQuestionSchema),
  })
  .strict();
export type AttemptReview = z.infer<typeof attemptReviewSchema>;

/**
 * Releasing a result.
 *
 * Carries a comment and NOTHING else — no attempt id (that is the URL), no
 * learner id, no organization, no class, and above all no score. `.strict()`
 * turns any of those into a 400 rather than a silently ignored field.
 */
export const releaseAttemptRequestSchema = z
  .object({ teacherComment: z.string().trim().max(2000).optional() })
  .strict();
export type ReleaseAttemptRequest = z.infer<typeof releaseAttemptRequestSchema>;

// --- Listing -------------------------------------------------------------

/**
 * There is no `userId` filter here, on purpose. WHOSE attempts are being read
 * is decided by the ROUTE and the session, never by a query parameter — the
 * same rule as `listProgressQuerySchema`.
 */
export const listAttemptsQuerySchema = createListQuerySchema({
  sortableFields: ['startedAt', 'submittedAt', 'attemptNumber'],
  defaultSort: 'startedAt',
  defaultOrder: 'desc',
  filters: { assessmentId: idSchema.optional(), status: attemptStatusSchema.optional() },
});
export type ListAttemptsQuery = z.infer<typeof listAttemptsQuerySchema>;

export const listActivitiesQuerySchema = createListQuerySchema({
  sortableFields: ['position', 'createdAt'],
  defaultSort: 'position',
  defaultOrder: 'asc',
  filters: { activityType: activityTypeSchema.optional() },
});
export type ListActivitiesQuery = z.infer<typeof listActivitiesQuerySchema>;
