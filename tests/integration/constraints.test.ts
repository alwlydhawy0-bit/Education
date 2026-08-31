import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { TEST_SUPERUSER_URL } from '../setup/env.ts';
import {
  closeSeedDb,
  createClass,
  createOrganization,
  createUser,
  truncateAll,
} from '../setup/fixtures.ts';

/**
 * Database-level data integrity.
 *
 * These constraints exist so that a bug in ANY application code path — present
 * or future, in a module nobody has written yet — cannot persist a state that
 * breaks an authorization assumption. They are asserted here on a superuser
 * connection deliberately: the point is that not even an unconstrained writer
 * can insert these rows.
 */
const db = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
await db.connect();

afterAll(async () => {
  await db.end();
  await closeSeedDb();
});

beforeEach(truncateAll);

describe('users', () => {
  it('rejects a non-normalized (mixed-case) email', async () => {
    await expect(
      db.query(`INSERT INTO users (email, password_hash, display_name) VALUES ($1,'h','n')`, [
        'MiXeD@Example.com',
      ]),
    ).rejects.toThrow(/users_email_normalized_ck/);
  });

  it('rejects a duplicate email', async () => {
    await createUser({ email: 'dup@test.local' });
    await expect(
      db.query(
        `INSERT INTO users (email, password_hash, display_name) VALUES ('dup@test.local','h','n')`,
      ),
    ).rejects.toThrow(/users_email_uk/);
  });

  it('rejects an unknown status value', async () => {
    await expect(
      db.query(
        `INSERT INTO users (email, password_hash, display_name, status) VALUES ('x@test.local','h','n','godmode')`,
      ),
    ).rejects.toThrow(/users_status_ck/);
  });

  it('rejects a role grant naming a role that does not exist', async () => {
    // Roles are now rows, so an unknown role is a foreign-key failure rather
    // than a CHECK failure — and `auth_assign_role` refuses it by name before
    // the insert is attempted at all.
    const user = await createUser({ email: 'r@test.local' });
    await expect(
      db.query(`SELECT auth_assign_role($1, 'superuser', 'global', NULL, NULL)`, [user.id]),
    ).rejects.toThrow(/Unknown role/);
  });

  it('rejects a scoped grant with no scope id, and a global grant with one', async () => {
    // Access is evaluated against the scope, so the two must never drift: a
    // scoped grant missing its target would silently widen into a global one.
    const user = await createUser({ email: 'r2@test.local' });
    await expect(
      db.query(
        `INSERT INTO user_roles (user_id, role_id, scope_type, scope_id)
         SELECT $1, id, 'class', NULL FROM roles WHERE name='teacher'`,
        [user.id],
      ),
    ).rejects.toThrow(/user_roles_scope_pairing_ck/);

    await expect(
      db.query(
        `INSERT INTO user_roles (user_id, role_id, scope_type, scope_id)
         SELECT $1, id, 'global', gen_random_uuid() FROM roles WHERE name='teacher'`,
        [user.id],
      ),
    ).rejects.toThrow(/user_roles_scope_pairing_ck/);
  });

  it('rejects a permission whose name disagrees with its resource and action', async () => {
    await expect(
      db.query(
        `INSERT INTO permissions (name, resource, action) VALUES ('notes:read','users','list')`,
      ),
    ).rejects.toThrow(/permissions_name_derived_ck/);
  });
});

