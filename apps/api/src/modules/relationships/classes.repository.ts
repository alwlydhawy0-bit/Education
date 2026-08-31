import { Guarded, type ClassResource, type TeacherAssignmentResource } from '@edu/authz';
import { resolveSortColumn, resolveSortDirection, type ListClassesQuery } from '@edu/contracts';
import type { Tx } from '../../platform/db.ts';

export interface ClassRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly academicTerm: string;
  readonly status: 'active' | 'archived';
  readonly createdAt: Date;
}

export interface ClassMemberRecord {
  readonly id: string;
  readonly classId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly roleInClass: 'student' | 'assistant' | 'observer';
  readonly status: 'active' | 'ended';
  readonly joinedAt: Date;
}

export interface ClassTeacherRecord {
  readonly id: string;
  readonly classId: string;
  readonly teacherId: string;
  readonly displayName: string;
  readonly roleInClass: 'teacher' | 'assistant_teacher' | 'substitute';
  readonly status: 'active' | 'ended';
  readonly createdAt: Date;
}

interface ClassRow {
  id: string;
  organization_id: string;
  name: string;
  academic_term: string;
  status: 'active' | 'archived';
  created_at: Date;
}

interface MemberRow {
  id: string;
  class_id: string;
  user_id: string;
  display_name: string;
  role_in_class: ClassMemberRecord['roleInClass'];
  status: 'active' | 'ended';
  joined_at: Date;
  class_organization_id: string;
}

/**
 * The bare state of one membership, WITHOUT the member's name.
 *
 * Used for control flow — "is this person already on the roster?" — which must
 * not depend on whether the caller may read the member's identity. Joining
 * `users` here would make an ended membership invisible to a teacher (who can
 * only see a student through an ACTIVE one) and turn a duplicate enrolment into
 * a unique-violation 500 instead of a conflict.
 */
export interface MembershipState {
  readonly id: string;
  readonly userId: string;
  readonly status: 'active' | 'ended';
}

interface TeacherRow {
  id: string;
  class_id: string;
  teacher_id: string;
  display_name: string;
  role_in_class: ClassTeacherRecord['roleInClass'];
  status: 'active' | 'ended';
  created_at: Date;
  class_organization_id: string;
}

/** Allow-listed sort fields mapped to literal SQL columns (see ADR/query.ts). */
const CLASS_SORT_COLUMNS = { createdAt: 'created_at', name: 'name' } as const;

const toClass = (row: ClassRow): ClassRecord => ({
  id: row.id,
  organizationId: row.organization_id,
  name: row.name,
  academicTerm: row.academic_term,
  status: row.status,
  createdAt: row.created_at,
});

const toClassResource = (row: ClassRow): ClassResource => ({
  kind: 'class',
  id: row.id,
  organizationId: row.organization_id,
  state: row.status,
});

const toMember = (row: MemberRow): ClassMemberRecord => ({
  id: row.id,
  classId: row.class_id,
  userId: row.user_id,
  displayName: row.display_name,
  roleInClass: row.role_in_class,
  status: row.status,
  joinedAt: row.joined_at,
});

const toTeacher = (row: TeacherRow): ClassTeacherRecord => ({
  id: row.id,
  classId: row.class_id,
  teacherId: row.teacher_id,
  displayName: row.display_name,
  roleInClass: row.role_in_class,
  status: row.status,
  createdAt: row.created_at,
});

const toAssignmentResource = (row: TeacherRow): TeacherAssignmentResource => ({
  kind: 'teacher_assignment',
  id: row.id,
  classId: row.class_id,
  classOrganizationId: row.class_organization_id,
  teacherId: row.teacher_id,
  state: row.status,
});

/**
 * Class and roster persistence.
 *
 * Note what is absent: no method takes an organization id. Classes are created
 * in the caller's own organization, and every list is scoped by RLS. There is no
 * parameter through which a caller could reach another school.
 */
export interface ClassesRepository {
  findById(tx: Tx, id: string): Promise<Guarded<ClassRecord> | null>;
  list(tx: Tx, query: ListClassesQuery): Promise<ClassRecord[]>;
  insert(tx: Tx, organizationId: string, name: string, academicTerm: string): Promise<ClassRecord>;
  applyUpdate(
    tx: Tx,
    id: string,
    patch: { name?: string; academicTerm?: string },
  ): Promise<ClassRecord | null>;
  archive(tx: Tx, id: string): Promise<boolean>;

