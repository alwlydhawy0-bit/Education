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
 * The whole chain, built through the API, then disturbed on purpose.
 *
 *   Course → Unit → Lesson → Objective → Activity → Assessment → Question
 *          → Publish → Learner visibility → Attempt → Result → Evidence → Mastery
 *
 * WHY IT IS ONE TEST FILE AND NOT THIRTEEN. Every link in that chain has its own
 * suite already. What none of them can see is the failure this file exists for:
 * an authoring change that is locally correct at every step and still breaks the
 * MEANING of a learner's record — an objective reworded after it was measured, an
 * attempt silently re-pointed at different content, a mastery level that moves
 * because somebody edited a lesson months later. Those only show up end to end.
 *
 * THE INVARIANT, stated once. After ANY lifecycle move on the content — edit,
 * publish, republish, archive, cascade — every row a learner produced must be
 * bit-for-bit what it was: the same attempt, the same score, the same released
 * result, the same evidence rows pointing at the same objective ids, the same
 * mastery. The content may change around a learner's history. The history may
 * not change under the learner.
 *
 * Snapshots are read as SUPERUSER, deliberately: the point is what is stored,
 * not what an API happens to show, and an assertion that only compared API
 * output would pass if a row were rewritten and the endpoint rewritten with it.
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

const patch = (url: string, cookie: string, payload: Record<string, unknown>) =>
  testApp.app.inject({ method: 'PATCH', url, headers: { ...writeHeaders, cookie }, payload });

const put = (url: string, cookie: string, payload: Record<string, unknown>) =>
  testApp.app.inject({ method: 'PUT', url, headers: { ...writeHeaders, cookie }, payload });