describe('relationship integrity', () => {
  it('rejects self-guardianship', async () => {
    // The trivial escalation: claim guardianship of yourself to unlock
    // guardian-scoped access to your own record.
    const user = await createUser({ email: 'self@test.local' });
    await expect(
      db.query(
        `INSERT INTO guardian_relationships (guardian_id, child_id, status, verified_at)
         VALUES ($1,$1,'verified',now())`,
        [user.id],
      ),
    ).rejects.toThrow(/guardian_relationships_not_self_ck/);
  });

  it('rejects a "verified" guardianship with no verification timestamp', async () => {
    // Authorization keys off `status`, so status and evidence must not drift.
    const g = await createUser({ email: 'g@test.local' });
    const s = await createUser({ email: 's@test.local' });
    await expect(
      db.query(
        `INSERT INTO guardian_relationships (guardian_id, child_id, status)
         VALUES ($1,$2,'verified')`,
        [g.id, s.id],
      ),
    ).rejects.toThrow(/guardian_relationships_verified_consistency_ck/);
  });

  it('rejects an unknown relationship type', async () => {
    const g = await createUser({ email: 'g-type@test.local' });
    const s = await createUser({ email: 's-type@test.local' });
    await expect(
      db.query(
        `INSERT INTO guardian_relationships (guardian_id, child_id, relationship_type)
         VALUES ($1,$2,'owner')`,
        [g.id, s.id],
      ),
    ).rejects.toThrow(/guardian_relationships_type_ck/);
  });

  it('rejects a duplicate guardianship', async () => {
    const g = await createUser({ email: 'g2@test.local' });
    const s = await createUser({ email: 's3@test.local' });
    const insert = () =>
      db.query(
        `INSERT INTO guardian_relationships (guardian_id, child_id, status, verified_at)
         VALUES ($1,$2,'verified',now())`,
        [g.id, s.id],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/guardian_relationships_pair_uk/);
  });

  it('rejects an "ended" teacher assignment with no end timestamp', async () => {
    const org = await createOrganization('S');
    const t = await createUser({ email: 't@test.local', organizationId: org });
    const classId = await createClass(org);
    await expect(
      db.query(
        `INSERT INTO teacher_assignments (teacher_id, class_id, status) VALUES ($1,$2,'ended')`,
        [t.id, classId],
      ),
    ).rejects.toThrow(/teacher_assignments_ended_consistency_ck/);
  });

  it('rejects a duplicate teacher assignment to the same class', async () => {
    const org = await createOrganization('S');
    const t = await createUser({ email: 't-dup@test.local', organizationId: org });
    const classId = await createClass(org);
    const insert = () =>
      db.query(`INSERT INTO teacher_assignments (teacher_id, class_id) VALUES ($1,$2)`, [
        t.id,
        classId,
      ]);
    await insert();
    await expect(insert()).rejects.toThrow(/teacher_assignments_pair_uk/);
  });

  it('rejects an "ended" class membership with no end timestamp', async () => {
    const org = await createOrganization('S');
    const s = await createUser({ email: 's-mem@test.local', organizationId: org });
    const classId = await createClass(org);
    await expect(
      db.query(`INSERT INTO class_memberships (class_id, user_id, status) VALUES ($1,$2,'ended')`, [
        classId,
        s.id,
      ]),
    ).rejects.toThrow(/class_memberships_ended_consistency_ck/);
  });

  it('rejects an "archived" class with no archived timestamp', async () => {
    const org = await createOrganization('S');
    await expect(
      db.query(`INSERT INTO classes (organization_id, name, status) VALUES ($1,'C','archived')`, [
        org,
      ]),
    ).rejects.toThrow(/classes_archived_consistency_ck/);
  });

  it('rejects a duplicate class membership', async () => {
    const org = await createOrganization('S');
    const s = await createUser({ email: 's-dup@test.local', organizationId: org });
    const classId = await createClass(org);
    const insert = () =>
      db.query(`INSERT INTO class_memberships (class_id, user_id) VALUES ($1,$2)`, [classId, s.id]);
    await insert();
    await expect(insert()).rejects.toThrow(/class_memberships_pair_uk/);
  });
});

describe('notes', () => {
  it('rejects an unknown visibility value', async () => {
    const u = await createUser({ email: 'n@test.local' });
    await expect(
      db.query(`INSERT INTO notes (owner_id, title, visibility) VALUES ($1,'t','public')`, [u.id]),
    ).rejects.toThrow(/notes_visibility_ck/);
  });

  it('rejects a body over the 64 KiB cap', async () => {
    const u = await createUser({ email: 'n2@test.local' });
    await expect(
      db.query(`INSERT INTO notes (owner_id, title, body) VALUES ($1,'t',$2)`, [
        u.id,
        'x'.repeat(65_537),
      ]),
    ).rejects.toThrow(/notes_body_len_ck/);
  });

  it('rejects a blank title', async () => {
    const u = await createUser({ email: 'n3@test.local' });
    await expect(
      db.query(`INSERT INTO notes (owner_id, title) VALUES ($1,'   ')`, [u.id]),
    ).rejects.toThrow(/notes_title_len_ck/);
  });

  it('cascades note deletion when the owner is deleted', async () => {
    const u = await createUser({ email: 'n4@test.local' });
    await db.query(`INSERT INTO notes (owner_id, title) VALUES ($1,'t')`, [u.id]);
    await db.query('DELETE FROM users WHERE id = $1', [u.id]);
    const { rows } = await db.query('SELECT * FROM notes WHERE owner_id = $1', [u.id]);
    expect(rows).toEqual([]);
  });
});

