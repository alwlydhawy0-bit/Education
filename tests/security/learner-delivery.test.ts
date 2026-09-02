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
  createEducationLevel,
  createOrganization,
  createUser,
  truncateAll,
} from '../setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';

/**
 * Curriculum delivery to a learner, attacked from every direction.
 *
 * THE ONE RULE THIS FILE EXISTS TO PROVE. A learner reaches a piece of content
 * if and only if it is published, its whole ancestry is published, it is in
 * their organization's catalogue or the global one, AND it reaches them through
 * a class they are in. Nothing else grants access — not a known UUID, not a
 * query parameter, not a request body, not a route, not another class, not
 * another school.
 *
 * WHY THE SUITE IS SHAPED AS ONE WORLD WITH MANY ACTORS. Every interesting
 * failure here is RELATIONAL: it is not "can a learner read a lesson" but "can
 * THIS learner read the lesson belonging to THAT class, in THAT school, through
 * THAT attempt". A world with one learner cannot express a cross-class failure,
 * and a suite of single-actor tests passes while the boundary is wide open.
 * Task 010 learned this the expensive way — a defect injection removing the
 * organization boundary was NOT caught, because no foreign admin existed to
 * catch it.
 *
 * THE FRONTEND IS NOT IN THE PICTURE. Everything here is a direct HTTP request.
 * A control that only holds because a React component chose not to render a
 * button is not a control, and none of these assertions could be satisfied by
 * one.
 */
let testApp: TestApp;

const PASSWORD = 'a-sufficiently-long-passphrase'; // secret-scan-allow: test fixture password
const ABSENT = '00000000-0000-4000-8000-000000000000';

interface Session {
  readonly id: string;
  readonly cookie: string;
}

async function seedAndLogin(options: {
  email: string;
  roles?: readonly string[];
  organizationId?: string | null;
}): Promise<Session> {
  const user = await createUser({
    email: options.email,
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.organizationId !== undefined ? { organizationId: options.organizationId } : {}),
    passwordHash: await hashPassword(PASSWORD),
  });
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

const status = async (p: Promise<{ statusCode: number }>): Promise<number> => (await p).statusCode;

const ok = <T>(r: { statusCode: number; body: string; json: <U>() => U }, what: string): T => {
  if (r.statusCode >= 300) throw new Error(`${what}: ${r.statusCode} ${r.body}`);
  return r.json<T>();
};

async function rawRows<T extends pg.QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
  await raw.connect();
  try {
    const { rows } = await raw.query<T>(sql, [...params]);
    return rows;
  } finally {
    await raw.end();
  }
}

let levelId: string;

/**
 * Two schools, two classes in the first, and a course each class studies.
 *
 * `learner` is in class A1 and studies course A. `peer` is in class A2 in the
 * SAME school and studies course B — the cross-class boundary. `foreignLearner`
 * is in another school entirely — the cross-organization boundary. Both exist
 * because they fail differently, and a suite with only one of them proves only
 * half the rule.
 */
async function buildCourse(options: {
  organizationId: string;
  author: Session;
  reviewer: Session;
  code: string;
  title: string;
  /** Left as a draft, to be reachable only by staff. */
  draft?: boolean;
}) {
  const { author, reviewer, organizationId, code, title } = options;
  void organizationId;

  const curriculumId = ok<{ id: string }>(
    await post('/api/v1/curricula', author.cookie, { code, name: `${title} catalogue` }),
    'curriculum',
  ).id;
  const courseId = ok<{ id: string }>(
    await post('/api/v1/courses', author.cookie, { curriculumId, levelId, title }),
    'course',
  ).id;
  const unitId = ok<{ id: string }>(
    await post(`/api/v1/courses/${courseId}/units`, author.cookie, { title: `${title} unit` }),
    'unit',
  ).id;
  const lessonId = ok<{ id: string }>(
    await post(`/api/v1/units/${unitId}/lessons`, author.cookie, {
      title: `${title} lesson`,
      contentBody: 'Published body.',
      objectives: [`${title} objective one`, `${title} objective two`],
    }),
    'lesson',
  ).id;
  const activity = ok<{ id: string; assessmentId: string }>(
    await post(`/api/v1/lessons/${lessonId}/activities`, author.cookie, {
      activityType: 'assessment',
      title: `${title} quiz`,
      assessment: { passingPercentage: 50, maxAttempts: 5 },
    }),
    'activity',
  );
  ok(
    await post(`/api/v1/assessments/${activity.assessmentId}/questions`, author.cookie, {
      questionType: 'single_choice',
      prompt: 'What is F?',
      options: ['ma', 'mv'],
      correctOptions: [0],
      points: 2,
    }),
    'question',
  );

  // A second lesson that stays a DRAFT, so every suite below has a draft of
  // this course to try to reach by id.
  const draftLessonId = ok<{ id: string }>(
    await post(`/api/v1/units/${unitId}/lessons`, author.cookie, {
      title: `${title} draft lesson`,
      contentBody: 'Not for learners.',
    }),
    'draft lesson',
  ).id;

  if (options.draft !== true) {
    for (const url of [
      `/api/v1/curricula/${curriculumId}/publish`,
      `/api/v1/courses/${courseId}/publish`,
      `/api/v1/units/${unitId}/publish`,
      `/api/v1/lessons/${lessonId}/publish`,
      `/api/v1/activities/${activity.id}/publish`,
    ]) {
      ok(await post(url, reviewer.cookie), url);
    }
  }

  return {
    curriculumId,
    courseId,
    unitId,
    lessonId,
    draftLessonId,
    activityId: activity.id,
    assessmentId: activity.assessmentId,
  };
}

