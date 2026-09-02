import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  bodylessWriteHeaders,
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
  createEducationLevel,
  createOrganization,
  createUser,
  grantRole,
  truncateAll,
} from '../setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';

/**
 * The curriculum surface, end to end over the real HTTP stack.
 *
 * The scenarios section 3 of the task names by hand:
 *   - a student reaching draft or archived content,
 *   - content leaking between organizations,
 *   - a teacher modifying global or another school's courses,
 *   - a sort parameter reaching SQL.
 *
 * Everything is built through the API rather than seeded, so the tests exercise
 * the same path a client would — including the publish workflow, which is the
 * only way content becomes visible to a learner.
 */
let testApp: TestApp;

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
  if (options.globalSecurityAdmin) {
    await grantRole(user.id, 'security_admin', 'global', null);
  }
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

const get = (url: string, cookie: string) =>
  testApp.app.inject({ method: 'GET', url, headers: { cookie } });

const post = (url: string, cookie: string, payload?: Record<string, unknown>) =>
  payload === undefined
    ? testApp.app.inject({ method: 'POST', url, headers: { ...bodylessWriteHeaders, cookie } })
    : testApp.app.inject({ method: 'POST', url, headers: { ...writeHeaders, cookie }, payload });

const patch = (url: string, cookie: string, payload: Record<string, unknown>) =>
  testApp.app.inject({ method: 'PATCH', url, headers: { ...writeHeaders, cookie }, payload });

const put = (url: string, cookie: string, payload: Record<string, unknown>) =>
  testApp.app.inject({ method: 'PUT', url, headers: { ...writeHeaders, cookie }, payload });

const del = (url: string, cookie: string) =>
  testApp.app.inject({ method: 'DELETE', url, headers: { ...bodylessWriteHeaders, cookie } });

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

const id = (r: { json: <T>() => T }) => r.json<{ id: string }>().id;
const ids = (r: { json: <T>() => T }) =>
  r.json<{ items: { id: string }[] }>().items.map((i) => i.id);

/**
 * A school with the four editorial standings the permission split creates.
 *
 * `author` may write drafts, `reviewer` may only move the lifecycle, `admin`
 * holds both, and `student` holds neither.
 */
async function school(prefix: string, levelId: string) {
  const organizationId = await createOrganization(`School ${prefix}`);
  const author = await seedAndLogin({
    email: `${prefix}-author@test.local`,
    roles: ['content_author'],
    organizationId,
  });
  const teacher = await seedAndLogin({
    email: `${prefix}-teacher@test.local`,
    roles: ['teacher'],
    organizationId,
  });
  const reviewer = await seedAndLogin({
    email: `${prefix}-reviewer@test.local`,
    roles: ['reviewer'],
    organizationId,
  });
  const admin = await seedAndLogin({
    email: `${prefix}-admin@test.local`,
    roles: ['admin'],
    organizationId,
  });
  const student = await seedAndLogin({
    email: `${prefix}-student@test.local`,
    organizationId,
  });

  const curriculum = await post('/api/v1/curricula', author.cookie, {
    code: `${prefix}_math`,
    name: 'Mathematics',
  });
  expect(curriculum.statusCode).toBe(201);
  const curriculumId = id(curriculum);

  const course = await post('/api/v1/courses', author.cookie, {
    curriculumId,
    levelId,
    title: 'Algebra',
  });
  expect(course.statusCode).toBe(201);

  // Task 006: a learner reaches published content only through a class. The
  // school therefore has one, with the student enrolled — but NOTHING is
  // assigned to it here. Each test assigns exactly what it means to test, so a
  // missing assignment shows up as a failure rather than as silent visibility.
  const classId = await createClass(organizationId, `Class ${prefix}`);
  await addClassMember(classId, student.id);

  return {
    organizationId,
    classId,
    author,
    teacher,
    reviewer,
    admin,
    student,
    curriculumId,
    courseId: id(course),
  };
}

