import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../apps/api/src/platform/db.ts';
import { TEST_APP_URL } from '../setup/env.ts';
import {
  addClassMember,
  asVectorLiteral,
  assignCourseToClass,
  closeSeedDb,
  createClass,
  createCourse,
  createCurriculum,
  createEducationLevel,
  createEmbedding,
  createLesson,
  createOrganization,
  createUnit,
  createUser,
  seedDb,
  testVector,
  truncateAll,
} from '../setup/fixtures.ts';

/**
 * Row-Level Security for the curriculum vector index.
 *
 * No application code is in the path. Every statement runs as `edu_app`
 * (NOBYPASSRLS, non-owner) with `app.actor_id` set exactly as a request would
 * set it. If the entire retrieval service were deleted tomorrow, these are the
 * boundaries that would still hold — which is the claim 0026 makes when it says
 * the visibility of an embedding IS the visibility of its lesson rather than a
 * copy of it.
 *
 * THE VECTOR SEARCHES BELOW ARE DELIBERATELY UNSCOPED IN SQL. Every query says
 * `ORDER BY embedding <=> $1` with no course or organization predicate, because
 * the point is to prove that RLS ALONE returns nothing across a boundary. The
 * application's pre-filter is a second gate, asserted separately in
 * `tests/security/layered-defense.test.ts` with RLS switched off.
 */
const db: Database = createDatabase({ connectionString: TEST_APP_URL, poolMax: 4 });

afterAll(async () => {
  await db.close();
  await closeSeedDb();
});

beforeEach(truncateAll);

