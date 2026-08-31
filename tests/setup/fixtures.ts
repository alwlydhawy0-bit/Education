import pg from 'pg';
import { TEST_SUPERUSER_URL } from './env.ts';

/**
 * Seeding helpers.
 *
 * Seeds run on the SUPERUSER connection, because setting up a scenario is not
 * the thing under test — every assertion runs through the application role.
 * Keeping the two separate means a fixture can create a state the application
 * role could never create itself (a verified guardian link, an admin role),
 * which is exactly what the negative tests need. It also means the production
 * RLS policies never have to be loosened to make tests convenient.
 */
export interface SeededUser {
  readonly id: string;
  readonly email: string;
}

let seedClient: pg.Client | null = null;

export async function seedDb(): Promise<pg.Client> {
  if (!seedClient) {
    seedClient = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await seedClient.connect();
  }
  return seedClient;
}

export async function closeSeedDb(): Promise<void> {
  if (seedClient) {
    await seedClient.end();
    seedClient = null;
  }
}

/** Wipes all domain data between tests. Order respects foreign keys. */
export async function truncateAll(): Promise<void> {
  const db = await seedDb();
  // `roles`, `permissions` and `role_permissions` are seeded reference data
  // created by migration 0007 — truncating them would leave registration unable
  // to grant the default role.
  await db.query(
    `TRUNCATE notes, guardian_relationships, teacher_assignments, class_memberships,
              classes, sessions, user_roles, email_verifications, password_reset_tokens,
              profiles, audit_log, users, organizations
     RESTART IDENTITY CASCADE`,
  );
}

export async function createOrganization(name: string): Promise<string> {
  const db = await seedDb();
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    [name],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Failed to seed organization');
  return id;
}

export async function createUser(options: {
  email: string;
  roles?: readonly string[];
  organizationId?: string | null;
  status?: 'active' | 'suspended' | 'pending_verification';
  passwordHash?: string;
  roleScopeType?: 'global' | 'organization' | 'class';
  roleScopeId?: string | null;
}): Promise<SeededUser> {
  const db = await seedDb();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name, locale, status, organization_id)
     VALUES ($1, $2, $3, 'ar', $4, $5) RETURNING id`,
    [
      options.email.toLowerCase(),
      options.passwordHash ?? '$argon2id$placeholder',
      options.email.split('@')[0] ?? 'user',
      options.status ?? 'active',
      options.organizationId ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Failed to seed user');

  // Also create the profile, so seeded users match what registration produces.
  await db.query(
    `INSERT INTO profiles (user_id, display_name, locale) VALUES ($1, $2, 'ar')
     ON CONFLICT (user_id) DO NOTHING`,
    [id, options.email.split('@')[0] ?? 'user'],
  );

  for (const role of options.roles ?? ['student']) {
    await grantRole(id, role, options.roleScopeType ?? 'global', options.roleScopeId ?? null);
  }
  return { id, email: options.email.toLowerCase() };
}

/** Grants a role, resolving the role name to its id. */
export async function grantRole(
  userId: string,
  role: string,
  scopeType: 'global' | 'organization' | 'class' = 'global',
  scopeId: string | null = null,
): Promise<void> {
  const db = await seedDb();
  await db.query(
    `INSERT INTO user_roles (user_id, role_id, scope_type, scope_id)
     SELECT $1, r.id, $3, $4 FROM roles r WHERE r.name = $2
     ON CONFLICT DO NOTHING`,
    [userId, role, scopeType, scopeId],
  );
}

export async function createClass(
  organizationId: string,
  name = 'Test Class',
  status: 'active' | 'archived' = 'active',
): Promise<string> {
  const db = await seedDb();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO classes (organization_id, name, status, archived_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [organizationId, name, status, status === 'archived' ? new Date() : null],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Failed to seed class');
  return id;
}

export async function addClassMember(
  classId: string,
  userId: string,
  status: 'active' | 'ended' = 'active',
): Promise<void> {
  const db = await seedDb();
  await db.query(
    `INSERT INTO class_memberships (class_id, user_id, status, ended_at)
     VALUES ($1, $2, $3, $4)`,
    [classId, userId, status, status === 'ended' ? new Date() : null],
  );
}

export async function createNote(options: {
  ownerId: string;
  organizationId?: string | null;
  title?: string;
  body?: string;
  visibility?: 'private' | 'shared_with_teacher' | 'shared_with_guardian';
  state?: 'active' | 'archived' | 'deleted';
}): Promise<string> {
  const db = await seedDb();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO notes (owner_id, organization_id, title, body, visibility, state)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      options.ownerId,
      options.organizationId ?? null,
      options.title ?? 'Test note',
      options.body ?? 'Test body',
      options.visibility ?? 'private',
      options.state ?? 'active',
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Failed to seed note');
  return id;
}

export async function linkGuardian(
  guardianId: string,
  childId: string,
  status: 'pending' | 'verified' | 'revoked' = 'verified',
): Promise<string> {
  const db = await seedDb();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO guardian_relationships (guardian_id, child_id, status, verified_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [guardianId, childId, status, status === 'verified' ? new Date() : null],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Failed to seed guardian relationship');
  return id;
}

/**
 * Assigns a teacher to a class.
 *
 * Teacher-to-student is DERIVED from a shared class, so seeding that
 * relationship means seeding both halves: this assignment and the student's
 * membership. `linkTeacherToStudent` below does both for the common case.
 */
export async function assignTeacher(
  teacherId: string,
  classId: string,
  status: 'active' | 'ended' = 'active',
): Promise<void> {
  const db = await seedDb();
  await db.query(
    `INSERT INTO teacher_assignments (teacher_id, class_id, status, ended_at)
     VALUES ($1, $2, $3, $4)`,
    [teacherId, classId, status, status === 'ended' ? new Date() : null],
  );
}

/** Convenience: creates a class, assigns the teacher, and enrols the student. */
export async function linkTeacherToStudent(options: {
  teacherId: string;
  studentId: string;
  organizationId: string;
  className?: string;
  classStatus?: 'active' | 'archived';
  assignmentStatus?: 'active' | 'ended';
  membershipStatus?: 'active' | 'ended';
}): Promise<string> {
  const classId = await createClass(
    options.organizationId,
    options.className ?? 'Test Class',
    options.classStatus ?? 'active',
  );
  await assignTeacher(options.teacherId, classId, options.assignmentStatus ?? 'active');
  await addClassMember(classId, options.studentId, options.membershipStatus ?? 'active');
  return classId;
}
