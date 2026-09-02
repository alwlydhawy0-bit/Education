import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../apps/api/src/platform/db.ts';
import { TEST_APP_URL } from '../setup/env.ts';
import {
  addClassMember,
  assignCourseToClass,
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
  objectivesOf,
  recordProgress,
  seedDb,
  truncateAll,
} from '../setup/fixtures.ts';

/**
 * The content lifecycle, with no application code in the path.
 *
 * Every statement runs as `edu_app` (NOBYPASSRLS, non-owner) with `app.actor_id`
 * set exactly as a request would set it. If the entire policy engine were
 * deleted tomorrow, these are the boundaries that would still hold.
 *
 * THIS FILE OWNS THE IMMUTABILITY RULES. The question it answers, for every
 * column of every content table, is the one Task 010 made urgent: IF A LEARNER'S
 * EVIDENCE POINTS AT THIS ROW, CAN THIS COLUMN STILL MOVE WITHOUT CHANGING WHAT
 * THAT EVIDENCE MEANS?
 *
 * The POSITIVE cases matter as much as the negatives here, and are interleaved
 * deliberately: a migration that froze everything would pass every refusal in
 * this file while making the platform unauthorable.
 */
const db: Database = createDatabase({ connectionString: TEST_APP_URL, poolMax: 4 });

afterAll(async () => {
  await db.close();
  await closeSeedDb();
});

beforeEach(truncateAll);

/** Did the statement raise? Used where the guard is a trigger. */
async function attempt(actorId: string, sql: string, params: unknown[] = []): Promise<boolean> {
  try {
    await db.withActor(actorId, (tx) => tx.query(sql, params));
    return true;
  } catch {
    return false;
  }
}

/**
 * How many rows a statement actually changed.
 *
 * Not `attempt`: an RLS `USING` clause does not raise, it makes the row
 * invisible, so a blocked write matches ZERO rows and SUCCEEDS. "No error" is
 * what a refusal looks like, and a suite built on it would report a blocked
 * write as an allowed one.
 */
async function changedRows(actorId: string, sql: string, params: unknown[] = []): Promise<number> {
  return db.withActor(actorId, async (tx) => (await tx.query(sql, params)).rowCount ?? 0);
}

const count = (actorId: string, sql: string, params: unknown[] = []) =>
  db.withActor(actorId, async (tx) => {
    const { rows } = await tx.query<{ n: string }>(sql, params);
    return Number(rows[0]?.n ?? 0);
  });

interface World {
  orgA: string;
  orgB: string;
  author: string;
  foreignAuthor: string;
  reviewer: string;
  foreignReviewer: string;
  learner: string;
  teacher: string;
  operator: string;
  curriculum: string;
  course: string;
  unit: string;
  draftUnit: string;
  /** Published, with two objectives and one published activity. */
  lesson: string;
  objectives: Array<{ id: string; position: number; statement: string }>;
  activityId: string;
  assessmentId: string;
  classId: string;
}