async function world() {
  const orgA = await createOrganization('School A');
  const orgB = await createOrganization('School B');

  const author = await seedAndLogin({
    email: 'author@a.local',
    roles: ['content_author'],
    organizationId: orgA,
  });
  const reviewer = await seedAndLogin({
    email: 'reviewer@a.local',
    roles: ['reviewer'],
    organizationId: orgA,
  });
  const teacher = await seedAndLogin({
    email: 'teacher@a.local',
    roles: ['teacher'],
    organizationId: orgA,
  });
  const learner = await seedAndLogin({ email: 'learner@a.local', organizationId: orgA });
  const peer = await seedAndLogin({ email: 'peer@a.local', organizationId: orgA });

  const foreignAuthor = await seedAndLogin({
    email: 'author@b.local',
    roles: ['content_author'],
    organizationId: orgB,
  });
  const foreignReviewer = await seedAndLogin({
    email: 'reviewer@b.local',
    roles: ['reviewer'],
    organizationId: orgB,
  });
  const foreignLearner = await seedAndLogin({ email: 'learner@b.local', organizationId: orgB });

  const courseA = await buildCourse({
    organizationId: orgA,
    author,
    reviewer,
    code: 'a_phys',
    title: 'Physics A',
  });
  const courseB = await buildCourse({
    organizationId: orgA,
    author,
    reviewer,
    code: 'a_chem',
    title: 'Chemistry A',
  });
  const draftCourse = await buildCourse({
    organizationId: orgA,
    author,
    reviewer,
    code: 'a_draft',
    title: 'Unfinished A',
    draft: true,
  });
  const courseForeign = await buildCourse({
    organizationId: orgB,
    author: foreignAuthor,
    reviewer: foreignReviewer,
    code: 'b_phys',
    title: 'Physics B',
  });

  const classA1 = await createClass(orgA, 'A1');
  const classA2 = await createClass(orgA, 'A2');
  const classB1 = await createClass(orgB, 'B1');

  await addClassMember(classA1, learner.id);
  await addClassMember(classA2, peer.id);
  await addClassMember(classB1, foreignLearner.id);
  await assignTeacher(teacher.id, classA1);

  await assignCourseToClass({ classId: classA1, courseId: courseA.courseId });
  await assignCourseToClass({ classId: classA2, courseId: courseB.courseId });
  await assignCourseToClass({ classId: classB1, courseId: courseForeign.courseId });

  return {
    orgA,
    orgB,
    author,
    reviewer,
    teacher,
    learner,
    peer,
    foreignAuthor,
    foreignLearner,
    courseA,
    courseB,
    draftCourse,
    courseForeign,
    classA1,
    classA2,
    classB1,
  };
}

type World = Awaited<ReturnType<typeof world>>;
let w: World;

beforeEach(async () => {
  await truncateAll();
  testApp = await buildTestApp();
  levelId = await createEducationLevel();
  w = await world();
});

afterAll(async () => {
  await testApp?.db.close();
  await closeSeedDb();
});

// =====================================================================
// The happy path, first. A suite of only refusals passes when
// delivery is completely broken.
// =====================================================================

