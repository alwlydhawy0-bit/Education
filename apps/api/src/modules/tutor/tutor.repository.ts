import { Guarded, type AiConversationResource } from '@edu/authz';
import type { Tx } from '../../platform/db.ts';

/**
 * Persistence for AI tutor conversations.
 *
 * TWO RULES SHAPE EVERY QUERY HERE.
 *
 * 1. THE POLICY'S RELATIONSHIP FACTS ARE RESOLVED IN SQL, BESIDE THE ROW. The
 *    policy engine is pure, so "does this actor teach this learner", "may they
 *    moderate this school" and "is the learner still studying the anchor" have
 *    to arrive as facts. Resolving them in the same statement as the row means
 *    the row and the facts about it cannot come from different moments — a
 *    second query could observe an enrolment that changed in between and
 *    authorize against a world that no longer exists.
 *
 * 2. NOTHING HERE WRITES A `sender_type` A CALLER CHOSE. `appendStudentTurn`
 *    hard-codes `'student'`; `appendPlatformTurn` is the only path to the other
 *    two and calls `ai_begin_platform_turn` first, which is the marker the RLS
 *    policy checks. There are exactly two INSERT statements against
 *    `ai_messages` in this codebase and a fitness function asserts it.
 */

export interface ConversationRow {
  readonly id: string;
  readonly ownerId: string;
  readonly organizationId: string | null;
  readonly lessonId: string;
  readonly courseId: string;
  readonly lessonTitle: string;
  readonly title: string;
  readonly status: 'active' | 'archived';
  readonly messageCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MessageRow {
  readonly id: string;
  readonly seq: number;
  readonly senderType: 'student' | 'system' | 'ai_tutor';
  readonly content: string;
  readonly retrievedSources: Array<{ id: string; lessonId: string; lessonTitle: string }>;
  readonly guardrailVerdict: string | null;
  readonly createdAt: Date;
}

export interface RecordedTurn {
  readonly conversationId: string;
  readonly content: string;
  readonly sources: ReadonlyArray<{ id: string; lessonId: string; lessonTitle: string }>;
  readonly tokenCount: number;
  readonly latencyMs: number | null;
  readonly verdict: string | null;
}

export interface TutorRepository {
  findConversation(tx: Tx, id: string): Promise<Guarded<ConversationRow> | null>;
  /** The learner's own conversations. Scoped by owner in SQL, not only by RLS. */
  listOwn(tx: Tx, ownerId: string): Promise<ConversationRow[]>;
  /** A lesson, as the policy needs it, before a conversation exists for it. */
  lessonAnchor(
    tx: Tx,
    lessonId: string,
  ): Promise<{ lessonId: string; courseId: string; organizationId: string | null;
               lessonTitle: string; stillAssigned: boolean } | null>;
  createConversation(
    tx: Tx,
    input: { ownerId: string; lessonId: string; title: string },
  ): Promise<string>;
  rename(tx: Tx, id: string, title: string): Promise<boolean>;
  archive(tx: Tx, id: string): Promise<boolean>;
  messages(tx: Tx, conversationId: string): Promise<MessageRow[]>;
  /** Oldest-first turns for the provider, capped. Content only. */
  history(
    tx: Tx,
    conversationId: string,
    limit: number,
  ): Promise<Array<{ senderType: string; content: string }>>;
  appendStudentTurn(tx: Tx, turn: RecordedTurn & { ownerId: string }): Promise<MessageRow>;
  appendPlatformTurn(
    tx: Tx,
    turn: RecordedTurn & { ownerId: string; senderType: 'system' | 'ai_tutor' },
  ): Promise<MessageRow>;
}

interface RawConversation {
  id: string;
  student_id: string;
  organization_id: string | null;
  lesson_id: string;
  course_id: string;
  lesson_title: string;
  title: string;
  status: 'active' | 'archived';
  message_count: string;
  created_at: Date;
  updated_at: Date;
  observable_as_teacher: boolean;
  moderatable: boolean;
  anchor_still_assigned: boolean;
}

const toRow = (raw: RawConversation): ConversationRow => ({
  id: raw.id,
  ownerId: raw.student_id,
  organizationId: raw.organization_id,
  lessonId: raw.lesson_id,
  courseId: raw.course_id,
  lessonTitle: raw.lesson_title,
  title: raw.title,
  status: raw.status,
  messageCount: Number(raw.message_count),
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
});

const toResource = (raw: RawConversation): AiConversationResource => ({
  kind: 'ai_conversation',
  id: raw.id,
  ownerId: raw.student_id,
  organizationId: raw.organization_id,
  lessonId: raw.lesson_id,
  courseId: raw.course_id,
  status: raw.status,
  observableByActorAsTeacher: raw.observable_as_teacher,
  moderatableByActor: raw.moderatable,
  anchorStillAssigned: raw.anchor_still_assigned,
});

/**
 * The relationship facts, resolved beside every conversation row.
 *
 * `app_actor_observes_learner_lesson` and `app_actor_moderates_conversation`
 * are the SAME functions the RLS policies call. Asking them here rather than
 * re-deriving the joins is what keeps the two gates from drifting: if the
 * definition of "teaches this learner" changes, both layers change with it,
 * because there is only one definition.
 */
const RELATIONSHIP_FACTS = `
  app_actor_observes_learner_lesson(c.student_id, c.lesson_id) AS observable_as_teacher,
  app_actor_moderates_conversation(c.student_id, c.organization_id, c.lesson_id) AS moderatable,
  app_actor_may_study_lesson(c.lesson_id) AS anchor_still_assigned`;

/**
 * THE LESSON JOIN IS FOR DISPLAY, NOT FOR AUTHORIZATION — hence LEFT.
 *
 * It was an inner join first, and that quietly overrode the whole moderation
 * design. `lessons` is RLS-narrowed to the classes an actor is in, so a safety
 * moderator — who teaches nobody and studies nothing — could not see the lesson
 * row, the join dropped the conversation, and the transcript came back 404
 * despite a policy that plainly admitted them. The same accident hid a
 * learner's OWN history the moment they left the class, contradicting the
 * property the migration and the RLS suite both assert: revocation takes away
 * the ability to keep talking, not the record of having talked.
 *
 * Who may see a conversation is decided by `ai_conversations_select` and by
 * `aiConversationPolicy`. A join added to fetch a title must not get a vote,
 * and `coalesce` to the conversation's own title keeps the response shape
 * without disclosing anything the reader did not already hold.
 */
const LESSON_TITLE = `coalesce(l.title, c.title) AS lesson_title`;

const COUNT_SUBQUERY = `(SELECT count(*) FROM ai_messages m WHERE m.conversation_id = c.id)`;

export function createTutorRepository(): TutorRepository {
  return {
    async findConversation(tx, id) {
      const { rows } = await tx.query<RawConversation>(
        `SELECT c.id, c.student_id, c.organization_id, c.lesson_id, c.course_id,
                ${LESSON_TITLE}, c.title, c.status,
                ${COUNT_SUBQUERY} AS message_count,
                c.created_at, c.updated_at,
                ${RELATIONSHIP_FACTS}
           FROM ai_conversations c
           LEFT JOIN lessons l ON l.id = c.lesson_id
          WHERE c.id = $1`,
        [id],
      );
      const raw = rows[0];
      if (!raw) return null;
      return Guarded.of(toRow(raw), toResource(raw));
    },

    async listOwn(tx, ownerId) {
      // SCOPED BY OWNER IN SQL, not only by RLS. Two gates, and the layered
      // defence suite runs this one with the database's gate switched off —
      // VULN-017 was a listing that RLS was quietly carrying alone.
      const { rows } = await tx.query<RawConversation>(
        `SELECT c.id, c.student_id, c.organization_id, c.lesson_id, c.course_id,
                ${LESSON_TITLE}, c.title, c.status,
                ${COUNT_SUBQUERY} AS message_count,
                c.created_at, c.updated_at,
                ${RELATIONSHIP_FACTS}
           FROM ai_conversations c
           LEFT JOIN lessons l ON l.id = c.lesson_id
          WHERE c.student_id = $1
          ORDER BY c.updated_at DESC
          LIMIT 200`,
        [ownerId],
      );
      return rows.map(toRow);
    },

    async lessonAnchor(tx, lessonId) {
      const { rows } = await tx.query<{
        lesson_id: string;
        course_id: string;
        organization_id: string | null;
        lesson_title: string;
        still_assigned: boolean;
      }>(
        `SELECT l.id AS lesson_id, u.course_id,
                app_course_organization(u.course_id) AS organization_id,
                l.title AS lesson_title,
                app_actor_may_study_lesson(l.id) AS still_assigned
           FROM lessons l
           JOIN course_units u ON u.id = l.unit_id
          WHERE l.id = $1`,
        [lessonId],
      );
      const raw = rows[0];
      if (!raw) return null;
      return {
        lessonId: raw.lesson_id,
        courseId: raw.course_id,
        organizationId: raw.organization_id,
        lessonTitle: raw.lesson_title,
        stillAssigned: raw.still_assigned,
      };
    },

    async createConversation(tx, input) {
      // `course_id` is sent as a placeholder and OVERWRITTEN by the scope
      // trigger, which derives it from the lesson. Passed explicitly so the
      // overwrite is visible in the source rather than being a surprise to
      // somebody reading this statement alone.
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO ai_conversations (student_id, lesson_id, course_id, title)
         VALUES ($1, $2, $2, $3)
         RETURNING id`,
        [input.ownerId, input.lessonId, input.title],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error('Conversation insert returned no id');
      return id;
    },

    async rename(tx, id, title) {
      const { rowCount } = await tx.query(
        `UPDATE ai_conversations SET title = $2 WHERE id = $1`,
        [id, title],
      );
      return (rowCount ?? 0) > 0;
    },

    async archive(tx, id) {
      const { rowCount } = await tx.query(
        `UPDATE ai_conversations SET status = 'archived' WHERE id = $1 AND status = 'active'`,
        [id],
      );
      return (rowCount ?? 0) > 0;
    },

    async messages(tx, conversationId) {
      const { rows } = await tx.query<{
        id: string;
        seq: number;
        sender_type: 'student' | 'system' | 'ai_tutor';
        content_text: string;
        retrieved_context_chunks_json: Array<{ id: string; lessonId: string; lessonTitle: string }>;
        guardrail_verdict: string | null;
        created_at: Date;
      }>(
        `SELECT id, seq, sender_type, content_text, retrieved_context_chunks_json,
                guardrail_verdict, created_at
           FROM ai_messages
          WHERE conversation_id = $1
          ORDER BY seq`,
        [conversationId],
      );
      return rows.map((row) => ({
        id: row.id,
        seq: row.seq,
        senderType: row.sender_type,
        content: row.content_text,
        retrievedSources: row.retrieved_context_chunks_json ?? [],
        guardrailVerdict: row.guardrail_verdict,
        createdAt: row.created_at,
      }));
    },

    async history(tx, conversationId, limit) {
      // THE MOST RECENT turns, then re-ordered oldest-first for the provider.
      //
      // Taking the FIRST n would freeze the conversation at its opening and
      // make the tutor progressively more confused as it went on; taking the
      // last n and reversing is what "recent context" means. The limit exists
      // because history is the cheapest thing to grow without noticing and the
      // most expensive to send.
      //
      // A REFUSED TURN IS EXCLUDED. A message the guardrail blocked was never
      // answered, and replaying it would put the attempt back into the
      // context of every later turn — which is exactly the persistence
      // property that makes multi-turn injection worth defending against.
      const { rows } = await tx.query<{ sender_type: string; content_text: string }>(
        `SELECT sender_type, content_text
           FROM (
             SELECT sender_type, content_text, seq
               FROM ai_messages
              WHERE conversation_id = $1
                AND guardrail_verdict IS DISTINCT FROM 'blocked_injection'
              ORDER BY seq DESC
              LIMIT $2
           ) recent
          ORDER BY seq ASC`,
        [conversationId, limit],
      );
      return rows.map((row) => ({ senderType: row.sender_type, content: row.content_text }));
    },

    async appendStudentTurn(tx, turn) {
      // `'student'` IS A LITERAL AND MUST STAY ONE. It is not a parameter and
      // there is no code path by which a caller could reach it.
      const { rows } = await tx.query<{ id: string; seq: number; created_at: Date }>(
        `INSERT INTO ai_messages
           (conversation_id, owner_id, sender_type, content_text,
            retrieved_context_chunks_json, token_count, latency_ms, guardrail_verdict)
         VALUES ($1, $2, 'student', $3, $4::jsonb, $5, $6, $7)
         RETURNING id, seq, created_at`,
        [
          turn.conversationId,
          turn.ownerId,
          turn.content,
          JSON.stringify(turn.sources),
          turn.tokenCount,
          turn.latencyMs,
          turn.verdict,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error('Student turn insert returned no row');
      return {
        id: row.id,
        seq: row.seq,
        senderType: 'student',
        content: turn.content,
        retrievedSources: [...turn.sources],
        guardrailVerdict: turn.verdict,
        createdAt: row.created_at,
      };
    },

    async appendPlatformTurn(tx, turn) {
      // THE MARKER, AND THE ONLY CALL SITE OF IT.
      //
      // `ai_begin_platform_turn` sets a transaction-local setting naming this
      // conversation; the RLS policy admits a non-student `sender_type` only
      // for the conversation that setting names. Migration 0027 explains at
      // length why this is a path marker rather than an identity check, and
      // what that does and does not buy.
      await tx.query('SELECT ai_begin_platform_turn($1)', [turn.conversationId]);

      const { rows } = await tx.query<{ id: string; seq: number; created_at: Date }>(
        `INSERT INTO ai_messages
           (conversation_id, owner_id, sender_type, content_text,
            retrieved_context_chunks_json, token_count, latency_ms, guardrail_verdict)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         RETURNING id, seq, created_at`,
        [
          turn.conversationId,
          turn.ownerId,
          turn.senderType,
          turn.content,
          JSON.stringify(turn.sources),
          turn.tokenCount,
          turn.latencyMs,
          turn.verdict,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error('Platform turn insert returned no row');
      return {
        id: row.id,
        seq: row.seq,
        senderType: turn.senderType,
        content: turn.content,
        retrievedSources: [...turn.sources],
        guardrailVerdict: turn.verdict,
        createdAt: row.created_at,
      };
    },
  };
}