/** Puts a course in front of a class's learners. */
const study = (classId: string, courseId: string) => assignCourseToClass({ classId, courseId });

/** Publishes a whole chain, which is the only way a learner ever sees it. */
async function publishChain(
  cookie: string,
  ids: { curriculumId?: string; courseId?: string; unitId?: string; lessonId?: string },
) {
  if (ids.curriculumId)
    expect((await post(`/api/v1/curricula/${ids.curriculumId}/publish`, cookie)).statusCode).toBe(
      200,
    );
  if (ids.courseId)
    expect((await post(`/api/v1/courses/${ids.courseId}/publish`, cookie)).statusCode).toBe(200);
  if (ids.unitId)
    expect((await post(`/api/v1/units/${ids.unitId}/publish`, cookie)).statusCode).toBe(200);
  if (ids.lessonId)
    expect((await post(`/api/v1/lessons/${ids.lessonId}/publish`, cookie)).statusCode).toBe(200);
}

let levelId: string;

beforeEach(async () => {
  await truncateAll();
  testApp = await buildTestApp();
  levelId = await createEducationLevel();
});

afterAll(async () => {
  await testApp?.db.close();
  await closeSeedDb();
});

// =========================================================================
describe('education levels', () => {
  it('lets any authenticated actor list them', async () => {
    const a = await school('a', levelId);
    const listed = await get('/api/v1/education-levels', a.student.cookie);
    expect(listed.statusCode).toBe(200);
    expect(ids(listed)).toEqual([levelId]);
  });

  it.each(['student', 'content_author', 'teacher', 'reviewer', 'admin'])(
    'REFUSES a %s creating one',
    async (role) => {
      const organizationId = await createOrganization('School X');
      const actor = await seedAndLogin({
        email: `lvl-${role}@test.local`,
        roles: [role],
        organizationId,
      });
      const response = await post('/api/v1/education-levels', actor.cookie, {
        code: 'sneak',
        name: 'X',
        stage: 'middle',
      });
      // 403, not 404: the actor can already read every level.
      expect(response.statusCode).toBe(403);
    },
  );

  it('lets a platform operator create one', async () => {
    const operator = await seedAndLogin({
      email: 'op@test.local',
      organizationId: null,
      globalSecurityAdmin: true,
    });
    const response = await post('/api/v1/education-levels', operator.cookie, {
      code: 'grade_8',
      name: 'Grade 8',
      stage: 'middle',
      grade: 8,
    });
    expect(response.statusCode).toBe(201);
    expect(await auditTypes()).toContain('content.education_level_changed');
  });

  it('rejects an unknown stage rather than storing it', async () => {
    const operator = await seedAndLogin({
      email: 'op@test.local',
      organizationId: null,
      globalSecurityAdmin: true,
    });
    expect(
      (
        await post('/api/v1/education-levels', operator.cookie, {
          code: 'x',
          name: 'X',
          stage: 'kindergarten',
        })
      ).statusCode,
    ).toBe(400);
  });
});

