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
  truncateAll,
} from '../setup/fixtures.ts';

/**
 * Row-Level Security for course-to-class assignments, and for the narrowing
 * they cause.
 *
 * No application code is in the path. Every statement runs as `edu_app`
 * (NOBYPASSRLS, non-owner) with `app.actor_id` set exactly as a request would
 * set it. If the whole policy engine were deleted tomorrow, these are the
 * boundaries that would still hold.
 *
 * Its mirror is `tests/security/class-courses.test.ts`, which asserts the same
 * boundaries through the application, and `layered-defense.test.ts`, which
 * asserts them through the application with RLS switched OFF.
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

/** Rows the actor can actually SEE, by title. */
async function titles(actorId: string, table: string, column = 'title'): Promise<string[]> {
  return db.withActor(actorId, async (tx) =>
    (
      await tx.query<{ t: string }>(`SELECT ${column} AS t FROM ${table} ORDER BY ${column}`)
    ).rows.map((r) => r.t),
  );
}

/**
 * Two schools, each with a class, a published course, and the global catalog.
 *
 * Nothing is assigned. Every test assigns exactly what it means to test, so a
 * missing assignment shows up as an absence rather than as silent visibility.
 */
async function world() {
  const orgA = await createOrganization('School A');
  const orgB = await createOrganization('School B');
  const level = await createEducationLevel();

  const adminA = await createUser({
    email: 'admin-a@t.local',
    roles: ['admin'],
    organizationId: orgA,
  });
  const teacherA = await createUser({
    email: 'teacher-a@t.local',
    roles: ['teacher'],
    organizationId: orgA,
  });
  const otherTeacherA = await createUser({
    email: 'teacher2-a@t.local',
    roles: ['teacher'],
    organizationId: orgA,
  });
  const studentA = await createUser({ email: 'student-a@t.local', organizationId: orgA });
  const otherStudentA = await createUser({ email: 'student2-a@t.local', organizationId: orgA });
  const authorA = await createUser({
    email: 'author-a@t.local',
    roles: ['content_author'],
    organizationId: orgA,
  });
  const adminB = await createUser({
    email: 'admin-b@t.local',
    roles: ['admin'],
    organizationId: orgB,
  });
  const studentB = await createUser({ email: 'student-b@t.local', organizationId: orgB });
  const operator = await createUser({ email: 'op@t.local', organizationId: null });
  await grantRole(operator.id, 'security_admin', 'global', null);

  const classA = await createClass(orgA, 'Class A');
  const otherClassA = await createClass(orgA, 'Other Class A');
  const classB = await createClass(orgB, 'Class B');
  await addClassMember(classA, studentA.id);
  await addClassMember(otherClassA, otherStudentA.id);
  await addClassMember(classB, studentB.id);
  await assignTeacher(teacherA.id, classA);
  await assignTeacher(otherTeacherA.id, otherClassA);

  const curriculumA = await createCurriculum({ organizationId: orgA, status: 'published' });
  const curriculumB = await createCurriculum({ organizationId: orgB, status: 'published' });
  const curriculumG = await createCurriculum({
    organizationId: null,
    code: 'national',
    status: 'published',
  });

  const mkCourse = async (
    organizationId: string | null,
    curriculumId: string,
    title: string,
    status: 'draft' | 'published' | 'archived' = 'published',
  ) => {
    const course = await createCourse({
      organizationId,
      curriculumId,
      levelId: level,
      title,
      status,
    });
    const unit = await createUnit({
      courseId: course,
      title: `${title} Unit`,
      status: 'published',
    });
    await createLesson({ unitId: unit, title: `${title} Lesson`, status: 'published' });
    return course;
  };

  return {
    orgA,
    orgB,
    level,
    classA,
    otherClassA,
    classB,
    adminA,
    teacherA,
    otherTeacherA,
    studentA,
    otherStudentA,
    authorA,
    adminB,
    studentB,
    operator,
    curriculumA,
    curriculumB,
    curriculumG,
    coursePhysicsA: await mkCourse(orgA, curriculumA, 'A Physics'),
    courseChemA: await mkCourse(orgA, curriculumA, 'A Chemistry'),
    draftA: await mkCourse(orgA, curriculumA, 'A Draft', 'draft'),
    courseB: await mkCourse(orgB, curriculumB, 'B Physics'),
    courseGlobal: await mkCourse(null, curriculumG, 'Global Physics'),
  };
}