  listMembers(tx: Tx, classId: string): Promise<ClassMemberRecord[]>;
  findActiveMembership(tx: Tx, classId: string, userId: string): Promise<MembershipState | null>;
  addMember(
    tx: Tx,
    classId: string,
    userId: string,
    roleInClass: ClassMemberRecord['roleInClass'],
  ): Promise<ClassMemberRecord>;
  endMembership(tx: Tx, membershipId: string): Promise<boolean>;

  findActiveAssignment(tx: Tx, classId: string, teacherId: string): Promise<string | null>;
  listTeachers(tx: Tx, classId: string): Promise<ClassTeacherRecord[]>;
  findAssignment(tx: Tx, id: string): Promise<Guarded<ClassTeacherRecord> | null>;
  addTeacher(
    tx: Tx,
    classId: string,
    teacherId: string,
    roleInClass: ClassTeacherRecord['roleInClass'],
  ): Promise<ClassTeacherRecord>;
  endAssignment(tx: Tx, assignmentId: string): Promise<boolean>;
}

const CLASS_COLUMNS = 'id, organization_id, name, academic_term, status, created_at';

const ASSIGNMENT_SELECT = `SELECT ta.id, ta.class_id, ta.teacher_id, u.display_name, ta.role_in_class,
              ta.status, ta.created_at, c.organization_id AS class_organization_id
         FROM teacher_assignments ta
         JOIN users u ON u.id = ta.teacher_id
         JOIN classes c ON c.id = ta.class_id`;

/** Reads one assignment WITH the teacher's name, subject to the caller's RLS. */
async function readAssignment(tx: Tx, assignmentId: string): Promise<ClassTeacherRecord | null> {
  const { rows } = await tx.query<TeacherRow>(`${ASSIGNMENT_SELECT} WHERE ta.id = $1`, [
    assignmentId,
  ]);
  const row = rows[0];
  return row ? toTeacher(row) : null;
}

/** Reads one membership WITH the member's name, subject to the caller's RLS. */
async function readMember(tx: Tx, membershipId: string): Promise<ClassMemberRecord | null> {
  const { rows } = await tx.query<MemberRow>(
    `SELECT cm.id, cm.class_id, cm.user_id, u.display_name, cm.role_in_class,
            cm.status, cm.joined_at, c.organization_id AS class_organization_id
       FROM class_memberships cm
       JOIN users u ON u.id = cm.user_id
       JOIN classes c ON c.id = cm.class_id
      WHERE cm.id = $1`,
    [membershipId],
  );
  const row = rows[0];
  return row ? toMember(row) : null;
}

