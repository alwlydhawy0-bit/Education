import {
  Guarded,
  type ContentStatus,
  type CourseResource,
  type CourseUnitResource,
  type CurriculumResource,
  type LessonResource,
} from '@edu/authz';
import {
  resolveSortColumn,
  resolveSortDirection,
  type ListCoursesQuery,
  type ListCurriculaQuery,
  type ListChildrenQuery,
} from '@edu/contracts';
import type { Tx } from '../../platform/db.ts';

/**
 * Persistence for the educational content tree.
 *
 * Two rules run through the whole file.
 *
 * **Every by-id loader returns `Guarded<T>`.** Fetching a lesson does not
 * produce something readable; it produces something that needs a matching
 * allow-decision. That is the structural half of the IDOR defence.
 *
 * **Every resource carries `ancestorsPublished`, computed in SQL.** A unit
 * inside a draft course is not visible to a learner however published the unit
 * itself is, and the policy cannot walk the tree (it is pure). Answering it here
 * — in the same query that loads the row — means the two can never disagree.
 */

export interface CurriculumRecord {
  readonly id: string;
  readonly organizationId: string | null;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly status: ContentStatus;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
}

export interface CourseRecord {
  readonly id: string;
  readonly organizationId: string | null;
  readonly curriculumId: string;
  readonly levelId: string;
  readonly title: string;
  readonly summary: string;
  readonly status: ContentStatus;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
}

export interface UnitRecord {
  readonly id: string;
  readonly courseId: string;
  readonly position: number;
  readonly title: string;
  readonly summary: string;
  readonly status: ContentStatus;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
}

export interface LessonRecord {
  readonly id: string;
  readonly unitId: string;
  readonly position: number;
  readonly title: string;
  readonly summary: string;
  readonly contentFormat: 'markdown' | 'plain';
  readonly contentBody: string;
  readonly externalUrl: string | null;
  readonly estimatedMinutes: number | null;
  readonly objectives: readonly string[];
  readonly status: ContentStatus;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
}

export interface EducationLevelRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly stage: 'primary' | 'middle' | 'secondary' | 'university';
  readonly grade: number | null;
  readonly sortOrder: number;
}

interface CurriculumRow {
  id: string;
  organization_id: string | null;
  code: string;
  name: string;
  description: string;
  status: ContentStatus;
  created_at: Date;
  published_at: Date | null;
}

interface CourseRow extends Omit<CurriculumRow, 'code' | 'name' | 'description'> {
  curriculum_id: string;
  level_id: string;
  title: string;
  summary: string;
}

interface UnitRow {
  id: string;
  course_id: string;
  position: number;
  title: string;
  summary: string;
  status: ContentStatus;
  created_at: Date;
  published_at: Date | null;
  course_organization_id: string | null;
  course_status: ContentStatus;
}

interface LessonRow {
  id: string;
  unit_id: string;
  position: number;
  title: string;
  summary: string;
  content_format: 'markdown' | 'plain';
  content_body: string;
  external_url: string | null;
  estimated_minutes: number | null;
  objectives: string[];
  status: ContentStatus;
  created_at: Date;
  published_at: Date | null;
  course_id: string;
  course_organization_id: string | null;
  ancestors_published: boolean;
}

interface LevelRow {
  id: string;
  code: string;
  name: string;
  stage: EducationLevelRecord['stage'];
  grade: number | null;
  sort_order: number;
}

const toCurriculum = (row: CurriculumRow): CurriculumRecord => ({
  id: row.id,
  organizationId: row.organization_id,
  code: row.code,
  name: row.name,
  description: row.description,
  status: row.status,
  createdAt: row.created_at,
  publishedAt: row.published_at,
});

const toCurriculumResource = (row: CurriculumRow): CurriculumResource => ({
  kind: 'curriculum',
  id: row.id,
  organizationId: row.organization_id,
  status: row.status,
  // A curriculum is a root: it has no content ancestor to be gated behind.
  ancestorsPublished: true,
});

const toCourse = (row: CourseRow): CourseRecord => ({
  id: row.id,
  organizationId: row.organization_id,
  curriculumId: row.curriculum_id,
  levelId: row.level_id,
  title: row.title,
  summary: row.summary,
  status: row.status,
  createdAt: row.created_at,
  publishedAt: row.published_at,
});