// =========================================================================
describe('RLS — the narrowing', () => {
  it('shows a learner NOTHING until a course is assigned to their class', async () => {
    const w = await world();
    expect(await titles(w.studentA.id, 'courses')).toEqual([]);

    await assignCourseToClass({ classId: w.classA, courseId: w.coursePhysicsA });
    expect(await titles(w.studentA.id, 'courses')).toEqual(['A Physics']);
  });

  it('narrows units and lessons the same way', async () => {
    const w = await world();
    expect(await titles(w.studentA.id, 'course_units')).toEqual([]);
    expect(await titles(w.studentA.id, 'lessons')).toEqual([]);

    await assignCourseToClass({ classId: w.classA, courseId: w.coursePhysicsA });
    expect(await titles(w.studentA.id, 'course_units')).toEqual(['A Physics Unit']);
    expect(await titles(w.studentA.id, 'lessons')).toEqual(['A Physics Lesson']);
  });

  it('shows a learner ONLY what their own class studies', async () => {
    const w = await world();
    await assignCourseToClass({ classId: w.classA, courseId: w.coursePhysicsA });
    await assignCourseToClass({ classId: w.otherClassA, courseId: w.courseChemA });

    expect(await titles(w.studentA.id, 'courses')).toEqual(['A Physics']);
    expect(await titles(w.otherStudentA.id, 'courses')).toEqual(['A Chemistry']);
  });

  it('does NOT narrow the CURRICULUM catalog — subjects stay browsable', async () => {
    const w = await world();
    // Deliberate: a learner may know their school teaches mathematics before
    // anybody assigns them a maths course.
    expect(await titles(w.studentA.id, 'curricula', 'name')).toEqual([
      'Mathematics',
      'Mathematics',
    ]);
  });

  it('leaves EDITORIAL visibility untouched — no assignment required', async () => {
    const w = await world();
    // Staff read their own school's content, drafts included, because they
    // maintain it rather than study it — and the PUBLISHED global catalog,
    // because choosing what to assign means browsing the candidates.
    const expected = ['A Chemistry', 'A Draft', 'A Physics', 'Global Physics'];
    expect(await titles(w.authorA.id, 'courses')).toEqual(expected);
    expect(await titles(w.adminA.id, 'courses')).toEqual(expected);
    // Not another school's, at any status.
    expect(await titles(w.authorA.id, 'courses')).not.toContain('B Physics');
  });

  it('gives a class-attached actor with NO content permission access through the assignment', async () => {
    const w = await world();
    // Isolates `app_actor_teaches_course`. Every real teacher today also holds
    // `content:author`, which already covers the published catalog — so the
    // class route is currently redundant FOR THEM. This actor teaches the class
    // and holds no content permission at all, which is the only way to show the
    // branch does real work and would still carry a teacher if that role
    // mapping ever changed.
    const bare = await createUser({ email: 'bare@t.local', organizationId: w.orgA });
    await assignTeacher(bare.id, w.classA);
    expect(await titles(bare.id, 'courses')).toEqual([]);

    await assignCourseToClass({ classId: w.classA, courseId: w.courseGlobal });
    expect(await titles(bare.id, 'courses')).toEqual(['Global Physics']);
    // ...and an equally bare actor attached to a DIFFERENT class sees nothing.
    const elsewhere = await createUser({ email: 'bare2@t.local', organizationId: w.orgA });
    await assignTeacher(elsewhere.id, w.otherClassA);
    expect(await titles(elsewhere.id, 'courses')).toEqual([]);
  });

  it('lets a platform operator see everything, assigned or not', async () => {
    const w = await world();
    expect(await titles(w.operator.id, 'courses')).toHaveLength(5);
  });
});

// =========================================================================
describe('RLS — an assignment can only NARROW, never widen', () => {
  // These rows CANNOT be created — the scope trigger refuses them for everyone,
  // superuser included, which is asserted in "who may assign" below. They are
  // forced into existence here for one reason: to prove the READ policies
  // defend themselves. A catalog check that is only ever reached through the
  // write-side trigger has not actually been tested, and if the trigger were
  // ever dropped the read path is what would have to hold.

  it('does not reveal another school’s course even when one is forced into the class', async () => {
    const w = await world();
    await assignCourseToClass({ classId: w.classA, courseId: w.courseB, force: true });
    expect(await titles(w.studentA.id, 'courses')).toEqual([]);
    expect(await titles(w.studentA.id, 'course_units')).toEqual([]);
    expect(await titles(w.studentA.id, 'lessons')).toEqual([]);
  });

  it('does not reveal a DRAFT course even when one is forced into the class', async () => {
    const w = await world();
    await assignCourseToClass({ classId: w.classA, courseId: w.draftA, force: true });
    expect(await titles(w.studentA.id, 'courses')).toEqual([]);
  });

  it('does not reveal an ARCHIVED course even when one is forced into the class', async () => {
    const w = await world();
    const archived = await createCourse({
      organizationId: w.orgA,
      curriculumId: w.curriculumA,
      levelId: w.level,
      title: 'A Retired',
      status: 'archived',
    });
    await assignCourseToClass({ classId: w.classA, courseId: archived, force: true });
    expect(await titles(w.studentA.id, 'courses')).toEqual([]);
  });

  it('refuses those rows through the ordinary path, for everybody', async () => {
    const w = await world();
    // The forced inserts above are the exception that proves this rule: the
    // trigger is not an RLS policy, so it binds the table owner and the
    // superuser too.
    await expect(assignCourseToClass({ classId: w.classA, courseId: w.courseB })).rejects.toThrow(
      /own organization/,
    );
    await expect(assignCourseToClass({ classId: w.classA, courseId: w.draftA })).rejects.toThrow(
      /published/,
    );
  });
});

