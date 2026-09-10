import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createDatabase, type Database } from '../../apps/api/src/platform/db.ts';
import { TEST_APP_URL, TEST_SUPERUSER_URL } from '../setup/env.ts';
import {
  addClassMember,
  assignCourseToClass,
  assignTeacher,
  closeSeedDb,
  createActivity,
  createAttempt,
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
  objectivesOf,
  recordProgress,
  truncateAll,
} from '../setup/fixtures.ts';

/**
 * Row-Level Security and metric accuracy for institutional analytics.
 *
 * No application code is in the path. Every read runs as `edu_app`
 * (NOBYPASSRLS, non-owner) with `app.actor_id` set exactly as a request would
 * set it, and every refresh runs as the owner, which is what a scheduled job
 * would be. If the entire policy engine were deleted tomorrow, these are the
 * boundaries that would still hold.
 *
 * THIS SUITE ALSO CHECKS THE NUMBERS, which the other RLS suites do not have to.
 * A boundary that holds around a metric nobody verified is a boundary around a
 * wrong answer, and a school-wide dashboard that is quietly wrong is worse than
 * one that is missing — people make decisions about staff and children from it.
 * So the fixtures produce a KNOWN answer and the tests assert it.
 */
const db: Database = createDatabase({ connectionString: TEST_APP_URL, poolMax: 4 });

afterAll(async () => {
  await db.close();
  await closeSeedDb();
});

beforeEach(truncateAll);

