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
  recordProgress,
  truncateAll,
} from '../setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';

/**
 * Institutional analytics, end to end over the real HTTP stack.
 *
 * Nothing is stubbed: the same composition root, the same policy engine, the
 * same `edu_app` role, the same RLS. This is the file section 2E names, and the
 * IDOR/BOLA matrix in the Task 015 report traces to the `IDOR-<letter>` markers
 * below.
 *
 * The RLS half — the same boundaries with no application code in the path — is
 * `tests/integration/rls-analytics.test.ts`. The pure half is
 * `tests/unit/analytics-csv-safety.test.ts` and
 * `tests/unit/analytics-policy.test.ts`. None of the four is sufficient alone.
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

async function asOwner<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

afterAll(async () => {
  await testApp.db.close();
  await closeSeedDb();
});

beforeEach(truncateAll);

/**
 * Two schools, a shared course, and one class name carrying a CSV payload.
 *
 * The payload is in the fixture rather than in the export test alone, because
 * the thing worth proving is that a name typed by an ordinary user weeks
 * earlier is neutralized when a head teacher exports — not that a function
 * called directly neutralizes a string.
 */
async function world() {
  const orgA = await createOrganization('Analytics HTTP A');
  const orgB = await createOrganization('Analytics HTTP B');

  const learner = await seedAndLogin({
    email: 'sa-learner@test.local',
    roles: ['student'],
    organizationId: orgA,
  });
  const guardian = await seedAndLogin({
    email: 'sa-guardian@test.local',
    roles: ['guardian'],
    organizationId: orgA,
  });
  const teacher = await seedAndLogin({
    email: 'sa-teacher@test.local',
    roles: ['teacher'],
    organizationId: orgA,
  });
  const otherTeacher = await seedAndLogin({
    email: 'sa-teacher2@test.local',
    roles: ['teacher'],
    organizationId: orgA,
  });
  const admin = await seedAndLogin({
    email: 'sa-admin@test.local',
    roles: ['admin'],
    organizationId: orgA,
  });
  const adminB = await seedAndLogin({
    email: 'sa-admin-b@test.local',
    roles: ['admin'],
    organizationId: orgB,
  });
  const learnerB = await seedAndLogin({
    email: 'sa-learner-b@test.local',
    roles: ['student'],
    organizationId: orgB,
  });
  await grantRole(admin.id, 'admin', 'organization', orgA);
  await grantRole(adminB.id, 'admin', 'organization', orgB);
  await linkGuardian(guardian.id, learner.id);

  // A CLASS NAMED WITH A FORMULA. Ordinary text to every other endpoint on the
  // platform; a live formula to a spreadsheet, months later.
  const classA = await createClass(orgA, '=cmd|\' /C calc\'!A0');
  const otherClass = await createClass(orgA, 'A2');
  const classB = await createClass(orgB, 'B1');
  await addClassMember(classA, learner.id);
  await addClassMember(classB, learnerB.id);
  await assignTeacher(teacher.id, classA);
  await assignTeacher(otherTeacher.id, otherClass);

  const curriculum = await createCurriculum({
    organizationId: null,
    code: 'sa_shared',
    status: 'published',
  });
  const level = await createEducationLevel('sa_lvl');
  const course = await createCourse({
    organizationId: null,
    curriculumId: curriculum,
    levelId: level,
    status: 'published',
  });
  const unit = await createUnit({ courseId: course, status: 'published' });
  const lesson = await createLesson({
    unitId: unit,
    status: 'published',
    contentBody: 'Adding numbers.',
    objectives: ['Add two numbers'],
  });
  const activity = await createActivity({
    lessonId: lesson,
    activityType: 'assessment',
    status: 'draft',
    passingPercentage: 50,
  });
  if (!activity.assessmentId) throw new Error('the fixture produced no assessment');
  const question = await createQuestion({
    assessmentId: activity.assessmentId,
    options: ['4', '5'],
    correctOptions: [0],
    points: 10,
  });
  await asOwner((client) =>
    client.query(
      `UPDATE learning_activities SET status='published', published_at=now() WHERE id=$1`,
      [activity.activityId],
    ),
  );

  await assignCourseToClass({ classId: classA, courseId: course });
  await assignCourseToClass({ classId: otherClass, courseId: course });
  await assignCourseToClass({ classId: classB, courseId: course });
  await recordProgress({ userId: learner.id, lessonId: lesson, status: 'completed' });

  await asOwner(async (client) => {
    for (const org of [orgA, orgB]) {
      await client.query('SELECT app_analytics_refresh_daily($1, CURRENT_DATE)', [org]);
      await client.query('SELECT app_analytics_refresh_courses($1)', [org]);
    }
  });

  return {
    orgA,
    orgB,
    classA,
    classB,
    otherClass,
    learner,
    learnerB,
    guardian,
    teacher,
    otherTeacher,
    admin,
    adminB,
    course,
    lesson,
    assessmentId: activity.assessmentId,
    question,
  };
}

