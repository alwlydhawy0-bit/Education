import { z } from 'zod';
import { idSchema } from './common.ts';

/**
 * Contracts for objectives, evidence and mastery.
 *
 * THERE IS NO REQUEST SCHEMA IN THIS FILE, and that is the most important thing
 * about it. Every other domain has a create or update body; this one has none,
 * because there is no endpoint that writes a mastery state, a mastery score, an
 * evidence row, or an objective association. Evidence is emitted by database
 * triggers on events that already happened, and mastery is derived from it on
 * every read.
 *
 * So the tampering cases the task enumerates — a client submitting `MASTERED`,
 * a client supplying a score, a client re-owning an evidence row, a client
 * backdating one — are not requests this contract rejects. They are requests
 * the API has no shape for, refused by a missing route rather than by a schema
 * somebody could loosen.
 */

/**
 * The five states, in order.
 *
 * Each one is a claim the stored evidence can justify, and no more than that:
 *
 *   no_evidence    nothing recorded.
 *   attempted      the learner engaged — a completed lesson, or an assessment
 *                  whose result they may not see yet. NOT a claim about ability.
 *   developing     assessed, and not yet passing.
 *   demonstrated   ONE assessment passed.
 *   mastered       TWO OR MORE DIFFERENT assessments passed.
 *
 * `mastered` counts DISTINCT ASSESSMENTS, not attempts. Passing one quiz three
 * times is one piece of evidence repeated; passing two different assessments is
 * genuinely stronger. The full rule lives in `app_objective_mastery` (migration
 * 0021) and is enumerated in `tests/integration/rls-mastery.test.ts`.
 */
export const masteryStateSchema = z.enum([
  'no_evidence',
  'attempted',
  'developing',
  'demonstrated',
  'mastered',
]);
export type MasteryState = z.infer<typeof masteryStateSchema>;

/**
 * The kinds of educational event that count as evidence.
 *
 * Every value names something a learner actually did. There is no
 * `manually_awarded`, no `teacher_asserted`, and no `imported` — a platform
 * that can mint evidence without an event is a platform whose mastery states
 * mean nothing.
 */
export const evidenceTypeSchema = z.enum([
  'lesson_completed',
  'assessment_passed',
  'assessment_not_passed',
]);
export type EvidenceType = z.infer<typeof evidenceTypeSchema>;

/**
 * One learner's standing on one objective.
 *
 * `evidenceCount` is a count, not a score. No numeric "mastery score" is
 * offered anywhere in this contract: a number invites arithmetic across
 * objectives, and averaging incommensurable evidence is exactly the misleading
 * aggregation the task warns against.
 */
export const objectiveMasterySchema = z
  .object({
    objectiveId: idSchema,
    statement: z.string(),
    position: z.number().int(),
    lessonId: idSchema,
    lessonTitle: z.string(),
    mastery: masteryStateSchema,
    /** How many evidence rows the READER may count towards this objective. */
    evidenceCount: z.number().int(),
    /** The most recent countable event, or null when there is none. */
    lastEvidenceAt: z.string().datetime().nullable(),
  })
  .strict();
export type ObjectiveMastery = z.infer<typeof objectiveMasterySchema>;

/**
 * One evidence row, as a reader receives it.
 *
 * NO SCORE, NO PERCENTAGE, NO MARK. The evidence summary says what happened and
 * when; the mark itself stays behind Task 009's release rules, on the endpoints
 * built for it. A percentage here would be a second door to a withheld result.
 */
export const evidenceSummarySchema = z
  .object({
    objectiveId: idSchema,
    evidenceType: evidenceTypeSchema,
    sourceKind: z.enum(['lesson_progress', 'assessment_attempt']),
    occurredAt: z.string().datetime(),
  })
  .strict();
export type EvidenceSummary = z.infer<typeof evidenceSummarySchema>;

/**
 * Objective counts rolled up over a course, a unit or a lesson.
 *
 * COUNTS PER STATE, NOT AN AVERAGE. Averaging five states onto one number
 * requires assigning them weights nobody can defend, and it hides the
 * distinction that matters most to a teacher: whether a class is stuck at
 * `developing` or split between `no_evidence` and `mastered`. A single
 * percentage is offered alongside — `demonstratedOrMastered / total` — because
 * a progress bar needs one, and its definition is stated rather than implied.
 */
export const masteryTallySchema = z
  .object({
    total: z.number().int(),
    noEvidence: z.number().int(),
    attempted: z.number().int(),
    developing: z.number().int(),
    demonstrated: z.number().int(),
    mastered: z.number().int(),
    /**
     * The share of objectives at `demonstrated` or `mastered`, 0–100, rounded
     * to one decimal. `null` when there are no objectives at all — a course with
     * nothing to demonstrate is not 0% mastered, it is unmeasurable, and
     * reporting 0 would read as failure.
     */
    demonstratedPercentage: z.number().nullable(),
  })
  .strict();
export type MasteryTally = z.infer<typeof masteryTallySchema>;

/** A lesson's objectives, with the learner's standing on each. */
export const lessonMasterySchema = z
  .object({
    lessonId: idSchema,
    lessonTitle: z.string(),
    unitId: idSchema,
    unitTitle: z.string(),
    /** From `lesson_progress` (0018) — started/completed, a different question. */
    lessonStatus: z.enum(['not_started', 'in_progress', 'completed']),
    objectives: z.array(objectiveMasterySchema),
    tally: masteryTallySchema,
  })
  .strict();
export type LessonMastery = z.infer<typeof lessonMasterySchema>;

/** A unit's lessons, rolled up. */
export const unitMasterySchema = z
  .object({
    unitId: idSchema,
    unitTitle: z.string(),
    position: z.number().int(),
    lessons: z.array(lessonMasterySchema),
    tally: masteryTallySchema,
  })
  .strict();
export type UnitMastery = z.infer<typeof unitMasterySchema>;

/**
 * A whole course, for one learner.
 *
 * The two tallies answer different questions and are reported separately rather
 * than blended: `tally` is about OBJECTIVES demonstrated, `lessonsCompleted` is
 * about LESSONS finished. A learner can complete every lesson and demonstrate
 * nothing, and a course view that averaged the two would hide exactly that.
 */
export const courseMasterySchema = z
  .object({
    courseId: idSchema,
    courseTitle: z.string(),
    units: z.array(unitMasterySchema),
    tally: masteryTallySchema,
    lessonsTotal: z.number().int(),
    lessonsCompleted: z.number().int(),
  })
  .strict();
export type CourseMastery = z.infer<typeof courseMasterySchema>;