describe('an authorized learner walks their own course', () => {
  it('lists only the courses assigned to their own classes', async () => {
    const body = ok<{ items: Array<{ courseId: string }> }>(
      await get('/api/v1/me/courses', w.learner.cookie),
      'me/courses',
    );
    expect(body.items.map((c) => c.courseId)).toEqual([w.courseA.courseId]);
  });

  it('reads the course, its units and its published lessons', async () => {
    expect(await status(get(`/api/v1/courses/${w.courseA.courseId}`, w.learner.cookie))).toBe(200);

    const units = ok<{ items: Array<{ id: string }> }>(
      await get(`/api/v1/courses/${w.courseA.courseId}/units`, w.learner.cookie),
      'units',
    );
    expect(units.items.map((u) => u.id)).toEqual([w.courseA.unitId]);

    const lessons = ok<{ items: Array<{ id: string }> }>(
      await get(`/api/v1/units/${w.courseA.unitId}/lessons`, w.learner.cookie),
      'lessons',
    );
    // The published one only. The draft sibling is NOT in the list, and its
    // absence is the assertion — a client that filtered would pass a test that
    // only checked the published one was present.
    expect(lessons.items.map((l) => l.id)).toEqual([w.courseA.lessonId]);
  });

  it('reads the lesson with its objectives, and its published activities', async () => {
    const lesson = ok<{ objectives: string[]; status: string }>(
      await get(`/api/v1/lessons/${w.courseA.lessonId}`, w.learner.cookie),
      'lesson',
    );
    expect(lesson.status).toBe('published');
    expect(lesson.objectives).toEqual(['Physics A objective one', 'Physics A objective two']);

    const activities = ok<{ items: Array<{ id: string; assessmentId: string | null }> }>(
      await get(`/api/v1/lessons/${w.courseA.lessonId}/activities`, w.learner.cookie),
      'activities',
    );
    expect(activities.items.map((a) => a.id)).toEqual([w.courseA.activityId]);
  });

  it('reads the assessment, attempts it, and is scored', async () => {
    const meta = ok<{ questionCount: number; maxScore: number }>(
      await get(`/api/v1/assessments/${w.courseA.assessmentId}`, w.learner.cookie),
      'assessment',
    );
    expect(meta).toMatchObject({ questionCount: 1, maxScore: 2 });

    const started = ok<{
      attempt: { id: string };
      questions: Array<{ id: string; options: Array<{ id: string; body: string }> }>;
    }>(
      await post(`/api/v1/assessments/${w.courseA.assessmentId}/attempts`, w.learner.cookie),
      'start',
    );
    const question = started.questions[0]!;
    const correct = question.options.find((o) => o.body === 'ma')!;
    const submitted = ok<{ score: number; passed: boolean }>(
      await post(`/api/v1/attempts/${started.attempt.id}/submit`, w.learner.cookie, {
        answers: [{ questionId: question.id, selectedOptionIds: [correct.id] }],
      }),
      'submit',
    );
    expect(submitted).toMatchObject({ score: 2, passed: true });
  });

  it('records progress and sees mastery move', async () => {
    expect(
      await status(
        put(`/api/v1/lessons/${w.courseA.lessonId}/progress`, w.learner.cookie, {
          status: 'completed',
        }),
      ),
    ).toBe(200);

    const mastery = ok<{
      units: Array<{ lessons: Array<{ objectives: Array<{ mastery: string }> }> }>;
    }>(await get(`/api/v1/me/courses/${w.courseA.courseId}/mastery`, w.learner.cookie), 'mastery');
    const states = mastery.units.flatMap((u) => u.lessons).flatMap((l) => l.objectives);
    expect(states).toHaveLength(2);
    for (const o of states) expect(o.mastery).not.toBe('no_evidence');
  });
});

// =====================================================================
// Payload hygiene: what a learner receives, key by key.
// =====================================================================

/**
 * Fields that must never appear anywhere in a learner-facing payload.
 *
 * A DENY-LIST IS NOT ENOUGH ON ITS OWN, which is why the exact key sets are
 * asserted below as well. This list exists because it names the specific things
 * a future change is most likely to add by accident, and because a violation
 * here is legible: "the learner payload now contains `isCorrect`" is a sentence
 * a reviewer acts on immediately.
 */
const FORBIDDEN_KEYS = [
  'createdBy',
  'authorId',
  'ownerId',
  'publisherId',
  'organizationId',
  'isCorrect',
  'correct',
  'correctOptions',
  'correctOptionIds',
  'answerKey',
  'answer',
  'explanation',
  'reviewPolicy_internal',
  'passwordHash',
  'auditId',
];

const keysDeep = (value: unknown, found: Set<string> = new Set()): Set<string> => {
  if (Array.isArray(value)) {
    for (const v of value) keysDeep(v, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      found.add(k);
      keysDeep(v, found);
    }
  }
  return found;
};

