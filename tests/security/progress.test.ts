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
  linkGuardian,
  recordProgress,
  truncateAll,
} from '../setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';

/**
 * Learner progress, end to end over the real HTTP stack.
 *
 * The scenarios section 2.D of the task names by hand:
 *   - a learner updating another learner's progress,
 *   - a learner logging progress on an unassigned lesson,
 *   - a teacher viewing a student who is not in their class,
 *   - a guardian viewing an unlinked student.
 *
 * Plus the retention rule from section 3, which is the property most easily
 * broken by an ordinary-looking refactor: losing access must stop the writing
 * without erasing the record.
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
  organizationSecurityAdmin?: string;
}): Promise<Session> {
  const user = await createUser({
    email: options.email,
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.organizationId !== undefined ? { organizationId: options.organizationId } : {}),
    passwordHash: await hashPassword(PASSWORD),
  });
  if (options.globalSecurityAdmin) await grantRole(user.id, 'security_admin', 'global', null);
  if (options.organizationSecurityAdmin) {
    await grantRole(user.id, 'security_admin', 'organization', options.organizationSecurityAdmin);
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

const items = <T>(r: { json: <U>() => U }) => r.json<{ items: T[] }>().items;
const lessons = (r: { json: <U>() => U }) =>
  items<{ lessonTitle: string }>(r).map((i) => i.lessonTitle);

/**
 * One school, two classes, one teacher across both.
 *
 * `learner` is in A1; course P is assigned to A1 and course Q to A2. That shape
 * is what separates "I teach them" from "I teach them THIS course".
 */
