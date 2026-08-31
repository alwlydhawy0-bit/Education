import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../apps/api/src/platform/db.ts';
import { TEST_APP_URL } from '../setup/env.ts';
import {
  closeSeedDb,
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
 * Row-Level Security for the educational content tree.
 *
 * No application code is in the path. Every statement runs as `edu_app`
 * (NOBYPASSRLS, non-owner) with `app.actor_id` set exactly as a request would
 * set it, and every assertion is about what the DATABASE permits. If the whole
 * policy engine were deleted tomorrow, these are the boundaries that would
 * still hold.
 *
 * Its mirror is `tests/security/curriculum.test.ts`, which asserts the same
 * boundaries through the application with RLS still on, and
 * `tests/security/layered-defense.test.ts`, which asserts them through the
 * application with RLS switched OFF.
 */
const db: Database = createDatabase({ connectionString: TEST_APP_URL, poolMax: 4 });

afterAll(async () => {
  await db.close();
  await closeSeedDb();
});

beforeEach(truncateAll);

/** Runs one statement as `actorId` and reports whether the database allowed it. */
async function attempt(actorId: string, sql: string, params: unknown[] = []): Promise<boolean> {
  try {
    await db.withActor(actorId, (tx) => tx.query(sql, params));
    return true;
  } catch {
    return false;
  }
}

/** Rows the actor can actually SEE, by id. */
async function visible(actorId: string, table: string): Promise<string[]> {
  return db.withActor(actorId, async (tx) =>
    (await tx.query<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`)).rows.map((r) => r.id),
  );
}

/**
 * Two schools plus the global catalog, each with content in all three states.
 *
 * Roles are seeded to match the permission split exactly: `content_author` may
 * write drafts, `reviewer` may only move the lifecycle, `admin` holds both, and
 * a student holds neither.
 */
async function world() {
  const orgA = await createOrganization('School A');
  const orgB = await createOrganization('School B');
  const level = await createEducationLevel();

  const mk = async (email: string, roles: readonly string[], org: string | null) => {
    const user = await createUser({ email, roles, organizationId: org });
    return user;
  };

  const authorA = await mk('author-a@test.local', ['content_author'], orgA);
  const teacherA = await mk('teacher-a@test.local', ['teacher'], orgA);
  const reviewerA = await mk('reviewer-a@test.local', ['reviewer'], orgA);
  const adminA = await mk('admin-a@test.local', ['admin'], orgA);
  const studentA = await mk('student-a@test.local', ['student'], orgA);
  const authorB = await mk('author-b@test.local', ['content_author'], orgB);
  const studentB = await mk('student-b@test.local', ['student'], orgB);

  const operator = await createUser({ email: 'operator@test.local', organizationId: null });
  await grantRole(operator.id, 'security_admin', 'global', null);

  const draftA = await createCurriculum({ organizationId: orgA, code: 'math', status: 'draft' });
  const publishedA = await createCurriculum({
    organizationId: orgA,
    code: 'physics',
    status: 'published',
  });
  const archivedA = await createCurriculum({
    organizationId: orgA,
    code: 'chem',
    status: 'archived',
  });
  const publishedB = await createCurriculum({
    organizationId: orgB,
    code: 'math',
    status: 'published',
  });
  const globalPublished = await createCurriculum({
    organizationId: null,
    code: 'math',
    status: 'published',
  });
  const globalDraft = await createCurriculum({
    organizationId: null,
    code: 'bio',
    status: 'draft',
  });

  return {
    orgA,
    orgB,
    level,
    authorA,
    teacherA,
    reviewerA,
    adminA,
    studentA,
    authorB,
    studentB,
    operator,
    draftA,
    publishedA,
    archivedA,
    publishedB,
    globalPublished,
    globalDraft,
  };
}

// =========================================================================
describe('RLS — content visibility', () => {
  it('shows a student only PUBLISHED content in their own school and the global catalog', async () => {
    const w = await world();
    const seen = await visible(w.studentA.id, 'curricula');
    expect(seen.sort()).toEqual([w.publishedA, w.globalPublished].sort());
    // Not the draft, not the archived one, not School B's, not the global draft.
    expect(seen).not.toContain(w.draftA);
    expect(seen).not.toContain(w.archivedA);
    expect(seen).not.toContain(w.publishedB);
    expect(seen).not.toContain(w.globalDraft);
  });

  it('shows an AUTHOR every state of their own school, and still hides other schools', async () => {
    const w = await world();
    const seen = await visible(w.authorA.id, 'curricula');
    expect(seen.sort()).toEqual([w.draftA, w.publishedA, w.archivedA, w.globalPublished].sort());
    expect(seen).not.toContain(w.publishedB);
    // A school's author has no standing in the global catalog beyond a learner's.
    expect(seen).not.toContain(w.globalDraft);
  });

  it('shows a REVIEWER drafts too — they cannot review what they cannot see', async () => {
    const w = await world();
    expect(await visible(w.reviewerA.id, 'curricula')).toContain(w.draftA);
  });

  it('shows a platform operator everything', async () => {
    const w = await world();
    const seen = await visible(w.operator.id, 'curricula');
    expect(seen).toHaveLength(6);
  });

  it('hides a published UNIT whose course is still a draft', async () => {
    const w = await world();
    const draftCourse = await createCourse({
      organizationId: w.orgA,
      curriculumId: w.publishedA,
      levelId: w.level,
      status: 'draft',
    });
    const unit = await createUnit({ courseId: draftCourse, status: 'published' });
    expect(await visible(w.studentA.id, 'course_units')).not.toContain(unit);
    // ...and the author, who may see drafts, does see it.
    expect(await visible(w.authorA.id, 'course_units')).toContain(unit);
  });

  it('hides a published LESSON whose unit is still a draft', async () => {
    const w = await world();
    const course = await createCourse({
      organizationId: w.orgA,
      curriculumId: w.publishedA,
      levelId: w.level,
      status: 'published',
    });
    const draftUnit = await createUnit({ courseId: course, status: 'draft' });
    const lesson = await createLesson({ unitId: draftUnit, status: 'published' });
    expect(await visible(w.studentA.id, 'lessons')).not.toContain(lesson);
  });

  it('shows a lesson only when the WHOLE chain is published', async () => {
    const w = await world();
    const course = await createCourse({
      organizationId: w.orgA,
      curriculumId: w.publishedA,
      levelId: w.level,
      status: 'published',
    });
    const unit = await createUnit({ courseId: course, status: 'published' });
    const lesson = await createLesson({ unitId: unit, status: 'published' });
    expect(await visible(w.studentA.id, 'lessons')).toEqual([lesson]);
  });

  it('hides another school’s content from a student even when everything is published', async () => {
    const w = await world();
    const course = await createCourse({
      organizationId: w.orgB,
      curriculumId: w.publishedB,
      levelId: w.level,
      status: 'published',
    });
    const unit = await createUnit({ courseId: course, status: 'published' });
    const lesson = await createLesson({ unitId: unit, status: 'published' });
    expect(await visible(w.studentA.id, 'lessons')).not.toContain(lesson);
    expect(await visible(w.studentB.id, 'lessons')).toEqual([lesson]);
  });
});

// =========================================================================
describe('RLS — content writes', () => {
  it('lets an author create a DRAFT in their own school, and nothing else', async () => {
    const w = await world();
    expect(
      await attempt(
        w.authorA.id,
        `INSERT INTO curricula (organization_id, code, name, created_by) VALUES ($1,'new','X', app_current_actor())`,
        [w.orgA],
      ),
    ).toBe(true);

    expect(
      await attempt(
        w.authorA.id,
        `INSERT INTO curricula (organization_id, code, name, created_by) VALUES ($1,'sneak','X', app_current_actor())`,
        [w.orgB],
      ),
    ).toBe(false);

    expect(
      await attempt(
        w.authorA.id,
        `INSERT INTO curricula (organization_id, code, name, created_by) VALUES (NULL,'sneak','X', app_current_actor())`,
      ),
    ).toBe(false);
  });

  it('REFUSES an insert that arrives already published', async () => {
    const w = await world();
    expect(
      await attempt(
        w.authorA.id,
        `INSERT INTO curricula (organization_id, code, name, status, published_at, created_by)
         VALUES ($1,'new','X','published', now(), app_current_actor())`,
        [w.orgA],
      ),
    ).toBe(false);
  });

  it('REFUSES an author forging somebody else’s byline', async () => {
    const w = await world();
    expect(
      await attempt(
        w.authorA.id,
        `INSERT INTO curricula (organization_id, code, name, created_by) VALUES ($1,'new','X',$2)`,
        [w.orgA, w.adminA.id],
      ),
    ).toBe(false);
  });

  it('REFUSES a student writing anything', async () => {
    const w = await world();
    expect(
      await attempt(
        w.studentA.id,
        `INSERT INTO curricula (organization_id, code, name, created_by) VALUES ($1,'new','X', app_current_actor())`,
        [w.orgA],
      ),
    ).toBe(false);
  });

  it('leaves another school’s row untouched rather than erroring', async () => {
    const w = await world();
    // A silent zero-row UPDATE is the expected shape: the caller learns nothing
    // about School B, not even that the row exists.
    await db.withActor(w.authorA.id, (tx) =>
      tx.query(`UPDATE curricula SET name = 'defaced' WHERE id = $1`, [w.publishedB]),
    );
    const name = await db.withActor(
      w.authorB.id,
      async (tx) =>
        (
          await tx.query<{ name: string }>('SELECT name FROM curricula WHERE id = $1', [
            w.publishedB,
          ])
        ).rows[0]?.name,
    );
    expect(name).toBe('Mathematics');
  });
});

// =========================================================================
describe('RLS — separation of authoring from publishing', () => {
  it('REFUSES an author moving the lifecycle', async () => {
    const w = await world();
    expect(
      await attempt(
        w.authorA.id,
        `UPDATE curricula SET status='published', published_at=now() WHERE id = $1`,
        [w.draftA],
      ),
    ).toBe(false);
  });

  it('REFUSES a teacher moving the lifecycle', async () => {
    const w = await world();
    expect(
      await attempt(
        w.teacherA.id,
        `UPDATE curricula SET status='published', published_at=now() WHERE id = $1`,
        [w.draftA],
      ),
    ).toBe(false);
  });

  it('lets a REVIEWER publish, but REFUSES them editing the text', async () => {
    const w = await world();
    expect(
      await attempt(w.reviewerA.id, `UPDATE curricula SET name='rewritten' WHERE id = $1`, [
        w.draftA,
      ]),
    ).toBe(false);
    expect(
      await attempt(
        w.reviewerA.id,
        `UPDATE curricula SET status='published', published_at=now() WHERE id = $1`,
        [w.draftA],
      ),
    ).toBe(true);
  });

  it('lets an ADMIN do both, holding both permissions', async () => {
    const w = await world();
    expect(
      await attempt(w.adminA.id, `UPDATE curricula SET name='corrected' WHERE id = $1`, [w.draftA]),
    ).toBe(true);
    expect(
      await attempt(
        w.adminA.id,
        `UPDATE curricula SET status='published', published_at=now() WHERE id = $1`,
        [w.draftA],
      ),
    ).toBe(true);
  });
});

// =========================================================================
describe('RLS — lifecycle and ownership invariants', () => {
  it('REFUSES un-publishing', async () => {
    const w = await world();
    expect(
      await attempt(
        w.adminA.id,
        `UPDATE curricula SET status='draft', published_at=NULL WHERE id = $1`,
        [w.publishedA],
      ),
    ).toBe(false);
  });

  it('REFUSES reviving an archived item', async () => {
    const w = await world();
    expect(
      await attempt(
        w.adminA.id,
        `UPDATE curricula SET status='published', published_at=now(), archived_at=NULL WHERE id = $1`,
        [w.archivedA],
      ),
    ).toBe(false);
  });

  it('REFUSES moving content between the global catalog and a school', async () => {
    const w = await world();
    expect(
      await attempt(w.adminA.id, `UPDATE curricula SET organization_id = NULL WHERE id = $1`, [
        w.draftA,
      ]),
    ).toBe(false);
  });

  it('REFUSES reassigning authorship', async () => {
    const w = await world();
    expect(
      await attempt(w.adminA.id, `UPDATE curricula SET created_by = $2 WHERE id = $1`, [
        w.draftA,
        w.adminA.id,
      ]),
    ).toBe(false);
  });

  it('REFUSES moving a unit to another course, or a lesson to another unit', async () => {
    const w = await world();
    const c1 = await createCourse({
      organizationId: w.orgA,
      curriculumId: w.publishedA,
      levelId: w.level,
      title: 'One',
    });
    const c2 = await createCourse({
      organizationId: w.orgA,
      curriculumId: w.publishedA,
      levelId: w.level,
      title: 'Two',
    });
    const u1 = await createUnit({ courseId: c1 });
    const u2 = await createUnit({ courseId: c2 });
    const lesson = await createLesson({ unitId: u1 });

    expect(
      await attempt(w.adminA.id, `UPDATE course_units SET course_id = $2 WHERE id = $1`, [u1, c2]),
    ).toBe(false);
    expect(
      await attempt(w.adminA.id, `UPDATE lessons SET unit_id = $2 WHERE id = $1`, [lesson, u2]),
    ).toBe(false);
  });

  it('REFUSES deleting published content, and permits deleting a draft', async () => {
    const w = await world();
    await db.withActor(w.authorA.id, (tx) =>
      tx.query(`DELETE FROM curricula WHERE id = $1`, [w.publishedA]),
    );
    expect(await visible(w.authorA.id, 'curricula')).toContain(w.publishedA);

    await db.withActor(w.authorA.id, (tx) =>
      tx.query(`DELETE FROM curricula WHERE id = $1`, [w.draftA]),
    );
    expect(await visible(w.authorA.id, 'curricula')).not.toContain(w.draftA);
  });
});

// =========================================================================
describe('RLS — the content tree inherits authority from its root', () => {
  it('REFUSES an author of another school adding a unit or a lesson', async () => {
    const w = await world();
    const course = await createCourse({
      organizationId: w.orgA,
      curriculumId: w.publishedA,
      levelId: w.level,
    });
    const unit = await createUnit({ courseId: course });

    expect(
      await attempt(
        w.authorB.id,
        `INSERT INTO course_units (course_id, position, title, created_by) VALUES ($1, 99, 'X', app_current_actor())`,
        [course],
      ),
    ).toBe(false);
    expect(
      await attempt(
        w.authorB.id,
        `INSERT INTO lessons (unit_id, position, title, created_by) VALUES ($1, 99, 'X', app_current_actor())`,
        [unit],
      ),
    ).toBe(false);
  });

  it('REFUSES an ADMIN adding a unit to a GLOBAL course', async () => {
    const w = await world();
    const globalCourse = await createCourse({
      organizationId: null,
      curriculumId: w.globalPublished,
      levelId: w.level,
      status: 'published',
    });
    expect(
      await attempt(
        w.adminA.id,
        `INSERT INTO course_units (course_id, position, title, created_by) VALUES ($1, 99, 'X', app_current_actor())`,
        [globalCourse],
      ),
    ).toBe(false);
  });

  it('REFUSES a course filed under another school’s private curriculum', async () => {
    const w = await world();
    const privateB = await createCurriculum({
      organizationId: w.orgB,
      code: 'secret',
      status: 'draft',
    });
    expect(
      await attempt(
        w.authorA.id,
        `INSERT INTO courses (organization_id, curriculum_id, level_id, title, created_by)
         VALUES ($1, $2, $3, 'X', app_current_actor())`,
        [w.orgA, privateB, w.level],
      ),
    ).toBe(false);
  });

  it('REFUSES a GLOBAL course filed under a school’s private curriculum', async () => {
    const w = await world();
    expect(
      await attempt(
        w.operator.id,
        `INSERT INTO courses (organization_id, curriculum_id, level_id, title, created_by)
         VALUES (NULL, $1, $2, 'X', app_current_actor())`,
        [w.draftA, w.level],
      ),
    ).toBe(false);
  });
});

// =========================================================================
describe('RLS — education levels are shared vocabulary', () => {
  it('lets every authenticated actor read them', async () => {
    const w = await world();
    for (const actor of [w.studentA, w.authorA, w.studentB]) {
      expect(await visible(actor.id, 'education_levels')).toEqual([w.level]);
    }
  });

  it('REFUSES everyone but a platform operator writing one', async () => {
    const w = await world();
    for (const actor of [w.studentA, w.authorA, w.adminA]) {
      expect(
        await attempt(
          actor.id,
          `INSERT INTO education_levels (code, name, stage) VALUES ('sneak','X','middle')`,
        ),
      ).toBe(false);
    }
    expect(
      await attempt(
        w.operator.id,
        `INSERT INTO education_levels (code, name, stage) VALUES ('grade_8','Grade 8','middle')`,
      ),
    ).toBe(true);
  });
});

// =========================================================================
describe('RLS — ordering integrity', () => {
  it('REFUSES two units at the same position in one course', async () => {
    const w = await world();
    const course = await createCourse({
      organizationId: w.orgA,
      curriculumId: w.publishedA,
      levelId: w.level,
    });
    await createUnit({ courseId: course, position: 1 });
    expect(
      await attempt(
        w.authorA.id,
        `INSERT INTO course_units (course_id, position, title, created_by) VALUES ($1, 1, 'X', app_current_actor())`,
        [course],
      ),
    ).toBe(false);
  });

  it('permits a whole-sequence rewrite inside one transaction', async () => {
    const w = await world();
    const course = await createCourse({
      organizationId: w.orgA,
      curriculumId: w.publishedA,
      levelId: w.level,
    });
    const a = await createUnit({ courseId: course, position: 1, title: 'A' });
    const b = await createUnit({ courseId: course, position: 2, title: 'B' });
    const c = await createUnit({ courseId: course, position: 3, title: 'C' });

    // Deferring is what makes this possible: mid-statement, position 2 is
    // briefly occupied twice, and an immediate constraint would reject it.
    await db.withActor(w.authorA.id, async (tx) => {
      await tx.query('SET CONSTRAINTS course_units_position_uk DEFERRED');
      await tx.query(`UPDATE course_units SET position = 4 - position WHERE course_id = $1`, [
        course,
      ]);
    });

    const order = await db.withActor(w.authorA.id, async (tx) =>
      (
        await tx.query<{ id: string }>(
          `SELECT id FROM course_units WHERE course_id = $1 ORDER BY position`,
          [course],
        )
      ).rows.map((r) => r.id),
    );
    expect(order).toEqual([c, b, a]);
  });

  it('REFUSES a position below 1', async () => {
    const w = await world();
    const course = await createCourse({
      organizationId: w.orgA,
      curriculumId: w.publishedA,
      levelId: w.level,
    });
    expect(
      await attempt(
        w.authorA.id,
        `INSERT INTO course_units (course_id, position, title, created_by) VALUES ($1, 0, 'X', app_current_actor())`,
        [course],
      ),
    ).toBe(false);
  });
});