/** Runs a statement as the table owner — what a scheduled refresh job is. */
async function asOwner<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function rows<T extends Record<string, unknown>>(
  actorId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return db.withActor(actorId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

/** Did the statement do anything? A USING clause goes quiet; WITH CHECK raises. */
async function attempt(actorId: string, sql: string, params: unknown[] = []): Promise<boolean> {
  try {
    const result = await db.withActor(actorId, (tx) => tx.query(sql, params));
    return (result.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * An attempt that is actually GRADED, driven the way a learner drives one.
 *
 * `createAttempt` with `status: 'submitted'` flips the status and lets the
 * submit trigger score whatever answers exist — which, with none, is zero. So
 * the answer is written between the two steps, exactly as the real endpoint
 * does, and the score that comes out is the one the database computed rather
 * than one a fixture asserted into place.
 */
async function gradedAttempt(options: {
  assessmentId: string;
  userId: string;
  questionId: string;
  optionId: string;
}): Promise<string> {
  const id = await createAttempt({
    assessmentId: options.assessmentId,
    userId: options.userId,
  });
  await asOwner((client) =>
    client.query(
      `INSERT INTO assessment_attempt_answers (attempt_id, question_id, option_id)
       VALUES ($1, $2, $3)`,
      [id, options.questionId, options.optionId],
    ),
  );
  await asOwner((client) =>
    client.query(`UPDATE assessment_attempts SET status = 'submitted' WHERE id = $1`, [id]),
  );
  return id;
}


/**
 * Two schools studying THE SAME SHARED COURSE.
 *
 * The shared course is the point of the fixture rather than a detail of it.
 * `courses.organization_id` is nullable and null means centrally authored
 * material used by many schools — so a tenant derived from the CONTENT would
 * answer null for both schools here, and a tenant derived from the LEARNER'S
 * CLASS answers correctly for each. Every accuracy test below would pass
 * trivially against a fixture where each school had its own course.
 *
 * Learner A answers correctly; learner B answers wrongly. The two schools
 * therefore have different, checkable numbers from identical curriculum.
 */
async function world() {
  const orgA = await createOrganization('Analytics School A');
  const orgB = await createOrganization('Analytics School B');

  // `createUser` returns a record, not an id.
  const mk = async (email: string, roles: readonly string[], org: string): Promise<string> =>
    (await createUser({ email, roles, organizationId: org })).id;

  const learnerA = await mk('an-learner-a@test.local', ['student'], orgA);
  const learnerB = await mk('an-learner-b@test.local', ['student'], orgB);
  const teacherA = await mk('an-teacher-a@test.local', ['teacher'], orgA);
  const teacherB = await mk('an-teacher-b@test.local', ['teacher'], orgB);
  const adminA = await mk('an-admin-a@test.local', ['admin'], orgA);
  const adminB = await mk('an-admin-b@test.local', ['admin'], orgB);
  const guardianA = await mk('an-guardian-a@test.local', ['guardian'], orgA);
  await grantRole(adminA, 'admin', 'organization', orgA);
  await grantRole(adminB, 'admin', 'organization', orgB);

  const classA = await createClass(orgA, 'A1');
  const classB = await createClass(orgB, 'B1');
  await addClassMember(classA, learnerA);
  await addClassMember(classB, learnerB);
  await assignTeacher(teacherA, classA);
  await assignTeacher(teacherB, classB);

  // The SHARED course: no organization of its own.
  const curriculum = await createCurriculum({
    organizationId: null,
    code: 'an_shared',
    status: 'published',
  });
  const level = await createEducationLevel('an_lvl');
  const course = await createCourse({
    curriculumId: curriculum,
    levelId: level,
    status: 'published',
    organizationId: null,
  });
  const unit = await createUnit({ courseId: course, status: 'published' });
  const lesson = await createLesson({
    unitId: unit,
    status: 'published',
    contentBody: 'Adding numbers.',
    objectives: ['Add two numbers'],
  });
  const [objective] = await objectivesOf(lesson);
  // DRAFT FIRST, THEN THE QUESTION, THEN PUBLISH. That is the only order the
  // schema permits — `learning_activity_structure_guard` refuses to publish an
  // assessment activity whose assessment has no scoreable question — and it is
  // the order a real author works in.
  const activity = await createActivity({
    lessonId: lesson,
    activityType: 'assessment',
    status: 'draft',
    passingPercentage: 50,
  });
  const assessmentId = activity.assessmentId;
  if (!assessmentId) throw new Error('the fixture produced no assessment');

  const question = await createQuestion({
    assessmentId,
    questionType: 'single_choice',
    prompt: 'Two plus two?',
    points: 10,
    options: ['4', '5'],
    correctOptions: [0],
  });

  await asOwner((client) =>
    client.query(
      `UPDATE learning_activities SET status='published', published_at=now() WHERE id=$1`,
      [activity.activityId],
    ),
  );

  await assignCourseToClass({ classId: classA, courseId: course });
  await assignCourseToClass({ classId: classB, courseId: course });

  return {
    orgA,
    orgB,
    classA,
    classB,
    learnerA,
    learnerB,
    teacherA,
    teacherB,
    adminA,
    adminB,
    guardianA,
    course,
    lesson,
    assessmentId,
    question,
    objective,
  };
}

async function refresh(orgs: readonly string[]): Promise<void> {
  await asOwner(async (client) => {
    for (const org of orgs) {
      await client.query('SELECT app_analytics_refresh_daily($1, CURRENT_DATE)', [org]);
      await client.query('SELECT app_analytics_refresh_courses($1)', [org]);
    }
  });
}

// ---------------------------------------------------------------------------
// The tenant boundary
// ---------------------------------------------------------------------------

describe('the school is the boundary', () => {
  it('an administrator reads their own school and only their own', async () => {
    const w = await world();
    await refresh([w.orgA, w.orgB]);

    const seen = await rows<{ organization_id: string }>(
      w.adminA,
      'SELECT organization_id FROM analytics_daily_school_metrics',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.organization_id).toBe(w.orgA);
  });

  it('REFUSES SCHOOL B TO SCHOOL A’S ADMINISTRATOR, even when named directly', async () => {
    // The headline requirement of section 2C. Naming the other school's id
    // explicitly is the exact attack, and it returns nothing rather than
    // erroring — a USING clause goes quiet.
    const w = await world();
    await refresh([w.orgA, w.orgB]);

    expect(
      await rows(w.adminA, 'SELECT * FROM analytics_daily_school_metrics WHERE organization_id = $1', [
        w.orgB,
      ]),
    ).toHaveLength(0);
    expect(
      await rows(w.adminA, 'SELECT * FROM analytics_course_performance WHERE organization_id = $1', [
        w.orgB,
      ]),
    ).toHaveLength(0);
  });

  it('REFUSES THE EXECUTIVE TABLE TO A TEACHER of that very school', async () => {
    // Section 2C separates the audiences: school-wide totals answer a question
    // about the institution, and a teacher's scope is their classes.
    const w = await world();
    await refresh([w.orgA]);
    expect(await rows(w.teacherA, 'SELECT * FROM analytics_daily_school_metrics')).toHaveLength(0);
  });

  it('gives a teacher their own class’s course row and no other', async () => {
    const w = await world();
    await refresh([w.orgA, w.orgB]);

    const mine = await rows<{ class_id: string }>(
      w.teacherA,
      'SELECT class_id FROM analytics_course_performance',
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.class_id).toBe(w.classA);

    // And the other school's teacher sees theirs, not this one. Asserting the
    // positive case too is what distinguishes "correctly filtered" from
    // "always returns nothing".
    const theirs = await rows<{ class_id: string }>(
      w.teacherB,
      'SELECT class_id FROM analytics_course_performance',
    );
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.class_id).toBe(w.classB);
  });

  it('gives an administrator every class in their school', async () => {
    const w = await world();
    const second = await createClass(w.orgA, 'A2');
    await assignCourseToClass({ classId: second, courseId: w.course });
    await refresh([w.orgA]);

    const seen = await rows(w.adminA, 'SELECT class_id FROM analytics_course_performance');
    expect(seen).toHaveLength(2);
  });

  it('BANS LEARNERS AND GUARDIANS FROM BOTH TABLES', async () => {
    // Section 2C, and it is stronger than a product preference: the mastery
    // index in these tables is computed from the STAFF vantage point, so it
    // includes results a teacher has not released. Serving one to a learner
    // would announce a mark through a side door.
    const w = await world();
    await refresh([w.orgA]);

    for (const actor of [w.learnerA, w.guardianA]) {
      expect(await rows(actor, 'SELECT * FROM analytics_daily_school_metrics')).toHaveLength(0);
      expect(await rows(actor, 'SELECT * FROM analytics_course_performance')).toHaveLength(0);
    }
  });

  it('a teacher who leaves the class stops seeing its numbers', async () => {
    const w = await world();
    await refresh([w.orgA]);
    expect(await rows(w.teacherA, 'SELECT * FROM analytics_course_performance')).toHaveLength(1);

    await asOwner((client) =>
      client.query(
        `UPDATE teacher_assignments SET status='ended', ended_at=now()
          WHERE teacher_id=$1 AND class_id=$2`,
        [w.teacherA, w.classA],
      ),
    );

    // `app_actor_teaches_class` requires an ACTIVE assignment, so this takes
    // effect on the same day the teacher stops teaching rather than at the next
    // refresh.
    expect(await rows(w.teacherA, 'SELECT * FROM analytics_course_performance')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The tables are derived, and nobody writes to them
// ---------------------------------------------------------------------------

describe('nobody writes a metric', () => {
  it('REFUSES INSERT, UPDATE AND DELETE to the application role', async () => {
    // Every number here is a fact about rows that live elsewhere. A write path
    // would be a way to make the dashboard say something the school's data does
    // not — which, on a table used to judge teachers and children, is the
    // failure mode worth designing out rather than auditing.
    const w = await world();
    await refresh([w.orgA]);

    expect(
      await attempt(
        w.adminA,
        `INSERT INTO analytics_daily_school_metrics (organization_id, metric_date, total_active_students)
         VALUES ($1, CURRENT_DATE - 1, 999)`,
        [w.orgA],
      ),
    ).toBe(false);
    expect(
      await attempt(w.adminA, 'UPDATE analytics_daily_school_metrics SET total_active_students = 999'),
    ).toBe(false);
    expect(await attempt(w.adminA, 'DELETE FROM analytics_course_performance')).toBe(false);
  });

  it('REFUSES THE REFRESH FUNCTIONS to the application role', async () => {
    const w = await world();
    expect(
      await attempt(w.adminA, 'SELECT app_analytics_refresh_daily($1, CURRENT_DATE)', [w.orgB]),
    ).toBe(false);
    expect(await attempt(w.adminA, 'SELECT app_analytics_refresh_courses($1)', [w.orgB])).toBe(
      false,
    );
  });

  it('REFUSES A ROW WHOSE SCHOOL DISAGREES WITH ITS CLASS — the composite key', async () => {
    /**
     * THE TENANT, STRUCTURALLY.
     *
     * `analytics_course_performance` references `classes (id, organization_id)`,
     * so a row claiming school B for a class in school A cannot exist. This is
     * asserted AS THE OWNER, with RLS and grants out of the picture, because
     * the point is that no amount of privilege makes it writable.
     */
    const w = await world();
    await refresh([w.orgA]);

    await expect(
      asOwner((client) =>
        client.query(
          `INSERT INTO analytics_course_performance (organization_id, course_id, class_id)
           VALUES ($1, $2, $3)`,
          [w.orgB, w.course, w.classA],
        ),
      ),
    ).rejects.toThrow(/foreign key|analytics_course_performance_class_fk/i);
  });

  it('REFUSES A FUTURE-DATED METRIC ROW', async () => {
    const w = await world();
    await expect(
      asOwner((client) =>
        client.query(
          `INSERT INTO analytics_daily_school_metrics (organization_id, metric_date)
           VALUES ($1, CURRENT_DATE + 1)`,
          [w.orgA],
        ),
      ),
    ).rejects.toThrow(/not_future/i);
  });
});

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

describe('the metrics are right, not merely present', () => {
  it('counts a completed lesson and an attempt for the right school', async () => {
    const w = await world();
    await recordProgress({ userId: w.learnerA, lessonId: w.lesson, status: 'completed' });
    await refresh([w.orgA, w.orgB]);

    const [a] = await rows<{ lessons_completed: number; total_active_students: number }>(
      w.adminA,
      'SELECT lessons_completed, total_active_students FROM analytics_daily_school_metrics',
    );
    expect(a?.lessons_completed).toBe(1);
    expect(a?.total_active_students).toBe(1);

    // SCHOOL B DID NOTHING, and gets zero rather than school A's number. This
    // is the assertion that would fail if the tenant came from the shared
    // course instead of the learner's class.
    const [b] = await rows<{ lessons_completed: number }>(
      w.adminB,
      'SELECT lessons_completed FROM analytics_daily_school_metrics',
    );
    expect(b?.lessons_completed).toBe(0);
  });

  it('ACTIVE MEANS DID SOMETHING, NOT MERELY ENROLLED', async () => {
    // The most common way an engagement dashboard lies to a head teacher is by
    // reporting the roll as "active users". Nobody has done anything here.
    const w = await world();
    await refresh([w.orgA]);

    const [row] = await rows<{ total_active_students: number }>(
      w.adminA,
      'SELECT total_active_students FROM analytics_daily_school_metrics',
    );
    expect(row?.total_active_students).toBe(0);
  });

  it('counts enrolment and completion at the class grain', async () => {
    const w = await world();
    await recordProgress({ userId: w.learnerA, lessonId: w.lesson, status: 'completed' });
    await refresh([w.orgA]);

    const [row] = await rows<{ enrollment_count: number; completion_rate_pct: string }>(
      w.adminA,
      'SELECT enrollment_count, completion_rate_pct FROM analytics_course_performance',
    );
    expect(row?.enrollment_count).toBe(1);
    // One learner, one published lesson, completed: 100%.
    expect(Number(row?.completion_rate_pct)).toBe(100);
  });

  it('LEAVES THE MASTERY INDEX NULL WHEN THERE IS NO EVIDENCE, rather than zero', async () => {
    /**
     * A school whose learners have produced no gradeable evidence has no
     * average. Zero would read as total failure to whoever opens the dashboard,
     * and this is a number people make decisions about staff from.
     */
    const w = await world();
    await refresh([w.orgA]);

    const [row] = await rows<{ average_mastery_score: string | null }>(
      w.adminA,
      'SELECT average_mastery_score FROM analytics_daily_school_metrics',
    );
    expect(row?.average_mastery_score).toBeNull();
  });

  it('scores mastery from real graded evidence, differently for each school', async () => {
    /**
     * THE TEST THE SHARED COURSE EXISTS FOR.
     *
     * Both schools study identical curriculum. Learner A passes; learner B does
     * not. If the tenant came from the content, both schools would show the same
     * number — or, since `courses.organization_id` is null here, no number at
     * all. Reaching through the learner's class gives each school its own.
     */
    const w = await world();
    const passing = await gradedAttempt({
      assessmentId: w.assessmentId,
      userId: w.learnerA,
      questionId: w.question.questionId,
      optionId: w.question.optionIds[0]!,
    });
    const failing = await gradedAttempt({
      assessmentId: w.assessmentId,
      userId: w.learnerB,
      questionId: w.question.questionId,
      optionId: w.question.optionIds[1]!,
    });
    expect(passing).not.toBe(failing);

    await refresh([w.orgA, w.orgB]);

    const [a] = await rows<{ average_mastery_score: string | null }>(
      w.adminA,
      'SELECT average_mastery_score FROM analytics_daily_school_metrics',
    );
    const [b] = await rows<{ average_mastery_score: string | null }>(
      w.adminB,
      'SELECT average_mastery_score FROM analytics_daily_school_metrics',
    );

    // `demonstrated` is 2 of 3 on the documented ordinal scale; `developing` is
    // 1 of 3. The exact numbers are asserted because a scale nobody checks is a
    // scale that can be quietly rescaled.
    expect(Number(a?.average_mastery_score)).toBeCloseTo(66.67, 1);
    expect(Number(b?.average_mastery_score)).toBeCloseTo(33.33, 1);
  });

  it('flags a struggling learner in the right school only', async () => {
    const w = await world();
    await gradedAttempt({
      assessmentId: w.assessmentId,
      userId: w.learnerA,
      questionId: w.question.questionId,
      optionId: w.question.optionIds[0]!,
    });
    await gradedAttempt({
      assessmentId: w.assessmentId,
      userId: w.learnerB,
      questionId: w.question.questionId,
      optionId: w.question.optionIds[1]!,
    });
    await refresh([w.orgA, w.orgB]);

    const [a] = await rows<{ flagged_struggling_students_count: number }>(
      w.adminA,
      'SELECT flagged_struggling_students_count FROM analytics_course_performance',
    );
    const [b] = await rows<{ flagged_struggling_students_count: number }>(
      w.adminB,
      'SELECT flagged_struggling_students_count FROM analytics_course_performance',
    );
    expect(a?.flagged_struggling_students_count).toBe(0);
    expect(b?.flagged_struggling_students_count).toBe(1);
  });

  it('DOES NOT FLAG A LEARNER WITH NO EVIDENCE AT ALL', async () => {
    // Absence is not failure. A learner who started the course yesterday must
    // not appear on an intervention list, or a teacher goes to the wrong child.
    const w = await world();
    await refresh([w.orgA]);

    const [row] = await rows<{ flagged_struggling_students_count: number }>(
      w.adminA,
      'SELECT flagged_struggling_students_count FROM analytics_course_performance',
    );
    expect(row?.flagged_struggling_students_count).toBe(0);
  });

  it('is idempotent: refreshing twice does not double a count', async () => {
    // The write is an upsert, so a job that runs late and then catches up does
    // not report twice the activity.
    const w = await world();
    await recordProgress({ userId: w.learnerA, lessonId: w.lesson, status: 'completed' });
    await refresh([w.orgA]);
    await refresh([w.orgA]);

    const found = await rows<{ lessons_completed: number }>(
      w.adminA,
      'SELECT lessons_completed FROM analytics_daily_school_metrics',
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.lessons_completed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The at-risk reader
// ---------------------------------------------------------------------------

describe('the at-risk reader authorizes itself', () => {
  async function withStruggler() {
    const w = await world();
    await gradedAttempt({
      assessmentId: w.assessmentId,
      userId: w.learnerB,
      questionId: w.question.questionId,
      optionId: w.question.optionIds[1]!,
    });
    return w;
  }

  it('gives the class’s teacher their struggling learner', async () => {
    const w = await withStruggler();
    const found = await rows<{ student_id: string; mastery_index: string }>(
      w.teacherB,
      'SELECT student_id, mastery_index FROM app_analytics_at_risk(50.0)',
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.student_id).toBe(w.learnerB);
  });

  it('GIVES AN ADMINISTRATOR NOTHING — the FERPA line', async () => {
    // Not a shorter list: nothing. A head teacher's legitimate view is the
    // count in `analytics_course_performance`; the named list belongs to the
    // adult who will sit down with the child.
    const w = await withStruggler();
    expect(await rows(w.adminB, 'SELECT * FROM app_analytics_at_risk(50.0)')).toHaveLength(0);
  });

  it('gives another school’s teacher nothing, at any threshold', async () => {
    const w = await withStruggler();
    // Threshold 100 means "everybody with any evidence" — the widest possible
    // ask — and it still crosses no school boundary.
    expect(await rows(w.teacherA, 'SELECT * FROM app_analytics_at_risk(100.0)')).toHaveLength(0);
  });

  it('gives the learner themselves nothing', async () => {
    const w = await withStruggler();
    expect(await rows(w.learnerB, 'SELECT * FROM app_analytics_at_risk(100.0)')).toHaveLength(0);
  });

  it('RETURNS NO ANSWERS, NO SCORES — only the finding', async () => {
    /**
     * Section 2B forbids leaking "raw individual student responses". The way to
     * comply is not to filter them downstream but never to put them in the
     * shape, so this asserts on the COLUMNS the function returns rather than on
     * a particular row's contents.
     */
    const w = await withStruggler();
    const [row] = await rows<Record<string, unknown>>(
      w.teacherB,
      'SELECT * FROM app_analytics_at_risk(50.0)',
    );
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'class_id',
      'course_id',
      'display_name',
      'mastery_index',
      'objectives_with_evidence',
      'student_id',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Section 2B: aggregation must not contend with live traffic
// ---------------------------------------------------------------------------

describe('the refresh does not lock the transaction tables', () => {
  it('TAKES NO ROW OR TABLE LOCK ON assessment_attempts OR ai_messages', async () => {
    /**
     * SECTION 2B, MEASURED RATHER THAN ASSERTED IN A COMMENT.
     *
     * "Ensure reporting queries are optimized to avoid lock contention on
     * primary transaction tables." The migration's reasoning is that every read
     * in the refresh is a plain SELECT at READ COMMITTED, which takes only an
     * ACCESS SHARE lock — the mode that conflicts with nothing except
     * `ACCESS EXCLUSIVE` (a DDL rewrite).
     *
     * This test holds the refresh open inside a transaction and asks `pg_locks`
     * what it is actually holding. A future edit that added `FOR UPDATE` for a
     * plausible-sounding reason — "so the numbers are consistent" — would start
     * blocking learners mid-quiz, and would fail here.
     */
    const w = await world();

    const modes = await asOwner(async (client) => {
      await client.query('BEGIN');
      await client.query('SELECT app_analytics_refresh_daily($1, CURRENT_DATE)', [w.orgA]);
      const { rows: held } = await client.query<{ relname: string; mode: string }>(
        `SELECT c.relname, l.mode
           FROM pg_locks l
           JOIN pg_class c ON c.oid = l.relation
          WHERE l.pid = pg_backend_pid()
            AND c.relname IN ('assessment_attempts', 'ai_messages', 'lesson_progress',
                              'objective_evidence')`,
      );
      await client.query('ROLLBACK');
      return held;
    });

    // ACCESS SHARE and nothing heavier. `RowShareLock` would mean `FOR UPDATE`;
    // `RowExclusiveLock` would mean the refresh had started writing to a source
    // table, which it must never do.
    for (const lock of modes) {
      expect(lock.mode, `${lock.relname} held ${lock.mode}`).toBe('AccessShareLock');
    }
  });

  it('writes only to the two analytics tables', async () => {
    // The other half of the same property: a refresh reads widely and writes
    // narrowly. Anything holding a write lock outside these two names would be
    // a reporting job mutating the data it reports on.
    const w = await world();

    const written = await asOwner(async (client) => {
      await client.query('BEGIN');
      await client.query('SELECT app_analytics_refresh_courses($1)', [w.orgA]);
      const { rows: held } = await client.query<{ relname: string }>(
        `SELECT DISTINCT c.relname
           FROM pg_locks l
           JOIN pg_class c ON c.oid = l.relation
          WHERE l.pid = pg_backend_pid()
            AND c.relkind = 'r'
            AND l.mode IN ('RowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')`,
      );
      await client.query('ROLLBACK');
      return held.map((r) => r.relname);
    });

    for (const name of written) {
      expect(name).toMatch(/^analytics_/);
    }
  });
});
