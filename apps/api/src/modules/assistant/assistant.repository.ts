import type { Tx } from '../../platform/db.ts';
import { RETRIEVAL_STOP_WORDS } from './stop-words.ts';

/**
 * Retrieval for the learning assistant.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   ❌  search everything → filter the results by permission
 *   ✅  compute the permitted scope → search inside it
 *
 * Post-filtering leaks through result counts, ranking behaviour and latency,
 * and one missed filter returns another learner's material verbatim. Every
 * query below runs on a connection where `app.actor_id` is the AUTHENTICATED
 * LEARNER, so PostgreSQL's row-level security has already removed every row
 * they may not read BEFORE `to_tsvector` is evaluated. The `WHERE` clause is
 * the authorization; the ranking only decides the order of what survives it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO CHUNK TABLE AND NO EMBEDDING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * These queries read `lessons` and `learning_objectives` — the LIVE curriculum
 * rows, the same ones `GET /lessons/:id` returns. Nothing is copied, so:
 *
 *   - There is no second copy of a lesson's text to drift from the first.
 *   - Archiving a lesson makes it unretrievable INSTANTLY, because the row
 *     leaves the learner's view. There is no index to invalidate and therefore
 *     no invalidation path to forget.
 *   - There is no second RLS policy mirroring `lessons_select`. The assistant
 *     is governed by the same policy as every other read, not by one that
 *     resembles it.
 *
 * The full reasoning, including why `pgvector` was not used, is in migration
 * `0023_content_retrieval_index.sql`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY NOT SEARCHED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Assessment questions, options, answer keys and explanations. Not because RLS
 * would leak them — it would not — but because there is no query here that
 * names those tables at all. The assistant cannot disclose an answer key for
 * the same reason it cannot disclose a payroll record: it never reads one.
 * That is a stronger guarantee than a filter, and it is why the "no answer key"
 * test asserts on the retrieved SET rather than on a redaction.
 */

/**
 * The lesson a learner named, with the facts the policy engine needs about it.
 *
 * EVERY FIELD IS READ FROM THE DATABASE, never asserted. An earlier draft of
 * the service synthesised a resource with `status: 'published'` and the actor's
 * own organization — which fed the policy engine its own answer and would have
 * made the second gate decorative rather than independent.
 *
 * It describes the LESSON rather than the course so the service can ask
 * `lesson:read` — the exact action `GET /lessons/:id` asks. "The same gate as
 * the delivery layer" is then literally true rather than approximately true.
 */
export interface LessonScope {
  readonly lessonId: string;
  readonly unitId: string;
  readonly courseId: string;
  readonly organizationId: string | null;
  readonly status: 'draft' | 'published' | 'archived';
  readonly ancestorsPublished: boolean;
}

/** A passage, as retrieved. `text` is untrusted curriculum prose. */
export interface RetrievedChunk {
  /** `lesson:<uuid>#<n>` or `objective:<uuid>`. Minted here, from real ids. */
  readonly id: string;
  readonly kind: 'lesson' | 'objective';
  readonly lessonId: string;
  readonly lessonTitle: string;
  readonly text: string;
  /** Higher is a closer lexical match. Ordering only; never a permission. */
  readonly rank: number;
}

export interface AssistantRepository {
  /**
   * The lesson the learner named, or null when they cannot reach it.
   *
   * Null covers "no such lesson", "another school's", "another class's",
   * "still a draft" and "archived" with ONE answer, because RLS hid the row and
   * the caller is not entitled to know which. The service turns that into the
   * same 404 the lesson endpoint gives.
   */
  lessonScope(tx: Tx, lessonId: string): Promise<LessonScope | null>;

  /**
   * Passages from one course, ranked against a question.
   *
   * `courseId` has ALREADY been authorized by the caller. It is not taken from
   * the client — it is derived from a lesson the learner demonstrably reaches —
   * and RLS re-applies the whole rule again here regardless, so a mistake in
   * the caller narrows nothing and widens nothing.
   */
  searchCourse(
    tx: Tx,
    courseId: string,
    question: string,
    limit: number,
  ): Promise<RetrievedChunk[]>;
}