// =========================================================================
describe('RLS — revocation is instant', () => {
  it('revokes on withdrawing the assignment', async () => {
    const w = await world();
    const assignment = await assignCourseToClass({
      classId: w.classA,
      courseId: w.coursePhysicsA,
    });
    expect(await titles(w.studentA.id, 'lessons')).toEqual(['A Physics Lesson']);

    await db.withActor(w.adminA.id, (tx) =>
      tx.query(
        `UPDATE class_course_assignments SET status='inactive', ended_at=now() WHERE id=$1`,
        [assignment],
      ),
    );
    expect(await titles(w.studentA.id, 'lessons')).toEqual([]);
  });

  it('revokes on ending the membership', async () => {
    const w = await world();
    await assignCourseToClass({ classId: w.classA, courseId: w.coursePhysicsA });
    expect(await titles(w.studentA.id, 'courses')).toEqual(['A Physics']);

    await db.withActor(w.adminA.id, (tx) =>
      tx.query(
        `UPDATE class_memberships SET status='ended', ended_at=now()
          WHERE class_id=$1 AND user_id=$2`,
        [w.classA, w.studentA.id],
      ),
    );
    expect(await titles(w.studentA.id, 'courses')).toEqual([]);
    expect(await titles(w.studentA.id, 'lessons')).toEqual([]);
  });

  it('revokes on archiving the class, and archives its assignments', async () => {
    const w = await world();
    await assignCourseToClass({ classId: w.classA, courseId: w.coursePhysicsA });

    await db.withActor(w.adminA.id, (tx) =>
      tx.query(`UPDATE classes SET status='archived', archived_at=now() WHERE id=$1`, [w.classA]),
    );
    expect(await titles(w.studentA.id, 'courses')).toEqual([]);

    const statuses = await db.withActor(w.operator.id, async (tx) =>
      (
        await tx.query<{ status: string }>(
          `SELECT status FROM class_course_assignments WHERE class_id=$1`,
          [w.classA],
        )
      ).rows.map((r) => r.status),
    );
    expect(statuses).toEqual(['archived']);
  });
});

// =========================================================================
describe('RLS — who may assign', () => {
  const insert = (classId: string, courseId: string): [string, unknown[]] => [
    `INSERT INTO class_course_assignments (class_id, course_id, assigned_by)
     VALUES ($1, $2, app_current_actor())`,
    [classId, courseId],
  ];

  it('lets an ADMIN of the class’s school and a TEACHER OF THAT CLASS assign', async () => {
    const w = await world();
    expect(await attempt(w.adminA.id, ...insert(w.classA, w.coursePhysicsA))).toBe(true);
    expect(await attempt(w.teacherA.id, ...insert(w.classA, w.courseChemA))).toBe(true);
  });

  it('REFUSES a teacher who does not teach that class', async () => {
    const w = await world();
    expect(await attempt(w.otherTeacherA.id, ...insert(w.classA, w.coursePhysicsA))).toBe(false);
  });

  it('REFUSES a student and a content author', async () => {
    const w = await world();
    expect(await attempt(w.studentA.id, ...insert(w.classA, w.coursePhysicsA))).toBe(false);
    expect(await attempt(w.authorA.id, ...insert(w.classA, w.coursePhysicsA))).toBe(false);
  });

  it('REFUSES both directions of a cross-school assignment', async () => {
    const w = await world();
    expect(await attempt(w.adminB.id, ...insert(w.classA, w.courseB))).toBe(false);
    expect(await attempt(w.adminA.id, ...insert(w.classB, w.coursePhysicsA))).toBe(false);
    expect(await attempt(w.adminA.id, ...insert(w.classA, w.courseB))).toBe(false);
  });

  it('ALLOWS a GLOBAL course — the one case where the organizations differ', async () => {
    const w = await world();
    expect(await attempt(w.adminA.id, ...insert(w.classA, w.courseGlobal))).toBe(true);
  });

  it('REFUSES a DRAFT course', async () => {
    const w = await world();
    expect(await attempt(w.adminA.id, ...insert(w.classA, w.draftA))).toBe(false);
  });

  it('REFUSES a duplicate ACTIVE assignment, and allows one after withdrawal', async () => {
    const w = await world();
    expect(await attempt(w.adminA.id, ...insert(w.classA, w.coursePhysicsA))).toBe(true);
    expect(await attempt(w.adminA.id, ...insert(w.classA, w.coursePhysicsA))).toBe(false);

    await db.withActor(w.adminA.id, (tx) =>
      tx.query(`UPDATE class_course_assignments SET status='inactive', ended_at=now()`),
    );
    // History may repeat: each spell keeps its own row and its own dates.
    expect(await attempt(w.adminA.id, ...insert(w.classA, w.coursePhysicsA))).toBe(true);
  });

  it('REFUSES an insert that arrives withdrawn, or forges the assigner', async () => {
    const w = await world();
    expect(
      await attempt(
        w.adminA.id,
        `INSERT INTO class_course_assignments (class_id, course_id, assigned_by, status, ended_at)
         VALUES ($1, $2, app_current_actor(), 'inactive', now())`,
        [w.classA, w.coursePhysicsA],
      ),
    ).toBe(false);
    expect(
      await attempt(
        w.adminA.id,
        `INSERT INTO class_course_assignments (class_id, course_id, assigned_by)
         VALUES ($1, $2, $3)`,
        [w.classA, w.coursePhysicsA, w.teacherA.id],
      ),
    ).toBe(false);
  });

  it('REFUSES assigning to an ARCHIVED class', async () => {
    const w = await world();
    await db.withActor(w.adminA.id, (tx) =>
      tx.query(`UPDATE classes SET status='archived', archived_at=now() WHERE id=$1`, [w.classA]),
    );
    expect(await attempt(w.adminA.id, ...insert(w.classA, w.coursePhysicsA))).toBe(false);
  });
});

