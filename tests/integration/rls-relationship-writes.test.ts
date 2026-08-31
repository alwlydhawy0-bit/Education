import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../apps/api/src/platform/db.ts';
import { TEST_APP_URL } from '../setup/env.ts';
import {
  addClassMember,
  assignTeacher,
  closeSeedDb,
  createClass,
  createOrganization,
  createUser,
  grantRole,
  truncateAll,
} from '../setup/fixtures.ts';

/**
 * Write-side Row-Level Security for organizations, classes, rosters and
 * guardian links (migrations 0014 and 0015).
 *
 * The point of this file is that it does not go through the API at all. Every
 * statement runs as `edu_app` (NOBYPASSRLS, non-owner) with `app.actor_id` set
 * the way a request would set it, and the assertions are about what the
 * DATABASE permits. If the whole application authorization layer were deleted
 * tomorrow, these are the boundaries that would still hold — which is the only
 * honest way to claim two independent gates.
 *
 * Its counterpart is tests/security/layered-defense.test.ts, which removes RLS
 * and re-asserts the same boundaries through the policy engine alone.
 */
const db: Database = createDatabase({ connectionString: TEST_APP_URL, poolMax: 4 });

afterAll(async () => {
  await db.close();
  await closeSeedDb();
});

beforeEach(truncateAll);

/** Two schools, each with an admin, a teacher and a student. */
async function twoSchools() {
  const orgA = await createOrganization('School A');
  const orgB = await createOrganization('School B');
  const mk = async (prefix: string, org: string, roles?: readonly string[]) =>
    createUser({
      email: `${prefix}@test.local`,
      ...(roles ? { roles } : {}),
      organizationId: org,
    });
  return {
    orgA,
    orgB,
    adminA: await mk('admin-a', orgA, ['admin']),
    teacherA: await mk('teacher-a', orgA, ['teacher']),
    studentA: await mk('student-a', orgA),
    adminB: await mk('admin-b', orgB, ['admin']),
    teacherB: await mk('teacher-b', orgB, ['teacher']),
    classA: await createClass(orgA, 'Physics A'),
  };
}

/** Runs one statement as `actorId` and reports whether the database allowed it. */
async function attempt(actorId: string, sql: string, params: unknown[] = []): Promise<boolean> {
  try {
    await db.withActor(actorId, (tx) => tx.query(sql, params));
    return true;
  } catch {
    return false;
  }
}

// =========================================================================
describe('RLS — organizations WRITE', () => {
  it('refuses a school administrator creating an organization', async () => {
    const { adminA } = await twoSchools();
    expect(await attempt(adminA.id, `INSERT INTO organizations (name) VALUES ('Sneak')`)).toBe(
      false,
    );
  });

  it('allows a PLATFORM operator — global security_admin — to create one', async () => {
    const { adminA, orgA } = await twoSchools();
    // Organization-scoped first: still refused. Same role name, different scope.
    await grantRole(adminA.id, 'security_admin', 'organization', orgA);
    expect(await attempt(adminA.id, `INSERT INTO organizations (name) VALUES ('Sneak')`)).toBe(
      false,
    );

    const operator = await createUser({ email: 'operator@test.local', organizationId: null });
    await grantRole(operator.id, 'security_admin', 'global', null);
    expect(
      await attempt(operator.id, `INSERT INTO organizations (name) VALUES ('New School')`),
    ).toBe(true);
  });

  it('refuses an administrator renaming ANOTHER school', async () => {
    const { adminA, adminB, orgA, orgB } = await twoSchools();

    // The statement is well-formed, so it runs — but RLS matches no row, so it
    // changes nothing. A silent zero-row UPDATE is the expected shape here: the
    // caller learns nothing about School B, not even that it exists.
    await db.withActor(adminA.id, (tx) =>
      tx.query(`UPDATE organizations SET name = 'Owned' WHERE id = $1`, [orgB]),
    );

    const nameOfB = await db.withActor(
      adminB.id,
      async (tx) =>
        (await tx.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [orgB]))
          .rows[0]?.name,
    );
    expect(nameOfB).toBe('School B');

    // And School A's administrator can see exactly one organization: their own.
    const visible = await db.withActor(adminA.id, async (tx) =>
      (await tx.query<{ id: string }>('SELECT id FROM organizations')).rows.map((r) => r.id),
    );
    expect(visible).toEqual([orgA]);
  });
});

