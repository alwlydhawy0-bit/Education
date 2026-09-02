import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../apps/api/src/platform/db.ts';
import { TEST_APP_URL, TEST_SUPERUSER_URL } from '../setup/env.ts';
import pg from 'pg';
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
  linkGuardian,
  truncateAll,
} from '../setup/fixtures.ts';

/**
 * Row-Level Security, integrity triggers and the SCORER, with no application
 * code in the path.
 *
 * Every statement runs as `edu_app` (NOBYPASSRLS, non-owner) with
 * `app.actor_id` set exactly as a request would set it. If the entire policy
 * engine were deleted tomorrow, these are the boundaries that would still hold.
 *
 * THIS FILE ALSO OWNS THE SCORING RULE. It is the only place the rule can be
 * tested, because scoring lives in `app_score_attempt` — SQL, SECURITY DEFINER,
 * granted to no role — precisely so the answer key never enters application
 * memory. A TypeScript scorer would be unit-testable and would be a second
 * implementation that could disagree with the one that actually marks
 * children's work.
 *
 * Its mirrors are `tests/security/assessment.test.ts` (the same boundaries
 * through HTTP) and `layered-defense.test.ts` (the same boundaries with RLS
 * switched OFF).
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
 * `attempt` above is NOT sufficient for an UPDATE, and the difference matters
 * enough to be worth a second helper. An RLS `USING` clause does not raise —
 * it makes the row invisible to the statement, which matches ZERO rows and
 * succeeds. So `attempt(...) === true` on an UPDATE means "no error", which is
 * exactly what a refusal looks like, and a suite built on it would report a
 * blocked write as an allowed one.
 *
 * This was found by these tests failing against a database that was behaving
 * correctly — the assertion was wrong, not the policy.
 */
async function changedRows(actorId: string, sql: string, params: unknown[] = []): Promise<number> {
  return db.withActor(actorId, async (tx) => (await tx.query(sql, params)).rowCount ?? 0);
}

/** A reviewer of Org A: holds `content:publish` and nothing else. */
async function seedReviewer(email: string, orgId: string): Promise<string> {
  const id = (await createUser({ email, roles: [], organizationId: orgId })).id;
  await grantRole(id, 'reviewer', 'organization', orgId);
  return id;
}

async function count(actorId: string, sql: string, params: unknown[] = []): Promise<number> {
  return db.withActor(actorId, async (tx) => {
    const { rows } = await tx.query<{ n: string }>(sql, params);
    return Number(rows[0]?.n ?? 0);
  });
}

interface World {
  orgA: string;
  orgB: string;
  learner: string;
  peer: string;
  teacher: string;
  foreignTeacher: string;
  guardian: string;
  admin: string;
  securityAdmin: string;
  operator: string;
  author: string;
  classA1: string;
  lessonA: string;
  activityId: string;
  assessmentId: string;
  /** Three questions: single-choice (2pt), multiple-choice (3pt), true/false (1pt). */
  q1: { questionId: string; optionIds: string[]; correctOptionIds: string[] };
  q2: { questionId: string; optionIds: string[]; correctOptionIds: string[] };
  q3: { questionId: string; optionIds: string[]; correctOptionIds: string[] };
  draftAssessmentId: string;
}

async function seedWorld(): Promise<World> {
  const orgA = await createOrganization('Org A');
  const orgB = await createOrganization('Org B');

  // Roles are granted separately below, always ORGANIZATION-scoped: the fixture
  // default is a GLOBAL grant, and a global `security_admin` is a platform
  // operator rather than a school's — a different actor with different standing.
  const mk = async (email: string, org: string | null) =>
    (await createUser({ email, roles: [], organizationId: org })).id;

  const learner = await mk('learner@a.test', orgA);
  await grantRole(learner, 'student', 'organization', orgA);
  const peer = await mk('peer@a.test', orgA);
  await grantRole(peer, 'student', 'organization', orgA);
  const teacher = await mk('teacher@a.test', orgA);
  await grantRole(teacher, 'teacher', 'organization', orgA);
  const foreignTeacher = await mk('teacher@b.test', orgB);
  await grantRole(foreignTeacher, 'teacher', 'organization', orgB);
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
  const course = await createCourse({
    organizationId: orgA,
    curriculumId: curriculum,
    levelId: level,
    title: 'Chemistry',
    status: 'published',
  });
  const unit = await createUnit({ courseId: course, title: 'Unit', status: 'published' });
  const lessonA = await createLesson({ unitId: unit, title: 'Atoms', status: 'published' });
  await assignCourseToClass({ classId: classA1, courseId: course });

  const { activityId, assessmentId } = await createActivity({
    lessonId: lessonA,
    title: 'Atoms Quiz',
    status: 'draft',
    maxAttempts: 2,
    passingPercentage: 50,
  });
  if (!assessmentId) throw new Error('seed: no assessment');

  const q1 = await createQuestion({
    assessmentId,
    questionType: 'single_choice',
    prompt: 'What is an atom?',
    points: 2,
    options: ['A unit of matter', 'A kind of soup'],
    correctOptions: [0],
  });
  const q2 = await createQuestion({
    assessmentId,
    questionType: 'multiple_choice',
    prompt: 'Which are particles?',
    points: 3,
    options: ['Proton', 'Neutron', 'Sandwich'],
    correctOptions: [0, 1],
  });
  const q3 = await createQuestion({
    assessmentId,
    questionType: 'true_false',
    prompt: 'Atoms are indivisible.',
    points: 1,
    options: ['True', 'False'],
    correctOptions: [1],
  });

  // Published through the real path, as the reviewer would: the activity is the
  // lifecycle owner, and publication runs the well-formedness validation.
  const su = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
  await su.connect();
  await su.query(
    `UPDATE learning_activities SET status='published', published_at=now() WHERE id=$1`,
    [activityId],
  );
  await su.end();

  // A second, DRAFT assessment on the same visible lesson. This is the shape
  // that produced VULN-027: the lesson is reachable, so a write path checking
  // only the lesson would admit an attempt at unreviewed material.
  const draft = await createActivity({ lessonId: lessonA, title: 'Draft Quiz', status: 'draft' });
  if (!draft.assessmentId) throw new Error('seed: no draft assessment');

  return {
    orgA,
    orgB,
    learner,
    peer,
    teacher,
    foreignTeacher,
    guardian,
    admin,
    securityAdmin,
    operator,
    author,
    classA1,
    lessonA,
    activityId,
    assessmentId,
    q1,
    q2,
    q3,
    draftAssessmentId: draft.assessmentId,
  };
}

let w: World;
beforeEach(async () => {
  w = await seedWorld();
});

// =====================================================================
// The answer key
// =====================================================================