export const classesRepository: ClassesRepository = {
  async findById(tx, id) {
    const { rows } = await tx.query<ClassRow>(
      `SELECT ${CLASS_COLUMNS} FROM classes WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return Guarded.of(toClass(row), toClassResource(row));
  },

  async list(tx, query) {
    // Both come from exhaustive maps, never from the request.
    const column = resolveSortColumn(CLASS_SORT_COLUMNS, query.sort);
    const direction = resolveSortDirection(query.order);
    const { rows } = await tx.query<ClassRow>(
      `SELECT ${CLASS_COLUMNS} FROM classes
        WHERE ($1::text IS NULL OR status = $1)
        ORDER BY ${column} ${direction}, id ASC
        LIMIT $2 OFFSET $3`,
      [query.status ?? null, query.limit, query.offset],
    );
    return rows.map(toClass);
  },

  async insert(tx, organizationId, name, academicTerm) {
    const { rows } = await tx.query<ClassRow>(
      `INSERT INTO classes (organization_id, name, academic_term)
       VALUES ($1, $2, $3) RETURNING ${CLASS_COLUMNS}`,
      [organizationId, name, academicTerm],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toClass(row);
  },

  async applyUpdate(tx, id, patch) {
    const { rows } = await tx.query<ClassRow>(
      `UPDATE classes
          SET name = COALESCE($2, name),
              academic_term = COALESCE($3, academic_term)
        WHERE id = $1 AND status = 'active'
      RETURNING ${CLASS_COLUMNS}`,
      [id, patch.name ?? null, patch.academicTerm ?? null],
    );
    const row = rows[0];
    return row ? toClass(row) : null;
  },

  async archive(tx, id) {
    // Archiving is the class's end state. It revokes every teacher's derived
    // access to the students in it, which is why it is audited.
    const result = await tx.query(
      `UPDATE classes SET status = 'archived', archived_at = now()
        WHERE id = $1 AND status = 'active'`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  },

  async listMembers(tx, classId) {
    const { rows } = await tx.query<MemberRow>(
      `SELECT cm.id, cm.class_id, cm.user_id, u.display_name, cm.role_in_class,
              cm.status, cm.joined_at, c.organization_id AS class_organization_id
         FROM class_memberships cm
         JOIN users u ON u.id = cm.user_id
         JOIN classes c ON c.id = cm.class_id
        WHERE cm.class_id = $1 AND cm.status = 'active'
        ORDER BY u.display_name ASC, cm.id ASC`,
      [classId],
    );
    return rows.map(toMember);
  },

  async findActiveMembership(tx, classId, userId) {
    // Only ACTIVE rows. Since 0015 a (class, user) pair may have several ended
    // rows — one per spell on the roster — and exactly one active row at most.
    const { rows } = await tx.query<{ id: string; user_id: string; status: 'active' | 'ended' }>(
      `SELECT cm.id, cm.user_id, cm.status
         FROM class_memberships cm
        WHERE cm.class_id = $1 AND cm.user_id = $2 AND cm.status = 'active'`,
      [classId, userId],
    );
    const row = rows[0];
    return row ? { id: row.id, userId: row.user_id, status: row.status } : null;
  },

  async findActiveAssignment(tx, classId, teacherId) {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT ta.id FROM teacher_assignments ta
        WHERE ta.class_id = $1 AND ta.teacher_id = $2 AND ta.status = 'active'`,
      [classId, teacherId],
    );
    return rows[0]?.id ?? null;
  },

  async addMember(tx, classId, userId, roleInClass) {
    // TWO statements, deliberately.
    //
    // A single `WITH inserted AS (INSERT ...) SELECT ... JOIN users` evaluates
    // the join against the snapshot taken when the statement began, so the
    // membership row it just wrote is not yet visible to `users_select`. For a
    // teacher — who may read a student ONLY through an active shared class —
    // the join therefore matched nothing and the insert appeared to fail. A
    // separate statement sees the row it depends on.
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO class_memberships (class_id, user_id, role_in_class)
       VALUES ($1, $2, $3) RETURNING id`,
      [classId, userId, roleInClass],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('Insert returned no row');
    const created = await readMember(tx, id);
    if (!created) {
      // The caller was authorized to enrol this member but cannot read them
      // back. That is a contradiction in the policies, not a client error, so
      // it fails loudly rather than returning a half-built record.
      throw new Error('Enrolled member is not readable by the enroller');
    }
    return created;
  },

  async endMembership(tx, membershipId) {
    // Removal is a status change, never a DELETE: the roster history is part of
    // the audit trail for who could see whose work, and when.
    const result = await tx.query(
      `UPDATE class_memberships SET status = 'ended', ended_at = now()
        WHERE id = $1 AND status = 'active'`,
      [membershipId],
    );
    return (result.rowCount ?? 0) > 0;
  },

  async listTeachers(tx, classId) {
    const { rows } = await tx.query<TeacherRow>(
      `SELECT ta.id, ta.class_id, ta.teacher_id, u.display_name, ta.role_in_class,
              ta.status, ta.created_at, c.organization_id AS class_organization_id
         FROM teacher_assignments ta
         JOIN users u ON u.id = ta.teacher_id
         JOIN classes c ON c.id = ta.class_id
        WHERE ta.class_id = $1 AND ta.status = 'active'
        ORDER BY u.display_name ASC, ta.id ASC`,
      [classId],
    );
    return rows.map(toTeacher);
  },

  async findAssignment(tx, id) {
    const { rows } = await tx.query<TeacherRow>(`${ASSIGNMENT_SELECT} WHERE ta.id = $1`, [id]);
    const row = rows[0];
    if (!row) return null;
    return Guarded.of(toTeacher(row), toAssignmentResource(row));
  },

  async addTeacher(tx, classId, teacherId, roleInClass) {
    // Split for the same reason as `addMember` above: the row a returning join
    // would need is not visible inside the statement that writes it.
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO teacher_assignments (teacher_id, class_id, role_in_class)
       VALUES ($1, $2, $3) RETURNING id`,
      [teacherId, classId, roleInClass],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('Insert returned no row');
    const created = await readAssignment(tx, id);
    if (!created) throw new Error('Assigned teacher is not readable by the assigner');
    return created;
  },

  async endAssignment(tx, assignmentId) {
    const result = await tx.query(
      `UPDATE teacher_assignments SET status = 'ended', ended_at = now()
        WHERE id = $1 AND status = 'active'`,
      [assignmentId],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
