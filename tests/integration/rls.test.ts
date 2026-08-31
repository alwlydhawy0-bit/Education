import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../apps/api/src/platform/db.ts';
import { TEST_APP_URL } from '../setup/env.ts';
import {
  assignTeacher,
  closeSeedDb,
  createNote,
  createOrganization,
  createUser,
  linkGuardian,
  truncateAll,
} from '../setup/fixtures.ts';

/**
 * Row-Level Security, exercised through the real application role.
 *
 * These tests are the evidence behind the claim that RLS is a genuine second
 * gate. Every query below runs as `edu_app` (NOBYPASSRLS, non-owner) with
 * `app.actor_id` set exactly as the request path sets it, and every assertion is
 * about what the DATABASE returns — not about what the application chose to do
 * with it.
 *
 * The scenario throughout: `student` owns a note. `stranger` knows its id.
 */
const db: Database = createDatabase({ connectionString: TEST_APP_URL, poolMax: 4 });

afterAll(async () => {
  await db.close();
  await closeSeedDb();
});

beforeEach(truncateAll);

async function setupScenario(
  visibility: 'private' | 'shared_with_teacher' | 'shared_with_guardian' = 'private',
) {
  const org = await createOrganization('Test School');
  const student = await createUser({ email: 'student@test.local', organizationId: org });
  const stranger = await createUser({ email: 'stranger@test.local', organizationId: org });
  const teacher = await createUser({
    email: 'teacher@test.local',
    roles: ['teacher'],
    organizationId: org,
  });
  const guardian = await createUser({ email: 'guardian@test.local', roles: ['guardian'] });
  const noteId = await createNote({
    ownerId: student.id,
    organizationId: org,
    body: 'private study notes',
    visibility,
  });
  return { org, student, stranger, teacher, guardian, noteId };
}

describe('RLS — notes SELECT', () => {
  it('lets the owner read their own note', async () => {
    const { student, noteId } = await setupScenario();
    const rows = await db.withActor(
      student.id,
      async (tx) => (await tx.query('SELECT body FROM notes WHERE id = $1', [noteId])).rows,
    );
    expect(rows).toHaveLength(1);
  });

  it('returns ZERO rows to a stranger who knows the exact note id (IDOR)', async () => {
    const { stranger, noteId } = await setupScenario();
    const rows = await db.withActor(
      stranger.id,
      async (tx) => (await tx.query('SELECT body FROM notes WHERE id = $1', [noteId])).rows,
    );
    expect(rows).toEqual([]);
  });

  it('hides the note from an unfiltered SELECT * (the forgotten-WHERE case)', async () => {
    // This is the bug RLS exists to survive: a query with no ownership filter.
    const { stranger } = await setupScenario();
    const rows = await db.withActor(
      stranger.id,
      async (tx) => (await tx.query('SELECT * FROM notes')).rows,
    );
    expect(rows).toEqual([]);
  });

  it('returns zero rows when no actor is set at all (pool-leak / unauthenticated)', async () => {
    await setupScenario();
    const rows = await db.withoutActor(async (tx) => (await tx.query('SELECT * FROM notes')).rows);
    expect(rows).toEqual([]);
  });

  it('hides a soft-deleted note from an assigned teacher it was shared with', async () => {
    // Deleted notes are filtered at the DATABASE layer for every non-owner.
    const org = await createOrganization('S');
    const student = await createUser({ email: 's@test.local', organizationId: org });
    const teacher = await createUser({
      email: 't-del@test.local',
      roles: ['teacher'],
      organizationId: org,
    });
    await assignTeacher(teacher.id, student.id, org);
    const noteId = await createNote({
      ownerId: student.id,
      organizationId: org,
      visibility: 'shared_with_teacher',
      state: 'deleted',
    });
    const rows = await db.withActor(
      teacher.id,
      async (tx) => (await tx.query('SELECT * FROM notes WHERE id = $1', [noteId])).rows,
    );
    expect(rows).toEqual([]);
  });

  it('leaves a soft-deleted note visible to its OWNER at the database layer', async () => {
    // This is a deliberate consequence of PostgreSQL applying the SELECT policy
    // to the new row of an UPDATE: were the owner branch to filter on state,
    // the owner could not soft-delete their own note at all. See
    // docs/architecture/adr/0007-soft-delete-and-rls.md.
    //
    // Hiding it from the owner is therefore an APPLICATION-layer guarantee,
    // enforced by notePolicy (tests/unit/note-policy.test.ts) and proven
    // end-to-end in tests/security/idor.test.ts, where the owner gets 404 for
    // their own deleted note.
    const org = await createOrganization('S');
    const student = await createUser({ email: 's-own@test.local', organizationId: org });
    const noteId = await createNote({ ownerId: student.id, organizationId: org, state: 'deleted' });
    const rows = await db.withActor(
      student.id,
      async (tx) => (await tx.query('SELECT * FROM notes WHERE id = $1', [noteId])).rows,
    );
    expect(rows).toHaveLength(1);
  });

  it('still hides a soft-deleted note from an unrelated stranger', async () => {
    const org = await createOrganization('S');
    const student = await createUser({ email: 's-del2@test.local', organizationId: org });
    const stranger = await createUser({ email: 'x-del@test.local', organizationId: org });
    const noteId = await createNote({ ownerId: student.id, organizationId: org, state: 'deleted' });
    const rows = await db.withActor(
      stranger.id,
      async (tx) => (await tx.query('SELECT * FROM notes WHERE id = $1', [noteId])).rows,
    );
    expect(rows).toEqual([]);
  });
});