describe('the answer key', () => {
  it('is invisible to the learner, with arbitrary SQL', async () => {
    // Not "the endpoint does not return it" — the learner's own database
    // connection cannot see the rows. That is why the key is a separate table:
    // "students may read the option but not its correctness" is not something
    // row-level security can say about a column.
    expect(await count(w.learner, 'SELECT count(*) AS n FROM assessment_answer_keys')).toBe(0);
  });

  it('is invisible to a verified guardian', async () => {
    expect(await count(w.guardian, 'SELECT count(*) AS n FROM assessment_answer_keys')).toBe(0);
  });

  it('is invisible to a security administrator of the same school', async () => {
    expect(await count(w.securityAdmin, 'SELECT count(*) AS n FROM assessment_answer_keys')).toBe(
      0,
    );
  });

  it('is invisible to a teacher of ANOTHER school', async () => {
    expect(await count(w.foreignTeacher, 'SELECT count(*) AS n FROM assessment_answer_keys')).toBe(
      0,
    );
  });

  it('IS visible to the author of the owning school', async () => {
    // The positive case matters as much as the negatives: a policy that hid the
    // key from everybody would pass every test above while making authoring
    // impossible, and somebody would then loosen it.
    expect(await count(w.author, 'SELECT count(*) AS n FROM assessment_answer_keys')).toBe(4);
  });

  it('IS visible to a teacher of the owning school — they hold content:author', async () => {
    // Recorded rather than hidden: the `teacher` role carries `content:author`,
    // so every teacher in the school can read every key in it (RISK-ASSESS-02).
    expect(await count(w.teacher, 'SELECT count(*) AS n FROM assessment_answer_keys')).toBe(4);
  });

  it('cannot be joined into a question read by a learner', async () => {
    const visible = await count(
      w.learner,
      `SELECT count(*) AS n
         FROM assessment_questions q
         LEFT JOIN assessment_answer_keys k ON k.question_id = q.id
        WHERE k.option_id IS NOT NULL`,
    );
    expect(visible).toBe(0);
  });

  it('cannot be inferred by counting rows per question', async () => {
    // A learner joining the key table sees their questions with NULL keys, so
    // even the SIZE of each key — which would narrow a multiple-choice guess —
    // is not disclosed.
    const perQuestion = await db.withActor(w.learner, async (tx) =>
      (
        await tx.query<{ n: string }>(
          `SELECT count(k.option_id) AS n
             FROM assessment_questions q
             LEFT JOIN assessment_answer_keys k ON k.question_id = q.id
            GROUP BY q.id`,
        )
      ).rows.map((r) => Number(r.n)),
    );
    expect(perQuestion).toEqual([0, 0, 0]);
  });
});

