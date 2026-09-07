import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import {
  bodylessWriteHeaders,
  buildTestApp,
  sessionCookieFrom,
  writeHeaders,
  type TestApp,
} from '../setup/app.ts';
import {
  addClassMember,
  assignCourseToClass,
  assignTeacher,
  closeSeedDb,
  createClass,
  createCourse,
  createCurriculum,
  createEducationLevel,
  createLesson,
  createOrganization,
  createActivity,
  createAttempt,
  createQuestion,
  createUnit,
  createUser,
  linkGuardian,
  recordProgress,
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

// =========================================================================
/**
 * The Task 006 narrowing, with RLS disabled.
 *
 * This boundary leans on the database harder than any before it: the
 * course-through-a-class edge is four status checks deep, and all four are
 * expressed as RLS. With RLS off every row is visible to the database client,
 * so anything refused below was refused by `contentPolicy` reading
 * `coursesViaClasses` — which the snapshot loader still computes correctly,
 * because it is ordinary SQL rather than a policy.
 */
describe('class-scoped content access, with RLS disabled', () => {
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

  /** One school, one class, one enrolled learner, two published courses. */
  async function world() {
    const orgA = await createOrganization('Narrow School A');
    const orgB = await createOrganization('Narrow School B');
    const levelId = await createEducationLevel();

    const student = await seedAndLogin('nrls-narrow-student@test.local', undefined, orgA);
    const outsider = await seedAndLogin('nrls-narrow-outsider@test.local', undefined, orgA);
    const studentB = await seedAndLogin('nrls-narrow-student-b@test.local', undefined, orgB);
    const admin = await seedAndLogin('nrls-narrow-admin@test.local', ['admin'], orgA);

    const classId = await createClass(orgA, 'Narrow Class');
    await addClassMember(classId, student.id);

    const curriculumA = await createCurriculum({
      organizationId: orgA,
      code: 'math',
      status: 'published',
    });
    const mk = async (organizationId: string | null, curriculumId: string, title: string) => {
      const course = await createCourse({
        organizationId,
        curriculumId,
        levelId,
        title,
        status: 'published',
      });
      const unit = await createUnit({ courseId: course, title: `${title} U`, status: 'published' });
      const lesson = await createLesson({
        unitId: unit,
        title: `${title} L`,
        status: 'published',
      });
      return { course, unit, lesson };
    };

    return {
      orgA,
      orgB,
      levelId,
      classId,
      student,
      outsider,
      studentB,
      admin,
      curriculumA,
      assigned: await mk(orgA, curriculumA, 'Assigned'),
      unassigned: await mk(orgA, curriculumA, 'Unassigned'),
    };
  }

  it('still hides a PUBLISHED course the learner’s class was not assigned', async () => {
    const w = await world();
    await assignCourseToClass({ classId: w.classId, courseId: w.assigned.course });

    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/courses/${w.assigned.course}`,
          headers: { cookie: w.student.cookie },
        })
      ).statusCode,
    ).toBe(200);

    const refused = await app.inject({
      method: 'GET',
      url: `/api/v1/courses/${w.unassigned.course}`,
      headers: { cookie: w.student.cookie },
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.body).not.toContain('Unassigned');
  });

  it('still hides the units and lessons of an unassigned course', async () => {
    const w = await world();
    for (const url of [
      `/api/v1/units/${w.unassigned.unit}`,
      `/api/v1/lessons/${w.unassigned.lesson}`,
    ]) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: w.student.cookie },
      });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('Unassigned');
    }
  });

  it('still hides everything from a learner in NO class', async () => {
    const w = await world();
    await assignCourseToClass({ classId: w.classId, courseId: w.assigned.course });
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/courses',
      headers: { cookie: w.outsider.cookie },
    });
    expect(listed.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('still revokes the moment the membership ends', async () => {
    const w = await world();
    await assignCourseToClass({ classId: w.classId, courseId: w.assigned.course });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/classes/${w.classId}/members/${w.student.id}`,
          headers: { origin: 'http://localhost:5173', cookie: w.admin.cookie },
        })
      ).statusCode,
    ).toBe(204);

    // Same live session, next request.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/courses/${w.assigned.course}`,
          headers: { cookie: w.student.cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/me/courses',
          headers: { cookie: w.student.cookie },
        })
      ).json<{ items: unknown[] }>().items,
    ).toEqual([]);
  });

  it('still refuses a cross-school assignment', async () => {
    const w = await world();
    const curriculumB = await createCurriculum({
      organizationId: w.orgB,
      code: 'math',
      status: 'published',
    });
    const courseB = await createCourse({
      organizationId: w.orgB,
      curriculumId: curriculumB,
      levelId: w.levelId,
      title: 'School B Course',
      status: 'published',
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/classes/${w.classId}/courses`,
      headers: { ...writeHeaders, cookie: w.admin.cookie },
      payload: { courseId: courseB },
    });
    expect(response.statusCode).toBe(404);
  });

  it('still keeps one learner’s /me/courses out of another’s', async () => {
    const w = await world();
    await assignCourseToClass({ classId: w.classId, courseId: w.assigned.course });
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/me/courses',
      headers: { cookie: w.studentB.cookie },
    });
    expect(listed.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('still refuses a learner assigning or withdrawing', async () => {
    const w = await world();
    await assignCourseToClass({ classId: w.classId, courseId: w.assigned.course });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/classes/${w.classId}/courses`,
          headers: { ...writeHeaders, cookie: w.student.cookie },
          payload: { courseId: w.unassigned.course },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/classes/${w.classId}/courses/${w.assigned.course}`,
          headers: { origin: 'http://localhost:5173', cookie: w.student.cookie },
        })
      ).statusCode,
    ).toBe(404);
  });
});

// =========================================================================
/**
 * Learner progress, with RLS disabled.
 *
 * The most sensitive boundary in the platform so far: a named child's record,
 * written by that child, read by their teacher and their guardian. Every read
 * route leans on a relationship built in an earlier task, and all of them are
 * expressed as RLS — so with RLS off, anything refused below was refused by
 * `lessonProgressPolicy` alone.
 *
 * Progress rows are SEEDED here, including rows the write path would refuse, so
 * the read path is tested on its own rather than only through the write gate.
 */
describe('learner progress, with RLS disabled', () => {
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

  async function world() {
    const orgA = await createOrganization('Progress School A');
    const orgB = await createOrganization('Progress School B');
    const levelId = await createEducationLevel();

    const learner = await seedAndLogin('nrls-prog-learner@test.local', undefined, orgA);
    const peer = await seedAndLogin('nrls-prog-peer@test.local', undefined, orgA);
    const teacher = await seedAndLogin('nrls-prog-teacher@test.local', ['teacher'], orgA);
    const otherTeacher = await seedAndLogin('nrls-prog-teacher2@test.local', ['teacher'], orgA);
    const guardian = await seedAndLogin('nrls-prog-guardian@test.local', ['guardian'], orgA);
    const adminB = await seedAndLogin('nrls-prog-admin-b@test.local', ['admin'], orgB);

    const classA1 = await createClass(orgA, 'PA1');
    const classA2 = await createClass(orgA, 'PA2');
    await addClassMember(classA1, learner.id);
    await addClassMember(classA1, peer.id);
    await assignTeacher(teacher.id, classA1);
    await assignTeacher(teacher.id, classA2);
    await assignTeacher(otherTeacher.id, classA2);
    await linkGuardian(guardian.id, learner.id, 'verified');

    const curriculumA = await createCurriculum({
      organizationId: orgA,
      code: 'math',
      status: 'published',
    });
    const mk = async (title: string) => {
      const course = await createCourse({
        organizationId: orgA,
        curriculumId: curriculumA,
        levelId,
        title,
        status: 'published',
      });
      const unit = await createUnit({ courseId: course, title: `${title}u`, status: 'published' });
      const lesson = await createLesson({
        unitId: unit,
        title: `${title} Lesson`,
        status: 'published',
      });
      return { course, lesson };
    };
    const P = await mk('P');
    const Q = await mk('Q');
    await assignCourseToClass({ classId: classA1, courseId: P.course });
    await assignCourseToClass({ classId: classA2, courseId: Q.course });

    await recordProgress({ userId: learner.id, lessonId: P.lesson, status: 'completed' });
    await recordProgress({ userId: peer.id, lessonId: P.lesson, status: 'in_progress' });
    // Forced: the learner is not in PA2, so they could never record this.
    await recordProgress({ userId: learner.id, lessonId: Q.lesson, status: 'completed' });

    return { orgA, classA1, classA2, learner, peer, teacher, otherTeacher, guardian, adminB, P, Q };
  }

  it('still shows a learner only their own records', async () => {
    const w = await world();
    const mine = await app.inject({
      method: 'GET',
      url: '/api/v1/me/progress',
      headers: { cookie: w.peer.cookie },
    });
    expect(mine.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(mine.body).toContain('P Lesson');
  });

  it('still refuses a learner writing another learner’s record', async () => {
    const w = await world();
    // The only write route derives its subject from the session, so the closest
    // a peer can get is writing their own row — which is what this asserts did
    // NOT touch the learner's.
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/lessons/${w.P.lesson}/progress`,
      headers: { ...writeHeaders, cookie: w.peer.cookie },
      payload: { status: 'completed' },
    });
    expect(response.statusCode).toBe(200);
    const learnerRows = await app.inject({
      method: 'GET',
      url: '/api/v1/me/progress',
      headers: { cookie: w.learner.cookie },
    });
    expect(learnerRows.json<{ items: { status: string }[] }>().items).toHaveLength(2);
  });

  it('still refuses a learner writing progress for an unassigned lesson', async () => {
    const w = await world();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/lessons/${w.Q.lesson}/progress`,
      headers: { ...writeHeaders, cookie: w.peer.cookie },
      payload: { status: 'completed' },
    });
    expect(response.statusCode).toBe(404);
  });

  /**
   * A note on what this next case does and does not prove.
   *
   * The teacher precision rule — "the course must be assigned to the class the
   * learner is actually in" — is enforced at THREE places: the service's class
   * check, the SQL scoping in `listForLearnerInClass`, and the policy's
   * `observableByActorAsTeacher`. On the only route that reaches it, the SQL
   * scoping fires first, so this test would still pass with the policy branch
   * coarsened. Verified by injecting exactly that defect.
   *
   * That is defence in depth behaving as designed, not a gap — but it means the
   * POLICY half of this boundary is pinned elsewhere: `progress-policy.test.ts`
   * asserts the branch directly, and `rls-progress.test.ts` asserts the
   * database's own version with no application code in the path. Both fail when
   * the check is coarsened.
   */
  it('still excludes a course assigned to a DIFFERENT class from the teacher view', async () => {
    const w = await world();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/classes/${w.classA1}/students/${w.learner.id}/progress`,
      headers: { cookie: w.teacher.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('P Lesson');
    expect(response.body).not.toContain('Q Lesson');
  });

  it('still refuses a teacher a class they do not teach', async () => {
    const w = await world();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/classes/${w.classA1}/students/${w.learner.id}/progress`,
      headers: { cookie: w.otherTeacher.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('still refuses an administrator of another school', async () => {
    const w = await world();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/classes/${w.classA1}/students/${w.learner.id}/progress`,
      headers: { cookie: w.adminB.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('still refuses a guardian an unlinked child', async () => {
    const w = await world();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/guardians/children/${w.peer.id}/progress`,
      headers: { cookie: w.guardian.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('still shows a verified guardian their own child', async () => {
    const w = await world();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/guardians/children/${w.learner.id}/progress`,
      headers: { cookie: w.guardian.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: unknown[] }>().items).toHaveLength(2);
  });
});

/**
 * Assessments and attempts, with the database gate removed.
 *
 * This is the half of Task 008's claim that is easiest to state and hardest to
 * have earned. Migration 0019 is unusually load-bearing — the answer key has
 * its own policy, the scorer is granted to nobody, submitted attempts are
 * frozen by a trigger — so a suite that ran only with RLS active would prove
 * that the DATABASE is careful and say nothing about the application.
 *
 * Here every row is visible to the client. Whatever still refuses, refuses
 * because of the policy engine and `Guarded`.
 *
 * WHAT THIS BLOCK CANNOT SHOW, stated plainly rather than glossed:
 *
 * 1. The answer key's non-disclosure and the score's authorship are DATABASE
 *    properties by design — the key lives behind a policy this role bypasses,
 *    and the scorer runs inside a trigger. With RLS off, a direct query for the
 *    key WOULD succeed. What is asserted below is that no ENDPOINT returns it
 *    even then, which is the application-layer half of the guarantee and all
 *    this suite can honestly claim. The other half is
 *    `tests/integration/rls-assessment.test.ts`.
 *
 * 2. Two policy branches were verified by DEFECT INJECTION to be invisible to
 *    this suite, and are recorded rather than counted as covered:
 *
 *    - Deleting the `isOwn` check from the attempt policy leaves these tests
 *      green, because `learnerMayAttempt` is computed in SQL as
 *      `user_id = app_current_actor() AND ...` and so already encodes
 *      ownership. The branch IS load-bearing — removing it fails eight cases in
 *      `tests/unit/assessment-policy.test.ts` — but this file is not where that
 *      is demonstrated.
 *    - Coarsening the teacher rule from "shares this class" to `teacherOf`
 *      likewise leaves these green, because the repository scopes the class
 *      listing in SQL before the policy is consulted. It fails the unit table.
 *
 *    Both are the same shape as the caveat recorded for learner progress in
 *    Task 007: a redundant gate makes its neighbour hard to observe, which is
 *    worth knowing when reading a green suite.
 */
describe('assessments, with RLS disabled', () => {
  /**
   * Publishes an activity outside the application, so the suite can construct a
   * published assessment without exercising the authoring endpoints it is not
   * testing. Uses the no-RLS role, which is what this whole file connects as.
   */
  async function publishDirectly(activityId: string): Promise<void> {
    const client = new pg.Client({ connectionString: NO_RLS_URL });
    await client.connect();
    try {
      await client.query(
        `UPDATE learning_activities SET status='published', published_at=now() WHERE id=$1`,
        [activityId],
      );
    } finally {
      await client.end();
    }
  }

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

  async function world() {
    const orgA = await createOrganization('Assess School A');
    const orgB = await createOrganization('Assess School B');
    const levelId = await createEducationLevel();

    const learner = await seedAndLogin('nrls-as-learner@test.local', undefined, orgA);
    const peer = await seedAndLogin('nrls-as-peer@test.local', undefined, orgA);
    const teacher = await seedAndLogin('nrls-as-teacher@test.local', ['teacher'], orgA);
    const otherTeacher = await seedAndLogin('nrls-as-teacher2@test.local', ['teacher'], orgA);
    const guardian = await seedAndLogin('nrls-as-guardian@test.local', ['guardian'], orgA);
    const adminB = await seedAndLogin('nrls-as-admin-b@test.local', ['admin'], orgB);

    const classA1 = await createClass(orgA, 'AA1');
    const classA2 = await createClass(orgA, 'AA2');
    await addClassMember(classA1, learner.id);
    await addClassMember(classA2, peer.id);
    await assignTeacher(teacher.id, classA1);
    await assignTeacher(otherTeacher.id, classA2);
    await linkGuardian(guardian.id, learner.id, 'verified');

    const curriculumA = await createCurriculum({
      organizationId: orgA,
      code: 'assess',
      status: 'published',
    });
    const course = await createCourse({
      organizationId: orgA,
      curriculumId: curriculumA,
      levelId,
      title: 'Assessed Course',
      status: 'published',
    });
    const unit = await createUnit({ courseId: course, title: 'AU', status: 'published' });
    const lesson = await createLesson({ unitId: unit, title: 'AL', status: 'published' });
    await assignCourseToClass({ classId: classA1, courseId: course });

    const { activityId, assessmentId } = await createActivity({
      lessonId: lesson,
      title: 'Guarded Quiz',
      status: 'draft',
      maxAttempts: 2,
    });
    const q = await createQuestion({
      assessmentId: assessmentId!,
      options: ['Right', 'Wrong'],
      correctOptions: [0],
    });
    // Published in a second statement, as a reviewer would: the publication
    // trigger validates the question set, which does not exist at insert time.
    await publishDirectly(activityId);

    // A DRAFT assessment on the SAME reachable lesson — the VULN-027 shape.
    const draft = await createActivity({ lessonId: lesson, title: 'Draft', status: 'draft' });

    const attemptId = await createAttempt({
      assessmentId: assessmentId!,
      userId: learner.id,
      status: 'submitted',
    });

    return {
      learner,
      peer,
      teacher,
      otherTeacher,
      guardian,
      adminB,
      classA1,
      lesson,
      activityId,
      assessmentId: assessmentId!,
      draftAssessmentId: draft.assessmentId!,
      attemptId,
      q,
    };
  }

  it('still refuses a peer another learner’s attempt', async () => {
    const w = await world();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/attempts/${w.attemptId}`,
      headers: { cookie: w.peer.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('still refuses a peer submitting another learner’s attempt', async () => {
    const w = await world();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${w.attemptId}/submit`,
      headers: { ...writeHeaders, cookie: w.peer.cookie },
      payload: { answers: [] },
    });
    expect(response.statusCode).toBe(404);
  });

  it('still refuses a teacher of another class', async () => {
    const w = await world();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/attempts/${w.attemptId}`,
      headers: { cookie: w.otherTeacher.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('still refuses an administrator of another organization', async () => {
    const w = await world();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/classes/${w.classA1}/students/${w.learner.id}/attempts`,
      headers: { cookie: w.adminB.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('still refuses a guardian an unlinked child', async () => {
    const w = await world();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/guardians/children/${w.peer.id}/attempts`,
      headers: { cookie: w.guardian.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('still shows a verified guardian their own child', async () => {
    const w = await world();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/guardians/children/${w.learner.id}/attempts`,
      headers: { cookie: w.guardian.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it('still refuses a learner a DRAFT assessment, and an attempt at one', async () => {
    // The application half of VULN-027's fix. With RLS off, the insert policy
    // that refuses this is gone — so what refuses here is the policy's
    // `learnerMayAttempt` check, computed from the activity's status.
    const w = await world();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/assessments/${w.draftAssessmentId}`,
          headers: { cookie: w.learner.cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/assessments/${w.draftAssessmentId}/attempts`,
          headers: { ...writeHeaders, cookie: w.learner.cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });

  it('still refuses a learner an assessment their class is not assigned', async () => {
    const w = await world();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/assessments/${w.assessmentId}/attempts`,
      headers: { ...writeHeaders, cookie: w.peer.cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });

  it('still returns no answer key, to anybody, on any endpoint', async () => {
    // The key IS readable by this database role — it bypasses the policy that
    // hides it. So this asserts the application-layer half: no endpoint puts it
    // in a response, because no response schema has a field for it.
    const w = await world();
    for (const [url, cookie] of [
      [`/api/v1/assessments/${w.assessmentId}`, w.learner.cookie],
      [`/api/v1/attempts/${w.attemptId}`, w.learner.cookie],
      [`/api/v1/me/attempts`, w.learner.cookie],
      [`/api/v1/attempts/${w.attemptId}`, w.teacher.cookie],
    ] as const) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toMatch(/isCorrect|answerKey|correctOption/i);
    }
  });

  it('still refuses a learner authoring an activity', async () => {
    const w = await world();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/lessons/${w.lesson}/activities`,
      headers: { ...writeHeaders, cookie: w.learner.cookie },
      payload: { activityType: 'assessment', title: 'Mine', assessment: {} },
    });
    expect(response.statusCode).toBe(404);
  });
});

/**
 * Mastery, with RLS disabled.
 *
 * The mastery reads pass THREE gates in production: the RLS policy on
 * `objective_evidence`, the self-authorizing `app_objective_mastery`, and the
 * policy engine's per-row pass in `keepReadable`. That redundancy is deliberate
 * and it makes each gate hard to observe — a suite with all three active cannot
 * say which one refused.
 *
 * Here the first is gone (BYPASSRLS) and the second answers for the row anyway,
 * so what remains to be shown is that the APPLICATION refuses on its own. Where
 * it cannot be shown, that is recorded below rather than counted as coverage.
 */
describe('mastery, with RLS disabled', () => {
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

  async function world() {
    const orgA = await createOrganization('Mastery School A');
    const orgB = await createOrganization('Mastery School B');
    const levelId = await createEducationLevel();

    const learner = await seedAndLogin('nrls-m-learner@test.local', undefined, orgA);
    const peer = await seedAndLogin('nrls-m-peer@test.local', undefined, orgA);
    const teacher = await seedAndLogin('nrls-m-teacher@test.local', ['teacher'], orgA);
    const otherTeacher = await seedAndLogin('nrls-m-teacher2@test.local', ['teacher'], orgA);
    const guardian = await seedAndLogin('nrls-m-guardian@test.local', ['guardian'], orgA);
    const otherGuardian = await seedAndLogin('nrls-m-guardian2@test.local', ['guardian'], orgA);
    const adminB = await seedAndLogin('nrls-m-admin-b@test.local', ['admin'], orgB);

    const classA1 = await createClass(orgA, 'MA1');
    const classA2 = await createClass(orgA, 'MA2');
    await addClassMember(classA1, learner.id);
    await addClassMember(classA2, peer.id);
    await assignTeacher(teacher.id, classA1);
    await assignTeacher(otherTeacher.id, classA2);
    await linkGuardian(guardian.id, learner.id, 'verified');
    await linkGuardian(otherGuardian.id, peer.id, 'verified');

    const curriculumId = await createCurriculum({
      organizationId: orgA,
      code: 'mastery',
      status: 'published',
    });
    const courseId = await createCourse({
      organizationId: orgA,
      curriculumId,
      levelId,
      title: 'Mastery Course',
      status: 'published',
    });
    const unitId = await createUnit({ courseId, title: 'M Unit', status: 'published' });
    const lessonId = await createLesson({
      unitId,
      title: 'M Lesson',
      status: 'published',
      objectives: ['M objective one'],
    });
    await assignCourseToClass({ classId: classA1, courseId });

    // Evidence, created through the real progress path so the trigger fires.
    await recordProgress({ userId: learner.id, lessonId, status: 'completed' });

    return {
      orgA,
      orgB,
      learner,
      peer,
      teacher,
      otherTeacher,
      guardian,
      otherGuardian,
      adminB,
      classA1,
      classA2,
      courseId,
      lessonId,
    };
  }

  it('STILL REFUSES A PEER THE GUARDIAN VIEW of another learner', async () => {
    // `objectivesForChild` checks the relationship snapshot in the SERVICE,
    // before any query runs. With RLS gone that check is the only thing standing
    // between a peer and another child's record.
    const w = await world();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/guardians/children/${w.learner.id}/objectives`,
      headers: { cookie: w.peer.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('STILL REFUSES A GUARDIAN AN UNLINKED CHILD', async () => {
    const w = await world();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/guardians/children/${w.learner.id}/objectives`,
      headers: { cookie: w.otherGuardian.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('STILL REFUSES A TEACHER A LEARNER OUTSIDE THEIR CLASS', async () => {
    // `courseForStudentInClass` establishes class standing in the service, from
    // definer helpers that do not depend on RLS at all.
    const w = await world();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/classes/${w.classA1}/students/${w.learner.id}/courses/${w.courseId}/mastery`,
      headers: { cookie: w.otherTeacher.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('STILL REFUSES AN ADMINISTRATOR OF ANOTHER ORGANIZATION', async () => {
    const w = await world();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/classes/${w.classA1}/students/${w.learner.id}/courses/${w.courseId}/mastery`,
      headers: { cookie: w.adminB.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('still admits the people who should be admitted', async () => {
    // The positive control. A suite of refusals passes when everything is
    // broken; this is what says the refusals above are selective.
    const w = await world();
    for (const [url, cookie] of [
      [`/api/v1/me/objectives`, w.learner.cookie],
      [`/api/v1/guardians/children/${w.learner.id}/objectives`, w.guardian.cookie],
      [
        `/api/v1/classes/${w.classA1}/students/${w.learner.id}/courses/${w.courseId}/mastery`,
        w.teacher.cookie,
      ],
    ] as const) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode).toBe(200);
    }
  });

  it('still exposes no way to write a mastery state or an evidence row', async () => {
    // With RLS gone the `edu_app_norls` role CAN write `objective_evidence`.
    // What stops a client is that no route accepts one — the application half of
    // the defence, which is what this file exists to isolate.
    const w = await world();
    for (const [method, url] of [
      ['POST', `/api/v1/me/objectives/${w.lessonId}/mastery`],
      ['PUT', `/api/v1/me/objectives/${w.lessonId}/mastery`],
      ['POST', `/api/v1/me/objectives/${w.lessonId}/evidence`],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: { ...writeHeaders, cookie: w.learner.cookie },
        payload: { mastery: 'mastered', masteryScore: 100 },
      });
      expect(response.statusCode).toBe(404);
    }
  });

  /**
   * WHAT THIS BLOCK CANNOT SHOW, recorded rather than counted:
   *
   * `/me/objectives` and `/me/courses/:id/mastery` are scoped by the SESSION in
   * the repository query, so a forged `?learnerId=` is ignored before any gate
   * is consulted. Injecting a handler that read the query parameter instead was
   * still refused with RLS active — the database filtered the rows — and is
   * caught here only through the guardian route above. The direct assertion
   * lives in `tests/security/mastery.test.ts`, where a peer supplies another
   * learner's id and receives their own empty record.
   *
   * Same shape as the caveat recorded for assessments above: a redundant gate
   * makes its neighbour hard to observe.
   */
});

describe('the student workspace, with RLS disabled', () => {
  /**
   * THE BLOCK THAT ANSWERS "WHICH GATE DID THE WORK?" FOR THE WORKSPACE.
   *
   * A defect-injection round removed the `owner_id = $1` clause from the
   * artifact listing query and from the quota query, and every test in
   * `tests/security/workspace.test.ts` still passed — because RLS was quietly
   * carrying both. That is fine until somebody adds a query path RLS does not
   * cover, and then the redundancy nobody was checking turns out never to have
   * existed.
   *
   * With BYPASSRLS every row is visible to the database client, so anything
   * refused below was refused by the application: by the policy engine, by
   * `Guarded`, or by the repository scoping its own SQL to the session.
   */
  async function makeNotebook(cookie: string, title = 'Private'): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/me/notebooks',
      headers: { ...writeHeaders, cookie },
      payload: { title },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function makeArtifact(cookie: string, byteSize = 4096): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/me/artifacts',
      headers: { ...writeHeaders, cookie },
      payload: { artifactType: 'image', declaredContentType: 'image/png', byteSize },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string }>().id;
  }

  it('refuses a peer reading another learner’s notebook by exact id', async () => {
    const victim = await registerAndLogin('ws-victim@test.local');
    const attacker = await registerAndLogin('ws-attacker@test.local');
    const notebook = await makeNotebook(victim.cookie);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/me/notebooks/${notebook}`,
      headers: { cookie: attacker.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a peer updating or deleting it', async () => {
    const victim = await registerAndLogin('ws-victim2@test.local');
    const attacker = await registerAndLogin('ws-attacker2@test.local');
    const notebook = await makeNotebook(victim.cookie);

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/me/notebooks/${notebook}`,
      headers: { ...writeHeaders, cookie: attacker.cookie },
      payload: { title: 'Taken' },
    });
    expect(updated.statusCode).toBe(404);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/me/notebooks/${notebook}`,
      headers: { ...bodylessWriteHeaders, cookie: attacker.cookie },
    });
    expect(deleted.statusCode).toBe(404);
  });

  it('LISTS ONLY THE CALLER’S OWN NOTEBOOKS, with every row visible to the client', () => {
    // The listing case, which is where a single gate is most expensive to be
    // wrong about (VULN-017). The repository scopes by the session's own id, so
    // the query returns one row even though the connection could see both.
    return (async () => {
      const victim = await registerAndLogin('ws-list-victim@test.local');
      const attacker = await registerAndLogin('ws-list-attacker@test.local');
      await makeNotebook(victim.cookie, 'Theirs');
      await makeNotebook(attacker.cookie, 'Mine');

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/me/notebooks',
        headers: { cookie: attacker.cookie },
      });
      expect(response.statusCode).toBe(200);
      const items = response.json<{ items: { title: string }[] }>().items;
      expect(items.map((i) => i.title)).toEqual(['Mine']);
    })();
  });

  it('LISTS ONLY THE CALLER’S OWN ARTIFACTS', async () => {
    const victim = await registerAndLogin('ws-art-victim@test.local');
    const attacker = await registerAndLogin('ws-art-attacker@test.local');
    await makeArtifact(victim.cookie, 8192);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me/artifacts',
      headers: { cookie: attacker.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('REPORTS ONLY THE CALLER’S OWN STORAGE USE', async () => {
    // The quota query names the caller's id explicitly. With RLS off, a query
    // that forgot to would sum the whole table and report somebody else's
    // files as this learner's.
    const victim = await registerAndLogin('ws-quota-victim@test.local');
    const attacker = await registerAndLogin('ws-quota-attacker@test.local');
    await makeArtifact(victim.cookie, 12_345);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me/storage',
      headers: { cookie: attacker.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ usedBytes: number; artifactCount: number }>();
    expect(body.usedBytes).toBe(0);
    expect(body.artifactCount).toBe(0);
  });

  it('refuses a peer reading or deleting another learner’s artifact by exact id', async () => {
    const victim = await registerAndLogin('ws-del-victim@test.local');
    const attacker = await registerAndLogin('ws-del-attacker@test.local');
    const artifact = await makeArtifact(victim.cookie);

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/me/artifacts/${artifact}`,
      headers: { cookie: attacker.cookie },
    });
    expect(read.statusCode).toBe(404);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/me/artifacts/${artifact}`,
      headers: { ...bodylessWriteHeaders, cookie: attacker.cookie },
    });
    expect(deleted.statusCode).toBe(404);
  });

  it('refuses a peer reading another learner’s private note by exact id', async () => {
    const victim = await registerAndLogin('ws-note-victim@test.local');
    const attacker = await registerAndLogin('ws-note-attacker@test.local');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/me/notes',
      headers: { ...writeHeaders, cookie: victim.cookie },
      payload: { title: 'Private', body: 'my working out' },
    });
    expect(created.statusCode).toBe(201);
    const noteId = created.json<{ id: string }>().id;

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/me/notes/${noteId}`,
      headers: { cookie: attacker.cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('my working out');
  });
});

describe('the curriculum knowledge base, with RLS disabled', () => {
  /**
   * THE BLOCK THAT ANSWERS "WHICH GATE DID THE WORK?" FOR VECTOR RETRIEVAL —
   * and for this feature the answer has to be the application, because the
   * application is where the requirement actually lives.
   *
   * Section 3 of the task forbids unbounded vector search filtered after the
   * fact. RLS alone could satisfy "the learner never SEES another school's
   * chunk" while completely failing that requirement: a policy is a predicate
   * the planner may apply wherever it likes, and `ORDER BY embedding <=> $1
   * LIMIT 10` under a row policy is entitled to rank first and discard after.
   * The result would be correct and the property would be gone.
   *
   * `coursesInScope` is therefore computed in application SQL and passed in as
   * an explicit `course_id = ANY($1)`, and this block is what proves that list
   * is load-bearing rather than decorative. With BYPASSRLS every embedding row
   * in the database is visible to the connection: if a school B learner still
   * gets nothing from school A here, the pre-filter did it alone.
   *
   * The mirror image — RLS standing alone, with no application code in the
   * path — is `tests/integration/rls-embeddings.test.ts`.
   */
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

  const MITOCHONDRIA = [
    'The mitochondrion is the organelle where respiration releases energy.',
    'Respiration in the mitochondrion converts glucose and oxygen into usable energy.',
    'Energy released by respiration is carried around the cell as ATP molecules.',
  ]
    .join('\n\n')
    .repeat(6);

  /** Two schools, each with one enrolled learner and one indexed course. */
  async function twoSchools() {
    const orgA = await createOrganization('Vector School A');
    const orgB = await createOrganization('Vector School B');
    const levelId = await createEducationLevel();

    const learnerA = await seedAndLogin('nrls-rag-learner-a@test.local', undefined, orgA);
    const learnerB = await seedAndLogin('nrls-rag-learner-b@test.local', undefined, orgB);
    const reviewerA = await seedAndLogin('nrls-rag-reviewer-a@test.local', ['reviewer'], orgA);
    const reviewerB = await seedAndLogin('nrls-rag-reviewer-b@test.local', ['reviewer'], orgB);

    const build = async (
      organizationId: string,
      code: string,
      title: string,
      marker: string,
    ): Promise<string> => {
      const curriculumId = await createCurriculum({ organizationId, code, status: 'published' });
      const courseId = await createCourse({
        organizationId,
        curriculumId,
        levelId,
        title,
        status: 'published',
      });
      const unitId = await createUnit({ courseId, status: 'published' });
      await createLesson({
        unitId,
        title: `${title} lesson`,
        status: 'published',
        contentBody: `${marker} ${MITOCHONDRIA}`,
      });
      return courseId;
    };

    const courseA = await build(orgA, 'bio', 'School A biology', 'SCHOOLAONLY');
    const courseB = await build(orgB, 'sci', 'School B biology', 'SCHOOLBONLY');

    const classA = await createClass(orgA, 'Vector Class A');
    await addClassMember(classA, learnerA.id);
    await assignCourseToClass({ classId: classA, courseId: courseA });

    const classB = await createClass(orgB, 'Vector Class B');
    await addClassMember(classB, learnerB.id);
    await assignCourseToClass({ classId: classB, courseId: courseB });

    return { learnerA, learnerB, reviewerA, reviewerB, courseA, courseB, classA };
  }

  const indexCourse = async (cookie: string, courseId: string) => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/curriculum/courses/${courseId}/index`,
      headers: { ...bodylessWriteHeaders, cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ chunksWritten: number }>();
  };

  const retrieve = async (cookie: string, payload: Record<string, unknown>) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/rag/retrieve',
      headers: { ...writeHeaders, cookie },
      payload,
    });
    expect(response.statusCode, response.body).toBe(200);
    return {
      raw: response.body,
      body: response.json<{
        chunks: Array<{ courseId: string; content: string }>;
        coursesInScope: number;
      }>(),
    };
  };

  it('CONFIRMS BOTH SCHOOLS ARE IN THE TABLE, so the next tests mean something', async () => {
    const w = await twoSchools();
    await indexCourse(w.reviewerA.cookie, w.courseA);
    await indexCourse(w.reviewerB.cookie, w.courseB);

    // Read with a raw connection and no actor set. Under RLS this is zero rows;
    // here it must show both schools' vectors, which is what makes the
    // isolation asserted below an application property rather than a database
    // one. A test that passed because the rows were absent would prove nothing.
    const raw = new pg.Client({ connectionString: NO_RLS_URL });
    await raw.connect();
    try {
      const { rows } = await raw.query<{ course_id: string }>(
        'SELECT DISTINCT course_id FROM curriculum_embeddings',
      );
      expect(rows.map((r) => r.course_id).sort()).toEqual([w.courseA, w.courseB].sort());
    } finally {
      await raw.end();
    }
  });

  it('gives a school B learner NOTHING from school A, on the query that matches it', async () => {
    const w = await twoSchools();
    await indexCourse(w.reviewerA.cookie, w.courseA);
    await indexCourse(w.reviewerB.cookie, w.courseB);

    // The same query text that school A's chunks were written from, so a
    // ranking that ran before the filter would put them at the top.
    const { raw, body } = await retrieve(w.learnerB.cookie, {
      query: 'mitochondrion respiration energy',
      topK: 20,
    });
    expect(raw).not.toContain('SCHOOLAONLY');
    expect(body.coursesInScope).toBe(1);
    for (const chunk of body.chunks) expect(chunk.courseId).toBe(w.courseB);
  });

  it('gives a school A learner NOTHING from school B, symmetrically', async () => {
    const w = await twoSchools();
    await indexCourse(w.reviewerA.cookie, w.courseA);
    await indexCourse(w.reviewerB.cookie, w.courseB);

    const { raw, body } = await retrieve(w.learnerA.cookie, {
      query: 'mitochondrion respiration energy',
      topK: 20,
    });
    expect(raw).not.toContain('SCHOOLBONLY');
    for (const chunk of body.chunks) expect(chunk.courseId).toBe(w.courseA);
  });

  it('REFUSES A NAMED CROSS-TENANT courseId by narrowing to nothing, not by trusting it', async () => {
    const w = await twoSchools();
    await indexCourse(w.reviewerA.cookie, w.courseA);
    await indexCourse(w.reviewerB.cookie, w.courseB);

    // The client asks, explicitly and by exact id, for the other school's
    // course. The filter is an INTERSECTION with what the actor may study, so
    // naming a course cannot add it — and with RLS gone, the intersection is
    // the only thing standing between this request and the row.
    const { raw, body } = await retrieve(w.learnerA.cookie, {
      query: 'mitochondrion respiration energy',
      courseId: w.courseB,
      topK: 20,
    });
    expect(body.chunks).toEqual([]);
    expect(raw).not.toContain('SCHOOLBONLY');
  });

  it('gives a learner in no class an empty result, not the whole table', async () => {
    const w = await twoSchools();
    await indexCourse(w.reviewerA.cookie, w.courseA);
    await indexCourse(w.reviewerB.cookie, w.courseB);
    const outsider = await seedAndLogin('nrls-rag-outsider@test.local', undefined, null);

    // An empty scope is the case where "filter afterwards" and "filter first"
    // differ most sharply: post-hoc filtering of an unbounded search would have
    // read every tenant's vectors to arrive at this same empty array.
    const { raw, body } = await retrieve(outsider.cookie, {
      query: 'mitochondrion respiration energy',
      topK: 20,
    });
    expect(body.chunks).toEqual([]);
    expect(body.coursesInScope).toBe(0);
    expect(raw).not.toContain('SCHOOLAONLY');
    expect(raw).not.toContain('SCHOOLBONLY');
  });

  it('still refuses a learner the right to REBUILD the index', async () => {
    const w = await twoSchools();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/curriculum/courses/${w.courseA}/index`,
      headers: { ...bodylessWriteHeaders, cookie: w.learnerA.cookie },
    });
    // Nothing about this refusal is the database's doing: `edu_app_norls` has
    // the INSERT grant and BYPASSRLS. The policy engine refused it.
    expect(response.statusCode).toBe(404);
  });

  it('still refuses a reviewer indexing ANOTHER school’s course', async () => {
    const w = await twoSchools();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/curriculum/courses/${w.courseB}/index`,
      headers: { ...bodylessWriteHeaders, cookie: w.reviewerA.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('STOPS AT THE MOMENT THE LEARNER LEAVES THE CLASS, with RLS gone (VULN-049)', async () => {
    // Defect injection round 10 removed `cm.status = 'active'` from
    // `coursesInScope` and every suite still passed, because the RLS policy on
    // `curriculum_embeddings` delegates to `app_actor_sees_lesson`, which
    // reaches `app_actor_studies_course`, which asks the same question. Two
    // gates, and nothing that could tell them apart — so the redundancy nobody
    // was checking might never have existed.
    //
    // With BYPASSRLS the database answers nothing. If retrieval still stops
    // here, the application's own scope query is what stopped it.
    const w = await twoSchools();
    await indexCourse(w.reviewerA.cookie, w.courseA);
    expect(
      (await retrieve(w.learnerA.cookie, { query: 'mitochondrion respiration' })).body.chunks
        .length,
    ).toBeGreaterThan(0);

    const raw = new pg.Client({ connectionString: NO_RLS_URL });
    await raw.connect();
    try {
      await raw.query(
        `UPDATE class_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1`,
        [w.learnerA.id],
      );
    } finally {
      await raw.end();
    }

    const { raw: bodyText, body } = await retrieve(w.learnerA.cookie, {
      query: 'mitochondrion respiration energy',
      topK: 20,
    });
    expect(body.chunks).toEqual([]);
    expect(body.coursesInScope).toBe(0);
    expect(bodyText).not.toContain('SCHOOLAONLY');
  });

  it('STOPS AT THE MOMENT THE COURSE IS WITHDRAWN FROM THE CLASS, with RLS gone', async () => {
    // The sibling clause, `a.status = 'active'`, masked the same way and
    // separated for the same reason.
    const w = await twoSchools();
    await indexCourse(w.reviewerA.cookie, w.courseA);

    const raw = new pg.Client({ connectionString: NO_RLS_URL });
    await raw.connect();
    try {
      await raw.query(
        `UPDATE class_course_assignments SET status = 'archived', ended_at = now()
          WHERE class_id = $1`,
        [w.classA],
      );
    } finally {
      await raw.end();
    }

    const { raw: bodyText, body } = await retrieve(w.learnerA.cookie, {
      query: 'mitochondrion respiration energy',
      topK: 20,
    });
    expect(body.chunks).toEqual([]);
    expect(body.coursesInScope).toBe(0);
    expect(bodyText).not.toContain('SCHOOLAONLY');
  });

  it('STOPS WHEN THE COURSE ITSELF IS ARCHIVED, and says so in the scope count', async () => {
    // The third masked clause. `co.status = 'published'` in `coursesInScope`
    // looks redundant beside the identical check in the retrieval join, and
    // dropping it changed no result — but the two are not interchangeable.
    // Only the scope query feeds `coursesInScope`, the number the response
    // reports back, so without this clause an archived course would still be
    // COUNTED as reachable while returning nothing. That is a caller being
    // told something untrue about its own access, which is why the count is
    // asserted here and not just the emptiness.
    const w = await twoSchools();
    await indexCourse(w.reviewerA.cookie, w.courseA);

    const raw = new pg.Client({ connectionString: NO_RLS_URL });
    await raw.connect();
    try {
      // Bottom-up. `content_tree_status_is_consistent` refuses to archive a
      // course while a published unit still hangs off it, and the first
      // version of this test archived the course alone — so it failed on a
      // trigger rather than on the control it was written for, and then
      // "caught" every injected defect by being red already. A test that fails
      // for every reason distinguishes nothing.
      await raw.query(
        `UPDATE lessons SET status = 'archived', published_at = NULL, archived_at = now()
          WHERE unit_id IN (SELECT id FROM course_units WHERE course_id = $1)`,
        [w.courseA],
      );
      await raw.query(
        `UPDATE course_units SET status = 'archived', published_at = NULL, archived_at = now()
          WHERE course_id = $1`,
        [w.courseA],
      );
      await raw.query(
        `UPDATE courses SET status = 'archived', published_at = NULL, archived_at = now()
          WHERE id = $1`,
        [w.courseA],
      );
    } finally {
      await raw.end();
    }

    const { raw: bodyText, body } = await retrieve(w.learnerA.cookie, {
      query: 'mitochondrion respiration energy',
      topK: 20,
    });
    expect(body.chunks).toEqual([]);
    expect(body.coursesInScope).toBe(0);
    expect(bodyText).not.toContain('SCHOOLAONLY');
  });

  it('STOPS SERVING AN ARCHIVED LESSON with RLS gone, so lifecycle is not a policy either', async () => {
    // The last of the masked clauses. `l.status = 'published'` in the
    // retrieval join is shadowed by the RLS policy, which delegates to
    // `app_actor_sees_lesson` and asks the same thing — so with both gates up,
    // removing the join clause changed no result (defect injection F5).
    //
    // It matters on its own because it is what makes an archived lesson need
    // NO invalidation path: nobody has to remember to delete its chunks,
    // because the join stops serving them the instant the lesson's status
    // changes. That guarantee belongs to the query, not to the database's
    // permission system, and this is where it is checked.
    const w = await twoSchools();
    await indexCourse(w.reviewerA.cookie, w.courseA);

    const raw = new pg.Client({ connectionString: NO_RLS_URL });
    await raw.connect();
    try {
      // `updated_at` is deliberately PINNED to what it was. Archiving normally
      // bumps it, and the freshness equality would then withdraw the chunks on
      // its own — which is why the first version of this test passed with the
      // lifecycle clause deleted. Holding the timestamp still is what isolates
      // the one control being tested from the one standing next to it.
      await raw.query(
        `UPDATE lessons
            SET status = 'archived', published_at = NULL, archived_at = now(),
                updated_at = updated_at
          WHERE unit_id IN (SELECT id FROM course_units WHERE course_id = $1)`,
        [w.courseA],
      );
    } finally {
      await raw.end();
    }

    const { raw: bodyText, body } = await retrieve(w.learnerA.cookie, {
      query: 'mitochondrion respiration energy',
      topK: 20,
    });
    expect(body.chunks).toEqual([]);
    expect(bodyText).not.toContain('SCHOOLAONLY');
  });

  it('stops serving an EDITED lesson with RLS gone, so freshness is not a policy either', async () => {
    const w = await twoSchools();
    await indexCourse(w.reviewerA.cookie, w.courseA);
    expect((await retrieve(w.learnerA.cookie, { query: 'mitochondrion respiration' })).body.chunks
      .length).toBeGreaterThan(0);

    const raw = new pg.Client({ connectionString: NO_RLS_URL });
    await raw.connect();
    try {
      await raw.query(
        `UPDATE lessons SET content_body = 'Replaced text about ribosomes.', updated_at = now()
          WHERE unit_id IN (SELECT id FROM course_units WHERE course_id = $1)`,
        [w.courseA],
      );
    } finally {
      await raw.end();
    }

    // The stale chunks are still in the table and still visible to this
    // connection. The `source_updated_at = l.updated_at` join in the retrieval
    // query is what withdraws them, and it is application SQL — no row policy
    // is involved in freshness at all.
    const { raw: bodyText, body } = await retrieve(w.learnerA.cookie, {
      query: 'mitochondrion respiration energy',
      topK: 20,
    });
    expect(body.chunks).toEqual([]);
    expect(bodyText).not.toContain('SCHOOLAONLY');
  });
});

describe('the AI tutor, with RLS disabled', () => {
  /**
   * THE BLOCK THAT ANSWERS "WHICH GATE DID THE WORK?" FOR CONVERSATIONS.
   *
   * This domain needs it more than most, because its read set and its write set
   * are deliberately different shapes: a teacher and a moderator may READ a
   * child's transcript, and nobody but the child may write to it. A suite run
   * with both gates up cannot tell whether the moderator's read was admitted by
   * the policy or merely not refused by RLS, nor whether the moderator's WRITE
   * was refused by the policy or only by a row-security check.
   *
   * With BYPASSRLS every conversation and every message is visible to the
   * database client, so anything refused below was refused by the application.
   */
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

  const CELLS = [
    'The mitochondrion is the organelle where respiration releases energy.',
    'Respiration combines glucose and oxygen to release usable energy as ATP.',
  ]
    .join('\n\n')
    .repeat(4);

  /** Two schools, one enrolled learner each, plus the adults. */
  async function twoSchools() {
    const orgA = await createOrganization('Tutor NoRLS A');
    const orgB = await createOrganization('Tutor NoRLS B');
    const levelId = await createEducationLevel();

    const learnerA = await seedAndLogin('nrls-tut-a@test.local', undefined, orgA);
    const learnerA2 = await seedAndLogin('nrls-tut-a2@test.local', undefined, orgA);
    const learnerB = await seedAndLogin('nrls-tut-b@test.local', undefined, orgB);
    const teacherA = await seedAndLogin('nrls-tut-teacher@test.local', ['teacher'], orgA);
    const teacherOther = await seedAndLogin('nrls-tut-teacher2@test.local', ['teacher'], orgA);
    const moderatorA = await seedAndLogin('nrls-tut-mod@test.local', ['moderator'], orgA);
    const moderatorB = await seedAndLogin('nrls-tut-mod-b@test.local', ['moderator'], orgB);

    const build = async (organizationId: string, code: string, marker: string) => {
      const curriculumId = await createCurriculum({
        organizationId,
        code,
        status: 'published',
      });
      const courseId = await createCourse({
        organizationId,
        curriculumId,
        levelId,
        title: `${code} science`,
        status: 'published',
      });
      const unitId = await createUnit({ courseId, status: 'published' });
      const lessonId = await createLesson({
        unitId,
        title: `${code} cells`,
        status: 'published',
        contentBody: `${marker} ${CELLS}`,
      });
      return { courseId, lessonId };
    };

    const a = await build(orgA, 'nta', 'SCHOOLAONLY');
    const b = await build(orgB, 'ntb', 'SCHOOLBONLY');

    const classA = await createClass(orgA, 'NoRLS Tutor A');
    await addClassMember(classA, learnerA.id);
    await addClassMember(classA, learnerA2.id);
    await assignCourseToClass({ classId: classA, courseId: a.courseId });
    await assignTeacher(teacherA.id, classA);

    const classB = await createClass(orgB, 'NoRLS Tutor B');
    await addClassMember(classB, learnerB.id);
    await assignCourseToClass({ classId: classB, courseId: b.courseId });

    return {
      learnerA, learnerA2, learnerB, teacherA, teacherOther, moderatorA, moderatorB,
      lessonA: a.lessonId, lessonB: b.lessonId, classA,
    };
  }

  const start = async (cookie: string, lessonId: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/conversations',
      headers: { ...writeHeaders, cookie },
      payload: { lessonId },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string }>().id;
  };

  const say = (cookie: string, id: string, content: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/ai/conversations/${id}/messages`,
      headers: { ...writeHeaders, cookie },
      payload: { content },
    });

  const read = (cookie: string, id: string) =>
    app.inject({ method: 'GET', url: `/api/v1/ai/conversations/${id}/messages`, headers: { cookie } });

  it('CONFIRMS EVERY CONVERSATION IS VISIBLE TO THE CLIENT, so the rest means something', async () => {
    const w = await twoSchools();
    const a = await start(w.learnerA.cookie, w.lessonA);
    await say(w.learnerA.cookie, a, 'what does a mitochondrion do');
    await start(w.learnerB.cookie, w.lessonB);

    const raw = new pg.Client({ connectionString: NO_RLS_URL });
    await raw.connect();
    try {
      // No `app.actor_id` is set. Under RLS this is zero rows; here it must
      // show both schools' conversations and the transcript, which is what
      // makes every refusal below an application property.
      const conversations = await raw.query('SELECT id FROM ai_conversations');
      expect(conversations.rows.length).toBe(2);
      const messages = await raw.query('SELECT id FROM ai_messages');
      expect(messages.rows.length).toBeGreaterThan(0);
    } finally {
      await raw.end();
    }
  });

  it('refuses a peer reading another learner’s transcript by exact id', async () => {
    const w = await twoSchools();
    const id = await start(w.learnerA.cookie, w.lessonA);
    await say(w.learnerA.cookie, id, 'my private question about respiration');

    const response = await read(w.learnerA2.cookie, id);
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('my private question');
  });

  it('refuses a peer speaking into it', async () => {
    const w = await twoSchools();
    const id = await start(w.learnerA.cookie, w.lessonA);
    expect((await say(w.learnerA2.cookie, id, 'hello')).statusCode).toBe(404);
  });

  it('refuses a learner in another school', async () => {
    const w = await twoSchools();
    const id = await start(w.learnerA.cookie, w.lessonA);
    expect((await read(w.learnerB.cookie, id)).statusCode).toBe(404);
  });

  it('LISTS ONLY THE CALLER’S OWN, with every row visible to the client', async () => {
    // The listing case, where a single gate is most expensive to be wrong about
    // (VULN-017). The repository scopes by the session's own id, so this
    // returns one row even though the connection can see both.
    const w = await twoSchools();
    await start(w.learnerA.cookie, w.lessonA);
    await start(w.learnerA2.cookie, w.lessonA);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ai/conversations',
      headers: { cookie: w.learnerA.cookie },
    });
    expect(response.json<{ conversations: unknown[] }>().conversations).toHaveLength(1);
  });

  it('ADMITS THE TEACHER WHO TEACHES THEM, and refuses the one who does not', async () => {
    // Both halves in one test on purpose: with RLS gone, an admit that came
    // from nothing and a refusal that came from nothing look identical unless
    // the pair is checked together.
    const w = await twoSchools();
    const id = await start(w.learnerA.cookie, w.lessonA);
    await say(w.learnerA.cookie, id, 'what is respiration');

    expect((await read(w.teacherA.cookie, id)).statusCode).toBe(200);
    expect((await read(w.teacherOther.cookie, id)).statusCode).toBe(404);
  });

  it('admits a moderator in the same school and refuses one from another', async () => {
    const w = await twoSchools();
    const id = await start(w.learnerA.cookie, w.lessonA);
    expect((await read(w.moderatorA.cookie, id)).statusCode).toBe(200);
    expect((await read(w.moderatorB.cookie, id)).statusCode).toBe(404);
  });

  it('REFUSES EVERY ADULT WRITE, which no row policy is doing here', async () => {
    // The read set is wider than the write set in this domain, and this is the
    // gap. Reading a transcript is oversight; editing one is tampering, and a
    // moderator who could archive a conversation could hide it from the next
    // moderator. With RLS off, only `aiConversationPolicy` is saying no.
    const w = await twoSchools();
    const id = await start(w.learnerA.cookie, w.lessonA);

    for (const who of [w.teacherA, w.moderatorA]) {
      expect((await say(who.cookie, id, 'adult speaking')).statusCode).toBe(404);

      const archived = await app.inject({
        method: 'POST',
        url: `/api/v1/ai/conversations/${id}/archive`,
        headers: { ...bodylessWriteHeaders, cookie: who.cookie },
      });
      expect(archived.statusCode).toBe(404);

      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/v1/ai/conversations/${id}`,
        headers: { ...writeHeaders, cookie: who.cookie },
        payload: { title: 'Edited by an adult' },
      });
      expect(renamed.statusCode).toBe(404);
    }
  });

  it('refuses starting a conversation about another school’s lesson', async () => {
    const w = await twoSchools();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/conversations',
      headers: { ...writeHeaders, cookie: w.learnerA.cookie },
      payload: { lessonId: w.lessonB },
    });
    expect(response.statusCode).toBe(404);
  });

  it('STOPS A REVOKED LEARNER TALKING, with RLS gone', async () => {
    // The trigger in migration 0027 re-asks `app_actor_may_study_lesson` on
    // every turn, and so does the policy. This asserts the POLICY does it
    // alone — the database's own copy of the rule is switched off here.
    const w = await twoSchools();
    const id = await start(w.learnerA.cookie, w.lessonA);
    expect((await say(w.learnerA.cookie, id, 'what is respiration')).statusCode).toBe(200);

    const raw = new pg.Client({ connectionString: NO_RLS_URL });
    await raw.connect();
    try {
      await raw.query(
        `UPDATE class_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1`,
        [w.learnerA.id],
      );
    } finally {
      await raw.end();
    }

    expect((await say(w.learnerA.cookie, id, 'and ATP?')).statusCode).toBe(403);
    // Their own history survives, which is the half a blunt revocation would
    // have taken with it.
    expect((await read(w.learnerA.cookie, id)).statusCode).toBe(200);
  });

  it('NEVER SURFACES ANOTHER SCHOOL’S LESSON TEXT, with every chunk readable', async () => {
    const w = await twoSchools();
    const id = await start(w.learnerA.cookie, w.lessonA);
    const response = await say(w.learnerA.cookie, id, 'mitochondrion respiration energy');
    expect(response.body).not.toContain('SCHOOLBONLY');
  });
});

describe('projects and portfolios, with RLS disabled', () => {
  /**
   * THE BLOCK THAT ANSWERS "WHICH GATE DID THE WORK?" FOR THE PUBLIC ROUTE.
   *
   * `GET /portfolios/share/:key` is the only unauthenticated content route on
   * this platform, which makes it the one place where standing on a single gate
   * is least acceptable — and where it was, when this block was first written.
   *
   * The resolver originally carried no WHERE clause at all: it selected from
   * `student_portfolios` and let RLS match the key. That reads well and is
   * wrong, because with RLS removed it returned whatever portfolio happened to
   * be first, to anybody, for any key. The repository now asks the same
   * predicate itself — published, and the presented key matches this row —
   * from the same transaction-local GUC. These tests are what that fix is for.
   */
  async function makeProject(
    cookie: string,
    classId: string,
    visibility: string,
    title = 'Work',
  ): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { ...writeHeaders, cookie },
      payload: { title, classId, visibility },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ id: string }>().id;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${id}`,
      headers: { ...writeHeaders, cookie },
      payload: { status: 'submitted' },
    });
    return id;
  }

  async function publish(cookie: string, projectId: string): Promise<string> {
    await app.inject({
      method: 'POST',
      url: '/api/v1/me/portfolio',
      headers: { ...writeHeaders, cookie },
      payload: { title: 'My work' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/me/portfolio/items',
      headers: { ...writeHeaders, cookie },
      payload: { projectId },
    });
    const published = await app.inject({
      method: 'POST',
      url: '/api/v1/me/portfolio/publish',
      headers: { ...writeHeaders, cookie },
      // An explicit empty object: `writeHeaders` declares a JSON content type,
      // and Fastify rejects a body-less request that claims to have one.
      payload: {},
    });
    expect(published.statusCode, published.body).toBe(200);
    return published.json<{ shareToken: string }>().shareToken;
  }

  /** One school, one class, two learners in it. */
  async function classWorld() {
    const org = await createOrganization('Layered School');
    const klass = await createClass(org, 'L1');
    const owner = await registerAndLogin('pf-owner@test.local');
    const peer = await registerAndLogin('pf-peer@test.local');

    const raw = new pg.Client({ connectionString: NO_RLS_URL });
    await raw.connect();
    try {
      await raw.query('UPDATE users SET organization_id = $1 WHERE id = ANY($2::uuid[])', [
        org,
        [owner.id, peer.id],
      ]);
    } finally {
      await raw.end();
    }
    await addClassMember(klass, owner.id);
    await addClassMember(klass, peer.id);
    return { org, klass, owner, peer };
  }

  it('REFUSES A PEER READING ANOTHER LEARNER’S PRIVATE PROJECT, with every row visible', async () => {
    const w = await classWorld();
    const project = await makeProject(w.owner.cookie, w.klass, 'private');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project}`,
      headers: { cookie: w.peer.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('REFUSES A PEER UPDATING OR DELETING IT', async () => {
    const w = await classWorld();
    const project = await makeProject(w.owner.cookie, w.klass, 'class');

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${project}`,
      headers: { ...writeHeaders, cookie: w.peer.cookie },
      payload: { title: 'Mine now' },
    });
    expect(updated.statusCode).toBe(404);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${project}`,
      headers: { ...bodylessWriteHeaders, cookie: w.peer.cookie },
    });
    expect(deleted.statusCode).toBe(404);
  });

  it('LISTS ONLY THE CALLER’S OWN PROJECTS', async () => {
    const w = await classWorld();
    await makeProject(w.owner.cookie, w.klass, 'public', 'Theirs');
    await makeProject(w.peer.cookie, w.klass, 'public', 'Mine');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me/projects',
      headers: { cookie: w.peer.cookie },
    });
    const items = response.json<{ items: { title: string }[] }>().items;
    expect(items.map((i) => i.title)).toEqual(['Mine']);
  });

  it('REFUSES A PEER READING ANOTHER LEARNER’S PORTFOLIO', async () => {
    const w = await classWorld();
    const project = await makeProject(w.owner.cookie, w.klass, 'public');
    await publish(w.owner.cookie, project);

    // `/me/portfolio` resolves by the SESSION's id in the repository's own SQL,
    // so the peer gets their own absence rather than the owner's page.
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me/portfolio',
      headers: { cookie: w.peer.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('SERVES NOTHING FOR A WRONG KEY, with every portfolio visible to the client', async () => {
    const w = await classWorld();
    const project = await makeProject(w.owner.cookie, w.klass, 'public', 'Published');
    await publish(w.owner.cookie, project);

    // THE CASE THAT FAILED. With RLS gone and no WHERE clause, this returned
    // the owner's page to anybody presenting any well-formed key.
    const wrong = await app.inject({
      method: 'GET',
      url: `/api/v1/portfolios/share/${'d'.repeat(64)}`,
    });
    expect(wrong.statusCode).toBe(404);
    expect(wrong.body).not.toContain('Published');
  });

  it('SERVES NOTHING ONCE WITHDRAWN, with the row still there to be found', async () => {
    const w = await classWorld();
    const project = await makeProject(w.owner.cookie, w.klass, 'public', 'Published');
    const token = await publish(w.owner.cookie, project);
    expect((await app.inject({ url: `/api/v1/portfolios/share/${token}` })).statusCode).toBe(200);

    await app.inject({
      method: 'DELETE',
      url: '/api/v1/me/portfolio/publish',
      headers: { ...bodylessWriteHeaders, cookie: w.owner.cookie },
    });

    const after = await app.inject({ url: `/api/v1/portfolios/share/${token}` });
    expect(after.statusCode).toBe(404);
    expect(after.body).not.toContain('Published');
  });

  it('HIDES A PRIVATE PROJECT FROM THE PUBLIC PAGE, with every row readable', async () => {
    const w = await classWorld();
    const shown = await makeProject(w.owner.cookie, w.klass, 'public', 'Shown');
    const token = await publish(w.owner.cookie, shown);

    const hidden = await makeProject(w.owner.cookie, w.klass, 'private', 'HIDDENWORK');
    await app.inject({
      method: 'POST',
      url: '/api/v1/me/portfolio/items',
      headers: { ...writeHeaders, cookie: w.owner.cookie },
      payload: { projectId: hidden },
    });

    const page = await app.inject({ url: `/api/v1/portfolios/share/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('HIDDENWORK');
    expect(page.json<{ projects: unknown[] }>().projects).toHaveLength(1);
  });

  it('NEVER PUTS AN IDENTIFIER ON THE PUBLIC PAGE, whatever the database returns', async () => {
    const w = await classWorld();
    const project = await makeProject(w.owner.cookie, w.klass, 'public');
    const token = await publish(w.owner.cookie, project);

    // The sanitizer is a pure constructor, so this holds with no gate at all:
    // it is the one control in this domain that does not depend on a query.
    const body = (await app.inject({ url: `/api/v1/portfolios/share/${token}` })).body;
    for (const secret of [project, w.owner.id, w.org, w.klass, token, 'pf-owner@test.local']) {
      expect(body, `${secret} leaked`).not.toContain(secret);
    }
  });
});
