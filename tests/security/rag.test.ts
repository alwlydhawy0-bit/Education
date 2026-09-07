import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  buildTestApp,
  sessionCookieFrom,
  writeHeaders,
  type TestApp,
} from '../setup/app.ts';
import { TEST_SUPERUSER_URL } from '../setup/env.ts';
import {
  addClassMember,
  assignCourseToClass,
  closeSeedDb,
  createClass,
  createCourse,
  createCurriculum,
  createEducationLevel,
  createLesson,
  createOrganization,
  createUnit,
  createUser,
  grantRole,
  truncateAll,
} from '../setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';

/**
 * The knowledge base and RAG retrieval, end to end over the real HTTP stack.
 *
 * Nothing is stubbed: the same composition root, the same policy engine, the
 * same `edu_app` role, the same pgvector index. This is the file section 2E of
 * the task names, and every scenario it lists is marked so a claim in the
 * report traces to a test that ran.
 *
 * The RLS half is `tests/integration/rls-embeddings.test.ts`, with no
 * application code in the path; the chunker and the embedder are in
 * `tests/unit/knowledge-chunking.test.ts`. None is sufficient alone.
 */
const testApp: TestApp = await buildTestApp();

const PASSWORD = 'a-sufficiently-long-passphrase'; // secret-scan-allow: test fixture password

interface Session {
  readonly id: string;
  readonly cookie: string;
}

async function seedAndLogin(options: {
  email: string;
  roles?: readonly string[];
  organizationId?: string | null;
  globalSecurityAdmin?: boolean;
}): Promise<Session> {
  const user = await createUser({
    email: options.email,
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.organizationId !== undefined ? { organizationId: options.organizationId } : {}),
    passwordHash: await hashPassword(PASSWORD),
  });
  if (options.globalSecurityAdmin) await grantRole(user.id, 'security_admin', 'global', null);
  const response = await testApp.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: writeHeaders,
    payload: { email: options.email, password: PASSWORD },
  });
  if (response.statusCode !== 204) {
    throw new Error(`login failed for ${options.email}: ${response.statusCode} ${response.body}`);
  }
  return {
    id: user.id,
    cookie: `edu_session=${sessionCookieFrom(response.headers['set-cookie'])}`,
  };
}

const post = (url: string, cookie: string, payload?: Record<string, unknown>) =>
  testApp.app.inject({
    method: 'POST',
    url,
    headers: { ...writeHeaders, cookie },
    payload: payload ?? {},
  });

interface RagResponse {
  chunks: Array<{ content: string; lessonId: string; courseId: string; distance: number }>;
  coursesInScope: number;
  embeddingModel: string;
}

const retrieve = async (
  who: Session,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: RagResponse }> => {
  const r = await post('/api/v1/rag/retrieve', who.cookie, payload);
  return { status: r.statusCode, body: r.json<RagResponse>() };
};

async function asSuperuser(sql: string, params: unknown[] = []): Promise<void> {
  const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
  await raw.connect();
  try {
    await raw.query(sql, params);
  } finally {
    await raw.end();
  }
}

async function auditTypes(): Promise<string[]> {
  const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
  await raw.connect();
  try {
    const { rows } = await raw.query<{ event_type: string }>('SELECT event_type FROM audit_log');
    return rows.map((r) => r.event_type);
  } finally {
    await raw.end();
  }
}

const MITOCHONDRIA =
  'Mitochondria are the powerhouse of the cell and produce adenosine triphosphate energy.';

/**
 * Two schools. School A has an assigned course, an unassigned one, and a draft
 * lesson inside the assigned course - every exclusion the task names.
 */