async function seedWorld(): Promise<World> {
  const orgA = await createOrganization('Org A');
  const orgB = await createOrganization('Org B');

  const mk = async (email: string, org: string | null) =>
    (await createUser({ email, roles: [], organizationId: org })).id;

  const author = await mk('author@a.test', orgA);
  await grantRole(author, 'content_author', 'organization', orgA);
  const foreignAuthor = await mk('author@b.test', orgB);
  await grantRole(foreignAuthor, 'content_author', 'organization', orgB);
  const reviewer = await mk('reviewer@a.test', orgA);
  await grantRole(reviewer, 'reviewer', 'organization', orgA);
  const foreignReviewer = await mk('reviewer@b.test', orgB);
  await grantRole(foreignReviewer, 'reviewer', 'organization', orgB);
  const learner = await mk('learner@a.test', orgA);
  await grantRole(learner, 'student', 'organization', orgA);
  const teacher = await mk('teacher@a.test', orgA);
  await grantRole(teacher, 'teacher', 'organization', orgA);
  const operator = await mk('op@platform.test', null);
  await grantRole(operator, 'security_admin', 'global', null);

  const level = await createEducationLevel('grade_7');
  const curriculum = await createCurriculum({
    organizationId: orgA,
    code: 'sci',
    status: 'published',
  });
  const course = await createCourse({
    organizationId: orgA,
    curriculumId: curriculum,
    levelId: level,
    title: 'Physics',
    status: 'published',
  });
  const unit = await createUnit({ courseId: course, title: 'Mechanics', status: 'published' });
  const draftUnit = await createUnit({ courseId: course, title: 'Optics', status: 'draft' });
  const lesson = await createLesson({
    unitId: unit,
    title: "Newton's Laws",
    contentBody: 'A body remains at rest…',
    status: 'published',
    objectives: ["Explain Newton's second law", 'Apply F=ma to a trolley'],
  });

  const { activityId, assessmentId } = await createActivity({
    lessonId: lesson,
    title: 'Atoms Quiz',
    status: 'draft',
    maxAttempts: 3,
    passingPercentage: 50,
  });
  if (!assessmentId) throw new Error('seed: no assessment');
  await createQuestion({
    assessmentId,
    questionType: 'single_choice',
    prompt: 'Which one?',
    points: 2,
    options: ['Right', 'Wrong'],
    correctOptions: [0],
  });
  const sdb = await seedDb();
  await sdb.query(
    `UPDATE learning_activities SET status='published', published_at=now() WHERE id=$1`,
    [activityId],
  );

  const classId = await createClass(orgA, 'A1');
  await addClassMember(classId, learner);
  await assignCourseToClass({ classId, courseId: course });

  return {
    orgA,
    orgB,
    author,
    foreignAuthor,
    reviewer,
    foreignReviewer,
    learner,
    teacher,
    operator,
    curriculum,
    course,
    unit,
    draftUnit,
    lesson,
    objectives: await objectivesOf(lesson),
    activityId,
    assessmentId,
    classId,
  };
}

let w: World;
beforeEach(async () => {
  w = await seedWorld();
});

// =====================================================================
// The objective freeze — the most important rule in this file
// =====================================================================

