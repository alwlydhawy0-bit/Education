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
  truncateAll,
} from '../setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';

/**
 * Activities, assessments and attempts, end to end over the real HTTP stack.
 *
 * The fifteen scenarios section 19 of the task names, A to O, are each marked
 * in the test name so the matrix in the report can be traced back to a test
 * that actually ran rather than to a claim.
 *
 * Written from the SCENARIOS by hand, not from the implementation. A suite
 * derived from the code tests what the code does; these test what the task
 * says must be true.
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

const post = (url: string, cookie: string, payload?: Record<string, unknown>) =>
  testApp.app.inject({
    method: 'POST',
    url,
    headers: { ...writeHeaders, cookie },
    payload: payload ?? {},
  });

const items = <T>(r: { json: <U>() => U }) => r.json<{ items: T[] }>().items;

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
 * `learner` is in A1 and `otherClassLearner` in A2, so "I teach a class" and
 * "I teach THIS learner in THIS class" can be told apart — the distinction the
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
  const securityAdmin = await seedAndLogin({
    email: 'sec@t.local',
    roles: [],
    organizationId: orgA,
    organizationSecurityAdmin: orgA,
  });
  const author = await seedAndLogin({
    email: 'author@t.local',
    roles: ['content_author'],
    organizationId: orgA,
  });
  const reviewer = await seedAndLogin({
    email: 'reviewer@t.local',
    roles: ['reviewer'],
    organizationId: orgA,
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
  const foreignLearner = await seedAndLogin({ email: 'learner@b.local', organizationId: orgB });
  const foreignAdmin = await seedAndLogin({
    email: 'admin@b.local',
    roles: ['admin'],
    organizationId: orgB,
  });

  const classA1 = await createClass(orgA, 'A1');
  const classA2 = await createClass(orgA, 'A2');
  const classB1 = await createClass(orgB, 'B1');
  await addClassMember(classA1, learner.id);
  await addClassMember(classA2, otherClassLearner.id);
  await addClassMember(classB1, foreignLearner.id);
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
    });
    return { courseId, lessonId };
  };

  const courseP = await mkCourse(orgA, 'course_p', 'P');
  const courseQ = await mkCourse(orgA, 'course_q', 'Q');
  const courseB = await mkCourse(orgB, 'course_b', 'B');
  await assignCourseToClass({ classId: classA1, courseId: courseP.courseId });
  await assignCourseToClass({ classId: classA2, courseId: courseQ.courseId });
  await assignCourseToClass({ classId: classB1, courseId: courseB.courseId });

  /** Builds a published assessment with one 2-point single-choice question. */
  const mkAssessment = async (
    lessonId: string,
    title: string,
    options: {
      maxAttempts?: number;
      status?: 'draft' | 'published';
      reviewPolicy?: 'on_submission' | 'on_release';
    } = {},
  ) => {
    const { activityId, assessmentId } = await createActivity({
      lessonId,
      title,
      status: 'draft',
      maxAttempts: options.maxAttempts ?? 2,
      passingPercentage: 50,
      ...(options.reviewPolicy ? { reviewPolicy: options.reviewPolicy } : {}),
    });
    const q = await createQuestion({
      assessmentId: assessmentId!,
      questionType: 'single_choice',
      prompt: 'Which one?',
      points: 2,
      options: ['Right', 'Wrong'],
      correctOptions: [0],
      explanation: 'Because Right is right.',
    });
    if ((options.status ?? 'published') === 'published') {
      await asSuperuser(
        `UPDATE learning_activities SET status='published', published_at=now() WHERE id=$1`,
        [activityId],
      );
    }
    return { activityId, assessmentId: assessmentId!, q };
  };

  const quizP = await mkAssessment(courseP.lessonId, 'P Quiz');
  const quizQ = await mkAssessment(courseQ.lessonId, 'Q Quiz');
  const quizB = await mkAssessment(courseB.lessonId, 'B Quiz');
  const draftQuiz = await mkAssessment(courseP.lessonId, 'Draft Quiz', { status: 'draft' });
  /** Same lesson, same class — but its results are WITHHELD until released. */
  const withheldQuiz = await mkAssessment(courseP.lessonId, 'Withheld Quiz', {
    reviewPolicy: 'on_release',
  });
  /** In class A2's course, so `otherTeacher` is its teacher and `teacher` is not. */
  const withheldQuizQ = await mkAssessment(courseQ.lessonId, 'Withheld Q Quiz', {
    reviewPolicy: 'on_release',
  });

  return {
    orgA,
    orgB,
    learner,
    peer,
    otherClassLearner,
    teacher,
    otherTeacher,
    admin,
    securityAdmin,
    author,
    reviewer,
    guardian,
    otherGuardian,
    foreignLearner,
    foreignAdmin,
    classA1,
    classA2,
    classB1,
    courseP,
    courseQ,
    courseB,
    quizP,
    quizQ,
    quizB,
    draftQuiz,
    withheldQuiz,
    withheldQuizQ,
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

/** Starts an attempt and returns the attempt plus the paper. */
async function startAttempt(session: Session, assessmentId: string) {
  const response = await post(`/api/v1/assessments/${assessmentId}/attempts`, session.cookie);
  if (response.statusCode !== 201) {
    throw new Error(`start failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<{
    attempt: { id: string };
    questions: Array<{ id: string; options: Array<{ id: string; body: string }> }>;
  }>();
}

// =====================================================================
// The happy path, first — a suite of only negatives passes when everything
// is broken.
// =====================================================================

describe('the learner flow', () => {
  it('a learner reads the assessment, attempts it, submits, and is scored', async () => {
    const meta = await get(`/api/v1/assessments/${w.quizP.assessmentId}`, w.learner.cookie);
    expect(meta.statusCode).toBe(200);
    expect(
      meta.json<{ questionCount: number; maxScore: number; attemptsUsed: number }>(),
    ).toMatchObject({ questionCount: 1, maxScore: 2, attemptsUsed: 0 });

    const { attempt, questions } = await startAttempt(w.learner, w.quizP.assessmentId);
    expect(questions).toHaveLength(1);

    const correct = questions[0]!.options.find((o) => o.body === 'Right')!;
    const submitted = await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers: [{ questionId: questions[0]!.id, selectedOptionIds: [correct.id] }],
    });
    expect(submitted.statusCode).toBe(200);
    expect(
      submitted.json<{ score: number; maxScore: number; percentage: number; passed: boolean }>(),
    ).toMatchObject({ score: 2, maxScore: 2, percentage: 100, passed: true });
  });

  it('a wrong answer scores zero and fails', async () => {
    const { attempt, questions } = await startAttempt(w.learner, w.quizP.assessmentId);
    const wrong = questions[0]!.options.find((o) => o.body === 'Wrong')!;
    const submitted = await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers: [{ questionId: questions[0]!.id, selectedOptionIds: [wrong.id] }],
    });
    expect(submitted.json<{ score: number; passed: boolean }>()).toMatchObject({
      score: 0,
      passed: false,
    });
  });

  it('SCENARIO A — a learner reads their own attempt', async () => {
    const { attempt } = await startAttempt(w.learner, w.quizP.assessmentId);
    const read = await get(`/api/v1/attempts/${attempt.id}`, w.learner.cookie);
    expect(read.statusCode).toBe(200);
    expect(read.json<{ attempt: { id: string } }>().attempt.id).toBe(attempt.id);
  });

  it('and lists their own attempts', async () => {
    await startAttempt(w.learner, w.quizP.assessmentId);
    const list = await get('/api/v1/me/attempts', w.learner.cookie);
    expect(list.statusCode).toBe(200);
    expect(items(list)).toHaveLength(1);
  });

  it('submitting notes engagement on the lesson, but never completion', async () => {
    const { attempt, questions } = await startAttempt(w.learner, w.quizP.assessmentId);
    await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers: [
        { questionId: questions[0]!.id, selectedOptionIds: [questions[0]!.options[0]!.id] },
      ],
    });
    const progress = await get('/api/v1/me/progress', w.learner.cookie);
    const rows = items<{ status: string; lessonTitle: string }>(progress);
    expect(rows).toHaveLength(1);
    // `in_progress`, NEVER `completed`. Passing an assessment is evidence about
    // one paper on one day; completion is a claim only the learner may author.
    expect(rows[0]?.status).toBe('in_progress');
  });
});

// =====================================================================
// Answer-key non-disclosure — the property this whole domain is built around
// =====================================================================

describe('SCENARIO K — the answer key is never disclosed', () => {
  it('the assessment metadata carries no answers', async () => {
    const response = await get(`/api/v1/assessments/${w.quizP.assessmentId}`, w.learner.cookie);
    expect(response.body).not.toMatch(/correct|isCorrect|answerKey/i);
  });

  it('the paper handed out at the start of an attempt carries no answers', async () => {
    const response = await post(
      `/api/v1/assessments/${w.quizP.assessmentId}/attempts`,
      w.learner.cookie,
    );
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toMatch(/correct|isCorrect|answerKey/i);
    // And no correct option id appears anywhere in the payload under any name.
    for (const id of w.quizP.q.correctOptionIds) {
      // The id itself IS present — it is an option the learner must be able to
      // choose. What must not be present is any marker distinguishing it.
      expect(response.body).toContain(id);
    }
    const parsed = response.json<{
      questions: Array<Record<string, unknown> & { options: Array<Record<string, unknown>> }>;
    }>();
    for (const q of parsed.questions) {
      expect(Object.keys(q).sort()).toEqual(
        ['id', 'options', 'points', 'position', 'prompt', 'questionType', 'selectionLimit'].sort(),
      );
      for (const o of q.options) expect(Object.keys(o).sort()).toEqual(['body', 'id', 'position']);
    }
  });

  it('the result after submission still carries no answers', async () => {
    const { attempt, questions } = await startAttempt(w.learner, w.quizP.assessmentId);
    const submitted = await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers: [{ questionId: questions[0]!.id, selectedOptionIds: [] }],
    });
    expect(submitted.body).not.toMatch(/correct|isCorrect|answerKey/i);
    // Nor per-question correctness, which for a two-option question WOULD be
    // the key. A review-after-close feature needs a deliberate release policy;
    // it is not being smuggled in as a convenience.
    expect(submitted.body).not.toContain(questions[0]!.id);
  });

  it('re-reading a SUBMITTED attempt no longer returns the paper at all', async () => {
    const { attempt, questions } = await startAttempt(w.learner, w.quizP.assessmentId);
    await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers: [{ questionId: questions[0]!.id, selectedOptionIds: [] }],
    });
    const read = await get(`/api/v1/attempts/${attempt.id}`, w.learner.cookie);
    expect(read.json<{ questions: unknown[] }>().questions).toEqual([]);
  });

  it('a reader who is not the learner never receives the paper', async () => {
    const { attempt } = await startAttempt(w.learner, w.quizP.assessmentId);
    for (const reader of [w.teacher, w.guardian, w.admin]) {
      const read = await get(`/api/v1/attempts/${attempt.id}`, reader.cookie);
      expect(read.statusCode).toBe(200);
      expect(read.json<{ questions: unknown[] }>().questions).toEqual([]);
    }
  });

  it('the authoring response echoes an id, not the question', async () => {
    const draft = await createActivity({ lessonId: w.courseP.lessonId, status: 'draft' });
    const created = await post(
      `/api/v1/assessments/${draft.assessmentId}/questions`,
      w.author.cookie,
      {
        questionType: 'single_choice',
        prompt: 'Secret question',
        options: ['Yes', 'No'],
        correctOptions: [0],
      },
    );
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('Secret question');
    expect(created.body).not.toMatch(/Yes|No/);
  });
});

// =====================================================================
// IDOR / BOLA — the named scenarios
// =====================================================================

describe('cross-user access', () => {
  it('SCENARIO B — a learner cannot read another learner’s attempt', async () => {
    const { attempt } = await startAttempt(w.learner, w.quizP.assessmentId);
    const response = await get(`/api/v1/attempts/${attempt.id}`, w.peer.cookie);
    expect(response.statusCode).toBe(404);
  });

  it('SCENARIO C — a learner cannot submit another learner’s attempt', async () => {
    const { attempt, questions } = await startAttempt(w.learner, w.quizP.assessmentId);
    const response = await post(`/api/v1/attempts/${attempt.id}/submit`, w.peer.cookie, {
      answers: [{ questionId: questions[0]!.id, selectedOptionIds: [] }],
    });
    expect(response.statusCode).toBe(404);

    // And the attempt is untouched — a refusal that left it submitted would be
    // a denial in name only.
    const read = await get(`/api/v1/attempts/${attempt.id}`, w.learner.cookie);
    expect(read.json<{ attempt: { status: string } }>().attempt.status).toBe('in_progress');
  });

  it('SCENARIO D — a learner cannot attempt an assessment they cannot reach', async () => {
    // Same school, different class: course Q is assigned to A2 and this learner
    // is in A1.
    const response = await post(
      `/api/v1/assessments/${w.quizQ.assessmentId}/attempts`,
      w.learner.cookie,
    );
    expect(response.statusCode).toBe(404);
  });

  it('SCENARIO E — a learner cannot reach a DRAFT assessment', async () => {
    expect(
      (await get(`/api/v1/assessments/${w.draftQuiz.assessmentId}`, w.learner.cookie)).statusCode,
    ).toBe(404);
    // And cannot start an attempt at it either. This is VULN-027: the draft is
    // on a lesson the learner CAN reach, so a write path checking only the
    // lesson admitted an attempt at unreviewed material.
    expect(
      (await post(`/api/v1/assessments/${w.draftQuiz.assessmentId}/attempts`, w.learner.cookie))
        .statusCode,
    ).toBe(404);
  });

  it('SCENARIO F — a learner cannot reach another organization’s assessment', async () => {
    expect(
      (await get(`/api/v1/assessments/${w.quizB.assessmentId}`, w.learner.cookie)).statusCode,
    ).toBe(404);
    expect(
      (await post(`/api/v1/assessments/${w.quizB.assessmentId}/attempts`, w.learner.cookie))
        .statusCode,
    ).toBe(404);
  });

  it('SCENARIO G — a forged score is ignored and the real one is computed', async () => {
    const { attempt, questions } = await startAttempt(w.learner, w.quizP.assessmentId);
    const wrong = questions[0]!.options.find((o) => o.body === 'Wrong')!;
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attempt.id}/submit`,
      headers: { ...writeHeaders, cookie: w.learner.cookie },
      payload: {
        answers: [{ questionId: questions[0]!.id, selectedOptionIds: [wrong.id] }],
        score: 100,
        percentage: 100,
        passed: true,
        maxScore: 100,
      },
    });
    // REJECTED, not ignored: the contract is `.strict()`, so an unknown field
    // is a 400 rather than a value some future code path starts trusting.
    expect(response.statusCode).toBe(400);

    // And with the extra fields removed, the real score is computed.
    const clean = await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers: [{ questionId: questions[0]!.id, selectedOptionIds: [wrong.id] }],
    });
    expect(clean.json<{ score: number; passed: boolean }>()).toMatchObject({
      score: 0,
      passed: false,
    });
  });

  it('SCENARIO H — a forged learner id is refused by the contract', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/api/v1/assessments/${w.quizP.assessmentId}/attempts`,
      headers: { ...writeHeaders, cookie: w.learner.cookie },
      payload: { userId: w.peer.id, learnerId: w.peer.id },
    });
    expect(response.statusCode).toBe(400);

    // And the authenticated actor remains authoritative on the clean request.
    const { attempt } = await startAttempt(w.learner, w.quizP.assessmentId);
    expect((await get(`/api/v1/attempts/${attempt.id}`, w.peer.cookie)).statusCode).toBe(404);
    expect((await get(`/api/v1/attempts/${attempt.id}`, w.learner.cookie)).statusCode).toBe(200);
  });

  it('SCENARIO I — a submitted attempt cannot be modified', async () => {
    const { attempt, questions } = await startAttempt(w.learner, w.quizP.assessmentId);
    const correct = questions[0]!.options.find((o) => o.body === 'Right')!;
    await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers: [{ questionId: questions[0]!.id, selectedOptionIds: [correct.id] }],
    });

    const again = await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers: [{ questionId: questions[0]!.id, selectedOptionIds: [] }],
    });
    expect(again.statusCode).toBe(403);

    const read = await get(`/api/v1/attempts/${attempt.id}`, w.learner.cookie);
    expect(read.json<{ attempt: { score: number } }>().attempt.score).toBe(2);
  });

  it('SCENARIO J — the attempt limit is enforced, and cannot be bypassed by the payload', async () => {
    await startAttempt(w.learner, w.quizP.assessmentId);
    await startAttempt(w.learner, w.quizP.assessmentId);
    const third = await post(
      `/api/v1/assessments/${w.quizP.assessmentId}/attempts`,
      w.learner.cookie,
    );
    expect(third.statusCode).toBe(409);
    expect(await auditTypes()).toContain('assessment.attempt_limit_exceeded');
  });

  it('SCENARIO L — a question id from another assessment is refused and reported', async () => {
    const { attempt } = await startAttempt(w.learner, w.quizP.assessmentId);
    const response = await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers: [{ questionId: w.quizQ.q.questionId, selectedOptionIds: [w.quizQ.q.optionIds[0]!] }],
    });
    expect(response.statusCode).toBe(400);
    expect(await auditTypes()).toContain('assessment.suspicious_submission');
  });

  it('and an option id from another question is refused', async () => {
    const { attempt, questions } = await startAttempt(w.learner, w.quizP.assessmentId);
    const response = await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers: [{ questionId: questions[0]!.id, selectedOptionIds: [w.quizQ.q.optionIds[0]!] }],
    });
    expect(response.statusCode).toBe(400);
  });

  it('SCENARIO M — a teacher cannot read a student outside their class', async () => {
    await startAttempt(w.learner, w.quizP.assessmentId);
    // `otherTeacher` teaches A2; `learner` is in A1.
    const response = await get(
      `/api/v1/classes/${w.classA1}/students/${w.learner.id}/attempts`,
      w.otherTeacher.cookie,
    );
    expect(response.statusCode).toBe(404);
  });

  it('and a teacher of the right class cannot read a NON-MEMBER through it', async () => {
    const response = await get(
      `/api/v1/classes/${w.classA1}/students/${w.otherClassLearner.id}/attempts`,
      w.teacher.cookie,
    );
    expect(response.statusCode).toBe(404);
  });

  it('but the teacher of the shared class CAN read their student', async () => {
    await startAttempt(w.learner, w.quizP.assessmentId);
    const response = await get(
      `/api/v1/classes/${w.classA1}/students/${w.learner.id}/attempts`,
      w.teacher.cookie,
    );
    expect(response.statusCode).toBe(200);
    expect(items(response)).toHaveLength(1);
  });

  it('SCENARIO N — a guardian cannot read an unlinked child', async () => {
    await startAttempt(w.learner, w.quizP.assessmentId);
    const response = await get(
      `/api/v1/guardians/children/${w.learner.id}/attempts`,
      w.otherGuardian.cookie,
    );
    expect(response.statusCode).toBe(404);
  });

  it('but the verified guardian CAN', async () => {
    await startAttempt(w.learner, w.quizP.assessmentId);
    const response = await get(
      `/api/v1/guardians/children/${w.learner.id}/attempts`,
      w.guardian.cookie,
    );
    expect(response.statusCode).toBe(200);
    expect(items(response)).toHaveLength(1);
  });

  it('a PENDING guardian link grants nothing', async () => {
    const pending = await seedAndLogin({
      email: 'pending@t.local',
      roles: ['guardian'],
      organizationId: w.orgA,
    });
    await linkGuardian(pending.id, w.learner.id, 'pending');
    await startAttempt(w.learner, w.quizP.assessmentId);
    expect(
      (await get(`/api/v1/guardians/children/${w.learner.id}/attempts`, pending.cookie)).statusCode,
    ).toBe(404);
  });

  it('SCENARIO O — an administrator cannot reach across organizations', async () => {
    await startAttempt(w.learner, w.quizP.assessmentId);
    expect(
      (
        await get(
          `/api/v1/classes/${w.classA1}/students/${w.learner.id}/attempts`,
          w.foreignAdmin.cookie,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await get(`/api/v1/assessments/${w.quizP.assessmentId}`, w.foreignAdmin.cookie)).statusCode,
    ).toBe(404);
  });

  it('a SECURITY administrator gets no educational data', async () => {
    const { attempt } = await startAttempt(w.learner, w.quizP.assessmentId);
    expect((await get(`/api/v1/attempts/${attempt.id}`, w.securityAdmin.cookie)).statusCode).toBe(
      404,
    );
    expect(
      (
        await get(
          `/api/v1/classes/${w.classA1}/students/${w.learner.id}/attempts`,
          w.securityAdmin.cookie,
        )
      ).statusCode,
    ).toBe(404);
  });
});

// =====================================================================
// Authoring and the duty split
// =====================================================================

describe('authoring', () => {
  it('an author creates a draft assessment activity', async () => {
    const response = await post(
      `/api/v1/lessons/${w.courseP.lessonId}/activities`,
      w.author.cookie,
      {
        activityType: 'assessment',
        title: 'New Quiz',
        assessment: { passingPercentage: 60, maxAttempts: 3 },
      },
    );
    expect(response.statusCode).toBe(201);
    expect(response.json<{ status: string }>().status).toBe('draft');
  });

  it('an activity cannot be born published', async () => {
    const response = await post(
      `/api/v1/lessons/${w.courseP.lessonId}/activities`,
      w.author.cookie,
      { activityType: 'assessment', title: 'X', status: 'published', assessment: {} },
    );
    expect(response.statusCode).toBe(400);
  });

  it('an assessment activity requires its configuration; a non-assessment refuses it', async () => {
    expect(
      (
        await post(`/api/v1/lessons/${w.courseP.lessonId}/activities`, w.author.cookie, {
          activityType: 'assessment',
          title: 'X',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post(`/api/v1/lessons/${w.courseP.lessonId}/activities`, w.author.cookie, {
          activityType: 'practice',
          title: 'X',
          assessment: {},
        })
      ).statusCode,
    ).toBe(400);
  });

  it('an AUTHOR cannot publish', async () => {
    const draft = await createActivity({ lessonId: w.courseP.lessonId, status: 'draft' });
    await createQuestion({
      assessmentId: draft.assessmentId!,
      options: ['A', 'B'],
      correctOptions: [0],
    });
    const response = await post(`/api/v1/activities/${draft.activityId}/publish`, w.author.cookie);
    expect(response.statusCode).toBe(403);
  });

  it('a REVIEWER can publish a well-formed assessment', async () => {
    const draft = await createActivity({ lessonId: w.courseP.lessonId, status: 'draft' });
    await createQuestion({
      assessmentId: draft.assessmentId!,
      options: ['A', 'B'],
      correctOptions: [0],
    });
    const response = await post(
      `/api/v1/activities/${draft.activityId}/publish`,
      w.reviewer.cookie,
    );
    expect(response.statusCode).toBe(200);
    expect(await auditTypes()).toContain('content.published');
  });

  it('but not a malformed one', async () => {
    const draft = await createActivity({ lessonId: w.courseP.lessonId, status: 'draft' });
    const response = await post(
      `/api/v1/activities/${draft.activityId}/publish`,
      w.reviewer.cookie,
    );
    expect(response.statusCode).toBe(409);
  });

  it('a question cannot be added after publication', async () => {
    const response = await post(
      `/api/v1/assessments/${w.quizP.assessmentId}/questions`,
      w.author.cookie,
      { questionType: 'single_choice', prompt: 'Late', options: ['A', 'B'], correctOptions: [0] },
    );
    // Refused by the policy first — a published activity may not be edited.
    expect(response.statusCode).toBe(403);
  });

  it('a LEARNER cannot author anything', async () => {
    expect(
      (
        await post(`/api/v1/lessons/${w.courseP.lessonId}/activities`, w.learner.cookie, {
          activityType: 'assessment',
          title: 'Mine',
          assessment: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await post(`/api/v1/assessments/${w.quizP.assessmentId}/questions`, w.learner.cookie, {
          questionType: 'single_choice',
          prompt: 'X',
          options: ['A', 'B'],
          correctOptions: [0],
        })
      ).statusCode,
    ).toBe(404);
  });

  it('an author of another school cannot author here', async () => {
    const foreignAuthor = await seedAndLogin({
      email: 'author@b.local',
      roles: ['content_author'],
      organizationId: w.orgB,
    });
    expect(
      (
        await post(`/api/v1/lessons/${w.courseP.lessonId}/activities`, foreignAuthor.cookie, {
          activityType: 'assessment',
          title: 'Theirs',
          assessment: {},
        })
      ).statusCode,
    ).toBe(404);
  });

  it('archiving withdraws the activity from learners', async () => {
    expect(
      (await post(`/api/v1/activities/${w.quizP.activityId}/archive`, w.reviewer.cookie))
        .statusCode,
    ).toBe(200);
    expect(
      (await get(`/api/v1/assessments/${w.quizP.assessmentId}`, w.learner.cookie)).statusCode,
    ).toBe(404);
    expect(
      (await post(`/api/v1/assessments/${w.quizP.assessmentId}/attempts`, w.learner.cookie))
        .statusCode,
    ).toBe(404);
  });
});

// =====================================================================
// Listing, malformed input and revocation
// =====================================================================

describe('activity listing', () => {
  it('a learner sees only published activities on their lesson', async () => {
    const response = await get(
      `/api/v1/lessons/${w.courseP.lessonId}/activities`,
      w.learner.cookie,
    );
    expect(response.statusCode).toBe(200);
    expect(
      items<{ title: string }>(response)
        .map((a) => a.title)
        .sort(),
    ).toEqual(['P Quiz', 'Withheld Quiz']);
  });

  it('an author sees the drafts too', async () => {
    const response = await get(`/api/v1/lessons/${w.courseP.lessonId}/activities`, w.author.cookie);
    expect(
      items<{ title: string }>(response)
        .map((a) => a.title)
        .sort(),
    ).toEqual(['Draft Quiz', 'P Quiz', 'Withheld Quiz']);
  });

  it('a learner cannot list activities on a lesson they cannot reach', async () => {
    expect(
      (await get(`/api/v1/lessons/${w.courseQ.lessonId}/activities`, w.learner.cookie)).statusCode,
    ).toBe(404);
  });

  it('rejects a sort field that is not allow-listed', async () => {
    const response = await get(
      `/api/v1/lessons/${w.courseP.lessonId}/activities?sort=title;DROP TABLE users`,
      w.learner.cookie,
    );
    expect(response.statusCode).toBe(400);
  });

  it('rejects an unknown query parameter rather than ignoring it', async () => {
    expect(
      (await get('/api/v1/me/attempts?userId=' + w.peer.id, w.learner.cookie)).statusCode,
    ).toBe(400);
  });
});

describe('malformed submissions', () => {
  it('rejects a non-UUID attempt id', async () => {
    expect((await get('/api/v1/attempts/not-a-uuid', w.learner.cookie)).statusCode).toBe(400);
  });

  it('rejects more answers than an assessment could have', async () => {
    const { attempt, questions } = await startAttempt(w.learner, w.quizP.assessmentId);
    const answers = Array.from({ length: 101 }, () => ({
      questionId: questions[0]!.id,
      selectedOptionIds: [],
    }));
    const response = await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers,
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a repeated question in one submission', async () => {
    const { attempt, questions } = await startAttempt(w.learner, w.quizP.assessmentId);
    const response = await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers: [
        { questionId: questions[0]!.id, selectedOptionIds: [] },
        { questionId: questions[0]!.id, selectedOptionIds: [] },
      ],
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects two selections on a single-choice question', async () => {
    const { attempt, questions } = await startAttempt(w.learner, w.quizP.assessmentId);
    const response = await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers: [
        {
          questionId: questions[0]!.id,
          selectedOptionIds: questions[0]!.options.map((o) => o.id),
        },
      ],
    });
    expect(response.statusCode).toBe(400);
  });

  it('accepts an empty submission — that is a learner who ran out of time', async () => {
    const { attempt } = await startAttempt(w.learner, w.quizP.assessmentId);
    const response = await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers: [],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ score: number; maxScore: number }>()).toMatchObject({
      score: 0,
      maxScore: 2,
    });
  });

  it('every write requires authentication', async () => {
    for (const url of [
      `/api/v1/assessments/${w.quizP.assessmentId}/attempts`,
      `/api/v1/attempts/${w.quizP.assessmentId}/submit`,
      `/api/v1/lessons/${w.courseP.lessonId}/activities`,
    ]) {
      const response = await testApp.app.inject({
        method: 'POST',
        url,
        headers: writeHeaders,
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    }
  });
});

describe('revocation and retention', () => {
  it('removing the learner from the class stops new attempts ON THE SAME SESSION', async () => {
    await asSuperuser(
      `UPDATE class_memberships SET status='ended', ended_at=now() WHERE user_id=$1`,
      [w.learner.id],
    );
    expect(
      (await post(`/api/v1/assessments/${w.quizP.assessmentId}/attempts`, w.learner.cookie))
        .statusCode,
    ).toBe(404);
  });

  it('but their submitted results remain readable, and legible', async () => {
    const { attempt, questions } = await startAttempt(w.learner, w.quizP.assessmentId);
    await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers: [{ questionId: questions[0]!.id, selectedOptionIds: [] }],
    });
    await asSuperuser(
      `UPDATE class_memberships SET status='ended', ended_at=now() WHERE user_id=$1`,
      [w.learner.id],
    );

    const list = await get('/api/v1/me/attempts', w.learner.cookie);
    expect(list.statusCode).toBe(200);
    const rows = items<{ assessmentTitle: string; courseTitle: string; score: number }>(list);
    expect(rows).toHaveLength(1);
    // The TITLES survive. A join to `assessments` here would have returned zero
    // rows and silently erased the learner's own history.
    expect(rows[0]?.assessmentTitle).toBe('P Quiz');
    expect(rows[0]?.courseTitle).toBe('P');
  });

  it('withdrawing the course has the same effect', async () => {
    await asSuperuser(
      `UPDATE class_course_assignments SET status='inactive', ended_at=now() WHERE class_id=$1`,
      [w.classA1],
    );
    expect(
      (await post(`/api/v1/assessments/${w.quizP.assessmentId}/attempts`, w.learner.cookie))
        .statusCode,
    ).toBe(404);
  });
});

describe('the audit trail', () => {
  it('records the attempt lifecycle without recording any answer', async () => {
    const { attempt, questions } = await startAttempt(w.learner, w.quizP.assessmentId);
    await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers: [
        { questionId: questions[0]!.id, selectedOptionIds: [questions[0]!.options[0]!.id] },
      ],
    });
    const types = await auditTypes();
    expect(types).toContain('assessment.attempt_started');
    expect(types).toContain('assessment.submitted');

    const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await raw.connect();
    try {
      const { rows } = await raw.query<{ detail: unknown }>('SELECT detail FROM audit_log');
      const serialized = JSON.stringify(rows);
      // No option id, no prompt, no option body anywhere in the audit trail.
      for (const option of questions[0]!.options) {
        expect(serialized).not.toContain(option.id);
        expect(serialized).not.toContain(option.body);
      }
      expect(serialized).not.toContain('Which one?');
    } finally {
      await raw.end();
    }
  });

  it('records a denial when a learner reaches for another’s attempt', async () => {
    const { attempt } = await startAttempt(w.learner, w.quizP.assessmentId);
    await get(`/api/v1/attempts/${attempt.id}`, w.peer.cookie);
    expect(await auditTypes()).toContain('authz.denied');
  });
});

// =====================================================================
// TASK 009 — result release, review and educational feedback
//
// Over the real HTTP stack, with both authorization gates live. The named
// adversarial cases from the task brief are marked in the test names so the
// report's matrix traces back to a test that ran rather than to a claim.
// =====================================================================

/** Sits an assessment through the real endpoints and returns the attempt id. */
async function sitAndSubmit(
  session: Session,
  assessmentId: string,
  answer: 'right' | 'wrong' | 'blank' = 'right',
): Promise<string> {
  const { attempt, questions } = await startAttempt(session, assessmentId);
  const question = questions[0]!;
  const chosen =
    answer === 'blank'
      ? []
      : [
          question.options.find((o) =>
            answer === 'right' ? o.body === 'Right' : o.body === 'Wrong',
          )!.id,
        ];
  const submitted = await post(`/api/v1/attempts/${attempt.id}/submit`, session.cookie, {
    answers: [{ questionId: question.id, selectedOptionIds: chosen }],
  });
  if (submitted.statusCode !== 200) {
    throw new Error(`submit failed: ${submitted.statusCode} ${submitted.body}`);
  }
  return attempt.id;
}

/**
 * The result block of `GET /attempts/:id`, which wraps the attempt alongside
 * the paper. The list endpoints return the attempt flat, so the two are read
 * differently on purpose rather than by a shared shortcut that could hide a
 * difference between them.
 */
const resultOf = (r: { json: <U>() => U }) => r.json<{ attempt: ResultBody }>().attempt;

interface ResultBody {
  score: number | null;
  maxScore: number | null;
  percentage: number | null;
  passed: boolean | null;
  released: boolean;
  releasedAt: string | null;
}

describe('withholding a result', () => {
  it('an `on_submission` assessment still returns the mark immediately', async () => {
    // Task 008's behaviour, unchanged. The default must not alter what any
    // existing assessment does.
    const id = await sitAndSubmit(w.learner, w.quizP.assessmentId);
    const read = await get(`/api/v1/attempts/${id}`, w.learner.cookie);
    expect(resultOf(read)).toMatchObject({ score: 2, passed: true, released: true });
  });

  it('and says so up front, before the learner sits', async () => {
    const meta = await get(`/api/v1/assessments/${w.withheldQuiz.assessmentId}`, w.learner.cookie);
    expect(meta.statusCode).toBe(200);
    expect(meta.json<{ reviewPolicy: string }>().reviewPolicy).toBe('on_release');
  });

  it('AN `on_release` ASSESSMENT RETURNS NO MARK AT ALL — not zero, not null-with-a-hint', async () => {
    // The submission response itself must not carry the mark, because that is
    // the first place a withheld result would leak: the learner already has an
    // authenticated request in flight at the moment of scoring.
    const { attempt, questions } = await startAttempt(w.learner, w.withheldQuiz.assessmentId);
    const correct = questions[0]!.options.find((o) => o.body === 'Right')!;
    const submitted = await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers: [{ questionId: questions[0]!.id, selectedOptionIds: [correct.id] }],
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json<ResultBody>()).toMatchObject({
      score: null,
      maxScore: null,
      percentage: null,
      passed: null,
      released: false,
      releasedAt: null,
    });
  });

  it('and re-reading the attempt does not reveal it either', async () => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    const read = await get(`/api/v1/attempts/${id}`, w.learner.cookie);
    expect(resultOf(read)).toMatchObject({ score: null, passed: null, released: false });
  });

  it('nor does the learner’s own attempt LIST', async () => {
    // The list is a different query with a different shape, and a redaction
    // applied only to the single-record read would leak through it.
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    const list = items<ResultBody & { id: string }>(
      await get('/api/v1/me/attempts', w.learner.cookie),
    );
    const row = list.find((r) => r.id === id)!;
    expect(row).toMatchObject({ score: null, passed: null, released: false });
  });

  it('nor the GUARDIAN’s view of their child', async () => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    const list = items<ResultBody & { id: string }>(
      await get(`/api/v1/guardians/children/${w.learner.id}/attempts`, w.guardian.cookie),
    );
    expect(list.find((r) => r.id === id)).toMatchObject({ score: null, released: false });
  });

  it('BUT THE TEACHER SEES THE MARK — withholding is from the subject, not from staff', async () => {
    // The positive case, and the one that makes release possible at all: a
    // teacher cannot decide whether to release a result they cannot see.
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    const read = await get(`/api/v1/attempts/${id}`, w.teacher.cookie);
    expect(resultOf(read)).toMatchObject({ score: 2, passed: true, released: false });
  });

  it('the mark is withheld in the RESPONSE, not merely hidden by the client', async () => {
    // The number must not appear anywhere in the payload under any name. A
    // field the frontend is trusted to hide is not a control.
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    const read = await get(`/api/v1/attempts/${id}`, w.learner.cookie);
    const body = resultOf(read) as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(body)) {
      if (key === 'passingPercentage') continue; // a property of the assessment, not the result
      expect(typeof value === 'number' && value === 2).toBe(false);
    }
  });
});

describe('releasing a result', () => {
  const release = (session: Session, attemptId: string, payload?: Record<string, unknown>) =>
    post(`/api/v1/attempts/${attemptId}/release`, session.cookie, payload);

  it('A LEARNER CANNOT RELEASE THEIR OWN RESULT', async () => {
    // The single most important refusal in this task.
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    const response = await release(w.learner, id);
    expect(response.statusCode).toBe(403);
    // And nothing moved.
    const read = await get(`/api/v1/attempts/${id}`, w.learner.cookie);
    expect(resultOf(read)).toMatchObject({ released: false, score: null });
  });

  it('A LEARNER CANNOT RELEASE ANOTHER LEARNER’S RESULT', async () => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    const response = await release(w.peer, id);
    // 404, not 403: a peer has no standing to know the attempt exists.
    expect(response.statusCode).toBe(404);
  });

  it('AN UNAUTHORIZED TEACHER CANNOT RELEASE — another class, same school', async () => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    const response = await release(w.otherTeacher, id);
    expect(response.statusCode).toBe(404);
  });

  it('A TEACHER CANNOT RELEASE A RESULT FROM ANOTHER CLASS they do teach', async () => {
    // The mirror of the case above, from the other side: `otherTeacher` teaches
    // A2, so they may release A2's results and not A1's. Both directions are
    // asserted, because a rule that admitted everyone would pass one of them.
    const theirs = await sitAndSubmit(w.otherClassLearner, w.withheldQuizQ.assessmentId);
    expect((await release(w.otherTeacher, theirs)).statusCode).toBe(200);
    const mine = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    expect((await release(w.otherTeacher, mine)).statusCode).toBe(404);
  });

  it('A TEACHER FROM ANOTHER ORGANIZATION CANNOT RELEASE', async () => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    expect((await release(w.foreignAdmin, id)).statusCode).toBe(404);
  });

  it('A GUARDIAN CANNOT RELEASE, though they may read the attempt', async () => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    expect((await get(`/api/v1/attempts/${id}`, w.guardian.cookie)).statusCode).toBe(200);
    expect((await release(w.guardian, id)).statusCode).toBe(404);
  });

  it('A SECURITY ADMINISTRATOR CANNOT RELEASE', async () => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    expect((await release(w.securityAdmin, id)).statusCode).toBe(404);
  });

  it('the teacher of the class CAN release, and the learner then sees the mark', async () => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    const released = await release(w.teacher, id);
    expect(released.statusCode).toBe(200);
    expect(released.json<ResultBody>()).toMatchObject({ released: true });

    const read = await get(`/api/v1/attempts/${id}`, w.learner.cookie);
    expect(resultOf(read)).toMatchObject({
      score: 2,
      maxScore: 2,
      passed: true,
      released: true,
    });
    expect(resultOf(read).releasedAt).not.toBeNull();
  });

  it('an administrator of the school can release too', async () => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    expect((await release(w.admin, id)).statusCode).toBe(200);
  });

  it('releasing twice is idempotent and does not move the timestamp', async () => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    const first = await release(w.teacher, id);
    const firstAt = first.json<{ releasedAt: string }>().releasedAt;
    const second = await release(w.admin, id);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ releasedAt: string }>().releasedAt).toBe(firstAt);
  });

  it('an in-progress attempt has nothing to release', async () => {
    const { attempt } = await startAttempt(w.learner, w.withheldQuiz.assessmentId);
    expect((await release(w.teacher, attempt.id)).statusCode).toBe(403);
  });

  it('a release carries a teacher comment, and the learner reads it', async () => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    await release(w.teacher, id, { teacherComment: 'راجع الوحدة الثانية قبل المحاولة القادمة' });
    const review = await get(`/api/v1/attempts/${id}/review`, w.learner.cookie);
    expect(review.json<{ teacherComment: string }>().teacherComment).toBe(
      'راجع الوحدة الثانية قبل المحاولة القادمة',
    );
  });

  it('the release is recorded in the audit trail', async () => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    await release(w.teacher, id);
    expect(await auditTypes()).toContain('assessment.result_released');
  });
});

describe('parameter tampering on release', () => {
  const releaseRaw = (session: Session, attemptId: string, payload: Record<string, unknown>) =>
    post(`/api/v1/attempts/${attemptId}/release`, session.cookie, payload);

  it.each([
    ['a score', { score: 10 }],
    ['a percentage', { percentage: 100 }],
    ['a pass flag', { passed: true }],
    ['a learner id', { userId: '00000000-0000-4000-8000-000000000000' }],
    ['a learner id under another name', { learnerId: '00000000-0000-4000-8000-000000000000' }],
    ['an organization', { organizationId: '00000000-0000-4000-8000-000000000000' }],
    ['a class', { classId: '00000000-0000-4000-8000-000000000000' }],
    ['a release timestamp', { releasedAt: '2001-01-01T00:00:00.000Z' }],
    ['a releaser', { releasedBy: '00000000-0000-4000-8000-000000000000' }],
  ])('a release body carrying %s is REFUSED, not silently ignored', async (_label, extra) => {
    // `.strict()` turns an unexpected field into a 400. Silently dropping it
    // would leave a caller believing the platform accepted their number.
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    const response = await releaseRaw(w.teacher, id, extra);
    expect(response.statusCode).toBe(400);
    const read = await get(`/api/v1/attempts/${id}`, w.learner.cookie);
    expect(resultOf(read).released).toBe(false);
  });

  it('a comment longer than the limit is refused', async () => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    const response = await releaseRaw(w.teacher, id, { teacherComment: 'x'.repeat(2001) });
    expect(response.statusCode).toBe(400);
  });

  it('a release aimed at an attempt that does not exist is a 404', async () => {
    const response = await post(
      `/api/v1/attempts/00000000-0000-4000-8000-000000000000/release`,
      w.teacher.cookie,
    );
    expect(response.statusCode).toBe(404);
  });

  it('a release aimed at a malformed id is a 400, not a 500', async () => {
    expect((await post('/api/v1/attempts/not-a-uuid/release', w.teacher.cookie)).statusCode).toBe(
      400,
    );
  });

  it('an unauthenticated release is refused', async () => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${id}/release`,
      headers: writeHeaders,
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('reviewing the marked paper', () => {
  const review = (session: Session, attemptId: string) =>
    get(`/api/v1/attempts/${attemptId}/review`, session.cookie);

  interface Review {
    questions: Array<{
      questionId: string;
      isCorrect: boolean;
      awarded: number;
      explanation: string;
      correctOptionIds: string[];
      selectedOptionIds: string[];
    }>;
    released: boolean;
    teacherComment: string | null;
  }

  it('THE LEARNER CANNOT REVIEW AN UNRELEASED PAPER', async () => {
    // The answer key is the payload here, so this is the refusal that matters
    // most: a review endpoint that ignored release would be a key oracle for
    // every learner who had sat the paper once.
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    const response = await review(w.learner, id);
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(w.withheldQuiz.q.correctOptionIds[0]);
  });

  it('nor can their guardian', async () => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    expect((await review(w.guardian, id)).statusCode).toBe(403);
  });

  it('the learner reviews it once released, and is told WHY', async () => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId, 'wrong');
    await post(`/api/v1/attempts/${id}/release`, w.teacher.cookie, {});
    const response = await review(w.learner, id);
    expect(response.statusCode).toBe(200);
    const body = response.json<Review>();
    expect(body.released).toBe(true);
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0]).toMatchObject({
      isCorrect: false,
      awarded: 0,
      explanation: 'Because Right is right.',
    });
    // The educational point: a wrong answer that teaches nothing is worth less
    // than one that does, so the learner is told what the right answer WAS.
    expect(body.questions[0]!.correctOptionIds).toEqual(w.withheldQuiz.q.correctOptionIds);
  });

  it('an `on_submission` paper is reviewable straight away', async () => {
    const id = await sitAndSubmit(w.learner, w.quizP.assessmentId);
    expect((await review(w.learner, id)).statusCode).toBe(200);
  });

  it('A PEER CANNOT REVIEW A RELEASED PAPER — release is not publication', async () => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    await post(`/api/v1/attempts/${id}/release`, w.teacher.cookie, {});
    const response = await review(w.peer, id);
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(w.withheldQuiz.q.correctOptionIds[0]);
  });

  it.each([
    ['a teacher of another class', () => w.otherTeacher],
    ['an administrator of another organization', () => w.foreignAdmin],
    ['a security administrator', () => w.securityAdmin],
  ])('%s cannot review a released paper either', async (_label, who) => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    await post(`/api/v1/attempts/${id}/release`, w.teacher.cookie, {});
    const response = await review(who(), id);
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(w.withheldQuiz.q.correctOptionIds[0]);
  });

  it('THE TEACHER MAY REVIEW BEFORE RELEASE — that is how the decision is made', async () => {
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    const response = await review(w.teacher, id);
    expect(response.statusCode).toBe(200);
    expect(response.json<Review>().questions).toHaveLength(1);
  });

  it('an IN-PROGRESS attempt cannot be reviewed by its own learner', async () => {
    // Otherwise the review endpoint is a way to read the key mid-attempt, which
    // would make every assessment scoreable at full marks on the second try.
    const { attempt } = await startAttempt(w.learner, w.withheldQuiz.assessmentId);
    const response = await review(w.learner, attempt.id);
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(w.withheldQuiz.q.correctOptionIds[0]);
  });

  it('reviewing an attempt that does not exist is a 404', async () => {
    const response = await get(
      '/api/v1/attempts/00000000-0000-4000-8000-000000000000/review',
      w.learner.cookie,
    );
    expect(response.statusCode).toBe(404);
  });

  it('an unauthenticated review is refused', async () => {
    const id = await sitAndSubmit(w.learner, w.quizP.assessmentId);
    const response = await testApp.app.inject({
      method: 'GET',
      url: `/api/v1/attempts/${id}/review`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('the review carries no field that could name another learner', async () => {
    const id = await sitAndSubmit(w.learner, w.quizP.assessmentId);
    const body = (await review(w.learner, id)).json<Review>();
    for (const q of body.questions) {
      expect(Object.keys(q).sort()).toEqual(
        [
          'awarded',
          'correctOptionIds',
          'explanation',
          'isCorrect',
          'options',
          'points',
          'position',
          'prompt',
          'questionId',
          'questionType',
          'selectedOptionIds',
        ].sort(),
      );
    }
  });
});

describe('the result cannot be mutated', () => {
  it('a teacher cannot change a mark by releasing it', async () => {
    // There is no endpoint that accepts a score, and `.strict()` refuses one
    // smuggled into the release body. This asserts the OUTCOME rather than the
    // mechanism: the number a learner is shown is the number the database
    // computed.
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId, 'wrong');
    await post(`/api/v1/attempts/${id}/release`, w.teacher.cookie, {});
    const read = await get(`/api/v1/attempts/${id}`, w.learner.cookie);
    expect(resultOf(read)).toMatchObject({ score: 0, passed: false });
  });

  it('a submitted attempt cannot be re-submitted with better answers', async () => {
    const { attempt, questions } = await startAttempt(w.learner, w.withheldQuiz.assessmentId);
    const wrong = questions[0]!.options.find((o) => o.body === 'Wrong')!;
    const right = questions[0]!.options.find((o) => o.body === 'Right')!;
    await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers: [{ questionId: questions[0]!.id, selectedOptionIds: [wrong.id] }],
    });
    const again = await post(`/api/v1/attempts/${attempt.id}/submit`, w.learner.cookie, {
      answers: [{ questionId: questions[0]!.id, selectedOptionIds: [right.id] }],
    });
    // 403 with `reveal`, not 404: it is their own attempt and they can already
    // see it, so the policy refuses the second submission before the database
    // is reached at all.
    expect(again.statusCode).toBe(403);
    await post(`/api/v1/attempts/${attempt.id}/release`, w.teacher.cookie, {});
    const read = await get(`/api/v1/attempts/${attempt.id}`, w.learner.cookie);
    expect(resultOf(read).score).toBe(0);
  });

  it('a released result cannot be un-released', async () => {
    // There is no endpoint for it, and the database refuses it independently.
    // Asserted here so that adding one later breaks a test rather than a child's
    // expectation.
    const id = await sitAndSubmit(w.learner, w.withheldQuiz.assessmentId);
    await post(`/api/v1/attempts/${id}/release`, w.teacher.cookie, {});
    const read = await get(`/api/v1/attempts/${id}`, w.learner.cookie);
    expect(resultOf(read).released).toBe(true);
  });
});