const ok = <T>(r: { statusCode: number; body: string; json: <U>() => U }, what: string): T => {
  if (r.statusCode >= 300) throw new Error(`${what} failed: ${r.statusCode} ${r.body}`);
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
 * Everything a learner has produced, as stored.
 *
 * Ordered and complete rather than sampled: a snapshot that looked at one
 * column would miss a rewrite of the next one along.
 */
async function learnerHistory(userId: string): Promise<Record<string, unknown>> {
  const [attempts, answers, evidence, progress] = await Promise.all([
    rawRows(
      `SELECT id, assessment_id, status, score, max_score, percentage, passed,
              started_at, submitted_at, released_at
         FROM assessment_attempts WHERE user_id = $1 ORDER BY started_at, id`,
      [userId],
    ),
    rawRows(
      // The learner's actual selections. Answers are write-once and carry no
      // mark of their own — the score lives on the attempt — so what must hold
      // here is that the SAME options are still recorded against the same
      // questions after the content moves.
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

interface Built {
  readonly curriculumId: string;
  readonly courseId: string;
  readonly unitId: string;
  readonly lessonId: string;
  readonly objectiveIds: readonly string[];
  readonly activityId: string;
  readonly assessmentId: string;
}

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
  const teacher = await seedAndLogin({
    email: 'teacher@t.local',
    roles: ['teacher'],
    organizationId,
  });
  const learner = await seedAndLogin({ email: 'learner@t.local', organizationId });

  return { organizationId, author, reviewer, teacher, learner };
}

type World = Awaited<ReturnType<typeof world>>;
let w: World;

/**
 * Authors the chain down to a published question, exactly as an author would.
 *
 * Nothing here is seeded behind the API's back: if any rule in the lifecycle
 * refused a step, this throws, and the whole file fails rather than testing a
 * state the product cannot reach.
 */
async function buildAndPublish(): Promise<Built> {
  const { id: curriculumId } = ok<{ id: string }>(
    await post('/api/v1/curricula', w.author.cookie, { code: 'sci', name: 'Science' }),
    'curriculum',
  );
  const { id: courseId } = ok<{ id: string }>(
    await post('/api/v1/courses', w.author.cookie, { curriculumId, levelId, title: 'Physics' }),
    'course',
  );
  const { id: unitId } = ok<{ id: string }>(
    await post(`/api/v1/courses/${courseId}/units`, w.author.cookie, { title: 'Mechanics' }),
    'unit',
  );
  const { id: lessonId } = ok<{ id: string }>(
    await post(`/api/v1/units/${unitId}/lessons`, w.author.cookie, {
      title: "Newton's Laws",
      contentBody: 'A body remains at rest…',
      objectives: ['Explain the second law', 'Apply F=ma to a trolley'],
    }),
    'lesson',
  );

  const activity = ok<{ id: string; assessmentId: string }>(
    await post(`/api/v1/lessons/${lessonId}/activities`, w.author.cookie, {
      activityType: 'assessment',
      title: 'Forces quiz',
      assessment: { passingPercentage: 50, maxAttempts: 3 },
    }),
    'activity',
  );
  ok(
    await post(`/api/v1/assessments/${activity.assessmentId}/questions`, w.author.cookie, {
      questionType: 'single_choice',
      prompt: 'What is F?',
      options: ['ma', 'mv'],
      correctOptions: [0],
      points: 2,
    }),
    'question',
  );

  // Top down: 0022 refuses to publish beneath a draft parent, so the order is
  // not a preference — the reverse order fails.
  for (const url of [
    `/api/v1/curricula/${curriculumId}/publish`,
    `/api/v1/courses/${courseId}/publish`,
    `/api/v1/units/${unitId}/publish`,
    `/api/v1/lessons/${lessonId}/publish`,
    `/api/v1/activities/${activity.id}/publish`,
  ]) {
    ok(await post(url, w.reviewer.cookie), url);
  }

  const objectiveIds = (
    await rawRows<{ id: string }>(
      'SELECT id FROM learning_objectives WHERE lesson_id = $1 ORDER BY position',
      [lessonId],
    )
  ).map((r) => r.id);

  return {
    curriculumId,
    courseId,
    unitId,
    lessonId,
    objectiveIds,
    activityId: activity.id,
    assessmentId: activity.assessmentId,
  };
}

/** Enrols the learner so published content actually reaches them. */
async function enrol(built: Built): Promise<string> {
  const classId = await createClass(w.organizationId, 'A1');
  await addClassMember(classId, w.learner.id);
  await assignCourseToClass({ classId, courseId: built.courseId });
  return classId;
}

/** The learner sits the quiz and answers correctly. */
async function sit(built: Built): Promise<{ attemptId: string; score: number }> {
  const started = ok<{
    attempt: { id: string };
    questions: Array<{ id: string; options: Array<{ id: string; body: string }> }>;
  }>(await post(`/api/v1/assessments/${built.assessmentId}/attempts`, w.learner.cookie), 'start');

  const question = started.questions[0];
  if (!question) throw new Error('no questions handed out');
  const correct = question.options.find((o) => o.body === 'ma');
  if (!correct) throw new Error('correct option missing');

  const submitted = ok<{ score: number }>(
    await post(`/api/v1/attempts/${started.attempt.id}/submit`, w.learner.cookie, {
      answers: [{ questionId: question.id, selectedOptionIds: [correct.id] }],
    }),
    'submit',
  );
  return { attemptId: started.attempt.id, score: submitted.score };
}

let built: Built;

beforeEach(async () => {
  await truncateAll();
  testApp = await buildTestApp();
  levelId = await createEducationLevel();
  w = await world();
  built = await buildAndPublish();
});

afterAll(async () => {
  await testApp?.db.close();
  await closeSeedDb();
});

// =====================================================================
// The chain itself.
// =====================================================================

describe('the full chain, authored through the API', () => {
  it('runs from a course to a mastery level without a single seeded shortcut', async () => {
    await enrol(built);

    // --- Publish → learner visibility ---------------------------------
    const lesson = ok<{ status: string; objectives: string[] }>(
      await get(`/api/v1/lessons/${built.lessonId}`, w.learner.cookie),
      'learner reads lesson',
    );
    expect(lesson.status).toBe('published');
    expect(lesson.objectives).toEqual(['Explain the second law', 'Apply F=ma to a trolley']);

    // --- Attempt → result ---------------------------------------------
    const { attemptId, score } = await sit(built);
    expect(score).toBe(2);

    const result = ok<{ attempt: { score: number; passed: boolean } }>(
      await get(`/api/v1/attempts/${attemptId}`, w.learner.cookie),
      'read attempt',
    );
    expect(result.attempt).toMatchObject({ score: 2, passed: true });

    // --- Evidence -------------------------------------------------------
    const evidence = ok<{ items: Array<{ objectiveId: string; evidenceType: string }> }>(
      await get(`/api/v1/me/objectives/${built.objectiveIds[0]}/evidence`, w.learner.cookie),
      'evidence',
    );
    expect(evidence.items.map((e) => e.evidenceType)).toContain('assessment_passed');

    // --- Mastery ---------------------------------------------------------
    const mastery = ok<{
      units: Array<{ lessons: Array<{ objectives: Array<{ mastery: string }> }> }>;
    }>(
      await get(`/api/v1/me/courses/${built.courseId}/mastery`, w.learner.cookie),
      'course mastery',
    );
    const states = mastery.units
      .flatMap((u) => u.lessons)
      .flatMap((l) => l.objectives)
      .map((o) => o.mastery);
    expect(states).toHaveLength(2);
    // A single passed assessment is evidence, not proof of mastery — the
    // levels are earned from counted evidence, never assigned by a client.
    for (const state of states) expect(state).not.toBe('no_evidence');
  });

  it('a draft lesson in a published course stays invisible to the learner', async () => {
    await enrol(built);
    const { id: draftLessonId } = ok<{ id: string }>(
      await post(`/api/v1/units/${built.unitId}/lessons`, w.author.cookie, { title: 'Next' }),
      'draft lesson',
    );
    // The course, unit and sibling lesson are all live. This one is not, and
    // publication of the parent did NOT drag it out.
    expect((await get(`/api/v1/lessons/${draftLessonId}`, w.learner.cookie)).statusCode).toBe(404);
  });
});

// =====================================================================
// Historical safety: the content moves, the record does not.
// =====================================================================

describe('historical safety across lifecycle moves', () => {
  let before: Record<string, unknown>;
  let attemptId: string;

  beforeEach(async () => {
    await enrol(built);
    ({ attemptId } = await sit(built));
    // A completed lesson too, so both evidence sources are represented.
    ok(
      await put(`/api/v1/lessons/${built.lessonId}/progress`, w.learner.cookie, {
        status: 'completed',
      }),
      'complete lesson',
    );
    before = await learnerHistory(w.learner.id);
  });

  const expectUnchanged = async (): Promise<void> => {
    expect(await learnerHistory(w.learner.id)).toEqual(before);
  };

  it('editing the published lesson’s title and body changes nothing a learner earned', async () => {
    ok(
      await patch(`/api/v1/lessons/${built.lessonId}`, w.author.cookie, {
        title: 'Newton’s Laws, second edition',
        contentBody: 'Substantially rewritten prose.',
      }),
      'edit',
    );
    // The lesson a learner completed now READS differently. Their record must
    // not: no rescoring, no re-derivation, no recount.
    await expectUnchanged();
  });

  it('archiving the lesson leaves the attempt, result, evidence and mastery intact', async () => {
    ok(await post(`/api/v1/lessons/${built.lessonId}/archive`, w.reviewer.cookie), 'archive');
    await expectUnchanged();

    // And the learner can still read their own result: retiring the material
    // does not retire the child's record of having done it.
    const result = ok<{ attempt: { score: number } }>(
      await get(`/api/v1/attempts/${attemptId}`, w.learner.cookie),
      'read attempt after archive',
    );
    expect(result.attempt.score).toBe(2);
  });

  it('archiving the whole course cascades over content and over nothing else', async () => {
    ok(
      await post(`/api/v1/courses/${built.courseId}/archive`, w.reviewer.cookie),
      'archive course',
    );

    // The cascade reached the content…
    const statuses = await rawRows<{ status: string }>(
      `SELECT status FROM lessons WHERE id = $1
       UNION ALL SELECT status FROM course_units WHERE id = $2
       UNION ALL SELECT status FROM learning_activities WHERE id = $3`,
      [built.lessonId, built.unitId, built.activityId],
    );
    expect(statuses.map((s) => s.status)).toEqual(['archived', 'archived', 'archived']);

    // …and stopped there.
    await expectUnchanged();
  });

  it('evidence still points at the SAME objective ids after every move', async () => {
    ok(
      await patch(`/api/v1/lessons/${built.lessonId}`, w.author.cookie, { title: 'Renamed' }),
      'edit',
    );
    ok(await post(`/api/v1/lessons/${built.lessonId}/archive`, w.reviewer.cookie), 'archive');

    const evidence = await rawRows<{ objective_id: string }>(
      'SELECT DISTINCT objective_id FROM objective_evidence WHERE user_id = $1',
      [w.learner.id],
    );
    // Not merely "there is still evidence" — it hangs off the same statements
    // the learner was actually measured against.
    expect(evidence.map((e) => e.objective_id).sort()).toEqual([...built.objectiveIds].sort());
  });

  it('no attempt is re-pointed at different content by any lifecycle move', async () => {
    const assessmentBefore = (
      await rawRows<{ assessment_id: string }>(
        'SELECT assessment_id FROM assessment_attempts WHERE id = $1',
        [attemptId],
      )
    )[0]?.assessment_id;

    ok(await post(`/api/v1/lessons/${built.lessonId}/archive`, w.reviewer.cookie), 'archive');
    // A new lesson and a new assessment now exist. Neither may adopt the old
    // attempt, and nothing in the lifecycle offers a way for them to.
    const { id: newLessonId } = ok<{ id: string }>(
      await post(`/api/v1/units/${built.unitId}/lessons`, w.author.cookie, { title: 'Rewrite' }),
      'new lesson',
    );
    expect(newLessonId).not.toBe(built.lessonId);

    const after = (
      await rawRows<{ assessment_id: string }>(
        'SELECT assessment_id FROM assessment_attempts WHERE id = $1',
        [attemptId],
      )
    )[0]?.assessment_id;
    expect(after).toBe(assessmentBefore);
  });

  it('a published objective cannot be reworded, so no record changes meaning', async () => {
    const refused = await patch(`/api/v1/lessons/${built.lessonId}`, w.author.cookie, {
      objectives: ['Explain the second law of thermodynamics', 'Apply F=ma to a trolley'],
    });
    expect(refused.statusCode).toBe(409);

    // The statement the evidence points at is the one the learner was taught.
    const statements = await rawRows<{ statement: string }>(
      'SELECT statement FROM learning_objectives WHERE lesson_id = $1 ORDER BY position',
      [built.lessonId],
    );
    expect(statements.map((s) => s.statement)).toEqual([
      'Explain the second law',
      'Apply F=ma to a trolley',
    ]);
    await expectUnchanged();
  });

  it('the answer key of a published assessment cannot be moved under a graded attempt', async () => {
    const keysBefore = await rawRows<{ question_id: string; option_id: string }>(
      `SELECT k.question_id, k.option_id
         FROM assessment_answer_keys k
         JOIN assessment_questions q ON q.id = k.question_id
        WHERE q.assessment_id = $1 ORDER BY k.question_id, k.option_id`,
      [built.assessmentId],
    );
    expect(keysBefore.length).toBeGreaterThan(0);

    const refused = await post(
      `/api/v1/assessments/${built.assessmentId}/questions`,
      w.author.cookie,
      { questionType: 'single_choice', prompt: 'Late', options: ['A', 'B'], correctOptions: [1] },
    );
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);

    const keysAfter = await rawRows<{ question_id: string; option_id: string }>(
      `SELECT k.question_id, k.option_id
         FROM assessment_answer_keys k
         JOIN assessment_questions q ON q.id = k.question_id
        WHERE q.assessment_id = $1 ORDER BY k.question_id, k.option_id`,
      [built.assessmentId],
    );
    expect(keysAfter).toEqual(keysBefore);
    await expectUnchanged();
  });

  it('mastery reported to the learner does not move when the content does', async () => {
    const read = async (): Promise<unknown> =>
      ok<{ units: Array<{ lessons: Array<{ objectives: Array<{ mastery: string }> }> }> }>(
        await get(`/api/v1/me/courses/${built.courseId}/mastery`, w.learner.cookie),
        'mastery',
      )
        .units.flatMap((u) => u.lessons)
        .flatMap((l) => l.objectives)
        .map((o) => o.mastery);

    const masteryBefore = await read();
    ok(
      await patch(`/api/v1/lessons/${built.lessonId}`, w.author.cookie, {
        title: 'Renamed after the learner finished',
        contentBody: 'Different words entirely.',
      }),
      'edit',
    );
    // The levels are derived from evidence, and no evidence moved — so nothing
    // a guardian or a teacher reads about this child changes because an author
    // fixed a typo.
    expect(await read()).toEqual(masteryBefore);
  });

  it('a released result stays released, and an unreleased one stays unreleased', async () => {
    const releasedBefore = await rawRows<{ released_at: Date | null }>(
      'SELECT released_at FROM assessment_attempts WHERE id = $1',
      [attemptId],
    );
    ok(await post(`/api/v1/lessons/${built.lessonId}/archive`, w.reviewer.cookie), 'archive');
    const releasedAfter = await rawRows<{ released_at: Date | null }>(
      'SELECT released_at FROM assessment_attempts WHERE id = $1',
      [attemptId],
    );
    // Archiving is not a release, and it is not a withdrawal of one either.
    expect(releasedAfter[0]?.released_at?.toISOString() ?? null).toBe(
      releasedBefore[0]?.released_at?.toISOString() ?? null,
    );
  });
});