describe('a published lesson’s objectives are closed', () => {
  it('THE STATEMENT CANNOT BE REWORDED', async () => {
    // `objective_evidence` records "this learner demonstrated objective X" by
    // id. The statement is what X MEANS. Rewording it after a child has
    // demonstrated it silently rewrites the claim the platform is making about
    // that child — and a typo fix is indistinguishable from a meaning change.
    expect(
      await attempt(w.author, `UPDATE learning_objectives SET statement = $2 WHERE id = $1`, [
        w.objectives[0]!.id,
        'Something entirely different',
      ]),
    ).toBe(false);
    expect((await objectivesOf(w.lesson))[0]!.statement).toBe("Explain Newton's second law");
  });

  it('…not even when the learner has already demonstrated it', async () => {
    // The case the rule exists for, stated explicitly rather than left implied.
    await recordProgress({ userId: w.learner, lessonId: w.lesson, status: 'completed' });
    expect(await count(w.learner, 'SELECT count(*) AS n FROM objective_evidence')).toBe(2);
    expect(
      await attempt(w.author, `UPDATE learning_objectives SET statement = 'X' WHERE id = $1`, [
        w.objectives[0]!.id,
      ]),
    ).toBe(false);
  });

  it('A NEW OBJECTIVE CANNOT BE ADDED', async () => {
    // Less obvious than the reword and it matters as much. Mastery is a tally
    // over a lesson's objectives; a learner who completed the lesson last term
    // has evidence for the objectives that existed THEN. A twelfth objective
    // gives them a `no_evidence` row they had no chance to earn, and their
    // recorded mastery drops without them doing anything.
    expect(
      await attempt(
        w.author,
        `INSERT INTO learning_objectives (lesson_id, position, statement) VALUES ($1, 9, 'Late')`,
        [w.lesson],
      ),
    ).toBe(false);
  });

  it('demonstrated mastery does not move when an author tries to add one', async () => {
    // The outcome, asserted rather than the mechanism: the denominator is what
    // the freeze is protecting.
    await recordProgress({ userId: w.learner, lessonId: w.lesson, status: 'completed' });
    const before = await count(
      w.learner,
      `SELECT count(*) AS n FROM learning_objectives WHERE lesson_id = $1`,
      [w.lesson],
    );
    await attempt(
      w.author,
      `INSERT INTO learning_objectives (lesson_id, position, statement) VALUES ($1, 9, 'Late')`,
      [w.lesson],
    );
    expect(
      await count(w.learner, `SELECT count(*) AS n FROM learning_objectives WHERE lesson_id = $1`, [
        w.lesson,
      ]),
    ).toBe(before);
  });

  it('THE ORDER CANNOT BE CHANGED', async () => {
    expect(
      await attempt(w.author, `UPDATE learning_objectives SET position = 9 WHERE id = $1`, [
        w.objectives[0]!.id,
      ]),
    ).toBe(false);
  });

  it('and deletion was already confined to drafts by 0021', async () => {
    expect(
      await changedRows(w.author, `DELETE FROM learning_objectives WHERE id = $1`, [
        w.objectives[0]!.id,
      ]),
    ).toBe(0);
  });

  it('BUT A DRAFT LESSON IS FULLY AUTHORABLE — the escape hatch, and the point', async () => {
    // A freeze with no draft phase would make the platform unauthorable. This is
    // what says the rules above are about publication rather than about
    // objectives.
    const draft = await createLesson({
      unitId: w.draftUnit,
      title: 'Draft',
      contentBody: 'Body',
      status: 'draft',
      objectives: ['First wording'],
    });
    const objective = (await objectivesOf(draft))[0]!;
    expect(
      await changedRows(w.author, `UPDATE learning_objectives SET statement = $2 WHERE id = $1`, [
        objective.id,
        'Better wording',
      ]),
    ).toBe(1);
    expect(
      await changedRows(
        w.author,
        `INSERT INTO learning_objectives (lesson_id, position, statement) VALUES ($1, 2, 'Second')`,
        [draft],
      ),
    ).toBe(1);
    expect(
      await changedRows(w.author, `DELETE FROM learning_objectives WHERE id = $1`, [objective.id]),
    ).toBe(1);
  });
});

// =====================================================================
// A published activity keeps the task it set
// =====================================================================

describe('a published activity’s definition is fixed', () => {
  it.each([
    ['title', `title = 'Renamed'`],
    ['instructions', `instructions = 'Do something else'`],
    ['activity_type', `activity_type = 'practice'`],
  ])('the %s cannot be changed', async (_label, assignment) => {
    // The instructions are the task a learner was given. Changing them after
    // attempts exist changes what those attempts were attempts AT — the same
    // harm 0019 refused for a question.
    expect(
      await attempt(w.author, `UPDATE learning_activities SET ${assignment} WHERE id = $1`, [
        w.activityId,
      ]),
    ).toBe(false);
  });

  it('which makes the Task 008 documentation true for the first time', async () => {
    // `docs/api/assessment.md` has claimed since Task 008 that "a published
    // activity cannot be edited". That was true of its QUESTIONS and false of
    // the activity row. Probing found the divergence; this pins the fix.
    const { rows } = await db.withActor(w.author, (tx) =>
      tx.query<{ title: string }>(`SELECT title FROM learning_activities WHERE id = $1`, [
        w.activityId,
      ]),
    );
    expect(rows[0]?.title).toBe('Atoms Quiz');
  });

  it('but a DRAFT activity is editable', async () => {
    const draft = await createActivity({ lessonId: w.lesson, title: 'Draft', status: 'draft' });
    expect(
      await changedRows(
        w.author,
        `UPDATE learning_activities SET title = 'Renamed' WHERE id = $1`,
        [draft.activityId],
      ),
    ).toBe(1);
  });

  it('and publishing or archiving it still works — the lifecycle is not frozen', async () => {
    // The freeze excludes the lifecycle columns on purpose. A guard that caught
    // them would make a published activity unarchivable.
    expect(
      await changedRows(
        w.reviewer,
        `UPDATE learning_activities SET status='archived', archived_at=now() WHERE id = $1`,
        [w.activityId],
      ),
    ).toBe(1);
  });
});

