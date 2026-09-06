import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../apps/api/src/platform/db.ts';
import { TEST_APP_URL } from '../setup/env.ts';
import {
  addClassMember,
  assignCourseToClass,
  assignTeacher,
  closeSeedDb,
  createArtifact,
  createClass,
  createCourse,
  createCurriculum,
  createEducationLevel,
  createLesson,
  createNote,
  createNotebook,
  createOrganization,
  createUnit,
  createUser,
  grantRole,
  linkGuardian,
  seedDb,
  truncateAll,
} from '../setup/fixtures.ts';

/**
 * Row-Level Security for the student workspace.
 *
 * No application code is in the path. Every statement runs as `edu_app`
 * (NOBYPASSRLS, non-owner) with `app.actor_id` set exactly as a request would
 * set it. If the entire policy engine were deleted tomorrow, these are the
 * boundaries that would still hold.
 *
 * THIS SUITE WRITES THROUGH `edu_app`, NOT ONLY THROUGH SUPERUSER FIXTURES.
 * VULN-042 was an insert policy that refused every legitimate author, and it
 * survived a whole RLS suite because every fixture seeded as superuser. The
 * "an owner writes through the application role" block below exists so that
 * cannot happen again here.
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
 * NOT simply "did it throw". An UPDATE or DELETE whose rows are excluded by an
 * RLS USING clause does not raise — it matches nothing and reports zero rows.
 * `WITH CHECK` raises; `USING` goes quiet; both are refusals.
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

async function rows<T extends Record<string, unknown>>(
  actorId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return db.withActor(actorId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

/**
 * One school, one class, one published course the class is assigned.
 *
 *   learner   — in the class. May anchor work to the lesson.
 *   peer      — in the same class. The IDOR counterparty.
 *   outsider  — same school, no class. May not anchor anything.
 *   teacher   — teaches the class.
 *   guardian  — verified guardian of `learner`.
 *   admin     — administrator of the school.
 */
async function world() {
  const orgA = await createOrganization('School A');
  const orgB = await createOrganization('School B');
  const level = await createEducationLevel();

  const mk = (email: string, roles?: readonly string[], org: string | null = orgA) =>
    createUser({ email, ...(roles ? { roles } : {}), organizationId: org });

  const learner = await mk('learner@a.test', ['student']);
  const peer = await mk('peer@a.test', ['student']);
  const outsider = await mk('outsider@a.test', ['student']);
  const teacher = await mk('teacher@a.test', ['teacher']);
  const guardian = await mk('guardian@a.test', ['guardian']);
  const stranger = await mk('stranger@b.test', ['teacher'], orgB);
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

  // A second course, published but assigned to NOBODY. The catalog the learner
  // must not be able to anchor against.
  const unassignedCourse = await createCourse({
    organizationId: orgA,
    curriculumId: curriculum,
    levelId: level,
    title: 'Unassigned',
    status: 'published',
  });
  const unassignedUnit = await createUnit({ courseId: unassignedCourse, status: 'published' });
  const unassignedLesson = await createLesson({ unitId: unassignedUnit, status: 'published' });

  const klass = await createClass(orgA, 'A1');
  await addClassMember(klass, learner.id);
  await addClassMember(klass, peer.id);
  await assignTeacher(teacher.id, klass);
  await assignCourseToClass({ classId: klass, courseId: course });
  await linkGuardian(guardian.id, learner.id, 'verified');

  return {
    orgA,
    orgB,
    learner,
    peer,
    outsider,
    teacher,
    guardian,
    stranger,
    admin,
    course,
    unit,
    lesson,
    unassignedCourse,
    unassignedUnit,
    unassignedLesson,
    klass,
  };
}

