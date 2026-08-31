import { Guarded, type ClassCourseAssignmentResource, type ContentStatus } from '@edu/authz';
import {
  resolveSortColumn,
  resolveSortDirection,
  type AssignmentStatus,
  type ListClassCoursesQuery,
  type ListMyCoursesQuery,
} from '@edu/contracts';
import type { Tx } from '../../platform/db.ts';

/**
 * Persistence for course-to-class assignments.
 *
 * Every row is read together with the two facts the policy needs and cannot
 * derive: the class's organization and the course's. Loading them in the same
 * query as the row is what stops the two gates from disagreeing about tenancy —
 * the database and the policy are looking at the same snapshot.
 *
 * `findById` returns `Guarded<T>`, so a caller physically cannot read an
 * assignment without an allow-decision naming that exact row.
 */

export interface ClassCourseRecord {
  readonly id: string;
  readonly classId: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly courseStatus: ContentStatus;
  readonly status: AssignmentStatus;
  readonly assignedAt: Date;
  readonly startsOn: string | null;
  readonly dueOn: string | null;
  /**
   * The two organizations and the class's state, carried for the AUTHORIZATION
   * decision and not part of any API response — `class-courses.routes.ts` maps
   * every field it returns through `classCourseResponseSchema`, which does not
   * include these.
   *
   * They are on the record rather than re-derived at the call site because a
   * listing has to run the policy over each row, and a policy fed invented
   * inputs is not a second gate. These are the row's own facts, loaded in the
   * same query as the row.
   */
  readonly classOrganizationId: string | null;
  readonly courseOrganizationId: string | null;
  readonly classIsActive: boolean;
}

/** A course a learner reaches through one of their classes. */
export interface EnrolledCourseRecord {
  readonly courseId: string;
  readonly classId: string;
  readonly className: string;
  readonly title: string;
  readonly summary: string;
  readonly levelId: string;
  readonly curriculumId: string;
  readonly assignedAt: Date;
  readonly startsOn: string | null;
  readonly dueOn: string | null;
}

interface AssignmentRow {
  id: string;
  class_id: string;
  course_id: string;
  course_title: string;
  course_status: ContentStatus;
  status: AssignmentStatus;
  assigned_at: Date;
  starts_on: string | null;
  due_on: string | null;
  class_organization_id: string | null;
  course_organization_id: string | null;
  class_is_active: boolean;
}

interface EnrolledRow {
  course_id: string;
  class_id: string;
  class_name: string;
  title: string;
  summary: string;
  level_id: string;
  curriculum_id: string;
  assigned_at: Date;
  starts_on: string | null;
  due_on: string | null;
}

const toRecord = (row: AssignmentRow): ClassCourseRecord => ({
  id: row.id,
  classId: row.class_id,
  courseId: row.course_id,
  courseTitle: row.course_title,
  courseStatus: row.course_status,
  status: row.status,
  assignedAt: row.assigned_at,
  startsOn: row.starts_on,
  dueOn: row.due_on,
  classOrganizationId: row.class_organization_id,
  courseOrganizationId: row.course_organization_id,
  classIsActive: row.class_is_active,
});

const toResource = (row: AssignmentRow): ClassCourseAssignmentResource => ({
  kind: 'class_course_assignment',
  id: row.id,
  classId: row.class_id,
  classOrganizationId: row.class_organization_id,
  courseId: row.course_id,
  courseOrganizationId: row.course_organization_id,
  courseStatus: row.course_status,
  classIsActive: row.class_is_active,
  state: row.status,
});

const toEnrolled = (row: EnrolledRow): EnrolledCourseRecord => ({
  courseId: row.course_id,
  classId: row.class_id,
  className: row.class_name,
  title: row.title,
  summary: row.summary,
  levelId: row.level_id,
  curriculumId: row.curriculum_id,
  assignedAt: row.assigned_at,
  startsOn: row.starts_on,
  dueOn: row.due_on,
});

/**
 * `courses` and `classes` are joined here, and both are RLS-protected.
 *
 * That is deliberate rather than incidental: an assignment naming a course the
 * caller cannot see should not be readable either, and the join enforces that
 * without a second check. The one place it must NOT be relied on is the
 * pre-write existence check, which is why `courseFacts` below asks the definer
 * helpers instead.
 */