// =====================================================================
// The tree's status stays consistent, in both directions
// =====================================================================

describe('publishing walks up', () => {
  it('A LESSON CANNOT BE PUBLISHED UNDER A DRAFT UNIT', async () => {
    // A published child of an unpublished parent is invisible to learners — the
    // chain rule already sees to that — but it is a lie about state, and §10 of
    // the task names it exactly.
    const lesson = await createLesson({
      unitId: w.draftUnit,
      title: 'Early',
      contentBody: 'Body',
      status: 'draft',
    });
    expect(
      await attempt(
        w.reviewer,
        `UPDATE lessons SET status='published', published_at=now() WHERE id = $1`,
        [lesson],
      ),
    ).toBe(false);
  });

  it('a unit cannot be published under a draft course', async () => {
    const course = await createCourse({
      organizationId: w.orgA,
      curriculumId: w.curriculum,
      levelId: await createEducationLevel('grade_8'),
      title: 'Draft Course',
      status: 'draft',
    });
    const unit = await createUnit({ courseId: course, title: 'U', status: 'draft' });
    expect(
      await attempt(
        w.reviewer,
        `UPDATE course_units SET status='published', published_at=now() WHERE id = $1`,
        [unit],
      ),
    ).toBe(false);
  });

  it('a course cannot be published under a draft curriculum', async () => {
    const curriculum = await createCurriculum({
      organizationId: w.orgA,
      code: 'draftc',
      status: 'draft',
    });
    const course = await createCourse({
      organizationId: w.orgA,
      curriculumId: curriculum,
      levelId: await createEducationLevel('grade_9'),
      title: 'C',
      status: 'draft',
    });
    expect(
      await attempt(
        w.reviewer,
        `UPDATE courses SET status='published', published_at=now() WHERE id = $1`,
        [course],
      ),
    ).toBe(false);
  });

  it('and publishing IN ORDER works all the way down', async () => {
    // The positive control for the whole rule.
    const unit = w.draftUnit;
    expect(
      await changedRows(
        w.reviewer,
        `UPDATE course_units SET status='published', published_at=now() WHERE id = $1`,
        [unit],
      ),
    ).toBe(1);
    const lesson = await createLesson({
      unitId: unit,
      title: 'Now valid',
      contentBody: 'Body',
      status: 'draft',
    });
    expect(
      await changedRows(
        w.reviewer,
        `UPDATE lessons SET status='published', published_at=now() WHERE id = $1`,
        [lesson],
      ),
    ).toBe(1);
  });
});