// =========================================================================
describe('RLS — classes WRITE', () => {
  it('lets an administrator create a class in their own organization only', async () => {
    const { adminA, orgA, orgB } = await twoSchools();
    expect(
      await attempt(adminA.id, `INSERT INTO classes (organization_id, name) VALUES ($1, 'Own')`, [
        orgA,
      ]),
    ).toBe(true);
    expect(
      await attempt(
        adminA.id,
        `INSERT INTO classes (organization_id, name) VALUES ($1, 'Theirs')`,
        [orgB],
      ),
    ).toBe(false);
  });

  it('refuses a teacher creating a class at all', async () => {
    const { teacherA, orgA, classA } = await twoSchools();
    await assignTeacher(teacherA.id, classA);
    expect(
      await attempt(
        teacherA.id,
        `INSERT INTO classes (organization_id, name) VALUES ($1, 'Mine')`,
        [orgA],
      ),
    ).toBe(false);
  });

  it('refuses moving a class to another organization, even for its own administrator', async () => {
    const { adminA, orgB, classA } = await twoSchools();
    // The trigger from 0014 rejects this outright, so the statement itself errors.
    expect(
      await attempt(adminA.id, `UPDATE classes SET organization_id = $1 WHERE id = $2`, [
        orgB,
        classA,
      ]),
    ).toBe(false);
  });
});

// =========================================================================
describe('RLS — teacher assignments WRITE', () => {
  it('REFUSES a teacher assigning themselves to a class', async () => {
    const { teacherA, classA } = await twoSchools();
    expect(
      await attempt(
        teacherA.id,
        `INSERT INTO teacher_assignments (teacher_id, class_id) VALUES ($1, $2)`,
        [teacherA.id, classA],
      ),
    ).toBe(false);
  });

  it('refuses a teacher assigning themselves even to a class they ALREADY teach', async () => {
    const { teacherA, orgA, classA } = await twoSchools();
    await assignTeacher(teacherA.id, classA);
    const other = await createClass(orgA, 'Chemistry A');
    expect(
      await attempt(
        teacherA.id,
        `INSERT INTO teacher_assignments (teacher_id, class_id) VALUES ($1, $2)`,
        [teacherA.id, other],
      ),
    ).toBe(false);
  });

  it('refuses an administrator assigning a teacher into ANOTHER organization', async () => {
    const { adminB, teacherB, classA } = await twoSchools();
    expect(
      await attempt(
        adminB.id,
        `INSERT INTO teacher_assignments (teacher_id, class_id) VALUES ($1, $2)`,
        [teacherB.id, classA],
      ),
    ).toBe(false);
  });

  it('lets an administrator assign within their own organization', async () => {
    const { adminA, teacherA, classA } = await twoSchools();
    expect(
      await attempt(
        adminA.id,
        `INSERT INTO teacher_assignments (teacher_id, class_id) VALUES ($1, $2)`,
        [teacherA.id, classA],
      ),
    ).toBe(true);
  });

  it('refuses re-pointing an existing assignment at another teacher or class', async () => {
    const { adminA, teacherA, classA, orgA } = await twoSchools();
    await assignTeacher(teacherA.id, classA);
    const id = await db.withActor(
      adminA.id,
      async (tx) =>
        (await tx.query<{ id: string }>('SELECT id FROM teacher_assignments')).rows[0]!.id,
    );
    const other = await createUser({ email: 'teacher-a2@test.local', organizationId: orgA });
    expect(
      await attempt(adminA.id, `UPDATE teacher_assignments SET teacher_id = $1 WHERE id = $2`, [
        other.id,
        id,
      ]),
    ).toBe(false);
  });
});