describe('what a learner payload contains', () => {
  it('the lesson response carries no authoring or ownership field', async () => {
    const response = await get(`/api/v1/lessons/${w.courseA.lessonId}`, w.learner.cookie);
    const keys = keysDeep(response.json());
    for (const forbidden of FORBIDDEN_KEYS) expect([...keys]).not.toContain(forbidden);

    // The EXACT set, so a field added later is a failing test rather than a
    // silent widening. `permissions` is the reader's own capability block from
    // Task 011 and is all-false here; it describes the reader, not the content.
    expect([...keys].sort()).toEqual(
      [
        'archive',
        'contentBody',
        'contentFormat',
        'createdAt',
        'estimatedMinutes',
        'externalUrl',
        'id',
        'objectives',
        'permissions',
        'position',
        'publish',
        'publishedAt',
        'status',
        'summary',
        'title',
        'unitId',
        'update',
        'updatedAt',
      ].sort(),
    );
  });

  it('grants a learner nothing in the capability block', async () => {
    const lesson = ok<{ permissions: Record<string, boolean> }>(
      await get(`/api/v1/lessons/${w.courseA.lessonId}`, w.learner.cookie),
      'lesson',
    );
    expect(lesson.permissions).toEqual({ update: false, publish: false, archive: false });
  });

  it('the assessment response carries no key, no scoring internals', async () => {
    const response = await get(`/api/v1/assessments/${w.courseA.assessmentId}`, w.learner.cookie);
    const keys = keysDeep(response.json());
    for (const forbidden of FORBIDDEN_KEYS) expect([...keys]).not.toContain(forbidden);
    expect(response.body).not.toContain('ma"');
  });

  it('the attempt paper carries options WITHOUT any marker of the right one', async () => {
    const started = ok<{ questions: Array<{ options: Array<Record<string, unknown>> }> }>(
      await post(`/api/v1/assessments/${w.courseA.assessmentId}/attempts`, w.learner.cookie),
      'start',
    );
    const optionKeys = keysDeep(started.questions[0]!.options);
    // Exactly three fields. Not "no isCorrect" — an exact set, because the leak
    // to fear is a NEW field, and a deny-list cannot name a field nobody has
    // invented yet.
    expect([...optionKeys].sort()).toEqual(['body', 'id', 'position']);

    // And the key really is elsewhere: it exists, and it is not in the payload.
    const keys = await rawRows<{ n: string }>(
      `SELECT count(*) AS n FROM assessment_answer_keys k
         JOIN assessment_questions q ON q.id = k.question_id
        WHERE q.assessment_id = $1`,
      [w.courseA.assessmentId],
    );
    expect(Number(keys[0]!.n)).toBeGreaterThan(0);
  });

  it('the activity response carries no ownership field', async () => {
    const response = await get(`/api/v1/activities/${w.courseA.activityId}`, w.learner.cookie);
    const keys = keysDeep(response.json());
    for (const forbidden of FORBIDDEN_KEYS) expect([...keys]).not.toContain(forbidden);
  });
});

// =====================================================================
// Draft leakage — section 4, case by case.
// =====================================================================

describe('draft content never reaches a learner', () => {
  it('a draft COURSE is neither listed nor retrievable', async () => {
    const listed = ok<{ items: Array<{ id: string }> }>(
      await get('/api/v1/courses', w.learner.cookie),
      'courses',
    );
    expect(listed.items.map((c) => c.id)).not.toContain(w.draftCourse.courseId);
    expect(await status(get(`/api/v1/courses/${w.draftCourse.courseId}`, w.learner.cookie))).toBe(
      404,
    );
  });

  it('a draft UNIT is neither listed nor retrievable', async () => {
    expect(await status(get(`/api/v1/units/${w.draftCourse.unitId}`, w.learner.cookie))).toBe(404);
    // Listing the children of a draft course is refused at the parent, so the
    // learner cannot even ask the question.
    expect(
      await status(get(`/api/v1/courses/${w.draftCourse.courseId}/units`, w.learner.cookie)),
    ).toBe(404);
  });

  it('a draft LESSON inside a PUBLISHED course is neither listed nor retrievable', async () => {
    // The sharper case: the course, unit and a sibling lesson are all live, so
    // the learner is legitimately in this part of the tree. Only this row is a
    // draft, and only RLS and the policy stand between them.
    const lessons = ok<{ items: Array<{ id: string }> }>(
      await get(`/api/v1/units/${w.courseA.unitId}/lessons`, w.learner.cookie),
      'lessons',
    );
    expect(lessons.items.map((l) => l.id)).not.toContain(w.courseA.draftLessonId);
    expect(await status(get(`/api/v1/lessons/${w.courseA.draftLessonId}`, w.learner.cookie))).toBe(
      404,
    );
  });

  it('a status filter cannot be used to ask for drafts', async () => {
    const drafts = await get('/api/v1/courses?status=draft', w.learner.cookie);
    // Either the filter is refused or it returns nothing. What must NOT happen
    // is a draft coming back because the learner named it.
    if (drafts.statusCode === 200) {
      expect(drafts.json<{ items: unknown[] }>().items).toEqual([]);
    } else {
      expect(drafts.statusCode).toBe(400);
    }
  });

  it('an UNPUBLISHED activity and its assessment are unreachable', async () => {
    const draftActivity = ok<{ id: string; assessmentId: string }>(
      await post(`/api/v1/lessons/${w.courseA.lessonId}/activities`, w.author.cookie, {
        activityType: 'assessment',
        title: 'Not yet',
        assessment: { passingPercentage: 50, maxAttempts: 1 },
      }),
      'draft activity',
    );
    expect(await status(get(`/api/v1/activities/${draftActivity.id}`, w.learner.cookie))).toBe(404);
    expect(
      await status(get(`/api/v1/assessments/${draftActivity.assessmentId}`, w.learner.cookie)),
    ).toBe(404);
    // And it cannot be attempted, which is the consequence that matters.
    expect(
      await status(
        post(`/api/v1/assessments/${draftActivity.assessmentId}/attempts`, w.learner.cookie),
      ),
    ).toBe(404);
  });

  it('a draft is indistinguishable from a lesson that does not exist', async () => {
    const draft = await get(`/api/v1/lessons/${w.courseA.draftLessonId}`, w.learner.cookie);
    const absent = await get(`/api/v1/lessons/${ABSENT}`, w.learner.cookie);
    expect(draft.statusCode).toBe(absent.statusCode);
    // Same code AND same body shape, minus the correlation id. A difference in
    // either turns the endpoint into an oracle for "this id names something".
    const strip = (b: string) => b.replace(/"correlationId":"[^"]*"/, '');
    expect(strip(draft.body)).toBe(strip(absent.body));
  });
});