async function attempt(actorId: string, sql: string, params: unknown[] = []): Promise<boolean> {
  try {
    const result = await db.withActor(actorId, (tx) => tx.query(sql, params));
    return (result.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

async function rows<T extends Record<string, unknown>>(
  actorId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return db.withActor(actorId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

/** An unscoped nearest-neighbour search. What RLS alone permits. */
async function nearest(actorId: string, seed = 1): Promise<string[]> {
  const found = await rows<{ chunk_content: string }>(
    actorId,
    `SELECT chunk_content FROM curriculum_embeddings
      ORDER BY embedding <=> $1::vector
      LIMIT 50`,
    [asVectorLiteral(testVector(seed))],
  );
  return found.map((r) => r.chunk_content);
}

/**
 * Two schools. School A has an assigned course, an UNassigned course, a draft
 * lesson and an archived lesson — every exclusion the task names, in one world.
 */
async function world() {
  const orgA = await createOrganization('School A');
  const orgB = await createOrganization('School B');
  const level = await createEducationLevel();

  const mk = (email: string, roles: readonly string[], org: string | null) =>
    createUser({ email, roles, organizationId: org });

  const learnerA = await mk('learner@a.test', ['student'], orgA);
  const learnerB = await mk('learner@b.test', ['student'], orgB);
  const outsiderA = await mk('outsider@a.test', ['student'], orgA);
  const authorA = await mk('author@a.test', ['content_author'], orgA);
  const authorB = await mk('author@b.test', ['content_author'], orgB);

  // ── School A ──────────────────────────────────────────────────────────────
  const curriculumA = await createCurriculum({ organizationId: orgA, status: 'published' });
  const assigned = await createCourse({
    organizationId: orgA,
    curriculumId: curriculumA,
    levelId: level,
    title: 'Assigned',
    status: 'published',
  });
  const unitA = await createUnit({ courseId: assigned, status: 'published' });
  const lessonA = await createLesson({
    unitId: unitA,
    title: 'Cells',
    status: 'published',
    contentBody: 'Mitochondria are the powerhouse of the cell.',
  });
  const draftLesson = await createLesson({
    unitId: unitA,
    title: 'Draft cells',
    status: 'draft',
    contentBody: 'Unpublished material about mitochondria.',
    position: 2,
  });
  const archivedLesson = await createLesson({
    unitId: unitA,
    title: 'Retired cells',
    status: 'archived',
    contentBody: 'Retired material about mitochondria.',
    position: 3,
  });

  const unassignedCourse = await createCourse({
    organizationId: orgA,
    curriculumId: curriculumA,
    levelId: level,
    title: 'Unassigned',
    status: 'published',
  });
  const unassignedUnit = await createUnit({ courseId: unassignedCourse, status: 'published' });
  const unassignedLesson = await createLesson({
    unitId: unassignedUnit,
    title: 'Unassigned cells',
    status: 'published',
    contentBody: 'Unassigned material about mitochondria.',
  });

  // ── School B ──────────────────────────────────────────────────────────────
  const curriculumB = await createCurriculum({
    organizationId: orgB,
    code: 'sci',
    status: 'published',
  });
  const courseB = await createCourse({
    organizationId: orgB,
    curriculumId: curriculumB,
    levelId: level,
    title: 'School B science',
    status: 'published',
  });
  const unitB = await createUnit({ courseId: courseB, status: 'published' });
  const lessonB = await createLesson({
    unitId: unitB,
    title: 'B cells',
    status: 'published',
    contentBody: 'School B material about mitochondria.',
  });

  const classA = await createClass(orgA, 'A1');
  await addClassMember(classA, learnerA.id);
  await assignCourseToClass({ classId: classA, courseId: assigned });

  const classB = await createClass(orgB, 'B1');
  await addClassMember(classB, learnerB.id);
  await assignCourseToClass({ classId: classB, courseId: courseB });

  return {
    orgA,
    orgB,
    learnerA,
    learnerB,
    outsiderA,
    authorA,
    authorB,
    assigned,
    unitA,
    lessonA,
    draftLesson,
    archivedLesson,
    unassignedCourse,
    unassignedLesson,
    courseB,
    lessonB,
    classA,
  };
}

describe('an author writes embeddings through the application role', () => {
  /**
   * THE BLOCK VULN-042 SAYS MUST EXIST.
   *
   * Every other fixture here seeds as superuser. Without this, no INSERT policy
   * on this table would be exercised at all — which is exactly how a policy
   * that refused every legitimate author survived a full suite two tasks ago.
   * `RETURNING` is on the insert deliberately: it forces the SELECT policy to
   * admit the new row, which is the half of that defect that is invisible
   * without it.
   */
  it('inserts a chunk for a lesson it can see, with RETURNING', async () => {
    const w = await world();
    const inserted = await rows<{ id: string; course_id: string; organization_id: string }>(
      w.authorA.id,
      `INSERT INTO curriculum_embeddings
         (lesson_id, course_id, unit_id, chunk_index, chunk_content,
          embedding, embedding_model, source_updated_at)
       VALUES ($1, $2, $2, 0, 'a chunk', $3::vector, 'test-model', now())
       RETURNING id, course_id, organization_id`,
      [w.lessonA, '00000000-0000-4000-8000-000000000000', asVectorLiteral(testVector(1))],
    );
    expect(inserted).toHaveLength(1);
    // ANCESTRY IS DERIVED. The forged course and unit ids above were discarded
    // and the live tree written in their place.
    expect(inserted[0]?.course_id).toBe(w.assigned);
    expect(inserted[0]?.organization_id).toBe(w.orgA);
  });

  it('refuses an author at ANOTHER school', async () => {
    const w = await world();
    expect(
      await attempt(
        w.authorB.id,
        `INSERT INTO curriculum_embeddings
           (lesson_id, course_id, unit_id, chunk_index, chunk_content,
            embedding, embedding_model, source_updated_at)
         VALUES ($1, $2, $2, 0, 'x', $3::vector, 'm', now())`,
        [w.lessonA, '00000000-0000-4000-8000-000000000000', asVectorLiteral(testVector(1))],
      ),
    ).toBe(false);
  });

  it('refuses a LEARNER inserting a chunk', async () => {
    const w = await world();
    expect(
      await attempt(
        w.learnerA.id,
        `INSERT INTO curriculum_embeddings
           (lesson_id, course_id, unit_id, chunk_index, chunk_content,
            embedding, embedding_model, source_updated_at)
         VALUES ($1, $2, $2, 0, 'x', $3::vector, 'm', now())`,
        [w.lessonA, '00000000-0000-4000-8000-000000000000', asVectorLiteral(testVector(1))],
      ),
    ).toBe(false);
  });

  it('refuses a learner DELETING a chunk', async () => {
    const w = await world();
    await createEmbedding({ lessonId: w.lessonA });
    expect(await attempt(w.learnerA.id, 'DELETE FROM curriculum_embeddings', [])).toBe(false);
  });

  it('has no UPDATE privilege at all, so a vector cannot drift from its text', async () => {
    const seed = await seedDb();
    const { rows: grants } = await seed.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'edu_app' AND table_name = 'curriculum_embeddings'
        ORDER BY privilege_type`,
    );
    expect(grants.map((g) => g.privilege_type)).toEqual(['DELETE', 'INSERT', 'SELECT']);
  });
});

describe('§2E — cross-tenant vector similarity leaks nothing', () => {
  it('returns ZERO of school A’s chunks to a school B learner, on an unscoped search', async () => {
    // The query has no organization predicate. Anything it returns, RLS let
    // through — so an empty result is the database refusing, not the caller
    // being careful.
    const w = await world();
    await createEmbedding({ lessonId: w.lessonA, chunkContent: 'School A secret material' });

    const seen = await nearest(w.learnerB.id);
    expect(seen).toEqual([]);
  });

  it('returns ZERO of school B’s chunks to a school A learner', async () => {
    const w = await world();
    await createEmbedding({ lessonId: w.lessonB, chunkContent: 'School B material' });
    expect(await nearest(w.learnerA.id)).toEqual([]);
  });

  it('gives each school its own, so the two emptinesses above are not vacuous', async () => {
    const w = await world();
    await createEmbedding({ lessonId: w.lessonA, chunkContent: 'A material' });
    await createEmbedding({ lessonId: w.lessonB, chunkContent: 'B material' });

    expect(await nearest(w.learnerA.id)).toEqual(['A material']);
    expect(await nearest(w.learnerB.id)).toEqual(['B material']);
  });

  it('hides everything from an author at another school too', async () => {
    const w = await world();
    await createEmbedding({ lessonId: w.lessonA, chunkContent: 'A material' });
    expect(await nearest(w.authorB.id)).toEqual([]);
  });
});

describe('§2E — draft and archived curriculum never reaches a learner', () => {
  it('excludes chunks of a DRAFT lesson', async () => {
    const w = await world();
    await createEmbedding({ lessonId: w.lessonA, chunkContent: 'published' });
    await createEmbedding({ lessonId: w.draftLesson, chunkContent: 'draft material' });

    expect(await nearest(w.learnerA.id)).toEqual(['published']);
  });

  it('excludes chunks of an ARCHIVED lesson', async () => {
    const w = await world();
    await createEmbedding({ lessonId: w.lessonA, chunkContent: 'published' });
    await createEmbedding({ lessonId: w.archivedLesson, chunkContent: 'retired material' });

    expect(await nearest(w.learnerA.id)).toEqual(['published']);
  });

  it('shows a draft chunk to the AUTHOR, so the exclusion is the learner’s and not the row’s', async () => {
    const w = await world();
    await createEmbedding({ lessonId: w.draftLesson, chunkContent: 'draft material' });
    expect(await nearest(w.authorA.id)).toContain('draft material');
  });

  it('stops returning a chunk the moment its lesson is archived', async () => {
    // No invalidation path, and this is the test that says so: the chunk is
    // untouched and becomes unreachable because the LESSON moved.
    const w = await world();
    await createEmbedding({ lessonId: w.lessonA, chunkContent: 'published' });
    expect(await nearest(w.learnerA.id)).toEqual(['published']);

    const seed = await seedDb();
    await seed.query(
      `UPDATE lessons SET status = 'archived', published_at = NULL, archived_at = now()
        WHERE id = $1`,
      [w.lessonA],
    );

    expect(await nearest(w.learnerA.id)).toEqual([]);
    // The row is still there. It is the visibility that changed.
    const { rows: still } = await seed.query('SELECT id FROM curriculum_embeddings');
    expect(still).toHaveLength(1);
  });
});

describe('§2E — a course the learner is not assigned is not searchable', () => {
  it('excludes chunks from an unassigned course in the same school', async () => {
    const w = await world();
    await createEmbedding({ lessonId: w.lessonA, chunkContent: 'assigned material' });
    await createEmbedding({ lessonId: w.unassignedLesson, chunkContent: 'unassigned material' });

    expect(await nearest(w.learnerA.id)).toEqual(['assigned material']);
  });

  it('excludes everything from a learner in no class at all', async () => {
    const w = await world();
    await createEmbedding({ lessonId: w.lessonA, chunkContent: 'assigned material' });
    expect(await nearest(w.outsiderA.id)).toEqual([]);
  });

  it('stops returning chunks the moment the course is withdrawn from the class', async () => {
    const w = await world();
    await createEmbedding({ lessonId: w.lessonA, chunkContent: 'assigned material' });
    expect(await nearest(w.learnerA.id)).toHaveLength(1);

    const seed = await seedDb();
    await seed.query(
      `UPDATE class_course_assignments SET status = 'archived', ended_at = now()
        WHERE class_id = $1`,
      [w.classA],
    );

    expect(await nearest(w.learnerA.id)).toEqual([]);
  });

  it('stops returning chunks the moment the learner leaves the class', async () => {
    const w = await world();
    await createEmbedding({ lessonId: w.lessonA, chunkContent: 'assigned material' });

    const seed = await seedDb();
    await seed.query(
      `UPDATE class_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1`,
      [w.learnerA.id],
    );

    expect(await nearest(w.learnerA.id)).toEqual([]);
  });
});

describe('similarity actually orders, and only orders', () => {
  it('returns the nearer chunk first', async () => {
    const w = await world();
    await createEmbedding({ lessonId: w.lessonA, chunkContent: 'far', seed: 40, chunkIndex: 0 });
    await createEmbedding({ lessonId: w.lessonA, chunkContent: 'near', seed: 1, chunkIndex: 1 });

    expect(await nearest(w.learnerA.id, 1)).toEqual(['near', 'far']);
  });

  it('cannot promote a chunk across a boundary, however near it is', async () => {
    // The whole security claim of 0023 and 0026, as one assertion: an EXACT
    // vector match in another school still returns nothing.
    const w = await world();
    await createEmbedding({ lessonId: w.lessonB, chunkContent: 'exact match', seed: 7 });
    expect(await nearest(w.learnerA.id, 7)).toEqual([]);
  });
});

describe('the schema keeps a chunk honest', () => {
  it('deletes chunks when their lesson is deleted', async () => {
    const w = await world();
    await createEmbedding({ lessonId: w.lessonA });
    const seed = await seedDb();
    await seed.query('DELETE FROM lessons WHERE id = $1', [w.lessonA]);
    const { rows: left } = await seed.query('SELECT id FROM curriculum_embeddings');
    expect(left).toEqual([]);
  });

  it('refuses a second chunk with the same lesson, model and index', async () => {
    const w = await world();
    await createEmbedding({ lessonId: w.lessonA, chunkIndex: 0 });
    await expect(createEmbedding({ lessonId: w.lessonA, chunkIndex: 0 })).rejects.toThrow(
      /curriculum_embeddings_chunk_uk/,
    );
  });

  it('permits the same index under a DIFFERENT model, so a re-index can overlap', async () => {
    const w = await world();
    await createEmbedding({ lessonId: w.lessonA, chunkIndex: 0, embeddingModel: 'old' });
    await expect(
      createEmbedding({ lessonId: w.lessonA, chunkIndex: 0, embeddingModel: 'new' }),
    ).resolves.toBeTruthy();
  });

  it('records the lesson’s own updated_at, so freshness is an equality', async () => {
    const w = await world();
    await createEmbedding({ lessonId: w.lessonA });
    const seed = await seedDb();
    const { rows: pair } = await seed.query<{ same: boolean }>(
      `SELECT (e.source_updated_at = l.updated_at) AS same
         FROM curriculum_embeddings e JOIN lessons l ON l.id = e.lesson_id`,
    );
    expect(pair[0]?.same).toBe(true);
  });

  it('leaves a chunk stale — not deleted — when its lesson is edited', async () => {
    // The freshness guard's whole point: an edit does not corrupt the index, it
    // makes it invisible until re-indexed. The row survives; the retrieval
    // query is what skips it, asserted end to end in the security suite.
    const w = await world();
    await createEmbedding({ lessonId: w.lessonA });
    const seed = await seedDb();
    await seed.query(
      `UPDATE lessons SET content_body = 'edited', updated_at = now() + interval '1 second'
        WHERE id = $1`,
      [w.lessonA],
    );
    const { rows: pair } = await seed.query<{ same: boolean }>(
      `SELECT (e.source_updated_at = l.updated_at) AS same
         FROM curriculum_embeddings e JOIN lessons l ON l.id = e.lesson_id`,
    );
    expect(pair[0]?.same).toBe(false);
  });

  it('refuses a vector of the wrong dimension', async () => {
    const w = await world();
    const seed = await seedDb();
    await expect(
      seed.query(
        `INSERT INTO curriculum_embeddings
           (lesson_id, course_id, unit_id, chunk_index, chunk_content,
            embedding, embedding_model, source_updated_at)
         VALUES ($1, $1, $1, 0, 'x', $2::vector, 'm', now())`,
        [w.lessonA, asVectorLiteral(testVector(1, 12))],
      ),
    ).rejects.toThrow(/expected 768 dimensions/i);
  });
});