describe('archival refuses while anything below is live', () => {
  it('A UNIT CANNOT BE ARCHIVED while a published lesson hangs off it', async () => {
    expect(
      await attempt(
        w.reviewer,
        `UPDATE course_units SET status='archived', archived_at=now() WHERE id = $1`,
        [w.unit],
      ),
    ).toBe(false);
  });

  it('a COURSE cannot be archived while a published unit hangs off it', async () => {
    expect(
      await attempt(
        w.reviewer,
        `UPDATE courses SET status='archived', archived_at=now() WHERE id = $1`,
        [w.course],
      ),
    ).toBe(false);
  });

  it('a CURRICULUM cannot be archived while a published course hangs off it', async () => {
    expect(
      await attempt(
        w.reviewer,
        `UPDATE curricula SET status='archived', archived_at=now() WHERE id = $1`,
        [w.curriculum],
      ),
    ).toBe(false);
  });

  it('a LESSON cannot be archived while a published activity hangs off it', async () => {
    expect(
      await attempt(
        w.reviewer,
        `UPDATE lessons SET status='archived', archived_at=now() WHERE id = $1`,
        [w.lesson],
      ),
    ).toBe(false);
  });

  it('ARCHIVING FROM THE BOTTOM UP WORKS — refusal is not prohibition', async () => {
    // The rule is about ORDER, not about permission. An author who means to
    // withdraw a unit can, one deliberate and separately audited step at a time.
    const step = (sql: string, id: string) => changedRows(w.reviewer, sql, [id]);
    expect(
      await step(
        `UPDATE learning_activities SET status='archived', archived_at=now() WHERE id=$1`,
        w.activityId,
      ),
    ).toBe(1);
    expect(
      await step(`UPDATE lessons SET status='archived', archived_at=now() WHERE id=$1`, w.lesson),
    ).toBe(1);
    expect(
      await step(
        `UPDATE course_units SET status='archived', archived_at=now() WHERE id=$1`,
        w.unit,
      ),
    ).toBe(1);
  });

  it('a DRAFT child does not block archival', async () => {
    // Only PUBLISHED descendants block. A draft has never been seen by a
    // learner, so withdrawing its parent takes nothing away from anyone.
    await createLesson({ unitId: w.draftUnit, title: 'Never published', status: 'draft' });
    expect(
      await changedRows(
        w.reviewer,
        `UPDATE course_units SET status='archived', archived_at=now() WHERE id=$1`,
        [w.draftUnit],
      ),
    ).toBe(1);
  });
});

// =====================================================================
// Publish validation
// =====================================================================

describe('a lesson must have something in it to publish', () => {
  it('AN EMPTY LESSON CANNOT BE PUBLISHED', async () => {
    const empty = await createLesson({ unitId: w.unit, title: 'Title only', status: 'draft' });
    expect(
      await attempt(
        w.reviewer,
        `UPDATE lessons SET status='published', published_at=now() WHERE id = $1`,
        [empty],
      ),
    ).toBe(false);
  });

  it('an external link is enough', async () => {
    // The bar is low on purpose: this catches a lesson with no lesson in it, not
    // a lesson somebody judges too short.
    const linked = await createLesson({ unitId: w.unit, title: 'Linked', status: 'draft' });
    await db.withActor(w.author, (tx) =>
      tx.query(`UPDATE lessons SET external_url = 'https://example.org/l' WHERE id = $1`, [linked]),
    );
    expect(
      await changedRows(
        w.reviewer,
        `UPDATE lessons SET status='published', published_at=now() WHERE id = $1`,
        [linked],
      ),
    ).toBe(1);
  });

  it('a lesson with NO OBJECTIVES is still publishable, deliberately', async () => {
    // Not an oversight. A reading lesson with nothing assessable is a legitimate
    // thing to publish; it records progress and produces no mastery evidence,
    // which is the honest outcome rather than a validation failure.
    const reading = await createLesson({
      unitId: w.unit,
      title: 'Just read this',
      contentBody: 'Some text',
      status: 'draft',
    });
    expect(
      await changedRows(
        w.reviewer,
        `UPDATE lessons SET status='published', published_at=now() WHERE id = $1`,
        [reading],
      ),
    ).toBe(1);
  });
});

// =====================================================================
// Who may author, and who may publish
// =====================================================================

