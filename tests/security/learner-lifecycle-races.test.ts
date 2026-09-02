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
  truncateAll,
} from '../setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';

/**
 * What happens to a learner when the ground moves under them.
 *
 * FOUR RACES, and the requirement on all four is the same: the outcome must be
 * DETERMINISTIC and there must be no half-written state. A learner whose course
 * is withdrawn mid-session should get a clean refusal, not a partially started
 * attempt; a lesson archived while they read it should disappear from the
 * catalogue without taking their progress with it.
 *
 * WHY THIS IS NOT PARANOIA. Every one of these happens in an ordinary school
 * week: a teacher withdraws a course at 09:00 while thirty learners have the
 * page open; a reviewer archives last term's material while somebody is
 * mid-quiz. The interesting question is never "does it error" — it is "what did
 * it leave behind".
 *
 * THE INVARIANT, stated once. Revocation removes ACCESS. It never removes
 * HISTORY. A learner who loses access to a course keeps every attempt, result,
 * evidence row and progress record they earned while they had it, and those
 * remain readable by the roles the existing policy says may read them.
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

const put = (url: string, cookie: string, payload: Record<string, unknown>) =>
  testApp.app.inject({ method: 'PUT', url, headers: { ...writeHeaders, cookie }, payload });

const del = (url: string, cookie: string) =>
  testApp.app.inject({ method: 'DELETE', url, headers: { ...bodylessWriteHeaders, cookie } });

/** A 204 has no body, so `ok` (which parses JSON) cannot be used on it. */
const withdrew = async (url: string, cookie: string): Promise<void> => {
  const response = await del(url, cookie);
  if (response.statusCode !== 204) {
    throw new Error(`withdraw failed: ${response.statusCode} ${response.body}`);
  }
};

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

/**
 * Everything the learner has produced, as stored.
 *
 * Read as superuser on purpose: the question is what the DATABASE holds, not
 * what an endpoint chooses to show. An assertion built only from API output
 * would pass if a row were deleted and the endpoint changed to match.
 */
async function history(userId: string): Promise<Record<string, unknown>> {
  const [attempts, answers, evidence, progress] = await Promise.all([
    rawRows(
      `SELECT id, assessment_id, status, score, max_score, percentage, passed,
              started_at, submitted_at, released_at
         FROM assessment_attempts WHERE user_id = $1 ORDER BY started_at, id`,
      [userId],
    ),
    rawRows(
      `SELECT a.attempt_id, a.question_id, a.option_id
         FROM assessment_attempt_answers a
         JOIN assessment_attempts t ON t.id = a.attempt_id
        WHERE t.user_id = $1 ORDER BY a.attempt_id, a.question_id, a.option_id`,
      [userId],
    ),
    rawRows(
      `SELECT objective_id, evidence_type, source_kind, source_id, occurred_at
         FROM objective_evidence WHERE user_id = $1
        ORDER BY objective_id, source_kind, source_id`,
      [userId],
    ),
    rawRows(
      `SELECT lesson_id, status, completed_at FROM lesson_progress
        WHERE user_id = $1 ORDER BY lesson_id`,
      [userId],
    ),
  ]);
  return { attempts, answers, evidence, progress };
}

let levelId: string;

