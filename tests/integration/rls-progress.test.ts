import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../apps/api/src/platform/db.ts';
import { TEST_APP_URL } from '../setup/env.ts';
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

/**
 * Row-Level Security for learner progress.
 *
 * No application code is in the path. Every statement runs as `edu_app`
 * (NOBYPASSRLS, non-owner) with `app.actor_id` set exactly as a request would
 * set it. If the whole policy engine were deleted tomorrow, these are the
 * boundaries that would still hold.
 *
 * Its mirror is `tests/security/progress.test.ts`, which asserts the same
 * boundaries through the application, and `layered-defense.test.ts`, which
 * asserts them with RLS switched OFF.
 */
const db: Database = createDatabase({ connectionString: TEST_APP_URL, poolMax: 4 });

afterAll(async () => {
  await db.close();
  await closeSeedDb();
});

beforeEach(truncateAll);

async function attempt(actorId: string, sql: string, params: unknown[] = []): Promise<boolean> {
  try {
    await db.withActor(actorId, (tx) => tx.query(sql, params));
    return true;
  } catch {
    return false;
  }
}

/** Which (learner, course) pairs the actor can actually read. */
async function readable(actorId: string): Promise<string[]> {
  return db.withActor(actorId, async (tx) =>
    (
      await tx.query<{ pair: string }>(
        `SELECT p.user_id || '/' || lb.course_title AS pair
           FROM lesson_progress p
           CROSS JOIN LATERAL app_lesson_label(p.lesson_id) lb
          ORDER BY pair`,
      )
    ).rows.map((r) => r.pair),
  );
}

/**
 * One school. `teacher` teaches BOTH classes; `learner` is in A1 only.
 * Course P is assigned to A1, course Q to A2, course U to neither.
 *
 * The two-class shape is what separates "I teach them" from "I teach them THIS
 * course" — the conjunction the task's teacher rule turns on.
 */