describe('the scorer', () => {
  it('cannot be executed by the application role at all', async () => {
    // Granted to nobody. A grant would let any learner read any attempt's marks
    // by id, straight past `assessment_attempts_select`.
    await expect(
      db.withActor(w.learner, (tx) =>
        tx.query('SELECT * FROM app_score_attempt($1)', ['00000000-0000-4000-8000-000000000000']),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

// =====================================================================
// Scoring — the rule itself, enumerated
// =====================================================================

/** Submits an attempt with the given selections and returns the stored result. */
async function scoreWith(
  learner: string,
  assessmentId: string,
  selections: ReadonlyArray<readonly [string, string]>,
): Promise<{ score: number; maxScore: number; percentage: number; passed: boolean }> {
  return db.withActor(learner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1, $2) RETURNING id`,
      [assessmentId, learner],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('no attempt');
    if (selections.length > 0) {
      await tx.query(
        `INSERT INTO assessment_attempt_answers (attempt_id, question_id, option_id)
         SELECT $1, q, o FROM unnest($2::uuid[], $3::uuid[]) AS t(q, o)`,
        [id, selections.map((s) => s[0]), selections.map((s) => s[1])],
      );
    }
    // The ENTIRE submission statement. No score is sent, because the
    // application has none to send.
    await tx.query(`UPDATE assessment_attempts SET status = 'submitted' WHERE id = $1`, [id]);
    const { rows: result } = await tx.query<{
      score: number;
      max_score: number;
      percentage: string;
      passed: boolean;
    }>(`SELECT score, max_score, percentage, passed FROM assessment_attempts WHERE id = $1`, [id]);
    const r = result[0];
    if (!r) throw new Error('no result');
    return {
      score: r.score,
      maxScore: r.max_score,
      percentage: Number(r.percentage),
      passed: r.passed,
    };
  });
}

describe('the scoring rule', () => {
  it('awards full marks for an entirely correct paper', async () => {
    const result = await scoreWith(w.learner, w.assessmentId, [
      [w.q1.questionId, w.q1.correctOptionIds[0]!],
      [w.q2.questionId, w.q2.correctOptionIds[0]!],
      [w.q2.questionId, w.q2.correctOptionIds[1]!],
      [w.q3.questionId, w.q3.correctOptionIds[0]!],
    ]);
    expect(result).toEqual({ score: 6, maxScore: 6, percentage: 100, passed: true });
  });

  it('awards nothing for a blank paper, and the denominator does not shrink', async () => {
    const result = await scoreWith(w.learner, w.assessmentId, []);
    expect(result).toEqual({ score: 0, maxScore: 6, percentage: 0, passed: false });
  });

  it('gives NO partial credit for a partly-correct multiple-choice answer', async () => {
    // One of the two correct options. The rule is exact SET equality, so this
    // scores zero for that question — the single most surprising consequence of
    // the rule, pinned here so it cannot change silently.
    const result = await scoreWith(w.learner, w.assessmentId, [
      [w.q1.questionId, w.q1.correctOptionIds[0]!],
      [w.q2.questionId, w.q2.correctOptionIds[0]!],
    ]);
    expect(result.score).toBe(2);
    expect(result.maxScore).toBe(6);
    expect(result.percentage).toBeCloseTo(33.33, 2);
    expect(result.passed).toBe(false);
  });

  it('gives nothing for a multiple-choice answer with a correct set PLUS a wrong option', async () => {
    const wrong = w.q2.optionIds.find((id) => !w.q2.correctOptionIds.includes(id))!;
    const result = await scoreWith(w.learner, w.assessmentId, [
      [w.q2.questionId, w.q2.correctOptionIds[0]!],
      [w.q2.questionId, w.q2.correctOptionIds[1]!],
      [w.q2.questionId, wrong],
    ]);
    expect(result.score).toBe(0);
  });

  it('is order-independent', async () => {
    const reversed = await scoreWith(w.learner, w.assessmentId, [
      [w.q2.questionId, w.q2.correctOptionIds[1]!],
      [w.q2.questionId, w.q2.correctOptionIds[0]!],
    ]);
    expect(reversed.score).toBe(3);
  });

  it('marks a pass exactly at the threshold, not above it', async () => {
    // 3 of 6 is 50%, and the threshold is 50. An off-by-one here would fail a
    // child who passed.
    const result = await scoreWith(w.learner, w.assessmentId, [
      [w.q2.questionId, w.q2.correctOptionIds[0]!],
      [w.q2.questionId, w.q2.correctOptionIds[1]!],
    ]);
    expect(result.percentage).toBe(50);
    expect(result.passed).toBe(true);
  });
});

// =====================================================================
// Score integrity
// =====================================================================

describe('score integrity', () => {
  it('discards a forged score submitted in the same statement', async () => {
    const stored = await db.withActor(w.learner, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1, $2) RETURNING id`,
        [w.assessmentId, w.learner],
      );
      const id = rows[0]!.id;
      await tx.query(
        `UPDATE assessment_attempts
            SET status='submitted', score=100, max_score=100, percentage=100.00,
                passed=true, submitted_at='2020-01-01', attempt_number=42
          WHERE id=$1`,
        [id],
      );
      const { rows: r } = await tx.query<{
        score: number;
        max_score: number;
        passed: boolean;
        attempt_number: number;
      }>(`SELECT score, max_score, passed, attempt_number FROM assessment_attempts WHERE id=$1`, [
        id,
      ]);
      return r[0]!;
    });
    // Every forged value replaced by the computed one. Not rejected — replaced,
    // which is why no code path can write a score even when it tries.
    expect(stored).toEqual({ score: 0, max_score: 6, passed: false, attempt_number: 1 });
  });

  it('discards a forged result supplied at INSERT', async () => {
    const stored = await db.withActor(w.learner, async (tx) => {
      const { rows } = await tx.query<{
        attempt_number: number;
        status: string;
        score: number | null;
      }>(
        `INSERT INTO assessment_attempts
           (assessment_id, user_id, attempt_number, status, score, max_score, percentage, passed, submitted_at)
         VALUES ($1, $2, 99, 'submitted', 100, 100, 100.00, true, now())
         RETURNING attempt_number, status, score`,
        [w.assessmentId, w.learner],
      );
      return rows[0]!;
    });
    expect(stored).toEqual({ attempt_number: 1, status: 'in_progress', score: null });
  });

  it('freezes a submitted attempt: the learner’s UPDATE matches no rows', async () => {
    const id = await createAttempt({
      assessmentId: w.assessmentId,
      userId: w.learner,
      status: 'submitted',
    });
    // ZERO ROWS, not an error. `assessment_attempts_update` carries
    // `status = 'in_progress'` in its USING clause, so a submitted row is not
    // visible to the statement at all. Asserting on the row count rather than
    // on a thrown error is what makes this test mean something.
    expect(
      await changedRows(w.learner, `UPDATE assessment_attempts SET score = 6 WHERE id = $1`, [id]),
    ).toBe(0);
    const stored = await count(
      w.learner,
      `SELECT count(*) AS n FROM assessment_attempts WHERE id = $1 AND score = 6`,
      [id],
    );
    expect(stored).toBe(0);
  });

  it('and the TRIGGER refuses the same change with RLS out of the picture', async () => {
    // The second gate, tested with the first removed. As the superuser, the
    // policy above does not apply — so if `assessment_attempt_submit_guard`
    // were dropped, this statement would succeed and a submitted mark would be
    // editable by anybody with database access.
    const id = await createAttempt({
      assessmentId: w.assessmentId,
      userId: w.learner,
      status: 'submitted',
    });
    const su = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await su.connect();
    try {
      await expect(
        su.query(`UPDATE assessment_attempts SET score = 6 WHERE id = $1`, [id]),
      ).rejects.toThrow(/submitted attempt cannot be modified/i);
    } finally {
      await su.end();
    }
  });

  it('refuses an answer added to a submitted attempt', async () => {
    const id = await createAttempt({
      assessmentId: w.assessmentId,
      userId: w.learner,
      status: 'submitted',
    });
    expect(
      await attempt(
        w.learner,
        `INSERT INTO assessment_attempt_answers (attempt_id, question_id, option_id) VALUES ($1,$2,$3)`,
        [id, w.q1.questionId, w.q1.correctOptionIds[0]],
      ),
    ).toBe(false);
  });

  it('grants no DELETE on attempts at all', async () => {
    const id = await createAttempt({ assessmentId: w.assessmentId, userId: w.learner });
    expect(await attempt(w.learner, `DELETE FROM assessment_attempts WHERE id = $1`, [id])).toBe(
      false,
    );
  });

  it('refuses an answer naming a question from another assessment', async () => {
    const other = await createQuestion({
      assessmentId: w.draftAssessmentId,
      options: ['x', 'y'],
      correctOptions: [0],
    });
    const id = await createAttempt({ assessmentId: w.assessmentId, userId: w.learner });
    expect(
      await attempt(
        w.learner,
        `INSERT INTO assessment_attempt_answers (attempt_id, question_id, option_id) VALUES ($1,$2,$3)`,
        [id, other.questionId, other.optionIds[0]],
      ),
    ).toBe(false);
  });

  it('refuses an option belonging to another question', async () => {
    const id = await createAttempt({ assessmentId: w.assessmentId, userId: w.learner });
    expect(
      await attempt(
        w.learner,
        `INSERT INTO assessment_attempt_answers (attempt_id, question_id, option_id) VALUES ($1,$2,$3)`,
        // q1's id with q3's option: refused by the composite foreign key, with
        // no trigger and no handler involved.
        [id, w.q1.questionId, w.q3.optionIds[0]],
      ),
    ).toBe(false);
  });

  it('collapses a duplicated selection into a primary-key collision', async () => {
    const id = await createAttempt({ assessmentId: w.assessmentId, userId: w.learner });
    await db.withActor(w.learner, (tx) =>
      tx.query(
        `INSERT INTO assessment_attempt_answers (attempt_id, question_id, option_id) VALUES ($1,$2,$3)`,
        [id, w.q1.questionId, w.q1.correctOptionIds[0]],
      ),
    );
    expect(
      await attempt(
        w.learner,
        `INSERT INTO assessment_attempt_answers (attempt_id, question_id, option_id) VALUES ($1,$2,$3)`,
        [id, w.q1.questionId, w.q1.correctOptionIds[0]],
      ),
    ).toBe(false);
  });
});

// =====================================================================
// Attempt limits and ownership
// =====================================================================

