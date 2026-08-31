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
  grantRole,
  truncateAll,
} from '../setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';

/**
 * Course-to-class assignment, end to end over the real HTTP stack.
 *
 * The scenarios section 2.D of the task names by hand:
 *   - a learner reaching a published course NOT assigned to their class,
 *   - a cross-organization assignment attempt,
 *   - a learner assigning or unassigning,
 *   - a former member losing access the moment their membership ends.
 *
 * Content is seeded; the ASSIGNMENTS are made through the API, because the
 * assignment path is what this file is testing.
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

const get = (url: string, cookie: string) =>
  testApp.app.inject({ method: 'GET', url, headers: { cookie } });

const post = (url: string, cookie: string, payload?: Record<string, unknown>) =>
  payload === undefined
    ? testApp.app.inject({ method: 'POST', url, headers: { ...bodylessWriteHeaders, cookie } })
    : testApp.app.inject({ method: 'POST', url, headers: { ...writeHeaders, cookie }, payload });

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

const items = <T>(r: { json: <U>() => U }) => r.json<{ items: T[] }>().items;
const courseIds = (r: { json: <U>() => U }) =>
  items<{ courseId: string }>(r).map((i) => i.courseId);

let levelId: string;

/**
 * A school with a class, its teacher and learner, and two published courses —
 * one assigned by the test, one deliberately left unassigned as the control.
 */
