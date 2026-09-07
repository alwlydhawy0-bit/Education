import { z } from 'zod';
import { idSchema } from './common.ts';

/**
 * Contracts for the curriculum knowledge base: indexing, and RAG retrieval.
 *
 * NOT ACCEPTED FROM A CLIENT, ANYWHERE IN THIS FILE:
 *
 *   organizationId  — the tenant is the session. There is no field for it, so
 *                     there is no forged value to validate.
 *   lessonId lists  — WHICH lessons are searched follows from the actor's class
 *                     enrolment, never from the request.
 *   embedding       — a caller supplying a raw vector would be choosing its own
 *                     neighbourhood in the index. The query is text; the server
 *                     embeds it.
 *   model           — pinned server-side, so two rows in different vector
 *                     spaces are never compared.
 *
 * THE ONLY FILTER A CLIENT MAY SEND IS `courseId`, and it can only ever NARROW.
 * The server computes the set of courses the actor reaches and intersects; a
 * course outside that set yields an empty result rather than an error, because
 * distinguishing "not assigned to you" from "does not exist" is an oracle for
 * the catalog of other schools.
 */

// --- Indexing ------------------------------------------------------------

/**
 * Rebuilding a course's index.
 *
 * The body is EMPTY and `.strict()`, not absent. A route that never reads
 * `request.body` ignores `{"organizationId": "<another school>"}` silently —
 * which looks identical, today, to trusting it (VULN-028).
 */
export const indexCourseRequestSchema = z.object({}).strict();
export type IndexCourseRequest = z.infer<typeof indexCourseRequestSchema>;

export const indexCourseResponseSchema = z
  .object({
    courseId: idSchema,
    /** Lessons that were read and re-chunked. */
    lessonsIndexed: z.number().int(),
    chunksWritten: z.number().int(),
    /** Rows removed because they were stale or their lesson is gone. */
    chunksRemoved: z.number().int(),
    embeddingModel: z.string(),
    /**
     * Lessons SKIPPED because they are not published.
     *
     * Reported as a count rather than a list of ids: an author knows their own
     * drafts, and a number is enough to explain a smaller-than-expected index
     * without enumerating unpublished work into a response body.
     */
    lessonsSkipped: z.number().int(),
  })
  .strict();
export type IndexCourseResponse = z.infer<typeof indexCourseResponseSchema>;

// --- Retrieval -----------------------------------------------------------

/** Bounds what one question can ask the database to rank. */
export const RAG_MAX_TOP_K = 20;
export const RAG_MAX_QUERY_CHARACTERS = 1_000;

export const ragRetrieveRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(RAG_MAX_QUERY_CHARACTERS),
    topK: z.number().int().min(1).max(RAG_MAX_TOP_K).default(5),
    /**
     * NARROWING ONLY. Intersected with the courses the actor actually reaches;
     * a course outside that set returns nothing rather than a 403.
     */
    courseId: idSchema.optional(),
    /** Likewise narrowing, and likewise silent when out of scope. */
    lessonId: idSchema.optional(),
  })
  .strict();
export type RagRetrieveRequest = z.infer<typeof ragRetrieveRequestSchema>;

/**
 * One retrieved passage.
 *
 * `distance` is included and `similarity` is not, deliberately. Cosine distance
 * is what pgvector returns and what the ORDER BY uses; inventing a similarity
 * score would mean choosing a formula, and every consumer would then depend on
 * that choice. The number is for ordering and diagnostics — it is never a
 * permission, and nothing downstream may branch on it to decide access.
 */
export const ragChunkSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['lesson', 'objective']),
    courseId: idSchema,
    courseTitle: z.string(),
    unitId: idSchema,
    lessonId: idSchema,
    lessonTitle: z.string(),
    chunkIndex: z.number().int(),
    content: z.string(),
    distance: z.number(),
  })
  .strict();
export type RagChunk = z.infer<typeof ragChunkSchema>;

export const ragRetrieveResponseSchema = z
  .object({
    chunks: z.array(ragChunkSchema),
    /**
     * How many courses the actor's enrolment actually admitted.
     *
     * Returned so a client can tell "you are enrolled in nothing" from "nothing
     * matched", which are different problems with different fixes. It counts
     * the caller's OWN scope and discloses nothing about anyone else's.
     */
    coursesInScope: z.number().int(),
    embeddingModel: z.string(),
  })
  .strict();
export type RagRetrieveResponse = z.infer<typeof ragRetrieveResponseSchema>;