async function world() {
  const orgA = await createOrganization('School A');
  const orgB = await createOrganization('School B');
  const level = await createEducationLevel();

  const learnerA = await seedAndLogin({
    email: 'learner@a.test',
    roles: ['student'],
    organizationId: orgA,
  });
  const learnerB = await seedAndLogin({
    email: 'learner@b.test',
    roles: ['student'],
    organizationId: orgB,
  });
  const outsiderA = await seedAndLogin({
    email: 'outsider@a.test',
    roles: ['student'],
    organizationId: orgA,
  });
  const reviewerA = await seedAndLogin({
    email: 'reviewer@a.test',
    roles: ['reviewer'],
    organizationId: orgA,
  });
  const reviewerB = await seedAndLogin({
    email: 'reviewer@b.test',
    roles: ['reviewer'],
    organizationId: orgB,
  });
  const authorA = await seedAndLogin({
    email: 'author@a.test',
    roles: ['content_author'],
    organizationId: orgA,
  });

  const curriculumA = await createCurriculum({ organizationId: orgA, status: 'published' });
  const assigned = await createCourse({
    organizationId: orgA,
    curriculumId: curriculumA,
    levelId: level,
    title: 'Assigned biology',
    status: 'published',
  });
  const unitA = await createUnit({ courseId: assigned, status: 'published' });
  const lessonA = await createLesson({
    unitId: unitA,
    title: 'Cells',
    status: 'published',
    contentBody: MITOCHONDRIA,
  });
  const draftLesson = await createLesson({
    unitId: unitA,
    title: 'Draft cells',
    status: 'draft',
    position: 2,
    contentBody: 'DRAFTSECRET mitochondria material not yet published to anybody.',
  });

  const unassigned = await createCourse({
    organizationId: orgA,
    curriculumId: curriculumA,
    levelId: level,
    title: 'Unassigned chemistry',
    status: 'published',
  });
  const unassignedUnit = await createUnit({ courseId: unassigned, status: 'published' });
  const unassignedLesson = await createLesson({
    unitId: unassignedUnit,
    title: 'Unassigned',
    status: 'published',
    contentBody: `UNASSIGNEDSECRET ${MITOCHONDRIA}`,
  });

  const curriculumB = await createCurriculum({
    organizationId: orgB,
    code: 'sci',
    status: 'published',
  });
  const courseB = await createCourse({
    organizationId: orgB,
    curriculumId: curriculumB,
    levelId: level,
    title: 'School B biology',
    status: 'published',
  });
  const unitB = await createUnit({ courseId: courseB, status: 'published' });
  const lessonB = await createLesson({
    unitId: unitB,
    title: 'B cells',
    status: 'published',
    contentBody: `TENANTBSECRET ${MITOCHONDRIA}`,
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
    level,
    curriculumA,
    learnerA,
    learnerB,
    outsiderA,
    reviewerA,
    reviewerB,
    authorA,
    assigned,
    lessonA,
    draftLesson,
    unassigned,
    unassignedLesson,
    courseB,
    lessonB,
    classA,
  };
}

/** Indexes a course as a reviewer and asserts it worked. */
async function index(who: Session, courseId: string) {
  const r = await post(`/api/v1/curriculum/courses/${courseId}/index`, who.cookie);
  expect(r.statusCode, r.body).toBe(200);
  return r.json<{
    chunksWritten: number;
    chunksRemoved: number;
    lessonsIndexed: number;
    lessonsSkipped: number;
  }>();
}

beforeEach(truncateAll);

afterAll(async () => {
  await testApp.db.close();
  await closeSeedDb();
});

describe('A - the pipeline works for the people it is for', () => {
  it('indexes a published course and retrieves from it', async () => {
    const w = await world();
    const result = await index(w.reviewerA, w.assigned);
    expect(result.lessonsIndexed).toBe(1);
    expect(result.chunksWritten).toBeGreaterThan(0);

    const { status, body } = await retrieve(w.learnerA, { query: 'mitochondria energy' });
    expect(status).toBe(200);
    expect(body.chunks.length).toBeGreaterThan(0);
    expect(body.chunks[0]?.content).toContain('Mitochondria');
    expect(body.coursesInScope).toBe(1);
  });

  it('reports skipped drafts as a count, never as a list of ids', async () => {
    const w = await world();
    const result = await index(w.reviewerA, w.assigned);
    expect(result.lessonsSkipped).toBe(1);
    const raw = JSON.stringify(result);
    expect(raw).not.toContain(w.draftLesson);
  });

  it('replaces rather than appends on re-index', async () => {
    const w = await world();
    const first = await index(w.reviewerA, w.assigned);
    const second = await index(w.reviewerA, w.assigned);
    expect(second.chunksWritten).toBe(first.chunksWritten);
    expect(second.chunksRemoved ?? 0).toBe(first.chunksWritten);

    const { body } = await retrieve(w.learnerA, { query: 'mitochondria', topK: 20 });
    expect(body.chunks).toHaveLength(first.chunksWritten);
  });

  it('honours topK', async () => {
    const w = await world();
    await asSuperuser(
      `UPDATE lessons SET content_body = $2, updated_at = now() WHERE id = $1`,
      [w.lessonA, Array.from({ length: 12 }, (_u, i) => `Paragraph ${i}. ${MITOCHONDRIA}`).join(String.fromCharCode(10, 10))],
    );
    await index(w.reviewerA, w.assigned);
    const { body } = await retrieve(w.learnerA, { query: 'mitochondria', topK: 2 });
    expect(body.chunks).toHaveLength(2);
  });
});

describe('B - section 2E: cross-tenant vector similarity returns zero', () => {
  it('gives a school B learner NOTHING from school A, on an identical query', async () => {
    const w = await world();
    await index(w.reviewerA, w.assigned);
    await index(w.reviewerB, w.courseB);

    const { body } = await retrieve(w.learnerB, { query: 'mitochondria energy' });
    expect(body.chunks.every((c) => !c.content.includes('powerhouse of the cell') || c.courseId === w.courseB)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('School A');
    for (const chunk of body.chunks) expect(chunk.courseId).toBe(w.courseB);
  });

  it('gives a school A learner NOTHING from school B', async () => {
    const w = await world();
    await index(w.reviewerA, w.assigned);
    await index(w.reviewerB, w.courseB);

    const { body } = await retrieve(w.learnerA, { query: 'mitochondria energy' });
    expect(JSON.stringify(body)).not.toContain('TENANTBSECRET');
    for (const chunk of body.chunks) expect(chunk.courseId).toBe(w.assigned);
  });

  it('refuses a school B reviewer indexing a school A course', async () => {
    const w = await world();
    const r = await post(`/api/v1/curriculum/courses/${w.assigned}/index`, w.reviewerB.cookie);
    expect(r.statusCode).toBe(404);
  });

  it('returns an EMPTY RESULT, not a 403, when naming another school course', async () => {
    // A 403 would confirm the id names something real - the one bit somebody
    // enumerating another school catalog is trying to buy.
    const w = await world();
    await index(w.reviewerB, w.courseB);
    const { status, body } = await retrieve(w.learnerA, {
      query: 'mitochondria',
      courseId: w.courseB,
    });
    expect(status).toBe(200);
    expect(body.chunks).toEqual([]);
  });
});

describe('C - section 2E: draft and archived content never reaches a learner', () => {
  it('never indexes a draft lesson in the first place', async () => {
    const w = await world();
    await index(w.reviewerA, w.assigned);
    const { body } = await retrieve(w.learnerA, { query: 'DRAFTSECRET mitochondria', topK: 20 });
    expect(JSON.stringify(body)).not.toContain('DRAFTSECRET');
  });

  it('WRITES NO DRAFT TEXT INTO THE TABLE AT ALL, not merely none into a response', async () => {
    // Read straight from the table as a superuser, past every gate.
    //
    // The response-level test above passes even with the ingestion filter
    // removed, because the retrieval join independently refuses to serve a
    // chunk whose lesson is not published — defence in depth doing its job,
    // and in doing so hiding whether ingestion is filtering at all (defect
    // injection F13 confirmed it).
    //
    // What the ingestion filter uniquely prevents is unpublished wording
    // RESTING in the store: visible in a backup, in a database console, to a
    // DBA, and to whatever query path some future task adds over this table.
    // An author's abandoned draft is not something the knowledge base should
    // be holding, whether or not anything currently serves it.
    const w = await world();
    await index(w.reviewerA, w.assigned);

    const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await raw.connect();
    try {
      const { rows } = await raw.query<{ chunk_content: string; lesson_id: string }>(
        'SELECT chunk_content, lesson_id FROM curriculum_embeddings',
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.chunk_content).not.toContain('DRAFTSECRET');
        expect(row.lesson_id).not.toBe(w.draftLesson);
      }
    } finally {
      await raw.end();
    }
  });

  it('stops returning chunks the moment the lesson is archived, with no re-index', async () => {
    const w = await world();
    await index(w.reviewerA, w.assigned);
    expect((await retrieve(w.learnerA, { query: 'mitochondria' })).body.chunks.length).toBeGreaterThan(0);

    await asSuperuser(
      `UPDATE lessons SET status = 'archived', published_at = NULL, archived_at = now()
        WHERE id = $1`,
      [w.lessonA],
    );

    const { body } = await retrieve(w.learnerA, { query: 'mitochondria' });
    expect(body.chunks).toEqual([]);
  });

  it('stops returning chunks whose lesson has been EDITED since indexing', async () => {
    // The freshness guard. The index holds the old text; serving it would be
    // answering with what the lesson used to say.
    const w = await world();
    await index(w.reviewerA, w.assigned);
    expect((await retrieve(w.learnerA, { query: 'mitochondria' })).body.chunks.length).toBeGreaterThan(0);

    await asSuperuser(
      `UPDATE lessons SET content_body = 'Something entirely different now.',
              updated_at = now() + interval '1 second'
        WHERE id = $1`,
      [w.lessonA],
    );

    const { body } = await retrieve(w.learnerA, { query: 'mitochondria' });
    expect(body.chunks).toEqual([]);
  });

  it('serves the new text again after a re-index', async () => {
    const w = await world();
    await index(w.reviewerA, w.assigned);
    await asSuperuser(
      `UPDATE lessons SET content_body = 'Ribosomes assemble proteins from amino acids.',
              updated_at = now() + interval '1 second'
        WHERE id = $1`,
      [w.lessonA],
    );
    await index(w.reviewerA, w.assigned);

    const { body } = await retrieve(w.learnerA, { query: 'ribosomes proteins' });
    expect(body.chunks.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).toContain('Ribosomes');
    expect(JSON.stringify(body)).not.toContain('powerhouse');
  });

  it('refuses to index a DRAFT course at all', async () => {
    // Born a draft, rather than demoted from published: migration 0022 forbids
    // that transition outright, and the first version of this test tripped
    // over it. Content that has been published stays published or is archived,
    // so "a draft course" can only mean one that was never published.
    const w = await world();
    const draftCourse = await createCourse({
      organizationId: w.orgA,
      curriculumId: w.curriculumA,
      levelId: w.level,
      title: 'Draft physics',
      status: 'draft',
    });
    const r = await post(`/api/v1/curriculum/courses/${draftCourse}/index`, w.reviewerA.cookie);
    // 403 rather than 404: the reviewer has editorial standing here and can
    // already see the course, so it is the STATE axis refusing, and that axis
    // reveals. Contrast the learner in group E, whom the SCOPE axis hides from.
    expect(r.statusCode).toBe(403);
  });
});

describe('D - section 2E: an unassigned course is not searchable', () => {
  it('excludes a published course in the same school that is assigned to nobody', async () => {
    const w = await world();
    await index(w.reviewerA, w.assigned);
    await index(w.reviewerA, w.unassigned);

    const { body } = await retrieve(w.learnerA, { query: 'mitochondria', topK: 20 });
    expect(JSON.stringify(body)).not.toContain('UNASSIGNEDSECRET');
    for (const chunk of body.chunks) expect(chunk.courseId).toBe(w.assigned);
  });

  it('gives a learner in no class an empty result and a zero scope', async () => {
    const w = await world();
    await index(w.reviewerA, w.assigned);
    const { status, body } = await retrieve(w.outsiderA, { query: 'mitochondria' });
    expect(status).toBe(200);
    expect(body.chunks).toEqual([]);
    expect(body.coursesInScope).toBe(0);
  });

  it('stops returning chunks the moment the course is withdrawn from the class', async () => {
    const w = await world();
    await index(w.reviewerA, w.assigned);
    await asSuperuser(
      `UPDATE class_course_assignments SET status = 'archived', ended_at = now()
        WHERE class_id = $1`,
      [w.classA],
    );
    const { body } = await retrieve(w.learnerA, { query: 'mitochondria' });
    expect(body.chunks).toEqual([]);
    expect(body.coursesInScope).toBe(0);
  });

  it('stops returning chunks the moment the learner leaves the class', async () => {
    const w = await world();
    await index(w.reviewerA, w.assigned);
    await asSuperuser(
      `UPDATE class_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1`,
      [w.learnerA.id],
    );
    expect((await retrieve(w.learnerA, { query: 'mitochondria' })).body.chunks).toEqual([]);
  });

  it('narrows, never widens, when a client sends a courseId it CAN reach', async () => {
    const w = await world();
    await index(w.reviewerA, w.assigned);
    const { body } = await retrieve(w.learnerA, {
      query: 'mitochondria',
      courseId: w.assigned,
    });
    expect(body.chunks.length).toBeGreaterThan(0);
  });
});

describe('E - indexing is a publish-level authority', () => {
  it('refuses a learner, and does not admit the endpoint applies to them', async () => {
    // 404, NOT 403, and the difference is the point. Indexing is a write verb,
    // and `contentPolicy` hides every write from an actor without editorial
    // standing in the catalog — the same answer a learner gets for create,
    // update, delete and publish. A 403 here would tell a child that this
    // course has a knowledge-base entry and that some authority governs it.
    // The learner is studying this very course, so the existence of the COURSE
    // is not what is being concealed; the existence of the OPERATION is.
    const w = await world();
    const r = await post(`/api/v1/curriculum/courses/${w.assigned}/index`, w.learnerA.cookie);
    expect(r.statusCode).toBe(404);
  });

  it('refuses a content AUTHOR, who may write but not decide what is served', async () => {
    // The separation of duties: writing content and deciding that learners may
    // be told it are different authorities, and indexing is the second.
    const w = await world();
    const r = await post(`/api/v1/curriculum/courses/${w.assigned}/index`, w.authorA.cookie);
    expect(r.statusCode).toBe(403);
  });

  it('refuses a body, rather than ignoring a forged one', async () => {
    const w = await world();
    const r = await post(`/api/v1/curriculum/courses/${w.assigned}/index`, w.reviewerA.cookie, {
      organizationId: w.orgB,
    });
    expect(r.statusCode).toBe(400);
  });

  it('answers 404 for a course that does not exist', async () => {
    const w = await world();
    void w;
    const r = await post(
      '/api/v1/curriculum/courses/00000000-0000-4000-8000-000000000000/index',
      (await seedAndLogin({ email: 'rev2@a.test', roles: ['reviewer'] })).cookie,
    );
    expect(r.statusCode).toBe(404);
  });
});

describe('F - the response discloses nothing beyond the passage', () => {
  it('carries no embedding, no organization and no source timestamp', async () => {
    const w = await world();
    await index(w.reviewerA, w.assigned);
    const { body } = await retrieve(w.learnerA, { query: 'mitochondria' });
    const chunk = body.chunks[0] as unknown as Record<string, unknown>;
    expect(chunk).toBeDefined();
    for (const forbidden of ['embedding', 'organizationId', 'sourceUpdatedAt', 'source_updated_at']) {
      expect(Object.keys(chunk ?? {})).not.toContain(forbidden);
    }
  });

  it('refuses an unknown request field rather than ignoring it', async () => {
    const w = await world();
    const r = await post('/api/v1/rag/retrieve', w.learnerA.cookie, {
      query: 'x',
      embedding: [0.1, 0.2],
    });
    expect(r.statusCode).toBe(400);
  });

  it('refuses a GET, so a question never lands in an access log', async () => {
    const w = await world();
    const r = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/rag/retrieve?query=something+private',
      headers: { cookie: w.learnerA.cookie },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('G - the audit trail records the right things and not the question', () => {
  it('records an index rebuild with counts and the model', async () => {
    const w = await world();
    await index(w.reviewerA, w.assigned);
    expect(await auditTypes()).toContain('knowledge.index_rebuilt');
  });

  it('records an empty scope without recording the query text', async () => {
    const w = await world();
    await retrieve(w.outsiderA, { query: 'a private question about my difficulties' });
    expect(await auditTypes()).toContain('knowledge.retrieval_empty_scope');

    const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await raw.connect();
    try {
      const { rows } = await raw.query<{ detail: unknown }>('SELECT detail FROM audit_log');
      expect(JSON.stringify(rows.map((r) => r.detail))).not.toContain('my difficulties');
    } finally {
      await raw.end();
    }
  });

  it('does NOT record an ordinary successful retrieval', async () => {
    // A learner asking a question is not a security event, and logging every
    // one would build a record of what each child does not understand.
    const w = await world();
    await index(w.reviewerA, w.assigned);
    const before = (await auditTypes()).filter((t) => t.startsWith('knowledge.')).length;
    await retrieve(w.learnerA, { query: 'mitochondria' });
    const after = (await auditTypes()).filter((t) => t.startsWith('knowledge.')).length;
    expect(after).toBe(before);
  });
});