async function world() {
  const orgA = await createOrganization('School A');
  const orgB = await createOrganization('School B');
  const levelId = await createEducationLevel();

  const learner = await seedAndLogin({ email: 'learner@t.local', organizationId: orgA });
  const peer = await seedAndLogin({ email: 'peer@t.local', organizationId: orgA });
  const otherClassLearner = await seedAndLogin({
    email: 'other-class@t.local',
    organizationId: orgA,
  });
  const stranger = await seedAndLogin({ email: 'stranger@t.local', organizationId: orgA });
  const teacher = await seedAndLogin({
    email: 'teacher@t.local',
    roles: ['teacher'],
    organizationId: orgA,
  });
  const otherTeacher = await seedAndLogin({
    email: 'other-teacher@t.local',
    roles: ['teacher'],
    organizationId: orgA,
  });
  const admin = await seedAndLogin({
    email: 'admin@t.local',
    roles: ['admin'],
    organizationId: orgA,
  });
  const securityAdmin = await seedAndLogin({
    email: 'sec-admin@t.local',
    organizationId: orgA,
    organizationSecurityAdmin: orgA,
  });
  const guardian = await seedAndLogin({
    email: 'guardian@t.local',
    roles: ['guardian'],
    organizationId: orgA,
  });
  const otherGuardian = await seedAndLogin({
    email: 'other-guardian@t.local',
    roles: ['guardian'],
    organizationId: orgA,
  });
  const adminB = await seedAndLogin({
    email: 'admin-b@t.local',
    roles: ['admin'],
    organizationId: orgB,
  });

  const classA1 = await createClass(orgA, 'A1');
  const classA2 = await createClass(orgA, 'A2');
  const classB = await createClass(orgB, 'B1');
  await addClassMember(classA1, learner.id);
  await addClassMember(classA1, peer.id);
  await addClassMember(classA2, otherClassLearner.id);
  await assignTeacher(teacher.id, classA1);
  await assignTeacher(teacher.id, classA2);
  await assignTeacher(otherTeacher.id, classA2);
  await linkGuardian(guardian.id, learner.id, 'verified');
  await linkGuardian(otherGuardian.id, peer.id, 'verified');

  const curriculumA = await createCurriculum({ organizationId: orgA, status: 'published' });
  const mkCourse = async (title: string) => {
    const course = await createCourse({
      organizationId: orgA,
      curriculumId: curriculumA,
      levelId,
      title,
      status: 'published',
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
    const draftLesson = await createLesson({
      unitId: unit,
      title: `${title} Draft Lesson`,
      status: 'draft',
    });
    return { course, unit, lesson, draftLesson };
  };

  const P = await mkCourse('P');
  const Q = await mkCourse('Q');
  const U = await mkCourse('U');
  await assignCourseToClass({ classId: classA1, courseId: P.course });
  await assignCourseToClass({ classId: classA2, courseId: Q.course });

  return {
    orgA,
    orgB,
    classA1,
    classA2,
    classB,
    learner,
    peer,
    otherClassLearner,
    stranger,
    teacher,
    otherTeacher,
    admin,
    securityAdmin,
    guardian,
    otherGuardian,
    adminB,
    P,
    Q,
    U,
  };
}

beforeEach(async () => {
  await truncateAll();
  testApp = await buildTestApp();
});

afterAll(async () => {
  await testApp?.db.close();
  await closeSeedDb();
});

// =========================================================================
describe('recording your own progress', () => {
  it('records progress on an assigned lesson, and is idempotent', async () => {
    const w = await world();
    const first = await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, {
      status: 'in_progress',
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ status: string }>().status).toBe('in_progress');
    expect(first.json<{ completedAt: string | null }>().completedAt).toBeNull();
    expect(first.json<{ lessonTitle: string }>().lessonTitle).toBe('P Lesson');

    const again = await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, {
      status: 'in_progress',
    });
    expect(again.statusCode).toBe(200);
  });

  it('stamps a completion once, and keeps the original moment on a repeat', async () => {
    const w = await world();
    const done = await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, {
      status: 'completed',
    });
    expect(done.statusCode).toBe(200);
    const firstStamp = done.json<{ completedAt: string }>().completedAt;
    expect(firstStamp).not.toBeNull();

    const repeat = await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, {
      status: 'completed',
    });
    expect(repeat.json<{ completedAt: string }>().completedAt).toBe(firstStamp);
  });

  it('REFUSES going backwards', async () => {
    const w = await world();
    await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, { status: 'completed' });
    for (const status of ['in_progress', 'not_started']) {
      const response = await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, {
        status,
      });
      expect(response.statusCode).toBe(409);
    }
  });

  it('REFUSES a body carrying anything but a status', async () => {
    const w = await world();
    for (const forged of [
      { userId: w.peer.id },
      { completedAt: new Date().toISOString() },
      { lastAccessedAt: new Date().toISOString() },
      { lessonId: w.Q.lesson },
    ]) {
      const response = await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, {
        status: 'completed',
        ...forged,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('REFUSES an unknown status', async () => {
    const w = await world();
    expect(
      (
        await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, {
          status: 'mastered',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('offers no way to DELETE a record', async () => {
    const w = await world();
    await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, { status: 'completed' });
    // The route does not exist. Progress is a record of what a child did.
    expect((await del(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie)).statusCode).toBe(
      404,
    );
    expect(lessons(await get('/api/v1/me/progress', w.learner.cookie))).toEqual(['P Lesson']);
  });
});

// =========================================================================
describe('IDOR / BOLA — writing', () => {
  it('REFUSES a lesson whose course is not assigned to any class they are in', async () => {
    const w = await world();
    for (const lesson of [w.U.lesson, w.Q.lesson]) {
      const response = await put(`/api/v1/lessons/${lesson}/progress`, w.learner.cookie, {
        status: 'completed',
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it('REFUSES an unpublished lesson inside an assigned course', async () => {
    const w = await world();
    expect(
      (
        await put(`/api/v1/lessons/${w.P.draftLesson}/progress`, w.learner.cookie, {
          status: 'completed',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('REFUSES a learner in no class at all', async () => {
    const w = await world();
    expect(
      (
        await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.stranger.cookie, {
          status: 'completed',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('answers 404 for a lesson that does not exist, the same as one they may not touch', async () => {
    const w = await world();
    expect(
      (
        await put(
          '/api/v1/lessons/00000000-0000-4000-8000-000000000000/progress',
          w.learner.cookie,
          { status: 'completed' },
        )
      ).statusCode,
    ).toBe(404);
  });

  it.each([
    ['their teacher', 'teacher'],
    ['an administrator', 'admin'],
    ['their guardian', 'guardian'],
  ])('gives %s NO way to write a record about the learner', async (_label, who) => {
    const w = await world();
    const cookie = (w as unknown as Record<string, Session>)[who]!.cookie;
    // There is no endpoint that names a learner for a write. The only write
    // route derives the subject from the session, so the third party can only
    // ever write their OWN row — and they have no class access to this lesson.
    const response = await put(`/api/v1/lessons/${w.P.lesson}/progress`, cookie, {
      status: 'completed',
    });
    expect(response.statusCode).toBe(404);
    expect(items(await get('/api/v1/me/progress', w.learner.cookie))).toEqual([]);
  });

  it('records a denial when a write is refused', async () => {
    const w = await world();
    await put(`/api/v1/lessons/${w.U.lesson}/progress`, w.learner.cookie, { status: 'completed' });
    expect(await auditTypes()).toContain('authz.denied');
  });
});

// =========================================================================
describe('IDOR / BOLA — reading your own', () => {
  it('shows a learner only their own records', async () => {
    const w = await world();
    await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, { status: 'completed' });
    await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.peer.cookie, { status: 'in_progress' });

    expect(lessons(await get('/api/v1/me/progress', w.learner.cookie))).toEqual(['P Lesson']);
    expect(lessons(await get('/api/v1/me/progress', w.peer.cookie))).toEqual(['P Lesson']);
    expect(items(await get('/api/v1/me/progress', w.stranger.cookie))).toEqual([]);
  });

  it('never returns lesson CONTENT, only the names around it', async () => {
    const w = await world();
    await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, { status: 'completed' });
    const body = (await get('/api/v1/me/progress', w.learner.cookie)).body;
    // A progress row says what was studied. The material stays behind the
    // content policy.
    for (const field of ['contentBody', 'externalUrl', 'objectives']) {
      expect(body).not.toContain(field);
    }
  });
});

// =========================================================================
describe('retention: losing access keeps the record', () => {
  it('keeps the record legible after the learner leaves the class', async () => {
    const w = await world();
    await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, { status: 'completed' });
    expect(
      (await del(`/api/v1/classes/${w.classA1}/members/${w.learner.id}`, w.admin.cookie))
        .statusCode,
    ).toBe(204);

    // The lesson itself is gone from them...
    expect((await get(`/api/v1/lessons/${w.P.lesson}`, w.learner.cookie)).statusCode).toBe(404);
    // ...but their own history is intact, and still names what they studied.
    const mine = items<{ lessonTitle: string; courseTitle: string; status: string }>(
      await get('/api/v1/me/progress', w.learner.cookie),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.lessonTitle).toBe('P Lesson');
    expect(mine[0]?.courseTitle).toBe('P');
    expect(mine[0]?.status).toBe('completed');
  });

  it('stops the learner writing after they leave the class', async () => {
    const w = await world();
    await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, {
      status: 'in_progress',
    });
    await del(`/api/v1/classes/${w.classA1}/members/${w.learner.id}`, w.admin.cookie);

    const response = await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, {
      status: 'completed',
    });
    expect(response.statusCode).toBe(404);
    expect(
      items<{ status: string }>(await get('/api/v1/me/progress', w.learner.cookie))[0]?.status,
    ).toBe('in_progress');
  });

  it('keeps the record after the course is withdrawn from the class', async () => {
    const w = await world();
    await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, { status: 'completed' });
    expect(
      (await del(`/api/v1/classes/${w.classA1}/courses/${w.P.course}`, w.admin.cookie)).statusCode,
    ).toBe(204);

    expect(lessons(await get('/api/v1/me/progress', w.learner.cookie))).toEqual(['P Lesson']);
    expect(
      (
        await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, {
          status: 'completed',
        })
      ).statusCode,
    ).toBe(404);
  });
});

// =========================================================================
describe('IDOR / BOLA — the teacher view', () => {
  async function withProgress(w: Awaited<ReturnType<typeof world>>) {
    await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, { status: 'completed' });
    await put(`/api/v1/lessons/${w.Q.lesson}/progress`, w.otherClassLearner.cookie, {
      status: 'in_progress',
    });
  }

  it('shows a teacher one of their own students, in their own class', async () => {
    const w = await world();
    await withProgress(w);
    const response = await get(
      `/api/v1/classes/${w.classA1}/students/${w.learner.id}/progress`,
      w.teacher.cookie,
    );
    expect(response.statusCode).toBe(200);
    expect(lessons(response)).toEqual(['P Lesson']);
  });

  it('REFUSES a teacher a student who is NOT in that class', async () => {
    const w = await world();
    await withProgress(w);
    // `teacher` teaches A2 and `otherClassLearner` is in A2 — but the URL names
    // A1, where they are not enrolled.
    expect(
      (
        await get(
          `/api/v1/classes/${w.classA1}/students/${w.otherClassLearner.id}/progress`,
          w.teacher.cookie,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('REFUSES a teacher a class they do not teach', async () => {
    const w = await world();
    await withProgress(w);
    expect(
      (
        await get(
          `/api/v1/classes/${w.classA1}/students/${w.learner.id}/progress`,
          w.otherTeacher.cookie,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('EXCLUDES progress on a course assigned to a DIFFERENT class they teach', async () => {
    const w = await world();
    await withProgress(w);
    // Forced in, because the write path refuses it: `learner` is not in A2, so
    // they could never record Q progress themselves. This tests the READ path.
    await recordProgress({ userId: w.learner.id, lessonId: w.Q.lesson, status: 'completed' });

    const seen = lessons(
      await get(`/api/v1/classes/${w.classA1}/students/${w.learner.id}/progress`, w.teacher.cookie),
    );
    expect(seen).toEqual(['P Lesson']);
    expect(seen).not.toContain('Q Lesson');
  });

  it('lets an ADMIN of the school view any student in any of its classes', async () => {
    const w = await world();
    await withProgress(w);
    expect(
      lessons(
        await get(`/api/v1/classes/${w.classA1}/students/${w.learner.id}/progress`, w.admin.cookie),
      ),
    ).toEqual(['P Lesson']);
  });

  it('REFUSES an admin of ANOTHER school', async () => {
    const w = await world();
    await withProgress(w);
    expect(
      (await get(`/api/v1/classes/${w.classA1}/students/${w.learner.id}/progress`, w.adminB.cookie))
        .statusCode,
    ).toBe(404);
  });

  it('REFUSES a school SECURITY ADMIN', async () => {
    const w = await world();
    await withProgress(w);
    expect(
      (
        await get(
          `/api/v1/classes/${w.classA1}/students/${w.learner.id}/progress`,
          w.securityAdmin.cookie,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('REFUSES a peer, and a learner reading their own record through this route', async () => {
    const w = await world();
    await withProgress(w);
    for (const cookie of [w.peer.cookie, w.learner.cookie]) {
      expect(
        (await get(`/api/v1/classes/${w.classA1}/students/${w.learner.id}/progress`, cookie))
          .statusCode,
      ).toBe(404);
    }
  });

  it('answers the same 404 for an absent class and an absent student', async () => {
    const w = await world();
    const absent = '00000000-0000-4000-8000-000000000000';
    expect(
      (await get(`/api/v1/classes/${absent}/students/${w.learner.id}/progress`, w.teacher.cookie))
        .statusCode,
    ).toBe(404);
    expect(
      (await get(`/api/v1/classes/${w.classA1}/students/${absent}/progress`, w.teacher.cookie))
        .statusCode,
    ).toBe(404);
  });

  it('REFUSES once the student leaves the class, though the record survives', async () => {
    const w = await world();
    await withProgress(w);
    await del(`/api/v1/classes/${w.classA1}/members/${w.learner.id}`, w.admin.cookie);
    expect(
      (
        await get(
          `/api/v1/classes/${w.classA1}/students/${w.learner.id}/progress`,
          w.teacher.cookie,
        )
      ).statusCode,
    ).toBe(404);
    // The learner still has it.
    expect(lessons(await get('/api/v1/me/progress', w.learner.cookie))).toEqual(['P Lesson']);
  });
});

// =========================================================================
describe('IDOR / BOLA — the guardian view', () => {
  it('shows a VERIFIED guardian their own child’s record', async () => {
    const w = await world();
    await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, { status: 'completed' });
    const response = await get(
      `/api/v1/guardians/children/${w.learner.id}/progress`,
      w.guardian.cookie,
    );
    expect(response.statusCode).toBe(200);
    expect(lessons(response)).toEqual(['P Lesson']);
  });

  it('REFUSES a guardian an UNLINKED student', async () => {
    const w = await world();
    await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.peer.cookie, { status: 'completed' });
    expect(
      (await get(`/api/v1/guardians/children/${w.peer.id}/progress`, w.guardian.cookie)).statusCode,
    ).toBe(404);
  });

  it('REFUSES a guardian whose claim is only PENDING', async () => {
    const w = await world();
    await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, { status: 'completed' });
    const pending = await seedAndLogin({
      email: 'pending@t.local',
      roles: ['guardian'],
      organizationId: w.orgA,
    });
    await linkGuardian(pending.id, w.learner.id, 'pending');
    expect(
      (await get(`/api/v1/guardians/children/${w.learner.id}/progress`, pending.cookie)).statusCode,
    ).toBe(404);
  });

  it('REFUSES once the link is revoked', async () => {
    const w = await world();
    await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, { status: 'completed' });
    expect(
      (await get(`/api/v1/guardians/children/${w.learner.id}/progress`, w.guardian.cookie))
        .statusCode,
    ).toBe(200);

    const links = items<{ id: string }>(await get('/api/v1/guardian-links', w.guardian.cookie));
    expect(
      (
        await testApp.app.inject({
          method: 'POST',
          url: `/api/v1/guardian-links/${links[0]!.id}/revoke`,
          headers: { ...bodylessWriteHeaders, cookie: w.guardian.cookie },
        })
      ).statusCode,
    ).toBe(204);

    // Immediately, on the same live session.
    expect(
      (await get(`/api/v1/guardians/children/${w.learner.id}/progress`, w.guardian.cookie))
        .statusCode,
    ).toBe(404);
  });

  it('REFUSES a teacher, an admin and a learner using the guardian route', async () => {
    const w = await world();
    await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, { status: 'completed' });
    for (const cookie of [w.teacher.cookie, w.admin.cookie, w.peer.cookie]) {
      expect(
        (await get(`/api/v1/guardians/children/${w.learner.id}/progress`, cookie)).statusCode,
      ).toBe(404);
    }
  });

  it('shows the child’s WHOLE record, not only currently-assigned courses', async () => {
    const w = await world();
    await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, { status: 'completed' });
    await del(`/api/v1/classes/${w.classA1}/courses/${w.P.course}`, w.admin.cookie);
    // A guardian sees what their child did, not what the timetable currently says.
    expect(
      lessons(await get(`/api/v1/guardians/children/${w.learner.id}/progress`, w.guardian.cookie)),
    ).toEqual(['P Lesson']);
  });
});

// =========================================================================
describe('query parameter safety', () => {
  it('rejects a sort field that is not on the allow-list', async () => {
    const w = await world();
    for (const sort of ['user_id', 'last_accessed_at; DROP TABLE lesson_progress', 'id']) {
      expect(
        (await get(`/api/v1/me/progress?sort=${encodeURIComponent(sort)}`, w.learner.cookie))
          .statusCode,
      ).toBe(400);
    }
  });

  it('rejects an unknown query parameter, including one naming a user', async () => {
    const w = await world();
    expect(
      (await get(`/api/v1/me/progress?userId=${w.peer.id}`, w.learner.cookie)).statusCode,
    ).toBe(400);
    expect((await get('/api/v1/me/progress?learnerId=x', w.learner.cookie)).statusCode).toBe(400);
  });

  it('applies allow-listed filters without widening the result set', async () => {
    const w = await world();
    await put(`/api/v1/lessons/${w.P.lesson}/progress`, w.learner.cookie, { status: 'completed' });
    expect(lessons(await get('/api/v1/me/progress?status=completed', w.learner.cookie))).toEqual([
      'P Lesson',
    ]);
    expect(items(await get('/api/v1/me/progress?status=in_progress', w.learner.cookie))).toEqual(
      [],
    );
    // A courseId filter narrows; it cannot reach another learner's rows.
    expect(
      items(await get(`/api/v1/me/progress?courseId=${w.Q.course}`, w.learner.cookie)),
    ).toEqual([]);
  });
});

// =========================================================================
describe('authentication is required throughout', () => {
  it('refuses every progress route without a session', async () => {
    const w = await world();
    for (const [method, url] of [
      ['GET', '/api/v1/me/progress'],
      ['PUT', `/api/v1/lessons/${w.P.lesson}/progress`],
      ['GET', `/api/v1/classes/${w.classA1}/students/${w.learner.id}/progress`],
      ['GET', `/api/v1/guardians/children/${w.learner.id}/progress`],
    ] as const) {
      const response = await testApp.app.inject({
        method,
        url,
        headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
        ...(method === 'PUT' ? { payload: { status: 'completed' } } : {}),
      });
      expect(response.statusCode).toBe(401);
    }
  });
});
