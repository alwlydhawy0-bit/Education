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
  objectivesOf,
  seedDb,
  truncateAll,
} from '../setup/fixtures.ts';

/**
 * Objectives, evidence and mastery, with no application code in the path.
 *
 * Every statement runs as `edu_app` (NOBYPASSRLS, non-owner) with `app.actor_id`
 * set exactly as a request would set it. If the entire policy engine were
 * deleted tomorrow, these are the boundaries that would still hold.
 *
 * THIS FILE OWNS THE MASTERY RULES. They live in `app_objective_mastery` — SQL,
 * SECURITY DEFINER, self-authorizing — so this is the only place they can be
 * tested. A TypeScript re-implementation would be a second answer to the
 * question "what does this child understand?", and the two would eventually
 * disagree about a real learner.
 *
 * Its mirrors are `tests/security/mastery.test.ts` (the same boundaries through
 * HTTP) and `layered-defense.test.ts` (the same boundaries with RLS switched
 * off).
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

/**
 * How many rows a statement actually changed.
 *
 * Not `attempt`: an RLS `USING` clause does not raise, it makes the row
 * invisible, so a blocked UPDATE or DELETE matches ZERO rows and SUCCEEDS.
 * Recorded in 0018's suite for the same reason.
 */
async function changedRows(actorId: string, sql: string, params: unknown[] = []): Promise<number> {
  return db.withActor(actorId, async (tx) => (await tx.query(sql, params)).rowCount ?? 0);
}

async function count(actorId: string, sql: string, params: unknown[] = []): Promise<number> {
  return db.withActor(actorId, async (tx) => {
    const { rows } = await tx.query<{ n: string }>(sql, params);
    return Number(rows[0]?.n ?? 0);
  });
}

/** The mastery state as a given reader sees it. */
async function masteryFor(
  actorId: string,
  learnerId: string,
  objectiveId: string,
): Promise<string> {
  return db.withActor(actorId, async (tx) => {
    const { rows } = await tx.query<{ m: string }>(`SELECT app_objective_mastery($1, $2) AS m`, [
      learnerId,
      objectiveId,
    ]);
    return rows[0]?.m ?? 'ERROR';
  });
}

const asSuperuser = async (sql: string, params: unknown[] = []): Promise<void> => {
  const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
  await raw.connect();
  try {
    await raw.query(sql, params);
  } finally {
    await raw.end();
  }
};

interface World {
  orgA: string;
  orgB: string;
  learner: string;
  peer: string;
  teacher: string;
  strangerTeacher: string;
  foreignTeacher: string;
  foreignAdmin: string;
  guardian: string;
  admin: string;
  securityAdmin: string;
  operator: string;
  author: string;
  classA1: string;
  lessonA: string;
  draftLesson: string;
  /** Three objectives on lessonA, in authored order. */
  objectives: Array<{ id: string; position: number; statement: string }>;
  courseA: string;
  unitA: string;
  /** A published assessment on lessonA, passable with `correct`. */
  quiz: { assessmentId: string; questionId: string; correct: string; wrong: string };
  quiz2: { assessmentId: string; questionId: string; correct: string; wrong: string };
}