const toCourseResource = (row: CourseRow): CourseResource => ({
  kind: 'course',
  id: row.id,
  organizationId: row.organization_id,
  curriculumId: row.curriculum_id,
  levelId: row.level_id,
  status: row.status,
  ancestorsPublished: true,
});

const toUnit = (row: UnitRow): UnitRecord => ({
  id: row.id,
  courseId: row.course_id,
  position: row.position,
  title: row.title,
  summary: row.summary,
  status: row.status,
  createdAt: row.created_at,
  publishedAt: row.published_at,
});

const toUnitResource = (row: UnitRow): CourseUnitResource => ({
  kind: 'course_unit',
  id: row.id,
  courseId: row.course_id,
  organizationId: row.course_organization_id,
  status: row.status,
  ancestorsPublished: row.course_status === 'published',
});

const toLesson = (row: LessonRow): LessonRecord => ({
  id: row.id,
  unitId: row.unit_id,
  position: row.position,
  title: row.title,
  summary: row.summary,
  contentFormat: row.content_format,
  contentBody: row.content_body,
  externalUrl: row.external_url,
  estimatedMinutes: row.estimated_minutes,
  objectives: row.objectives,
  status: row.status,
  createdAt: row.created_at,
  publishedAt: row.published_at,
});

const toLessonResource = (row: LessonRow): LessonResource => ({
  kind: 'lesson',
  id: row.id,
  unitId: row.unit_id,
  courseId: row.course_id,
  organizationId: row.course_organization_id,
  status: row.status,
  ancestorsPublished: row.ancestors_published,
});

const toLevel = (row: LevelRow): EducationLevelRecord => ({
  id: row.id,
  code: row.code,
  name: row.name,
  stage: row.stage,
  grade: row.grade,
  sortOrder: row.sort_order,
});

const CURRICULUM_COLUMNS =
  'id, organization_id, code, name, description, status, created_at, published_at';
const COURSE_COLUMNS =
  'id, organization_id, curriculum_id, level_id, title, summary, status, created_at, published_at';

/**
 * Units and lessons are always read WITH their ancestry.
 *
 * The join is to the same domain's own tables, so it crosses no module
 * boundary, and it is what makes `ancestorsPublished` a property of the row
 * rather than something a caller might forget to look up.
 */
const UNIT_SELECT = `SELECT u.id, u.course_id, u.position, u.title, u.summary, u.status,
              u.created_at, u.published_at,
              c.organization_id AS course_organization_id, c.status AS course_status
         FROM course_units u
         JOIN courses c ON c.id = u.course_id`;

const LESSON_SELECT = `SELECT l.id, l.unit_id, l.position, l.title, l.summary, l.content_format,
              l.content_body, l.external_url, l.estimated_minutes,
              -- Derived from learning_objectives (0021), which replaced the
              -- array column. The response shape is unchanged for every reader;
              -- what changed underneath is that each statement now has a stable
              -- id that a learner's evidence can point at.
              COALESCE(
                (SELECT array_agg(o.statement ORDER BY o.position)
                   FROM learning_objectives o WHERE o.lesson_id = l.id),
                '{}'::text[]
              ) AS objectives,
              l.status, l.created_at, l.published_at,
              c.id AS course_id, c.organization_id AS course_organization_id,
              (u.status = 'published' AND c.status = 'published') AS ancestors_published
         FROM lessons l
         JOIN course_units u ON u.id = l.unit_id
         JOIN courses c ON c.id = u.course_id`;

/**
 * Plain read-backs, used after a write.
 *
 * Deliberately NOT `findUnit`/`findLesson`: those return `Guarded<T>`, and
 * unwrapping one here would need a decision the repository has no business
 * holding. Adding an `expose()` escape hatch to `Guarded` would be worse still —
 * it would exist forever, for every caller. Two small private readers cost less
 * than one hole in the control.
 */
async function insertLevelRow(
  tx: Tx,
  input: {
    code: string;
    name: string;
    stage: EducationLevelRecord['stage'];
    grade: number | null;
    sortOrder: number;
  },
): Promise<EducationLevelRecord> {
  const { rows } = await tx.query<LevelRow>(
    `INSERT INTO education_levels (code, name, stage, grade, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, code, name, stage, grade, sort_order`,
    [input.code, input.name, input.stage, input.grade, input.sortOrder],
  );
  const row = rows[0];
  if (!row) throw new Error('Insert returned no row');
  return toLevel(row);
}