describe('RLS — notes WRITE', () => {
  it('silently affects no rows when a stranger UPDATEs by id', async () => {
    const { student, stranger, noteId } = await setupScenario();
    const affected = await db.withActor(stranger.id, async (tx) => {
      const r = await tx.query('UPDATE notes SET body = $2 WHERE id = $1', [noteId, 'pwned']);
      return r.rowCount;
    });
    expect(affected).toBe(0);

    const body = await db.withActor(
      student.id,
      async (tx) =>
        (await tx.query<{ body: string }>('SELECT body FROM notes WHERE id = $1', [noteId])).rows[0]
          ?.body,
    );
    expect(body).toBe('private study notes');
  });

  it('silently affects no rows when a stranger DELETEs by id', async () => {
    const { student, stranger, noteId } = await setupScenario();
    const affected = await db.withActor(stranger.id, async (tx) => {
      const r = await tx.query('DELETE FROM notes WHERE id = $1', [noteId]);
      return r.rowCount;
    });
    expect(affected).toBe(0);

    const remaining = await db.withActor(
      student.id,
      async (tx) => (await tx.query('SELECT 1 FROM notes WHERE id = $1', [noteId])).rows,
    );
    expect(remaining).toHaveLength(1);
  });

  it('REJECTS an insert that forges another user as the owner', async () => {
    const { student, stranger } = await setupScenario();
    await expect(
      db.withActor(stranger.id, (tx) =>
        tx.query('INSERT INTO notes (owner_id, title) VALUES ($1, $2)', [student.id, 'forged']),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('REJECTS an owner re-parenting their note to someone else', async () => {
    const { student, stranger, noteId } = await setupScenario();
    await expect(
      db.withActor(student.id, (tx) =>
        tx.query('UPDATE notes SET owner_id = $2 WHERE id = $1', [noteId, stranger.id]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('RLS — relationship-scoped reads', () => {
  it('lets an assigned teacher read a note shared with teachers', async () => {
    const { org, student, teacher, noteId } = await setupScenario('shared_with_teacher');
    await assignTeacher(teacher.id, student.id, org);
    const rows = await db.withActor(
      teacher.id,
      async (tx) => (await tx.query('SELECT id FROM notes WHERE id = $1', [noteId])).rows,
    );
    expect(rows).toHaveLength(1);
  });

  it('denies a teacher whose assignment has ENDED', async () => {
    const { org, student, teacher, noteId } = await setupScenario('shared_with_teacher');
    await assignTeacher(teacher.id, student.id, org, 'ended');
    const rows = await db.withActor(
      teacher.id,
      async (tx) => (await tx.query('SELECT id FROM notes WHERE id = $1', [noteId])).rows,
    );
    expect(rows).toEqual([]);
  });

  it('denies an assigned teacher when the note is still private', async () => {
    const { org, student, teacher, noteId } = await setupScenario('private');
    await assignTeacher(teacher.id, student.id, org);
    const rows = await db.withActor(
      teacher.id,
      async (tx) => (await tx.query('SELECT id FROM notes WHERE id = $1', [noteId])).rows,
    );
    expect(rows).toEqual([]);
  });

  it('lets a VERIFIED guardian read a note shared with guardians', async () => {
    const { student, guardian, noteId } = await setupScenario('shared_with_guardian');
    await linkGuardian(guardian.id, student.id, 'verified');
    const rows = await db.withActor(
      guardian.id,
      async (tx) => (await tx.query('SELECT id FROM notes WHERE id = $1', [noteId])).rows,
    );
    expect(rows).toHaveLength(1);
  });

  it('denies a guardian whose link is only PENDING', async () => {
    const { student, guardian, noteId } = await setupScenario('shared_with_guardian');
    await linkGuardian(guardian.id, student.id, 'pending');
    const rows = await db.withActor(
      guardian.id,
      async (tx) => (await tx.query('SELECT id FROM notes WHERE id = $1', [noteId])).rows,
    );
    expect(rows).toEqual([]);
  });

  it('denies a teacher even with a share, when the assignment is in another org', async () => {
    const orgA = await createOrganization('School A');
    const orgB = await createOrganization('School B');
    const student = await createUser({ email: 'sa@test.local', organizationId: orgA });
    const teacher = await createUser({
      email: 'tb@test.local',
      roles: ['teacher'],
      organizationId: orgB,
    });
    await assignTeacher(teacher.id, student.id, orgB);
    const noteId = await createNote({
      ownerId: student.id,
      organizationId: orgA,
      visibility: 'shared_with_teacher',
    });
    const rows = await db.withActor(
      teacher.id,
      async (tx) => (await tx.query('SELECT id FROM notes WHERE id = $1', [noteId])).rows,
    );
    expect(rows).toEqual([]);
  });
});

describe('RLS — other tables', () => {
  it('prevents reading another user row', async () => {
    const { student, stranger } = await setupScenario();
    const rows = await db.withActor(
      stranger.id,
      async (tx) => (await tx.query('SELECT email FROM users WHERE id = $1', [student.id])).rows,
    );
    expect(rows).toEqual([]);
  });

  it('prevents reading another user session', async () => {
    const { student, stranger } = await setupScenario();
    await db.withoutActor((tx) =>
      tx.query(`SELECT auth_create_session($1, $2, now() + interval '1 hour', NULL, NULL)`, [
        student.id,
        Buffer.alloc(32, 7),
      ]),
    );
    const rows = await db.withActor(
      stranger.id,
      async (tx) => (await tx.query('SELECT * FROM sessions')).rows,
    );
    expect(rows).toEqual([]);
  });

  it('prevents the application role from granting any role', async () => {
    const { stranger } = await setupScenario();
    await expect(
      db.withActor(stranger.id, (tx) =>
        tx.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [stranger.id, 'admin']),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('prevents the application role from reading the audit log', async () => {
    const { stranger } = await setupScenario();
    await expect(
      db.withActor(stranger.id, (tx) => tx.query('SELECT * FROM audit_log')),
    ).rejects.toThrow(/permission denied/i);
  });

  it('allows the application role to APPEND to the audit log', async () => {
    const { stranger } = await setupScenario();
    await expect(
      db.withActor(stranger.id, (tx) =>
        tx.query(
          `INSERT INTO audit_log (event_type, actor_id, correlation_id, detail)
           VALUES ('authz.denied', $1, 'corr', '{}'::jsonb)`,
          [stranger.id],
        ),
      ),
    ).resolves.toBeDefined();
  });
});

describe('RLS — actor scoping is transaction-local', () => {
  it('does not leak an actor across pooled transactions', async () => {
    // If `set_config` were session-level instead of transaction-local, the
    // second call could inherit the first actor from a reused connection. With
    // poolMax=1 the same physical connection is guaranteed to be reused.
    const single = createDatabase({ connectionString: TEST_APP_URL, poolMax: 1 });
    try {
      const { student, noteId } = await setupScenario();
      await single.withActor(student.id, async (tx) => {
        expect((await tx.query('SELECT * FROM notes WHERE id = $1', [noteId])).rows).toHaveLength(
          1,
        );
      });
      const leaked = await single.withoutActor(
        async (tx) => (await tx.query('SELECT * FROM notes')).rows,
      );
      expect(leaked).toEqual([]);
    } finally {
      await single.close();
    }
  });

  it('refuses a non-UUID actor id rather than interpolating it', async () => {
    await expect(db.withActor("' OR 1=1 --", async () => undefined)).rejects.toThrow(
      /non-UUID actor id/,
    );
  });
});
