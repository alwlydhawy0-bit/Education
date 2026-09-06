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
  createExperiment,
  createLabSession,
  createLesson,
  createOrganization,
  createUnit,
  createUser,
  grantRole,
  linkGuardian,
  seedDb,
  truncateAll,
} from '../setup/fixtures.ts';

/**
 * Row-Level Security for interactive labs.
 *
 * No application code is in the path. Every statement runs as `edu_app`
 * (NOBYPASSRLS, non-owner) with `app.actor_id` set exactly as a request would
 * set it. If the entire policy engine were deleted tomorrow, these are the
 * boundaries that would still hold.
 *
 * This file began as the adversarial probe written BEFORE any application
 * code — the probe that found the `to_jsonb` trigger defect recorded in
 * migration 0024. It is kept as the suite because a probe that is thrown away
 * only protects the afternoon it was written.
 */
const db: Database = createDatabase({ connectionString: TEST_APP_URL, poolMax: 4 });

afterAll(async () => {
  await db.close();
  await closeSeedDb();
});

beforeEach(truncateAll);

/**
 * Did the statement actually do anything?
 *
 * NOT simply "did it throw". An UPDATE whose rows are excluded by an RLS
 * USING clause does not raise — it matches nothing and reports zero rows, and
 * a helper that only watched for exceptions would call that a success. The
 * first run of this probe did exactly that and reported five refusals as
 * breaches. `WITH CHECK` raises; `USING` goes quiet, and both are refusals.
 */