async function readUnit(tx: Tx, id: string): Promise<UnitRecord | null> {
  const { rows } = await tx.query<UnitRow>(`${UNIT_SELECT} WHERE u.id = $1`, [id]);
  const row = rows[0];
  return row ? toUnit(row) : null;
}

/**
 * Rewrites a lesson's objectives to exactly the statements supplied.
 *
 * DELETE-THEN-INSERT, and the consequence is stated rather than hidden: an
 * objective removed from the list loses its identity, and with it any evidence
 * that pointed at it. That is safe only because 0021 confines the DELETE policy
 * to DRAFT lessons — once a lesson is published, the delete matches zero rows
 * and a rewrite that dropped a statement is refused by the database rather than
 * silently erasing a child's record.
 *
 * Rewording is therefore the safe operation and reordering is not, which is the
 * honest shape of a text-list authoring surface promoted to entities. A future
 * task that lets an author edit objectives individually should carry their ids.
 */
async function replaceObjectives(
  tx: Tx,
  lessonId: string,
  statements: readonly string[],
): Promise<void> {
  await tx.query(`DELETE FROM learning_objectives WHERE lesson_id = $1`, [lessonId]);
  if (statements.length === 0) return;
  await tx.query(
    `INSERT INTO learning_objectives (lesson_id, position, statement)
     SELECT $1, ord, statement
       FROM unnest($2::text[]) WITH ORDINALITY AS t(statement, ord)`,
    [lessonId, [...statements]],
  );
}

async function readLesson(tx: Tx, id: string): Promise<LessonRecord | null> {
  const { rows } = await tx.query<LessonRow>(`${LESSON_SELECT} WHERE l.id = $1`, [id]);
  const row = rows[0];
  return row ? toLesson(row) : null;
}

/**
 * Raised when a delete is refused because something still references the row.
 *
 * `courses.curriculum_id` is ON DELETE RESTRICT: emptying a catalog entry from
 * under the courses taught in it would leave the tree inconsistent. Translated
 * here so the service can answer 409 rather than letting a raw driver error
 * become a 500 — a state the caller can fix is not an internal error.
 */
export class ContentInUseError extends Error {
  constructor() {
    super('Content is still referenced');
    this.name = 'ContentInUseError';
  }
}

/**
 * Raised when a code is already taken in the same catalog.
 *
 * `curricula_code_uk` is unique per (organization, code) — with the global
 * catalog keyed by a sentinel — so two schools may both define `math`, and one
 * school may not define it twice. Translated so the caller gets 409 and can fix
 * it, rather than a 500 that says only "something went wrong".
 */
export class DuplicateCodeError extends Error {
  constructor() {
    super('Code already used in this catalog');
    this.name = 'DuplicateCodeError';
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23503'
  );
}

const CURRICULUM_SORT = { createdAt: 'created_at', name: 'name', code: 'code' } as const;
const COURSE_SORT = { createdAt: 'created_at', title: 'title' } as const;
const CHILD_SORT = { position: 'position' } as const;

export interface CurriculumRepository {
  listLevels(tx: Tx): Promise<EducationLevelRecord[]>;
  findLevel(tx: Tx, id: string): Promise<EducationLevelRecord | null>;
  insertLevel(
    tx: Tx,
    input: {
      code: string;
      name: string;
      stage: EducationLevelRecord['stage'];
      grade: number | null;
      sortOrder: number;
    },
  ): Promise<EducationLevelRecord>;
  updateLevel(
    tx: Tx,
    id: string,
    patch: { name?: string; sortOrder?: number },
  ): Promise<EducationLevelRecord | null>;

  findCurriculum(tx: Tx, id: string): Promise<Guarded<CurriculumRecord> | null>;
  listCurricula(
    tx: Tx,
    query: ListCurriculaQuery,
    actorOrganizationId: string | null,
  ): Promise<CurriculumRecord[]>;
  insertCurriculum(
    tx: Tx,
    input: {
      organizationId: string | null;
      code: string;
      name: string;
      description: string;
      createdBy: string;
    },
  ): Promise<CurriculumRecord>;
  updateCurriculum(
    tx: Tx,
    id: string,
    patch: { name?: string; description?: string },
  ): Promise<CurriculumRecord | null>;
  setCurriculumStatus(tx: Tx, id: string, status: ContentStatus): Promise<CurriculumRecord | null>;
  deleteCurriculum(tx: Tx, id: string): Promise<boolean>;

