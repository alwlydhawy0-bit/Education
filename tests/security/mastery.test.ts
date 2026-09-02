import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildTestApp, sessionCookieFrom, writeHeaders, type TestApp } from '../setup/app.ts';
import { TEST_SUPERUSER_URL } from '../setup/env.ts';
import {
  addClassMember,
  assignCourseToClass,
  assignTeacher,
  closeSeedDb,
  createActivity,
  createClass,
  createCourse,
  createCurriculum,
  createEducationLevel,
  createLesson,
  createOrganization,
  createQuestion,
  createUnit,
  createUser,
  grantRole,
  linkGuardian,
  objectivesOf,
  truncateAll,
} from '../setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';

/**
 * Objectives, evidence and mastery, end to end over the real HTTP stack.
 *
 * Written from the TASK'S SECURITY SECTION by hand, not from the implementation.
 * A suite derived from the code tests what the code does; these test what the
 * task says must be true — including the cases where the right answer is "that
 * endpoint does not exist".
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
  organizationSecurityAdmin?: string;
}): Promise<Session> {
  const user = await createUser({
    email: options.email,
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.organizationId !== undefined ? { organizationId: options.organizationId } : {}),
    passwordHash: await hashPassword(PASSWORD),
  });
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

const send = (
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  cookie: string,
  payload?: unknown,
) =>
  testApp.app.inject({
    method,
    url,
    headers: { ...writeHeaders, cookie },
    payload: payload ?? {},
  });

const items = <T>(r: { json: <U>() => U }) => r.json<{ items: T[] }>().items;

async function asSuperuser(sql: string, params: unknown[] = []): Promise<void> {
  const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
  await raw.connect();
  try {
    await raw.query(sql, params);
  } finally {
    await raw.end();
  }
}

/**
 * Two schools, two classes in the first, one teacher per class.
 *
 * `learner` is in A1 and `otherClassLearner` in A2, so "I teach a class" and "I
 * teach THIS learner in THIS class" can be told apart — the distinction the
 * whole teacher rule turns on.
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
  const foreignAdmin = await seedAndLogin({
    email: 'admin@b.local',
    roles: ['admin'],
    organizationId: orgB,
  });
  const securityAdmin = await seedAndLogin({
    email: 'sec@t.local',
    roles: [],
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
  const author = await seedAndLogin({
    email: 'author@t.local',
    roles: ['content_author'],
    organizationId: orgA,
  });

  const classA1 = await createClass(orgA, 'A1');
  const classA2 = await createClass(orgA, 'A2');
  await addClassMember(classA1, learner.id);
  await addClassMember(classA1, peer.id);
  await addClassMember(classA2, otherClassLearner.id);
  await assignTeacher(teacher.id, classA1);
  await assignTeacher(otherTeacher.id, classA2);
  await linkGuardian(guardian.id, learner.id, 'verified');
  await linkGuardian(otherGuardian.id, peer.id, 'verified');

  const mkCourse = async (organizationId: string, code: string, title: string) => {
    const curriculumId = await createCurriculum({ organizationId, code, status: 'published' });
    const courseId = await createCourse({
      organizationId,
      curriculumId,
      levelId,
      title,
      status: 'published',
    });
    const unitId = await createUnit({ courseId, title: `${title} Unit`, status: 'published' });
    const lessonId = await createLesson({
      unitId,
      title: `${title} Lesson`,
      status: 'published',
      objectives: [`${title} objective one`, `${title} objective two`],
    });
    return { courseId, unitId, lessonId, objectives: await objectivesOf(lessonId) };
  };

  const courseP = await mkCourse(orgA, 'course_p', 'P');
  const courseQ = await mkCourse(orgA, 'course_q', 'Q');
  const courseB = await mkCourse(orgB, 'course_b', 'B');
  await assignCourseToClass({ classId: classA1, courseId: courseP.courseId });
  await assignCourseToClass({ classId: classA2, courseId: courseQ.courseId });

  const mkQuiz = async (lessonId: string, title: string, reviewPolicy?: 'on_release') => {
    const { activityId, assessmentId } = await createActivity({
      lessonId,
      title,
      status: 'draft',
      maxAttempts: 5,
      passingPercentage: 50,
      ...(reviewPolicy ? { reviewPolicy } : {}),
    });
    const q = await createQuestion({
      assessmentId: assessmentId!,
      questionType: 'single_choice',
      prompt: 'Which one?',
      points: 2,
      options: ['Right', 'Wrong'],
      correctOptions: [0],
    });
    await asSuperuser(
      `UPDATE learning_activities SET status='published', published_at=now() WHERE id=$1`,
      [activityId],
    );
    return { assessmentId: assessmentId!, q };
  };

  return {
    orgA,
    orgB,
    learner,
    peer,
    otherClassLearner,
    teacher,
    otherTeacher,
    admin,
    foreignAdmin,
    securityAdmin,
    guardian,
    otherGuardian,
    author,
    classA1,
    classA2,
    courseP,
    courseQ,
    courseB,
    quizP: await mkQuiz(courseP.lessonId, 'P Quiz'),
    quizP2: await mkQuiz(courseP.lessonId, 'P Quiz Two'),
    withheldP: await mkQuiz(courseP.lessonId, 'P Withheld', 'on_release'),
    quizQ: await mkQuiz(courseQ.lessonId, 'Q Quiz'),
  };
}

type World = Awaited<ReturnType<typeof world>>;
let w: World;

beforeEach(async () => {
  await truncateAll();
  w = await world();
});

afterAll(async () => {
  await testApp.db.close();
  await closeSeedDb();
});

/** Sits an assessment through the real endpoints. */
async function sit(
  session: Session,
  quiz: {
    assessmentId: string;
    q: { questionId: string; optionIds: string[]; correctOptionIds: string[] };
  },
  answer: 'right' | 'wrong',
): Promise<string> {
  const started = await send(
    'POST',
    `/api/v1/assessments/${quiz.assessmentId}/attempts`,
    session.cookie,
  );
  if (started.statusCode !== 201) {
    throw new Error(`start failed: ${started.statusCode} ${started.body}`);
  }
  const body = started.json<{
    attempt: { id: string };
    questions: Array<{ id: string; options: Array<{ id: string; body: string }> }>;
  }>();
  const question = body.questions[0]!;
  const chosen = question.options.find((o) =>
    answer === 'right' ? o.body === 'Right' : o.body === 'Wrong',
  )!;
  const submitted = await send(
    'POST',
    `/api/v1/attempts/${body.attempt.id}/submit`,
    session.cookie,
    {
      answers: [{ questionId: question.id, selectedOptionIds: [chosen.id] }],
    },
  );
  if (submitted.statusCode !== 200) {
    throw new Error(`submit failed: ${submitted.statusCode} ${submitted.body}`);
  }
  return body.attempt.id;
}