// =====================================================================
// Archived content.
// =====================================================================

describe('archived content follows the existing policy, and history does not', () => {
  it('an archived lesson leaves the learner’s view', async () => {
    expect(await status(get(`/api/v1/lessons/${w.courseA.lessonId}`, w.learner.cookie))).toBe(200);
    ok(await post(`/api/v1/lessons/${w.courseA.lessonId}/archive`, w.reviewer.cookie), 'archive');
    // 404, not 403: an archived lesson is not "forbidden", it is out of the
    // learner's catalogue entirely, and the existing policy answers `hide`.
    expect(await status(get(`/api/v1/lessons/${w.courseA.lessonId}`, w.learner.cookie))).toBe(404);
  });

  it('an archived assessment cannot be started', async () => {
    ok(await post(`/api/v1/activities/${w.courseA.activityId}/archive`, w.reviewer.cookie), 'arch');
    expect(
      await status(
        post(`/api/v1/assessments/${w.courseA.assessmentId}/attempts`, w.learner.cookie),
      ),
    ).toBe(404);
  });

  it('but the learner keeps the result they already earned', async () => {
    const started = ok<{
      attempt: { id: string };
      questions: Array<{ id: string; options: Array<{ id: string; body: string }> }>;
    }>(
      await post(`/api/v1/assessments/${w.courseA.assessmentId}/attempts`, w.learner.cookie),
      'start',
    );
    const q = started.questions[0]!;
    ok(
      await post(`/api/v1/attempts/${started.attempt.id}/submit`, w.learner.cookie, {
        answers: [{ questionId: q.id, selectedOptionIds: [q.options[0]!.id] }],
      }),
      'submit',
    );

    ok(await post(`/api/v1/lessons/${w.courseA.lessonId}/archive`, w.reviewer.cookie), 'archive');

    // The material is gone from the catalogue; the child's record of having
    // done it is not. Deleting history because content was retired would be
    // the worst possible reading of "archive".
    const attempt = ok<{ attempt: { score: number } }>(
      await get(`/api/v1/attempts/${started.attempt.id}`, w.learner.cookie),
      'attempt after archive',
    );
    expect(attempt.attempt.score).toBe(2);
  });
});

// =====================================================================
// IDOR / BOLA — section 13, every mandatory case.
// =====================================================================

describe('cross-class access', () => {
  it('REFUSES a learner the course another class in the same school studies', async () => {
    // Same organization, same catalogue, fully published. The ONLY thing
    // missing is an assignment reaching this learner — so this is the test that
    // isolates the class narrowing from the organization boundary.
    expect(await status(get(`/api/v1/courses/${w.courseB.courseId}`, w.learner.cookie))).toBe(404);
    expect(await status(get(`/api/v1/units/${w.courseB.unitId}`, w.learner.cookie))).toBe(404);
    expect(await status(get(`/api/v1/lessons/${w.courseB.lessonId}`, w.learner.cookie))).toBe(404);
    expect(await status(get(`/api/v1/activities/${w.courseB.activityId}`, w.learner.cookie))).toBe(
      404,
    );
    expect(
      await status(get(`/api/v1/assessments/${w.courseB.assessmentId}`, w.learner.cookie)),
    ).toBe(404);
  });

  it('REFUSES starting an attempt on another class’s assessment', async () => {
    expect(
      await status(
        post(`/api/v1/assessments/${w.courseB.assessmentId}/attempts`, w.learner.cookie),
      ),
    ).toBe(404);
  });

  it('REFUSES reading mastery for a course the learner does not study', async () => {
    expect(
      await status(get(`/api/v1/me/courses/${w.courseB.courseId}/mastery`, w.learner.cookie)),
    ).toBe(404);
  });

  it('and the refusal is symmetric — the peer cannot reach course A either', async () => {
    expect(await status(get(`/api/v1/lessons/${w.courseA.lessonId}`, w.peer.cookie))).toBe(404);
  });
});