describe('attempt limits', () => {
  it('permits attempts up to the configured maximum', async () => {
    await createAttempt({ assessmentId: w.assessmentId, userId: w.learner });
    expect(
      await attempt(
        w.learner,
        `INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1,$2)`,
        [w.assessmentId, w.learner],
      ),
    ).toBe(true);
  });

  it('refuses the one beyond it', async () => {
    await createAttempt({ assessmentId: w.assessmentId, userId: w.learner });
    await createAttempt({ assessmentId: w.assessmentId, userId: w.learner });
    expect(
      await attempt(
        w.learner,
        `INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1,$2)`,
        [w.assessmentId, w.learner],
      ),
    ).toBe(false);
  });

  it('numbers attempts from a definer count, so a hidden attempt still counts', async () => {
    const numbers = await db.withActor(w.learner, async (tx) => {
      const a = await tx.query<{ attempt_number: number }>(
        `INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1,$2) RETURNING attempt_number`,
        [w.assessmentId, w.learner],
      );
      const b = await tx.query<{ attempt_number: number }>(
        `INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1,$2) RETURNING attempt_number`,
        [w.assessmentId, w.learner],
      );
      return [a.rows[0]!.attempt_number, b.rows[0]!.attempt_number];
    });
    expect(numbers).toEqual([1, 2]);
  });
});

describe('attempt ownership', () => {
  it('refuses an attempt started in somebody else’s name', async () => {
    expect(
      await attempt(
        w.learner,
        `INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1,$2)`,
        [w.assessmentId, w.peer],
      ),
    ).toBe(false);
  });

  it('refuses an attempt by a learner not enrolled in the class', async () => {
    expect(
      await attempt(
        w.peer,
        `INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1,$2)`,
        [w.assessmentId, w.peer],
      ),
    ).toBe(false);
  });

  it('refuses an attempt at a DRAFT assessment on a reachable lesson', async () => {
    // VULN-027. The lesson IS reachable, so a write path checking only
    // `app_actor_may_study_lesson` admitted this — an attempt at unreviewed
    // material, and an oracle confirming the draft's id was real.
    expect(
      await attempt(
        w.learner,
        `INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1,$2)`,
        [w.draftAssessmentId, w.learner],
      ),
    ).toBe(false);
  });

  it('refuses a submission of somebody else’s attempt', async () => {
    const id = await createAttempt({ assessmentId: w.assessmentId, userId: w.learner });
    await db.withActor(w.peer, (tx) =>
      tx.query(`UPDATE assessment_attempts SET status='submitted' WHERE id=$1`, [id]),
    );
    // Filtered to zero rows by the UPDATE policy, so nothing changed.
    const status = await db.withActor(
      w.learner,
      async (tx) =>
        (
          await tx.query<{ status: string }>(`SELECT status FROM assessment_attempts WHERE id=$1`, [
            id,
          ])
        ).rows[0]?.status,
    );
    expect(status).toBe('in_progress');
  });
});

// =====================================================================
// Who can read an attempt
// =====================================================================

describe('attempt visibility', () => {
  const readableCount = (actor: string) =>
    count(actor, 'SELECT count(*) AS n FROM assessment_attempts');

  beforeEach(async () => {
    await createAttempt({
      assessmentId: w.assessmentId,
      userId: w.learner,
      status: 'submitted',
    });
  });

  it('the learner reads their own', async () => {
    expect(await readableCount(w.learner)).toBe(1);
  });

  it('a peer in the same school reads nothing', async () => {
    expect(await readableCount(w.peer)).toBe(0);
  });

  it('the teacher of the shared class reads it', async () => {
    expect(await readableCount(w.teacher)).toBe(1);
  });

  it('a teacher of another school reads nothing', async () => {
    expect(await readableCount(w.foreignTeacher)).toBe(0);
  });

  it('the verified guardian reads it', async () => {
    expect(await readableCount(w.guardian)).toBe(1);
  });

  it('an administrator of the school reads it', async () => {
    expect(await readableCount(w.admin)).toBe(1);
  });

  it('a SECURITY administrator of the same school reads nothing', async () => {
    expect(await readableCount(w.securityAdmin)).toBe(0);
  });

  it('a platform operator reads it', async () => {
    expect(await readableCount(w.operator)).toBe(1);
  });

  it('the individual ANSWERS are narrower than the attempt: owner only', async () => {
    // A teacher can read the SCORE; nothing in this task returns the
    // selections, so nothing here grants them. Widening it later is then a
    // visible decision in a migration.
    const answersFor = (actor: string) =>
      count(actor, 'SELECT count(*) AS n FROM assessment_attempt_answers');
    expect(await answersFor(w.teacher)).toBe(0);
    expect(await answersFor(w.guardian)).toBe(0);
    expect(await answersFor(w.admin)).toBe(0);
  });
});

// =====================================================================
// Retention
// =====================================================================

describe('retention after revocation', () => {
  it('keeps the result readable, and legible, after the class membership ends', async () => {
    await createAttempt({
      assessmentId: w.assessmentId,
      userId: w.learner,
      status: 'submitted',
    });

    const su = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await su.connect();
    await su.query(`UPDATE class_memberships SET status='ended', ended_at=now() WHERE user_id=$1`, [
      w.learner,
    ]);
    await su.end();

    const rows = await db.withActor(
      w.learner,
      async (tx) =>
        (
          await tx.query<{ score: number; activity_title: string; course_title: string }>(
            // The LABEL comes from a definer helper, not a join. A join to
            // `assessments` would return zero rows here — silently erasing the
            // learner's marks from their own view while the rows sat intact.
            `SELECT t.score, lb.activity_title, lb.course_title
             FROM assessment_attempts t
             CROSS JOIN LATERAL app_assessment_label(t.assessment_id) lb
            WHERE t.user_id = $1`,
            [w.learner],
          )
        ).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.activity_title).toBe('Atoms Quiz');
    expect(rows[0]?.course_title).toBe('Chemistry');
  });

  it('but the assessment itself is gone from their view', async () => {
    const su = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await su.connect();
    await su.query(`UPDATE class_memberships SET status='ended', ended_at=now() WHERE user_id=$1`, [
      w.learner,
    ]);
    await su.end();
    expect(await count(w.learner, 'SELECT count(*) AS n FROM assessments')).toBe(0);
    expect(await count(w.learner, 'SELECT count(*) AS n FROM assessment_questions')).toBe(0);
  });

  it('and they can no longer start a new attempt', async () => {
    const su = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await su.connect();
    await su.query(`UPDATE class_memberships SET status='ended', ended_at=now() WHERE user_id=$1`, [
      w.learner,
    ]);
    await su.end();
    expect(
      await attempt(
        w.learner,
        `INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1,$2)`,
        [w.assessmentId, w.learner],
      ),
    ).toBe(false);
  });
});

// =====================================================================
// Content immutability and publication validation
// =====================================================================

