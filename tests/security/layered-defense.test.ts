import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildTestApp, sessionCookieFrom, writeHeaders, type TestApp } from '../setup/app.ts';
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