// =========================================================================
describe('RLS — assignment immutability and visibility', () => {
  it('REFUSES re-pointing an assignment at another class or course', async () => {
    const w = await world();
    const assignment = await assignCourseToClass({
      classId: w.classA,
      courseId: w.coursePhysicsA,
    });
    expect(
      await attempt(w.adminA.id, `UPDATE class_course_assignments SET class_id=$2 WHERE id=$1`, [
        assignment,
        w.otherClassA,
      ]),
    ).toBe(false);
    expect(
      await attempt(w.adminA.id, `UPDATE class_course_assignments SET course_id=$2 WHERE id=$1`, [
        assignment,
        w.courseChemA,
      ]),
    ).toBe(false);
  });

  it('REFUSES reopening an archived assignment', async () => {
    const w = await world();
    const assignment = await assignCourseToClass({
      classId: w.classA,
      courseId: w.coursePhysicsA,
      status: 'archived',
    });
    // Refused twice over: the UPDATE policy's USING excludes archived rows, and
    // the trigger refuses the transition.
    await db.withActor(w.adminA.id, (tx) =>
      tx.query(`UPDATE class_course_assignments SET status='active', ended_at=NULL WHERE id=$1`, [
        assignment,
      ]),
    );
    const status = await db.withActor(
      w.operator.id,
      async (tx) =>
        (
          await tx.query<{ status: string }>(
            `SELECT status FROM class_course_assignments WHERE id=$1`,
            [assignment],
          )
        ).rows[0]?.status,
    );
    expect(status).toBe('archived');
  });

  it('shows the syllabus to the class, and to nobody else', async () => {
    const w = await world();
    await assignCourseToClass({ classId: w.classA, courseId: w.coursePhysicsA });
    const seen = async (id: string) =>
      db.withActor(
        id,
        async (tx) => (await tx.query('SELECT id FROM class_course_assignments')).rows.length,
      );

    expect(await seen(w.studentA.id)).toBe(1);
    expect(await seen(w.teacherA.id)).toBe(1);
    expect(await seen(w.adminA.id)).toBe(1);
    // Not the student of another class, not another school's admin.
    expect(await seen(w.otherStudentA.id)).toBe(0);
    expect(await seen(w.adminB.id)).toBe(0);
    expect(await seen(w.studentB.id)).toBe(0);
  });

  it('REFUSES a student or a foreign admin withdrawing', async () => {
    const w = await world();
    const assignment = await assignCourseToClass({
      classId: w.classA,
      courseId: w.coursePhysicsA,
    });
    for (const actor of [w.studentA, w.adminB]) {
      await db.withActor(actor.id, (tx) =>
        tx.query(
          `UPDATE class_course_assignments SET status='inactive', ended_at=now() WHERE id=$1`,
          [assignment],
        ),
      );
    }
    const status = await db.withActor(
      w.adminA.id,
      async (tx) =>
        (
          await tx.query<{ status: string }>(
            `SELECT status FROM class_course_assignments WHERE id=$1`,
            [assignment],
          )
        ).rows[0]?.status,
    );
    expect(status).toBe('active');
  });
});