/**
 * Splits a question into search terms.
 *
 * Unicode-aware, because `\w` is ASCII-only and would erase every Arabic word —
 * on an Arabic-first platform that is not a rough edge, it is the product not
 * working. Short tokens are dropped: in both languages they are overwhelmingly
 * particles, and they match everything.
 *
 * FUNCTION WORDS ARE DROPPED TOO, which the length filter alone does not
 * achieve — `ما`, `هي`, `explain` and `lesson` are all long enough to survive
 * it. Retrieving on those is what produced RISK-AI-09.
 *
 * ── WHY THE TERMS ARE JOINED WITH `|` AND NOT HANDED TO `plainto_tsquery` ──
 *
 * `plainto_tsquery` ANDs every term. A learner asking "What is mitochondria?"
 * would then require the lesson to contain "what" AND "is" AND "mitochondria",
 * and a lesson that says only "the mitochondria process" matches NOTHING. Found
 * by a test that expected a grounded answer and got `insufficient`: with AND
 * semantics the assistant is silent on almost every naturally-phrased question,
 * which is a correctness bug wearing the costume of a safety feature.
 *
 * So the terms are ORed and `ts_rank` does the discriminating — a passage
 * matching three of the learner's words outranks one matching a single common
 * word, which is the behaviour a reader expects.
 *
 * ── WHY BUILDING A `tsquery` FROM USER TEXT IS SAFE HERE ──
 *
 * `to_tsquery` DOES parse operators, so handing it raw user text would be an
 * injection into query syntax. It never sees raw user text: the split above
 * keeps only `\p{L}` and `\p{N}` — letters and digits — so every surviving
 * token is alphanumeric by construction and cannot contain `|`, `&`, `!`, `<->`
 * or a parenthesis. The joined string is then passed as a PARAMETER, never
 * interpolated into SQL. Two independent reasons, and the first is the one that
 * matters: there is no character left that could mean anything to the parser.
 */
function searchTerms(question: string): string {
  return (
    question
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 1)
      /**
       * ── FUNCTION WORDS REMOVED (RISK-AI-09, VULN-039) ────────────────────
       *
       * The `simple` FTS configuration carries no stop-word list, so without
       * this every Arabic question matched every lesson on `ما` and `هي` alone.
       * Measured: "ما هي عاصمة اليابان؟" — the capital of Japan — retrieved all
       * four paragraphs of a lesson about cells, and the server went on to
       * label the answer `course_material`.
       *
       * See `stop-words.ts` for why this is a reviewable word list rather than
       * a tuned relevance score.
       */
      .filter((token) => !RETRIEVAL_STOP_WORDS.has(token))
      .slice(0, 40)
      .join(' | ')
  );
}

/**
 * Paragraphs of a lesson body, with their ordinal.
 *
 * CHUNKING HAPPENS HERE, AT READ TIME, over a body the contract caps at 64,000
 * characters — which is why no stored chunk table is needed. The ordinal makes
 * a chunk id stable for a given body, so a citation can be checked, and it
 * changes when the body changes, so a citation cannot outlive the text it
 * pointed at.
 */
function paragraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0);
}

