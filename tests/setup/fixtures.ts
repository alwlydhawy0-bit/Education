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
  await db.query(
    'TRUNCATE notes, guardian_links, teacher_assignments, sessions, user_roles, audit_log, users, organizations RESTART IDENTITY CASCADE',
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

  for (const role of options.roles ?? ['student']) {
    await db.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, role]);
  }
  return { id, email: options.email.toLowerCase() };
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
  studentId: string,
  status: 'pending' | 'verified' | 'revoked' = 'verified',
): Promise<void> {
  const db = await seedDb();
  await db.query(
    `INSERT INTO guardian_links (guardian_id, student_id, status, verified_at)
     VALUES ($1, $2, $3, $4)`,
    [guardianId, studentId, status, status === 'verified' ? new Date() : null],
  );
}

export async function assignTeacher(
  teacherId: string,
  studentId: string,
  organizationId: string,
  status: 'active' | 'ended' = 'active',
): Promise<void> {
  const db = await seedDb();
  await db.query(
    `INSERT INTO teacher_assignments (teacher_id, student_id, organization_id, status, ended_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [teacherId, studentId, organizationId, status, status === 'ended' ? new Date() : null],
  );
}