describe('an assessment is frozen once it leaves draft', () => {
  it('refuses a question added after publication', async () => {
    expect(
      await attempt(
        w.author,
        `INSERT INTO assessment_questions (assessment_id, position, question_type, prompt)
         VALUES ($1, 9, 'true_false', 'Late')`,
        [w.assessmentId],
      ),
    ).toBe(false);
  });

  it('refuses an option added after publication', async () => {
    expect(
      await attempt(
        w.author,
        `INSERT INTO assessment_options (question_id, position, body) VALUES ($1, 9, 'Late')`,
        [w.q1.questionId],
      ),
    ).toBe(false);
  });

  it('refuses an answer key added after publication', async () => {
    const wrong = w.q1.optionIds.find((id) => !w.q1.correctOptionIds.includes(id))!;
    expect(
      await attempt(
        w.author,
        `INSERT INTO assessment_answer_keys (question_id, option_id) VALUES ($1, $2)`,
        [w.q1.questionId, wrong],
      ),
    ).toBe(false);
  });

  it('grants no UPDATE on questions, options or keys at all', async () => {
    expect(
      await attempt(w.author, `UPDATE assessment_questions SET prompt = 'x' WHERE id = $1`, [
        w.q1.questionId,
      ]),
    ).toBe(false);
    expect(
      await attempt(w.author, `UPDATE assessment_options SET body = 'x' WHERE id = $1`, [
        w.q1.optionIds[0],
      ]),
    ).toBe(false);
  });
});

describe('publication validation', () => {
  const publishAs = async (actor: string, activityId: string) =>
    attempt(
      actor,
      `UPDATE learning_activities SET status='published', published_at=now() WHERE id=$1`,
      [activityId],
    );

  it('refuses to publish an assessment with no questions', async () => {
    const { activityId } = await createActivity({ lessonId: w.lessonA, status: 'draft' });
    const reviewer = await seedReviewer('rev@a.test', w.orgA);
    expect(await publishAs(reviewer, activityId)).toBe(false);
  });

  it('refuses a single-choice question with two correct answers', async () => {
    const { activityId, assessmentId } = await createActivity({
      lessonId: w.lessonA,
      status: 'draft',
    });
    await createQuestion({
      assessmentId: assessmentId!,
      questionType: 'single_choice',
      options: ['A', 'B'],
      correctOptions: [0, 1],
    });
    const reviewer = await seedReviewer('rev2@a.test', w.orgA);
    expect(await publishAs(reviewer, activityId)).toBe(false);
  });

  it('refuses a multiple-choice question where every option is correct', async () => {
    // Unfailable, so it adds marks without measuring anything.
    const { activityId, assessmentId } = await createActivity({
      lessonId: w.lessonA,
      status: 'draft',
    });
    await createQuestion({
      assessmentId: assessmentId!,
      questionType: 'multiple_choice',
      options: ['A', 'B'],
      correctOptions: [0, 1],
    });
    const reviewer = await seedReviewer('rev3@a.test', w.orgA);
    expect(await publishAs(reviewer, activityId)).toBe(false);
  });

  it('refuses a question with no answer key', async () => {
    const { activityId, assessmentId } = await createActivity({
      lessonId: w.lessonA,
      status: 'draft',
    });
    await createQuestion({
      assessmentId: assessmentId!,
      options: ['A', 'B'],
      correctOptions: [],
    });
    const reviewer = await seedReviewer('rev4@a.test', w.orgA);
    expect(await publishAs(reviewer, activityId)).toBe(false);
  });

  it('ACCEPTS a well-formed assessment — the rule is not simply "refuse everything"', async () => {
    const { activityId, assessmentId } = await createActivity({
      lessonId: w.lessonA,
      status: 'draft',
    });
    await createQuestion({
      assessmentId: assessmentId!,
      options: ['A', 'B'],
      correctOptions: [0],
    });
    const reviewer = await seedReviewer('rev5@a.test', w.orgA);
    expect(await publishAs(reviewer, activityId)).toBe(true);
  });

  it('an AUTHOR still cannot publish a well-formed one — the duty split holds', async () => {
    const { activityId, assessmentId } = await createActivity({
      lessonId: w.lessonA,
      status: 'draft',
    });
    await createQuestion({
      assessmentId: assessmentId!,
      options: ['A', 'B'],
      correctOptions: [0],
    });
    expect(await publishAs(w.author, activityId)).toBe(false);
  });
});

describe('activity visibility', () => {
  it('a learner sees only the published activity, not the draft beside it', async () => {
    const titles = await db.withActor(w.learner, async (tx) =>
      (
        await tx.query<{ title: string }>(`SELECT title FROM learning_activities ORDER BY title`)
      ).rows.map((r) => r.title),
    );
    expect(titles).toEqual(['Atoms Quiz']);
  });

  it('the author sees both', async () => {
    expect(await count(w.author, 'SELECT count(*) AS n FROM learning_activities')).toBe(2);
  });

  it('a teacher from another school sees neither', async () => {
    expect(await count(w.foreignTeacher, 'SELECT count(*) AS n FROM learning_activities')).toBe(0);
  });

  it('an assessment is exactly as visible as its activity', async () => {
    // No independent lifecycle means no rule that could disagree.
    expect(await count(w.learner, 'SELECT count(*) AS n FROM assessments')).toBe(1);
    expect(await count(w.author, 'SELECT count(*) AS n FROM assessments')).toBe(2);
  });

  it('an activity cannot be moved to another lesson', async () => {
    const otherLesson = await createLesson({
      unitId: (
        await db.withActor(
          w.author,
          async (tx) =>
            (
              await tx.query<{ unit_id: string }>(`SELECT unit_id FROM lessons WHERE id = $1`, [
                w.lessonA,
              ])
            ).rows,
        )
      )[0]!.unit_id,
      title: 'Elsewhere',
      status: 'published',
      position: 9,
    });
    expect(
      await attempt(w.author, `UPDATE learning_activities SET lesson_id = $2 WHERE id = $1`, [
        w.activityId,
        otherLesson,
      ]),
    ).toBe(false);
  });
});

// =====================================================================
// Result release — the withholding rule, at the database
//
// Everything below runs as `edu_app` with no application code in the path. If
// `assessmentAttemptPolicy` were deleted, these are the boundaries that would
// still hold, and they are deliberately the SAME boundaries the unit decision
// table asserts. Two independent mechanisms agreeing is the design; one of them
// silently disappearing is what these tests exist to catch.
// =====================================================================

/**
 * A second assessment on the same lesson whose results are WITHHELD.
 *
 * Published through the same superuser path as the seed's, because publication
 * is the reviewer's act and this file is testing release, not publication.
 */
