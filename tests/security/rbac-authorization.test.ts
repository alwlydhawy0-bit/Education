import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildTestApp, sessionCookieFrom, writeHeaders, type TestApp } from '../setup/app.ts';
import { TEST_SUPERUSER_URL } from '../setup/env.ts';
import {
  closeSeedDb,
  createOrganization,
  createUser,
  grantRole,
  linkGuardian,
  linkTeacherToStudent,
  truncateAll,
} from '../setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';

/**
 * Object-level authorization across the identity domain.
 *
 * The scenarios Task 003 calls out by name:
 *   - Guardian A cannot reach Guardian B's children.
 *   - Teacher A cannot reach Teacher B's students.
 *   - A student cannot reach another student's data.
 *   - Nobody can escalate their own privileges.
 *
 * Every request goes through the real HTTP stack with a real session.
 */
let testApp: TestApp;

const PASSWORD = 'a-sufficiently-long-passphrase'; // secret-scan-allow: test fixture password

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
  const response = await testApp.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: writeHeaders,
    payload: { email: options.email, password: PASSWORD },
  });
  if (response.statusCode !== 204) {
    throw new Error(`login failed for ${options.email}: ${response.statusCode} ${response.body}`);
  }
  return {
    id: user.id,
    cookie: `edu_session=${sessionCookieFrom(response.headers['set-cookie'])}`,
  };
}

const getProfile = (userId: string, cookie: string) =>
  testApp.app.inject({
    method: 'GET',
    url: `/api/v1/users/${userId}/profile`,
    headers: { cookie },
  });

async function auditTypes(): Promise<string[]> {
  const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
  await raw.connect();
  try {
    const { rows } = await raw.query<{ event_type: string }>('SELECT event_type FROM audit_log');
    return rows.map((r) => r.event_type);
  } finally {
    await raw.end();
  }
}

beforeEach(async () => {
  await truncateAll();
  testApp = await buildTestApp();
});

afterAll(async () => {
  await testApp?.db.close();
  await closeSeedDb();
});

describe('guardian isolation — Guardian A cannot reach Guardian B children', () => {
  it('refuses a guardian reading a child who is not theirs', async () => {
    const org = await createOrganization('School A');
    const childA = await seedAndLogin({ email: 'child-a@test.local', organizationId: org });
    const childB = await seedAndLogin({ email: 'child-b@test.local', organizationId: org });
    const guardianA = await seedAndLogin({
      email: 'guardian-a@test.local',
      roles: ['guardian'],
      organizationId: org,
    });
    await linkGuardian(guardianA.id, childA.id, 'verified');

    // Their own child: allowed.
    expect((await getProfile(childA.id, guardianA.cookie)).statusCode).toBe(200);
    // Someone else's child: refused, and indistinguishable from not existing.
    expect((await getProfile(childB.id, guardianA.cookie)).statusCode).toBe(404);
  });

  it('refuses a guardian whose link is only pending', async () => {
    const org = await createOrganization('School A');
    const child = await seedAndLogin({ email: 'child-p@test.local', organizationId: org });
    const guardian = await seedAndLogin({
      email: 'guardian-p@test.local',
      roles: ['guardian'],
      organizationId: org,
    });
    await linkGuardian(guardian.id, child.id, 'pending');

    // An unverified claim is not an access grant.
    expect((await getProfile(child.id, guardian.cookie)).statusCode).toBe(404);
  });

  it('refuses a guardian whose link has been revoked', async () => {
    const org = await createOrganization('School A');
    const child = await seedAndLogin({ email: 'child-r@test.local', organizationId: org });
    const guardian = await seedAndLogin({
      email: 'guardian-r@test.local',
      roles: ['guardian'],
      organizationId: org,
    });
    await linkGuardian(guardian.id, child.id, 'revoked');
    expect((await getProfile(child.id, guardian.cookie)).statusCode).toBe(404);
  });
});

