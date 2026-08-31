import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  bodylessWriteHeaders,
  buildTestApp,
  sessionCookieFrom,
  writeHeaders,
  type TestApp,
} from '../setup/app.ts';
import { TEST_SUPERUSER_URL } from '../setup/env.ts';
import {
  closeSeedDb,
  createOrganization,
  createUser,
  grantRole,
  truncateAll,
} from '../setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';

/**
 * Organization, class, roster and guardian-link management, end to end.
 *
 * The scenarios section 3 of the task calls out by name:
 *   - a teacher assigning themselves to a class (in any organization),
 *   - a guardian viewing or approving links for unlinked students,
 *   - a student reaching rosters or class administration,
 *   - an admin acting outside their own organization.
 *
 * Every request drives the real HTTP stack with a real session.
 */
let testApp: TestApp;

const PASSWORD = 'a-sufficiently-long-passphrase'; // secret-scan-allow: test fixture password

interface Session {
  readonly id: string;
  readonly cookie: string;
}

async function seedAndLogin(options: {
  email: string;
  roles?: readonly string[];
  organizationId?: string | null;
  /** Grants the roles scoped to `organizationId` rather than globally. */
  scopeRolesToOrganization?: boolean;
  globalSecurityAdmin?: boolean;
}): Promise<Session> {
  const scoped = options.scopeRolesToOrganization === true && options.organizationId != null;
  const user = await createUser({
    email: options.email,
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.organizationId !== undefined ? { organizationId: options.organizationId } : {}),
    ...(scoped
      ? { roleScopeType: 'organization' as const, roleScopeId: options.organizationId }
      : {}),
    passwordHash: await hashPassword(PASSWORD),
  });
  if (options.globalSecurityAdmin) {
    // A PLATFORM operator. Provisioned directly, because migration 0013 refuses
    // to grant any privileged role globally through the API — deliberately.
    await grantRole(user.id, 'security_admin', 'global', null);
  }

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

const get = (url: string, cookie: string) =>
  testApp.app.inject({ method: 'GET', url, headers: { cookie } });

// A bodyless POST (archive, verify, revoke) must not declare a JSON
// content-type: an empty body under that header is a malformed request, and
// Fastify rejects it with 400 before any authorization runs.
const post = (url: string, cookie: string, payload?: Record<string, unknown>) =>
  payload === undefined
    ? testApp.app.inject({
        method: 'POST',
        url,
        headers: { ...bodylessWriteHeaders, cookie },
      })
    : testApp.app.inject({
        method: 'POST',
        url,
        headers: { ...writeHeaders, cookie },
        payload,
      });