describe('the organization boundary holds at the database', () => {
  it.each([
    ['a lesson', `UPDATE lessons SET title = 'Theirs' WHERE id = $1`, (): string => w.lesson],
    ['a course', `UPDATE courses SET title = 'Theirs' WHERE id = $1`, (): string => w.course],
    ['a unit', `UPDATE course_units SET title = 'Theirs' WHERE id = $1`, (): string => w.unit],
    [
      'a curriculum',
      `UPDATE curricula SET name = 'Theirs' WHERE id = $1`,
      (): string => w.curriculum,
    ],
  ])('AN AUTHOR OF ANOTHER ORGANIZATION CANNOT EDIT %s', async (_label, sql, id) => {
    expect(await changedRows(w.foreignAuthor, sql, [id()])).toBe(0);
  });

  it('AN AUTHOR OF ANOTHER ORGANIZATION CANNOT EDIT A DRAFT OBJECTIVE', async () => {
    const draft = await createLesson({
      unitId: w.draftUnit,
      title: 'D',
      contentBody: 'B',
      status: 'draft',
      objectives: ['Ours'],
    });
    const objective = (await objectivesOf(draft))[0]!;
    expect(
      await changedRows(
        w.foreignAuthor,
        `UPDATE learning_objectives SET statement='X' WHERE id=$1`,
        [objective.id],
      ),
    ).toBe(0);
    // `attempt`, not `changedRows`: an INSERT is refused by the policy's WITH
    // CHECK, which RAISES, where an UPDATE is hidden by its USING clause and
    // matches zero rows. Both are refusals; they arrive differently, and a
    // suite that expected one shape everywhere would report a real refusal as
    // an error.
    expect(
      await attempt(
        w.foreignAuthor,
        `INSERT INTO learning_objectives (lesson_id, position, statement) VALUES ($1, 5, 'X')`,
        [draft],
      ),
    ).toBe(false);
  });

  it('A REVIEWER OF ANOTHER ORGANIZATION CANNOT PUBLISH OR ARCHIVE', async () => {
    const draft = await createLesson({
      unitId: w.unit,
      title: 'D',
      contentBody: 'B',
      status: 'draft',
    });
    expect(
      await changedRows(
        w.foreignReviewer,
        `UPDATE lessons SET status='published', published_at=now() WHERE id=$1`,
        [draft],
      ),
    ).toBe(0);
    expect(
      await changedRows(
        w.foreignReviewer,
        `UPDATE learning_activities SET status='archived', archived_at=now() WHERE id=$1`,
        [w.activityId],
      ),
    ).toBe(0);
  });

  it('and an author of the OWNING organization can — the boundary is not a wall', async () => {
    expect(
      await changedRows(w.author, `UPDATE lessons SET title='Ours' WHERE id=$1`, [w.lesson]),
    ).toBe(1);
  });
});

describe('the author/publisher duty split holds at the database', () => {
  it('AN AUTHOR CANNOT PUBLISH', async () => {
    // `content:author` writes content; `content:publish` moves the lifecycle.
    // Holding one does not confer the other — 0016's rule, restated here so the
    // lifecycle suite covers it too.
    const draft = await createLesson({
      unitId: w.unit,
      title: 'D',
      contentBody: 'B',
      status: 'draft',
    });
    expect(
      await attempt(
        w.author,
        `UPDATE lessons SET status='published', published_at=now() WHERE id=$1`,
        [draft],
      ),
    ).toBe(false);
  });

  it('A REVIEWER CANNOT EDIT CONTENT', async () => {
    expect(
      await attempt(w.reviewer, `UPDATE lessons SET title='Theirs' WHERE id=$1`, [w.lesson]),
    ).toBe(false);
  });

  it('A LEARNER CAN DO NEITHER', async () => {
    const draft = await createLesson({
      unitId: w.unit,
      title: 'D',
      contentBody: 'B',
      status: 'draft',
    });
    expect(
      await changedRows(w.learner, `UPDATE lessons SET title='Mine' WHERE id=$1`, [w.lesson]),
    ).toBe(0);
    expect(
      await changedRows(
        w.learner,
        `UPDATE lessons SET status='published', published_at=now() WHERE id=$1`,
        [draft],
      ),
    ).toBe(0);
    expect(
      await attempt(
        w.learner,
        `INSERT INTO learning_objectives (lesson_id, position, statement) VALUES ($1, 5, 'Mine')`,
        [draft],
      ),
    ).toBe(false);
  });

  it('A TEACHER CANNOT PUBLISH either — teaching is not publishing', async () => {
    const draft = await createLesson({
      unitId: w.unit,
      title: 'D',
      contentBody: 'B',
      status: 'draft',
    });
    // A teacher carries `content:author` (RISK-ASSESS-02), so the update policy
    // ADMITS the row and it is the duty-split trigger that refuses — an error
    // rather than zero rows. The distinction is worth pinning: it is the only
    // reason this differs from the learner case above.
    expect(
      await attempt(
        w.teacher,
        `UPDATE lessons SET status='published', published_at=now() WHERE id=$1`,
        [draft],
      ),
    ).toBe(false);
  });
});