async function seedWorld(): Promise<World> {
  const orgA = await createOrganization('Org A');
  const orgB = await createOrganization('Org B');

  const mk = async (email: string, org: string | null) =>
    (await createUser({ email, roles: [], organizationId: org })).id;

  const learner = await mk('learner@a.test', orgA);
  await grantRole(learner, 'student', 'organization', orgA);
  const peer = await mk('peer@a.test', orgA);
  await grantRole(peer, 'student', 'organization', orgA);
  const teacher = await mk('teacher@a.test', orgA);
  await grantRole(teacher, 'teacher', 'organization', orgA);
  const strangerTeacher = await mk('stranger@a.test', orgA);
  await grantRole(strangerTeacher, 'teacher', 'organization', orgA);
  const foreignTeacher = await mk('teacher@b.test', orgB);
  await grantRole(foreignTeacher, 'teacher', 'organization', orgB);
  const foreignAdmin = await mk('admin@b.test', orgB);
  await grantRole(foreignAdmin, 'admin', 'organization', orgB);
  const guardian = await mk('guardian@a.test', orgA);
  await grantRole(guardian, 'guardian', 'organization', orgA);
  const admin = await mk('admin@a.test', orgA);
  await grantRole(admin, 'admin', 'organization', orgA);
  const securityAdmin = await mk('sec@a.test', orgA);
  await grantRole(securityAdmin, 'security_admin', 'organization', orgA);
  const operator = await mk('op@platform.test', null);
  await grantRole(operator, 'security_admin', 'global', null);
  const author = await mk('author@a.test', orgA);
  await grantRole(author, 'content_author', 'organization', orgA);

  const classA1 = await createClass(orgA, 'A1');
  await addClassMember(classA1, learner);
  await assignTeacher(teacher, classA1);
  await linkGuardian(guardian, learner, 'verified');

  const level = await createEducationLevel('grade_7');
  const curriculum = await createCurriculum({
    organizationId: orgA,
    code: 'sci',
    status: 'published',
  });
  const courseA = await createCourse({
    organizationId: orgA,
    curriculumId: curriculum,
    levelId: level,
    title: 'Physics',
    status: 'published',
  });
  const unitA = await createUnit({ courseId: courseA, title: 'Mechanics', status: 'published' });
  const lessonA = await createLesson({
    unitId: unitA,
    title: "Newton's Laws",
    status: 'published',
    objectives: [
      "Explain Newton's second law",
      'Apply F=ma to a trolley',
      'Distinguish mass from weight',
    ],
  });
  const draftLesson = await createLesson({
    unitId: unitA,
    title: 'Momentum',
    status: 'draft',
    objectives: ['Define momentum'],
  });
  await assignCourseToClass({ classId: classA1, courseId: courseA });

  const mkQuiz = async (title: string) => {
    const { activityId, assessmentId } = await createActivity({
      lessonId: lessonA,
      title,
      status: 'draft',
      maxAttempts: 5,
      passingPercentage: 50,
    });
    if (!assessmentId) throw new Error('seed: no assessment');
    const q = await createQuestion({
      assessmentId,
      questionType: 'single_choice',
      prompt: `${title}?`,
      points: 2,
      options: ['Right', 'Wrong'],
      correctOptions: [0],
    });
    await asSuperuser(
      `UPDATE learning_activities SET status='published', published_at=now() WHERE id=$1`,
      [activityId],
    );
    return {
      assessmentId,
      questionId: q.questionId,
      correct: q.correctOptionIds[0]!,
      wrong: q.optionIds.find((id) => !q.correctOptionIds.includes(id))!,
    };
  };

  return {
    orgA,
    orgB,
    learner,
    peer,
    teacher,
    strangerTeacher,
    foreignTeacher,
    foreignAdmin,
    guardian,
    admin,
    securityAdmin,
    operator,
    author,
    classA1,
    lessonA,
    draftLesson,
    objectives: await objectivesOf(lessonA),
    courseA,
    unitA,
    quiz: await mkQuiz('Quiz One'),
    quiz2: await mkQuiz('Quiz Two'),
  };
}

let w: World;
beforeEach(async () => {
  w = await seedWorld();
});