export function createAssistantRepository(): AssistantRepository {
  return {
    async lessonScope(tx, lessonId) {
      // Joined up to `courses` rather than trusting `lessons` alone: every hop
      // is an RLS-governed table, so a lesson whose ancestry the learner cannot
      // read yields no row even if the lesson row itself were somehow visible.
      //
      // The status and organization come back as COLUMNS so the caller can put
      // real values in front of the policy engine. A caller that invented them
      // would be asking the policy a question it had already answered.
      const { rows } = await tx.query<{
        unit_id: string;
        course_id: string;
        organization_id: string | null;
        status: 'draft' | 'published' | 'archived';
        ancestors_published: boolean;
      }>(
        `SELECT l.unit_id, c.id AS course_id, c.organization_id, l.status,
                (u.status = 'published' AND c.status = 'published') AS ancestors_published
           FROM lessons l
           JOIN course_units u ON u.id = l.unit_id
           JOIN courses c      ON c.id = u.course_id
          WHERE l.id = $1`,
        [lessonId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        lessonId,
        unitId: row.unit_id,
        courseId: row.course_id,
        organizationId: row.organization_id,
        status: row.status,
        ancestorsPublished: row.ancestors_published,
      };
    },

    async searchCourse(tx, courseId, question, limit) {
      const terms = searchTerms(question);
      if (terms === '') return [];

      // ── Objectives ────────────────────────────────────────────────────────
      // Retrieved as objectives in their own right: an objective is the unit a
      // learner's evidence points at, so a citation naming one must name the
      // statement, not the lesson that happens to contain it.
      const objectiveRows = await tx.query<{
        id: string;
        statement: string;
        lesson_id: string;
        lesson_title: string;
        rank: number;
      }>(
        `SELECT o.id, o.statement, l.id AS lesson_id, l.title AS lesson_title,
                ts_rank(
                  to_tsvector('simple'::regconfig, coalesce(o.statement, '')),
                  to_tsquery('simple'::regconfig, $2)
                ) AS rank
           FROM learning_objectives o
           JOIN lessons l      ON l.id = o.lesson_id
           JOIN course_units u ON u.id = l.unit_id
          WHERE u.course_id = $1
            AND to_tsvector('simple'::regconfig, coalesce(o.statement, ''))
                @@ to_tsquery('simple'::regconfig, $2)
          ORDER BY rank DESC, o.position ASC
          LIMIT $3`,
        [courseId, terms, limit],
      );

      // ── Lessons ───────────────────────────────────────────────────────────
      // The whole body comes back for a matching lesson and is split into
      // paragraphs here. Only lessons that match are read, so the size of the
      // payload is bounded by relevance rather than by course size — a course
      // with two hundred lessons does not become a two-hundred-lesson read.
      const lessonRows = await tx.query<{
        id: string;
        title: string;
        summary: string;
        content_body: string;
        rank: number;
      }>(
        `SELECT l.id, l.title, l.summary, l.content_body,
                ts_rank(
                  to_tsvector(
                    'simple'::regconfig,
                    coalesce(l.title, '') || ' ' || coalesce(l.summary, '') || ' ' ||
                    coalesce(l.content_body, '')
                  ),
                  to_tsquery('simple'::regconfig, $2)
                ) AS rank
           FROM lessons l
           JOIN course_units u ON u.id = l.unit_id
          WHERE u.course_id = $1
            AND to_tsvector(
                  'simple'::regconfig,
                  coalesce(l.title, '') || ' ' || coalesce(l.summary, '') || ' ' ||
                  coalesce(l.content_body, '')
                ) @@ to_tsquery('simple'::regconfig, $2)
          ORDER BY rank DESC, l.position ASC
          LIMIT $3`,
        [courseId, terms, limit],
      );

      const chunks: RetrievedChunk[] = objectiveRows.rows.map((row) => ({
        id: `objective:${row.id}`,
        kind: 'objective' as const,
        lessonId: row.lesson_id,
        lessonTitle: row.lesson_title,
        text: row.statement,
        rank: Number(row.rank),
      }));

      for (const row of lessonRows.rows) {
        const parts = paragraphs(row.content_body);
        // A lesson with a title and no body still has something to say. The
        // summary stands in so the lesson is citable rather than silently
        // dropped for having been written concisely.
        const usable = parts.length > 0 ? parts : [row.summary].filter((s) => s.trim() !== '');
        for (const [index, text] of usable.entries()) {
          chunks.push({
            id: `lesson:${row.id}#${index}`,
            kind: 'lesson',
            lessonId: row.id,
            lessonTitle: row.title,
            text,
            rank: Number(row.rank),
          });
        }
      }

      return chunks;
    },
  };
}