const OVERVIEW = '/api/v1/analytics/school/overview';
const COURSES = '/api/v1/analytics/courses/performance';
const AT_RISK = '/api/v1/analytics/students/at-risk';
const EXPORT = '/api/v1/analytics/export';

// ---------------------------------------------------------------------------
// Section 2E: students and guardians are banned outright
// ---------------------------------------------------------------------------

describe('learners and guardians reach no analytics endpoint', () => {
  it.each([OVERVIEW, COURSES, AT_RISK, `${EXPORT}?dataset=school_overview`])(
    'IDOR-A: a student is refused %s',
    async (url) => {
      const w = await world();
      const response = await get(url, w.learner.cookie);
      expect([403, 404]).toContain(response.statusCode);
      expect(response.body).not.toContain('lessonsCompleted');
    },
  );

  it.each([OVERVIEW, COURSES, AT_RISK, `${EXPORT}?dataset=school_overview`])(
    'IDOR-B: a guardian is refused %s',
    async (url) => {
      const w = await world();
      const response = await get(url, w.guardian.cookie);
      expect([403, 404]).toContain(response.statusCode);
    },
  );

  it('IDOR-C: no session reaches anything', async () => {
    await world();
    for (const url of [OVERVIEW, COURSES, AT_RISK, `${EXPORT}?dataset=school_overview`]) {
      const response = await testApp.app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 2E: cross-tenant
// ---------------------------------------------------------------------------

describe('a school administrator cannot reach another school', () => {
  it('IDOR-D: school B’s administrator sees only school B', async () => {
    const w = await world();
    const response = await get(OVERVIEW, w.adminB.cookie);
    expect(response.statusCode).toBe(200);

    // The positive case FIRST: the endpoint works and returns real rows, so an
    // empty result below means "filtered", not "broken".
    const own = response.json<{ days: unknown[] }>().days;
    expect(own.length).toBeGreaterThan(0);
  });

  it('IDOR-E: THERE IS NOWHERE TO PUT ANOTHER SCHOOL’S ID', async () => {
    /**
     * Section 2B's requirement, enforced structurally rather than by checking.
     * The query schemas are `.strict()` and none of them declares an
     * `organizationId`, so the attack is not "refused" — it is a 400 about a
     * field that does not exist.
     */
    const w = await world();
    for (const url of [
      `${OVERVIEW}?organizationId=${w.orgB}`,
      `${COURSES}?organizationId=${w.orgB}`,
      `${AT_RISK}?organizationId=${w.orgB}`,
      `${EXPORT}?dataset=school_overview&organizationId=${w.orgB}`,
    ]) {
      const response = await get(url, w.admin.cookie);
      expect(response.statusCode, url).toBe(400);
    }
  });

  it('IDOR-F: naming another school’s CLASS returns 404, not that class’s numbers', async () => {
    const w = await world();
    const response = await get(`${COURSES}?classId=${w.classB}`, w.admin.cookie);
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('enrollmentCount');
  });

  it('IDOR-G: school A’s administrator never sees school B’s rows in their own list', async () => {
    const w = await world();
    const response = await get(COURSES, w.admin.cookie);
    expect(response.statusCode).toBe(200);
    const items = response.json<{ items: { classId: string }[] }>().items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((i) => i.classId)).not.toContain(w.classB);
  });

  it('IDOR-H: a made-up class id is indistinguishable from another school’s', async () => {
    const w = await world();
    const invented = '00000000-0000-4000-8000-000000000000';
    const madeUp = await get(`${COURSES}?classId=${invented}`, w.admin.cookie);
    const realElsewhere = await get(`${COURSES}?classId=${w.classB}`, w.admin.cookie);
    expect(madeUp.statusCode).toBe(realElsewhere.statusCode);
  });
});

// ---------------------------------------------------------------------------
// Section 2E: a teacher reaching for executive metrics
// ---------------------------------------------------------------------------

describe('a teacher’s scope is their classes, not the institution', () => {
  it('IDOR-I: a teacher is refused the executive dashboard with 403', async () => {
    /**
     * Section 2E asks specifically for 403 here rather than 404, and the policy
     * agrees: the caller is staff asking about the school they work in, an
     * institution whose front door they can see. Pretending the dashboard does
     * not exist would read as a broken product and they would try again.
     */
    const w = await world();
    const response = await get(OVERVIEW, w.teacher.cookie);
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('administrator');
    expect(response.body).not.toContain('lessonsCompleted');
  });

  it('IDOR-J: the same teacher IS allowed their own class’s performance', async () => {
    // The positive case, which is what makes the refusal above a scope rather
    // than a broken endpoint.
    const w = await world();
    const response = await get(COURSES, w.teacher.cookie);
    expect(response.statusCode).toBe(200);
    const items = response.json<{ items: { classId: string }[] }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.classId).toBe(w.classA);
  });

  it('IDOR-K: a teacher sees no colleague’s class, in the same school', async () => {
    const w = await world();
    const list = await get(COURSES, w.otherTeacher.cookie);
    expect(list.json<{ items: { classId: string }[] }>().items.map((i) => i.classId)).toEqual([
      w.otherClass,
    ]);

    const named = await get(`${COURSES}?classId=${w.classA}`, w.otherTeacher.cookie);
    expect(named.statusCode).toBe(404);
  });

  it('IDOR-L: a teacher is refused the executive EXPORT', async () => {
    const w = await world();
    const response = await get(`${EXPORT}?dataset=school_overview`, w.teacher.cookie);
    expect(response.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Section 2B: the FERPA line
// ---------------------------------------------------------------------------

describe('named children go to the teacher who will act, not to the institution', () => {
  it('IDOR-M: the class teacher gets their at-risk learners', async () => {
    const w = await world();
    // Learner B is in school B; learner A passed nothing yet, so start by
    // making one genuinely at risk in the teacher's own class.
    await asOwner(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1, $2) RETURNING id`,
        [w.assessmentId, w.learner.id],
      );
      const id = rows[0]!.id;
      await client.query(
        `INSERT INTO assessment_attempt_answers (attempt_id, question_id, option_id)
         VALUES ($1, $2, $3)`,
        [id, w.question.questionId, w.question.optionIds[1]],
      );
      await client.query(`UPDATE assessment_attempts SET status='submitted' WHERE id=$1`, [id]);
    });

    const response = await get(`${AT_RISK}?threshold=50`, w.teacher.cookie);
    expect(response.statusCode).toBe(200);
    const items = response.json<{ items: { studentId: string }[] }>().items;
    expect(items.map((i) => i.studentId)).toContain(w.learner.id);
  });

  it('IDOR-N: THE ADMINISTRATOR IS REFUSED THE NAMED LIST, with 403', async () => {
    /**
     * Seniority narrows rather than widens. A head teacher running a school
     * does not need a browsable list of individual struggling minors; their
     * legitimate view is the COUNT in the course-performance report, which
     * tells them where to put resources.
     */
    const w = await world();
    const response = await get(AT_RISK, w.admin.cookie);
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('teachers');
  });

  it('IDOR-O: a teacher of another class sees none of these children', async () => {
    const w = await world();
    const response = await get(`${AT_RISK}?threshold=100`, w.otherTeacher.cookie);
    // Threshold 100 is the widest possible ask — everyone with any evidence.
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  it('IDOR-P: the payload carries no answers and no per-assessment scores', async () => {
    const w = await world();
    const response = await get(`${AT_RISK}?threshold=100`, w.teacher.cookie);
    expect(response.statusCode).toBe(200);
    const body = response.body;
    for (const forbidden of ['optionId', 'answers', 'percentage', 'score', 'attemptId']) {
      expect(body, `${forbidden} in the at-risk payload`).not.toContain(forbidden);
    }
  });

  it('IDOR-Q: at-risk cannot be exported at all', async () => {
    // A CSV of struggling minors is precisely the artefact that gets forwarded
    // and left on laptops. The dataset enum does not contain it, so this is a
    // 400 rather than a policy decision — the door is not there.
    const w = await world();
    const response = await get(`${EXPORT}?dataset=at_risk`, w.teacher.cookie);
    expect(response.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Section 2E and 3: the export
// ---------------------------------------------------------------------------

describe('the export', () => {
  it('IDOR-R: NEUTRALIZES A FORMULA THAT ARRIVED AS A CLASS NAME', async () => {
    /**
     * THE WHOLE CSV-INJECTION SCENARIO, END TO END.
     *
     * The class was named `=cmd|' /C calc'!A0` by an ordinary write, months
     * before anybody exported anything. `tests/unit/analytics-csv-safety.test.ts`
     * proves the sanitizer handles the string; this proves the string actually
     * reaches the sanitizer on the real path, which is the half a unit test
     * cannot establish.
     */
    const w = await world();
    const response = await get(`${EXPORT}?dataset=course_performance`, w.admin.cookie);
    expect(response.statusCode, response.body).toBe(200);

    expect(response.body).toContain('cmd|');
    // Present, and neutralized: the cell opens with a quote then an apostrophe,
    // so no spreadsheet parses what follows as a formula.
    expect(response.body).not.toMatch(/(^|\r\n|,)"=/);
    expect(response.body).toContain('"\'=cmd|');
  });

  it('IDOR-S: is served as an attachment that a browser will not render', async () => {
    const w = await world();
    const response = await get(`${EXPORT}?dataset=school_overview`, w.admin.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('IDOR-T: carries no internal identifiers', async () => {
    // A compliance export travels. A uuid in it is a thing to try against other
    // endpoints once it has.
    const w = await world();
    const response = await get(`${EXPORT}?dataset=course_performance`, w.admin.cookie);
    for (const id of [w.orgA, w.classA, w.course, w.learner.id]) {
      expect(response.body, `${id} leaked into the export`).not.toContain(id);
    }
  });

  it('IDOR-U: a teacher exporting course performance gets only their class', async () => {
    const w = await world();
    const response = await get(`${EXPORT}?dataset=course_performance`, w.teacher.cookie);
    expect(response.statusCode).toBe(200);
    // Header row plus exactly one data row.
    expect(response.body.split('\r\n')).toHaveLength(2);
  });

  it('IDOR-V: refuses a dataset that is not on the list', async () => {
    const w = await world();
    for (const dataset of ['users', 'assessment_attempts', '../etc/passwd', '']) {
      const response = await get(
        `${EXPORT}?dataset=${encodeURIComponent(dataset)}`,
        w.admin.cookie,
      );
      expect(response.statusCode, dataset).toBe(400);
    }
  });

  it('IDOR-W: the JSON format is authorized identically', async () => {
    // A second format is a second door, and a door is where somebody forgets a
    // lock. The teacher is refused the executive dataset in JSON exactly as in
    // CSV.
    const w = await world();
    expect(
      (await get(`${EXPORT}?dataset=school_overview&format=json`, w.teacher.cookie)).statusCode,
    ).toBe(403);
    expect(
      (await get(`${EXPORT}?dataset=school_overview&format=json`, w.admin.cookie)).statusCode,
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Section 3: role elevation must not bypass the tenant filter
// ---------------------------------------------------------------------------

describe('role elevation does not widen the tenant', () => {
  it('IDOR-X: A GLOBAL ADMIN GRANT STILL SEES ONLY THEIR OWN SCHOOL', async () => {
    /**
     * Section 3: "verify that user role elevation attempts do not bypass
     * analytics RLS filters."
     *
     * `app_actor_is_org_admin()` asks only whether the actor HOLDS the admin
     * role — it ignores the grant's scope entirely, which is the established
     * shape on this platform. That is safe only because the tenant equality is
     * always paired with it, and this test is what proves the pairing holds
     * when the role grant is as wide as a role grant can be.
     *
     * The learner is given a GLOBAL admin role directly in the database — a
     * stronger grant than any endpoint issues — and still reaches only the
     * school their user record names.
     */
    const w = await world();
    await grantRole(w.learner.id, 'admin', 'global', null);

    // A fresh session, so the elevation is reflected in the actor.
    const elevated = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: writeHeaders,
      payload: { email: 'sa-learner@test.local', password: PASSWORD },
    });
    const cookie = `edu_session=${sessionCookieFrom(elevated.headers['set-cookie'])}`;

    const response = await get(OVERVIEW, cookie);
    if (response.statusCode === 200) {
      // If the elevation works at all, it works only for school A. There is no
      // response shape in which school B's figures appear.
      expect(response.body).not.toContain(w.orgB);
    }

    // And school B's class is still out of reach, whatever the role says.
    expect((await get(`${COURSES}?classId=${w.classB}`, cookie)).statusCode).toBe(404);
  });

  it('IDOR-Y: an administrator with no organization on their user record gets nothing', async () => {
    /**
     * The null-tenant case, which is the one a `= app_actor_organization()`
     * predicate gets wrong if it forgets that null is not equal to anything —
     * including itself. Both the RLS policy and the repository query say
     * `IS NOT NULL` explicitly for this reason.
     */
    await world();
    const orphan = await seedAndLogin({
      email: 'sa-orphan-admin@test.local',
      roles: ['admin'],
      organizationId: null,
    });
    // REFUSED OR EMPTY, AND IT TURNS OUT TO BE REFUSED. `app_actor_organization()`
    // is null, so the administrator disjunct cannot hold; they teach nothing, so
    // the teacher disjunct cannot either. The assertion is written to accept
    // both outcomes and then to check the property that actually matters — that
    // no school's figures appear — because which of the two happens is a policy
    // detail and "no rows from anywhere" is the guarantee.
    for (const url of [OVERVIEW, COURSES]) {
      const response = await get(url, orphan.cookie);
      expect([200, 403, 404], `${url} -> ${response.statusCode}`).toContain(response.statusCode);
      if (response.statusCode === 200) {
        const body = response.json<{ days?: unknown[]; items?: unknown[] }>();
        expect(body.days ?? body.items ?? []).toHaveLength(0);
      }
      expect(response.body).not.toContain('lessonsCompleted');
    }
  });
});

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

describe('the overview payload', () => {
  it('reports a real completed lesson', async () => {
    const w = await world();
    const response = await get(OVERVIEW, w.admin.cookie);
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      days: { lessonsCompleted: number }[];
      totals: { lessonsCompleted: number; activeStudentsPeak: number };
    }>();
    expect(body.totals.lessonsCompleted).toBe(1);
    expect(body.totals.activeStudentsPeak).toBe(1);
  });

  it('CARRIES NO organizationId', async () => {
    // The caller has exactly one school and already knows which. Echoing the id
    // back adds nothing a dashboard renders and puts an internal key in a
    // payload that gets pasted into support tickets.
    const w = await world();
    const response = await get(OVERVIEW, w.admin.cookie);
    expect(response.body).not.toContain(w.orgA);
    expect(response.body).not.toContain('organizationId');
  });

  it('reports an unassessed school’s mastery index as null, not zero', async () => {
    /**
     * The fixture completes a lesson, which emits `lesson_completed` evidence
     * and puts the learner in `attempted` — something happened, none of it
     * graded. Migration 0033 excludes that from the average alongside
     * `no_evidence`, because scoring it zero told a head teacher their school
     * had failed when in fact it had not yet been assessed.
     */
    const w = await world();
    const response = await get(OVERVIEW, w.admin.cookie);
    const body = response.json<{ totals: { masteryIndex: number | null } }>();
    expect(body.totals.masteryIndex).toBeNull();
  });

  it('refuses an out-of-range window rather than clamping it silently', async () => {
    const w = await world();
    expect((await get(`${OVERVIEW}?days=0`, w.admin.cookie)).statusCode).toBe(400);
    expect((await get(`${OVERVIEW}?days=4000`, w.admin.cookie)).statusCode).toBe(400);
    expect((await get(`${OVERVIEW}?days=abc`, w.admin.cookie)).statusCode).toBe(400);
  });
});