/** Sits an assessment as the learner and submits it. Returns the attempt id. */
async function sit(
  learnerId: string,
  quiz: World['quiz'],
  answer: 'right' | 'wrong',
): Promise<string> {
  return db.withActor(learnerId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1, $2) RETURNING id`,
      [quiz.assessmentId, learnerId],
    );
    const id = rows[0]!.id;
    await tx.query(
      `INSERT INTO assessment_attempt_answers (attempt_id, question_id, option_id)
       VALUES ($1, $2, $3)`,
      [id, quiz.questionId, answer === 'right' ? quiz.correct : quiz.wrong],
    );
    await tx.query(`UPDATE assessment_attempts SET status = 'submitted' WHERE id = $1`, [id]);
    return id;
  });
}

/** Marks a lesson complete as the learner, through the real 0018 path. */
async function completeLesson(learnerId: string, lessonId: string): Promise<void> {
  await db.withActor(learnerId, (tx) =>
    tx.query(
      `INSERT INTO lesson_progress (user_id, lesson_id, status, completed_at)
       VALUES ($1, $2, 'completed', now())`,
      [learnerId, lessonId],
    ),
  );
}

const evidenceCount = (actorId: string) =>
  count(actorId, 'SELECT count(*) AS n FROM objective_evidence');

// =====================================================================
// Objectives are content, and inherit the lesson's visibility
// =====================================================================

describe('learning objectives', () => {
  const visible = (actor: string) =>
    count(actor, 'SELECT count(*) AS n FROM learning_objectives WHERE lesson_id = $1', [w.lessonA]);

  it('are readable by a learner who reaches the lesson', () => {
    // Not a new disclosure: 0016 already returned these statements to anyone who
    // could read the lesson, as an array column on the lesson row.
    return expect(visible(w.learner)).resolves.toBe(3);
  });

  it('are readable by their teacher and by an author of the school', async () => {
    expect(await visible(w.teacher)).toBe(3);
    expect(await visible(w.author)).toBe(3);
  });

  it('are INVISIBLE on a draft lesson to a learner', async () => {
    // The objective inherits the lesson's status through `app_actor_sees_lesson`,
    // so an unreviewed objective is not disclosed before publication.
    expect(
      await count(w.learner, 'SELECT count(*) AS n FROM learning_objectives WHERE lesson_id = $1', [
        w.draftLesson,
      ]),
    ).toBe(0);
    expect(
      await count(w.author, 'SELECT count(*) AS n FROM learning_objectives WHERE lesson_id = $1', [
        w.draftLesson,
      ]),
    ).toBe(1);
  });

  it('are invisible to a teacher of ANOTHER organization', async () => {
    expect(await visible(w.foreignTeacher)).toBe(0);
  });

  it('cannot be written by a learner', async () => {
    expect(
      await attempt(
        w.learner,
        `INSERT INTO learning_objectives (lesson_id, position, statement) VALUES ($1, 9, 'Mine')`,
        [w.lessonA],
      ),
    ).toBe(false);
  });

  it('CAN be reworded by an author after publication, and keep their identity', async () => {
    // The whole reason objectives are rows rather than array elements: a
    // published lesson is still editable (0016), so an author fixing a typo must
    // not re-point or orphan a child's evidence.
    const first = w.objectives[0]!;
    expect(
      await changedRows(w.author, `UPDATE learning_objectives SET statement = $2 WHERE id = $1`, [
        first.id,
        "Explain Newton's SECOND law",
      ]),
    ).toBe(1);
    const after = await objectivesOf(w.lessonA);
    expect(after[0]!.id).toBe(first.id);
    expect(after[0]!.statement).toBe("Explain Newton's SECOND law");
  });

  it('CANNOT be moved to another lesson', async () => {
    // Moving one would move every attached evidence row across an authorization
    // boundary in a single UPDATE.
    //
    // The destination is a lesson with NO objectives, deliberately. Moving into
    // `draftLesson` would collide with its position-1 objective and be refused
    // by the UNIQUE constraint instead — the test would pass with the
    // immutability trigger deleted, which is a test that proves nothing.
    // Verified by injection: removing the trigger fails this assertion.
    const emptyLesson = await createLesson({
      unitId: w.unitA,
      title: 'Somewhere Else',
      status: 'draft',
    });
    expect(
      await attempt(w.author, `UPDATE learning_objectives SET lesson_id = $2 WHERE id = $1`, [
        w.objectives[0]!.id,
        emptyLesson,
      ]),
    ).toBe(false);
  });

  it('CANNOT be deleted once the lesson is published', async () => {
    // A learner may already have demonstrated it, and the FK cascades — so a
    // delete here would erase a record of what a child did in order to tidy a
    // content tree.
    expect(
      await changedRows(w.author, `DELETE FROM learning_objectives WHERE id = $1`, [
        w.objectives[0]!.id,
      ]),
    ).toBe(0);
  });

  it('CAN be deleted while the lesson is still a draft', async () => {
    const draftObjective = (await objectivesOf(w.draftLesson))[0]!;
    expect(
      await changedRows(w.author, `DELETE FROM learning_objectives WHERE id = $1`, [
        draftObjective.id,
      ]),
    ).toBe(1);
  });

  it('are capped at twenty per lesson', async () => {
    // 0016 held this as `cardinality(objectives) <= 20`; the bound survives the
    // promotion to rows rather than being quietly dropped with the column.
    const db2 = await seedDb();
    await db2.query(
      `INSERT INTO learning_objectives (lesson_id, position, statement)
       SELECT $1, g, 'Objective ' || g FROM generate_series(4, 20) g`,
      [w.lessonA],
    );
    await expect(
      db2.query(
        `INSERT INTO learning_objectives (lesson_id, position, statement) VALUES ($1, 21, 'One too many')`,
        [w.lessonA],
      ),
    ).rejects.toThrow(/at most 20/i);
  });
});

// =====================================================================
// Evidence is emitted, never submitted
// =====================================================================

describe('evidence cannot be written by the application role', () => {
  it('a learner cannot insert evidence for themselves', async () => {
    // The strongest statement in the migration: `edu_app` holds SELECT and
    // nothing else, so this is refused by a missing PRIVILEGE rather than by a
    // policy somebody could get wrong.
    await expect(
      db.withActor(w.learner, (tx) =>
        tx.query(
          `INSERT INTO objective_evidence
             (user_id, objective_id, evidence_type, source_kind, source_id, occurred_at)
           VALUES ($1, $2, 'assessment_passed', 'assessment_attempt', gen_random_uuid(), now())`,
          [w.learner, w.objectives[0]!.id],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it.each([
    ['a teacher', (): string => w.teacher],
    ['an administrator', (): string => w.admin],
    ['a platform operator', (): string => w.operator],
  ])('nor can %s', async (_label, who) => {
    await expect(
      db.withActor(who(), (tx) =>
        tx.query(
          `INSERT INTO objective_evidence
             (user_id, objective_id, evidence_type, source_kind, source_id, occurred_at)
           VALUES ($1, $2, 'assessment_passed', 'assessment_attempt', gen_random_uuid(), now())`,
          [w.learner, w.objectives[0]!.id],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('nobody can UPDATE evidence — not its owner, its timestamp, or its objective', async () => {
    await completeLesson(w.learner, w.lessonA);
    for (const [actor, column] of [
      [w.learner, `user_id = '00000000-0000-4000-8000-000000000000'`],
      [w.teacher, `occurred_at = now() - interval '1 year'`],
      [w.operator, `objective_id = '00000000-0000-4000-8000-000000000000'`],
      [w.admin, `evidence_type = 'assessment_passed'`],
    ] as const) {
      await expect(
        db.withActor(actor, (tx) => tx.query(`UPDATE objective_evidence SET ${column}`)),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it('nobody can DELETE evidence', async () => {
    await completeLesson(w.learner, w.lessonA);
    await expect(
      db.withActor(w.learner, (tx) => tx.query(`DELETE FROM objective_evidence`)),
    ).rejects.toThrow(/permission denied/i);
  });
});

// =====================================================================
// Where evidence comes from
// =====================================================================

describe('evidence generation', () => {
  const evidenceFor = (objectiveId: string) =>
    db.withActor(w.learner, async (tx) => {
      const { rows } = await tx.query<{ evidence_type: string; source_kind: string }>(
        `SELECT evidence_type, source_kind FROM objective_evidence
          WHERE user_id = $1 AND objective_id = $2 ORDER BY occurred_at`,
        [w.learner, objectiveId],
      );
      return rows;
    });

  it('a completed lesson produces evidence for EVERY objective of that lesson', async () => {
    await completeLesson(w.learner, w.lessonA);
    expect(await evidenceCount(w.learner)).toBe(3);
    expect(await evidenceFor(w.objectives[0]!.id)).toEqual([
      { evidence_type: 'lesson_completed', source_kind: 'lesson_progress' },
    ]);
  });

  it('MERELY OPENING a lesson produces none', async () => {
    // `in_progress` is engagement, not evidence. A row saying "opened the page"
    // would be exactly the fake progress this must not manufacture.
    await db.withActor(w.learner, (tx) =>
      tx.query(
        `INSERT INTO lesson_progress (user_id, lesson_id, status) VALUES ($1, $2, 'in_progress')`,
        [w.learner, w.lessonA],
      ),
    );
    expect(await evidenceCount(w.learner)).toBe(0);
  });

  it('a submitted assessment produces evidence carrying its real outcome', async () => {
    await sit(w.learner, w.quiz, 'right');
    const rows = await evidenceFor(w.objectives[0]!.id);
    expect(rows).toEqual([
      { evidence_type: 'assessment_passed', source_kind: 'assessment_attempt' },
    ]);
  });

  it('a FAILED assessment produces evidence too — a failure is evidence', async () => {
    await sit(w.learner, w.quiz, 'wrong');
    expect(await evidenceFor(w.objectives[0]!.id)).toEqual([
      { evidence_type: 'assessment_not_passed', source_kind: 'assessment_attempt' },
    ]);
  });

  it('AN UNRELEASED RESULT STILL PRODUCES EVIDENCE', async () => {
    // Withholding a mark is a decision about what the CHILD is told. Tying
    // evidence to release would mean an unreleased result silently erased the
    // learning it recorded, and a teacher would see a hole where a quiz was.
    const { activityId, assessmentId } = await createActivity({
      lessonId: w.lessonA,
      title: 'Withheld',
      status: 'draft',
      maxAttempts: 2,
      reviewPolicy: 'on_release',
    });
    const q = await createQuestion({
      assessmentId: assessmentId!,
      options: ['Right', 'Wrong'],
      correctOptions: [0],
      points: 2,
    });
    await asSuperuser(
      `UPDATE learning_activities SET status='published', published_at=now() WHERE id=$1`,
      [activityId],
    );
    await sit(
      w.learner,
      {
        assessmentId: assessmentId!,
        questionId: q.questionId,
        correct: q.correctOptionIds[0]!,
        wrong: q.optionIds.find((id) => !q.correctOptionIds.includes(id))!,
      },
      'right',
    );

    // The teacher sees the true evidence immediately.
    expect(
      await count(w.teacher, 'SELECT count(*) AS n FROM objective_evidence WHERE user_id = $1', [
        w.learner,
      ]),
    ).toBe(3);
  });

  it('produces NOTHING for an attempt still in progress', async () => {
    await db.withActor(w.learner, (tx) =>
      tx.query(`INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1, $2)`, [
        w.quiz.assessmentId,
        w.learner,
      ]),
    );
    expect(await evidenceCount(w.learner)).toBe(0);
  });

  it('IS IDEMPOTENT: the same event cannot produce a second row', async () => {
    // The unique index is the idempotency, not a check in a service. A retried
    // submission carries the same attempt id, so the second write is refused by
    // the database whatever the caller believes.
    //
    // Asserted at the constraint rather than by re-firing the trigger, because
    // re-firing is impossible by design: Task 009's submit guard refuses every
    // modification to a submitted attempt, so a retry can never reach the
    // trigger a second time. Two independent mechanisms, tested where each
    // lives.
    const attemptId = await sit(w.learner, w.quiz, 'right');
    expect(await evidenceCount(w.learner)).toBe(3);

    const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await raw.connect();
    try {
      await expect(
        raw.query(
          `INSERT INTO objective_evidence
             (user_id, objective_id, evidence_type, source_kind, source_id, occurred_at)
           VALUES ($1, $2, 'assessment_passed', 'assessment_attempt', $3, now())`,
          [w.learner, w.objectives[0]!.id, attemptId],
        ),
      ).rejects.toThrow(/duplicate key|unique/i);
    } finally {
      await raw.end();
    }
    expect(await evidenceCount(w.learner)).toBe(3);
  });

  it('and a retried SUBMISSION is refused upstream, so the trigger never re-fires', async () => {
    // The other half of the same property, at the layer a retry actually
    // reaches: Task 009 freezes a submitted attempt, so there is no statement
    // through which the same event could be replayed.
    const attemptId = await sit(w.learner, w.quiz, 'right');
    // `changedRows`, not `attempt`: the learner's update policy carries
    // `status = 'in_progress'` in its USING clause, so a submitted attempt is
    // INVISIBLE to the statement and it succeeds against zero rows. "No error"
    // is what a refusal looks like here, and a suite built on it would report a
    // blocked replay as an allowed one.
    expect(
      await changedRows(
        w.learner,
        `UPDATE assessment_attempts SET status = 'submitted' WHERE id = $1`,
        [attemptId],
      ),
    ).toBe(0);
    expect(await evidenceCount(w.learner)).toBe(3);
  });

  it('a RELEASE does not emit a second round of evidence', async () => {
    // A release is an UPDATE on an already-submitted attempt. Emitting again
    // would double-count a single sitting, and re-date it to the moment a
    // teacher happened to click.
    const { activityId, assessmentId } = await createActivity({
      lessonId: w.lessonA,
      title: 'Withheld For Release',
      status: 'draft',
      maxAttempts: 2,
      reviewPolicy: 'on_release',
    });
    const q = await createQuestion({
      assessmentId: assessmentId!,
      options: ['Right', 'Wrong'],
      correctOptions: [0],
      points: 2,
    });
    await asSuperuser(
      `UPDATE learning_activities SET status='published', published_at=now() WHERE id=$1`,
      [activityId],
    );
    const attemptId = await sit(
      w.learner,
      {
        assessmentId: assessmentId!,
        questionId: q.questionId,
        correct: q.correctOptionIds[0]!,
        wrong: q.optionIds.find((id) => !q.correctOptionIds.includes(id))!,
      },
      'right',
    );
    const before = await evidenceCount(w.teacher);
    expect(
      await changedRows(
        w.teacher,
        `UPDATE assessment_attempts SET released_at = now(), released_by = app_current_actor() WHERE id = $1`,
        [attemptId],
      ),
    ).toBe(1);
    expect(await evidenceCount(w.teacher)).toBe(before);
  });

  it('two DIFFERENT attempts at the same quiz are two pieces of evidence', async () => {
    await sit(w.learner, w.quiz, 'wrong');
    await sit(w.learner, w.quiz, 'right');
    expect(await evidenceFor(w.objectives[0]!.id)).toEqual([
      { evidence_type: 'assessment_not_passed', source_kind: 'assessment_attempt' },
      { evidence_type: 'assessment_passed', source_kind: 'assessment_attempt' },
    ]);
  });

  it('carries the moment of the EVENT, not the moment the row was written', async () => {
    await completeLesson(w.learner, w.lessonA);
    const rows = await db.withActor(
      w.learner,
      async (tx) =>
        (
          await tx.query<{ occurred_at: Date; completed_at: Date }>(
            `SELECT e.occurred_at, p.completed_at
             FROM objective_evidence e JOIN lesson_progress p ON p.id = e.source_id
            WHERE e.user_id = $1 LIMIT 1`,
            [w.learner],
          )
        ).rows,
    );
    expect(rows[0]!.occurred_at.getTime()).toBe(rows[0]!.completed_at.getTime());
  });
});

// =====================================================================
// The mastery rules, enumerated
// =====================================================================

describe('the mastery rule', () => {
  /** Read as the TEACHER unless stated: the authoritative state, unfiltered. */
  const mastery = (objectiveIndex = 0, reader?: string) =>
    masteryFor(reader ?? w.teacher, w.learner, w.objectives[objectiveIndex]!.id);

  it('is `no_evidence` before the learner has done anything', async () => {
    expect(await mastery()).toBe('no_evidence');
  });

  it('is `attempted` when the only evidence is a completed lesson', async () => {
    // Completing a lesson says the learner engaged with the material. It does
    // not say they can do anything, and the state name says exactly that.
    await completeLesson(w.learner, w.lessonA);
    expect(await mastery()).toBe('attempted');
  });

  it('is `developing` when an assessment was sat and not passed', async () => {
    await sit(w.learner, w.quiz, 'wrong');
    expect(await mastery()).toBe('developing');
  });

  it('is `demonstrated` after ONE assessment is passed', async () => {
    await sit(w.learner, w.quiz, 'right');
    expect(await mastery()).toBe('demonstrated');
  });

  it('IS NOT `mastered` for passing the SAME assessment twice', async () => {
    // The single most important negative in the model. Repeating one quiz is one
    // piece of evidence repeated, not two — counting attempts would make
    // `mastered` mean "sat the same paper twice", a claim about persistence
    // rather than understanding.
    await sit(w.learner, w.quiz, 'right');
    await sit(w.learner, w.quiz, 'right');
    expect(await mastery()).toBe('demonstrated');
  });

  it('IS `mastered` after passing TWO DIFFERENT assessments', async () => {
    await sit(w.learner, w.quiz, 'right');
    await sit(w.learner, w.quiz2, 'right');
    expect(await mastery()).toBe('mastered');
  });

  it('NEVER GOES DOWN when a later attempt fails', async () => {
    // Every rule counts things that only accumulate. A bad day does not retract
    // what a child previously showed they could do.
    await sit(w.learner, w.quiz, 'right');
    await sit(w.learner, w.quiz2, 'right');
    expect(await mastery()).toBe('mastered');
    await sit(w.learner, w.quiz, 'wrong');
    expect(await mastery()).toBe('mastered');
  });

  it('does not decay: nothing about elapsed time changes it', async () => {
    // There is no forgetting curve in this model — not because forgetting is
    // unreal, but because a decay rate is a claim about a child the platform has
    // no evidence to support.
    await sit(w.learner, w.quiz, 'right');
    await asSuperuser(
      `UPDATE objective_evidence SET occurred_at = now() - interval '3 years', created_at = now() - interval '3 years'`,
    );
    expect(await mastery()).toBe('demonstrated');
  });

  it('is per-objective, not per-learner', async () => {
    // A learner may have demonstrated one objective and nothing on another.
    const otherLesson = await createLesson({
      unitId: w.unitA,
      title: 'Energy',
      status: 'published',
      objectives: ['Define kinetic energy'],
    });
    const otherObjective = (await objectivesOf(otherLesson))[0]!;
    await sit(w.learner, w.quiz, 'right');
    expect(await mastery()).toBe('demonstrated');
    expect(await masteryFor(w.teacher, w.learner, otherObjective.id)).toBe('no_evidence');
  });

  it('moves every objective of a lesson together, which is the model’s honest limit', async () => {
    // An assessment attaches to its LESSON's objectives, because nothing in the
    // schema says which question tested which objective. Pinned as a test rather
    // than left as a surprise: this is a real limitation, documented in
    // docs/api/mastery.md, not an accident.
    await sit(w.learner, w.quiz, 'right');
    expect(await mastery(0)).toBe('demonstrated');
    expect(await mastery(1)).toBe('demonstrated');
    expect(await mastery(2)).toBe('demonstrated');
  });
});

// =====================================================================
// The withheld-result rule
// =====================================================================

describe('an unreleased result is withheld from the learner’s mastery too', () => {
  let withheld: World['quiz'];

  beforeEach(async () => {
    const { activityId, assessmentId } = await createActivity({
      lessonId: w.lessonA,
      title: 'Withheld Quiz',
      status: 'draft',
      maxAttempts: 3,
      reviewPolicy: 'on_release',
    });
    const q = await createQuestion({
      assessmentId: assessmentId!,
      options: ['Right', 'Wrong'],
      correctOptions: [0],
      points: 2,
    });
    await asSuperuser(
      `UPDATE learning_activities SET status='published', published_at=now() WHERE id=$1`,
      [activityId],
    );
    withheld = {
      assessmentId: assessmentId!,
      questionId: q.questionId,
      correct: q.correctOptionIds[0]!,
      wrong: q.optionIds.find((id) => !q.correctOptionIds.includes(id))!,
    };
  });

  const objective = () => w.objectives[0]!.id;

  it('THE TEACHER SEES THE TRUE STATE IMMEDIATELY', async () => {
    await sit(w.learner, withheld, 'right');
    expect(await masteryFor(w.teacher, w.learner, objective())).toBe('demonstrated');
  });

  it('THE LEARNER SEES ONLY `attempted` UNTIL IT IS RELEASED', async () => {
    // A mastery state that jumped to `demonstrated` on submission would announce
    // the withheld mark through a different endpoint. `attempted` leaks nothing
    // — the learner knows they sat it.
    await sit(w.learner, withheld, 'right');
    expect(await masteryFor(w.learner, w.learner, objective())).toBe('attempted');
  });

  it('and a withheld FAILURE is not announced either', async () => {
    await sit(w.learner, withheld, 'wrong');
    expect(await masteryFor(w.learner, w.learner, objective())).toBe('attempted');
    expect(await masteryFor(w.teacher, w.learner, objective())).toBe('developing');
  });

  it('the guardian is bound by the same rule as the child', async () => {
    await sit(w.learner, withheld, 'right');
    expect(await masteryFor(w.guardian, w.learner, objective())).toBe('attempted');
  });

  it('RELEASING IT UPDATES THE LEARNER’S MASTERY, with no extra step', async () => {
    const attemptId = await sit(w.learner, withheld, 'right');
    expect(await masteryFor(w.learner, w.learner, objective())).toBe('attempted');
    await changedRows(
      w.teacher,
      `UPDATE assessment_attempts SET released_at = now(), released_by = app_current_actor() WHERE id = $1`,
      [attemptId],
    );
    expect(await masteryFor(w.learner, w.learner, objective())).toBe('demonstrated');
  });

  it('an `on_submission` assessment is visible to the learner at once', async () => {
    // The default path, unchanged: nothing about Task 010 delays a result that
    // Task 009 releases automatically.
    await sit(w.learner, w.quiz, 'right');
    expect(await masteryFor(w.learner, w.learner, objective())).toBe('demonstrated');
  });
});

// =====================================================================
// Who may read a learner's evidence and mastery
// =====================================================================

describe('evidence visibility', () => {
  beforeEach(async () => {
    await completeLesson(w.learner, w.lessonA);
    await sit(w.learner, w.quiz, 'right');
  });

  const readable = (actor: string) =>
    count(actor, 'SELECT count(*) AS n FROM objective_evidence WHERE user_id = $1', [w.learner]);

  it('the learner reads their own', async () => {
    expect(await readable(w.learner)).toBe(6);
  });

  it('A PEER IN THE SAME SCHOOL READS NOTHING', async () => {
    expect(await readable(w.peer)).toBe(0);
  });

  it('the teacher of the shared class reads it', async () => {
    expect(await readable(w.teacher)).toBe(6);
  });

  it('A TEACHER OF THE SAME SCHOOL BUT NOT OF THE CLASS READS NOTHING', async () => {
    // The sharpest negative: same organization, same role, same lesson. Only the
    // class roster separates them.
    expect(await readable(w.strangerTeacher)).toBe(0);
  });

  it('A TEACHER OF ANOTHER ORGANIZATION READS NOTHING', async () => {
    expect(await readable(w.foreignTeacher)).toBe(0);
  });

  it('the verified guardian reads it', async () => {
    expect(await readable(w.guardian)).toBe(6);
  });

  it('an administrator of the learner’s school reads it', async () => {
    expect(await readable(w.admin)).toBe(6);
  });

  it('AN ADMINISTRATOR OF ANOTHER ORGANIZATION READS NOTHING', async () => {
    // The cross-tenant boundary, and the one this suite originally missed:
    // removing `app_user_organization(...) = app_actor_organization()` from the
    // read predicate passed all 64 tests until this was added. An `admin` role
    // held anywhere would otherwise have reached every child on the platform.
    expect(await readable(w.foreignAdmin)).toBe(0);
  });

  it('an administrator with NO organization matches nothing', async () => {
    // `app_user_organization(...) IS NOT NULL` is what stops NULL = NULL from
    // quietly admitting an organization-less admin to an organization-less
    // learner. Same guard as 0018 and 0019.
    const orphanAdmin = (
      await createUser({ email: 'orphan@x.test', roles: [], organizationId: null })
    ).id;
    await grantRole(orphanAdmin, 'admin', 'global', null);
    expect(await readable(orphanAdmin)).toBe(0);
  });

  it('A SECURITY ADMINISTRATOR OF THE SAME SCHOOL READS NOTHING', async () => {
    // Accounts and lockouts are their remit. Every child's learning record is a
    // different authority that must not ride along with it — the same boundary
    // 0018 draws, drawn again here so the two agree (VULN-020).
    expect(await readable(w.securityAdmin)).toBe(0);
  });

  it('a platform operator reads it', async () => {
    expect(await readable(w.operator)).toBe(6);
  });

  it('an UNFILTERED select leaks nothing across learners', async () => {
    // Not "the endpoint filters by user" — the peer's own database connection
    // cannot see the rows, with arbitrary SQL and no WHERE clause.
    //
    // The peer is enrolled in the SAME class for this test, which is what makes
    // it sharp: they reach the same lesson, sit under the same teacher, and
    // still see only their own record.
    await addClassMember(w.classA1, w.peer);
    await completeLesson(w.peer, w.lessonA);
    expect(await count(w.peer, 'SELECT count(*) AS n FROM objective_evidence')).toBe(3);
    expect(await count(w.learner, 'SELECT count(*) AS n FROM objective_evidence')).toBe(6);
  });
});

describe('mastery visibility mirrors evidence visibility', () => {
  beforeEach(async () => {
    await sit(w.learner, w.quiz, 'right');
  });

  const objective = () => w.objectives[0]!.id;

  it.each([
    ['a peer', (): string => w.peer],
    ['a teacher of another class', (): string => w.strangerTeacher],
    ['a teacher of another organization', (): string => w.foreignTeacher],
    ['AN ADMINISTRATOR OF ANOTHER ORGANIZATION', (): string => w.foreignAdmin],
    ['a security administrator', (): string => w.securityAdmin],
  ])('%s is told `no_evidence`, which discloses nothing', async (_label, who) => {
    // The function is granted to `edu_app`, so anyone may CALL it. It is safe
    // only because it re-asks the authorization question itself — this is the
    // test of that claim. An unauthorized reader gets the same answer they would
    // get for a learner who had done nothing, so the reply distinguishes
    // "not permitted" from "nothing there" for nobody.
    expect(await masteryFor(who(), w.learner, objective())).toBe('no_evidence');
  });

  it.each([
    ['the learner', (): string => w.learner],
    ['their teacher', (): string => w.teacher],
    ['their guardian', (): string => w.guardian],
    ['an administrator of the school', (): string => w.admin],
    ['a platform operator', (): string => w.operator],
  ])('%s is told the real state', async (_label, who) => {
    expect(await masteryFor(who(), w.learner, objective())).toBe('demonstrated');
  });

  it('IS NOT AN ORACLE: an id alone buys nothing', async () => {
    // A peer holding both uuids learns neither the learner's state nor whether
    // the objective exists.
    expect(await masteryFor(w.peer, w.learner, objective())).toBe('no_evidence');
    expect(await masteryFor(w.peer, w.peer, objective())).toBe('no_evidence');
  });

  it('retains a learner’s record after their class membership ends', async () => {
    // The retention rule, restated for mastery. An administrative change to a
    // timetable must not delete what a child demonstrated from their own view.
    await asSuperuser(
      `UPDATE class_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1`,
      [w.learner],
    );
    expect(await masteryFor(w.learner, w.learner, objective())).toBe('demonstrated');
    // The teacher's view ends with the enrolment, exactly as it does for progress.
    expect(await masteryFor(w.teacher, w.learner, objective())).toBe('no_evidence');
  });
});