// =====================================================================
// Draft content does not exist, as far as a learner is concerned
// =====================================================================

describe('draft leakage', () => {
  let draftLesson: string;
  let draftObjective: string;
  let draftActivity: string;

  beforeEach(async () => {
    draftLesson = await createLesson({
      unitId: w.unit,
      title: 'Secret',
      contentBody: 'Unreviewed',
      status: 'draft',
      objectives: ['Unreviewed objective'],
    });
    draftObjective = (await objectivesOf(draftLesson))[0]!.id;
    draftActivity = (await createActivity({ lessonId: draftLesson, title: 'S', status: 'draft' }))
      .activityId;
  });

  it('a learner cannot see a draft LESSON', async () => {
    expect(
      await count(w.learner, `SELECT count(*) AS n FROM lessons WHERE id=$1`, [draftLesson]),
    ).toBe(0);
  });

  it('a learner cannot see a draft OBJECTIVE', async () => {
    expect(
      await count(w.learner, `SELECT count(*) AS n FROM learning_objectives WHERE id=$1`, [
        draftObjective,
      ]),
    ).toBe(0);
  });

  it('a learner cannot see a draft ACTIVITY', async () => {
    expect(
      await count(w.learner, `SELECT count(*) AS n FROM learning_activities WHERE id=$1`, [
        draftActivity,
      ]),
    ).toBe(0);
  });

  it('a learner cannot STUDY a draft lesson, so it generates no evidence', async () => {
    // The write gate, not just the read gate: a draft lesson must not be able to
    // become progress, and therefore must not be able to become mastery evidence.
    expect(
      await attempt(
        w.learner,
        `INSERT INTO lesson_progress (user_id, lesson_id, status, completed_at)
         VALUES ($1, $2, 'completed', now())`,
        [w.learner, draftLesson],
      ),
    ).toBe(false);
    expect(await count(w.learner, `SELECT count(*) AS n FROM objective_evidence`)).toBe(0);
  });

  it('an UNFILTERED select leaks no draft to a learner', async () => {
    // Not "the endpoint filters" — the learner's own database connection cannot
    // see the rows, with arbitrary SQL and no WHERE clause.
    const visible = await count(
      w.learner,
      `SELECT count(*) AS n FROM learning_objectives o
        JOIN lessons l ON l.id = o.lesson_id
       WHERE l.status <> 'published'`,
    );
    expect(visible).toBe(0);
  });

  it('but an AUTHOR of the owning school sees their own drafts', async () => {
    expect(
      await count(w.author, `SELECT count(*) AS n FROM lessons WHERE id=$1`, [draftLesson]),
    ).toBe(1);
    expect(
      await count(w.author, `SELECT count(*) AS n FROM learning_objectives WHERE id=$1`, [
        draftObjective,
      ]),
    ).toBe(1);
  });

  it('and an author of ANOTHER organization does not', async () => {
    expect(
      await count(w.foreignAuthor, `SELECT count(*) AS n FROM lessons WHERE id=$1`, [draftLesson]),
    ).toBe(0);
    expect(
      await count(w.foreignAuthor, `SELECT count(*) AS n FROM learning_objectives WHERE id=$1`, [
        draftObjective,
      ]),
    ).toBe(0);
  });
});

// =====================================================================
// Historical data survives content changes
// =====================================================================

