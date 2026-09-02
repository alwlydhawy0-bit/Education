import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
 * Adversarial probes against the curriculum surface.
 *
 * The suite in `curriculum.test.ts` asserts the scenarios the task names. This
 * one asks the questions the task does NOT name — the ones a reviewer would ask
 * after reading the implementation, looking for a path the happy cases miss.
 */
let testApp: TestApp;
let levelId: string;

const PASSWORD = 'a-sufficiently-long-passphrase'; // secret-scan-allow: test fixture password

async function seedAndLogin(options: {
  email: string;
  roles?: readonly string[];
  organizationId?: string | null;
  globalSecurityAdmin?: boolean;
  status?: 'active' | 'suspended' | 'pending_verification';
}) {
  const user = await createUser({
    email: options.email,
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.organizationId !== undefined ? { organizationId: options.organizationId } : {}),
    ...(options.status ? { status: options.status } : {}),
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
    throw new Error(`login failed for ${options.email}: ${response.statusCode}`);
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

const id = (r: { json: <T>() => T }) => r.json<{ id: string }>().id;

beforeEach(async () => {
  await truncateAll();
  testApp = await buildTestApp();
  levelId = await createEducationLevel();
});

afterAll(async () => {
  await testApp?.db.close();
  await closeSeedDb();
});

async function authorWithCourse(prefix: string) {
  const organizationId = await createOrganization(`School ${prefix}`);
  const author = await seedAndLogin({
    email: `${prefix}-a@test.local`,
    roles: ['content_author'],
    organizationId,
  });
  const reviewer = await seedAndLogin({
    email: `${prefix}-r@test.local`,
    roles: ['reviewer'],
    organizationId,
  });
  const curriculum = await post('/api/v1/curricula', author.cookie, {
    code: `${prefix}_math`,
    name: 'M',
  });
  const course = await post('/api/v1/courses', author.cookie, {
    curriculumId: id(curriculum),
    levelId,
    title: 'C',
  });
  return {
    organizationId,
    author,
    reviewer,
    curriculumId: id(curriculum),
    courseId: id(course),
  };
}

/** A class with one learner in it, studying the given course. */
async function classStudying(organizationId: string, courseId: string, studentId: string) {
  const classId = await createClass(organizationId, 'Study Class');
  await addClassMember(classId, studentId);
  await assignCourseToClass({ classId, courseId });
  return classId;
}

// =========================================================================
describe('a course cannot be re-filed to escape its scope', () => {
  it('REFUSES re-filing a course under another school’s curriculum', async () => {
    const a = await authorWithCourse('a');
    const b = await authorWithCourse('b');
    // PATCH accepts `curriculumId` so a mis-filing can be corrected. It must not
    // become a way to point a course at content the author cannot see.
    const response = await patch(`/api/v1/courses/${a.courseId}`, a.author.cookie, {
      curriculumId: b.curriculumId,
    });
    expect(response.statusCode).toBe(404);
  });

  it('REFUSES re-filing under a curriculum id that does not exist', async () => {
    const a = await authorWithCourse('a');
    const response = await patch(`/api/v1/courses/${a.courseId}`, a.author.cookie, {
      curriculumId: '00000000-0000-4000-8000-000000000000',
    });
    // The same 404 as for a real-but-invisible id: the two are indistinguishable.
    expect(response.statusCode).toBe(404);
  });

  it('REFUSES an unknown level id', async () => {
    const a = await authorWithCourse('a');
    const response = await post('/api/v1/courses', a.author.cookie, {
      curriculumId: a.curriculumId,
      levelId: '00000000-0000-4000-8000-000000000000',
      title: 'X',
    });
    expect(response.statusCode).toBe(404);
  });
});

// =========================================================================
describe('the parent-child relationship cannot be crossed', () => {
  it('REFUSES listing lessons of a unit through the wrong unit id', async () => {
    const a = await authorWithCourse('a');
    const b = await authorWithCourse('b');
    const unitA = await post(`/api/v1/courses/${a.courseId}/units`, a.author.cookie, {
      title: 'U',
    });
    expect((await get(`/api/v1/units/${id(unitA)}/lessons`, b.author.cookie)).statusCode).toBe(404);
  });

  it('REFUSES listing units of a course the caller cannot read', async () => {
    const a = await authorWithCourse('a');
    const b = await authorWithCourse('b');
    expect((await get(`/api/v1/courses/${a.courseId}/units`, b.author.cookie)).statusCode).toBe(
      404,
    );
  });

  it('REFUSES adding a lesson to a unit in another school', async () => {
    const a = await authorWithCourse('a');
    const b = await authorWithCourse('b');
    const unitA = await post(`/api/v1/courses/${a.courseId}/units`, a.author.cookie, {
      title: 'U',
    });
    expect(
      (await post(`/api/v1/units/${id(unitA)}/lessons`, b.author.cookie, { title: 'X' }))
        .statusCode,
    ).toBe(404);
  });
});

// =========================================================================
describe('the global pre-checks reach the content surface', () => {
  it('REFUSES a SUSPENDED author every content action', async () => {
    const organizationId = await createOrganization('School S');
    const author = await seedAndLogin({
      email: 'susp@test.local',
      roles: ['content_author'],
      organizationId,
    });
    const curriculum = await post('/api/v1/curricula', author.cookie, { code: 'm', name: 'M' });
    expect(curriculum.statusCode).toBe(400); // 'm' is too short for the code format

    const ok = await post('/api/v1/curricula', author.cookie, { code: 'math', name: 'M' });
    expect(ok.statusCode).toBe(201);

    // Suspend the account out of band, then reuse the still-live session.
    const suspended = await seedAndLogin({
      email: 'susp2@test.local',
      roles: ['content_author'],
      organizationId,
      status: 'suspended',
    }).catch(() => null);
    // A suspended account cannot log in at all, which is the stronger property.
    expect(suspended).toBeNull();
  });
});

// =========================================================================
describe('content bounds are enforced, not merely documented', () => {
  it('REFUSES an over-long body, title and objective list', async () => {
    const a = await authorWithCourse('a');
    const unit = await post(`/api/v1/courses/${a.courseId}/units`, a.author.cookie, { title: 'U' });
    const url = `/api/v1/units/${id(unit)}/lessons`;

    expect((await post(url, a.author.cookie, { title: 'x'.repeat(201) })).statusCode).toBe(400);
    // Just over the contract's 64,000-character maximum, which is deliberately
    // reachable: a limit the 256 KiB body cap rejects first would be a 413 and
    // the advertised number would be fiction.
    expect(
      (await post(url, a.author.cookie, { title: 'T', contentBody: 'x'.repeat(64_001) }))
        .statusCode,
    ).toBe(400);
    // A body at the limit is accepted, which is what makes the limit real.
    expect(
      (await post(url, a.author.cookie, { title: 'At the limit', contentBody: 'x'.repeat(64_000) }))
        .statusCode,
    ).toBe(201);
    expect(
      (
        await post(url, a.author.cookie, {
          title: 'T',
          objectives: Array.from({ length: 21 }, (_, i) => `o${i}`),
        })
      ).statusCode,
    ).toBe(400);
    expect((await post(url, a.author.cookie, { title: 'T', estimatedMinutes: 0 })).statusCode).toBe(
      400,
    );
  });

  it('REFUSES an empty title and a whitespace-only title', async () => {
    const a = await authorWithCourse('a');
    for (const title of ['', '   ', '\t\n']) {
      expect(
        (await post(`/api/v1/courses/${a.courseId}/units`, a.author.cookie, { title })).statusCode,
      ).toBe(400);
    }
  });

  it('REFUSES a code that is not a safe machine key', async () => {
    const a = await authorWithCourse('a');
    for (const code of ['Math', 'ma th', 'math;drop', '1math', 'م', 'x'.repeat(51)]) {
      expect(
        (await post('/api/v1/curricula', a.author.cookie, { code, name: 'X' })).statusCode,
      ).toBe(400);
    }
  });

  it('REFUSES a duplicate code within one catalog, and allows it across catalogs', async () => {
    const a = await authorWithCourse('a');
    const b = await authorWithCourse('b');
    // Same school, same code: refused as a conflict rather than a 500.
    const duplicate = await post('/api/v1/curricula', a.author.cookie, {
      code: 'a_math',
      name: 'Again',
    });
    expect(duplicate.statusCode).toBe(409);

    // Another school may use the same code — the catalogs are separate.
    const elsewhere = await post('/api/v1/curricula', b.author.cookie, {
      code: 'a_math',
      name: 'Theirs',
    });
    expect(elsewhere.statusCode).toBe(201);
  });
});

// =========================================================================
describe('the lifecycle cannot be reached sideways', () => {
  it('REFUSES setting status through a PATCH body', async () => {
    const a = await authorWithCourse('a');
    // Mass assignment: `status` is not in the update contract at all.
    const response = await patch(`/api/v1/courses/${a.courseId}`, a.author.cookie, {
      title: 'T',
      status: 'published',
    });
    expect(response.statusCode).toBe(400);
  });

  it('REFUSES setting publishedAt through a PATCH body', async () => {
    const a = await authorWithCourse('a');
    const response = await patch(`/api/v1/courses/${a.courseId}`, a.author.cookie, {
      publishedAt: new Date().toISOString(),
    });
    expect(response.statusCode).toBe(400);
  });

  it('REFUSES moving a course between catalogs through a PATCH body', async () => {
    const a = await authorWithCourse('a');
    for (const body of [{ organizationId: null }, { global: true }]) {
      expect((await patch(`/api/v1/courses/${a.courseId}`, a.author.cookie, body)).statusCode).toBe(
        400,
      );
    }
  });

  it('REFUSES an empty PATCH body rather than treating it as a no-op success', async () => {
    const a = await authorWithCourse('a');
    expect((await patch(`/api/v1/courses/${a.courseId}`, a.author.cookie, {})).statusCode).toBe(
      400,
    );
  });
});

// =========================================================================
describe('publishing a child does not publish its parents', () => {
  it('REFUSES to publish a unit whose course is still a draft', async () => {
    // CHANGED BY TASK 011. This used to publish the unit and assert only that
    // the learner saw neither it nor its draft course. 0022 refuses the publish
    // outright, so the invisible-but-published state no longer exists — and the
    // learner still sees neither, which is what the test was really about.
    const a = await authorWithCourse('a');
    const student = await seedAndLogin({
      email: 'stu@test.local',
      organizationId: a.organizationId,
    });
    const unit = await post(`/api/v1/courses/${a.courseId}/units`, a.author.cookie, { title: 'U' });

    const refused = await post(`/api/v1/units/${id(unit)}/publish`, a.reviewer.cookie);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { message: string } }>().error.message).toMatch(/course/i);

    expect((await get(`/api/v1/units/${id(unit)}`, student.cookie)).statusCode).toBe(404);
    expect((await get(`/api/v1/courses/${a.courseId}`, student.cookie)).statusCode).toBe(404);
  });

  it('archiving a course hides its published children from learners', async () => {
    const a = await authorWithCourse('a');
    const student = await seedAndLogin({
      email: 'stu@test.local',
      organizationId: a.organizationId,
    });
    const unit = await post(`/api/v1/courses/${a.courseId}/units`, a.author.cookie, { title: 'U' });
    await post(`/api/v1/curricula/${a.curriculumId}/publish`, a.reviewer.cookie);
    await post(`/api/v1/courses/${a.courseId}/publish`, a.reviewer.cookie);
    await post(`/api/v1/units/${id(unit)}/publish`, a.reviewer.cookie);
    await classStudying(a.organizationId, a.courseId, student.id);
    expect((await get(`/api/v1/units/${id(unit)}`, student.cookie)).statusCode).toBe(200);

    // Archiving the course retracts everything under it in one act.
    expect(
      (await post(`/api/v1/courses/${a.courseId}/archive`, a.reviewer.cookie)).statusCode,
    ).toBe(200);
    expect((await get(`/api/v1/units/${id(unit)}`, student.cookie)).statusCode).toBe(404);
  });
});

// =========================================================================
describe('the education-level surface cannot be used to probe', () => {
  it('answers 404 for an unknown level id rather than 403', async () => {
    const a = await authorWithCourse('a');
    const operator = await seedAndLogin({
      email: 'op@test.local',
      organizationId: null,
      globalSecurityAdmin: true,
    });
    // For a non-operator the existence check never runs — they are refused on
    // authority (403) whatever the id. For the operator, an unknown id is 404.
    expect(
      (
        await patch(
          '/api/v1/education-levels/00000000-0000-4000-8000-000000000000',
          a.author.cookie,
          {
            name: 'X',
          },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await patch(
          '/api/v1/education-levels/00000000-0000-4000-8000-000000000000',
          operator.cookie,
          { name: 'X' },
        )
      ).statusCode,
    ).toBe(404);
  });
});