describe('teacher isolation — Teacher A cannot reach Teacher B students', () => {
  it('refuses a teacher reading a student they do not teach', async () => {
    const org = await createOrganization('School A');
    const studentA = await seedAndLogin({ email: 'student-a@test.local', organizationId: org });
    const studentB = await seedAndLogin({ email: 'student-b@test.local', organizationId: org });
    const teacherA = await seedAndLogin({
      email: 'teacher-a@test.local',
      roles: ['teacher'],
      organizationId: org,
    });
    await linkTeacherToStudent({
      teacherId: teacherA.id,
      studentId: studentA.id,
      organizationId: org,
    });

    expect((await getProfile(studentA.id, teacherA.cookie)).statusCode).toBe(200);
    expect((await getProfile(studentB.id, teacherA.cookie)).statusCode).toBe(404);
  });

  it('revokes access the moment the student leaves the class', async () => {
    // Teacher-to-student is DERIVED, so there is no second edge to forget.
    const org = await createOrganization('School A');
    const student = await seedAndLogin({ email: 'student-l@test.local', organizationId: org });
    const teacher = await seedAndLogin({
      email: 'teacher-l@test.local',
      roles: ['teacher'],
      organizationId: org,
    });
    await linkTeacherToStudent({
      teacherId: teacher.id,
      studentId: student.id,
      organizationId: org,
    });
    expect((await getProfile(student.id, teacher.cookie)).statusCode).toBe(200);

    const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await raw.connect();
    try {
      await raw.query(`UPDATE class_memberships SET status='ended', ended_at=now()`);
    } finally {
      await raw.end();
    }

    expect((await getProfile(student.id, teacher.cookie)).statusCode).toBe(404);
  });

  it('revokes access when the class is archived', async () => {
    const org = await createOrganization('School A');
    const student = await seedAndLogin({ email: 'student-ar@test.local', organizationId: org });
    const teacher = await seedAndLogin({
      email: 'teacher-ar@test.local',
      roles: ['teacher'],
      organizationId: org,
    });
    await linkTeacherToStudent({
      teacherId: teacher.id,
      studentId: student.id,
      organizationId: org,
      classStatus: 'archived',
    });
    expect((await getProfile(student.id, teacher.cookie)).statusCode).toBe(404);
  });

  it('refuses a teacher whose assignment is in another organization', async () => {
    const orgA = await createOrganization('School A');
    const orgB = await createOrganization('School B');
    const student = await seedAndLogin({ email: 'student-x@test.local', organizationId: orgA });
    const teacher = await seedAndLogin({
      email: 'teacher-x@test.local',
      roles: ['teacher'],
      organizationId: orgB,
    });
    await linkTeacherToStudent({
      teacherId: teacher.id,
      studentId: student.id,
      organizationId: orgB,
    });
    expect((await getProfile(student.id, teacher.cookie)).statusCode).toBe(404);
  });
});