const completeLesson = (session: Session, lessonId: string) =>
  send('PUT', `/api/v1/lessons/${lessonId}/progress`, session.cookie, { status: 'completed' });

interface CourseBody {
  courseId: string;
  units: Array<{
    lessons: Array<{
      lessonStatus: string;
      objectives: Array<{ objectiveId: string; mastery: string; evidenceCount: number }>;
    }>;
  }>;
  tally: {
    total: number;
    demonstrated: number;
    mastered: number;
    demonstratedPercentage: number | null;
  };
  lessonsTotal: number;
  lessonsCompleted: number;
}

const flatObjectives = (body: CourseBody) =>
  body.units.flatMap((u) => u.lessons.flatMap((l) => l.objectives));

// =====================================================================
// The happy path, first — a suite of only negatives passes when
// everything is broken.
// =====================================================================

describe('the learner flow', () => {
  it('a learner sees no evidence before doing anything', async () => {
    const response = await get(
      `/api/v1/me/courses/${w.courseP.courseId}/mastery`,
      w.learner.cookie,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json<CourseBody>();
    expect(body.tally).toMatchObject({ total: 2, demonstrated: 0, mastered: 0 });
    expect(body.tally.demonstratedPercentage).toBe(0);
    expect(flatObjectives(body).every((o) => o.mastery === 'no_evidence')).toBe(true);
  });

  it('completing a lesson moves every objective of that lesson to `attempted`', async () => {
    expect((await completeLesson(w.learner, w.courseP.lessonId)).statusCode).toBe(200);
    const body = (
      await get(`/api/v1/me/courses/${w.courseP.courseId}/mastery`, w.learner.cookie)
    ).json<CourseBody>();
    expect(flatObjectives(body).map((o) => o.mastery)).toEqual(['attempted', 'attempted']);
    expect(body.lessonsCompleted).toBe(1);
  });

  it('passing one assessment reaches `demonstrated`, two DIFFERENT ones reach `mastered`', async () => {
    await sit(w.learner, w.quizP, 'right');
    let body = (
      await get(`/api/v1/me/courses/${w.courseP.courseId}/mastery`, w.learner.cookie)
    ).json<CourseBody>();
    expect(flatObjectives(body).map((o) => o.mastery)).toEqual(['demonstrated', 'demonstrated']);

    await sit(w.learner, w.quizP2, 'right');
    body = (
      await get(`/api/v1/me/courses/${w.courseP.courseId}/mastery`, w.learner.cookie)
    ).json<CourseBody>();
    expect(flatObjectives(body).map((o) => o.mastery)).toEqual(['mastered', 'mastered']);
    expect(body.tally.demonstratedPercentage).toBe(100);
  });

  it('the evidence behind an objective is retrievable, and explains the state', async () => {
    await completeLesson(w.learner, w.courseP.lessonId);
    await sit(w.learner, w.quizP, 'right');
    const objectiveId = w.courseP.objectives[0]!.id;
    const evidence = items<{ evidenceType: string; sourceKind: string; occurredAt: string }>(
      await get(`/api/v1/me/objectives/${objectiveId}/evidence`, w.learner.cookie),
    );
    expect(evidence.map((e) => e.evidenceType).sort()).toEqual([
      'assessment_passed',
      'lesson_completed',
    ]);
  });

  it('THE EVIDENCE SUMMARY CARRIES NO MARK', async () => {
    // A percentage here would be a second door to a result Task 009 may still be
    // withholding. The table has no score column, and the DTO has no field.
    await sit(w.learner, w.quizP, 'right');
    const response = await get(
      `/api/v1/me/objectives/${w.courseP.objectives[0]!.id}/evidence`,
      w.learner.cookie,
    );
    expect(response.body).not.toMatch(/score|percentage|passingPercentage|"passed"/i);
  });

  it('the learner’s objective list covers only what they have evidence for', async () => {
    await sit(w.learner, w.quizP, 'right');
    const objectives = items<{ objectiveId: string }>(
      await get('/api/v1/me/objectives', w.learner.cookie),
    );
    expect(objectives).toHaveLength(2);
    expect(objectives.map((o) => o.objectiveId).sort()).toEqual(
      w.courseP.objectives.map((o) => o.id).sort(),
    );
  });
});

// =====================================================================
// IDOR / BOLA
// =====================================================================

describe('cross-learner access', () => {
  beforeEach(async () => {
    await completeLesson(w.learner, w.courseP.lessonId);
    await sit(w.learner, w.quizP, 'right');
  });

  it('A LEARNER CANNOT READ ANOTHER LEARNER’S MASTERY', async () => {
    // There is no route that takes a learner id for a peer to try, which is the
    // point: `/me/...` is scoped by the SESSION. The peer's own view returns
    // their own (empty) record rather than the learner's.
    const body = (
      await get(`/api/v1/me/courses/${w.courseP.courseId}/mastery`, w.peer.cookie)
    ).json<CourseBody>();
    expect(flatObjectives(body).every((o) => o.mastery === 'no_evidence')).toBe(true);
    expect(body.lessonsCompleted).toBe(0);
  });

  it('A LEARNER CANNOT READ ANOTHER LEARNER’S EVIDENCE', async () => {
    // Same objective id, different session. The endpoint reads the actor's own
    // evidence for that objective, so the peer gets an empty list — never the
    // learner's rows.
    const objectiveId = w.courseP.objectives[0]!.id;
    const evidence = items<unknown>(
      await get(`/api/v1/me/objectives/${objectiveId}/evidence`, w.peer.cookie),
    );
    expect(evidence).toEqual([]);
  });

  it('A FORGED learnerId IS REFUSED — the session is authoritative', async () => {
    // TASK 010 ASSERTED THAT THESE WERE IGNORED, and Task 012 changed it to a
    // refusal (VULN-034). "Ignored" and "trusted" look identical from outside,
    // and a 200 tells a caller probing `?learnerId=` that the parameter was at
    // least accepted. The `/me/...` routes take no learner parameter, so the
    // honest answer is 400.
    for (const query of [`learnerId=${w.learner.id}`, `userId=${w.learner.id}`]) {
      expect((await get(`/api/v1/me/objectives?${query}`, w.peer.cookie)).statusCode).toBe(400);
    }
    expect(
      (
        await get(
          `/api/v1/me/courses/${w.courseP.courseId}/mastery?learnerId=${w.learner.id}`,
          w.peer.cookie,
        )
      ).statusCode,
    ).toBe(400);

    // AND THE UNDERLYING GUARANTEE IS UNCHANGED: with no parameter at all, the
    // peer sees only their own record. The refusal above is the outer layer;
    // this is the one that would still hold if the parameter were accepted.
    const listed = items<{ mastery: string }>(await get('/api/v1/me/objectives', w.peer.cookie));
    expect(listed).toEqual([]);
    const course = await get(`/api/v1/me/courses/${w.courseP.courseId}/mastery`, w.peer.cookie);
    expect(course.statusCode).toBe(200);
    const body = course.json<CourseBody>();
    expect(flatObjectives(body).every((o) => o.mastery === 'no_evidence')).toBe(true);
    expect(body.tally.demonstrated + body.tally.mastered).toBe(0);
  });

  it('…and a forged organizationId or classId is refused the same way', async () => {
    await sit(w.peer, w.quizP, 'wrong');
    expect(
      (
        await get(
          `/api/v1/me/courses/${w.courseP.courseId}/mastery?organizationId=${w.orgB}&classId=${w.classA2}`,
          w.peer.cookie,
        )
      ).statusCode,
    ).toBe(400);

    // Their own real state is what the clean request returns — the parameters
    // could not have changed it, and now cannot even be sent.
    const response = await get(`/api/v1/me/courses/${w.courseP.courseId}/mastery`, w.peer.cookie);
    expect(response.statusCode).toBe(200);
    expect(
      flatObjectives(response.json<CourseBody>()).every((o) => o.mastery === 'developing'),
    ).toBe(true);
  });

  it('A LEARNER CANNOT REACH THE GUARDIAN VIEW OF ANOTHER LEARNER', async () => {
    const response = await get(
      `/api/v1/guardians/children/${w.learner.id}/objectives`,
      w.peer.cookie,
    );
    expect(response.statusCode).toBe(404);
  });

  it('A GUARDIAN CANNOT READ AN UNLINKED CHILD', async () => {
    // `otherGuardian` is verified for `peer`, not for `learner`.
    const response = await get(
      `/api/v1/guardians/children/${w.learner.id}/objectives`,
      w.otherGuardian.cookie,
    );
    expect(response.statusCode).toBe(404);
  });

  it('a VERIFIED guardian reads their own child', async () => {
    const objectives = items<{ mastery: string }>(
      await get(`/api/v1/guardians/children/${w.learner.id}/objectives`, w.guardian.cookie),
    );
    expect(objectives).toHaveLength(2);
    expect(objectives.every((o) => o.mastery === 'demonstrated')).toBe(true);
  });

  it('an unauthenticated caller reaches none of it', async () => {
    for (const url of [
      `/api/v1/me/courses/${w.courseP.courseId}/mastery`,
      `/api/v1/me/objectives`,
      `/api/v1/me/objectives/${w.courseP.objectives[0]!.id}/evidence`,
      `/api/v1/guardians/children/${w.learner.id}/objectives`,
      `/api/v1/classes/${w.classA1}/students/${w.learner.id}/courses/${w.courseP.courseId}/mastery`,
    ]) {
      const response = await testApp.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
    }
  });
});

describe('cross-class and cross-organization access', () => {
  const teacherView = (session: Session, classId: string, studentId: string, courseId: string) =>
    get(
      `/api/v1/classes/${classId}/students/${studentId}/courses/${courseId}/mastery`,
      session.cookie,
    );

  beforeEach(async () => {
    await sit(w.learner, w.quizP, 'right');
  });

  it('the teacher of the class reads their own student', async () => {
    const response = await teacherView(w.teacher, w.classA1, w.learner.id, w.courseP.courseId);
    expect(response.statusCode).toBe(200);
    expect(
      flatObjectives(response.json<CourseBody>()).every((o) => o.mastery === 'demonstrated'),
    ).toBe(true);
  });

  it('A TEACHER CANNOT READ A LEARNER OUTSIDE THEIR CLASS', async () => {
    // `otherTeacher` teaches A2. Naming A1 gives them no standing in it.
    expect(
      (await teacherView(w.otherTeacher, w.classA1, w.learner.id, w.courseP.courseId)).statusCode,
    ).toBe(404);
  });

  it('…and cannot borrow their OWN class id to reach a learner not in it', async () => {
    // The other half of the same rule: standing in A2 does not reach a learner
    // who is not enrolled in A2. Both directions are asserted, because a rule
    // that admitted everybody would pass only one of them.
    expect(
      (await teacherView(w.otherTeacher, w.classA2, w.learner.id, w.courseP.courseId)).statusCode,
    ).toBe(404);
  });

  it('A TEACHER CANNOT READ A LEARNER OUTSIDE THEIR ORGANIZATION', async () => {
    expect(
      (await teacherView(w.foreignAdmin, w.classA1, w.learner.id, w.courseP.courseId)).statusCode,
    ).toBe(404);
  });

  it('AN ADMINISTRATOR OF ANOTHER ORGANIZATION IS REFUSED', async () => {
    expect(
      (await teacherView(w.foreignAdmin, w.classA1, w.learner.id, w.courseP.courseId)).statusCode,
    ).toBe(404);
  });

  it('an administrator of the learner’s own school is admitted', async () => {
    expect(
      (await teacherView(w.admin, w.classA1, w.learner.id, w.courseP.courseId)).statusCode,
    ).toBe(200);
  });

  it('A SECURITY ADMINISTRATOR IS REFUSED', async () => {
    // Accounts and lockouts are their remit; every child's learning record is a
    // different authority that must not ride along with it.
    expect(
      (await teacherView(w.securityAdmin, w.classA1, w.learner.id, w.courseP.courseId)).statusCode,
    ).toBe(404);
  });

  it('the SAME 404 for a class that does not exist, no standing, and a student not enrolled', async () => {
    // Three ways to the same answer, so the endpoint cannot be used to probe
    // class rosters or to confirm that a class id is real.
    const absent = '00000000-0000-4000-8000-000000000000';
    const statuses = await Promise.all([
      teacherView(w.teacher, absent, w.learner.id, w.courseP.courseId),
      teacherView(w.otherTeacher, w.classA1, w.learner.id, w.courseP.courseId),
      teacherView(w.teacher, w.classA1, w.otherClassLearner.id, w.courseP.courseId),
    ]);
    expect(statuses.map((r) => r.statusCode)).toEqual([404, 404, 404]);
  });

  it('A TEACHER CANNOT NAME A COURSE THEIR CLASS DOES NOT REACH', async () => {
    // Course Q is assigned to A2, not A1. Standing over the learner does not
    // extend to a course the class never had.
    expect(
      (await teacherView(w.teacher, w.classA1, w.learner.id, w.courseQ.courseId)).statusCode,
    ).toBe(404);
  });

  it('and cannot name ANOTHER ORGANIZATION’S course', async () => {
    expect(
      (await teacherView(w.teacher, w.classA1, w.learner.id, w.courseB.courseId)).statusCode,
    ).toBe(404);
  });

  it('a learner cannot read a course their class is not assigned', async () => {
    expect(
      (await get(`/api/v1/me/courses/${w.courseQ.courseId}/mastery`, w.learner.cookie)).statusCode,
    ).toBe(404);
  });

  it('a learner cannot read another organization’s course', async () => {
    expect(
      (await get(`/api/v1/me/courses/${w.courseB.courseId}/mastery`, w.learner.cookie)).statusCode,
    ).toBe(404);
  });
});

// =====================================================================
// Retention
// =====================================================================

describe('retention after revocation', () => {
  it('A LEARNER KEEPS THEIR RECORD AFTER LEAVING THE CLASS, and it stays legible', async () => {
    // The reason `/me/objectives` is driven off evidence and labelled through a
    // definer rather than joined to the content tree: a learner who leaves a
    // class loses content access, and a join would empty their own history.
    await sit(w.learner, w.quizP, 'right');
    await asSuperuser(
      `UPDATE class_memberships SET status='ended', ended_at=now() WHERE user_id=$1`,
      [w.learner.id],
    );
    const objectives = items<{ mastery: string; statement: string; lessonTitle: string }>(
      await get('/api/v1/me/objectives', w.learner.cookie),
    );
    expect(objectives).toHaveLength(2);
    expect(objectives[0]?.mastery).toBe('demonstrated');
    // Legible, not just present: the statement and the lesson name are there.
    expect(objectives[0]?.statement).toContain('objective');
    expect(objectives[0]?.lessonTitle).toBe('P Lesson');
  });

  it('and the guardian, who never had content access at all, sees the same', async () => {
    await sit(w.learner, w.quizP, 'right');
    const objectives = items<{ statement: string; courseTitle?: string }>(
      await get(`/api/v1/guardians/children/${w.learner.id}/objectives`, w.guardian.cookie),
    );
    expect(objectives).toHaveLength(2);
    expect(objectives[0]?.statement).toContain('objective');
  });

  it('but the TEACHER’s view ends with the enrolment', async () => {
    // The opposite rule, deliberately: the enrolment is what made them this
    // child's teacher, so it is what their access ends with.
    await sit(w.learner, w.quizP, 'right');
    await asSuperuser(
      `UPDATE class_memberships SET status='ended', ended_at=now() WHERE user_id=$1`,
      [w.learner.id],
    );
    expect(
      (
        await get(
          `/api/v1/classes/${w.classA1}/students/${w.learner.id}/courses/${w.courseP.courseId}/mastery`,
          w.teacher.cookie,
        )
      ).statusCode,
    ).toBe(404);
  });
});

// =====================================================================
// Mastery and evidence cannot be authored
// =====================================================================

describe('mastery manipulation', () => {
  const ABSENT = '00000000-0000-4000-8000-000000000000';

  it('THERE IS NO ENDPOINT THAT ACCEPTS A MASTERY STATE', async () => {
    // The refusal is a missing ROUTE, not a schema rejection. `objective_progress`
    // has only `read` and `list` actions, the evidence table grants `edu_app`
    // nothing but SELECT, and no handler in the platform takes a mastery value.
    const objectiveId = w.courseP.objectives[0]!.id;
    for (const [method, url] of [
      ['POST', `/api/v1/me/objectives/${objectiveId}/mastery`],
      ['PUT', `/api/v1/me/objectives/${objectiveId}/mastery`],
      ['PATCH', `/api/v1/me/objectives/${objectiveId}`],
      ['POST', `/api/v1/me/objectives/${objectiveId}/evidence`],
      ['PUT', `/api/v1/me/objectives`],
      ['POST', `/api/v1/objectives/${objectiveId}/evidence`],
    ] as const) {
      const response = await send(method, url, w.learner.cookie, {
        mastery: 'mastered',
        masteryScore: 100,
        evidenceType: 'assessment_passed',
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it('nor one a TEACHER or an ADMINISTRATOR can use', async () => {
    // Not a learner-only restriction: nobody authors a claim about what another
    // person understands, exactly as nobody authors their progress (0018).
    const objectiveId = w.courseP.objectives[0]!.id;
    for (const session of [w.teacher, w.admin, w.author]) {
      const response = await send(
        'POST',
        `/api/v1/classes/${w.classA1}/students/${w.learner.id}/objectives/${objectiveId}/mastery`,
        session.cookie,
        { mastery: 'mastered' },
      );
      expect(response.statusCode).toBe(404);
    }
  });

  it('A FORGED MASTERY STATE ON A READ IS REFUSED, and the real one returned', async () => {
    // Query parameters are not a back door, and since Task 012 (VULN-034) they
    // are not even accepted. The state comes from `app_objective_mastery`,
    // which takes no input but ids — so there was never anything for these to
    // influence; what changed is that the endpoint now says so.
    await sit(w.learner, w.quizP, 'wrong');
    expect(
      (
        await get(
          `/api/v1/me/courses/${w.courseP.courseId}/mastery?mastery=mastered&demonstratedPercentage=100`,
          w.learner.cookie,
        )
      ).statusCode,
    ).toBe(400);

    // The real state, from the clean request.
    const response = await get(
      `/api/v1/me/courses/${w.courseP.courseId}/mastery`,
      w.learner.cookie,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json<CourseBody>();
    expect(flatObjectives(body).every((o) => o.mastery === 'developing')).toBe(true);
    expect(body.tally.demonstratedPercentage).toBe(0);
  });

  it('A LEARNER CANNOT MANUFACTURE EVIDENCE BY COMPLETING A LESSON TWICE', async () => {
    // Idempotency at the surface a retry actually reaches. Two identical PUTs
    // are the same claim twice and produce one evidence row per objective.
    expect((await completeLesson(w.learner, w.courseP.lessonId)).statusCode).toBe(200);
    expect((await completeLesson(w.learner, w.courseP.lessonId)).statusCode).toBe(200);
    const evidence = items<unknown>(
      await get(`/api/v1/me/objectives/${w.courseP.objectives[0]!.id}/evidence`, w.learner.cookie),
    );
    expect(evidence).toHaveLength(1);
  });

  it('a forged objective id returns an empty list, never another learner’s evidence', async () => {
    await sit(w.learner, w.quizP, 'right');
    for (const id of [ABSENT, w.courseQ.objectives[0]!.id, w.courseB.objectives[0]!.id]) {
      const response = await get(`/api/v1/me/objectives/${id}/evidence`, w.learner.cookie);
      expect(response.statusCode).toBe(200);
      expect(items<unknown>(response)).toEqual([]);
    }
  });

  it('a malformed id is a 400, not a 500', async () => {
    for (const url of [
      '/api/v1/me/courses/not-a-uuid/mastery',
      '/api/v1/me/objectives/not-a-uuid/evidence',
      '/api/v1/guardians/children/not-a-uuid/objectives',
    ]) {
      expect((await get(url, w.learner.cookie)).statusCode).toBe(400);
    }
  });
});

describe('the withheld-result rule reaches mastery too', () => {
  it('A WITHHELD PASS DOES NOT ANNOUNCE ITSELF THROUGH MASTERY', async () => {
    // Task 009 withholds the mark until a teacher releases it. A mastery state
    // that jumped to `demonstrated` on submission would announce the result
    // through a different endpoint — so for the SUBJECT it counts as
    // `attempted`, which leaks nothing they do not already know.
    await sit(w.learner, w.withheldP, 'right');
    const body = (
      await get(`/api/v1/me/courses/${w.courseP.courseId}/mastery`, w.learner.cookie)
    ).json<CourseBody>();
    expect(flatObjectives(body).every((o) => o.mastery === 'attempted')).toBe(true);
  });

  it('a withheld FAILURE is not announced either', async () => {
    await sit(w.learner, w.withheldP, 'wrong');
    const body = (
      await get(`/api/v1/me/courses/${w.courseP.courseId}/mastery`, w.learner.cookie)
    ).json<CourseBody>();
    expect(flatObjectives(body).every((o) => o.mastery === 'attempted')).toBe(true);
  });

  it('THE TEACHER SEES THE TRUE STATE IMMEDIATELY', async () => {
    await sit(w.learner, w.withheldP, 'right');
    const body = (
      await get(
        `/api/v1/classes/${w.classA1}/students/${w.learner.id}/courses/${w.courseP.courseId}/mastery`,
        w.teacher.cookie,
      )
    ).json<CourseBody>();
    expect(flatObjectives(body).every((o) => o.mastery === 'demonstrated')).toBe(true);
  });

  it('releasing it updates the learner’s own view, with no extra step', async () => {
    const attemptId = await sit(w.learner, w.withheldP, 'right');
    const released = await send('POST', `/api/v1/attempts/${attemptId}/release`, w.teacher.cookie);
    expect(released.statusCode).toBe(200);
    const body = (
      await get(`/api/v1/me/courses/${w.courseP.courseId}/mastery`, w.learner.cookie)
    ).json<CourseBody>();
    expect(flatObjectives(body).every((o) => o.mastery === 'demonstrated')).toBe(true);
  });

  it('THE EVIDENCE STILL EXISTS — withholding hides the outcome, not the learning', async () => {
    // §8's rule: a result being unreleased must not erase the learning it
    // recorded. The learner's own evidence list is empty (they may not see the
    // outcome yet) while the teacher's view proves the evidence is there and
    // already counted.
    await sit(w.learner, w.withheldP, 'right');
    expect(
      items<unknown>(
        await get(
          `/api/v1/me/objectives/${w.courseP.objectives[0]!.id}/evidence`,
          w.learner.cookie,
        ),
      ),
    ).toEqual([]);

    const teacherView = (
      await get(
        `/api/v1/classes/${w.classA1}/students/${w.learner.id}/courses/${w.courseP.courseId}/mastery`,
        w.teacher.cookie,
      )
    ).json<CourseBody>();
    expect(flatObjectives(teacherView).every((o) => o.evidenceCount === 1)).toBe(true);
    expect(flatObjectives(teacherView).every((o) => o.mastery === 'demonstrated')).toBe(true);
  });
});