async function school(prefix: string) {
  const organizationId = await createOrganization(`School ${prefix}`);
  const admin = await seedAndLogin({
    email: `${prefix}-admin@t.local`,
    roles: ['admin'],
    organizationId,
  });
  const teacher = await seedAndLogin({
    email: `${prefix}-teacher@t.local`,
    roles: ['teacher'],
    organizationId,
  });
  const otherTeacher = await seedAndLogin({
    email: `${prefix}-teacher2@t.local`,
    roles: ['teacher'],
    organizationId,
  });
  const student = await seedAndLogin({ email: `${prefix}-student@t.local`, organizationId });
  const outsider = await seedAndLogin({ email: `${prefix}-outsider@t.local`, organizationId });

  const classId = await createClass(organizationId, `Class ${prefix}`);
  await addClassMember(classId, student.id);
  await assignTeacher(teacher.id, classId);

  const curriculumId = await createCurriculum({
    organizationId,
    code: `${prefix}_math`,
    status: 'published',
  });
  const mkCourse = async (title: string, status: 'draft' | 'published' = 'published') => {
    const course = await createCourse({
      organizationId,
      curriculumId,
      levelId,
      title,
      status,
    });
    const unit = await createUnit({
      courseId: course,
      title: `${title} Unit`,
      status: 'published',
    });
    const lesson = await createLesson({
      unitId: unit,
      title: `${title} Lesson`,
      status: 'published',
    });
    return { course, unit, lesson };
  };

  const assigned = await mkCourse(`${prefix} Physics`);
  const unassigned = await mkCourse(`${prefix} Chemistry`);
  const draft = await mkCourse(`${prefix} Draft`, 'draft');

  return {
    organizationId,
    classId,
    admin,
    teacher,
    otherTeacher,
    student,
    outsider,
    curriculumId,
    assigned,
    unassigned,
    draft,
  };
}

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
describe('assigning a course to a class', () => {
  it('lets an administrator assign, and records both parties', async () => {
    const a = await school('a');
    const response = await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ courseId: string }>().courseId).toBe(a.assigned.course);
    expect(response.json<{ status: string }>().status).toBe('active');
    expect(await auditTypes()).toContain('class.course_assigned');
  });

  it('lets a TEACHER OF THAT CLASS assign', async () => {
    const a = await school('a');
    expect(
      (
        await post(`/api/v1/classes/${a.classId}/courses`, a.teacher.cookie, {
          courseId: a.assigned.course,
        })
      ).statusCode,
    ).toBe(201);
  });

  it('REFUSES a teacher who does not teach that class', async () => {
    const a = await school('a');
    expect(
      (
        await post(`/api/v1/classes/${a.classId}/courses`, a.otherTeacher.cookie, {
          courseId: a.assigned.course,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('REFUSES a STUDENT assigning, enrolled or not', async () => {
    const a = await school('a');
    for (const cookie of [a.student.cookie, a.outsider.cookie]) {
      const response = await post(`/api/v1/classes/${a.classId}/courses`, cookie, {
        courseId: a.assigned.course,
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it('REFUSES assigning a DRAFT course', async () => {
    const a = await school('a');
    const response = await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.draft.course,
    });
    // 403: the administrator can see this course, so hiding it would confuse.
    expect(response.statusCode).toBe(403);
  });

  it('REFUSES a duplicate active assignment, and allows one after withdrawal', async () => {
    const a = await school('a');
    const body = { courseId: a.assigned.course };
    expect(
      (await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, body)).statusCode,
    ).toBe(201);
    expect(
      (await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, body)).statusCode,
    ).toBe(409);

    expect(
      (await del(`/api/v1/classes/${a.classId}/courses/${a.assigned.course}`, a.admin.cookie))
        .statusCode,
    ).toBe(204);
    expect(
      (await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, body)).statusCode,
    ).toBe(201);
  });

  it('REFUSES a body that asserts its own status or assigner', async () => {
    const a = await school('a');
    for (const forged of [
      { status: 'archived' },
      { assignedBy: a.student.id },
      { classId: a.classId },
    ]) {
      const response = await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
        courseId: a.assigned.course,
        ...forged,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('REFUSES a due date before the start date', async () => {
    const a = await school('a');
    const response = await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
      startsOn: '2026-09-01',
      dueOn: '2026-08-01',
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers 404 for a class or a course that does not exist', async () => {
    const a = await school('a');
    const absent = '00000000-0000-4000-8000-000000000000';
    expect(
      (
        await post(`/api/v1/classes/${absent}/courses`, a.admin.cookie, {
          courseId: a.assigned.course,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, { courseId: absent }))
        .statusCode,
    ).toBe(404);
  });
});

// =========================================================================
describe('IDOR / BOLA — content reaches only the classes it is assigned to', () => {
  it('REFUSES a learner a PUBLISHED course their class was not assigned', async () => {
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });

    expect((await get(`/api/v1/courses/${a.assigned.course}`, a.student.cookie)).statusCode).toBe(
      200,
    );
    // Same school, same publication state, no assignment.
    const refused = await get(`/api/v1/courses/${a.unassigned.course}`, a.student.cookie);
    expect(refused.statusCode).toBe(404);
    expect(refused.body).not.toContain('Chemistry');
  });

  it('REFUSES the units and lessons of an unassigned course', async () => {
    const a = await school('a');
    for (const url of [
      `/api/v1/units/${a.unassigned.unit}`,
      `/api/v1/lessons/${a.unassigned.lesson}`,
      `/api/v1/courses/${a.unassigned.course}/units`,
      `/api/v1/units/${a.unassigned.unit}/lessons`,
    ]) {
      expect((await get(url, a.student.cookie)).statusCode).toBe(404);
    }
  });

  it('shows a learner only assigned courses in a listing', async () => {
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });
    const listed = items<{ id: string }>(await get('/api/v1/courses', a.student.cookie));
    expect(listed.map((c) => c.id)).toEqual([a.assigned.course]);
  });

  it('REFUSES a learner in the school but in NO class', async () => {
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });
    expect((await get(`/api/v1/courses/${a.assigned.course}`, a.outsider.cookie)).statusCode).toBe(
      404,
    );
    expect(items(await get('/api/v1/courses', a.outsider.cookie))).toEqual([]);
  });

  it('leaves an EDITOR’s access untouched — no assignment needed', async () => {
    const a = await school('a');
    // The administrator sees every course in their school, assigned or not,
    // because they maintain it rather than study it.
    const listed = items<{ id: string }>(await get('/api/v1/courses', a.admin.cookie));
    expect(listed.map((c) => c.id).sort()).toEqual(
      [a.assigned.course, a.unassigned.course, a.draft.course].sort(),
    );
  });
});

// =========================================================================
describe('IDOR / BOLA — across organizations', () => {
  it('REFUSES assigning another school’s course to this class', async () => {
    const a = await school('a');
    const b = await school('b');
    const response = await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: b.assigned.course,
    });
    expect(response.statusCode).toBe(404);
  });

  it('REFUSES assigning this school’s course to another school’s class', async () => {
    const a = await school('a');
    const b = await school('b');
    expect(
      (
        await post(`/api/v1/classes/${b.classId}/courses`, a.admin.cookie, {
          courseId: a.assigned.course,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('REFUSES an administrator of another school assigning into this class', async () => {
    const a = await school('a');
    const b = await school('b');
    expect(
      (
        await post(`/api/v1/classes/${a.classId}/courses`, b.admin.cookie, {
          courseId: a.assigned.course,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('REFUSES another school reading or withdrawing an assignment', async () => {
    const a = await school('a');
    const b = await school('b');
    await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });
    expect(items(await get(`/api/v1/classes/${a.classId}/courses`, b.admin.cookie))).toEqual([]);
    expect(
      (await del(`/api/v1/classes/${a.classId}/courses/${a.assigned.course}`, b.admin.cookie))
        .statusCode,
    ).toBe(404);
  });

  it('lets a GLOBAL course be assigned — the one legal cross-catalog case', async () => {
    const operator = await seedAndLogin({
      email: 'op@t.local',
      organizationId: null,
      globalSecurityAdmin: true,
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
      title: 'National Physics',
      status: 'published',
    });
    void operator;

    const a = await school('a');
    expect((await get(`/api/v1/courses/${globalCourse}`, a.student.cookie)).statusCode).toBe(404);
    expect(
      (
        await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
          courseId: globalCourse,
        })
      ).statusCode,
    ).toBe(201);
    expect((await get(`/api/v1/courses/${globalCourse}`, a.student.cookie)).statusCode).toBe(200);
  });
});

// =========================================================================
describe('revocation is instant', () => {
  it('revokes on withdrawing the assignment', async () => {
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });
    expect((await get(`/api/v1/lessons/${a.assigned.lesson}`, a.student.cookie)).statusCode).toBe(
      200,
    );

    expect(
      (await del(`/api/v1/classes/${a.classId}/courses/${a.assigned.course}`, a.admin.cookie))
        .statusCode,
    ).toBe(204);
    expect(await auditTypes()).toContain('class.course_withdrawn');

    // The very next request, with the same live session.
    expect((await get(`/api/v1/lessons/${a.assigned.lesson}`, a.student.cookie)).statusCode).toBe(
      404,
    );
    expect((await get(`/api/v1/courses/${a.assigned.course}`, a.student.cookie)).statusCode).toBe(
      404,
    );
    expect(items(await get('/api/v1/me/courses', a.student.cookie))).toEqual([]);
  });

  it('revokes when the learner is REMOVED FROM THE CLASS', async () => {
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });
    expect((await get(`/api/v1/courses/${a.assigned.course}`, a.student.cookie)).statusCode).toBe(
      200,
    );

    expect(
      (await del(`/api/v1/classes/${a.classId}/members/${a.student.id}`, a.admin.cookie))
        .statusCode,
    ).toBe(204);

    // Immediately, on the same session — no re-login, no cache to expire.
    expect((await get(`/api/v1/courses/${a.assigned.course}`, a.student.cookie)).statusCode).toBe(
      404,
    );
    expect((await get(`/api/v1/lessons/${a.assigned.lesson}`, a.student.cookie)).statusCode).toBe(
      404,
    );
    expect(items(await get('/api/v1/me/courses', a.student.cookie))).toEqual([]);
  });

  it('revokes when the CLASS is archived', async () => {
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });
    expect((await post(`/api/v1/classes/${a.classId}/archive`, a.admin.cookie)).statusCode).toBe(
      200,
    );
    expect((await get(`/api/v1/courses/${a.assigned.course}`, a.student.cookie)).statusCode).toBe(
      404,
    );
  });

  it('revokes when the COURSE is archived, even with the assignment live', async () => {
    const a = await school('a');
    const reviewer = await seedAndLogin({
      email: 'a-reviewer@t.local',
      roles: ['reviewer'],
      organizationId: a.organizationId,
    });
    await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });
    expect((await get(`/api/v1/courses/${a.assigned.course}`, a.student.cookie)).statusCode).toBe(
      200,
    );

    expect(
      (await post(`/api/v1/courses/${a.assigned.course}/archive`, reviewer.cookie)).statusCode,
    ).toBe(200);
    expect((await get(`/api/v1/courses/${a.assigned.course}`, a.student.cookie)).statusCode).toBe(
      404,
    );
  });
});

