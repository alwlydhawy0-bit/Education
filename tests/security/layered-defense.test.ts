import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildTestApp, sessionCookieFrom, writeHeaders, type TestApp } from '../setup/app.ts';
import {
  closeSeedDb,
  createCourse,
  createCurriculum,
  createEducationLevel,
  createLesson,
  createOrganization,
  createUnit,
  createUser,
  linkGuardian,
  truncateAll,
} from '../setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';

/**
 * Layer isolation: does the APPLICATION authorization layer stand on its own?
 *
 * The other IDOR tests pass with both gates active, which means a passing suite
 * cannot tell you WHICH gate did the work. If RLS were silently carrying the
 * whole load, the tests would look identical — right up until someone
 * introduced a query path RLS did not cover.
 *
 * So this suite runs the entire application against `edu_app_norls`: the same
 * grants as the production role, but with BYPASSRLS. Every row is visible to
 * the database client. If cross-user access is still refused, the refusal came
 * from the policy engine and `Guarded`, not from the database.
 *
 * The mirror-image case (RLS standing alone, with the application layer
 * removed) is covered by tests/integration/rls.test.ts, which queries the
 * database directly with no application code in the path.
 */
const NO_RLS_URL =
  process.env['TEST_APP_NORLS_URL'] ??
  'postgres://edu_app_norls:norls_test_pw@127.0.0.1:5432/edu_test'; // secret-scan-allow: local test database default, no production value

let testApp: TestApp;
let app: FastifyInstance;

const PASSWORD = 'a-sufficiently-long-passphrase'; // secret-scan-allow: test fixture password for a throwaway test database

async function registerAndLogin(email: string): Promise<{ cookie: string; id: string }> {
  const registered = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: writeHeaders,
    payload: { email, password: PASSWORD, displayName: 'Test User' },
  });
  expect(registered.statusCode).toBe(201);
  const { id } = registered.json<{ id: string }>();

  const loggedIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: writeHeaders,
    payload: { email, password: PASSWORD },
  });
  expect(loggedIn.statusCode).toBe(204);
  return { cookie: `edu_session=${sessionCookieFrom(loggedIn.headers['set-cookie'])}`, id };
}

beforeEach(async () => {
  await truncateAll();
  testApp = await buildTestApp({ DATABASE_URL: NO_RLS_URL });
  app = testApp.app;
});

afterAll(async () => {
  await testApp?.db.close();
  await closeSeedDb();
});

describe('the test role really does bypass RLS (otherwise this suite proves nothing)', () => {
  it('sees every note row through a raw connection with no actor set', async () => {
    const victim = await registerAndLogin('norls-victim@test.local');
    await app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: { ...writeHeaders, cookie: victim.cookie },
      payload: { title: 'Visible to the raw connection', body: 'secret' },
    });

    const raw = new pg.Client({ connectionString: NO_RLS_URL });
    await raw.connect();
    try {
      // No `app.actor_id` is set. Under RLS this returns zero rows (asserted in
      // tests/integration/rls.test.ts). Here it must return the note — that is
      // what confirms the gate is genuinely off for the rest of this file.
      const { rows } = await raw.query('SELECT id, body FROM notes');
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await raw.end();
    }
  });
});

describe('application-layer authorization, with RLS disabled', () => {
  it('still returns 404 when another student reads a note by id', async () => {
    const victim = await registerAndLogin('norls-v1@test.local');
    const attacker = await registerAndLogin('norls-a1@test.local');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: { ...writeHeaders, cookie: victim.cookie },
      payload: { title: 'Private', body: 'my private working notes' },
    });
    const noteId = created.json<{ id: string }>().id;

    const attack = await app.inject({
      method: 'GET',
      url: `/api/v1/notes/${noteId}`,
      headers: { cookie: attacker.cookie },
    });

    expect(attack.statusCode).toBe(404);
    expect(attack.body).not.toContain('my private working notes');
  });

  it('still refuses to update another student’s note', async () => {
    const victim = await registerAndLogin('norls-v2@test.local');
    const attacker = await registerAndLogin('norls-a2@test.local');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: { ...writeHeaders, cookie: victim.cookie },
      payload: { title: 'Private', body: 'original' },
    });
    const noteId = created.json<{ id: string }>().id;

    const attack = await app.inject({
      method: 'PATCH',
      url: `/api/v1/notes/${noteId}`,
      headers: { ...writeHeaders, cookie: attacker.cookie },
      payload: { body: 'defaced' },
    });
    expect(attack.statusCode).toBe(404);

    const owner = await app.inject({
      method: 'GET',
      url: `/api/v1/notes/${noteId}`,
      headers: { cookie: victim.cookie },
    });
    expect(owner.json<{ body: string }>().body).toBe('original');
  });

  it('still excludes other students’ notes from a listing', async () => {
    const victim = await registerAndLogin('norls-v3@test.local');
    const attacker = await registerAndLogin('norls-a3@test.local');

    await app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: { ...writeHeaders, cookie: victim.cookie },
      payload: { title: 'Victim note' },
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/notes',
      headers: { cookie: attacker.cookie },
    });
    expect(listed.json<{ items: unknown[] }>().items).toEqual([]);
  });
});