const del = (url: string, cookie: string) =>
  testApp.app.inject({
    method: 'DELETE',
    url,
    headers: { origin: 'http://localhost:5173', cookie },
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

/** A school with an admin, a teacher and a student, plus one class. */
async function school(prefix: string) {
  const organizationId = await createOrganization(`School ${prefix}`);
  const admin = await seedAndLogin({
    email: `${prefix}-admin@test.local`,
    roles: ['admin'],
    organizationId,
  });
  const teacher = await seedAndLogin({
    email: `${prefix}-teacher@test.local`,
    roles: ['teacher'],
    organizationId,
  });
  const student = await seedAndLogin({
    email: `${prefix}-student@test.local`,
    organizationId,
  });
  const created = await post('/api/v1/classes', admin.cookie, { name: `${prefix} Physics` });
  expect(created.statusCode).toBe(201);
  const classId = created.json<{ id: string }>().id;
  return { organizationId, admin, teacher, student, classId };
}

beforeEach(async () => {
  await truncateAll();
  testApp = await buildTestApp();
});

afterAll(async () => {
  await testApp?.db.close();
  await closeSeedDb();
});

// =========================================================================
describe('organizations', () => {
  it('lets a platform operator create one', async () => {
    const operator = await seedAndLogin({
      email: 'operator@test.local',
      organizationId: null,
      globalSecurityAdmin: true,
    });
    const response = await post('/api/v1/organizations', operator.cookie, { name: 'New School' });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ name: string }>().name).toBe('New School');
    expect(await auditTypes()).toContain('organization.created');
  });

  it.each(['admin', 'security_admin', 'teacher', 'student'])(
    'refuses an organization-scoped %s creating one',
    async (role) => {
      const organizationId = await createOrganization('School A');
      const actor = await seedAndLogin({
        email: `nocreate-${role}@test.local`,
        roles: [role],
        organizationId,
        // The grant is scoped to the school, which is the whole point for
        // `security_admin`: only the GLOBAL holder is a platform operator.
        scopeRolesToOrganization: true,
      });
      const response = await post('/api/v1/organizations', actor.cookie, { name: 'Sneak' });
      expect(response.statusCode).toBe(404);
    },
  );

  it('shows a member only their own organization', async () => {
    const orgA = await createOrganization('School A');
    const orgB = await createOrganization('School B');
    const student = await seedAndLogin({ email: 'org-student@test.local', organizationId: orgA });

    const listed = await get('/api/v1/organizations', student.cookie);
    const ids = listed.json<{ items: { id: string }[] }>().items.map((o) => o.id);
    expect(ids).toEqual([orgA]);
    expect(ids).not.toContain(orgB);

    expect((await get(`/api/v1/organizations/${orgB}`, student.cookie)).statusCode).toBe(404);
  });

  it('lets an admin rename their own organization but not another', async () => {
    const orgA = await createOrganization('School A');
    const orgB = await createOrganization('School B');
    const admin = await seedAndLogin({
      email: 'org-admin@test.local',
      roles: ['admin'],
      organizationId: orgA,
    });

    const own = await testApp.app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${orgA}`,
      headers: { ...writeHeaders, cookie: admin.cookie },
      payload: { name: 'Renamed' },
    });
    expect(own.statusCode).toBe(200);

    const foreign = await testApp.app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${orgB}`,
      headers: { ...writeHeaders, cookie: admin.cookie },
      payload: { name: 'Hijacked' },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('refuses a student renaming their own organization', async () => {
    const orgA = await createOrganization('School A');
    const student = await seedAndLogin({ email: 'org-stu@test.local', organizationId: orgA });
    const response = await testApp.app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${orgA}`,
      headers: { ...writeHeaders, cookie: student.cookie },
      payload: { name: 'Nope' },
    });
    expect(response.statusCode).toBe(404);
  });
});

// =========================================================================
describe('classes', () => {
  it('creates a class in the admin own organization, and nowhere else', async () => {
    const a = await school('a');
    const created = await get(`/api/v1/classes/${a.classId}`, a.admin.cookie);
    expect(created.statusCode).toBe(200);
    // The request body has no organization field, so the class necessarily
    // belongs to the caller's school.
    expect(created.json<{ organizationId: string }>().organizationId).toBe(a.organizationId);
    expect(await auditTypes()).toContain('class.created');
  });

  it('refuses a request that tries to name an organization', async () => {
    const a = await school('a');
    const response = await post('/api/v1/classes', a.admin.cookie, {
      name: 'Sneaky',
      organizationId: '11111111-1111-4111-8111-111111111111',
    });
    expect(response.statusCode).toBe(400);
  });

  it.each(['teacher', 'student'])('refuses a %s creating a class', async (role) => {
    const organizationId = await createOrganization('School A');
    const actor = await seedAndLogin({
      email: `noclass-${role}@test.local`,
      roles: [role],
      organizationId,
    });
    expect((await post('/api/v1/classes', actor.cookie, { name: 'X' })).statusCode).toBe(404);
  });

  it('refuses an admin from another school reading or editing the class', async () => {
    const a = await school('a');
    const b = await school('b');

    expect((await get(`/api/v1/classes/${a.classId}`, b.admin.cookie)).statusCode).toBe(404);

    const edit = await testApp.app.inject({
      method: 'PATCH',
      url: `/api/v1/classes/${a.classId}`,
      headers: { ...writeHeaders, cookie: b.admin.cookie },
      payload: { name: 'Hijacked' },
    });
    expect(edit.statusCode).toBe(404);
  });

  it('archives a class, and refuses edits afterwards', async () => {
    const a = await school('a');
    const archived = await post(`/api/v1/classes/${a.classId}/archive`, a.admin.cookie);
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ status: string }>().status).toBe('archived');
    expect(await auditTypes()).toContain('class.archived');

    const edit = await testApp.app.inject({
      method: 'PATCH',
      url: `/api/v1/classes/${a.classId}`,
      headers: { ...writeHeaders, cookie: a.admin.cookie },
      payload: { name: 'Reopened' },
    });
    expect(edit.statusCode).toBe(403);
  });

  it('lists only classes the actor is attached to', async () => {
    const a = await school('a');
    const outsider = await seedAndLogin({
      email: 'outsider@test.local',
      organizationId: a.organizationId,
    });
    const listed = await get('/api/v1/classes', outsider.cookie);
    expect(listed.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('rejects a sort field outside the allow-list', async () => {
    const a = await school('a');
    const response = await get('/api/v1/classes?sort=organization_id;DROP', a.admin.cookie);
    expect(response.statusCode).toBe(400);
  });
});

// =========================================================================
describe('teacher assignment — the self-assignment boundary', () => {
  it('REFUSES a teacher assigning themselves to a class in their own school', async () => {
    const a = await school('a');
    const response = await post(`/api/v1/classes/${a.classId}/teachers`, a.teacher.cookie, {
      teacherId: a.teacher.id,
    });
    expect(response.statusCode).toBe(404);
  });

  it('REFUSES a teacher assigning themselves to a class in ANOTHER school', async () => {
    const a = await school('a');
    const b = await school('b');
    const response = await post(`/api/v1/classes/${a.classId}/teachers`, b.teacher.cookie, {
      teacherId: b.teacher.id,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses an ADMIN assigning themselves', async () => {
    const a = await school('a');
    const response = await post(`/api/v1/classes/${a.classId}/teachers`, a.admin.cookie, {
      teacherId: a.admin.id,
    });
    expect(response.statusCode).toBe(403);
  });

  it('lets an admin assign a teacher, and records it', async () => {
    const a = await school('a');
    const response = await post(`/api/v1/classes/${a.classId}/teachers`, a.admin.cookie, {
      teacherId: a.teacher.id,
    });
    expect(response.statusCode).toBe(201);
    expect(await auditTypes()).toContain('class.teacher_assigned');
  });

  it('refuses an admin from another school assigning into this class', async () => {
    const a = await school('a');
    const b = await school('b');
    const response = await post(`/api/v1/classes/${a.classId}/teachers`, b.admin.cookie, {
      teacherId: b.teacher.id,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses removing an assignment through a class it does not belong to', async () => {
    // Without the class/assignment consistency check, an assignment id from one
    // class could be actioned under another class the caller administers.
    const a = await school('a');
    const b = await school('b');
    const assigned = await post(`/api/v1/classes/${a.classId}/teachers`, a.admin.cookie, {
      teacherId: a.teacher.id,
    });
    const assignmentId = assigned.json<{ id: string }>().id;

    const response = await del(
      `/api/v1/classes/${b.classId}/teachers/${assignmentId}`,
      b.admin.cookie,
    );
    expect(response.statusCode).toBe(404);
  });

  it('unassigns a teacher, revoking their derived access', async () => {
    const a = await school('a');
    const assigned = await post(`/api/v1/classes/${a.classId}/teachers`, a.admin.cookie, {
      teacherId: a.teacher.id,
    });
    await post(`/api/v1/classes/${a.classId}/members`, a.admin.cookie, { userId: a.student.id });

    // While assigned, the teacher can read the class.
    expect((await get(`/api/v1/classes/${a.classId}`, a.teacher.cookie)).statusCode).toBe(200);

    const removed = await del(
      `/api/v1/classes/${a.classId}/teachers/${assigned.json<{ id: string }>().id}`,
      a.admin.cookie,
    );
    expect(removed.statusCode).toBe(204);
    expect(await auditTypes()).toContain('class.teacher_unassigned');

    // Afterwards it is gone.
    expect((await get(`/api/v1/classes/${a.classId}`, a.teacher.cookie)).statusCode).toBe(404);
  });
});

// =========================================================================
describe('class roster', () => {
  it('lets an admin enrol a student and lists the roster', async () => {
    const a = await school('a');
    const added = await post(`/api/v1/classes/${a.classId}/members`, a.admin.cookie, {
      userId: a.student.id,
    });
    expect(added.statusCode).toBe(201);
    expect(await auditTypes()).toContain('class.member_added');

    const roster = await get(`/api/v1/classes/${a.classId}/members`, a.admin.cookie);
    expect(roster.json<{ items: { userId: string }[] }>().items.map((m) => m.userId)).toEqual([
      a.student.id,
    ]);
  });

  it('lets an assigned teacher manage and read the roster', async () => {
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/teachers`, a.admin.cookie, {
      teacherId: a.teacher.id,
    });
    const added = await post(`/api/v1/classes/${a.classId}/members`, a.teacher.cookie, {
      userId: a.student.id,
    });
    expect(added.statusCode).toBe(201);
    expect((await get(`/api/v1/classes/${a.classId}/members`, a.teacher.cookie)).statusCode).toBe(
      200,
    );
  });

  it('REFUSES an enrolled student the roster', async () => {
    // A student is attached to the class, so they can read the class itself —
    // but enumerating classmates is a separate grant they do not hold.
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/members`, a.admin.cookie, { userId: a.student.id });

    expect((await get(`/api/v1/classes/${a.classId}`, a.student.cookie)).statusCode).toBe(200);
    expect((await get(`/api/v1/classes/${a.classId}/members`, a.student.cookie)).statusCode).toBe(
      404,
    );
  });

  it('refuses a student enrolling themselves or anyone else', async () => {
    const a = await school('a');
    const response = await post(`/api/v1/classes/${a.classId}/members`, a.student.cookie, {
      userId: a.student.id,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a teacher who does not teach the class', async () => {
    const a = await school('a');
    // a.teacher has NOT been assigned to a.classId.
    const response = await post(`/api/v1/classes/${a.classId}/members`, a.teacher.cookie, {
      userId: a.student.id,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a cross-organization enrolment', async () => {
    const a = await school('a');
    const b = await school('b');
    const response = await post(`/api/v1/classes/${a.classId}/members`, b.admin.cookie, {
      userId: b.student.id,
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a duplicate enrolment', async () => {
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/members`, a.admin.cookie, { userId: a.student.id });
    const again = await post(`/api/v1/classes/${a.classId}/members`, a.admin.cookie, {
      userId: a.student.id,
    });
    expect(again.statusCode).toBe(409);
  });

  it('re-enrols a removed student as a NEW membership, leaving the old one as history', async () => {
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/members`, a.admin.cookie, { userId: a.student.id });
    const first = (await get(`/api/v1/classes/${a.classId}/members`, a.admin.cookie)).json<{
      items: { id: string }[];
    }>().items[0]!.id;

    expect(
      (await del(`/api/v1/classes/${a.classId}/members/${a.student.id}`, a.admin.cookie))
        .statusCode,
    ).toBe(204);

    // Putting them back must work — a roster is not a one-way door — and must
    // produce a DIFFERENT row, so the earlier spell keeps its own dates.
    const again = await post(`/api/v1/classes/${a.classId}/members`, a.admin.cookie, {
      userId: a.student.id,
    });
    expect(again.statusCode).toBe(201);
    expect(again.json<{ id: string }>().id).not.toBe(first);

    const roster = (await get(`/api/v1/classes/${a.classId}/members`, a.admin.cookie)).json<{
      items: { id: string; userId: string }[];
    }>().items;
    expect(roster.map((m) => m.userId)).toEqual([a.student.id]);
  });

  it('reassigns a teacher after unassignment, and rejects a duplicate assignment', async () => {
    const a = await school('a');
    const first = await post(`/api/v1/classes/${a.classId}/teachers`, a.admin.cookie, {
      teacherId: a.teacher.id,
    });
    expect(first.statusCode).toBe(201);

    // A second ACTIVE assignment is a conflict, not a silent duplicate.
    expect(
      (
        await post(`/api/v1/classes/${a.classId}/teachers`, a.admin.cookie, {
          teacherId: a.teacher.id,
        })
      ).statusCode,
    ).toBe(409);

    expect(
      (
        await del(
          `/api/v1/classes/${a.classId}/teachers/${first.json<{ id: string }>().id}`,
          a.admin.cookie,
        )
      ).statusCode,
    ).toBe(204);

    const again = await post(`/api/v1/classes/${a.classId}/teachers`, a.admin.cookie, {
      teacherId: a.teacher.id,
    });
    expect(again.statusCode).toBe(201);
    expect(again.json<{ id: string }>().id).not.toBe(first.json<{ id: string }>().id);
  });

  it('removes a student, and the removal revokes derived teacher access', async () => {
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/teachers`, a.admin.cookie, {
      teacherId: a.teacher.id,
    });
    await post(`/api/v1/classes/${a.classId}/members`, a.admin.cookie, { userId: a.student.id });

    // The teacher can see the student's profile through the shared class.
    expect((await get(`/api/v1/users/${a.student.id}/profile`, a.teacher.cookie)).statusCode).toBe(
      200,
    );

    const removed = await del(
      `/api/v1/classes/${a.classId}/members/${a.student.id}`,
      a.admin.cookie,
    );
    expect(removed.statusCode).toBe(204);
    expect(await auditTypes()).toContain('class.member_removed');

    // Access is gone the moment the membership ends — no second table to update.
    expect((await get(`/api/v1/users/${a.student.id}/profile`, a.teacher.cookie)).statusCode).toBe(
      404,
    );
  });
});