  findCourse(tx: Tx, id: string): Promise<Guarded<CourseRecord> | null>;
  listCourses(
    tx: Tx,
    query: ListCoursesQuery,
    actorOrganizationId: string | null,
  ): Promise<CourseRecord[]>;
  insertCourse(
    tx: Tx,
    input: {
      organizationId: string | null;
      curriculumId: string;
      levelId: string;
      title: string;
      summary: string;
      createdBy: string;
    },
  ): Promise<CourseRecord>;
  updateCourse(
    tx: Tx,
    id: string,
    patch: { title?: string; summary?: string; curriculumId?: string; levelId?: string },
  ): Promise<CourseRecord | null>;
  setCourseStatus(tx: Tx, id: string, status: ContentStatus): Promise<CourseRecord | null>;
  deleteCourse(tx: Tx, id: string): Promise<boolean>;

  findUnit(tx: Tx, id: string): Promise<Guarded<UnitRecord> | null>;
  listUnits(tx: Tx, courseId: string, query: ListChildrenQuery): Promise<UnitRecord[]>;
  insertUnit(
    tx: Tx,
    input: { courseId: string; title: string; summary: string; createdBy: string },
  ): Promise<UnitRecord>;
  updateUnit(
    tx: Tx,
    id: string,
    patch: { title?: string; summary?: string },
  ): Promise<UnitRecord | null>;
  setUnitStatus(tx: Tx, id: string, status: ContentStatus): Promise<UnitRecord | null>;
  deleteUnit(tx: Tx, id: string): Promise<boolean>;
  unitIdsInOrder(tx: Tx, courseId: string): Promise<string[]>;
  applyUnitOrder(tx: Tx, courseId: string, orderedIds: readonly string[]): Promise<void>;

  findLesson(tx: Tx, id: string): Promise<Guarded<LessonRecord> | null>;
  listLessons(tx: Tx, unitId: string, query: ListChildrenQuery): Promise<LessonRecord[]>;
  insertLesson(
    tx: Tx,
    input: {
      unitId: string;
      title: string;
      summary: string;
      contentFormat: 'markdown' | 'plain';
      contentBody: string;
      externalUrl: string | null;
      estimatedMinutes: number | null;
      objectives: readonly string[];
      createdBy: string;
    },
  ): Promise<LessonRecord>;
  updateLesson(
    tx: Tx,
    id: string,
    patch: Partial<{
      title: string;
      summary: string;
      contentFormat: 'markdown' | 'plain';
      contentBody: string;
      externalUrl: string | null;
      estimatedMinutes: number | null;
      objectives: readonly string[];
    }>,
  ): Promise<LessonRecord | null>;
  setLessonStatus(tx: Tx, id: string, status: ContentStatus): Promise<LessonRecord | null>;
  deleteLesson(tx: Tx, id: string): Promise<boolean>;
  lessonIdsInOrder(tx: Tx, unitId: string): Promise<string[]>;
  applyLessonOrder(tx: Tx, unitId: string, orderedIds: readonly string[]): Promise<void>;
}

/**
 * Timestamps for a lifecycle move, derived from the target status alone.
 *
 * Kept in one place because the CHECK constraints tie `published_at` and
 * `archived_at` to `status` exactly; setting one without the other is a
 * constraint violation rather than a silently wrong row, but only if every call
 * site agrees on the mapping.
 */
const statusTimestamps = (status: ContentStatus): string =>
  status === 'published'
    ? `status = 'published', published_at = now(), archived_at = NULL`
    : status === 'archived'
      ? `status = 'archived', archived_at = now()`
      : `status = 'draft', published_at = NULL, archived_at = NULL`;