describe('student isolation', () => {
  it('refuses one student reading another student profile', async () => {
    const org = await createOrganization('School A');
    const a = await seedAndLogin({ email: 's-one@test.local', organizationId: org });
    const b = await seedAndLogin({ email: 's-two@test.local', organizationId: org });
    expect((await getProfile(b.id, a.cookie)).statusCode).toBe(404);
    // Their own profile still works — the control is not blanket denial.
    expect((await getProfile(a.id, a.cookie)).statusCode).toBe(200);
  });

  it('refuses a student updating another profile, even with a crafted body', async () => {
    const org = await createOrganization('School A');
    const a = await seedAndLogin({ email: 's-three@test.local', organizationId: org });
    const b = await seedAndLogin({ email: 's-four@test.local', organizationId: org });

    // There is no `userId` field in the contract, so the attempt is a 400 —
    // the request cannot even name another person.
    const response = await testApp.app.inject({
      method: 'PATCH',
      url: '/api/v1/profile',
      headers: { ...writeHeaders, cookie: a.cookie },
      payload: { displayName: 'hijacked', userId: b.id },
    });
    expect(response.statusCode).toBe(400);
  });

  it('updates only the caller own profile', async () => {
    const org = await createOrganization('School A');
    const a = await seedAndLogin({ email: 's-five@test.local', organizationId: org });
    const response = await testApp.app.inject({
      method: 'PATCH',
      url: '/api/v1/profile',
      headers: { ...writeHeaders, cookie: a.cookie },
      payload: { displayName: 'New Name', bio: 'Hello' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ userId: string; displayName: string }>()).toMatchObject({
      userId: a.id,
      displayName: 'New Name',
    });
  });

  it('rejects an avatar URL with a dangerous scheme', async () => {
    const a = await seedAndLogin({ email: 's-six@test.local' });
    for (const avatarUrl of ['javascript:alert(1)', 'data:text/html,<script>', 'http://x.test/a']) {
      const response = await testApp.app.inject({
        method: 'PATCH',
        url: '/api/v1/profile',
        headers: { ...writeHeaders, cookie: a.cookie },
        payload: { avatarUrl },
      });
      expect(response.statusCode).toBe(400);
    }
  });
});

describe('administration is scoped and contained', () => {
  async function seedAdmin(organizationId: string, email = 'admin@test.local') {
    return seedAndLogin({ email, roles: ['admin'], organizationId });
  }

  it('lets an admin list users in their own organization only', async () => {
    const orgA = await createOrganization('School A');
    const orgB = await createOrganization('School B');
    await seedAndLogin({ email: 'in-a@test.local', organizationId: orgA });
    const outsider = await seedAndLogin({ email: 'in-b@test.local', organizationId: orgB });
    const admin = await seedAdmin(orgA);

    const listed = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { cookie: admin.cookie },
    });
    expect(listed.statusCode).toBe(200);
    const ids = listed.json<{ items: { id: string }[] }>().items.map((u) => u.id);
    expect(ids).not.toContain(outsider.id);
  });

  it.each(['student', 'teacher', 'guardian', 'moderator', 'reviewer', 'content_author'])(
    'refuses %s the admin listing',
    async (role) => {
      const org = await createOrganization('School A');
      const actor = await seedAndLogin({
        email: `nolist-${role}@test.local`,
        roles: [role],
        organizationId: org,
      });
      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/admin/users',
        headers: { cookie: actor.cookie },
      });
      expect(response.statusCode).toBe(404);
    },
  );

  it('refuses an admin reading a user in another organization', async () => {
    const orgA = await createOrganization('School A');
    const orgB = await createOrganization('School B');
    const foreign = await seedAndLogin({ email: 'foreign@test.local', organizationId: orgB });
    const admin = await seedAdmin(orgA);

    const response = await testApp.app.inject({
      method: 'GET',
      url: `/api/v1/admin/users/${foreign.id}`,
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('REFUSES an admin granting a role to themselves', async () => {
    // Self-grant is the shortest path from a compromised admin account to
    // permanent control.
    const org = await createOrganization('School A');
    const admin = await seedAdmin(org);

    const response = await testApp.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${admin.id}/roles`,
      headers: { ...writeHeaders, cookie: admin.cookie },
      payload: { role: 'security_admin', scopeType: 'organization', scopeId: org },
    });
    expect(response.statusCode).toBe(403);
  });

  it.each(['admin', 'security_admin'])(
    'refuses an ordinary admin granting the privileged role %s',
    async (role) => {
      const org = await createOrganization('School A');
      const target = await seedAndLogin({
        email: `target-${role}@test.local`,
        organizationId: org,
      });
      const admin = await seedAdmin(org, `admin-${role}@test.local`);

      const response = await testApp.app.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${target.id}/roles`,
        headers: { ...writeHeaders, cookie: admin.cookie },
        payload: { role, scopeType: 'organization', scopeId: org },
      });
      expect(response.statusCode).toBe(403);
    },
  );

  it('lets an admin grant an ordinary role, and records who did it', async () => {
    const org = await createOrganization('School A');
    const target = await seedAndLogin({ email: 'promote@test.local', organizationId: org });
    const admin = await seedAdmin(org, 'admin-ok@test.local');

    const response = await testApp.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${target.id}/roles`,
      headers: { ...writeHeaders, cookie: admin.cookie },
      payload: { role: 'teacher', scopeType: 'organization', scopeId: org },
    });
    expect(response.statusCode).toBe(204);

    const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await raw.connect();
    try {
      const { rows } = await raw.query<{ actor_id: string; detail: Record<string, unknown> }>(
        `SELECT actor_id, detail FROM audit_log WHERE event_type = 'role.granted'`,
      );
      // The recorded actor is the OPERATOR, not the affected user: an
      // investigator needs to know who acted.
      expect(rows[0]?.actor_id).toBe(admin.id);
      expect(rows[0]?.detail['targetUserId']).toBe(target.id);
      expect(rows[0]?.detail['role']).toBe('teacher');
    } finally {
      await raw.end();
    }
  });

  it('refuses an admin granting a role to a user in another organization', async () => {
    const orgA = await createOrganization('School A');
    const orgB = await createOrganization('School B');
    const foreign = await seedAndLogin({ email: 'foreign-2@test.local', organizationId: orgB });
    const admin = await seedAdmin(orgA, 'admin-cross@test.local');

    const response = await testApp.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${foreign.id}/roles`,
      headers: { ...writeHeaders, cookie: admin.cookie },
      payload: { role: 'teacher', scopeType: 'organization', scopeId: orgA },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses an ordinary admin suspending an account', async () => {
    // Suspension is reserved to security administrators, so the two
    // capabilities stay separable.
    const org = await createOrganization('School A');
    const target = await seedAndLogin({ email: 'victim@test.local', organizationId: org });
    const admin = await seedAdmin(org, 'admin-susp@test.local');

    const response = await testApp.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${target.id}`,
      headers: { ...writeHeaders, cookie: admin.cookie },
      payload: { status: 'suspended' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('lets a security administrator suspend, and records the change', async () => {
    const org = await createOrganization('School A');
    const target = await seedAndLogin({ email: 'victim2@test.local', organizationId: org });
    const secAdmin = await seedAndLogin({
      email: 'secadmin@test.local',
      roles: ['security_admin'],
      organizationId: org,
    });

    const response = await testApp.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${target.id}`,
      headers: { ...writeHeaders, cookie: secAdmin.cookie },
      payload: { status: 'suspended' },
    });
    expect(response.statusCode).toBe(200);
    expect(await auditTypes()).toContain('user.status_changed');
  });

  it('a suspended user is refused everything immediately', async () => {
    const org = await createOrganization('School A');
    const target = await seedAndLogin({ email: 'victim3@test.local', organizationId: org });
    const secAdmin = await seedAndLogin({
      email: 'secadmin2@test.local',
      roles: ['security_admin'],
      organizationId: org,
    });

    await testApp.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${target.id}`,
      headers: { ...writeHeaders, cookie: secAdmin.cookie },
      payload: { status: 'suspended' },
    });

    // The global pre-check in the policy engine denies a suspended actor even
    // their own resources, on their existing session. 403 rather than 404 here:
    // the actor plainly knows their own profile exists, so hiding it would be
    // confusing rather than protective.
    const own = await getProfile(target.id, target.cookie);
    expect(own.statusCode).toBe(403);
  });
});

describe('scoped grants do not leak across scopes', () => {
  it('a class-scoped teacher role does not confer organization-wide reach', async () => {
    const org = await createOrganization('School A');
    const student = await seedAndLogin({ email: 'scoped-student@test.local', organizationId: org });
    const teacher = await createUser({
      email: 'scoped-teacher@test.local',
      organizationId: org,
      roles: [],
      passwordHash: await hashPassword(PASSWORD),
    });
    // Teacher of ONE class, and the student is not in it.
    const classId = await linkTeacherToStudent({
      teacherId: teacher.id,
      studentId: (await createUser({ email: 'other-student@test.local', organizationId: org })).id,
      organizationId: org,
    });
    await grantRole(teacher.id, 'teacher', 'class', classId);

    const loggedIn = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: writeHeaders,
      payload: { email: 'scoped-teacher@test.local', password: PASSWORD },
    });
    const cookie = `edu_session=${sessionCookieFrom(loggedIn.headers['set-cookie'])}`;

    expect((await getProfile(student.id, cookie)).statusCode).toBe(404);
  });

  it('reports the scope of each grant on /auth/me', async () => {
    const org = await createOrganization('School A');
    const teacher = await createUser({
      email: 'grants@test.local',
      organizationId: org,
      roles: ['student'],
      passwordHash: await hashPassword(PASSWORD),
    });
    await grantRole(teacher.id, 'teacher', 'organization', org);

    const loggedIn = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: writeHeaders,
      payload: { email: 'grants@test.local', password: PASSWORD },
    });
    const cookie = `edu_session=${sessionCookieFrom(loggedIn.headers['set-cookie'])}`;

    const me = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    const body = me.json<{
      grants: { role: string; scopeType: string; scopeId: string | null }[];
      permissions: string[];
    }>();

    expect(body.grants).toContainEqual({ role: 'student', scopeType: 'global', scopeId: null });
    expect(body.grants).toContainEqual({
      role: 'teacher',
      scopeType: 'organization',
      scopeId: org,
    });
    // Permissions are the union across roles, derived by the database.
    expect(body.permissions).toContain('students:read');
  });
});