describe('cross-organization access', () => {
  it('REFUSES another school’s course, unit, lesson, activity and assessment', async () => {
    for (const url of [
      `/api/v1/courses/${w.courseForeign.courseId}`,
      `/api/v1/units/${w.courseForeign.unitId}`,
      `/api/v1/lessons/${w.courseForeign.lessonId}`,
      `/api/v1/activities/${w.courseForeign.activityId}`,
      `/api/v1/assessments/${w.courseForeign.assessmentId}`,
    ]) {
      expect(await status(get(url, w.learner.cookie))).toBe(404);
    }
  });

  it('REFUSES a foreign learner this school’s content', async () => {
    expect(
      await status(get(`/api/v1/lessons/${w.courseA.lessonId}`, w.foreignLearner.cookie)),
    ).toBe(404);
  });

  it('the DATABASE itself refuses a cross-organization assignment', async () => {
    // Attempted behind the API entirely, as a superuser, which is the strongest
    // form of the question: if the only thing stopping a cross-school
    // assignment were the assignment ENDPOINT, this would succeed.
    await expect(
      rawRows(
        `INSERT INTO class_course_assignments (class_id, course_id, assigned_by, status)
         VALUES ($1, $2, $3, 'active')`,
        [w.classB1, w.courseA.courseId, w.foreignLearner.id],
      ),
    ).rejects.toThrow(/own organization/i);

    // And with no assignment in place, the content stays invisible — so the two
    // controls are independent rather than one standing in for the other.
    expect(
      await status(get(`/api/v1/lessons/${w.courseA.lessonId}`, w.foreignLearner.cookie)),
    ).toBe(404);
  });

  it('and even a SAME-SCHOOL assignment forced in behind the API grants nothing across schools', async () => {
    // The content policy asked directly: a foreign learner is put into a class
    // of THEIR OWN school that has been assigned THEIR OWN school's course, so
    // the assignment machinery is entirely valid — and school A's lesson is
    // still invisible, because the organization check is a separate conjunct.
    // Already assigned during seeding — the point is that the foreign learner
    // has a perfectly valid enrolment, not that a second one is created.
    const assignments = await rawRows<{ n: string }>(
      `SELECT count(*) AS n FROM class_course_assignments
        WHERE class_id = $1 AND course_id = $2 AND status = 'active'`,
      [w.classB1, w.courseForeign.courseId],
    );
    expect(Number(assignments[0]!.n)).toBe(1);
    expect(
      await status(get(`/api/v1/lessons/${w.courseA.lessonId}`, w.foreignLearner.cookie)),
    ).toBe(404);
  });
});

describe('cross-attempt access', () => {
  const sit = async (session: Session, assessmentId: string): Promise<string> => {
    const started = ok<{
      attempt: { id: string };
      questions: Array<{ id: string; options: Array<{ id: string }> }>;
    }>(await post(`/api/v1/assessments/${assessmentId}/attempts`, session.cookie), 'start');
    const q = started.questions[0]!;
    ok(
      await post(`/api/v1/attempts/${started.attempt.id}/submit`, session.cookie, {
        answers: [{ questionId: q.id, selectedOptionIds: [q.options[0]!.id] }],
      }),
      'submit',
    );
    return started.attempt.id;
  };

  it('REFUSES learner A the attempt of learner B', async () => {
    const peerAttempt = await sit(w.peer, w.courseB.assessmentId);
    expect(await status(get(`/api/v1/attempts/${peerAttempt}`, w.learner.cookie))).toBe(404);
    expect(await status(get(`/api/v1/attempts/${peerAttempt}/review`, w.learner.cookie))).toBe(404);
  });

  it('REFUSES an attempt from another organization', async () => {
    const foreignAttempt = await sit(w.foreignLearner, w.courseForeign.assessmentId);
    expect(await status(get(`/api/v1/attempts/${foreignAttempt}`, w.learner.cookie))).toBe(404);
  });

  it('REFUSES submitting into somebody else’s attempt', async () => {
    const started = ok<{ attempt: { id: string }; questions: Array<{ id: string }> }>(
      await post(`/api/v1/assessments/${w.courseB.assessmentId}/attempts`, w.peer.cookie),
      'start',
    );
    const hijack = await post(`/api/v1/attempts/${started.attempt.id}/submit`, w.learner.cookie, {
      answers: [],
    });
    expect(hijack.statusCode).toBe(404);
    // And the peer's attempt is untouched — a refused write that still wrote
    // would pass a status-only assertion.
    const rows = await rawRows<{ status: string }>(
      'SELECT status FROM assessment_attempts WHERE id = $1',
      [started.attempt.id],
    );
    expect(rows[0]!.status).toBe('in_progress');
  });

  it('REFUSES a learner releasing their own result', async () => {
    const mine = await sit(w.learner, w.courseA.assessmentId);
    expect(await status(post(`/api/v1/attempts/${mine}/release`, w.learner.cookie))).toBe(403);
  });

  it('lists only the learner’s own attempts', async () => {
    await sit(w.peer, w.courseB.assessmentId);
    const mine = await sit(w.learner, w.courseA.assessmentId);
    const listed = ok<{ items: Array<{ id: string }> }>(
      await get('/api/v1/me/attempts', w.learner.cookie),
      'me/attempts',
    );
    expect(listed.items.map((a) => a.id)).toEqual([mine]);
  });
});