async function world() {
  const orgA = await createOrganization('School A');
  const orgB = await createOrganization('School B');
  const level = await createEducationLevel();

  const mk = (email: string, roles?: readonly string[], org: string | null = orgA) =>
    createUser({ email, ...(roles ? { roles } : {}), organizationId: org });

  const learner = await mk('learner@t.local');
  const peer = await mk('peer@t.local');
  const otherClassLearner = await mk('other-class@t.local');
  const teacher = await mk('teacher@t.local', ['teacher']);
  const otherTeacher = await mk('other-teacher@t.local', ['teacher']);
  const admin = await mk('admin@t.local', ['admin']);
  const guardian = await mk('guardian@t.local', ['guardian']);
  const stranger = await mk('stranger@t.local');
  const learnerB = await mk('learner-b@t.local', undefined, orgB);
  const adminB = await mk('admin-b@t.local', ['admin'], orgB);

  // A school security administrator: the role scoped to the school, which is
  // NOT a platform operator.
  const securityAdmin = await mk('sec-admin@t.local');
  await grantRole(securityAdmin.id, 'security_admin', 'organization', orgA);

  const operator = await createUser({ email: 'op@t.local', organizationId: null });
  await grantRole(operator.id, 'security_admin', 'global', null);

  const classA1 = await createClass(orgA, 'A1');
  const classA2 = await createClass(orgA, 'A2');
  await addClassMember(classA1, learner.id);
  await addClassMember(classA1, peer.id);
  await addClassMember(classA2, otherClassLearner.id);
  await assignTeacher(teacher.id, classA1);
  await assignTeacher(teacher.id, classA2);
  await assignTeacher(otherTeacher.id, classA2);

  await linkGuardian(guardian.id, learner.id, 'verified');

  const curriculumA = await createCurriculum({ organizationId: orgA, status: 'published' });
  const mkCourse = async (title: string, status: 'draft' | 'published' = 'published') => {
    const course = await createCourse({
      organizationId: orgA,
      curriculumId: curriculumA,
      levelId: level,
      title,
      status,
    });
    const unit = await createUnit({ courseId: course, title: `${title}-u`, status: 'published' });
    const lesson = await createLesson({
      unitId: unit,
      title: `${title}-l`,
      status: 'published',
    });
    const draftLesson = await createLesson({
      unitId: unit,
      title: `${title}-draft`,
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
    learner,
    peer,
    otherClassLearner,
    teacher,
    otherTeacher,
    admin,
    guardian,
    stranger,
    learnerB,
    adminB,
    securityAdmin,
    operator,
    P,
    Q,
    U,
  };
}

const write = (lessonId: string, status = 'in_progress') =>
  [
    `INSERT INTO lesson_progress (user_id, lesson_id, status) VALUES (app_current_actor(), $1, $2)`,
    [lessonId, status],
  ] as [string, unknown[]];

// =========================================================================
describe('RLS — writing progress', () => {
  it('lets a learner record progress on a lesson their class studies', async () => {
    const w = await world();
    expect(await attempt(w.learner.id, ...write(w.P.lesson))).toBe(true);
  });

  it('REFUSES a lesson whose course is not assigned to any class they are in', async () => {
    const w = await world();
    expect(await attempt(w.learner.id, ...write(w.U.lesson))).toBe(false);
    expect(await attempt(w.learner.id, ...write(w.Q.lesson))).toBe(false);
  });

  it('REFUSES an unpublished lesson inside an assigned course', async () => {
    const w = await world();
    expect(await attempt(w.learner.id, ...write(w.P.draftLesson))).toBe(false);
  });

  it('REFUSES a learner in no class at all', async () => {
    const w = await world();
    expect(await attempt(w.stranger.id, ...write(w.P.lesson))).toBe(false);
  });

  it('REFUSES writing a row about ANOTHER learner', async () => {
    const w = await world();
    expect(
      await attempt(
        w.learner.id,
        `INSERT INTO lesson_progress (user_id, lesson_id, status) VALUES ($1, $2, 'completed')`,
        [w.peer.id, w.P.lesson],
      ),
    ).toBe(false);
  });

  it.each([
    ['a teacher of the class', 'teacher'],
    ['an administrator', 'admin'],
    ['a verified guardian', 'guardian'],
    ['a platform operator', 'operator'],
  ])('REFUSES %s writing a record on the learner’s behalf', async (_label, who) => {
    const w = await world();
    const actorId = (w as unknown as Record<string, { id: string }>)[who]!.id;
    expect(
      await attempt(
        actorId,
        `INSERT INTO lesson_progress (user_id, lesson_id, status) VALUES ($1, $2, 'completed')`,
        [w.learner.id, w.P.lesson],
      ),
    ).toBe(false);
  });

  it('REFUSES a DELETE outright — the privilege is not granted', async () => {
    const w = await world();
    await recordProgress({ userId: w.learner.id, lessonId: w.P.lesson });
    expect(
      await attempt(
        w.learner.id,
        `DELETE FROM lesson_progress WHERE user_id = app_current_actor()`,
      ),
    ).toBe(false);
  });
});

// =========================================================================
describe('RLS — the state machine and row immutability', () => {
  it('permits forward moves and refuses backward ones', async () => {
    const w = await world();
    await recordProgress({ userId: w.learner.id, lessonId: w.P.lesson, status: 'in_progress' });
    expect(
      await attempt(
        w.learner.id,
        `UPDATE lesson_progress SET status='completed', completed_at=now() WHERE user_id=app_current_actor()`,
      ),
    ).toBe(true);
    expect(
      await attempt(
        w.learner.id,
        `UPDATE lesson_progress SET status='in_progress', completed_at=NULL WHERE user_id=app_current_actor()`,
      ),
    ).toBe(false);
    expect(
      await attempt(
        w.learner.id,
        `UPDATE lesson_progress SET status='not_started', completed_at=NULL WHERE user_id=app_current_actor()`,
      ),
    ).toBe(false);
  });

  it('REFUSES moving a completion timestamp once it is set', async () => {
    const w = await world();
    await recordProgress({ userId: w.learner.id, lessonId: w.P.lesson, status: 'completed' });
    expect(
      await attempt(
        w.learner.id,
        `UPDATE lesson_progress SET completed_at = now() - interval '30 days' WHERE user_id=app_current_actor()`,
      ),
    ).toBe(false);
  });

  it('still permits touching last_accessed_at on a completed row', async () => {
    const w = await world();
    await recordProgress({ userId: w.learner.id, lessonId: w.P.lesson, status: 'completed' });
    expect(
      await attempt(
        w.learner.id,
        `UPDATE lesson_progress SET last_accessed_at = now() WHERE user_id=app_current_actor()`,
      ),
    ).toBe(true);
  });

  it('REFUSES re-pointing a row at another learner or another lesson', async () => {
    const w = await world();
    await recordProgress({ userId: w.learner.id, lessonId: w.P.lesson });
    expect(await attempt(w.learner.id, `UPDATE lesson_progress SET user_id=$1`, [w.peer.id])).toBe(
      false,
    );
    expect(
      await attempt(w.learner.id, `UPDATE lesson_progress SET lesson_id=$1`, [w.Q.lesson]),
    ).toBe(false);
  });

  it('REFUSES a second row for the same (learner, lesson)', async () => {
    const w = await world();
    await recordProgress({ userId: w.learner.id, lessonId: w.P.lesson });
    expect(await attempt(w.learner.id, ...write(w.P.lesson))).toBe(false);
  });
});

// =========================================================================
describe('RLS — retention: access loss keeps the record, stops the writing', () => {
  it('keeps a learner’s own rows readable after they leave the class', async () => {
    const w = await world();
    await recordProgress({ userId: w.learner.id, lessonId: w.P.lesson, status: 'completed' });
    expect(await readable(w.learner.id)).toEqual([`${w.learner.id}/P`]);

    await db.withActor(w.admin.id, (tx) =>
      tx.query(
        `UPDATE class_memberships SET status='ended', ended_at=now()
          WHERE class_id=$1 AND user_id=$2`,
        [w.classA1, w.learner.id],
      ),
    );

    // Still readable — and still LEGIBLE, because the label comes from a
    // definer helper rather than a join to `lessons`, which the learner can no
    // longer see.
    expect(await readable(w.learner.id)).toEqual([`${w.learner.id}/P`]);
    const lessonsVisible = await db.withActor(
      w.learner.id,
      async (tx) => (await tx.query('SELECT id FROM lessons')).rows.length,
    );
    expect(lessonsVisible).toBe(0);
  });

  it('stops the learner writing after they leave the class', async () => {
    const w = await world();
    await recordProgress({ userId: w.learner.id, lessonId: w.P.lesson, status: 'in_progress' });
    await db.withActor(w.admin.id, (tx) =>
      tx.query(
        `UPDATE class_memberships SET status='ended', ended_at=now()
          WHERE class_id=$1 AND user_id=$2`,
        [w.classA1, w.learner.id],
      ),
    );

    await db.withActor(w.learner.id, (tx) =>
      tx.query(
        `UPDATE lesson_progress SET status='completed', completed_at=now()
          WHERE user_id=app_current_actor()`,
      ),
    );
    const status = await db.withActor(
      w.learner.id,
      async (tx) =>
        (await tx.query<{ status: string }>('SELECT status FROM lesson_progress')).rows[0]?.status,
    );
    expect(status).toBe('in_progress');
  });

  it('stops the learner writing when the course is withdrawn from the class', async () => {
    const w = await world();
    await recordProgress({ userId: w.learner.id, lessonId: w.P.lesson });
    await db.withActor(w.admin.id, (tx) =>
      tx.query(
        `UPDATE class_course_assignments SET status='inactive', ended_at=now() WHERE class_id=$1`,
        [w.classA1],
      ),
    );
    expect(await readable(w.learner.id)).toEqual([`${w.learner.id}/P`]);
    expect(
      await attempt(
        w.learner.id,
        `UPDATE lesson_progress SET status='completed', completed_at=now() WHERE user_id=app_current_actor()`,
      ),
    ).toBe(true); // the statement runs...
    const status = await db.withActor(
      w.learner.id,
      async (tx) =>
        (await tx.query<{ status: string }>('SELECT status FROM lesson_progress')).rows[0]?.status,
    );
    expect(status).toBe('in_progress'); // ...but matches no row.
  });
});

// =========================================================================
describe('RLS — who may read whose progress', () => {
  async function withRows() {
    const w = await world();
    await recordProgress({ userId: w.learner.id, lessonId: w.P.lesson });
    await recordProgress({ userId: w.peer.id, lessonId: w.P.lesson });
    await recordProgress({ userId: w.otherClassLearner.id, lessonId: w.Q.lesson });
    return w;
  }

  it('shows a learner only their own', async () => {
    const w = await withRows();
    expect(await readable(w.learner.id)).toEqual([`${w.learner.id}/P`]);
    expect(await readable(w.peer.id)).toEqual([`${w.peer.id}/P`]);
  });

  it('shows a VERIFIED guardian only their own child’s', async () => {
    const w = await withRows();
    expect(await readable(w.guardian.id)).toEqual([`${w.learner.id}/P`]);
  });

  it('shows nothing to a guardian whose claim is only PENDING', async () => {
    const w = await withRows();
    const pending = await createUser({
      email: 'pending-guardian@t.local',
      roles: ['guardian'],
      organizationId: w.orgA,
    });
    await linkGuardian(pending.id, w.learner.id, 'pending');
    expect(await readable(pending.id)).toEqual([]);
  });

  it('shows a teacher their own class’s learners, on the course assigned to it', async () => {
    const w = await withRows();
    expect(await readable(w.teacher.id)).toEqual(
      [`${w.learner.id}/P`, `${w.peer.id}/P`, `${w.otherClassLearner.id}/Q`].sort(),
    );
  });

  it('REFUSES a teacher a learner’s progress on a course assigned to a DIFFERENT class', async () => {
    // The precision case. `teacher` teaches A1 and A2; `learner` is in A1;
    // course Q is assigned to A2 only. Two coarser checks — "I teach them" and
    // "I reach that course" — would BOTH be true, and would leak.
    const w = await withRows();
    await recordProgress({ userId: w.learner.id, lessonId: w.Q.lesson });
    const seen = await readable(w.teacher.id);
    expect(seen).toContain(`${w.learner.id}/P`);
    expect(seen).not.toContain(`${w.learner.id}/Q`);
  });

  it('REFUSES a teacher of a class the learner is not in', async () => {
    const w = await withRows();
    expect(await readable(w.otherTeacher.id)).toEqual([`${w.otherClassLearner.id}/Q`]);
  });

  it('shows an ADMIN every learner in their own school, and nobody else’s', async () => {
    const w = await withRows();
    expect(await readable(w.admin.id)).toHaveLength(3);
    expect(await readable(w.adminB.id)).toEqual([]);
  });

  it('REFUSES a school SECURITY ADMIN — a different authority from account admin', async () => {
    const w = await withRows();
    expect(await readable(w.securityAdmin.id)).toEqual([]);
  });

  it('REFUSES an unrelated peer and a learner in another school', async () => {
    const w = await withRows();
    expect(await readable(w.stranger.id)).toEqual([]);
    expect(await readable(w.learnerB.id)).toEqual([]);
  });

  it('shows a platform operator everything', async () => {
    const w = await withRows();
    expect(await readable(w.operator.id)).toHaveLength(3);
  });

  it('keeps a teacher’s view after the course is withdrawn — but not after the learner leaves', async () => {
    const w = await withRows();
    // A teacher may look at what a student did last term, so the ASSIGNMENT is
    // not required to be current...
    await db.withActor(w.admin.id, (tx) =>
      tx.query(
        `UPDATE class_course_assignments SET status='inactive', ended_at=now() WHERE class_id=$1`,
        [w.classA1],
      ),
    );
    expect(await readable(w.teacher.id)).toContain(`${w.learner.id}/P`);

    // ...but the ENROLMENT is, because that is what makes them this child's
    // teacher at all.
    await db.withActor(w.admin.id, (tx) =>
      tx.query(
        `UPDATE class_memberships SET status='ended', ended_at=now()
          WHERE class_id=$1 AND user_id=$2`,
        [w.classA1, w.learner.id],
      ),
    );
    expect(await readable(w.teacher.id)).not.toContain(`${w.learner.id}/P`);
  });
});