describe('an owner writes through the application role', () => {
  /**
   * THE BLOCK THAT VULN-042 SAYS MUST EXIST.
   *
   * Every other fixture in this file seeds as superuser. If the only writes
   * were those, no INSERT policy on any table here would be exercised at all —
   * which is precisely how a policy that refused every legitimate owner
   * survived a full suite three tasks ago.
   *
   * `RETURNING` is on every insert deliberately: it forces the SELECT policy to
   * admit the new row, which is the second half of that defect and the half
   * that is invisible without it.
   */
  it('creates a notebook, an anchored note and an artifact, all with RETURNING', async () => {
    const w = await world();

    const notebook = await rows<{ id: string }>(
      w.learner.id,
      `INSERT INTO student_notebooks (owner_id, organization_id, title)
       VALUES ($1, $2, 'Physics') RETURNING id`,
      [w.learner.id, w.orgA],
    );
    expect(notebook).toHaveLength(1);

    const note = await rows<{ id: string }>(
      w.learner.id,
      `INSERT INTO notes (owner_id, organization_id, title, body, notebook_id, lesson_id)
       VALUES ($1, $2, 'Ohm', 'V = IR', $3, $4) RETURNING id`,
      [w.learner.id, w.orgA, notebook[0]?.id, w.lesson],
    );
    expect(note).toHaveLength(1);

    const artifact = await rows<{ id: string; storage_key: string }>(
      w.learner.id,
      `INSERT INTO student_artifacts
         (owner_id, note_id, artifact_type, storage_key, declared_content_type, byte_size)
       VALUES ($1, $2, 'image', 'client-supplied', 'image/png', 2048)
       RETURNING id, storage_key`,
      [w.learner.id, note[0]?.id],
    );
    expect(artifact).toHaveLength(1);
    // The key the client sent was discarded.
    expect(artifact[0]?.storage_key).not.toBe('client-supplied');
  });

  it('refuses a notebook opened in somebody else’s name', async () => {
    const w = await world();
    expect(
      await attempt(
        w.peer.id,
        `INSERT INTO student_notebooks (owner_id, title) VALUES ($1, 'Forged')`,
        [w.learner.id],
      ),
    ).toBe(false);
  });

  it('refuses an artifact registered in somebody else’s name', async () => {
    const w = await world();
    expect(
      await attempt(
        w.peer.id,
        `INSERT INTO student_artifacts
           (owner_id, artifact_type, storage_key, declared_content_type, byte_size)
         VALUES ($1, 'image', 'x', 'image/png', 10)`,
        [w.learner.id],
      ),
    ).toBe(false);
  });
});