describe('cross-learner progress and mastery', () => {
  it('REFUSES reading a peer’s progress, and there is no route that takes a learner id', async () => {
    ok(
      await put(`/api/v1/lessons/${w.courseA.lessonId}/progress`, w.learner.cookie, {
        status: 'completed',
      }),
      'progress',
    );
    // `/me/progress` is the only learner-facing progress read, and "me" is the
    // session. A parameter naming somebody else is not ignored — it is refused.
    expect(await status(get(`/api/v1/me/progress?userId=${w.peer.id}`, w.learner.cookie))).toBe(
      400,
    );
    expect(
      await status(get(`/api/v1/me/objectives?learnerId=${w.peer.id}`, w.learner.cookie)),
    ).toBe(400);
  });

  it('REFUSES a learner the teacher route for their own class', async () => {
    expect(
      await status(
        get(`/api/v1/classes/${w.classA1}/students/${w.learner.id}/progress`, w.learner.cookie),
      ),
    ).toBe(404);
  });

  it('a peer’s mastery is unreachable even naming the right class and course', async () => {
    expect(
      await status(
        get(
          `/api/v1/classes/${w.classA2}/students/${w.peer.id}/courses/${w.courseB.courseId}/mastery`,
          w.learner.cookie,
        ),
      ),
    ).toBe(404);
  });
});

// =====================================================================
// Forged identity — the client never says who it is.
// =====================================================================