// =========================================================================
/**
 * The same question for the Task 004 surface: organizations, classes, rosters
 * and guardian links.
 *
 * These endpoints lean on RLS heavily — every listing is scoped by it — so it
 * would be easy for the application layer to be quietly redundant here. With
 * RLS off, every row is visible to the database client, and any refusal below
 * therefore came from the policy engine and `Guarded` alone.
 */
describe('relationship management authorization, with RLS disabled', () => {
  async function seedAndLogin(
    email: string,
    roles: readonly string[] | undefined,
    organizationId: string | null,
  ): Promise<{ id: string; cookie: string }> {
    const user = await createUser({
      email,
      ...(roles ? { roles } : {}),
      organizationId,
      passwordHash: await hashPassword(PASSWORD),
    });
    const loggedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: writeHeaders,
      payload: { email, password: PASSWORD },
    });
    expect(loggedIn.statusCode).toBe(204);
    return {
      id: user.id,
      cookie: `edu_session=${sessionCookieFrom(loggedIn.headers['set-cookie'])}`,
    };
  }

  /** A school with an admin, a teacher, a student and one class. */
  async function school(prefix: string) {
    const organizationId = await createOrganization(`School ${prefix}`);
    const admin = await seedAndLogin(`${prefix}-nrls-admin@test.local`, ['admin'], organizationId);
    const teacher = await seedAndLogin(
      `${prefix}-nrls-teacher@test.local`,
      ['teacher'],
      organizationId,
    );
    const student = await seedAndLogin(
      `${prefix}-nrls-student@test.local`,
      undefined,
      organizationId,
    );
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/classes',
      headers: { ...writeHeaders, cookie: admin.cookie },
      payload: { name: `${prefix} Physics` },
    });
    expect(created.statusCode).toBe(201);
    return { organizationId, admin, teacher, student, classId: created.json<{ id: string }>().id };
  }

  it('still refuses a teacher assigning themselves to a class', async () => {
    const a = await school('x');
    const attack = await app.inject({
      method: 'POST',
      url: `/api/v1/classes/${a.classId}/teachers`,
      headers: { ...writeHeaders, cookie: a.teacher.cookie },
      payload: { teacherId: a.teacher.id },
    });
    expect(attack.statusCode).toBe(404);
  });

  it('still refuses an administrator reaching into another organization', async () => {
    const a = await school('y');
    const b = await school('z');
    const attack = await app.inject({
      method: 'PATCH',
      url: `/api/v1/classes/${a.classId}`,
      headers: { ...writeHeaders, cookie: b.admin.cookie },
      payload: { name: 'Owned' },
    });
    expect(attack.statusCode).toBe(404);
  });

  it('still refuses an enrolled student the class roster', async () => {
    const a = await school('r');
    const enrolled = await app.inject({
      method: 'POST',
      url: `/api/v1/classes/${a.classId}/members`,
      headers: { ...writeHeaders, cookie: a.admin.cookie },
      payload: { userId: a.student.id },
    });
    expect(enrolled.statusCode).toBe(201);

    const attack = await app.inject({
      method: 'GET',
      url: `/api/v1/classes/${a.classId}/members`,
      headers: { cookie: a.student.cookie },
    });
    expect(attack.statusCode).toBe(404);
  });

  it('still refuses a guardian verifying their own claim', async () => {
    const a = await school('g');
    const guardian = await seedAndLogin(
      'g-nrls-guardian@test.local',
      ['guardian'],
      a.organizationId,
    );
    const linkId = await linkGuardian(guardian.id, a.student.id, 'pending');

    const attack = await app.inject({
      method: 'POST',
      url: `/api/v1/guardian-links/${linkId}/verify`,
      headers: { origin: 'http://localhost:5173', cookie: guardian.cookie },
    });
    expect(attack.statusCode).toBe(403);
  });

  it('still excludes other schools from an organization listing', async () => {
    const a = await school('l');
    await school('m');

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/organizations',
      headers: { cookie: a.student.cookie },
    });
    expect(listed.json<{ items: { id: string }[] }>().items.map((o) => o.id)).toEqual([
      a.organizationId,
    ]);
  });

  it('still excludes classes the actor is unrelated to from a class listing', async () => {
    const a = await school('n');
    const b = await school('o');
    await app.inject({
      method: 'POST',
      url: `/api/v1/classes/${a.classId}/members`,
      headers: { ...writeHeaders, cookie: a.admin.cookie },
      payload: { userId: a.student.id },
    });

    // The student sees the one class they are enrolled in — not school B's, and
    // not any other class in their own school.
    await app.inject({
      method: 'POST',
      url: '/api/v1/classes',
      headers: { ...writeHeaders, cookie: a.admin.cookie },
      payload: { name: 'Another class in the same school' },
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/classes',
      headers: { cookie: a.student.cookie },
    });
    expect(listed.json<{ items: { id: string }[] }>().items.map((c) => c.id)).toEqual([a.classId]);
    expect(listed.body).not.toContain(b.classId);
  });

  it('still refuses an administrator of ANOTHER school verifying a claim', async () => {
    // With RLS off, the database hides nothing — so if this passes, the
    // organization confinement on guardian links is genuinely in the policy.
    const a = await school('c');
    const b = await school('d');
    const guardian = await seedAndLogin(
      'c-nrls-guardian@test.local',
      ['guardian'],
      a.organizationId,
    );
    const linkId = await linkGuardian(guardian.id, a.student.id, 'pending');

    const attack = await app.inject({
      method: 'POST',
      url: `/api/v1/guardian-links/${linkId}/verify`,
      headers: { origin: 'http://localhost:5173', cookie: b.admin.cookie },
    });
    expect(attack.statusCode).toBe(404);

    // The administrator of the child's OWN school still may.
    const allowed = await app.inject({
      method: 'POST',
      url: `/api/v1/guardian-links/${linkId}/verify`,
      headers: { origin: 'http://localhost:5173', cookie: a.admin.cookie },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('still hides another guardian’s links from a listing and from action', async () => {
    const a = await school('h');
    const guardianA = await seedAndLogin('h-nrls-g1@test.local', ['guardian'], a.organizationId);
    const guardianB = await seedAndLogin('h-nrls-g2@test.local', ['guardian'], a.organizationId);
    const linkId = await linkGuardian(guardianA.id, a.student.id, 'verified');

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/guardian-links',
      headers: { cookie: guardianB.cookie },
    });
    expect(listed.json<{ items: unknown[] }>().items).toEqual([]);

    const attack = await app.inject({
      method: 'POST',
      url: `/api/v1/guardian-links/${linkId}/revoke`,
      headers: { origin: 'http://localhost:5173', cookie: guardianB.cookie },
    });
    expect(attack.statusCode).toBe(404);
  });
});