// =========================================================================
describe('guardian links', () => {
  async function guardianOf(prefix: string, organizationId: string) {
    return seedAndLogin({
      email: `${prefix}-guardian@test.local`,
      roles: ['guardian'],
      organizationId,
    });
  }

  it('creates a PENDING claim that grants nothing yet', async () => {
    const a = await school('a');
    const guardian = await guardianOf('a', a.organizationId);

    const created = await post('/api/v1/guardian-links', guardian.cookie, {
      childId: a.student.id,
    });
    expect(created.statusCode).toBe(202);

    const links = await get('/api/v1/guardian-links', guardian.cookie);
    const items = links.json<{ items: { status: string; childId: string }[] }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe('pending');

    // Pending grants nothing.
    expect((await get(`/api/v1/users/${a.student.id}/profile`, guardian.cookie)).statusCode).toBe(
      404,
    );
    expect(await auditTypes()).toContain('guardian_link.created');
  });

  it('answers 202 for a child that does not exist, disclosing nothing', async () => {
    const a = await school('a');
    const guardian = await guardianOf('a', a.organizationId);

    const real = await post('/api/v1/guardian-links', guardian.cookie, {
      childId: a.student.id,
    });
    const fake = await post('/api/v1/guardian-links', guardian.cookie, {
      childId: '99999999-9999-4999-8999-999999999999',
    });
    expect(real.statusCode).toBe(fake.statusCode);
    expect(real.body).toBe(fake.body);

    // Only the real claim exists.
    const links = await get('/api/v1/guardian-links', guardian.cookie);
    expect(links.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it('REFUSES the guardian verifying their own claim', async () => {
    // The whole attack on this table: claim guardianship of any student and
    // confirm it yourself.
    const a = await school('a');
    const guardian = await guardianOf('a', a.organizationId);
    await post('/api/v1/guardian-links', guardian.cookie, { childId: a.student.id });
    const linkId = (await get('/api/v1/guardian-links', guardian.cookie)).json<{
      items: { id: string }[];
    }>().items[0]!.id;

    const response = await post(`/api/v1/guardian-links/${linkId}/verify`, guardian.cookie);
    expect(response.statusCode).toBe(403);
  });

  it('refuses the CHILD verifying it either', async () => {
    const a = await school('a');
    const guardian = await guardianOf('a', a.organizationId);
    await post('/api/v1/guardian-links', guardian.cookie, { childId: a.student.id });
    const linkId = (await get('/api/v1/guardian-links', guardian.cookie)).json<{
      items: { id: string }[];
    }>().items[0]!.id;

    expect(
      (await post(`/api/v1/guardian-links/${linkId}/verify`, a.student.cookie)).statusCode,
    ).toBe(403);
  });

  it('lets an administrator verify, and access then follows', async () => {
    const a = await school('a');
    const guardian = await guardianOf('a', a.organizationId);
    await post('/api/v1/guardian-links', guardian.cookie, { childId: a.student.id });
    const linkId = (await get('/api/v1/guardian-links', guardian.cookie)).json<{
      items: { id: string }[];
    }>().items[0]!.id;

    const verified = await post(`/api/v1/guardian-links/${linkId}/verify`, a.admin.cookie);
    expect(verified.statusCode).toBe(200);
    expect(verified.json<{ status: string }>().status).toBe('verified');
    expect(await auditTypes()).toContain('guardian_link.verified');

    expect((await get(`/api/v1/users/${a.student.id}/profile`, guardian.cookie)).statusCode).toBe(
      200,
    );
  });

  it('refuses an admin from ANOTHER school verifying the claim', async () => {
    const a = await school('a');
    const b = await school('b');
    const guardian = await guardianOf('a', a.organizationId);
    await post('/api/v1/guardian-links', guardian.cookie, { childId: a.student.id });
    const linkId = (await get('/api/v1/guardian-links', guardian.cookie)).json<{
      items: { id: string }[];
    }>().items[0]!.id;

    expect((await post(`/api/v1/guardian-links/${linkId}/verify`, b.admin.cookie)).statusCode).toBe(
      404,
    );
  });

  it('REFUSES guardian A seeing or acting on guardian B links', async () => {
    const a = await school('a');
    const guardianA = await guardianOf('a', a.organizationId);
    const guardianB = await seedAndLogin({
      email: 'b-guardian@test.local',
      roles: ['guardian'],
      organizationId: a.organizationId,
    });

    await post('/api/v1/guardian-links', guardianA.cookie, { childId: a.student.id });
    const linkId = (await get('/api/v1/guardian-links', guardianA.cookie)).json<{
      items: { id: string }[];
    }>().items[0]!.id;

    // B sees none of A's links...
    expect(
      (await get('/api/v1/guardian-links', guardianB.cookie)).json<{ items: unknown[] }>().items,
    ).toEqual([]);
    // ...and cannot act on one by id.
    expect(
      (await post(`/api/v1/guardian-links/${linkId}/verify`, guardianB.cookie)).statusCode,
    ).toBe(404);
    expect(
      (await post(`/api/v1/guardian-links/${linkId}/revoke`, guardianB.cookie)).statusCode,
    ).toBe(404);
    // ...and cannot list the child's guardians.
    expect(
      (await get(`/api/v1/users/${a.student.id}/guardian-links`, guardianB.cookie)).json<{
        items: unknown[];
      }>().items,
    ).toEqual([]);
  });

  it('lets the CHILD revoke a verified link without anyone approval', async () => {
    const a = await school('a');
    const guardian = await guardianOf('a', a.organizationId);
    await post('/api/v1/guardian-links', guardian.cookie, { childId: a.student.id });
    const linkId = (await get('/api/v1/guardian-links', guardian.cookie)).json<{
      items: { id: string }[];
    }>().items[0]!.id;
    await post(`/api/v1/guardian-links/${linkId}/verify`, a.admin.cookie);

    const revoked = await post(`/api/v1/guardian-links/${linkId}/revoke`, a.student.cookie);
    expect(revoked.statusCode).toBe(204);
    expect(await auditTypes()).toContain('guardian_link.revoked');

    // Access is gone immediately.
    expect((await get(`/api/v1/users/${a.student.id}/profile`, guardian.cookie)).statusCode).toBe(
      404,
    );
  });

  it('refuses a student claiming to be somebody guardian', async () => {
    const a = await school('a');
    const other = await seedAndLogin({
      email: 'a-other@test.local',
      organizationId: a.organizationId,
    });
    const response = await post('/api/v1/guardian-links', a.student.cookie, {
      childId: other.id,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a request that tries to assert its own status', async () => {
    const a = await school('a');
    const guardian = await guardianOf('a', a.organizationId);
    const response = await post('/api/v1/guardian-links', guardian.cookie, {
      childId: a.student.id,
      status: 'verified',
    });
    expect(response.statusCode).toBe(400);
  });

  it('shows a teacher nothing about a student guardians', async () => {
    const a = await school('a');
    await post(`/api/v1/classes/${a.classId}/teachers`, a.admin.cookie, {
      teacherId: a.teacher.id,
    });
    await post(`/api/v1/classes/${a.classId}/members`, a.admin.cookie, { userId: a.student.id });
    const guardian = await guardianOf('a', a.organizationId);
    await post('/api/v1/guardian-links', guardian.cookie, { childId: a.student.id });

    // The teacher can see the student, but a family relationship is not theirs.
    expect((await get(`/api/v1/users/${a.student.id}/profile`, a.teacher.cookie)).statusCode).toBe(
      200,
    );
    expect(
      (await get(`/api/v1/users/${a.student.id}/guardian-links`, a.teacher.cookie)).json<{
        items: unknown[];
      }>().items,
    ).toEqual([]);
  });
});

// =========================================================================
describe('authentication is required everywhere', () => {
  it.each([
    ['GET', '/api/v1/organizations'],
    ['GET', '/api/v1/classes'],
    ['GET', '/api/v1/guardian-links'],
  ])('rejects an anonymous %s %s', async (method, url) => {
    const response = await testApp.app.inject({ method: method as 'GET', url });
    expect(response.statusCode).toBe(401);
  });
});