describe('forged identity and ownership fields', () => {
  it('a forged learner id on progress is refused, not ignored — one field at a time', async () => {
    // ONE FIELD PER REQUEST, deliberately. An earlier version of this test sent
    // `userId` and `learnerId` together and asserted a single 400 — which a
    // schema that accepted `learnerId` still satisfied, because `userId` was
    // refusing on its own. A bundled assertion cannot say WHICH field was
    // rejected, and the one that quietly became acceptable is exactly the one
    // an attacker would find. Verified by injection: adding `learnerId` to the
    // schema passes the bundled test and fails this one.
    for (const forged of [
      { userId: w.peer.id },
      { learnerId: w.peer.id },
      { studentId: w.peer.id },
      { organizationId: w.orgB },
      { classId: w.classA2 },
      { lessonId: w.courseB.lessonId },
      { completedAt: '2020-01-01T00:00:00.000Z' },
    ]) {
      const response = await put(
        `/api/v1/lessons/${w.courseA.lessonId}/progress`,
        w.learner.cookie,
        { status: 'completed', ...forged },
      );
      expect({ field: Object.keys(forged)[0], code: response.statusCode }).toEqual({
        field: Object.keys(forged)[0],
        code: 400,
      });
    }

    // And nothing was written by any of them: a 400 that had already written
    // would be worse than a 200.
    const rows = await rawRows<{ n: string }>('SELECT count(*) AS n FROM lesson_progress');
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('a forged owner on attempt creation is refused', async () => {
    for (const body of [
      { userId: w.peer.id },
      { learnerId: w.peer.id },
      { organizationId: w.orgB },
      { classId: w.classA2 },
      { attemptNumber: 99 },
      { score: 100 },
      { passed: true },
      { released: true },
    ]) {
      expect(
        await status(
          post(`/api/v1/assessments/${w.courseA.assessmentId}/attempts`, w.learner.cookie, body),
        ),
      ).toBe(400);
    }
  });

  it('a forged mark on submission is refused', async () => {
    const started = ok<{ attempt: { id: string }; questions: Array<{ id: string }> }>(
      await post(`/api/v1/assessments/${w.courseA.assessmentId}/attempts`, w.learner.cookie),
      'start',
    );
    for (const body of [
      { answers: [], score: 100 },
      { answers: [], passed: true },
      { answers: [], userId: w.peer.id },
      { answers: [], released: true },
    ]) {
      expect(
        await status(post(`/api/v1/attempts/${started.attempt.id}/submit`, w.learner.cookie, body)),
      ).toBe(400);
    }
  });

  it('a learner cannot write mastery or evidence at all — there is no endpoint', async () => {
    for (const url of [
      '/api/v1/me/objectives',
      `/api/v1/me/courses/${w.courseA.courseId}/mastery`,
    ]) {
      // 404 for an unrouted method, never 200. Mastery is derived from
      // evidence; there is deliberately no way to assert it.
      const response = await post(url, w.learner.cookie, { mastery: 'mastered' });
      expect(response.statusCode).toBe(404);
    }
  });

  it('a learner cannot write objective evidence directly', async () => {
    const objective = (
      await rawRows<{ id: string }>(
        'SELECT id FROM learning_objectives WHERE lesson_id = $1 LIMIT 1',
        [w.courseA.lessonId],
      )
    )[0]!.id;
    expect(
      await status(
        post(`/api/v1/me/objectives/${objective}/evidence`, w.learner.cookie, {
          evidenceType: 'assessment_passed',
        }),
      ),
    ).toBe(404);
  });
});

// =====================================================================
// A learner may not author. Section 7, over HTTP.
// =====================================================================

describe('a learner cannot author anything', () => {
  it('REFUSES editing, publishing, archiving or deleting a lesson they can read', async () => {
    expect(
      await status(
        patch(`/api/v1/lessons/${w.courseA.lessonId}`, w.learner.cookie, { title: 'X' }),
      ),
    ).toBe(404);
    expect(
      await status(post(`/api/v1/lessons/${w.courseA.lessonId}/publish`, w.learner.cookie)),
    ).toBe(404);
    expect(
      await status(post(`/api/v1/lessons/${w.courseA.lessonId}/archive`, w.learner.cookie)),
    ).toBe(404);
    expect(
      await status(
        testApp.app.inject({
          method: 'DELETE',
          url: `/api/v1/lessons/${w.courseA.lessonId}`,
          headers: { ...bodylessWriteHeaders, cookie: w.learner.cookie },
        }),
      ),
    ).toBe(404);
  });

  it('REFUSES creating an activity, or moving one to another lesson', async () => {
    expect(
      await status(
        post(`/api/v1/lessons/${w.courseA.lessonId}/activities`, w.learner.cookie, {
          activityType: 'assessment',
          title: 'Mine',
          assessment: {},
        }),
      ),
    ).toBe(404);
    expect(
      await status(post(`/api/v1/activities/${w.courseA.activityId}/publish`, w.learner.cookie)),
    ).toBe(404);
    expect(
      await status(post(`/api/v1/activities/${w.courseA.activityId}/archive`, w.learner.cookie)),
    ).toBe(404);
  });

  it('REFUSES adding a question to an assessment they are sitting', async () => {
    expect(
      await status(
        post(`/api/v1/assessments/${w.courseA.assessmentId}/questions`, w.learner.cookie, {
          questionType: 'single_choice',
          prompt: 'Mine',
          options: ['A', 'B'],
          correctOptions: [0],
        }),
      ),
    ).toBe(404);
  });

  it('REFUSES creating content, in their own school or the global catalogue', async () => {
    // A well-formed body, so it is AUTHORIZATION that refuses rather than the
    // schema — a 400 here would prove nothing about who may author.
    expect(
      await status(post('/api/v1/curricula', w.learner.cookie, { code: 'mine', name: 'Mine' })),
    ).toBe(404);
    expect(
      await status(
        post('/api/v1/curricula', w.learner.cookie, { code: 'global', name: 'G', global: true }),
      ),
    ).toBe(404);
  });
});

// =====================================================================
// Query and body hygiene on learner endpoints.
// =====================================================================

describe('learner endpoints accept only what they intend to', () => {
  it('rejects an unknown query parameter rather than ignoring it', async () => {
    for (const url of [
      '/api/v1/me/courses?organizationId=' + w.orgB,
      '/api/v1/me/attempts?userId=' + w.peer.id,
      `/api/v1/units/${w.courseA.unitId}/lessons?includeDrafts=true`,
      `/api/v1/courses/${w.courseA.courseId}/units?status=draft&scope=all&secret=1`,
    ]) {
      expect(await status(get(url, w.learner.cookie))).toBe(400);
    }
  });

  it('rejects a sort field that is not on the allow-list', async () => {
    expect(
      await status(
        get(
          `/api/v1/units/${w.courseA.unitId}/lessons?sort=title;DROP TABLE users`,
          w.learner.cookie,
        ),
      ),
    ).toBe(400);
  });

  it('rejects a malformed identifier without saying whether it would have existed', async () => {
    expect(await status(get('/api/v1/lessons/not-a-uuid', w.learner.cookie))).toBe(400);
  });

  it('requires a session on every learner route', async () => {
    for (const url of [
      '/api/v1/me/courses',
      '/api/v1/me/attempts',
      '/api/v1/me/progress',
      '/api/v1/me/objectives',
      `/api/v1/courses/${w.courseA.courseId}`,
      `/api/v1/lessons/${w.courseA.lessonId}`,
      `/api/v1/activities/${w.courseA.activityId}`,
      `/api/v1/assessments/${w.courseA.assessmentId}`,
      `/api/v1/me/courses/${w.courseA.courseId}/mastery`,
    ]) {
      expect(await status(testApp.app.inject({ method: 'GET', url }))).toBe(401);
    }
  });
});