const ASSIGNMENT_SELECT = `SELECT a.id, a.class_id, a.course_id, co.title AS course_title,
              co.status AS course_status, a.status, a.assigned_at, a.starts_on, a.due_on,
              cl.organization_id AS class_organization_id,
              co.organization_id AS course_organization_id,
              (cl.status = 'active') AS class_is_active
         FROM class_course_assignments a
         JOIN classes cl ON cl.id = a.class_id
         JOIN courses co ON co.id = a.course_id`;

const ASSIGNMENT_SORT = { assignedAt: 'a.assigned_at', courseTitle: 'co.title' } as const;
const MY_COURSE_SORT = { assignedAt: 'a.assigned_at', title: 'co.title' } as const;

/**
 * A plain read-back, used after a write.
 *
 * Deliberately NOT `findById`: that returns `Guarded<T>`, and unwrapping one
 * here would need a decision the repository has no business holding. Adding an
 * `expose()` escape hatch to `Guarded` would be worse — it would exist forever,
 * for every caller.
 */
async function readAssignment(tx: Tx, id: string): Promise<ClassCourseRecord | null> {
  const { rows } = await tx.query<AssignmentRow>(`${ASSIGNMENT_SELECT} WHERE a.id = $1`, [id]);
  const row = rows[0];
  return row ? toRecord(row) : null;
}

/**
 * What the policy needs to know about a prospective assignment.
 *
 * Answered through the SECURITY DEFINER helpers rather than by selecting from
 * `courses` and `classes`, because the caller may legitimately be unable to SEE
 * a global course they are entitled to assign. Visibility is the policy's
 * question; these are structural facts, and the trigger asks them the same way.
 */
export interface AssignmentFacts {
  readonly classOrganizationId: string | null;
  readonly classIsActive: boolean;
  readonly classExists: boolean;
  readonly courseOrganizationId: string | null;
  readonly courseExists: boolean;
  readonly courseStatus: ContentStatus | null;
}

export interface ClassCoursesRepository {
  facts(tx: Tx, classId: string, courseId: string): Promise<AssignmentFacts>;
  findById(tx: Tx, id: string): Promise<Guarded<ClassCourseRecord> | null>;
  findActive(tx: Tx, classId: string, courseId: string): Promise<Guarded<ClassCourseRecord> | null>;
  listForClass(tx: Tx, classId: string, query: ListClassCoursesQuery): Promise<ClassCourseRecord[]>;
  insert(
    tx: Tx,
    input: {
      classId: string;
      courseId: string;
      assignedBy: string;
      startsOn: string | null;
      dueOn: string | null;
    },
  ): Promise<ClassCourseRecord>;
  withdraw(tx: Tx, id: string): Promise<boolean>;
  listForLearner(
    tx: Tx,
    actorId: string,
    query: ListMyCoursesQuery,
  ): Promise<EnrolledCourseRecord[]>;
}

/** Raised when the pair already has an active assignment. */
export class AlreadyAssignedError extends Error {
  constructor() {
    super('Course is already assigned to this class');
    this.name = 'AlreadyAssignedError';
  }
}

/**
 * Raised when the database refuses the pairing on structural grounds — a course
 * from another school, or one that is not published.
 *
 * The application refuses these first, with its own message. Reaching this
 * means the two gates disagreed, so it is translated rather than swallowed:
 * a silent success would be far worse than a loud conflict.
 */
export class AssignmentNotPermittedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'AssignmentNotPermittedError';
  }
}

function pgCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: string }).code
    : undefined;
}