// =========================================================================
describe('RLS — class memberships WRITE', () => {
  it('REFUSES a student enrolling themselves', async () => {
    const { studentA, classA } = await twoSchools();
    expect(
      await attempt(
        studentA.id,
        `INSERT INTO class_memberships (class_id, user_id) VALUES ($1, $2)`,
        [classA, studentA.id],
      ),
    ).toBe(false);
  });

  it('lets a teacher enrol into a class they actually teach, and no other', async () => {
    const { teacherA, studentA, classA, orgA } = await twoSchools();
    await assignTeacher(teacherA.id, classA);
    expect(
      await attempt(
        teacherA.id,
        `INSERT INTO class_memberships (class_id, user_id) VALUES ($1, $2)`,
        [classA, studentA.id],
      ),
    ).toBe(true);

    const other = await createClass(orgA, 'Chemistry A');
    expect(
      await attempt(
        teacherA.id,
        `INSERT INTO class_memberships (class_id, user_id) VALUES ($1, $2)`,
        [other, studentA.id],
      ),
    ).toBe(false);
  });

  it('refuses an administrator enrolling into another organization', async () => {
    const { adminB, studentA, classA } = await twoSchools();
    expect(
      await attempt(
        adminB.id,
        `INSERT INTO class_memberships (class_id, user_id) VALUES ($1, $2)`,
        [classA, studentA.id],
      ),
    ).toBe(false);
  });

  it('refuses reinstating an ENDED membership, but permits a new one (0015)', async () => {
    const { adminA, studentA, classA } = await twoSchools();
    await addClassMember(classA, studentA.id, 'ended');
    const id = await db.withActor(
      adminA.id,
      async (tx) =>
        (await tx.query<{ id: string }>('SELECT id FROM class_memberships')).rows[0]!.id,
    );

    // Reopening the historical row is refused: the USING clause only matches
    // active rows, so this updates nothing.
    await db.withActor(adminA.id, (tx) =>
      tx.query(`UPDATE class_memberships SET status = 'active', ended_at = NULL WHERE id = $1`, [
        id,
      ]),
    );
    const stillEnded = await db.withActor(
      adminA.id,
      async (tx) =>
        (
          await tx.query<{ status: string }>('SELECT status FROM class_memberships WHERE id = $1', [
            id,
          ])
        ).rows[0]!.status,
    );
    expect(stillEnded).toBe('ended');

    // A fresh enrolment is allowed, because the unique index now covers only
    // active rows.
    expect(
      await attempt(
        adminA.id,
        `INSERT INTO class_memberships (class_id, user_id) VALUES ($1, $2)`,
        [classA, studentA.id],
      ),
    ).toBe(true);

    // ...and a SECOND active row for the same pair is still impossible.
    expect(
      await attempt(
        adminA.id,
        `INSERT INTO class_memberships (class_id, user_id) VALUES ($1, $2)`,
        [classA, studentA.id],
      ),
    ).toBe(false);
  });
});

// =========================================================================
describe('RLS — guardian relationships WRITE', () => {
  it('refuses a child asserting their own verified guardian', async () => {
    const { studentA, orgA } = await twoSchools();
    const adult = await createUser({ email: 'adult@test.local', organizationId: orgA });
    expect(
      await attempt(
        studentA.id,
        `INSERT INTO guardian_relationships (guardian_id, child_id, status, verified_at)
         VALUES ($1, $2, 'verified', now())`,
        [adult.id, studentA.id],
      ),
    ).toBe(false);
  });

  it('lets a guardian file a PENDING claim about themselves, and nothing stronger', async () => {
    const { studentA, orgA } = await twoSchools();
    const guardian = await createUser({
      email: 'guardian@test.local',
      roles: ['guardian'],
      organizationId: orgA,
    });
    expect(
      await attempt(
        guardian.id,
        `INSERT INTO guardian_relationships (guardian_id, child_id, status)
         VALUES ($1, $2, 'pending')`,
        [guardian.id, studentA.id],
      ),
    ).toBe(true);

    const other = await createUser({ email: 'student-a2@test.local', organizationId: orgA });
    expect(
      await attempt(
        guardian.id,
        `INSERT INTO guardian_relationships (guardian_id, child_id, status, verified_at)
         VALUES ($1, $2, 'verified', now())`,
        [guardian.id, other.id],
      ),
    ).toBe(false);
  });

  it('refuses re-pointing an existing link at a different child', async () => {
    const { adminA, studentA, orgA } = await twoSchools();
    const guardian = await createUser({
      email: 'guardian@test.local',
      roles: ['guardian'],
      organizationId: orgA,
    });
    const other = await createUser({ email: 'student-a2@test.local', organizationId: orgA });
    await db.withActor(guardian.id, (tx) =>
      tx.query(
        `INSERT INTO guardian_relationships (guardian_id, child_id, status)
         VALUES ($1, $2, 'pending')`,
        [guardian.id, studentA.id],
      ),
    );
    const id = await db.withActor(
      guardian.id,
      async (tx) =>
        (await tx.query<{ id: string }>('SELECT id FROM guardian_relationships')).rows[0]!.id,
    );
    expect(
      await attempt(adminA.id, `UPDATE guardian_relationships SET child_id = $1 WHERE id = $2`, [
        other.id,
        id,
      ]),
    ).toBe(false);
  });
});
