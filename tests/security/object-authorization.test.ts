import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, sessionCookieFrom, writeHeaders, type TestApp } from '../setup/app.ts';
import {
  assignTeacher,
  closeSeedDb,
  createOrganization,
  createUser,
  linkGuardian,
  truncateAll,
} from '../setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';

/**
 * Object-level authorization, end to end (brief section 11, scenarios A-E).
 *
 * Task 001 proved student-to-student IDOR over HTTP. Two scenarios had no HTTP
 * coverage and are the substance of this file:
 *
 *   Scenario D — an actor holding a PRIVILEGED role is still refused. Role is
 *                not authority over a specific object.
 *   Cross-boundary — a teacher whose assignment lives in another organization is
 *                refused, even with a real relationship edge and a real share.
 *
 * Every request below goes through the real HTTP stack with a real session.
 */
let testApp: TestApp;
let app: FastifyInstance;

const PASSWORD = 'a-sufficiently-long-passphrase'; // secret-scan-allow: test fixture password

/** Seeds a user with roles/organization, then logs in over HTTP. */
async function seedAndLogin(options: {
  email: string;
  roles?: readonly string[];
  organizationId?: string | null;
}): Promise<{ id: string; cookie: string }> {
  const user = await createUser({
    email: options.email,
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.organizationId !== undefined ? { organizationId: options.organizationId } : {}),
    passwordHash: await hashPassword(PASSWORD),
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: writeHeaders,
    payload: { email: options.email, password: PASSWORD },
  });
  if (response.statusCode !== 204) {
    throw new Error(`login failed for ${options.email}: ${response.statusCode}`);
  }
  return {
    id: user.id,
    cookie: `edu_session=${sessionCookieFrom(response.headers['set-cookie'])}`,
  };
}