describe('sessions', () => {
  it('rejects a token hash that is not 32 bytes', async () => {
    const u = await createUser({ email: 'sess@test.local' });
    await expect(
      db.query(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1,$2, now() + interval '1 hour')`,
        [u.id, Buffer.alloc(16)],
      ),
    ).rejects.toThrow(/sessions_token_len_ck/);
  });

  it('rejects a session that expires before it was created', async () => {
    const u = await createUser({ email: 'sess2@test.local' });
    await expect(
      db.query(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1,$2, now() - interval '1 hour')`,
        [u.id, Buffer.alloc(32, 1)],
      ),
    ).rejects.toThrow(/sessions_expiry_ck/);
  });

  it('rejects a duplicate token hash', async () => {
    const u = await createUser({ email: 'sess3@test.local' });
    const insert = () =>
      db.query(
        `INSERT INTO sessions (user_id, token_hash, expires_at)
         VALUES ($1,$2, now() + interval '1 hour')`,
        [u.id, Buffer.alloc(32, 9)],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/sessions_token_hash_uk/);
  });
});

describe('auth_register_user — the only role-granting path', () => {
  it('grants exactly the student role, globally scoped, and nothing else', async () => {
    const { rows } = await db.query<{ auth_register_user: string }>(
      `SELECT auth_register_user('newuser@test.local','$argon2id$x','New User','ar')`,
    );
    const id = rows[0]?.auth_register_user;
    const grants = await db.query<{ role_name: string; scope_type: string }>(
      'SELECT * FROM auth_user_grants($1)',
      [id],
    );
    expect(grants.rows).toEqual([
      expect.objectContaining({ role_name: 'student', scope_type: 'global' }),
    ]);
  });

  it('also creates the profile, so the two tables cannot diverge', async () => {
    const { rows } = await db.query<{ auth_register_user: string }>(
      `SELECT auth_register_user('withprofile@test.local','$argon2id$x','With Profile','ar')`,
    );
    const { rows: profiles } = await db.query(
      'SELECT display_name FROM profiles WHERE user_id = $1',
      [rows[0]?.auth_register_user],
    );
    expect(profiles).toHaveLength(1);
  });

  it('normalizes the email it stores', async () => {
    await db.query(`SELECT auth_register_user('  MiXeD@Test.Local ','$argon2id$x','U','ar')`);
    const { rows } = await db.query('SELECT email FROM users WHERE email = $1', [
      'mixed@test.local',
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe('auth_resolve_session — expiry and revocation are enforced in SQL', () => {
  it('returns no row for an expired session', async () => {
    const u = await createUser({ email: 'exp@test.local' });
    const hash = Buffer.alloc(32, 3);
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, created_at, expires_at)
       VALUES ($1,$2, now() - interval '2 hours', now() - interval '1 hour')`,
      [u.id, hash],
    );
    const { rows } = await db.query('SELECT * FROM auth_resolve_session($1)', [hash]);
    expect(rows).toEqual([]);
  });

  it('returns no row for a revoked session', async () => {
    const u = await createUser({ email: 'rev@test.local' });
    const hash = Buffer.alloc(32, 4);
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at, revoked_at)
       VALUES ($1,$2, now() + interval '1 hour', now())`,
      [u.id, hash],
    );
    const { rows } = await db.query('SELECT * FROM auth_resolve_session($1)', [hash]);
    expect(rows).toEqual([]);
  });

  it('returns the actor with their real grants and permissions', async () => {
    const u = await createUser({ email: 'live@test.local', roles: ['student', 'guardian'] });
    const hash = Buffer.alloc(32, 5);
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1,$2, now() + interval '1 hour')`,
      [u.id, hash],
    );
    const { rows } = await db.query<{
      user_id: string;
      grants: { role: string; scopeType: string }[];
      permissions: string[];
      email_verified: boolean;
    }>('SELECT * FROM auth_resolve_session($1)', [hash]);

    expect(rows[0]?.user_id).toBe(u.id);
    expect(rows[0]?.grants.map((g) => g.role).sort()).toEqual(['guardian', 'student']);
    // Permissions are the flattened union of every role's grants — derived by
    // the database, never supplied by the client.
    expect(rows[0]?.permissions).toContain('notes:read');
    expect(rows[0]?.permissions).toContain('students:read');
    expect(rows[0]?.email_verified).toBe(false);
  });
});
