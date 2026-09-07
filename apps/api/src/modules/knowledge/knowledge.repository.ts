import { Guarded, type CourseResource } from '@edu/authz';
import type { Tx } from '../../platform/db.ts';
import { toVectorLiteral } from '../../platform/ai/embeddings.ts';
import type { CurriculumChunk, LessonSource } from './chunking.ts';

/**
 * Persistence for the curriculum knowledge base.
 *
 * THREE RULES SHAPE EVERY QUERY IN THIS FILE.
 *
 * 1. THE SCOPE FILTER COMES BEFORE THE VECTOR SCAN, ALWAYS. Every retrieval
 *    query below narrows to a course list computed from the actor's own
 *    enrolment BEFORE `ORDER BY embedding <=> $1` is reached. Section 3 of the
 *    task requires it; the shape of the SQL is what delivers it. A query that
 *    ranked first and filtered afterwards would read every tenant's vectors
 *    into memory to decide it was not allowed to.
 *
 * 2. EVERY RETRIEVAL JOINS THE LIVE LESSON. Not for the text — the chunk has
 *    that — but for the LIFECYCLE and the FRESHNESS. The join is what makes an
 *    archived lesson's chunks disappear with no invalidation path, and the
 *    `source_updated_at` comparison beside it is what stops an edited lesson serving
 *    the text it used to have. Migration 0026 answers 0023's objections with
 *    these two clauses; deleting either re-opens one.
 *
 * FRESHNESS IS AN EQUALITY OVER AN EXACTLY-PRESERVED VALUE, and it took two
 * mistakes to arrive at that sentence. The first draft hashed the lesson text
 * in SQL and compared the digest against one the indexer computed in
 * TypeScript — two implementations of one normalization (whitespace, field
 * order, whether objectives are included), whose inevitable drift would have
 * presented as "retrieval silently returns nothing" rather than as an error.
 * `lessons.updated_at` is already this platform's definition of "has this
 * changed" — it is the optimistic-concurrency precondition for every lesson
 * write — so reusing it means one definition and nothing to keep in sync.
 *
 * The second mistake was to think that settled it. Reusing one value is not
 * enough if the value is reshaped in transit: `timestamptz` keeps microseconds
 * and a JavaScript `Date` does not, so reading the column into a `Date` and
 * writing it back stored a truncated copy and the equality was false for every
 * chunk in the table. The feature returned an empty result to every learner,
 * with no error anywhere. The lesson generalises past this column: an equality
 * is only as good as the fidelity of the carrier between the two reads, so the
 * timestamp travels as PostgreSQL's own text and is never parsed on the way.
 *
 * 3. NOTHING HERE READS A LEARNER'S WORKSPACE. `notes`, `student_notebooks`
 *    and `student_artifacts` appear in no query in this file, and
 *    `tests/architecture/knowledge-boundaries.test.ts` asserts it mechanically.
 *    A knowledge base that contained one child's private writing would answer
 *    another child's question with it.
 */

export interface CourseIndexTarget {
  readonly courseId: string;
  readonly courseTitle: string;
  readonly organizationId: string | null;
  readonly status: 'draft' | 'published' | 'archived';
}

export interface RetrievedVectorChunk {
  readonly id: string;
  readonly kind: 'lesson' | 'objective';
  readonly courseId: string;
  readonly courseTitle: string;
  readonly unitId: string;
  readonly lessonId: string;
  readonly lessonTitle: string;
  readonly chunkIndex: number;
  readonly content: string;
  readonly distance: number;
}

export interface KnowledgeRepository {
  /** The course, as the policy engine needs to see it. Null when hidden. */
  findCourse(tx: Tx, courseId: string): Promise<Guarded<CourseIndexTarget> | null>;

  /**
   * The PUBLISHED lessons of a course, with their objectives, ready to chunk.
   *
   * Published only, and that is enforced in SQL rather than filtered after: an
   * unpublished lesson must never reach the chunker, so the safest place for
   * the predicate is the one where forgetting it is impossible.
   */
  publishedLessons(tx: Tx, courseId: string): Promise<LessonSource[]>;
  /** How many of the course's lessons were NOT published. Reported, not listed. */
  unpublishedLessonCount(tx: Tx, courseId: string): Promise<number>;

  /** Removes a course's rows for one model. Re-indexing replaces, never appends. */
  clearCourseIndex(tx: Tx, courseId: string, model: string): Promise<number>;

  insertChunks(
    tx: Tx,
    chunks: readonly CurriculumChunk[],
    vectors: readonly number[][],
    model: string,
    sourceUpdatedAtByLesson: ReadonlyMap<string, string>,
  ): Promise<number>;

  /**
   * The courses this actor may study, right now.
   *
   * The PRE-FILTER's input, and it is computed from the live enrolment graph
   * rather than from anything the client sent. An empty list means an empty
   * search — never an unbounded one.
   */
  coursesInScope(tx: Tx, actorId: string): Promise<string[]>;

  similar(
    tx: Tx,
    options: {
      readonly courseIds: readonly string[];
      readonly queryVector: readonly number[];
      readonly model: string;
      readonly topK: number;
      readonly lessonId?: string | undefined;
    },
  ): Promise<RetrievedVectorChunk[]>;
}

