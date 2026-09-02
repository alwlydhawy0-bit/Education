import { z } from 'zod';
import { idSchema } from './common.ts';

/**
 * The learning assistant's wire contract (Task 013).
 *
 * TWO PROPERTIES CARRY THE SECURITY HERE, and both are structural rather than
 * advisory.
 *
 * FIRST: the request names a PLACE, never a PERSON and never a PERMISSION. The
 * only field a client may send besides the question is a lesson id — navigation
 * intent — and the server resolves that to an authorized scope on its own. There
 * is no `learnerId`, no `organizationId`, no `classId`, no `role`, and no
 * `sources` field, so there is no shape in which a client could name whose
 * material to read or assert that it may read it. `.strict()` makes sending one
 * a 400 rather than a silently ignored field.
 *
 * SECOND: the response cannot carry an instruction. It has an answer, validated
 * references, a grounding state and a refusal reason — and no field for a tool
 * call, a redirect, an action, or a permission. A model that emitted
 * `{"action":"publish"}` would be emitting a string into `answer`.
 */

/**
 * The longest question the assistant accepts.
 *
 * A cap in CHARACTERS, well under the 256 KiB body limit, and small on purpose.
 * A question is a question; a 50,000-character "question" is either an attempt
 * to exhaust provider tokens (which cost real money) or an attempt to bury an
 * injected instruction far enough down that a reviewer skims past it. Neither
 * is a use case worth supporting, and Arabic costs two UTF-8 bytes per
 * character so the limit is stated in characters to mean the same thing in both
 * languages.
 */
export const ASSISTANT_QUESTION_MAX_CHARS = 1_000;

export const askAssistantRequestSchema = z
  .object({
    question: z.string().trim().min(3).max(ASSISTANT_QUESTION_MAX_CHARS),
    /**
     * Where the learner is reading. NAVIGATION INTENT, NOT AUTHORIZATION.
     *
     * The server re-resolves this id against the learner's own authorization
     * and answers 404 if it does not reach them — exactly as `GET /lessons/:id`
     * does. Sending somebody else's lesson id gets a learner nothing; it is the
     * same refusal they would get from the lesson endpoint.
     */
    lessonId: idSchema,
  })
  .strict();
export type AskAssistantRequest = z.infer<typeof askAssistantRequestSchema>;

/**
 * A reference to material that was ACTUALLY retrieved.
 *
 * Every field here is copied from a row the server read under the learner's own
 * authorization, after the provider answered. The service intersects the
 * provider's claimed ids with the retrieved set and builds these from the
 * survivors, so a reference cannot name a lesson that does not exist, a lesson
 * the learner cannot read, or a passage that was never retrieved.
 *
 * `excerpt` is the retrieved text itself rather than the model's paraphrase of
 * it, so a reader can check the answer against the source without trusting the
 * answer.
 */
export const assistantSourceRefSchema = z
  .object({
    /** `lesson:<uuid>#<n>` or `objective:<uuid>` — minted by retrieval. */
    id: z.string().min(1).max(200),
    kind: z.enum(['lesson', 'objective']),
    /** The real row this came from, so a client can navigate to it. */
    lessonId: idSchema,
    lessonTitle: z.string(),
    excerpt: z.string(),
  })
  .strict();
export type AssistantSourceRef = z.infer<typeof assistantSourceRefSchema>;

/**
 * How well the answer is supported by the learner's own material.
 *
 * THIS IS THE FIELD SECTION 13 IS ABOUT. A learner must be able to tell "your
 * textbook says this" from "a language model says this", and the distinction is
 * decided by the SERVER from whether any citation survived validation — never by
 * the model's own claim about itself.
 *
 *   `course_material` — at least one validated reference supports the answer.
 *   `insufficient`    — the authorized material does not cover the question.
 *                       The assistant says so instead of answering from general
 *                       knowledge and letting it look like coursework.
 *   `unavailable`     — the assistant could not answer at all. Says nothing
 *                       about the question or the material.
 */
export const assistantGroundingSchema = z.enum(['course_material', 'insufficient', 'unavailable']);
export type AssistantGrounding = z.infer<typeof assistantGroundingSchema>;

export const askAssistantResponseSchema = z
  .object({
    grounding: assistantGroundingSchema,
    /** Empty unless `grounding` is `course_material`. */
    answer: z.string(),
    /** Empty unless `grounding` is `course_material`. */
    sources: z.array(assistantSourceRefSchema),
    /**
     * How many authorized passages were searched.
     *
     * A COUNT, never the passages. It lets a learner see that the assistant
     * looked at their material and found nothing, rather than suspecting it did
     * not look. It discloses nothing: a learner may already read every one of
     * these, and the number of lessons in their own course is not a secret.
     */
    searchedSources: z.number().int().min(0),
  })
  .strict();
export type AskAssistantResponse = z.infer<typeof askAssistantResponseSchema>;