// =========================================================================
/**
 * The same question for the educational content tree.
 *
 * This surface leans on RLS harder than any before it: draft visibility, the
 * global-versus-organization split and the whole-chain published rule are all
 * expressed as database policies. With RLS off, every row is visible to the
 * database client, so anything refused below was refused by `contentPolicy` and
 * `Guarded` alone.
 *
 * Content is SEEDED here rather than built through the API, because the point
 * is to hand the application rows it should refuse — including rows no
 * authorized request could have produced.
 */
describe('curriculum authorization, with RLS disabled', () => {
  async function seedAndLogin(
    email: string,
    roles: readonly string[] | undefined,
    organizationId: string | null,
  ): Promise<{ id: string; cookie: string }> {
    const user = await createUser({
      email,
      ...(roles ? { roles } : {}),
      organizationId,
      passwordHash: await hashPassword(PASSWORD),
    });
    const loggedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: writeHeaders,
      payload: { email, password: PASSWORD },
    });
    expect(loggedIn.statusCode).toBe(204);
    return {
      id: user.id,
      cookie: `edu_session=${sessionCookieFrom(loggedIn.headers['set-cookie'])}`,
    };
  }

  /** Two schools and the global catalog, with content in every state. */
  async function content() {
    const orgA = await createOrganization('Content School A');
    const orgB = await createOrganization('Content School B');
    const levelId = await createEducationLevel();

    const authorA = await seedAndLogin('nrls-author-a@test.local', ['content_author'], orgA);
    const studentA = await seedAndLogin('nrls-student-a@test.local', undefined, orgA);
    const adminA = await seedAndLogin('nrls-admin-a@test.local', ['admin'], orgA);
    const authorB = await seedAndLogin('nrls-author-b@test.local', ['content_author'], orgB);

    const curriculumA = await createCurriculum({
      organizationId: orgA,
      code: 'math',
      status: 'published',
    });
    const draftCourseA = await createCourse({
      organizationId: orgA,
      curriculumId: curriculumA,
      levelId,
      title: 'Draft Algebra',
      status: 'draft',
    });
    const curriculumB = await createCurriculum({
      organizationId: orgB,
      code: 'math',
      status: 'published',
    });
    const publishedCourseB = await createCourse({
      organizationId: orgB,
      curriculumId: curriculumB,
      levelId,
      title: 'School B Algebra',
      status: 'published',
    });
    const globalCurriculum = await createCurriculum({
      organizationId: null,
      code: 'national',
      status: 'published',
    });
    const globalCourse = await createCourse({
      organizationId: null,
      curriculumId: globalCurriculum,
      levelId,
      title: 'National Algebra',
      status: 'published',
    });

    return {
      orgA,
      levelId,
      authorA,
      studentA,
      adminA,
      authorB,
      curriculumA,
      draftCourseA,
      publishedCourseB,
      globalCourse,
    };
  }

  it('still hides DRAFT content from a student', async () => {
    const c = await content();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/courses/${c.draftCourseA}`,
      headers: { cookie: c.studentA.cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('Draft Algebra');
  });

  it('still hides ARCHIVED content from a student', async () => {
    const c = await content();
    const archived = await createCourse({
      organizationId: c.orgA,
      curriculumId: c.curriculumA,
      levelId: c.levelId,
      title: 'Retired Algebra',
      status: 'archived',
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/courses/${archived}`,
      headers: { cookie: c.studentA.cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('Retired Algebra');
  });

  it('still hides another school’s published content, on read and in listings', async () => {
    const c = await content();
    const single = await app.inject({
      method: 'GET',
      url: `/api/v1/courses/${c.publishedCourseB}`,
      headers: { cookie: c.studentA.cookie },
    });
    expect(single.statusCode).toBe(404);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/courses',
      headers: { cookie: c.studentA.cookie },
    });
    expect(listed.body).not.toContain('School B Algebra');
  });

  it('still refuses a school actor writing to the GLOBAL catalog', async () => {
    const c = await content();
    for (const cookie of [c.authorA.cookie, c.adminA.cookie]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/courses/${c.globalCourse}`,
        headers: { ...writeHeaders, cookie },
        payload: { title: 'owned' },
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it('still refuses an author of another school editing a course', async () => {
    const c = await content();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/courses/${c.draftCourseA}`,
      headers: { ...writeHeaders, cookie: c.authorB.cookie },
      payload: { title: 'owned' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('still hides a published lesson whose ancestors are drafts', async () => {
    const c = await content();
    // The chain rule is expressed in RLS AND carried on the resource. With RLS
    // off, only the second can be doing the work.
    const unit = await createUnit({ courseId: c.draftCourseA, status: 'published' });
    const lesson = await createLesson({
      unitId: unit,
      title: 'Leaked Lesson',
      status: 'published',
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/lessons/${lesson}`,
      headers: { cookie: c.studentA.cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('Leaked Lesson');
  });

  it('still refuses a student publishing content', async () => {
    const c = await content();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/courses/${c.draftCourseA}/publish`,
      headers: { origin: 'http://localhost:5173', cookie: c.studentA.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('still refuses an AUTHOR publishing — the duty split is not RLS’s alone', async () => {
    const c = await content();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/courses/${c.draftCourseA}/publish`,
      headers: { origin: 'http://localhost:5173', cookie: c.authorA.cookie },
    });
    expect(response.statusCode).toBe(403);
  });
});