async function createNote(
  cookie: string,
  visibility: 'private' | 'shared_with_teacher' | 'shared_with_guardian' = 'private',
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/notes',
    headers: { ...writeHeaders, cookie },
    payload: { title: 'Chemistry lab', body: 'my private working notes', visibility },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

const read = (id: string, cookie?: string) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/notes/${id}`,
    ...(cookie ? { headers: { cookie } } : {}),
  });

beforeEach(async () => {
  await truncateAll();
  testApp = await buildTestApp();
  app = testApp.app;
});

afterAll(async () => {
  await testApp?.db.close();
  await closeSeedDb();
});

describe('Scenario A — the owner may reach their own object', () => {
  it('returns 200 and the content', async () => {
    const student = await seedAndLogin({ email: 'owner-a@test.local' });
    const noteId = await createNote(student.cookie);

    const response = await read(noteId, student.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ body: string }>().body).toBe('my private working notes');
  });
});

describe('Scenario B — another user may not reach it', () => {
  it('returns 404 and no content', async () => {
    const owner = await seedAndLogin({ email: 'owner-b@test.local' });
    const other = await seedAndLogin({ email: 'other-b@test.local' });
    const noteId = await createNote(owner.cookie);

    const response = await read(noteId, other.cookie);
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('my private working notes');
  });
});

describe('Scenario C — an unauthenticated caller may not reach it', () => {
  it('returns 401 for a real object id', async () => {
    const owner = await seedAndLogin({ email: 'owner-c@test.local' });
    const noteId = await createNote(owner.cookie);

    const response = await read(noteId);
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('my private working notes');
  });

  it('returns 401 for every mutating verb too', async () => {
    const owner = await seedAndLogin({ email: 'owner-c2@test.local' });
    const noteId = await createNote(owner.cookie);

    for (const method of ['PATCH', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: `/api/v1/notes/${noteId}`,
        headers: { origin: 'http://localhost:5173' },
      });
      expect(response.statusCode).toBe(401);
    }
  });
});

describe('Scenario D — a privileged role is NOT authority over a specific object', () => {
  it.each(['teacher', 'admin', 'security_admin', 'moderator', 'reviewer', 'content_author'])(
    'refuses a %s reading a student private note',
    async (role) => {
      const organizationId = await createOrganization('School A');
      const student = await seedAndLogin({ email: `s-${role}@test.local`, organizationId });
      const privileged = await seedAndLogin({
        email: `p-${role}@test.local`,
        roles: [role],
        organizationId,
      });
      const noteId = await createNote(student.cookie);

      const response = await read(noteId, privileged.cookie);
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('my private working notes');
    },
  );

  it('refuses an actor holding EVERY role at once', async () => {
    const organizationId = await createOrganization('School A');
    const student = await seedAndLogin({ email: 'sd-all@test.local', organizationId });
    const superuser = await seedAndLogin({
      email: 'pd-all@test.local',
      roles: [
        'student',
        'teacher',
        'guardian',
        'content_author',
        'reviewer',
        'moderator',
        'admin',
        'security_admin',
      ],
      organizationId,
    });
    const noteId = await createNote(student.cookie);

    expect((await read(noteId, superuser.cookie)).statusCode).toBe(404);
  });

  it('refuses an ASSIGNED teacher while the note is still private', async () => {
    // Assignment is not consent. Sharing is the student's decision.
    const organizationId = await createOrganization('School A');
    const student = await seedAndLogin({ email: 'sd-priv@test.local', organizationId });
    const teacher = await seedAndLogin({
      email: 'td-priv@test.local',
      roles: ['teacher'],
      organizationId,
    });
    await assignTeacher(teacher.id, student.id, organizationId);
    const noteId = await createNote(student.cookie, 'private');

    expect((await read(noteId, teacher.cookie)).statusCode).toBe(404);
  });

  it('ALLOWS an assigned teacher once the student shares (not blanket denial)', async () => {
    const organizationId = await createOrganization('School A');
    const student = await seedAndLogin({ email: 'sd-ok@test.local', organizationId });
    const teacher = await seedAndLogin({
      email: 'td-ok@test.local',
      roles: ['teacher'],
      organizationId,
    });
    await assignTeacher(teacher.id, student.id, organizationId);
    const noteId = await createNote(student.cookie, 'shared_with_teacher');

    const response = await read(noteId, teacher.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ body: string }>().body).toBe('my private working notes');
  });

  it('still refuses that teacher any WRITE access to the shared note', async () => {
    const organizationId = await createOrganization('School A');
    const student = await seedAndLogin({ email: 'sd-w@test.local', organizationId });
    const teacher = await seedAndLogin({
      email: 'td-w@test.local',
      roles: ['teacher'],
      organizationId,
    });
    await assignTeacher(teacher.id, student.id, organizationId);
    const noteId = await createNote(student.cookie, 'shared_with_teacher');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/notes/${noteId}`,
      headers: { ...writeHeaders, cookie: teacher.cookie },
      payload: { body: 'teacher edit' },
    });
    expect(patched.statusCode).toBe(404);

    const owner = await read(noteId, student.cookie);
    expect(owner.json<{ body: string }>().body).toBe('my private working notes');
  });

  it('refuses a guardian whose link is only pending', async () => {
    const guardianEmail = 'gd-pending@test.local';
    const student = await seedAndLogin({ email: 'sd-g@test.local' });
    const guardian = await seedAndLogin({ email: guardianEmail, roles: ['guardian'] });
    await linkGuardian(guardian.id, student.id, 'pending');
    const noteId = await createNote(student.cookie, 'shared_with_guardian');

    expect((await read(noteId, guardian.cookie)).statusCode).toBe(404);
  });

  it('allows a VERIFIED guardian on a guardian-shared note', async () => {
    const student = await seedAndLogin({ email: 'sd-g2@test.local' });
    const guardian = await seedAndLogin({ email: 'gd-ok@test.local', roles: ['guardian'] });
    await linkGuardian(guardian.id, student.id, 'verified');
    const noteId = await createNote(student.cookie, 'shared_with_guardian');

    expect((await read(noteId, guardian.cookie)).statusCode).toBe(200);
  });
});