describe('the storage key is derived, never accepted', () => {
  it('builds it from the organization, the owner and the row id', async () => {
    const w = await world();
    const id = await createArtifact({ ownerId: w.learner.id });
    const [row] = await rows<{ storage_key: string }>(
      w.learner.id,
      'SELECT storage_key FROM student_artifacts WHERE id = $1',
      [id],
    );
    expect(row?.storage_key).toBe(`org/${w.orgA}/user/${w.learner.id}/${id}`);
  });

  it('scopes two learners in different schools into different tenant prefixes', async () => {
    const w = await world();
    const a = await createArtifact({ ownerId: w.learner.id });
    const b = await createArtifact({ ownerId: w.stranger.id });

    const seed = await seedDb();
    const { rows: keys } = await seed.query<{ id: string; storage_key: string }>(
      'SELECT id, storage_key FROM student_artifacts WHERE id = ANY($1::uuid[])',
      [[a, b]],
    );
    const byId = new Map(keys.map((k) => [k.id, k.storage_key]));
    expect(byId.get(a)?.startsWith(`org/${w.orgA}/`)).toBe(true);
    expect(byId.get(b)?.startsWith(`org/${w.orgB}/`)).toBe(true);
  });

  it('cannot be rewritten afterwards, because there is no UPDATE privilege', async () => {
    const seed = await seedDb();
    const { rows: grants } = await seed.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'edu_app' AND table_name = 'student_artifacts'
        ORDER BY privilege_type`,
    );
    expect(grants.map((g) => g.privilege_type)).toEqual(['DELETE', 'INSERT', 'SELECT']);
  });
});

describe('a workspace belongs to one person', () => {
  it('shows a notebook to nobody but its owner', async () => {
    const w = await world();
    await createNotebook({ ownerId: w.learner.id, organizationId: w.orgA });

    const visible = async (actor: string) =>
      (await rows(actor, 'SELECT id FROM student_notebooks')).length;

    expect(await visible(w.learner.id)).toBe(1);
    for (const other of [w.peer, w.teacher, w.guardian, w.admin, w.stranger, w.outsider]) {
      expect(await visible(other.id), other.email).toBe(0);
    }
  });

  it('shows an artifact to nobody but its owner — the guardian included', async () => {
    // Sharper than `notes`, and deliberately so. A note has a visibility the
    // student can open; an artifact has none, so a verified guardian who could
    // read a SHARED note still cannot read the file attached to it.
    const w = await world();
    await createArtifact({ ownerId: w.learner.id });

    const visible = async (actor: string) =>
      (await rows(actor, 'SELECT id FROM student_artifacts')).length;

    expect(await visible(w.learner.id)).toBe(1);
    for (const other of [w.peer, w.teacher, w.guardian, w.admin, w.stranger]) {
      expect(await visible(other.id), other.email).toBe(0);
    }
  });

  it('refuses a peer updating or deleting a notebook', async () => {
    const w = await world();
    const notebook = await createNotebook({ ownerId: w.learner.id, organizationId: w.orgA });

    expect(
      await attempt(w.peer.id, `UPDATE student_notebooks SET title = 'Taken' WHERE id = $1`, [
        notebook,
      ]),
    ).toBe(false);
    expect(
      await attempt(w.peer.id, 'DELETE FROM student_notebooks WHERE id = $1', [notebook]),
    ).toBe(false);

    const [still] = await rows<{ title: string }>(
      w.learner.id,
      'SELECT title FROM student_notebooks WHERE id = $1',
      [notebook],
    );
    expect(still?.title).toBe('Physics');
  });

  it('refuses a peer deleting an artifact', async () => {
    const w = await world();
    const artifact = await createArtifact({ ownerId: w.learner.id });
    expect(
      await attempt(w.peer.id, 'DELETE FROM student_artifacts WHERE id = $1', [artifact]),
    ).toBe(false);
    expect(
      (await rows(w.learner.id, 'SELECT id FROM student_artifacts WHERE id = $1', [artifact]))
        .length,
    ).toBe(1);
  });

  it('refuses an owner re-parenting their own notebook to somebody else', async () => {
    const w = await world();
    const notebook = await createNotebook({ ownerId: w.learner.id, organizationId: w.orgA });
    expect(
      await attempt(w.learner.id, 'UPDATE student_notebooks SET owner_id = $2 WHERE id = $1', [
        notebook,
        w.peer.id,
      ]),
    ).toBe(false);
  });
});

describe('private notes stay private, whatever the relationship', () => {
  it('hides a private anchored note from the teacher, guardian and admin', async () => {
    const w = await world();
    const seed = await seedDb();
    const note = await createNote({
      ownerId: w.learner.id,
      organizationId: w.orgA,
      title: 'My working out',
    });
    await seed.query('UPDATE notes SET lesson_id = $2 WHERE id = $1', [note, w.lesson]);

    for (const other of [w.teacher, w.guardian, w.admin, w.peer, w.stranger]) {
      expect(
        (await rows(other.id, 'SELECT id FROM notes WHERE id = $1', [note])).length,
        other.email,
      ).toBe(0);
    }
    expect((await rows(w.learner.id, 'SELECT id FROM notes WHERE id = $1', [note])).length).toBe(1);
  });

  it('refuses a teacher writing into a learner’s note even when it is shared with them', async () => {
    const w = await world();
    const note = await createNote({
      ownerId: w.learner.id,
      organizationId: w.orgA,
      visibility: 'shared_with_teacher',
    });
    // Readable — the student opened it.
    expect((await rows(w.teacher.id, 'SELECT id FROM notes WHERE id = $1', [note])).length).toBe(1);
    // Not writable. Sharing is a read grant and nothing else.
    expect(
      await attempt(w.teacher.id, `UPDATE notes SET body = 'edited' WHERE id = $1`, [note]),
    ).toBe(false);
  });
});

describe('anchoring: what a learner may attach work to', () => {
  it('permits a lesson the learner studies', async () => {
    const w = await world();
    expect(
      await attempt(
        w.learner.id,
        `INSERT INTO notes (owner_id, organization_id, title, lesson_id) VALUES ($1, $2, 'ok', $3)`,
        [w.learner.id, w.orgA, w.lesson],
      ),
    ).toBe(true);
  });

  it('refuses a lesson in a course assigned to nobody', async () => {
    const w = await world();
    const message = await failure(
      w.learner.id,
      `INSERT INTO notes (owner_id, organization_id, title, lesson_id) VALUES ($1, $2, 'no', $3)`,
      [w.learner.id, w.orgA, w.unassignedLesson],
    );
    expect(message).toMatch(/not studying/i);
  });

  it('refuses a course and a unit the learner does not study', async () => {
    const w = await world();
    for (const [column, value] of [
      ['course_id', w.unassignedCourse],
      ['unit_id', w.unassignedUnit],
    ] as const) {
      const message = await failure(
        w.learner.id,
        `INSERT INTO notes (owner_id, organization_id, title, ${column}) VALUES ($1, $2, 'no', $3)`,
        [w.learner.id, w.orgA, value],
      );
      expect(message, column).toMatch(/not studying/i);
    }
  });

  it('permits a free-standing note with no anchor at all', async () => {
    // A learner does not need a course's permission to think.
    const w = await world();
    expect(
      await attempt(
        w.outsider.id,
        `INSERT INTO notes (owner_id, organization_id, title) VALUES ($1, $2, 'diary')`,
        [w.outsider.id, w.orgA],
      ),
    ).toBe(true);
  });

  it('refuses two anchors on one note', async () => {
    const w = await world();
    const message = await failure(
      w.learner.id,
      `INSERT INTO notes (owner_id, organization_id, title, course_id, lesson_id)
       VALUES ($1, $2, 'both', $3, $4)`,
      [w.learner.id, w.orgA, w.course, w.lesson],
    );
    expect(message).toMatch(/notes_single_anchor_ck/);
  });

  it('refuses filing a note in somebody else’s notebook', async () => {
    const w = await world();
    const theirs = await createNotebook({ ownerId: w.peer.id, organizationId: w.orgA });
    const message = await failure(
      w.learner.id,
      `INSERT INTO notes (owner_id, organization_id, title, notebook_id)
       VALUES ($1, $2, 'sneaky', $3)`,
      [w.learner.id, w.orgA, theirs],
    );
    // The COMPOSITE foreign key is what refuses, and the assertion names it
    // rather than a message. This is the whole reason the rule is a constraint:
    // it holds for every writer, including the migration role, and needs no
    // policy to be consulted.
    expect(message).toMatch(/notes_notebook_same_owner_fk/);
  });

  it('refuses MOVING an existing note into somebody else’s notebook', async () => {
    // The case a single combined guard would have missed: the anchor does not
    // move, so an anchor-only check would never run.
    const w = await world();
    const note = await createNote({ ownerId: w.learner.id, organizationId: w.orgA });
    const theirs = await createNotebook({ ownerId: w.peer.id, organizationId: w.orgA });
    const message = await failure(w.learner.id, 'UPDATE notes SET notebook_id = $2 WHERE id = $1', [
      note,
      theirs,
    ]);
    // A foreign key is checked on every write, so the "did the anchor move"
    // question that a trigger has to ask never arises here.
    expect(message).toMatch(/notes_notebook_same_owner_fk/);
  });
});

describe('retention: the term ends, the notes stay', () => {
  it('keeps an anchored note readable AND editable after enrolment ends', async () => {
    const w = await world();
    const seed = await seedDb();
    const note = await createNote({ ownerId: w.learner.id, organizationId: w.orgA });
    await seed.query('UPDATE notes SET lesson_id = $2 WHERE id = $1', [note, w.lesson]);

    await seed.query(
      `UPDATE class_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1`,
      [w.learner.id],
    );

    expect((await rows(w.learner.id, 'SELECT id FROM notes WHERE id = $1', [note])).length).toBe(1);
    // Revision notes are the child's, not the school's. Editing them must
    // survive the timetable.
    expect(
      await attempt(w.learner.id, `UPDATE notes SET body = 'revised' WHERE id = $1`, [note]),
    ).toBe(true);
  });

  it('refuses RE-ANCHORING that note to coursework they can no longer study', async () => {
    const w = await world();
    const seed = await seedDb();
    const note = await createNote({ ownerId: w.learner.id, organizationId: w.orgA });
    await seed.query(
      `UPDATE class_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1`,
      [w.learner.id],
    );
    const message = await failure(w.learner.id, 'UPDATE notes SET lesson_id = $2 WHERE id = $1', [
      note,
      w.lesson,
    ]);
    expect(message).toMatch(/not studying/i);
  });

  it('keeps notes when their notebook is deleted', async () => {
    const w = await world();
    const seed = await seedDb();
    const notebook = await createNotebook({ ownerId: w.learner.id, organizationId: w.orgA });
    const note = await createNote({ ownerId: w.learner.id, organizationId: w.orgA });
    await seed.query('UPDATE notes SET notebook_id = $2 WHERE id = $1', [note, notebook]);

    expect(
      await attempt(w.learner.id, 'DELETE FROM student_notebooks WHERE id = $1', [notebook]),
    ).toBe(true);

    const [survivor] = await rows<{ notebook_id: string | null }>(
      w.learner.id,
      'SELECT notebook_id FROM notes WHERE id = $1',
      [note],
    );
    expect(survivor).toBeDefined();
    expect(survivor?.notebook_id).toBeNull();
  });

  it('keeps notes when their anchor lesson is withdrawn from the catalog', async () => {
    const w = await world();
    const seed = await seedDb();
    const note = await createNote({ ownerId: w.learner.id, organizationId: w.orgA });
    await seed.query('UPDATE notes SET lesson_id = $2 WHERE id = $1', [note, w.lesson]);
    await seed.query('DELETE FROM lessons WHERE id = $1', [w.lesson]);

    const [survivor] = await rows<{ lesson_id: string | null }>(
      w.learner.id,
      'SELECT lesson_id FROM notes WHERE id = $1',
      [note],
    );
    expect(survivor).toBeDefined();
    expect(survivor?.lesson_id).toBeNull();
  });
});

describe('an artifact hangs only off its owner’s work', () => {
  it('refuses attaching to another learner’s note', async () => {
    const w = await world();
    const theirs = await createNote({ ownerId: w.peer.id, organizationId: w.orgA });
    const message = await failure(
      w.learner.id,
      `INSERT INTO student_artifacts
         (owner_id, note_id, artifact_type, storage_key, declared_content_type, byte_size)
       VALUES ($1, $2, 'image', 'x', 'image/png', 10)`,
      [w.learner.id, theirs],
    );
    expect(message).toMatch(/student_artifacts_note_same_owner_fk/);
  });

  it('refuses attaching to another learner’s lab session', async () => {
    const w = await world();
    const seed = await seedDb();
    const { rows: made } = await seed.query<{ id: string }>(
      `INSERT INTO learning_activities (lesson_id, position, activity_type, title, status)
       VALUES ($1, 50, 'simulation', 'Lab', 'draft') RETURNING id`,
      [w.lesson],
    );
    const activityId = made[0]?.id;
    const { rows: exp } = await seed.query<{ id: string }>(
      `INSERT INTO experiments (activity_id, simulation_type) VALUES ($1, 'circuit') RETURNING id`,
      [activityId],
    );
    const experimentId = exp[0]?.id;
    const { rows: sess } = await seed.query<{ id: string }>(
      `INSERT INTO experiment_sessions (experiment_id, user_id) VALUES ($1, $2) RETURNING id`,
      [experimentId, w.peer.id],
    );
    const sessionId = sess[0]?.id;

    const message = await failure(
      w.learner.id,
      `INSERT INTO student_artifacts
         (owner_id, session_id, artifact_type, storage_key, declared_content_type, byte_size)
       VALUES ($1, $2, 'data_export', 'x', 'application/json', 10)`,
      [w.learner.id, sessionId],
    );
    expect(message).toMatch(/student_artifacts_session_same_owner_fk/);
  });
});

describe('the storage quota is the database’s rule', () => {
  it('refuses a registration that would cross the ceiling', async () => {
    const w = await world();
    const seed = await seedDb();
    const quota = Number(
      (await seed.query<{ q: string }>('SELECT app_artifact_quota_bytes() AS q')).rows[0]?.q,
    );

    // Fill to just under, in ten chunks — each within the per-artifact cap.
    const perArtifact = 26_214_400;
    let filled = 0;
    while (filled + perArtifact <= quota) {
      await createArtifact({ ownerId: w.learner.id, byteSize: perArtifact });
      filled += perArtifact;
    }

    const message = await failure(
      w.learner.id,
      `INSERT INTO student_artifacts
         (owner_id, artifact_type, storage_key, declared_content_type, byte_size)
       VALUES ($1, 'image', 'x', 'image/png', $2)`,
      [w.learner.id, quota - filled + 1],
    );
    expect(message).toMatch(/quota exceeded/i);
  });

  it('counts only the owner’s own artifacts', async () => {
    const w = await world();
    await createArtifact({ ownerId: w.peer.id, byteSize: 1000 });
    const seed = await seedDb();
    const { rows: used } = await seed.query<{ u: string }>(
      'SELECT app_artifact_bytes_used($1) AS u',
      [w.learner.id],
    );
    expect(Number(used[0]?.u)).toBe(0);
  });

  it('refuses two concurrent registrations that only fit one at a time', async () => {
    /**
     * THE RACE THE APPLICATION LAYER CANNOT WIN.
     *
     * A service that reads `sum(byte_size)` and then inserts has a window in
     * which both requests see the pre-insert total and both proceed. Doing the
     * check in a BEFORE INSERT trigger closes it — but only if the two really
     * do overlap, so both statements are opened before either commits.
     */
    const w = await world();
    const seed = await seedDb();
    const quota = Number(
      (await seed.query<{ q: string }>('SELECT app_artifact_quota_bytes() AS q')).rows[0]?.q,
    );
    const perArtifact = 26_214_400;
    let filled = 0;
    while (filled + perArtifact <= quota - perArtifact) {
      await createArtifact({ ownerId: w.learner.id, byteSize: perArtifact });
      filled += perArtifact;
    }
    const remaining = quota - filled;
    const each = Math.floor(remaining * 0.7); // two of these do not fit.

    const insert = () =>
      db.withActor(w.learner.id, (tx) =>
        tx.query(
          `INSERT INTO student_artifacts
             (owner_id, artifact_type, storage_key, declared_content_type, byte_size)
           VALUES ($1, 'image', 'x', 'image/png', $2)`,
          [w.learner.id, each],
        ),
      );

    const results = await Promise.allSettled([insert(), insert()]);
    const accepted = results.filter((r) => r.status === 'fulfilled').length;
    expect(accepted).toBe(1);
  });
});