interface CourseRow {
  id: string;
  title: string;
  organization_id: string | null;
  status: 'draft' | 'published' | 'archived';
  curriculum_id: string;
  level_id: string;
}

const toCourse = (row: CourseRow): CourseIndexTarget => ({
  courseId: row.id,
  courseTitle: row.title,
  organizationId: row.organization_id,
  status: row.status,
});

/**
 * The projection the policy engine decides on.
 *
 * `ancestorsPublished` asks about the CURRICULUM above the course, matching
 * what `contentPolicy` means by the term at this level. Resolved in SQL beside
 * the row so the two cannot disagree.
 */
const toCourseResource = (row: CourseRow, ancestorsPublished: boolean): CourseResource => ({
  kind: 'course',
  id: row.id,
  organizationId: row.organization_id,
  status: row.status,
  ancestorsPublished,
  curriculumId: row.curriculum_id,
  levelId: row.level_id,
});

export function createKnowledgeRepository(): KnowledgeRepository {
  return {
    async findCourse(tx, courseId) {
      const { rows } = await tx.query<CourseRow & { ancestors_published: boolean }>(
        `SELECT c.id, c.title, c.organization_id, c.status, c.curriculum_id, c.level_id,
                (cu.status = 'published') AS ancestors_published
           FROM courses c
           JOIN curricula cu ON cu.id = c.curriculum_id
          WHERE c.id = $1`,
        [courseId],
      );
      const row = rows[0];
      if (!row) return null;
      return Guarded.of(toCourse(row), toCourseResource(row, row.ancestors_published));
    },

    async publishedLessons(tx, courseId) {
      // Objectives are aggregated in the same statement rather than fetched per
      // lesson: a course with two hundred lessons would otherwise be two
      // hundred round trips, and indexing is the one operation here that reads
      // a whole course at once.
      const { rows } = await tx.query<{
        lesson_id: string;
        unit_id: string;
        course_id: string;
        organization_id: string | null;
        title: string;
        summary: string;
        content_body: string;
        updated_at: string;
        objectives: Array<{ id: string; statement: string }> | null;
      }>(
        `SELECT l.id AS lesson_id, l.unit_id, u.course_id,
                app_course_organization(u.course_id) AS organization_id,
                l.title, coalesce(l.summary, '') AS summary,
                coalesce(l.content_body, '') AS content_body,
                -- ::text, NOT the bare column. node-pg parses timestamptz
                -- into a JavaScript Date, which is MILLISECOND-resolution,
                -- while the column is MICROSECOND-resolution. Round-tripping
                -- through a Date truncates ...613776 to ...613, and the
                -- freshness equality below is then false for every chunk that
                -- was ever written: retrieval returns nothing, silently, for
                -- everyone. Text is the only lossless carrier, so the value
                -- never leaves that form between reading it and storing it.
                l.updated_at::text AS updated_at,
                (SELECT json_agg(json_build_object('id', o.id, 'statement', o.statement)
                                 ORDER BY o.position)
                   FROM learning_objectives o
                  WHERE o.lesson_id = l.id) AS objectives
           FROM lessons l
           JOIN course_units u ON u.id = l.unit_id
          WHERE u.course_id = $1
            AND l.status = 'published'
            AND u.status = 'published'
          ORDER BY u.position, l.position`,
        [courseId],
      );

      return rows.map((row) => ({
        organizationId: row.organization_id,
        courseId: row.course_id,
        unitId: row.unit_id,
        lessonId: row.lesson_id,
        title: row.title,
        summary: row.summary,
        contentBody: row.content_body,
        updatedAt: row.updated_at,
        objectives: row.objectives ?? [],
      }));
    },

    async unpublishedLessonCount(tx, courseId) {
      const { rows } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n
           FROM lessons l
           JOIN course_units u ON u.id = l.unit_id
          WHERE u.course_id = $1
            AND NOT (l.status = 'published' AND u.status = 'published')`,
        [courseId],
      );
      return Number(rows[0]?.n ?? 0);
    },

    async clearCourseIndex(tx, courseId, model) {
      const { rowCount } = await tx.query(
        'DELETE FROM curriculum_embeddings WHERE course_id = $1 AND embedding_model = $2',
        [courseId, model],
      );
      return rowCount ?? 0;
    },

    async insertChunks(tx, chunks, vectors, model, sourceUpdatedAtByLesson) {
      if (chunks.length === 0) return 0;
      if (chunks.length !== vectors.length) {
        // The embedding contract is positional. A provider that returned a
        // different length would silently pair chunk N's text with chunk M's
        // vector — a retrieval index that quotes the wrong passage.
        throw new Error(
          `Embedding count ${vectors.length} does not match chunk count ${chunks.length}`,
        );
      }

      // `unnest` over parallel arrays: one statement for the whole course
      // rather than a round trip per chunk. `course_id` and `unit_id` are sent
      // as placeholders and OVERWRITTEN by the ancestry trigger — passed
      // explicitly so that overwrite is visible in the source.
      const lessonIds: string[] = [];
      const indexes: number[] = [];
      const contents: string[] = [];
      const literals: string[] = [];
      const stamps: string[] = [];
      const metadata: string[] = [];

      for (const [i, chunk] of chunks.entries()) {
        const stamp = sourceUpdatedAtByLesson.get(chunk.lessonId);
        if (stamp === undefined) {
          throw new Error(`No source timestamp for lesson ${chunk.lessonId}`);
        }
        lessonIds.push(chunk.lessonId);
        indexes.push(chunk.chunkIndex);
        contents.push(chunk.content);
        literals.push(toVectorLiteral(vectors[i] ?? []));
        stamps.push(stamp);
        metadata.push(
          JSON.stringify(
            chunk.objectiveId === undefined
              ? { kind: chunk.kind }
              : { kind: chunk.kind, objectiveId: chunk.objectiveId },
          ),
        );
      }

      const { rowCount } = await tx.query(
        `INSERT INTO curriculum_embeddings
           (lesson_id, course_id, unit_id, chunk_index, chunk_content,
            embedding, embedding_model, source_updated_at, metadata)
         SELECT t.lesson_id,
                t.lesson_id,   -- overwritten by curriculum_embeddings_ancestry
                t.lesson_id,   -- overwritten by curriculum_embeddings_ancestry
                t.chunk_index, t.content, t.embedding::vector, $7, t.source_updated_at,
                t.metadata::jsonb
           FROM unnest($1::uuid[], $2::int[], $3::text[], $4::text[],
                       $5::timestamptz[], $6::text[])
                AS t(lesson_id, chunk_index, content, embedding, source_updated_at, metadata)`,
        [lessonIds, indexes, contents, literals, stamps, metadata, model],
      );
      return rowCount ?? 0;
    },

    async coursesInScope(tx, actorId) {
      // `app_actor_studies_course` answers about the CURRENT actor, so this
      // asks the enrolment graph directly and passes the id explicitly — the
      // caller only ever supplies its own. RLS on these tables applies as well.
      const { rows } = await tx.query<{ course_id: string }>(
        `SELECT DISTINCT a.course_id
           FROM class_course_assignments a
           JOIN classes c            ON c.id = a.class_id
           JOIN class_memberships cm ON cm.class_id = a.class_id
           JOIN courses co           ON co.id = a.course_id
          WHERE cm.user_id = $1
            AND a.status  = 'active'
            AND c.status  = 'active'
            AND cm.status = 'active'
            AND co.status = 'published'`,
        [actorId],
      );
      return rows.map((r) => r.course_id);
    },

    async similar(tx, options) {
      // AN EMPTY SCOPE IS AN EMPTY RESULT, decided here rather than in SQL.
      // `= ANY('{}')` would be correct too, but returning early makes the
      // property impossible to lose to a later edit of the predicate: with no
      // courses there is no query at all.
      if (options.courseIds.length === 0) return [];

      const { rows } = await tx.query<{
        id: string;
        kind: string;
        course_id: string;
        course_title: string;
        unit_id: string;
        lesson_id: string;
        lesson_title: string;
        chunk_index: number;
        chunk_content: string;
        distance: string;
      }>(
        `SELECT e.id,
                coalesce(e.metadata ->> 'kind', 'lesson') AS kind,
                e.course_id, c.title AS course_title,
                e.unit_id, e.lesson_id, l.title AS lesson_title,
                e.chunk_index, e.chunk_content,
                (e.embedding <=> $2::vector) AS distance
           FROM curriculum_embeddings e
           -- THE MANDATORY JOIN. Lifecycle and Row Level Security are inherited
           -- from these live rows on every query, which is why an archived
           -- lesson needs no invalidation path.
           JOIN lessons l      ON l.id = e.lesson_id
           JOIN course_units u ON u.id = l.unit_id
           JOIN courses c      ON c.id = u.course_id
          WHERE e.course_id = ANY($1::uuid[])
            AND e.embedding_model = $3
            AND u.status = 'published'
            AND c.status = 'published'
            -- THE FRESHNESS GUARD, as a column comparison. See the note above
            -- this function for why it is an equality and not a recomputation.
            AND e.source_updated_at = l.updated_at
            AND ($4::uuid IS NULL OR e.lesson_id = $4)
          ORDER BY e.embedding <=> $2::vector
          LIMIT $5`,
        [
          options.courseIds,
          toVectorLiteral(options.queryVector),
          options.model,
          options.lessonId ?? null,
          options.topK,
        ],
      );

      return rows.map((row) => ({
        id: row.id,
        kind: row.kind === 'objective' ? ('objective' as const) : ('lesson' as const),
        courseId: row.course_id,
        courseTitle: row.course_title,
        unitId: row.unit_id,
        lessonId: row.lesson_id,
        lessonTitle: row.lesson_title,
        chunkIndex: row.chunk_index,
        content: row.chunk_content,
        // `numeric`/`float8` arrives as a string from `pg` in some shapes;
        // parsing here keeps the boundary in one place.
        distance: Number(row.distance),
      }));
    },
  };
}