async function seedWithheld(): Promise<{ assessmentId: string; q: QuestionSeed }> {
  const { activityId, assessmentId } = await createActivity({
    lessonId: w.lessonA,
    title: 'Withheld Quiz',
    status: 'draft',
    maxAttempts: 2,
    passingPercentage: 50,
    reviewPolicy: 'on_release',
  });
  if (!assessmentId) throw new Error('seed: no withheld assessment');
  const q = await createQuestion({
    assessmentId,
    questionType: 'single_choice',
    prompt: 'Is a result withheld until released?',
    points: 2,
    options: ['Yes', 'No'],
    correctOptions: [0],
    explanation: 'Because a teacher decides when a class sees its marks.',
  });
  const su = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
  await su.connect();
  await su.query(
    `UPDATE learning_activities SET status='published', published_at=now() WHERE id=$1`,
    [activityId],
  );
  await su.end();
  return { assessmentId, q };
}

type QuestionSeed = { questionId: string; optionIds: string[]; correctOptionIds: string[] };

/** Sits the assessment as the learner, answering with the given option. */
async function sit(assessmentId: string, questionId: string, optionId: string): Promise<string> {
  return db.withActor(w.learner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1, $2) RETURNING id`,
      [assessmentId, w.learner],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('no attempt');
    await tx.query(
      `INSERT INTO assessment_attempt_answers (attempt_id, question_id, option_id)
       VALUES ($1, $2, $3)`,
      [id, questionId, optionId],
    );
    await tx.query(`UPDATE assessment_attempts SET status = 'submitted' WHERE id = $1`, [id]);
    return id;
  });
}

/** Reads the release columns as the given actor, or null when the row is invisible. */
async function releaseState(
  actorId: string,
  attemptId: string,
): Promise<{ releasedAt: Date | null; releasedBy: string | null; comment: string | null } | null> {
  return db.withActor(actorId, async (tx) => {
    const { rows } = await tx.query<{
      released_at: Date | null;
      released_by: string | null;
      teacher_comment: string | null;
    }>(`SELECT released_at, released_by, teacher_comment FROM assessment_attempts WHERE id = $1`, [
      attemptId,
    ]);
    const r = rows[0];
    return r
      ? { releasedAt: r.released_at, releasedBy: r.released_by, comment: r.teacher_comment }
      : null;
  });
}

const RELEASE_SQL = `UPDATE assessment_attempts
                        SET released_at = now(), released_by = app_current_actor()
                      WHERE id = $1`;

describe('the review policy decides whether a result is released at all', () => {
  it('an `on_submission` assessment releases the moment it is scored', async () => {
    // Task 008's behaviour, preserved exactly. The default must not change what
    // any existing assessment does, or this migration would silently retract
    // results children had already been shown.
    const id = await sit(w.assessmentId, w.q1.questionId, w.q1.correctOptionIds[0]!);
    const state = await releaseState(w.learner, id);
    expect(state?.releasedAt).not.toBeNull();
  });

  it('…released BY NOBODY, because no person decided it', async () => {
    // A non-null `released_by` always names someone who made a decision. An
    // automatic release names nobody, and that distinction is the audit trail.
    const id = await sit(w.assessmentId, w.q1.questionId, w.q1.correctOptionIds[0]!);
    expect((await releaseState(w.learner, id))?.releasedBy).toBeNull();
  });

  it('an `on_release` assessment scores WITHOUT releasing', async () => {
    const { assessmentId, q } = await seedWithheld();
    const id = await sit(assessmentId, q.questionId, q.correctOptionIds[0]!);
    expect((await releaseState(w.learner, id))?.releasedAt).toBeNull();

    // The mark exists — the database computed it. It is the DISCLOSURE that is
    // withheld, not the scoring, and a test that confused the two would let
    // "withheld" quietly become "never marked".
    const { rows } = await db.withActor(w.teacher, (tx) =>
      tx.query<{ score: number }>(`SELECT score FROM assessment_attempts WHERE id = $1`, [id]),
    );
    expect(rows[0]?.score).toBe(2);
  });

  it('THE REVIEW POLICY CANNOT BE CHANGED once the assessment is published', async () => {
    // Otherwise a teacher could retro-withhold results children had already been
    // shown, or retro-disclose results a class was told would be held back —
    // and neither would be visible afterwards, because the column carries no
    // history.
    //
    // This test found a real gap. 0019 froze an assessment's QUESTIONS at
    // publication but left the `assessments` row itself writable by any content
    // author in the school; nothing in the application ever updated it, so
    // nothing exercised that until this task added a column where it mattered.
    // `assessments_config_draft_only` is the fix.
    expect(
      await attempt(
        w.teacher,
        `UPDATE assessments SET review_policy = 'on_release' WHERE id = $1`,
        [w.assessmentId],
      ),
    ).toBe(false);
    const { rows } = await db.withActor(w.teacher, (tx) =>
      tx.query<{ review_policy: string }>(`SELECT review_policy FROM assessments WHERE id = $1`, [
        w.assessmentId,
      ]),
    );
    expect(rows[0]?.review_policy).toBe('on_submission');
  });

  it.each([
    ['the pass mark', `passing_percentage = 99`],
    ['the attempt limit', `max_attempts = 50`],
  ])('nor can %s — the whole configuration is frozen with the paper', async (_l, assignment) => {
    // Moving the pass mark after a paper is sat re-decides who failed. The
    // freeze is stated over a column group rather than a list, so a
    // configuration column added later is frozen by default.
    expect(
      await attempt(w.teacher, `UPDATE assessments SET ${assignment} WHERE id = $1`, [
        w.assessmentId,
      ]),
    ).toBe(false);
  });

  it('but a DRAFT assessment is still configurable', async () => {
    // The positive case. A freeze that also applied in draft would make an
    // assessment unauthorable, and somebody would then loosen the wrong half.
    expect(
      await changedRows(
        w.author,
        `UPDATE assessments SET review_policy = 'on_release', passing_percentage = 60 WHERE id = $1`,
        [w.draftAssessmentId],
      ),
    ).toBe(1);
  });
});

describe('who may release a withheld result', () => {
  let assessmentId: string;
  let q: QuestionSeed;
  let attemptId: string;

  beforeEach(async () => {
    ({ assessmentId, q } = await seedWithheld());
    attemptId = await sit(assessmentId, q.questionId, q.correctOptionIds[0]!);
  });

  it('THE LEARNER CANNOT RELEASE THEIR OWN RESULT', async () => {
    // The row is visible to them (they may read their own attempt), so this is
    // not hidden by the SELECT policy — the UPDATE policy is what refuses it,
    // independently of anything the application does.
    expect(await changedRows(w.learner, RELEASE_SQL, [attemptId])).toBe(0);
    expect((await releaseState(w.learner, attemptId))?.releasedAt).toBeNull();
  });

  it('a peer cannot release it', async () => {
    expect(await changedRows(w.peer, RELEASE_SQL, [attemptId])).toBe(0);
  });

  it('a guardian of the learner cannot release it — though they may read it', async () => {
    expect(await releaseState(w.guardian, attemptId)).not.toBeNull();
    expect(await changedRows(w.guardian, RELEASE_SQL, [attemptId])).toBe(0);
  });

  it('a teacher of ANOTHER school cannot release it', async () => {
    expect(await changedRows(w.foreignTeacher, RELEASE_SQL, [attemptId])).toBe(0);
  });

  it('a teacher of the same school but NOT of the learner’s class cannot release it', async () => {
    // The sharpest of the negatives: same organization, same role, same
    // assessment. Only the class roster separates them.
    const stranger = (
      await createUser({ email: 'stranger@a.test', roles: [], organizationId: w.orgA })
    ).id;
    await grantRole(stranger, 'teacher', 'organization', w.orgA);
    expect(await changedRows(stranger, RELEASE_SQL, [attemptId])).toBe(0);
  });

  it('a SECURITY administrator of the same school cannot release it', async () => {
    expect(await changedRows(w.securityAdmin, RELEASE_SQL, [attemptId])).toBe(0);
  });

  it('the teacher of the shared class CAN release it', async () => {
    // The positive case. Without it, a policy that refused everybody would pass
    // every test above and somebody would later loosen the wrong thing.
    expect(await changedRows(w.teacher, RELEASE_SQL, [attemptId])).toBe(1);
    const state = await releaseState(w.learner, attemptId);
    expect(state?.releasedAt).not.toBeNull();
    expect(state?.releasedBy).toBe(w.teacher);
  });

  it('an administrator of the learner’s school CAN release it', async () => {
    expect(await changedRows(w.admin, RELEASE_SQL, [attemptId])).toBe(1);
  });

  it('nothing can be released before it is submitted', async () => {
    const open = await db.withActor(w.learner, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1, $2) RETURNING id`,
        [assessmentId, w.learner],
      );
      return rows[0]!.id;
    });
    // Not refused by the UPDATE policy — the teacher may act on the row — but
    // by the guard, which blanks the release columns of an unsubmitted attempt.
    await changedRows(w.teacher, RELEASE_SQL, [open]);
    expect((await releaseState(w.teacher, open))?.releasedAt).toBeNull();
  });
});