// =========================================================================
describe('withdrawing an assignment', () => {
  it('REFUSES a student withdrawing', async () => {
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });
    expect(
      (await del(`/api/v1/classes/${a.classId}/courses/${a.assigned.course}`, a.student.cookie))
        .statusCode,
    ).toBe(404);
    // ...and the course is still there.
    expect((await get(`/api/v1/courses/${a.assigned.course}`, a.student.cookie)).statusCode).toBe(
      200,
    );
  });

  it('lets a teacher of the class withdraw', async () => {
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });
    expect(
      (await del(`/api/v1/classes/${a.classId}/courses/${a.assigned.course}`, a.teacher.cookie))
        .statusCode,
    ).toBe(204);
  });

  it('answers 404 for a course that was never assigned, and for a second withdrawal', async () => {
    const a = await school('a');
    expect(
      (await del(`/api/v1/classes/${a.classId}/courses/${a.unassigned.course}`, a.admin.cookie))
        .statusCode,
    ).toBe(404);

    await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });
    await del(`/api/v1/classes/${a.classId}/courses/${a.assigned.course}`, a.admin.cookie);
    expect(
      (await del(`/api/v1/classes/${a.classId}/courses/${a.assigned.course}`, a.admin.cookie))
        .statusCode,
    ).toBe(404);
  });

  it('REFUSES withdrawing under the WRONG class', async () => {
    const a = await school('a');
    const otherClass = await createClass(a.organizationId, 'Other');
    await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });
    // The assignment exists, and the admin administers both classes — but the
    // pairing in the URL does not name it.
    expect(
      (await del(`/api/v1/classes/${otherClass}/courses/${a.assigned.course}`, a.admin.cookie))
        .statusCode,
    ).toBe(404);
    expect((await get(`/api/v1/courses/${a.assigned.course}`, a.student.cookie)).statusCode).toBe(
      200,
    );
  });
});