describe('Scenario E — manipulating the identifier does not bypass authorization', () => {
  it('refuses a different, valid object id', async () => {
    const owner = await seedAndLogin({ email: 'owner-e@test.local' });
    const attacker = await seedAndLogin({ email: 'attacker-e@test.local' });
    const victimNote = await createNote(owner.cookie);
    const ownNote = await createNote(attacker.cookie);

    // The attacker can reach their own object...
    expect((await read(ownNote, attacker.cookie)).statusCode).toBe(200);
    // ...and swapping the id in the same request does not carry that authority.
    expect((await read(victimNote, attacker.cookie)).statusCode).toBe(404);
  });

  it.each([
    ['a random UUID', () => randomUUID()],
    ['a nil UUID', () => '00000000-0000-0000-0000-000000000000'],
  ])('refuses %s', async (_label, makeId) => {
    const attacker = await seedAndLogin({ email: `e-${_label.replace(/\W/g, '')}@test.local` });
    expect((await read(makeId(), attacker.cookie)).statusCode).toBe(404);
  });

  it.each([
    ['SQL injection', "' OR '1'='1"],
    ['path traversal', '../../etc/passwd'],
    ['wildcard', '*'],
    ['numeric id', '1'],
    ['empty-ish', '%20'],
  ])('rejects %s as malformed rather than executing it', async (_label, id) => {
    const attacker = await seedAndLogin({ email: `em-${_label.replace(/\W/g, '')}@test.local` });
    const response = await read(id, attacker.cookie);
    // 400 (schema) or 404 (no route match) — never 200, and never a 500 that
    // would suggest the value reached the database.
    expect([400, 404]).toContain(response.statusCode);
  });

  it('is not fooled by case variation in a UUID belonging to someone else', async () => {
    const owner = await seedAndLogin({ email: 'owner-case@test.local' });
    const attacker = await seedAndLogin({ email: 'attacker-case@test.local' });
    const noteId = await createNote(owner.cookie);

    const response = await read(noteId.toUpperCase(), attacker.cookie);
    expect([400, 404]).toContain(response.statusCode);
    expect(response.body).not.toContain('my private working notes');
  });
});

describe('Cross-boundary — organization isolation', () => {
  it('refuses a teacher whose assignment lives in another organization', async () => {
    // A real relationship edge AND a real share, but the wrong organization.
    // This is what stops a stale assignment surviving a school transfer.
    const orgA = await createOrganization('School A');
    const orgB = await createOrganization('School B');

    const student = await seedAndLogin({ email: 'x-student@test.local', organizationId: orgA });
    const foreignTeacher = await seedAndLogin({
      email: 'x-teacher@test.local',
      roles: ['teacher'],
      organizationId: orgB,
    });
    await assignTeacher(foreignTeacher.id, student.id, orgB);

    const noteId = await createNote(student.cookie, 'shared_with_teacher');

    const response = await read(noteId, foreignTeacher.cookie);
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('my private working notes');
  });

  it('refuses a teacher whose assignment has ENDED', async () => {
    const organizationId = await createOrganization('School A');
    const student = await seedAndLogin({ email: 'x2-student@test.local', organizationId });
    const teacher = await seedAndLogin({
      email: 'x2-teacher@test.local',
      roles: ['teacher'],
      organizationId,
    });
    await assignTeacher(teacher.id, student.id, organizationId, 'ended');
    const noteId = await createNote(student.cookie, 'shared_with_teacher');

    expect((await read(noteId, teacher.cookie)).statusCode).toBe(404);
  });

  it('keeps listings scoped to the caller across organizations', async () => {
    const orgA = await createOrganization('School A');
    const student = await seedAndLogin({ email: 'x3-student@test.local', organizationId: orgA });
    const teacher = await seedAndLogin({
      email: 'x3-teacher@test.local',
      roles: ['teacher'],
      organizationId: orgA,
    });
    await assignTeacher(teacher.id, student.id, orgA);
    await createNote(student.cookie, 'shared_with_teacher');

    // Even a legitimately assigned teacher's own listing shows only their notes.
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/notes',
      headers: { cookie: teacher.cookie },
    });
    expect(listed.json<{ items: unknown[] }>().items).toEqual([]);
  });
});

describe('repeated denials escalate to a detection signal', () => {
  it('emits authz.repeated_denial after a run of probes', async () => {
    const owner = await seedAndLogin({ email: 'probe-owner@test.local' });
    const attacker = await seedAndLogin({ email: 'probe-attacker@test.local' });
    await createNote(owner.cookie);

    // Six probes at random ids, all 404.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await read(randomUUID(), attacker.cookie);
      expect(response.statusCode).toBe(404);
    }

    const pg = await import('pg');
    const raw = new pg.default.Client({
      connectionString:
        process.env['TEST_SUPERUSER_URL'] ??
        'postgres://postgres:postgres_test_pw@127.0.0.1:5432/edu_test', // secret-scan-allow: local test database default
    });
    await raw.connect();
    try {
      const { rows } = await raw.query<{ actor_id: string }>(
        `SELECT actor_id FROM audit_log WHERE event_type = 'authz.repeated_denial'`,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.actor_id).toBe(attacker.id);
    } finally {
      await raw.end();
    }
  });
});