export const classCoursesRepository: ClassCoursesRepository = {
  async facts(tx, classId, courseId) {
    const { rows } = await tx.query<{
      class_org: string | null;
      class_active: boolean;
      class_exists: boolean;
      course_org: string | null;
      course_global: boolean;
      course_status: ContentStatus | null;
    }>(
      `SELECT app_class_organization_of($1)              AS class_org,
              app_class_is_active($1)                    AS class_active,
              app_class_organization_of($1) IS NOT NULL  AS class_exists,
              app_course_organization($2)                AS course_org,
              app_course_is_global($2)                   AS course_global,
              app_course_status($2)                      AS course_status`,
      [classId, courseId],
    );
    const row = rows[0];
    if (!row) throw new Error('Fact query returned no row');
    return {
      classOrganizationId: row.class_org,
      classIsActive: row.class_active,
      classExists: row.class_exists,
      courseOrganizationId: row.course_org,
      // `app_course_organization` answers NULL for both "global" and "no such
      // course"; the status separates the two without a second existence probe.
      courseExists: row.course_global || row.course_org !== null,
      courseStatus: row.course_status,
    };
  },

  async findById(tx, id) {
    const { rows } = await tx.query<AssignmentRow>(`${ASSIGNMENT_SELECT} WHERE a.id = $1`, [id]);
    const row = rows[0];
    if (!row) return null;
    return Guarded.of(toRecord(row), toResource(row));
  },

  async findActive(tx, classId, courseId) {
    const { rows } = await tx.query<AssignmentRow>(
      `${ASSIGNMENT_SELECT} WHERE a.class_id = $1 AND a.course_id = $2 AND a.status = 'active'`,
      [classId, courseId],
    );
    const row = rows[0];
    if (!row) return null;
    return Guarded.of(toRecord(row), toResource(row));
  },

  async listForClass(tx, classId, query) {
    // Both come from exhaustive maps keyed by the schema's allow-list, never
    // from the request string.
    const column = resolveSortColumn(ASSIGNMENT_SORT, query.sort);
    const direction = resolveSortDirection(query.order);
    const { rows } = await tx.query<AssignmentRow>(
      `${ASSIGNMENT_SELECT}
        WHERE a.class_id = $1 AND ($4::text IS NULL OR a.status = $4)
        ORDER BY ${column} ${direction}, a.id ASC
        LIMIT $2 OFFSET $3`,
      [classId, query.limit, query.offset, query.status ?? null],
    );
    return rows.map(toRecord);
  },

  async insert(tx, input) {
    try {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO class_course_assignments (class_id, course_id, assigned_by, starts_on, due_on)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [input.classId, input.courseId, input.assignedBy, input.startsOn, input.dueOn],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error('Insert returned no row');
      // Read back in a SECOND statement. The ancestry join cannot see a row the
      // same statement is writing — the snapshot predates it. Same reason as
      // VULN-014.
      const created = await readAssignment(tx, id);
      if (!created) throw new Error('Created assignment is not readable by its assigner');
      return created;
    } catch (error) {
      const code = pgCode(error);
      if (code === '23P01') throw new AlreadyAssignedError();
      if (code === '23514' || code === '23505')
        throw new AssignmentNotPermittedError(error instanceof Error ? error.message : 'refused');
      throw error;
    }
  },

  async withdraw(tx, id) {
    // A status change, never a DELETE: which courses a class was taught, and
    // when, is part of the record of what a child was shown.
    const result = await tx.query(
      `UPDATE class_course_assignments SET status = 'inactive', ended_at = now()
        WHERE id = $1 AND status = 'active'`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  },

  async listForLearner(tx, actorId, query) {
    const column = resolveSortColumn(MY_COURSE_SORT, query.sort);
    const direction = resolveSortDirection(query.order);
    // Scoped by MEMBERSHIP, in SQL, in addition to RLS. Every hop is
    // status-checked here as well as in the policy, so a learner's own list
    // cannot outlive their enrolment even if one gate were removed.
    const { rows } = await tx.query<EnrolledRow>(
      `SELECT a.course_id, a.class_id, cl.name AS class_name,
              co.title, co.summary, co.level_id, co.curriculum_id,
              a.assigned_at, a.starts_on, a.due_on
         FROM class_course_assignments a
         JOIN classes cl           ON cl.id = a.class_id
         JOIN class_memberships cm ON cm.class_id = a.class_id
         JOIN courses co           ON co.id = a.course_id
        WHERE cm.user_id = $1
          AND a.status  = 'active'
          AND cl.status = 'active'
          AND cm.status = 'active'
          AND co.status = 'published'
        ORDER BY ${column} ${direction}, a.course_id ASC
        LIMIT $2 OFFSET $3`,
      [actorId, query.limit, query.offset],
    );
    return rows.map(toEnrolled);
  },
};