describe('historical evidence and attempts survive the lifecycle', () => {
  it('ARCHIVING PRESERVES ATTEMPTS, PROGRESS AND EVIDENCE', async () => {
    await recordProgress({ userId: w.learner, lessonId: w.lesson, status: 'completed' });
    const sdb = await seedDb();
    await sdb.query(`INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1,$2)`, [
      w.assessmentId,
      w.learner,
    ]);
    await sdb.query(`UPDATE assessment_attempts SET status='submitted' WHERE assessment_id=$1`, [
      w.assessmentId,
    ]);

    const evidenceBefore = await count(w.learner, `SELECT count(*) AS n FROM objective_evidence`);
    expect(evidenceBefore).toBeGreaterThan(0);

    // Archive the whole branch, bottom up.
    await changedRows(
      w.reviewer,
      `UPDATE learning_activities SET status='archived', archived_at=now() WHERE id=$1`,
      [w.activityId],
    );
    await changedRows(
      w.reviewer,
      `UPDATE lessons SET status='archived', archived_at=now() WHERE id=$1`,
      [w.lesson],
    );

    expect(await count(w.learner, `SELECT count(*) AS n FROM objective_evidence`)).toBe(
      evidenceBefore,
    );
    expect(await count(w.learner, `SELECT count(*) AS n FROM assessment_attempts`)).toBe(1);
    expect(await count(w.learner, `SELECT count(*) AS n FROM lesson_progress`)).toBe(1);
  });

  it('an archived lesson stops being STUDIABLE but keeps being REMEMBERED', async () => {
    // The retention rule meeting the lifecycle: withdrawing content ends new
    // learning, and does not erase what a child already did.
    await recordProgress({ userId: w.learner, lessonId: w.lesson, status: 'completed' });
    await changedRows(
      w.reviewer,
      `UPDATE learning_activities SET status='archived', archived_at=now() WHERE id=$1`,
      [w.activityId],
    );
    await changedRows(
      w.reviewer,
      `UPDATE lessons SET status='archived', archived_at=now() WHERE id=$1`,
      [w.lesson],
    );
    expect(
      await count(
        w.learner,
        `SELECT count(*) AS n FROM (SELECT app_actor_may_study_lesson($1) s) t WHERE t.s`,
        [w.lesson],
      ),
    ).toBe(0);
    expect(await count(w.learner, `SELECT count(*) AS n FROM lesson_progress`)).toBe(1);
  });

  it('AN ATTEMPT CANNOT BE RE-POINTED AT ANOTHER ASSESSMENT', async () => {
    // §18: historical attempts must not become attached to a different
    // assessment. 0019's submit guard already refuses it; asserted here because
    // it is a content-lifecycle property as much as an assessment one.
    const other = await createActivity({ lessonId: w.lesson, title: 'Other', status: 'draft' });
    const sdb = await seedDb();
    const { rows } = await sdb.query<{ id: string }>(
      `INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1,$2) RETURNING id`,
      [w.assessmentId, w.learner],
    );
    await sdb.query(`UPDATE assessment_attempts SET status='submitted' WHERE id=$1`, [rows[0]!.id]);
    // `changedRows`: the learner's update policy carries `status='in_progress'`
    // in its USING clause, so a SUBMITTED attempt is invisible to the statement
    // and it succeeds against zero rows. "No error" is what the refusal looks
    // like here, so the assertion reads the row back as well.
    expect(
      await changedRows(w.learner, `UPDATE assessment_attempts SET assessment_id=$2 WHERE id=$1`, [
        rows[0]!.id,
        other.assessmentId,
      ]),
    ).toBe(0);
    const { rows: after } = await db.withActor(w.learner, (tx) =>
      tx.query<{ assessment_id: string }>(
        `SELECT assessment_id FROM assessment_attempts WHERE id = $1`,
        [rows[0]!.id],
      ),
    );
    expect(after[0]?.assessment_id).toBe(w.assessmentId);
  });
});
