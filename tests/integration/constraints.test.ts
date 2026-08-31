import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { TEST_SUPERUSER_URL } from '../setup/env.ts';
import { closeSeedDb, createOrganization, createUser, truncateAll } from '../setup/fixtures.ts';

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

  it('rejects an unknown role', async () => {
    const user = await createUser({ email: 'r@test.local' });
    await expect(
      db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1,'superuser')`, [user.id]),
    ).rejects.toThrow(/user_roles_role_ck/);
  });
});

describe('relationship integrity', () => {
  it('rejects self-guardianship', async () => {
    const user = await createUser({ email: 'self@test.local' });
    await expect(
      db.query(
        `INSERT INTO guardian_links (guardian_id, student_id, status, verified_at)
         VALUES ($1,$1,'verified',now())`,
        [user.id],
      ),
    ).rejects.toThrow(/guardian_links_not_self_ck/);
  });

  it('rejects a self teacher-assignment', async () => {
    const org = await createOrganization('S');
    const user = await createUser({ email: 'self2@test.local', organizationId: org });
    await expect(
      db.query(
        `INSERT INTO teacher_assignments (teacher_id, student_id, organization_id)
         VALUES ($1,$1,$2)`,
        [user.id, org],
      ),
    ).rejects.toThrow(/teacher_assignments_not_self_ck/);
  });

  it('rejects a "verified" guardian link with no verification timestamp', async () => {
    // Authorization keys off `status`, so status and evidence must not drift.
    const g = await createUser({ email: 'g@test.local' });
    const s = await createUser({ email: 's@test.local' });
    await expect(
      db.query(
        `INSERT INTO guardian_links (guardian_id, student_id, status) VALUES ($1,$2,'verified')`,
        [g.id, s.id],
      ),
    ).rejects.toThrow(/guardian_links_verified_consistency_ck/);
  });

  it('rejects an "ended" assignment with no end timestamp', async () => {
    const org = await createOrganization('S');
    const t = await createUser({ email: 't@test.local', organizationId: org });
    const s = await createUser({ email: 's2@test.local', organizationId: org });
    await expect(
      db.query(
        `INSERT INTO teacher_assignments (teacher_id, student_id, organization_id, status)
         VALUES ($1,$2,$3,'ended')`,
        [t.id, s.id, org],
      ),
    ).rejects.toThrow(/teacher_assignments_ended_consistency_ck/);
  });

  it('rejects a duplicate guardian link', async () => {
    const g = await createUser({ email: 'g2@test.local' });
    const s = await createUser({ email: 's3@test.local' });
    const insert = () =>
      db.query(
        `INSERT INTO guardian_links (guardian_id, student_id, status, verified_at)
         VALUES ($1,$2,'verified',now())`,
        [g.id, s.id],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/guardian_links_pair_uk/);
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
  it('grants exactly the student role and nothing else', async () => {
    const { rows } = await db.query<{ auth_register_user: string }>(
      `SELECT auth_register_user('newuser@test.local','$argon2id$x','New User','ar')`,
    );
    const id = rows[0]?.auth_register_user;
    const roles = await db.query<{ role: string }>(
      'SELECT role FROM user_roles WHERE user_id = $1',
      [id],
    );
    expect(roles.rows.map((r) => r.role)).toEqual(['student']);
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

  it('returns the actor with their real roles for a live session', async () => {
    const u = await createUser({ email: 'live@test.local', roles: ['student', 'guardian'] });
    const hash = Buffer.alloc(32, 5);
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1,$2, now() + interval '1 hour')`,
      [u.id, hash],
    );
    const { rows } = await db.query<{ user_id: string; roles: string[] }>(
      'SELECT * FROM auth_resolve_session($1)',
      [hash],
    );
    expect(rows[0]?.user_id).toBe(u.id);
    expect(rows[0]?.roles.sort()).toEqual(['guardian', 'student']);
  });
});