async function world() {
  const organizationId = await createOrganization('School A');

  const author = await seedAndLogin({
    email: 'author@t.local',
    roles: ['content_author'],
    organizationId,
  });
  const reviewer = await seedAndLogin({
    email: 'reviewer@t.local',
    roles: ['reviewer'],
    organizationId,
  });
  const admin = await seedAndLogin({ email: 'admin@t.local', roles: ['admin'], organizationId });
  const learner = await seedAndLogin({ email: 'learner@t.local', organizationId });

  const curriculumId = ok<{ id: string }>(
    await post('/api/v1/curricula', author.cookie, { code: 'sci', name: 'Science' }),
    'curriculum',
  ).id;
  const courseId = ok<{ id: string }>(
    await post('/api/v1/courses', author.cookie, { curriculumId, levelId, title: 'Physics' }),
    'course',
  ).id;
  const unitId = ok<{ id: string }>(
    await post(`/api/v1/courses/${courseId}/units`, author.cookie, { title: 'Mechanics' }),
    'unit',
  ).id;
  const lessonId = ok<{ id: string }>(
    await post(`/api/v1/units/${unitId}/lessons`, author.cookie, {
      title: 'Newton',
      contentBody: 'A body remains at rest…',
      objectives: ['Explain the second law'],
    }),
    'lesson',
  ).id;
  const activity = ok<{ id: string; assessmentId: string }>(
    await post(`/api/v1/lessons/${lessonId}/activities`, author.cookie, {
      activityType: 'assessment',
      title: 'Forces quiz',
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

  for (const url of [
    `/api/v1/curricula/${curriculumId}/publish`,
    `/api/v1/courses/${courseId}/publish`,
    `/api/v1/units/${unitId}/publish`,
    `/api/v1/lessons/${lessonId}/publish`,
    `/api/v1/activities/${activity.id}/publish`,
  ]) {
    ok(await post(url, reviewer.cookie), url);
  }

  const classId = await createClass(organizationId, 'A1');
  await addClassMember(classId, learner.id);
  await assignCourseToClass({ classId, courseId });

  return {
    organizationId,
    author,
    reviewer,
    admin,
    learner,
    curriculumId,
    courseId,
    unitId,
    lessonId,
    classId,
    activityId: activity.id,
    assessmentId: activity.assessmentId,
  };
}

type World = Awaited<ReturnType<typeof world>>;
let w: World;

/** Starts an attempt and returns it with its paper. */
const start = async () =>
  ok<{
    attempt: { id: string };
    questions: Array<{ id: string; options: Array<{ id: string; body: string }> }>;
  }>(await post(`/api/v1/assessments/${w.assessmentId}/attempts`, w.learner.cookie), 'start');

const sitAndSubmit = async (): Promise<string> => {
  const started = await start();
  const q = started.questions[0]!;
  const correct = q.options.find((o) => o.body === 'ma')!;
  ok(
    await post(`/api/v1/attempts/${started.attempt.id}/submit`, w.learner.cookie, {
      answers: [{ questionId: q.id, selectedOptionIds: [correct.id] }],
    }),
    'submit',
  );
  return started.attempt.id;
};

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
// Race 1 — the lesson is archived while the learner is reading it.
// =====================================================================

describe('a lesson archived while the learner has it open', () => {
  it('disappears from the catalogue on the next request, deterministically', async () => {
    expect(await status(get(`/api/v1/lessons/${w.lessonId}`, w.learner.cookie))).toBe(200);
    ok(await post(`/api/v1/lessons/${w.lessonId}/archive`, w.reviewer.cookie), 'archive');

    // Not 403, and not a stale 200 from a cache — 404, because the existing
    // policy answers `hide` for content outside the learner's catalogue and
    // there is no cache between them and the row.
    expect(await status(get(`/api/v1/lessons/${w.lessonId}`, w.learner.cookie))).toBe(404);
    const lessons = ok<{ items: unknown[] }>(
      await get(`/api/v1/units/${w.unitId}/lessons`, w.learner.cookie),
      'lessons',
    );
    expect(lessons.items).toEqual([]);
  });

  it('takes nothing the learner had already earned with it', async () => {
    await sitAndSubmit();
    ok(
      await put(`/api/v1/lessons/${w.lessonId}/progress`, w.learner.cookie, {
        status: 'completed',
      }),
      'progress',
    );
    const before = await history(w.learner.id);

    ok(await post(`/api/v1/lessons/${w.lessonId}/archive`, w.reviewer.cookie), 'archive');

    expect(await history(w.learner.id)).toEqual(before);
  });

  it('refuses NEW progress against archived content, without disturbing the old', async () => {
    ok(
      await put(`/api/v1/lessons/${w.lessonId}/progress`, w.learner.cookie, {
        status: 'in_progress',
      }),
      'progress',
    );
    const before = await history(w.learner.id);

    ok(await post(`/api/v1/lessons/${w.lessonId}/archive`, w.reviewer.cookie), 'archive');

    // A write needs current access; the row already written does not.
    expect(
      await status(
        put(`/api/v1/lessons/${w.lessonId}/progress`, w.learner.cookie, { status: 'completed' }),
      ),
    ).toBe(404);
    expect(await history(w.learner.id)).toEqual(before);
  });
});

// =====================================================================
// Race 2 — the course assignment is withdrawn mid-session.
// =====================================================================

describe('a course withdrawn while the learner is studying it', () => {
  it('revokes reading immediately and completely', async () => {
    expect(await status(get(`/api/v1/lessons/${w.lessonId}`, w.learner.cookie))).toBe(200);

    await withdrew(`/api/v1/classes/${w.classId}/courses/${w.courseId}`, w.admin.cookie);

    for (const url of [
      `/api/v1/courses/${w.courseId}`,
      `/api/v1/units/${w.unitId}`,
      `/api/v1/lessons/${w.lessonId}`,
      `/api/v1/activities/${w.activityId}`,
      `/api/v1/assessments/${w.assessmentId}`,
      `/api/v1/me/courses/${w.courseId}/mastery`,
    ]) {
      expect(await status(get(url, w.learner.cookie))).toBe(404);
    }
    const mine = ok<{ items: unknown[] }>(
      await get('/api/v1/me/courses', w.learner.cookie),
      'me/courses',
    );
    expect(mine.items).toEqual([]);
  });

  it('leaves the completed attempt and its result readable by the learner', async () => {
    const attemptId = await sitAndSubmit();
    const before = await history(w.learner.id);

    await withdrew(`/api/v1/classes/${w.classId}/courses/${w.courseId}`, w.admin.cookie);

    expect(await history(w.learner.id)).toEqual(before);
    // The record of what they did survives losing access to the material —
    // otherwise withdrawing a course would erase a term's marks.
    const attempt = ok<{ attempt: { score: number } }>(
      await get(`/api/v1/attempts/${attemptId}`, w.learner.cookie),
      'attempt',
    );
    expect(attempt.attempt.score).toBe(2);
    expect(
      ok<{ items: unknown[] }>(await get('/api/v1/me/attempts', w.learner.cookie), 'attempts')
        .items,
    ).toHaveLength(1);
  });

  it('refuses a NEW attempt after withdrawal, and writes nothing', async () => {
    const before = await history(w.learner.id);
    await withdrew(`/api/v1/classes/${w.classId}/courses/${w.courseId}`, w.admin.cookie);

    expect(
      await status(post(`/api/v1/assessments/${w.assessmentId}/attempts`, w.learner.cookie)),
    ).toBe(404);
    // THE ASSERTION THAT MATTERS. A refusal that had already inserted the
    // attempt row would consume one of the learner's limited attempts on a
    // request that returned 404.
    expect(await history(w.learner.id)).toEqual(before);
  });
});

// =====================================================================
// Race 3 — the assessment is archived as the attempt begins.
// =====================================================================

describe('an assessment archived around an attempt', () => {
  it('cannot be started once archived, and no partial attempt is left behind', async () => {
    const before = await history(w.learner.id);
    ok(await post(`/api/v1/activities/${w.activityId}/archive`, w.reviewer.cookie), 'archive');

    expect(
      await status(post(`/api/v1/assessments/${w.assessmentId}/attempts`, w.learner.cookie)),
    ).toBe(404);
    expect(await history(w.learner.id)).toEqual(before);
  });

  it('an attempt already IN PROGRESS when the content is archived cannot be submitted', async () => {
    const started = await start();
    const q = started.questions[0]!;

    ok(await post(`/api/v1/activities/${w.activityId}/archive`, w.reviewer.cookie), 'archive');

    const submitted = await post(
      `/api/v1/attempts/${started.attempt.id}/submit`,
      w.learner.cookie,
      { answers: [{ questionId: q.id, selectedOptionIds: [q.options[0]!.id] }] },
    );
    // Writing requires current access, consistently with progress. The stranded
    // attempt is a known, documented consequence (RISK-ASSESS-04) rather than a
    // surprise — what matters here is that the outcome is deterministic and the
    // row is not half-scored.
    expect(submitted.statusCode).toBe(404);

    const rows = await rawRows<{ status: string; score: number | null; submitted_at: Date | null }>(
      'SELECT status, score, submitted_at FROM assessment_attempts WHERE id = $1',
      [started.attempt.id],
    );
    expect(rows[0]).toMatchObject({ status: 'in_progress', score: null, submitted_at: null });
    // No answers were recorded either — the submission was refused whole.
    const answers = await rawRows<{ n: string }>(
      'SELECT count(*) AS n FROM assessment_attempt_answers WHERE attempt_id = $1',
      [started.attempt.id],
    );
    expect(Number(answers[0]!.n)).toBe(0);
  });

  it('a result submitted BEFORE the archive keeps its mark exactly', async () => {
    const attemptId = await sitAndSubmit();
    const before = await rawRows<{ score: number; percentage: string; passed: boolean }>(
      'SELECT score, percentage, passed FROM assessment_attempts WHERE id = $1',
      [attemptId],
    );

    ok(await post(`/api/v1/activities/${w.activityId}/archive`, w.reviewer.cookie), 'archive');

    const after = await rawRows<{ score: number; percentage: string; passed: boolean }>(
      'SELECT score, percentage, passed FROM assessment_attempts WHERE id = $1',
      [attemptId],
    );
    // No automatic rescoring, ever. Archiving is a catalogue decision, not a
    // re-marking event.
    expect(after).toEqual(before);
  });
});

// =====================================================================
// Race 4 — membership is revoked while an attempt is live.
// =====================================================================

describe('class membership ended around an attempt', () => {
  it('revokes content access and refuses a new attempt, writing nothing', async () => {
    const before = await history(w.learner.id);
    await rawRows(
      `UPDATE class_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1`,
      [w.learner.id],
    );

    expect(await status(get(`/api/v1/lessons/${w.lessonId}`, w.learner.cookie))).toBe(404);
    expect(
      await status(post(`/api/v1/assessments/${w.assessmentId}/attempts`, w.learner.cookie)),
    ).toBe(404);
    expect(await history(w.learner.id)).toEqual(before);
  });

  it('leaves the learner’s objectives and evidence readable, because those are theirs', async () => {
    await sitAndSubmit();
    const before = await history(w.learner.id);

    await rawRows(
      `UPDATE class_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1`,
      [w.learner.id],
    );

    expect(await history(w.learner.id)).toEqual(before);
    // Evidence is about the LEARNER, not about the class, so it outlives the
    // enrolment — the same conclusion Task 010 reached and this re-proves at
    // the delivery layer.
    const objectives = ok<{ items: unknown[] }>(
      await get('/api/v1/me/objectives', w.learner.cookie),
      'objectives',
    );
    expect(objectives.items).toHaveLength(1);
  });
});

// =====================================================================
// The whole chain, once, with authorization checked at every boundary.
// =====================================================================

describe('the delivery chain end to end', () => {
  it('carries a learner from course to mastery, refusing at every wrong turn', async () => {
    const stranger = await seedAndLogin({
      email: 'stranger@t.local',
      organizationId: w.organizationId,
    });

    // Course → Unit → Lesson → Objective, each authorized, each refused for a
    // learner of the same school with no assignment.
    const course = ok<{ id: string }>(
      await get(`/api/v1/courses/${w.courseId}`, w.learner.cookie),
      'course',
    );
    expect(course.id).toBe(w.courseId);
    expect(await status(get(`/api/v1/courses/${w.courseId}`, stranger.cookie))).toBe(404);

    const lesson = ok<{ objectives: string[] }>(
      await get(`/api/v1/lessons/${w.lessonId}`, w.learner.cookie),
      'lesson',
    );
    expect(lesson.objectives).toEqual(['Explain the second law']);
    expect(await status(get(`/api/v1/lessons/${w.lessonId}`, stranger.cookie))).toBe(404);

    // Activity → Assessment
    const activities = ok<{ items: Array<{ id: string }> }>(
      await get(`/api/v1/lessons/${w.lessonId}/activities`, w.learner.cookie),
      'activities',
    );
    expect(activities.items.map((a) => a.id)).toEqual([w.activityId]);
    expect(await status(get(`/api/v1/activities/${w.activityId}`, stranger.cookie))).toBe(404);

    // Attempt → Result
    const attemptId = await sitAndSubmit();
    expect(await status(get(`/api/v1/attempts/${attemptId}`, stranger.cookie))).toBe(404);

    // Progress
    ok(
      await put(`/api/v1/lessons/${w.lessonId}/progress`, w.learner.cookie, {
        status: 'completed',
      }),
      'progress',
    );

    // Evidence → Mastery
    const objectiveId = (
      await rawRows<{ id: string }>('SELECT id FROM learning_objectives WHERE lesson_id = $1', [
        w.lessonId,
      ])
    )[0]!.id;
    const evidence = ok<{ items: Array<{ evidenceType: string }> }>(
      await get(`/api/v1/me/objectives/${objectiveId}/evidence`, w.learner.cookie),
      'evidence',
    );
    expect(evidence.items.map((e) => e.evidenceType).sort()).toEqual([
      'assessment_passed',
      'lesson_completed',
    ]);
    // A STRANGER'S EVIDENCE VIEW IS EMPTY, NOT REFUSED — and that is correct,
    // because the endpoint answers "what evidence do *I* have for this
    // objective", and the honest answer for somebody who has none is "none".
    //
    // What would be wrong is if it answered DIFFERENTLY for an objective that
    // exists than for one that does not, because that turns the route into an
    // oracle for "this id names a real objective". Both are asserted here, and
    // the assertion is that they are indistinguishable.
    const strangerReal = await get(
      `/api/v1/me/objectives/${objectiveId}/evidence`,
      stranger.cookie,
    );
    const strangerAbsent = await get(
      '/api/v1/me/objectives/00000000-0000-4000-8000-000000000000/evidence',
      stranger.cookie,
    );
    expect(strangerReal.statusCode).toBe(strangerAbsent.statusCode);
    expect(strangerReal.json()).toEqual(strangerAbsent.json());
    expect(strangerReal.json<{ items: unknown[] }>().items).toEqual([]);

    const mastery = ok<{
      units: Array<{ lessons: Array<{ objectives: Array<{ mastery: string }> }> }>;
    }>(await get(`/api/v1/me/courses/${w.courseId}/mastery`, w.learner.cookie), 'mastery');
    const states = mastery.units.flatMap((u) => u.lessons).flatMap((l) => l.objectives);
    expect(states).toHaveLength(1);
    expect(states[0]!.mastery).not.toBe('no_evidence');
    expect(await status(get(`/api/v1/me/courses/${w.courseId}/mastery`, stranger.cookie))).toBe(
      404,
    );
  });
});