describe('what a release may and may not carry', () => {
  let assessmentId: string;
  let q: QuestionSeed;
  let attemptId: string;

  beforeEach(async () => {
    ({ assessmentId, q } = await seedWithheld());
    attemptId = await sit(assessmentId, q.questionId, q.correctOptionIds[0]!);
  });

  it('A RELEASE CANNOT SMUGGLE A SCORE CHANGE ALONGSIDE IT', async () => {
    // The `to_jsonb(NEW) - <release columns>` comparison in the guard makes this
    // a fact rather than an intention: every other column must be
    // byte-identical, so the whole statement is refused rather than partially
    // applied. A teacher who can release must not thereby be able to mark.
    expect(
      await attempt(
        w.teacher,
        `UPDATE assessment_attempts SET released_at = now(), score = 999 WHERE id = $1`,
        [attemptId],
      ),
    ).toBe(false);
    const { rows } = await db.withActor(w.teacher, (tx) =>
      tx.query<{ score: number; released_at: Date | null }>(
        `SELECT score, released_at FROM assessment_attempts WHERE id = $1`,
        [attemptId],
      ),
    );
    // Neither half landed.
    expect(rows[0]?.score).toBe(2);
    expect(rows[0]?.released_at).toBeNull();
  });

  it.each([
    // Every value here must DIFFER from what the attempt already holds. The
    // guard compares the whole row, so `passed = true` on a paper that already
    // passed is not a change at all and is correctly allowed through as a plain
    // release — a table of no-ops would have asserted nothing.
    ['passed', `passed = false`],
    ['percentage', `percentage = 12.5`],
    ['max_score', `max_score = 1`],
    ['status', `status = 'in_progress'`],
    ['submitted_at', `submitted_at = now() - interval '1 day'`],
  ])('a release cannot change %s either', async (_label, assignment) => {
    expect(
      await attempt(
        w.teacher,
        `UPDATE assessment_attempts SET released_at = now(), ${assignment} WHERE id = $1`,
        [attemptId],
      ),
    ).toBe(false);
  });

  it('a release CAN carry a teacher comment', async () => {
    expect(
      await changedRows(
        w.teacher,
        `UPDATE assessment_attempts
            SET released_at = now(), released_by = app_current_actor(), teacher_comment = $2
          WHERE id = $1`,
        [attemptId, 'راجع السؤال الثاني'],
      ),
    ).toBe(1);
    expect((await releaseState(w.learner, attemptId))?.comment).toBe('راجع السؤال الثاني');
  });

  it('THE RELEASE TIMESTAMP IS THE SERVER’S, NOT THE CALLER’S', async () => {
    // A backdated release would falsify the record of when a child was told
    // their mark. The guard overwrites `released_at` with `now()` unconditionally.
    const backdated = new Date('2001-01-01T00:00:00Z');
    await changedRows(
      w.teacher,
      `UPDATE assessment_attempts SET released_at = $2, released_by = app_current_actor() WHERE id = $1`,
      [attemptId, backdated],
    );
    const state = await releaseState(w.teacher, attemptId);
    expect(state?.releasedAt).not.toBeNull();
    expect(state!.releasedAt!.getFullYear()).toBeGreaterThan(2020);
  });

  it('a released result CANNOT BE UN-RELEASED', async () => {
    // Taking a mark back after a child has seen it is not a state this system
    // has. The row becomes invisible to the release policy once `released_at`
    // is set, so the update matches nothing.
    await changedRows(w.teacher, RELEASE_SQL, [attemptId]);
    expect(
      await changedRows(
        w.teacher,
        `UPDATE assessment_attempts SET released_at = NULL WHERE id = $1`,
        [attemptId],
      ),
    ).toBe(0);
    expect((await releaseState(w.learner, attemptId))?.releasedAt).not.toBeNull();
  });

  it('re-releasing is a no-op rather than an error — which is what makes it idempotent', async () => {
    await changedRows(w.teacher, RELEASE_SQL, [attemptId]);
    const first = (await releaseState(w.teacher, attemptId))!.releasedAt;
    expect(await changedRows(w.admin, RELEASE_SQL, [attemptId])).toBe(0);
    const second = (await releaseState(w.teacher, attemptId))!.releasedAt;
    // Not merely "no error": the original release is intact, releaser and all.
    expect(second?.getTime()).toBe(first?.getTime());
    expect((await releaseState(w.teacher, attemptId))?.releasedBy).toBe(w.teacher);
  });

  it('an already-submitted `on_submission` attempt is equally frozen', async () => {
    // Auto-released attempts go through the same guard, so the freeze Task 008
    // established is not weakened for them by the release exception.
    const id = await sit(w.assessmentId, w.q1.questionId, w.q1.correctOptionIds[0]!);
    // Released already, so the release policy no longer admits the row and the
    // statement matches nothing rather than raising. Either way the mark stands
    // — which is the property, so it is what the test reads back.
    expect(
      await changedRows(w.teacher, `UPDATE assessment_attempts SET score = 0 WHERE id = $1`, [id]),
    ).toBe(0);
    const { rows } = await db.withActor(w.teacher, (tx) =>
      tx.query<{ score: number }>(`SELECT score FROM assessment_attempts WHERE id = $1`, [id]),
    );
    expect(rows[0]?.score).toBe(2);
  });
});