async function attempt(actorId: string, sql: string, params: unknown[] = []): Promise<boolean> {
  try {
    const result = await db.withActor(actorId, (tx) => tx.query(sql, params));
    return (result.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

async function failure(actorId: string, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await db.withActor(actorId, (tx) => tx.query(sql, params));
    return 'NO ERROR';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The rule set every published fixture lab below is marked against. */
const CIRCUIT_RULES = {
  rules: [
    { path: 'circuit.closed', op: 'isTrue' },
    { path: 'circuit.voltage', op: 'approx', value: 5, tolerance: 0.1 },
  ],
};

/**
 * One school, one class, one published lab.
 *
 *   learner   — in the class, which is assigned the course. May sit the lab.
 *   outsider  — same school, no class. May not see the lab at all.
 *   teacher   — teaches the class.
 *   stranger  — a teacher at another school entirely.
 *   guardian  — verified guardian of `learner`.
 *   author    — content author at the school.
 */
async function world() {
  const orgA = await createOrganization('School A');
  const orgB = await createOrganization('School B');
  const level = await createEducationLevel();

  const mk = (email: string, roles?: readonly string[], org: string | null = orgA) =>
    createUser({ email, ...(roles ? { roles } : {}), organizationId: org });

  const learner = await mk('learner@a.test', ['student']);
  const outsider = await mk('outsider@a.test', ['student']);
  const teacher = await mk('teacher@a.test', ['teacher']);
  const stranger = await mk('stranger@b.test', ['teacher'], orgB);
  const guardian = await mk('guardian@a.test', ['guardian']);
  const author = await mk('author@a.test', ['content_author']);
  const admin = await mk('admin@a.test', ['admin']);
  await grantRole(admin.id, 'admin', 'organization', orgA);

  const curriculum = await createCurriculum({ organizationId: orgA, status: 'published' });
  const course = await createCourse({
    organizationId: orgA,
    curriculumId: curriculum,
    levelId: level,
    status: 'published',
  });
  const unit = await createUnit({ courseId: course, status: 'published' });
  const lesson = await createLesson({ unitId: unit, status: 'published' });

  const klass = await createClass(orgA, 'A1');
  await addClassMember(klass, learner.id);
  await assignTeacher(teacher.id, klass);
  await assignCourseToClass({ classId: klass, courseId: course });
  await linkGuardian(guardian.id, learner.id, 'verified');

  const lab = await createExperiment({
    lessonId: lesson,
    status: 'published',
    rules: CIRCUIT_RULES,
  });

  return {
    orgA,
    orgB,
    learner,
    outsider,
    teacher,
    stranger,
    guardian,
    author,
    admin,
    lesson,
    course,
    klass,
    lab,
  };
}

describe('the answer key is not reachable by anyone sitting the lab', () => {
  it('returns the validation rules to an author and NOTHING to a learner', async () => {
    const w = await world();

    const asLearner = await db.withActor(w.learner.id, (tx) =>
      tx.query('SELECT experiment_id FROM experiment_validation_rules'),
    );
    expect(asLearner.rows).toEqual([]);

    const asAuthor = await db.withActor(w.author.id, (tx) =>
      tx.query('SELECT experiment_id FROM experiment_validation_rules'),
    );
    expect(asAuthor.rows).toHaveLength(1);
  });

  it('shows the rules to a teacher, who holds `content:author` on this platform', async () => {
    // Not an oversight, and worth stating because it looks like one. The
    // `teacher` role is granted `content:author` in the 0007 seed, so a
    // teacher IS an author here and the rules policy admits them by the same
    // clause it admits `content_author` by. This is exactly how
    // `assessment_answer_keys` already behaves; a lab that hid its rules from
    // teachers while the quiz next to it showed its answer key would be the
    // inconsistency, not this.
    //
    // The boundary that matters — and that the rest of this block asserts — is
    // the learner, who holds neither permission.
    const w = await world();
    const seen = await db.withActor(w.teacher.id, (tx) =>
      tx.query('SELECT experiment_id FROM experiment_validation_rules'),
    );
    expect(seen.rows).toHaveLength(1);

    const stranger = await db.withActor(w.stranger.id, (tx) =>
      tx.query('SELECT experiment_id FROM experiment_validation_rules'),
    );
    expect(stranger.rows).toEqual([]);
  });

  it('does not leak the rules through a join from a table the learner CAN read', async () => {
    const w = await world();
    const joined = await db.withActor(w.learner.id, (tx) =>
      tx.query(
        `SELECT v.rules
           FROM experiments e
           LEFT JOIN experiment_validation_rules v ON v.experiment_id = e.id`,
      ),
    );
    expect(joined.rows).toEqual([{ rules: null }]);
  });

  it('does not expose the marker function to the application role', async () => {
    const w = await world();
    const message = await failure(
      w.learner.id,
      `SELECT app_experiment_state_satisfies($1, '{}'::jsonb)`,
      [w.lab.experimentId],
    );
    expect(message).toMatch(/permission denied/i);
  });
});

describe('who may see a lab at all', () => {
  it('shows the published lab to the enrolled learner', async () => {
    const w = await world();
    const seen = await db.withActor(w.learner.id, (tx) =>
      tx.query('SELECT id FROM experiments'),
    );
    expect(seen.rows.map((r) => r['id'])).toEqual([w.lab.experimentId]);
  });

  it('hides it from a learner in no class', async () => {
    const w = await world();
    const seen = await db.withActor(w.outsider.id, (tx) =>
      tx.query('SELECT id FROM experiments'),
    );
    expect(seen.rows).toEqual([]);
  });

  it('hides it from a teacher at another school', async () => {
    const w = await world();
    const seen = await db.withActor(w.stranger.id, (tx) =>
      tx.query('SELECT id FROM experiments'),
    );
    expect(seen.rows).toEqual([]);
  });

  it('hides a DRAFT lab from the learner while showing it to the author', async () => {
    const w = await world();
    const draft = await createExperiment({ lessonId: w.lesson, status: 'draft' });

    const learnerSees = await db.withActor(w.learner.id, (tx) =>
      tx.query('SELECT id FROM experiments WHERE id = $1', [draft.experimentId]),
    );
    expect(learnerSees.rows).toEqual([]);

    const authorSees = await db.withActor(w.author.id, (tx) =>
      tx.query('SELECT id FROM experiments WHERE id = $1', [draft.experimentId]),
    );
    expect(authorSees.rows).toHaveLength(1);
  });
});

describe('sessions belong to the learner who sat them', () => {
  it('lets the enrolled learner start one, and refuses everyone else', async () => {
    const w = await world();
    const start = (actor: string, owner: string) =>
      attempt(
        actor,
        `INSERT INTO experiment_sessions (experiment_id, user_id) VALUES ($1, $2)`,
        [w.lab.experimentId, owner],
      );

    expect(await start(w.learner.id, w.learner.id)).toBe(true);
    expect(await start(w.outsider.id, w.outsider.id)).toBe(false);
    expect(await start(w.teacher.id, w.teacher.id)).toBe(false);
  });

  it('refuses a session opened in somebody else’s name', async () => {
    const w = await world();
    const forged = await attempt(
      w.outsider.id,
      `INSERT INTO experiment_sessions (experiment_id, user_id) VALUES ($1, $2)`,
      [w.lab.experimentId, w.learner.id],
    );
    expect(forged).toBe(false);
  });

  it('allows exactly one live session per learner per lab', async () => {
    const w = await world();
    const start = () =>
      attempt(
        w.learner.id,
        `INSERT INTO experiment_sessions (experiment_id, user_id) VALUES ($1, $2)`,
        [w.lab.experimentId, w.learner.id],
      );
    expect(await start()).toBe(true);
    expect(await start()).toBe(false);
  });

  it('shows a session to its owner, guardian, teacher and admin — and to nobody else', async () => {
    const w = await world();
    await createLabSession({ experimentId: w.lab.experimentId, userId: w.learner.id });

    const visible = async (actor: string) =>
      (await db.withActor(actor, (tx) => tx.query('SELECT id FROM experiment_sessions'))).rows
        .length;

    expect(await visible(w.learner.id)).toBe(1);
    expect(await visible(w.guardian.id)).toBe(1);
    expect(await visible(w.teacher.id)).toBe(1);
    expect(await visible(w.admin.id)).toBe(1);
    expect(await visible(w.outsider.id)).toBe(0);
    expect(await visible(w.stranger.id)).toBe(0);
  });

  it('refuses a learner writing into another learner’s session', async () => {
    const w = await world();
    const session = await createLabSession({
      experimentId: w.lab.experimentId,
      userId: w.learner.id,
    });
    const written = await attempt(
      w.outsider.id,
      `UPDATE experiment_sessions SET current_state = '{"x":1}'::jsonb WHERE id = $1`,
      [session],
    );
    expect(written).toBe(false);

    const state = await db.withActor(w.learner.id, (tx) =>
      tx.query<{ current_state: unknown }>(
        'SELECT current_state FROM experiment_sessions WHERE id = $1',
        [session],
      ),
    );
    expect(state.rows[0]?.current_state).toEqual({});
  });

  it('refuses a teacher working through a lab even in their OWN name', async () => {
    /**
     * THE CASE THAT SEPARATES THE TWO CONJUNCTS in the session UPDATE policy,
     * and the reason it exists as its own test.
     *
     * The policy asks both `app_actor_sees_experiment` and
     * `app_actor_may_study_lesson`. For a LEARNER the two move together —
     * leaving the class fails both — so every isolation test above passes with
     * either one deleted, and a defect-injection round proved exactly that.
     *
     * A teacher is where they part. `app_actor_reaches_course` is satisfied by
     * TEACHING as well as studying, so a teacher SEES the lab and may not STUDY
     * it. Without the study conjunct, a teacher could work through a lab and
     * have the database record a pass for them — which is not a disaster on its
     * own, but it is the clause §3 rests on, and a clause no test can remove is
     * a clause nobody is checking.
     *
     * The session is seeded directly because a teacher cannot create one: the
     * INSERT policy refuses them, as the test above this one asserts.
     */
    const w = await world();
    const session = await createLabSession({
      experimentId: w.lab.experimentId,
      userId: w.teacher.id,
    });

    expect(
      await attempt(
        w.teacher.id,
        `UPDATE experiment_sessions SET current_state = '{"a":1}'::jsonb WHERE id = $1`,
        [session],
      ),
    ).toBe(false);

    expect(
      await attempt(
        w.teacher.id,
        `UPDATE experiment_sessions SET status = 'submitted' WHERE id = $1`,
        [session],
      ),
    ).toBe(false);
  });

  it('refuses a TEACHER writing into a learner’s session', async () => {
    // A teacher marks; a teacher does not do the child's lab for them.
    const w = await world();
    const session = await createLabSession({
      experimentId: w.lab.experimentId,
      userId: w.learner.id,
    });
    expect(
      await attempt(
        w.teacher.id,
        `UPDATE experiment_sessions SET status = 'submitted' WHERE id = $1`,
        [session],
      ),
    ).toBe(false);
  });
});

describe('the outcome is the database’s word, never the client’s', () => {
  it('discards a forged `passed` and `status` on submission', async () => {
    const w = await world();
    const session = await createLabSession({
      experimentId: w.lab.experimentId,
      userId: w.learner.id,
    });

    // The learner submits a state that does NOT satisfy the rules, while
    // claiming to have passed. This is the whole attack.
    await db.withActor(w.learner.id, (tx) =>
      tx.query(
        `UPDATE experiment_sessions
            SET current_state = '{"circuit":{"closed":false,"voltage":0}}'::jsonb,
                status = 'submitted',
                passed = true,
                completed_at = now()
          WHERE id = $1`,
        [session],
      ),
    );

    const row = await db.withActor(w.learner.id, (tx) =>
      tx.query<{ status: string; passed: boolean | null; completed_at: Date | null }>(
        'SELECT status, passed, completed_at FROM experiment_sessions WHERE id = $1',
        [session],
      ),
    );
    expect(row.rows[0]?.passed).toBe(false);
    expect(row.rows[0]?.status).toBe('submitted');
    expect(row.rows[0]?.completed_at).toBeNull();
  });

  it('marks a genuinely satisfying state as completed', async () => {
    const w = await world();
    const session = await createLabSession({
      experimentId: w.lab.experimentId,
      userId: w.learner.id,
    });

    await db.withActor(w.learner.id, (tx) =>
      tx.query(
        `UPDATE experiment_sessions
            SET current_state = '{"circuit":{"closed":true,"voltage":5.05}}'::jsonb,
                status = 'submitted'
          WHERE id = $1`,
        [session],
      ),
    );

    const row = await db.withActor(w.learner.id, (tx) =>
      tx.query<{ status: string; passed: boolean | null }>(
        'SELECT status, passed FROM experiment_sessions WHERE id = $1',
        [session],
      ),
    );
    expect(row.rows[0]?.status).toBe('completed');
    expect(row.rows[0]?.passed).toBe(true);
  });

  it('refuses a client that asks for `completed` directly', async () => {
    const w = await world();
    const session = await createLabSession({
      experimentId: w.lab.experimentId,
      userId: w.learner.id,
    });
    const message = await failure(
      w.learner.id,
      `UPDATE experiment_sessions
          SET current_state = '{"circuit":{"closed":true,"voltage":5}}'::jsonb,
              status = 'completed'
        WHERE id = $1`,
      [session],
    );
    expect(message).toMatch(/submitted, never completed directly/i);
  });

  it('refuses a second submission of the same session', async () => {
    const w = await world();
    const session = await createLabSession({
      experimentId: w.lab.experimentId,
      userId: w.learner.id,
      submit: true,
    });
    // The UPDATE policy requires status = 'in_progress', so a resubmission is
    // not merely rejected by the trigger — the row is not updatable at all.
    const changed = await attempt(
      w.learner.id,
      `UPDATE experiment_sessions SET status = 'submitted' WHERE id = $1`,
      [session],
    );
    expect(changed).toBe(false);
  });

  it('silently discards a learner re-pointing a session at another learner', async () => {
    // The UPDATE is permitted and changes nothing: the submit guard restores
    // `user_id` from OLD before the WITH CHECK clause ever sees it, so the
    // write lands on the row it started on. Asserting a rejection here would
    // have been asserting the wrong defence — what matters is that ownership
    // did not move, and it is the trigger, not the policy, that holds it.
    const w = await world();
    const session = await createLabSession({
      experimentId: w.lab.experimentId,
      userId: w.learner.id,
    });
    await db.withActor(w.learner.id, (tx) =>
      tx.query(`UPDATE experiment_sessions SET user_id = $2 WHERE id = $1`, [
        session,
        w.outsider.id,
      ]),
    );

    const seed = await seedDb();
    const owner = await seed.query<{ user_id: string }>(
      'SELECT user_id FROM experiment_sessions WHERE id = $1',
      [session],
    );
    expect(owner.rows[0]?.user_id).toBe(w.learner.id);
  });
});

describe('instant state isolation', () => {
  it('refuses the next save the moment the learner leaves the class', async () => {
    const w = await world();
    const session = await createLabSession({
      experimentId: w.lab.experimentId,
      userId: w.learner.id,
    });

    const save = () =>
      attempt(
        w.learner.id,
        `UPDATE experiment_sessions SET current_state = '{"a":1}'::jsonb WHERE id = $1`,
        [session],
      );
    expect(await save()).toBe(true);

    const seed = await seedDb();
    await seed.query(
      `UPDATE class_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1`,
      [w.learner.id],
    );

    expect(await save()).toBe(false);
  });

  it('refuses the next save the moment the course is withdrawn from the class', async () => {
    const w = await world();
    const session = await createLabSession({
      experimentId: w.lab.experimentId,
      userId: w.learner.id,
    });

    const seed = await seedDb();
    await seed.query(
      `UPDATE class_course_assignments SET status = 'archived', ended_at = now()
        WHERE class_id = $1`,
      [w.klass],
    );

    expect(
      await attempt(
        w.learner.id,
        `UPDATE experiment_sessions SET current_state = '{"a":1}'::jsonb WHERE id = $1`,
        [session],
      ),
    ).toBe(false);
  });

  it('still SHOWS the learner their own past work after they leave', async () => {
    // Retention. Losing the class must not erase what the child did.
    const w = await world();
    await createLabSession({ experimentId: w.lab.experimentId, userId: w.learner.id });

    const seed = await seedDb();
    await seed.query(
      `UPDATE class_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1`,
      [w.learner.id],
    );

    const seen = await db.withActor(w.learner.id, (tx) =>
      tx.query('SELECT id FROM experiment_sessions'),
    );
    expect(seen.rows).toHaveLength(1);
  });
});

describe('artifacts are append-only', () => {
  it('has no UPDATE or DELETE privilege for the application role', async () => {
    const seed = await seedDb();
    const { rows } = await seed.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'edu_app' AND table_name = 'experiment_artifacts'
        ORDER BY privilege_type`,
    );
    expect(rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });

  it('lets the owner append while the session is live, and refuses afterwards', async () => {
    const w = await world();
    const session = await createLabSession({
      experimentId: w.lab.experimentId,
      userId: w.learner.id,
    });
    const append = () =>
      attempt(
        w.learner.id,
        `INSERT INTO experiment_artifacts (session_id, artifact_type) VALUES ($1, 'snapshot')`,
        [session],
      );

    expect(await append()).toBe(true);

    await db.withActor(w.learner.id, (tx) =>
      tx.query(`UPDATE experiment_sessions SET status = 'submitted' WHERE id = $1`, [session]),
    );
    expect(await append()).toBe(false);
  });

  it('refuses an artifact appended to somebody else’s session', async () => {
    const w = await world();
    const session = await createLabSession({
      experimentId: w.lab.experimentId,
      userId: w.learner.id,
    });
    expect(
      await attempt(
        w.outsider.id,
        `INSERT INTO experiment_artifacts (session_id, artifact_type) VALUES ($1, 'snapshot')`,
        [session],
      ),
    ).toBe(false);
  });
});

describe('an author writes a lab through the application role', () => {
  /**
   * THE CASE THE FIRST PROBE DID NOT HAVE, and the gap that let a defect
   * through to the HTTP suite.
   *
   * Every fixture above seeds as superuser, because constructing a scenario is
   * not the thing under test. The consequence is that no assertion here
   * exercised the INSERT policy on `experiments` — and that policy resolved the
   * school by looking the row up in `experiments` by its own id, which during
   * an INSERT's WITH CHECK is not yet visible. It refused every author.
   *
   * So the write path gets its own block, run as `edu_app` like everything else
   * in this file.
   */
  async function draftActivity(w: Awaited<ReturnType<typeof world>>): Promise<string> {
    const seed = await seedDb();
    const { rows } = await seed.query<{ id: string }>(
      `INSERT INTO learning_activities (lesson_id, position, activity_type, title, status)
       VALUES ($1, 99, 'simulation', 'Draft lab', 'draft') RETURNING id`,
      [w.lesson],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('Failed to seed a draft activity');
    return id;
  }

  it('lets an author insert an experiment and its rules', async () => {
    const w = await world();
    const activityId = await draftActivity(w);

    const inserted = await attempt(
      w.author.id,
      `INSERT INTO experiments (activity_id, simulation_type) VALUES ($1, 'circuit')`,
      [activityId],
    );
    expect(inserted).toBe(true);

    const experimentId = (
      await db.withActor(w.author.id, (tx) =>
        tx.query<{ id: string }>('SELECT id FROM experiments WHERE activity_id = $1', [activityId]),
      )
    ).rows[0]?.id;
    expect(experimentId).toBeDefined();

    expect(
      await attempt(
        w.author.id,
        `INSERT INTO experiment_validation_rules (experiment_id, rules) VALUES ($1, $2)`,
        [experimentId, JSON.stringify({ rules: [{ path: 'a.b', op: 'exists' }] })],
      ),
    ).toBe(true);
  });

  it('refuses an author at ANOTHER school', async () => {
    const w = await world();
    const activityId = await draftActivity(w);
    const seed = await seedDb();
    const foreign = await createUser({
      email: 'foreign-author@b.test',
      roles: ['content_author'],
      organizationId: w.orgB,
    });
    void seed;

    expect(
      await attempt(
        foreign.id,
        `INSERT INTO experiments (activity_id, simulation_type) VALUES ($1, 'circuit')`,
        [activityId],
      ),
    ).toBe(false);
  });

  it('refuses a LEARNER inserting an experiment', async () => {
    const w = await world();
    const activityId = await draftActivity(w);
    expect(
      await attempt(
        w.learner.id,
        `INSERT INTO experiments (activity_id, simulation_type) VALUES ($1, 'circuit')`,
        [activityId],
      ),
    ).toBe(false);
  });

  it('refuses a learner inserting validation rules for an existing lab', async () => {
    const w = await world();
    const draft = await createExperiment({ lessonId: w.lesson, status: 'draft', withoutRules: true });
    expect(
      await attempt(
        w.learner.id,
        `INSERT INTO experiment_validation_rules (experiment_id, rules) VALUES ($1, '{"rules":[]}')`,
        [draft.experimentId],
      ),
    ).toBe(false);
  });
});

describe('publication freezes the lab', () => {
  it('refuses an edit to a published experiment', async () => {
    const w = await world();
    const message = await failure(
      w.author.id,
      `UPDATE experiments SET initial_config = '{"tampered":true}'::jsonb WHERE id = $1`,
      [w.lab.experimentId],
    );
    expect(message).toMatch(/published experiment cannot be changed/i);
  });

  it('refuses an edit to a published lab’s answer key', async () => {
    const w = await world();
    const message = await failure(
      w.author.id,
      `UPDATE experiment_validation_rules SET rules = '{"rules":[]}'::jsonb WHERE experiment_id = $1`,
      [w.lab.experimentId],
    );
    expect(message).toMatch(/published experiment cannot be changed/i);
  });

  it('refuses publication of a lab whose rules row does not exist', async () => {
    const w = await world();
    const orphan = await createExperiment({ lessonId: w.lesson, withoutRules: true });
    const seed = await seedDb();
    await expect(
      seed.query(
        `UPDATE learning_activities SET status = 'published', published_at = now() WHERE id = $1`,
        [orphan.activityId],
      ),
    ).rejects.toThrow(/before its experiment exists|cannot be evaluated/i);
  });

  it('refuses publication of a lab whose rules cannot be evaluated', async () => {
    const w = await world();
    const bad = await createExperiment({
      lessonId: w.lesson,
      rules: { rules: [{ path: 'a..b', op: 'eq', value: 1 }] },
    });
    const seed = await seedDb();
    await expect(
      seed.query(
        `UPDATE learning_activities SET status = 'published', published_at = now() WHERE id = $1`,
        [bad.activityId],
      ),
    ).rejects.toThrow(/cannot be evaluated/i);
  });

  it('refuses publication of a lab whose operator is not in the closed set', async () => {
    const w = await world();
    const bad = await createExperiment({
      lessonId: w.lesson,
      rules: { rules: [{ path: 'a.b', op: 'evaluate', value: 1 }] },
    });
    const seed = await seedDb();
    await expect(
      seed.query(
        `UPDATE learning_activities SET status = 'published', published_at = now() WHERE id = $1`,
        [bad.activityId],
      ),
    ).rejects.toThrow(/cannot be evaluated/i);
  });
});

describe('payload ceilings are constraints, not hopes about the API', () => {
  it('refuses a session state over 256 KiB', async () => {
    const w = await world();
    const session = await createLabSession({
      experimentId: w.lab.experimentId,
      userId: w.learner.id,
    });
    const message = await failure(
      w.learner.id,
      `UPDATE experiment_sessions
          SET current_state = jsonb_build_object('blob', repeat('x', 300000))
        WHERE id = $1`,
      [session],
    );
    expect(message).toMatch(/experiment_sessions_state_size_ck/);
  });

  it('refuses a non-object state', async () => {
    const w = await world();
    const session = await createLabSession({
      experimentId: w.lab.experimentId,
      userId: w.learner.id,
    });
    const message = await failure(
      w.learner.id,
      `UPDATE experiment_sessions SET current_state = '[1,2,3]'::jsonb WHERE id = $1`,
      [session],
    );
    expect(message).toMatch(/experiment_sessions_state_kind_ck/);
  });
});