// =========================================================================
describe('the class syllabus and the learner’s own list', () => {
  it('shows the syllabus to the class, its teacher and its administrator', async () => {
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });
    for (const cookie of [a.student.cookie, a.teacher.cookie, a.admin.cookie]) {
      const listed = items<{ courseId: string }>(
        await get(`/api/v1/classes/${a.classId}/courses`, cookie),
      );
      expect(listed.map((i) => i.courseId)).toEqual([a.assigned.course]);
    }
  });

  it('shows an EMPTY syllabus to somebody unattached, rather than a 404', async () => {
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });
    // Indistinguishable from a class with nothing assigned, which is the point.
    expect(items(await get(`/api/v1/classes/${a.classId}/courses`, a.outsider.cookie))).toEqual([]);
  });

  it('lists a learner’s own courses, with the class they came through', async () => {
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });
    const listed = items<{ courseId: string; classId: string; className: string }>(
      await get('/api/v1/me/courses', a.student.cookie),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.courseId).toBe(a.assigned.course);
    expect(listed[0]?.classId).toBe(a.classId);
    expect(listed[0]?.className).toBe('Class a');
  });

  it('gives each learner only their OWN courses', async () => {
    const a = await school('a');
    const b = await school('b');
    await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });
    await post(`/api/v1/classes/${b.classId}/courses`, b.admin.cookie, {
      courseId: b.assigned.course,
    });

    expect(courseIds(await get('/api/v1/me/courses', a.student.cookie))).toEqual([
      a.assigned.course,
    ]);
    expect(courseIds(await get('/api/v1/me/courses', b.student.cookie))).toEqual([
      b.assigned.course,
    ]);
    expect(items(await get('/api/v1/me/courses', a.outsider.cookie))).toEqual([]);
  });

  it('gives a TEACHER an empty /me/courses — it is a learner endpoint', async () => {
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });
    // A teacher reaches a class's courses through the class, not through this.
    expect(items(await get('/api/v1/me/courses', a.teacher.cookie))).toEqual([]);
    expect(items(await get(`/api/v1/classes/${a.classId}/courses`, a.teacher.cookie))).toHaveLength(
      1,
    );
  });

  it('excludes a WITHDRAWN course from the learner’s list but keeps it on the syllabus', async () => {
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie, {
      courseId: a.assigned.course,
    });
    await del(`/api/v1/classes/${a.classId}/courses/${a.assigned.course}`, a.admin.cookie);

    expect(items(await get('/api/v1/me/courses', a.student.cookie))).toEqual([]);
    // The record of what the class was taught survives the withdrawal.
    const syllabus = items<{ status: string }>(
      await get(`/api/v1/classes/${a.classId}/courses`, a.admin.cookie),
    );
    expect(syllabus.map((i) => i.status)).toEqual(['inactive']);
  });
});

// =========================================================================
describe('query parameter safety', () => {
  it('rejects a sort field that is not on the allow-list', async () => {
    const a = await school('a');
    for (const sort of ['assigned_by', 'assigned_at; DROP TABLE courses', 'class_id']) {
      expect(
        (
          await get(
            `/api/v1/classes/${a.classId}/courses?sort=${encodeURIComponent(sort)}`,
            a.admin.cookie,
          )
        ).statusCode,
      ).toBe(400);
      expect(
        (await get(`/api/v1/me/courses?sort=${encodeURIComponent(sort)}`, a.student.cookie))
          .statusCode,
      ).toBe(400);
    }
  });

  it('rejects an unknown query parameter, including one naming a user', async () => {
    const a = await school('a');
    expect((await get('/api/v1/me/courses?userId=x', a.student.cookie)).statusCode).toBe(400);
    expect((await get('/api/v1/me/courses?status=inactive', a.student.cookie)).statusCode).toBe(
      400,
    );
  });
});

// =========================================================================
describe('authentication is required throughout', () => {
  it('refuses every assignment route without a session', async () => {
    const a = await school('a');
    for (const [method, url] of [
      ['GET', '/api/v1/me/courses'],
      ['GET', `/api/v1/classes/${a.classId}/courses`],
      ['POST', `/api/v1/classes/${a.classId}/courses`],
      ['DELETE', `/api/v1/classes/${a.classId}/courses/${a.assigned.course}`],
    ] as const) {
      const response = await testApp.app.inject({
        method,
        url,
        headers: { origin: 'http://localhost:5173' },
      });
      expect(response.statusCode).toBe(401);
    }
  });
});