describe('the marked paper', () => {
  let assessmentId: string;
  let q: QuestionSeed;
  let attemptId: string;

  const review = (actorId: string, id: string) =>
    db.withActor(actorId, async (tx) => {
      const { rows } = await tx.query(`SELECT * FROM app_attempt_review($1)`, [id]);
      return rows;
    });

  beforeEach(async () => {
    ({ assessmentId, q } = await seedWithheld());
    attemptId = await sit(assessmentId, q.questionId, q.correctOptionIds[0]!);
  });

  it('RETURNS NOTHING AT ALL BEFORE RELEASE — not even to the learner who sat it', async () => {
    // Empty, not redacted. An unreleased paper discloses no key, no
    // correctness, and not even how many questions there were.
    expect(await review(w.learner, attemptId)).toHaveLength(0);
  });

  it('is empty before release for a guardian too', async () => {
    expect(await review(w.guardian, attemptId)).toHaveLength(0);
  });

  it('returns the marked paper to the learner after release', async () => {
    await changedRows(w.teacher, RELEASE_SQL, [attemptId]);
    const rows = await review(w.learner, attemptId);
    expect(rows).toHaveLength(1);
    const row = rows[0] as {
      is_correct: boolean;
      awarded: number;
      explanation: string;
      correct_option_ids: string[];
      selected_option_ids: string[];
    };
    expect(row.is_correct).toBe(true);
    expect(row.awarded).toBe(2);
    expect(row.explanation).toBe('Because a teacher decides when a class sees its marks.');
    expect(row.correct_option_ids).toEqual(q.correctOptionIds);
    expect(row.selected_option_ids).toEqual([q.correctOptionIds[0]]);
  });

  it('A TEACHER MAY REVIEW BEFORE RELEASE — that is how they decide to release', async () => {
    const rows = await review(w.teacher, attemptId);
    expect(rows).toHaveLength(1);
  });

  it('IS EMPTY FOR A PEER even after release — release is not publication', async () => {
    await changedRows(w.teacher, RELEASE_SQL, [attemptId]);
    expect(await review(w.peer, attemptId)).toHaveLength(0);
  });

  it.each([
    ['a teacher of another school', () => w.foreignTeacher],
    ['a security administrator', () => w.securityAdmin],
  ])('is empty for %s even after release', async (_label, who) => {
    await changedRows(w.teacher, RELEASE_SQL, [attemptId]);
    expect(await review(who(), attemptId)).toHaveLength(0);
  });

  it('IS NOT A KEY ORACLE: an unrelated learner learns nothing from an id', async () => {
    // The function is granted to `edu_app`, so every actor may CALL it. It is
    // safe only because it re-asks both questions itself — this is the test of
    // that claim.
    await changedRows(w.teacher, RELEASE_SQL, [attemptId]);
    expect(await review(w.peer, attemptId)).toHaveLength(0);
    // And the key table remains unreadable to them by any other route.
    expect(await count(w.peer, 'SELECT count(*) AS n FROM assessment_answer_keys')).toBe(0);
  });

  it('does not widen the answer-key table for the learner it releases to', async () => {
    // A released paper hands back one attempt's worth of answers. It must not
    // become general read access to the key.
    await changedRows(w.teacher, RELEASE_SQL, [attemptId]);
    expect(await review(w.learner, attemptId)).toHaveLength(1);
    expect(await count(w.learner, 'SELECT count(*) AS n FROM assessment_answer_keys')).toBe(0);
  });

  it('cannot be walked: an id the caller does not own returns nothing', async () => {
    // There is no form of this query that enumerates an assessment, a class or
    // a learner. A second learner's released paper is invisible to the first.
    // Seeded rather than sat: the peer is not on this class's roster, so they
    // could not start the attempt themselves. The fixture builds the state
    // directly, which is exactly what a negative test needs.
    const peerAttempt = await createAttempt({
      assessmentId,
      userId: w.peer,
      status: 'submitted',
    });
    await changedRows(w.admin, RELEASE_SQL, [peerAttempt]);
    expect(await review(w.learner, peerAttempt)).toHaveLength(0);
  });

  it('agrees with the scorer about what the paper is worth', async () => {
    // Two implementations of the same marking rule — `app_score_attempt`
    // returns totals, `app_attempt_review` returns rows — and a disagreement
    // between them would mean a child's review contradicted their mark.
    await changedRows(w.teacher, RELEASE_SQL, [attemptId]);
    const rows = (await review(w.learner, attemptId)) as Array<{ awarded: number }>;
    const fromReview = rows.reduce((sum, r) => sum + r.awarded, 0);
    const { rows: stored } = await db.withActor(w.learner, (tx) =>
      tx.query<{ score: number }>(`SELECT score FROM assessment_attempts WHERE id = $1`, [
        attemptId,
      ]),
    );
    expect(fromReview).toBe(stored[0]?.score);
  });

  it('gives no partial credit, in agreement with the scorer', async () => {
    const wrong = q.optionIds.find((id) => !q.correctOptionIds.includes(id))!;
    const id = await sit(assessmentId, q.questionId, wrong);
    await changedRows(w.teacher, RELEASE_SQL, [id]);
    const rows = (await review(w.learner, id)) as Array<{ awarded: number; is_correct: boolean }>;
    expect(rows[0]?.awarded).toBe(0);
    expect(rows[0]?.is_correct).toBe(false);
    // And the learner is still told what the right answer WAS. That is the
    // educational point of review: a wrong answer that teaches nothing is
    // worth less than one that does.
    expect((rows[0] as unknown as { correct_option_ids: string[] }).correct_option_ids).toEqual(
      q.correctOptionIds,
    );
  });
});