// =========================================================================
describe('authoring', () => {
  it('lets an author create a curriculum, a course, a unit and a lesson', async () => {
    const a = await school('a', levelId);
    const unit = await post(`/api/v1/courses/${a.courseId}/units`, a.author.cookie, {
      title: 'Unit One',
    });
    expect(unit.statusCode).toBe(201);
    const lesson = await post(`/api/v1/units/${id(unit)}/lessons`, a.author.cookie, {
      title: 'Lesson One',
      contentBody: '# مرحبا',
    });
    expect(lesson.statusCode).toBe(201);
    expect(lesson.json<{ position: number }>().position).toBe(1);
    expect(await auditTypes()).toContain('content.created');
  });

  it('assigns positions server-side, in sequence', async () => {
    const a = await school('a', levelId);
    const positions: number[] = [];
    for (const title of ['A', 'B', 'C']) {
      const unit = await post(`/api/v1/courses/${a.courseId}/units`, a.author.cookie, { title });
      positions.push(unit.json<{ position: number }>().position);
    }
    expect(positions).toEqual([1, 2, 3]);
  });

  it('REFUSES a position supplied by the client', async () => {
    const a = await school('a', levelId);
    // Mass assignment: `position` is not in the contract, so `.strict()` rejects it.
    const response = await post(`/api/v1/courses/${a.courseId}/units`, a.author.cookie, {
      title: 'X',
      position: 99,
    });
    expect(response.statusCode).toBe(400);
  });

  it('REFUSES a body that asserts its own status, organization, or authorship', async () => {
    const a = await school('a', levelId);
    for (const forged of [
      { status: 'published' },
      { organizationId: a.organizationId },
      { createdBy: a.admin.id },
    ]) {
      const response = await post('/api/v1/curricula', a.author.cookie, {
        code: 'forged',
        name: 'X',
        ...forged,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('REFUSES a student authoring anything', async () => {
    const a = await school('a', levelId);
    expect(
      (await post('/api/v1/curricula', a.student.cookie, { code: 'sneak', name: 'X' })).statusCode,
    ).toBe(404);
    expect(
      (await post(`/api/v1/courses/${a.courseId}/units`, a.student.cookie, { title: 'X' }))
        .statusCode,
    ).toBe(404);
  });

  it('REFUSES a reviewer authoring — publishing is not writing', async () => {
    const a = await school('a', levelId);
    const response = await post('/api/v1/curricula', a.reviewer.cookie, { code: 'rev', name: 'X' });
    expect(response.statusCode).toBe(403);
  });

  it('REFUSES a lesson carrying a javascript: or data: URL', async () => {
    const a = await school('a', levelId);
    const unit = await post(`/api/v1/courses/${a.courseId}/units`, a.author.cookie, { title: 'U' });
    for (const externalUrl of [
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'http://example.org',
      'file:///etc/passwd',
    ]) {
      const response = await post(`/api/v1/units/${id(unit)}/lessons`, a.author.cookie, {
        title: 'X',
        externalUrl,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('REFUSES an HTML content format', async () => {
    const a = await school('a', levelId);
    const unit = await post(`/api/v1/courses/${a.courseId}/units`, a.author.cookie, { title: 'U' });
    const response = await post(`/api/v1/units/${id(unit)}/lessons`, a.author.cookie, {
      title: 'X',
      contentFormat: 'html',
      contentBody: '<script>alert(1)</script>',
    });
    expect(response.statusCode).toBe(400);
  });

  it('stores a script-looking body verbatim without interpreting it', async () => {
    // Markdown is stored as written; nothing on the server renders it. The
    // defence is that HTML is never an accepted FORMAT, not that the body is
    // sanitised — a renderer must still escape.
    const a = await school('a', levelId);
    const unit = await post(`/api/v1/courses/${a.courseId}/units`, a.author.cookie, { title: 'U' });
    const body = '<script>alert(1)</script>';
    const lesson = await post(`/api/v1/units/${id(unit)}/lessons`, a.author.cookie, {
      title: 'X',
      contentFormat: 'plain',
      contentBody: body,
    });
    expect(lesson.statusCode).toBe(201);
    expect(lesson.json<{ contentBody: string }>().contentBody).toBe(body);
  });
});

// =========================================================================
describe('the publishing workflow', () => {
  it('REFUSES an author publishing their own draft', async () => {
    const a = await school('a', levelId);
    const response = await post(`/api/v1/curricula/${a.curriculumId}/publish`, a.author.cookie);
    expect(response.statusCode).toBe(403);
  });

  it('REFUSES a teacher publishing', async () => {
    const a = await school('a', levelId);
    expect((await post(`/api/v1/courses/${a.courseId}/publish`, a.teacher.cookie)).statusCode).toBe(
      403,
    );
  });

  it('lets a reviewer publish, and records it', async () => {
    const a = await school('a', levelId);
    const response = await post(`/api/v1/curricula/${a.curriculumId}/publish`, a.reviewer.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('published');
    expect(response.json<{ publishedAt: string | null }>().publishedAt).not.toBeNull();
    expect(await auditTypes()).toContain('content.published');
  });

  it('REFUSES publishing twice, and REFUSES un-publishing', async () => {
    const a = await school('a', levelId);
    await publishChain(a.reviewer.cookie, { curriculumId: a.curriculumId });
    expect(
      (await post(`/api/v1/curricula/${a.curriculumId}/publish`, a.reviewer.cookie)).statusCode,
    ).toBe(403);
    // There is no un-publish endpoint at all — the surface does not exist.
    expect(
      (await patch(`/api/v1/curricula/${a.curriculumId}`, a.author.cookie, { name: 'ok' }))
        .statusCode,
    ).toBe(200);
  });

  it('archives, and then refuses every edit', async () => {
    const a = await school('a', levelId);
    const archived = await post(`/api/v1/curricula/${a.curriculumId}/archive`, a.admin.cookie);
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ status: string }>().status).toBe('archived');
    expect(await auditTypes()).toContain('content.archived');

    expect(
      (await patch(`/api/v1/curricula/${a.curriculumId}`, a.author.cookie, { name: 'x' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await post(`/api/v1/curricula/${a.curriculumId}/archive`, a.admin.cookie)).statusCode,
    ).toBe(403);
    expect((await del(`/api/v1/curricula/${a.curriculumId}`, a.author.cookie)).statusCode).toBe(
      403,
    );
  });
});

// =========================================================================
describe('IDOR / BOLA — draft and archived content', () => {
  it('REFUSES a student reading a draft course, unit or lesson', async () => {
    const a = await school('a', levelId);
    const unit = await post(`/api/v1/courses/${a.courseId}/units`, a.author.cookie, {
      title: 'Unit One',
    });
    const lesson = await post(`/api/v1/units/${id(unit)}/lessons`, a.author.cookie, { title: 'L' });

    for (const url of [
      `/api/v1/curricula/${a.curriculumId}`,
      `/api/v1/courses/${a.courseId}`,
      `/api/v1/units/${id(unit)}`,
      `/api/v1/lessons/${id(lesson)}`,
    ]) {
      const response = await get(url, a.student.cookie);
      // 404 — a 403 would confirm the id names real content.
      expect(response.statusCode).toBe(404);
      // The title never appears in the body — not even as a "you may not read
      // 'Unit One'" message, which would itself confirm the id.
      expect(response.body).not.toContain('Unit One');
    }
  });

  it('REFUSES a student listing draft content', async () => {
    const a = await school('a', levelId);
    expect(ids(await get('/api/v1/curricula', a.student.cookie))).toEqual([]);
    expect(ids(await get('/api/v1/courses', a.student.cookie))).toEqual([]);
  });

  it('shows a student published content, and nothing else in the same list', async () => {
    const a = await school('a', levelId);
    const second = await post('/api/v1/curricula', a.author.cookie, { code: 'a_phys', name: 'P' });
    await publishChain(a.reviewer.cookie, { curriculumId: a.curriculumId });

    expect(ids(await get('/api/v1/curricula', a.student.cookie))).toEqual([a.curriculumId]);
    expect(ids(await get('/api/v1/curricula', a.student.cookie))).not.toContain(id(second));
  });

  it('REFUSES TO PUBLISH a lesson whose UNIT is still a draft', async () => {
    // CHANGED BY TASK 011, deliberately, and the old expectation is worth
    // recording. This test used to publish the lesson successfully and assert
    // only that a learner could not see it — the lifecycle was per-node, so a
    // published child of a draft parent was a reachable state that happened to
    // be invisible.
    //
    // 0022 makes that state unreachable instead. The visibility guarantee is
    // unchanged and now rests on something stronger than a chain check at read
    // time: the tree cannot be put into the inconsistent shape at all.
    const a = await school('a', levelId);
    const unit = await post(`/api/v1/courses/${a.courseId}/units`, a.author.cookie, { title: 'U' });
    const lesson = await post(`/api/v1/units/${id(unit)}/lessons`, a.author.cookie, {
      title: 'L',
      contentBody: 'Something to read',
    });
    await publishChain(a.reviewer.cookie, { curriculumId: a.curriculumId, courseId: a.courseId });

    const refused = await post(`/api/v1/lessons/${id(lesson)}/publish`, a.reviewer.cookie);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { message: string } }>().error.message).toMatch(/unit or course/i);

    await study(a.classId, a.courseId);
    expect((await get(`/api/v1/courses/${a.courseId}`, a.student.cookie)).statusCode).toBe(200);
    expect((await get(`/api/v1/lessons/${id(lesson)}`, a.student.cookie)).statusCode).toBe(404);

    // And publishing IN ORDER works, so the rule is about sequence rather than
    // about permission.
    expect((await post(`/api/v1/units/${id(unit)}/publish`, a.reviewer.cookie)).statusCode).toBe(
      200,
    );
    expect(
      (await post(`/api/v1/lessons/${id(lesson)}/publish`, a.reviewer.cookie)).statusCode,
    ).toBe(200);
    expect((await get(`/api/v1/lessons/${id(lesson)}`, a.student.cookie)).statusCode).toBe(200);
  });

  it('hides content again once it is archived', async () => {
    const a = await school('a', levelId);
    await publishChain(a.reviewer.cookie, { curriculumId: a.curriculumId });
    expect((await get(`/api/v1/curricula/${a.curriculumId}`, a.student.cookie)).statusCode).toBe(
      200,
    );

    expect(
      (await post(`/api/v1/curricula/${a.curriculumId}/archive`, a.reviewer.cookie)).statusCode,
    ).toBe(200);
    expect((await get(`/api/v1/curricula/${a.curriculumId}`, a.student.cookie)).statusCode).toBe(
      404,
    );
    // ...and the author can still see it, because history is theirs to keep.
    expect((await get(`/api/v1/curricula/${a.curriculumId}`, a.author.cookie)).statusCode).toBe(
      200,
    );
  });
});

// =========================================================================
describe('IDOR / BOLA — across organizations', () => {
  it('hides one school’s PUBLISHED content from another school entirely', async () => {
    const a = await school('a', levelId);
    const b = await school('b', levelId);
    await publishChain(a.reviewer.cookie, {
      curriculumId: a.curriculumId,
      courseId: a.courseId,
    });

    for (const cookie of [b.student.cookie, b.author.cookie, b.admin.cookie]) {
      expect((await get(`/api/v1/courses/${a.courseId}`, cookie)).statusCode).toBe(404);
      expect(ids(await get('/api/v1/courses', cookie))).not.toContain(a.courseId);
    }
  });

  it('REFUSES an author of another school editing, publishing or deleting', async () => {
    const a = await school('a', levelId);
    const b = await school('b', levelId);
    expect(
      (await patch(`/api/v1/courses/${a.courseId}`, b.author.cookie, { title: 'owned' }))
        .statusCode,
    ).toBe(404);
    expect((await post(`/api/v1/courses/${a.courseId}/publish`, b.admin.cookie)).statusCode).toBe(
      404,
    );
    expect((await del(`/api/v1/courses/${a.courseId}`, b.author.cookie)).statusCode).toBe(404);
  });

  it('REFUSES filing a course under another school’s curriculum', async () => {
    const a = await school('a', levelId);
    const b = await school('b', levelId);
    const response = await post('/api/v1/courses', b.author.cookie, {
      curriculumId: a.curriculumId,
      levelId,
      title: 'X',
    });
    // 404 on the curriculum, before the database's structural check is reached.
    expect(response.statusCode).toBe(404);
  });

  it('REFUSES adding a unit to another school’s course', async () => {
    const a = await school('a', levelId);
    const b = await school('b', levelId);
    expect(
      (await post(`/api/v1/courses/${a.courseId}/units`, b.author.cookie, { title: 'X' }))
        .statusCode,
    ).toBe(404);
  });

  it('REFUSES reordering another school’s units', async () => {
    const a = await school('a', levelId);
    const b = await school('b', levelId);
    const unit = await post(`/api/v1/courses/${a.courseId}/units`, a.author.cookie, { title: 'U' });
    expect(
      (
        await put(`/api/v1/courses/${a.courseId}/units/order`, b.author.cookie, {
          order: [id(unit)],
        })
      ).statusCode,
    ).toBe(404);
  });
});

// =========================================================================
describe('IDOR / BOLA — the global catalog', () => {
  async function globalCourse(operatorCookie: string) {
    const curriculum = await post('/api/v1/curricula', operatorCookie, {
      code: 'global_math',
      name: 'Mathematics',
      global: true,
    });
    expect(curriculum.statusCode).toBe(201);
    const course = await post('/api/v1/courses', operatorCookie, {
      curriculumId: id(curriculum),
      levelId,
      title: 'National Algebra',
      global: true,
    });
    expect(course.statusCode).toBe(201);
    return { curriculumId: id(curriculum), courseId: id(course) };
  }

  it('REFUSES a school actor creating global content, at every role', async () => {
    const a = await school('a', levelId);
    for (const cookie of [a.student.cookie, a.author.cookie, a.teacher.cookie, a.admin.cookie]) {
      const response = await post('/api/v1/curricula', cookie, {
        code: 'sneak_global',
        name: 'X',
        global: true,
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it('REFUSES a TEACHER and an ADMIN modifying a global course', async () => {
    const operator = await seedAndLogin({
      email: 'op@test.local',
      organizationId: null,
      globalSecurityAdmin: true,
    });
    const g = await globalCourse(operator.cookie);
    const a = await school('a', levelId);

    for (const cookie of [a.teacher.cookie, a.author.cookie, a.admin.cookie]) {
      expect(
        (await patch(`/api/v1/courses/${g.courseId}`, cookie, { title: 'owned' })).statusCode,
      ).toBe(404);
      expect((await post(`/api/v1/courses/${g.courseId}/publish`, cookie)).statusCode).toBe(404);
      expect((await del(`/api/v1/courses/${g.courseId}`, cookie)).statusCode).toBe(404);
      expect(
        (await post(`/api/v1/courses/${g.courseId}/units`, cookie, { title: 'X' })).statusCode,
      ).toBe(404);
    }
  });

  it('lets every school READ published global content', async () => {
    const operator = await seedAndLogin({
      email: 'op@test.local',
      organizationId: null,
      globalSecurityAdmin: true,
    });
    const g = await globalCourse(operator.cookie);
    await publishChain(operator.cookie, { curriculumId: g.curriculumId, courseId: g.courseId });

    const a = await school('a', levelId);
    const b = await school('b', levelId);
    // A global course is readable by any school — once a class in that school
    // is actually studying it. Publication alone stopped being enough in 0017.
    for (const s of [a, b]) {
      expect((await get(`/api/v1/courses/${g.courseId}`, s.student.cookie)).statusCode).toBe(404);
      await study(s.classId, g.courseId);
      expect((await get(`/api/v1/courses/${g.courseId}`, s.student.cookie)).statusCode).toBe(200);
      expect(ids(await get('/api/v1/courses', s.student.cookie))).toContain(g.courseId);
    }
  });

  it('hides an UNPUBLISHED global course from every school', async () => {
    const operator = await seedAndLogin({
      email: 'op@test.local',
      organizationId: null,
      globalSecurityAdmin: true,
    });
    const g = await globalCourse(operator.cookie);
    const a = await school('a', levelId);
    expect((await get(`/api/v1/courses/${g.courseId}`, a.admin.cookie)).statusCode).toBe(404);
  });
});

// =========================================================================
describe('reordering', () => {
  async function threeUnits(a: Awaited<ReturnType<typeof school>>) {
    const created: string[] = [];
    for (const title of ['A', 'B', 'C']) {
      const unit = await post(`/api/v1/courses/${a.courseId}/units`, a.author.cookie, { title });
      created.push(id(unit));
    }
    return created;
  }

  it('rewrites the whole sequence and returns it in order', async () => {
    const a = await school('a', levelId);
    const [u1, u2, u3] = await threeUnits(a);

    const response = await put(`/api/v1/courses/${a.courseId}/units/order`, a.author.cookie, {
      order: [u3, u1, u2],
    });
    expect(response.statusCode).toBe(200);
    expect(ids(response)).toEqual([u3, u1, u2]);
    expect(response.json<{ items: { position: number }[] }>().items.map((i) => i.position)).toEqual(
      [1, 2, 3],
    );
    expect(await auditTypes()).toContain('content.reordered');
  });

  it('REFUSES an order that omits an item', async () => {
    const a = await school('a', levelId);
    const [u1, u2] = await threeUnits(a);
    const response = await put(`/api/v1/courses/${a.courseId}/units/order`, a.author.cookie, {
      order: [u1, u2],
    });
    expect(response.statusCode).toBe(409);
  });

  it('REFUSES an order naming an id from another course', async () => {
    const a = await school('a', levelId);
    const units = await threeUnits(a);
    const other = await post('/api/v1/courses', a.author.cookie, {
      curriculumId: a.curriculumId,
      levelId,
      title: 'Other',
    });
    const foreign = await post(`/api/v1/courses/${id(other)}/units`, a.author.cookie, {
      title: 'Foreign',
    });
    const response = await put(`/api/v1/courses/${a.courseId}/units/order`, a.author.cookie, {
      order: [...units.slice(0, 2), id(foreign)],
    });
    expect(response.statusCode).toBe(409);
    // ...and the foreign unit kept its position.
    expect(
      (await get(`/api/v1/courses/${id(other)}/units`, a.author.cookie)).json<{
        items: { position: number }[];
      }>().items[0]?.position,
    ).toBe(1);
  });

  it('REFUSES a repeated id', async () => {
    const a = await school('a', levelId);
    const [u1] = await threeUnits(a);
    const response = await put(`/api/v1/courses/${a.courseId}/units/order`, a.author.cookie, {
      order: [u1, u1, u1],
    });
    expect(response.statusCode).toBe(400);
  });

  it('REFUSES a student reordering', async () => {
    const a = await school('a', levelId);
    const units = await threeUnits(a);
    expect(
      (await put(`/api/v1/courses/${a.courseId}/units/order`, a.student.cookie, { order: units }))
        .statusCode,
    ).toBe(404);
  });

  it('reorders lessons within a unit the same way', async () => {
    const a = await school('a', levelId);
    const unit = await post(`/api/v1/courses/${a.courseId}/units`, a.author.cookie, { title: 'U' });
    const lessons: string[] = [];
    for (const title of ['L1', 'L2', 'L3']) {
      lessons.push(id(await post(`/api/v1/units/${id(unit)}/lessons`, a.author.cookie, { title })));
    }
    const reversed = [...lessons].reverse();
    const response = await put(`/api/v1/units/${id(unit)}/lessons/order`, a.author.cookie, {
      order: reversed,
    });
    expect(response.statusCode).toBe(200);
    expect(ids(response)).toEqual(reversed);
  });
});

// =========================================================================
describe('deletion', () => {
  it('lets an author delete a DRAFT, and refuses a published one', async () => {
    const a = await school('a', levelId);
    const draft = await post('/api/v1/curricula', a.author.cookie, { code: 'tmp', name: 'T' });
    expect((await del(`/api/v1/curricula/${id(draft)}`, a.author.cookie)).statusCode).toBe(204);
    expect(await auditTypes()).toContain('content.deleted');

    await publishChain(a.reviewer.cookie, { curriculumId: a.curriculumId });
    expect((await del(`/api/v1/curricula/${a.curriculumId}`, a.author.cookie)).statusCode).toBe(
      403,
    );
  });

  it('cascades a course delete to its units and lessons', async () => {
    const a = await school('a', levelId);
    const unit = await post(`/api/v1/courses/${a.courseId}/units`, a.author.cookie, { title: 'U' });
    const lesson = await post(`/api/v1/units/${id(unit)}/lessons`, a.author.cookie, { title: 'L' });

    expect((await del(`/api/v1/courses/${a.courseId}`, a.author.cookie)).statusCode).toBe(204);
    expect((await get(`/api/v1/units/${id(unit)}`, a.author.cookie)).statusCode).toBe(404);
    expect((await get(`/api/v1/lessons/${id(lesson)}`, a.author.cookie)).statusCode).toBe(404);
  });

  it('REFUSES deleting a curriculum that still has courses', async () => {
    const a = await school('a', levelId);
    // ON DELETE RESTRICT: the catalog entry cannot vanish from under its
    // courses. Surfaced as a 409, not a 500.
    const response = await del(`/api/v1/curricula/${a.curriculumId}`, a.author.cookie);
    expect(response.statusCode).toBe(409);
  });

  it('REFUSES a student deleting anything', async () => {
    const a = await school('a', levelId);
    expect((await del(`/api/v1/courses/${a.courseId}`, a.student.cookie)).statusCode).toBe(404);
  });
});

// =========================================================================
describe('query parameter safety', () => {
  it('rejects a sort field that is not on the allow-list', async () => {
    const a = await school('a', levelId);
    for (const sort of ['created_at; DROP TABLE courses', 'organization_id', 'created_by', '1']) {
      const response = await get(
        `/api/v1/courses?sort=${encodeURIComponent(sort)}`,
        a.author.cookie,
      );
      expect(response.statusCode).toBe(400);
    }
  });

  it('rejects an unknown query parameter rather than ignoring it', async () => {
    const a = await school('a', levelId);
    expect((await get('/api/v1/courses?organizationId=x', a.author.cookie)).statusCode).toBe(400);
  });

  it('rejects an out-of-range limit and a non-numeric offset', async () => {
    const a = await school('a', levelId);
    expect((await get('/api/v1/courses?limit=5000', a.author.cookie)).statusCode).toBe(400);
    expect((await get('/api/v1/courses?offset=abc', a.author.cookie)).statusCode).toBe(400);
  });

  it('applies allow-listed filters without widening the result set', async () => {
    const a = await school('a', levelId);
    const b = await school('b', levelId);
    await publishChain(b.reviewer.cookie, { curriculumId: b.curriculumId, courseId: b.courseId });

    // `scope=organization` cannot reach another school: the organization it
    // resolves to is the SESSION's, never a parameter.
    const listed = await get('/api/v1/courses?scope=organization', a.author.cookie);
    expect(ids(listed)).toEqual([a.courseId]);
    expect(ids(listed)).not.toContain(b.courseId);
  });

  it('filters by level and status', async () => {
    const a = await school('a', levelId);
    await publishChain(a.reviewer.cookie, { curriculumId: a.curriculumId, courseId: a.courseId });
    expect(ids(await get(`/api/v1/courses?levelId=${levelId}`, a.author.cookie))).toEqual([
      a.courseId,
    ]);
    expect(ids(await get('/api/v1/courses?status=draft', a.author.cookie))).toEqual([]);
    expect(ids(await get('/api/v1/courses?status=published', a.author.cookie))).toEqual([
      a.courseId,
    ]);
  });
});

// =========================================================================
describe('authentication is required throughout', () => {
  it('refuses every content route without a session', async () => {
    const a = await school('a', levelId);
    for (const [method, url] of [
      ['GET', '/api/v1/curricula'],
      ['GET', `/api/v1/courses/${a.courseId}`],
      ['GET', '/api/v1/education-levels'],
      ['GET', `/api/v1/courses/${a.courseId}/units`],
    ] as const) {
      const response = await testApp.app.inject({ method, url });
      expect(response.statusCode).toBe(401);
    }
  });
});
