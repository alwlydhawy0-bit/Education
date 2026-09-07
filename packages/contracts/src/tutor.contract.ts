import { z } from 'zod';
import { idSchema } from './common.ts';

/**
 * The wire contract for the AI tutor.
 *
 * TWO ABSENCES DO MORE WORK HERE THAN ANY FIELD PRESENT.
 *
 * 1. THERE IS NO `senderType`. A caller cannot say which side of the
 *    conversation a message came from, because the server decides. A learner
 *    who could post a turn labelled `ai_tutor` could fabricate a transcript in
 *    which the school's assistant told them something it never said — and a
 *    forged transcript is a serious thing to hold up in a homework dispute, a
 *    safeguarding review, or a conversation with a parent. Migration 0027
 *    enforces the same rule at the database; this is the half that means the
 *    request cannot even express the attempt.
 *
 * 2. THERE IS NO `context`, `sources`, `systemPrompt` OR `history` FIELD. The
 *    client says what the learner typed and nothing else. Everything the model
 *    sees — the instructions, the retrieved passages, the prior turns — is
 *    resolved server-side from the conversation's own id. A caller supplying
 *    its own context would be choosing what the tutor is grounded in, which is
 *    the entire security property of a RAG pipeline handed back to the
 *    attacker.
 *
 * Every schema is `.strict()`, so an unknown field is a 400 rather than
 * something quietly ignored. Ignoring a forged field looks identical, in every
 * log and every test, to trusting it — VULN-028.
 */

/** The longest question the API will accept, before the guardrail's own cap. */
export const TUTOR_MAX_QUESTION_CHARACTERS = 4_000;

/**
 * Deliberately ABOVE `MAX_QUESTION_CHARACTERS` in the guardrail layer.
 *
 * Two limits at the same value means the inner one never fires and is dead code
 * that reads as a control — VULN-043 exactly. The contract rejects the absurd;
 * the guardrail truncates the merely long and RECORDS that it did, which is a
 * different and more useful behaviour. Keeping them apart keeps both alive.
 */

export const createConversationRequestSchema = z
  .object({
    lessonId: idSchema,
    /**
     * Optional. When absent the server derives one from the lesson title.
     *
     * A learner naming their own conversation is ordinary; the field is capped
     * and trimmed rather than sanitized for markup, because it is rendered as
     * text and never as HTML, and the one place it could be dangerous — the
     * moderation view — renders it the same way.
     */
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>;

export const conversationSummarySchema = z
  .object({
    id: idSchema,
    lessonId: idSchema,
    courseId: idSchema,
    lessonTitle: z.string(),
    title: z.string(),
    status: z.enum(['active', 'archived']),
    messageCount: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const listConversationsResponseSchema = z
  .object({ conversations: z.array(conversationSummarySchema) })
  .strict();

/**
 * One turn, as it goes back to a reader.
 *
 * `retrievedSources` carries ids and titles, never chunk bodies. The bodies are
 * curriculum and already reachable through the lesson endpoints by anybody
 * entitled to read them; repeating them in every transcript row would make this
 * response a second copy of the coursework, going stale from the moment it was
 * written.
 */
export const conversationMessageSchema = z
  .object({
    id: idSchema,
    seq: z.number().int(),
    senderType: z.enum(['student', 'system', 'ai_tutor']),
    content: z.string(),
    retrievedSources: z.array(
      z.object({ id: z.string(), lessonId: idSchema, lessonTitle: z.string() }).strict(),
    ),
    /**
     * Set when the guardrail layer refused or altered this turn.
     *
     * Returned to the LEARNER as well as to a moderator, deliberately. A child
     * whose message was refused should be told that it was, and why in general
     * terms — a silent refusal teaches a persistent child to keep trying
     * variations until something works, while a plain one ends most attempts.
     */
    guardrailVerdict: z
      .enum(['blocked_injection', 'blocked_answer_seeking', 'out_of_scope', 'truncated'])
      .nullable(),
    createdAt: z.string(),
  })
  .strict();
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const conversationMessagesResponseSchema = z
  .object({
    conversationId: idSchema,
    messages: z.array(conversationMessageSchema),
  })
  .strict();

export const sendMessageRequestSchema = z
  .object({
    content: z.string().trim().min(1).max(TUTOR_MAX_QUESTION_CHARACTERS),
  })
  .strict();
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

/**
 * How the tutor answered — decided by the SERVER, never by the model.
 *
 *   `course_material` — grounded, with at least one citation that survived
 *                       validation against what was actually retrieved.
 *   `out_of_scope`    — the learner's own material does not cover this. The
 *                       honest answer, and the one section 2B requires.
 *   `refused`         — the guardrail layer blocked the turn.
 *   `unavailable`     — the provider failed. One message for all five failure
 *                       kinds; the distinction is for the operator's audit
 *                       trail, never for the learner.
 */
export const tutorGroundingSchema = z.enum([
  'course_material',
  'out_of_scope',
  'refused',
  'unavailable',
]);
export type TutorGrounding = z.infer<typeof tutorGroundingSchema>;

export const sendMessageResponseSchema = z
  .object({
    grounding: tutorGroundingSchema,
    studentMessage: conversationMessageSchema,
    tutorMessage: conversationMessageSchema,
    /** How many passages were searched. A count, never the passages. */
    searchedSources: z.number().int(),
  })
  .strict();
export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;