export const curriculumRepository: CurriculumRepository = {
  // --- Education levels -------------------------------------------------
  async listLevels(tx) {
    const { rows } = await tx.query<LevelRow>(
      `SELECT id, code, name, stage, grade, sort_order FROM education_levels
        ORDER BY sort_order ASC, code ASC`,
    );
    return rows.map(toLevel);
  },

  async findLevel(tx, id) {
    const { rows } = await tx.query<LevelRow>(
      `SELECT id, code, name, stage, grade, sort_order FROM education_levels WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? toLevel(row) : null;
  },

  async insertLevel(tx, input) {
    try {
      return await insertLevelRow(tx, input);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateCodeError();
      throw error;
    }
  },

  async updateLevel(tx, id, patch) {
    const { rows } = await tx.query<LevelRow>(
      `UPDATE education_levels
          SET name = COALESCE($2, name), sort_order = COALESCE($3, sort_order)
        WHERE id = $1
      RETURNING id, code, name, stage, grade, sort_order`,
      [id, patch.name ?? null, patch.sortOrder ?? null],
    );
    const row = rows[0];
    return row ? toLevel(row) : null;
  },

  // --- Curricula --------------------------------------------------------
  async findCurriculum(tx, id) {
    const { rows } = await tx.query<CurriculumRow>(
      `SELECT ${CURRICULUM_COLUMNS} FROM curricula WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return Guarded.of(toCurriculum(row), toCurriculumResource(row));
  },

  async listCurricula(tx, query, actorOrganizationId) {
    // Both come from exhaustive maps keyed by the schema's allow-list, never
    // from the request string.
    const column = resolveSortColumn(CURRICULUM_SORT, query.sort);
    const direction = resolveSortDirection(query.order);
    const { rows } = await tx.query<CurriculumRow>(
      `SELECT ${CURRICULUM_COLUMNS} FROM curricula
        WHERE ($3::text IS NULL OR status = $3)
          AND ($4::text IS NULL
               OR ($4 = 'global' AND organization_id IS NULL)
               OR ($4 = 'organization' AND organization_id IS NOT NULL AND organization_id = $5))
        ORDER BY ${column} ${direction}, id ASC
        LIMIT $1 OFFSET $2`,
      [query.limit, query.offset, query.status ?? null, query.scope ?? null, actorOrganizationId],
    );
    return rows.map(toCurriculum);
  },

  async insertCurriculum(tx, input) {
    try {
      const { rows } = await tx.query<CurriculumRow>(
        `INSERT INTO curricula (organization_id, code, name, description, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${CURRICULUM_COLUMNS}`,
        [input.organizationId, input.code, input.name, input.description, input.createdBy],
      );
      const row = rows[0];
      if (!row) throw new Error('Insert returned no row');
      return toCurriculum(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateCodeError();
      throw error;
    }
  },

  async updateCurriculum(tx, id, patch) {
    const { rows } = await tx.query<CurriculumRow>(
      `UPDATE curricula
          SET name = COALESCE($2, name), description = COALESCE($3, description),
              updated_at = now()
        WHERE id = $1
      RETURNING ${CURRICULUM_COLUMNS}`,
      [id, patch.name ?? null, patch.description ?? null],
    );
    const row = rows[0];
    return row ? toCurriculum(row) : null;
  },

  async setCurriculumStatus(tx, id, status) {
    const { rows } = await tx.query<CurriculumRow>(
      `UPDATE curricula SET ${statusTimestamps(status)}, updated_at = now()
        WHERE id = $1 RETURNING ${CURRICULUM_COLUMNS}`,
      [id],
    );
    const row = rows[0];
    return row ? toCurriculum(row) : null;
  },

  async deleteCurriculum(tx, id) {
    try {
      const result = await tx.query(`DELETE FROM curricula WHERE id = $1`, [id]);
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      if (isForeignKeyViolation(error)) throw new ContentInUseError();
      throw error;
    }
  },

  // --- Courses ----------------------------------------------------------
  async findCourse(tx, id) {
    const { rows } = await tx.query<CourseRow>(
      `SELECT ${COURSE_COLUMNS} FROM courses WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return Guarded.of(toCourse(row), toCourseResource(row));
  },

  async listCourses(tx, query, actorOrganizationId) {
    const column = resolveSortColumn(COURSE_SORT, query.sort);
    const direction = resolveSortDirection(query.order);
    const { rows } = await tx.query<CourseRow>(
      `SELECT ${COURSE_COLUMNS} FROM courses
        WHERE ($3::text IS NULL OR status = $3)
          AND ($4::text IS NULL
               OR ($4 = 'global' AND organization_id IS NULL)
               OR ($4 = 'organization' AND organization_id IS NOT NULL AND organization_id = $5))
          AND ($6::uuid IS NULL OR level_id = $6)
          AND ($7::uuid IS NULL OR curriculum_id = $7)
        ORDER BY ${column} ${direction}, id ASC
        LIMIT $1 OFFSET $2`,
      [
        query.limit,
        query.offset,
        query.status ?? null,
        query.scope ?? null,
        actorOrganizationId,
        query.levelId ?? null,
        query.curriculumId ?? null,
      ],
    );
    return rows.map(toCourse);
  },

  async insertCourse(tx, input) {
    const { rows } = await tx.query<CourseRow>(
      `INSERT INTO courses (organization_id, curriculum_id, level_id, title, summary, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COURSE_COLUMNS}`,
      [
        input.organizationId,
        input.curriculumId,
        input.levelId,
        input.title,
        input.summary,
        input.createdBy,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toCourse(row);
  },

  async updateCourse(tx, id, patch) {
    const { rows } = await tx.query<CourseRow>(
      `UPDATE courses
          SET title = COALESCE($2, title), summary = COALESCE($3, summary),
              curriculum_id = COALESCE($4, curriculum_id),
              level_id = COALESCE($5, level_id),
              updated_at = now()
        WHERE id = $1
      RETURNING ${COURSE_COLUMNS}`,
      [
        id,
        patch.title ?? null,
        patch.summary ?? null,
        patch.curriculumId ?? null,
        patch.levelId ?? null,
      ],
    );
    const row = rows[0];
    return row ? toCourse(row) : null;
  },

  async setCourseStatus(tx, id, status) {
    const { rows } = await tx.query<CourseRow>(
      `UPDATE courses SET ${statusTimestamps(status)}, updated_at = now()
        WHERE id = $1 RETURNING ${COURSE_COLUMNS}`,
      [id],
    );
    const row = rows[0];
    return row ? toCourse(row) : null;
  },

  async deleteCourse(tx, id) {
    const result = await tx.query(`DELETE FROM courses WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  },

  // --- Units ------------------------------------------------------------
  async findUnit(tx, id) {
    const { rows } = await tx.query<UnitRow>(`${UNIT_SELECT} WHERE u.id = $1`, [id]);
    const row = rows[0];
    if (!row) return null;
    return Guarded.of(toUnit(row), toUnitResource(row));
  },

  async listUnits(tx, courseId, query) {
    const column = resolveSortColumn(CHILD_SORT, query.sort);
    const direction = resolveSortDirection(query.order);
    const { rows } = await tx.query<UnitRow>(
      `${UNIT_SELECT}
        WHERE u.course_id = $1 AND ($4::text IS NULL OR u.status = $4)
        ORDER BY u.${column} ${direction}, u.id ASC
        LIMIT $2 OFFSET $3`,
      [courseId, query.limit, query.offset, query.status ?? null],
    );
    return rows.map(toUnit);
  },

  async insertUnit(tx, input) {
    // The position is chosen by the SERVER — the next free slot — never by the
    // request. A client-supplied position is either a collision or a silent
    // reshuffle of somebody else's ordering; reordering has its own endpoint.
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO course_units (course_id, position, title, summary, created_by)
       VALUES ($1,
               (SELECT COALESCE(MAX(position), 0) + 1 FROM course_units WHERE course_id = $1),
               $2, $3, $4)
       RETURNING id`,
      [input.courseId, input.title, input.summary, input.createdBy],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('Insert returned no row');
    // Read back in a second statement: the ancestry join cannot see a row the
    // same statement is writing (the snapshot predates it). Same reason as
    // VULN-014.
    const created = await readUnit(tx, id);
    if (!created) throw new Error('Created unit is not readable by its author');
    return created;
  },

  async updateUnit(tx, id, patch) {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE course_units
          SET title = COALESCE($2, title), summary = COALESCE($3, summary), updated_at = now()
        WHERE id = $1 RETURNING id`,
      [id, patch.title ?? null, patch.summary ?? null],
    );
    if (!rows[0]) return null;
    return readUnit(tx, id);
  },

  async setUnitStatus(tx, id, status) {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE course_units SET ${statusTimestamps(status)}, updated_at = now()
        WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!rows[0]) return null;
    return readUnit(tx, id);
  },

  async deleteUnit(tx, id) {
    const result = await tx.query(`DELETE FROM course_units WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  },

  async unitIdsInOrder(tx, courseId) {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM course_units WHERE course_id = $1 ORDER BY position ASC`,
      [courseId],
    );
    return rows.map((r) => r.id);
  },

  async applyUnitOrder(tx, courseId, orderedIds) {
    // Deferring the unique constraint lets the whole sequence be rewritten in
    // one statement. Without it, any reorder that is not a rotation collides
    // mid-way — position 2 is briefly occupied twice — and fails.
    await tx.query('SET CONSTRAINTS course_units_position_uk DEFERRED');
    await tx.query(
      `UPDATE course_units AS u
          SET position = o.ordinality, updated_at = now()
         FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, ordinality)
        WHERE u.id = o.id AND u.course_id = $1`,
      [courseId, [...orderedIds]],
    );
  },

  // --- Lessons ----------------------------------------------------------
  async findLesson(tx, id) {
    const { rows } = await tx.query<LessonRow>(`${LESSON_SELECT} WHERE l.id = $1`, [id]);
    const row = rows[0];
    if (!row) return null;
    return Guarded.of(toLesson(row), toLessonResource(row));
  },

  async listLessons(tx, unitId, query) {
    const column = resolveSortColumn(CHILD_SORT, query.sort);
    const direction = resolveSortDirection(query.order);
    const { rows } = await tx.query<LessonRow>(
      `${LESSON_SELECT}
        WHERE l.unit_id = $1 AND ($4::text IS NULL OR l.status = $4)
        ORDER BY l.${column} ${direction}, l.id ASC
        LIMIT $2 OFFSET $3`,
      [unitId, query.limit, query.offset, query.status ?? null],
    );
    return rows.map(toLesson);
  },

  async insertLesson(tx, input) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO lessons (unit_id, position, title, summary, content_format, content_body,
                            external_url, estimated_minutes, created_by)
       VALUES ($1,
               (SELECT COALESCE(MAX(position), 0) + 1 FROM lessons WHERE unit_id = $1),
               $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        input.unitId,
        input.title,
        input.summary,
        input.contentFormat,
        input.contentBody,
        input.externalUrl,
        input.estimatedMinutes,
        input.createdBy,
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('Insert returned no row');
    await replaceObjectives(tx, id, input.objectives);
    const created = await readLesson(tx, id);
    if (!created) throw new Error('Created lesson is not readable by its author');
    return created;
  },

  async updateLesson(tx, id, patch) {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE lessons
          SET title = COALESCE($2, title),
              summary = COALESCE($3, summary),
              content_format = COALESCE($4, content_format),
              content_body = COALESCE($5, content_body),
              -- externalUrl and estimatedMinutes are NULLABLE, so COALESCE
              -- cannot express "set it to null" -- it would read the null as
              -- "leave unchanged". The boolean flags say whether the field was
              -- present in the request at all, which is the real question.
              external_url = CASE WHEN $6 THEN $7 ELSE external_url END,
              estimated_minutes = CASE WHEN $8 THEN $9 ELSE estimated_minutes END,
              updated_at = now()
        WHERE id = $1 RETURNING id`,
      [
        id,
        patch.title ?? null,
        patch.summary ?? null,
        patch.contentFormat ?? null,
        patch.contentBody ?? null,
        'externalUrl' in patch,
        patch.externalUrl ?? null,
        'estimatedMinutes' in patch,
        patch.estimatedMinutes ?? null,
      ],
    );
    if (!rows[0]) return null;
    // Only when the field was supplied. An omitted `objectives` leaves the rows
    // alone, matching the COALESCE the array column used to rely on.
    if (patch.objectives) await replaceObjectives(tx, id, patch.objectives);
    return readLesson(tx, id);
  },

  async setLessonStatus(tx, id, status) {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE lessons SET ${statusTimestamps(status)}, updated_at = now()
        WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!rows[0]) return null;
    return readLesson(tx, id);
  },

  async deleteLesson(tx, id) {
    const result = await tx.query(`DELETE FROM lessons WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  },

  async lessonIdsInOrder(tx, unitId) {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM lessons WHERE unit_id = $1 ORDER BY position ASC`,
      [unitId],
    );
    return rows.map((r) => r.id);
  },

  async applyLessonOrder(tx, unitId, orderedIds) {
    await tx.query('SET CONSTRAINTS lessons_position_uk DEFERRED');
    await tx.query(
      `UPDATE lessons AS l
          SET position = o.ordinality, updated_at = now()
         FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, ordinality)
        WHERE l.id = o.id AND l.unit_id = $1`,
      [unitId, [...orderedIds]],
    );
  },
};
