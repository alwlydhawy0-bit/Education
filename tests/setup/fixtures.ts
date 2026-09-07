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
    `TRUNCATE curriculum_embeddings,
              student_artifacts, notes, student_notebooks,
              objective_evidence, learning_objectives,
              assessment_attempt_answers, assessment_attempts,
              assessment_answer_keys, assessment_options, assessment_questions,
              assessments,
              experiment_artifacts, experiment_sessions,
              experiment_validation_rules, experiments,
              learning_activities,
              lesson_progress, guardian_relationships, teacher_assignments,
              class_course_assignments, class_memberships,
              classes, lessons, course_units, courses, curricula, education_levels,
              sessions, user_roles, email_verifications, password_reset_tokens,
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

// ---------------------------------------------------------------------
// Educational content
// ---------------------------------------------------------------------
// These seed rows AS SUPERUSER, which is the point: they can construct states
// the application role could never reach — a published course, content in
// another school — so that a negative test is testing the boundary rather than
// the seeding path.

export async function createEducationLevel(
  code = 'grade_7',
  options: {
    name?: string;
    stage?: 'primary' | 'middle' | 'secondary' | 'university';
    grade?: number | null;
    sortOrder?: number;
  } = {},
): Promise<string> {
  const db = await seedDb();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO education_levels (code, name, stage, grade, sort_order)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      code,
      options.name ?? 'Grade 7',
      options.stage ?? 'middle',
      options.grade ?? 7,
      options.sortOrder ?? 0,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Failed to seed education level');
  return id;
}

type ContentStatus = 'draft' | 'published' | 'archived';

/** The lifecycle timestamps a status implies, matching the CHECK constraints. */
function lifecycleStamps(status: ContentStatus): [Date | null, Date | null] {
  if (status === 'published') return [new Date(), null];
  if (status === 'archived') return [null, new Date()];
  return [null, null];
}

export async function createCurriculum(options: {
  organizationId: string | null;
  code?: string;
  name?: string;
  status?: ContentStatus;
  createdBy?: string | null;
}): Promise<string> {
  const db = await seedDb();
  const status = options.status ?? 'draft';
  const [publishedAt, archivedAt] = lifecycleStamps(status);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO curricula (organization_id, code, name, status, published_at, archived_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      options.organizationId,
      options.code ?? 'math',
      options.name ?? 'Mathematics',
      status,
      publishedAt,
      archivedAt,
      options.createdBy ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Failed to seed curriculum');
  return id;
}

export async function createCourse(options: {
  organizationId: string | null;
  curriculumId: string;
  levelId: string;
  title?: string;
  status?: ContentStatus;
  createdBy?: string | null;
}): Promise<string> {
  const db = await seedDb();
  const status = options.status ?? 'draft';
  const [publishedAt, archivedAt] = lifecycleStamps(status);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO courses (organization_id, curriculum_id, level_id, title, status,
                          published_at, archived_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      options.organizationId,
      options.curriculumId,
      options.levelId,
      options.title ?? 'Algebra',
      status,
      publishedAt,
      archivedAt,
      options.createdBy ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Failed to seed course');
  return id;
}

export async function createUnit(options: {
  courseId: string;
  position?: number;
  title?: string;
  status?: ContentStatus;
  createdBy?: string | null;
}): Promise<string> {
  const db = await seedDb();
  const status = options.status ?? 'draft';
  const [publishedAt, archivedAt] = lifecycleStamps(status);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO course_units (course_id, position, title, status, published_at, archived_at, created_by)
     VALUES ($1,
             COALESCE($2, (SELECT COALESCE(MAX(position), 0) + 1 FROM course_units WHERE course_id = $1)),
             $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      options.courseId,
      options.position ?? null,
      options.title ?? 'Unit',
      status,
      publishedAt,
      archivedAt,
      options.createdBy ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Failed to seed unit');
  return id;
}

export async function createLesson(options: {
  unitId: string;
  position?: number;
  title?: string;
  contentBody?: string;
  status?: ContentStatus;
  createdBy?: string | null;
  /**
   * Objective statements, seeded as rows in `learning_objectives` (0021).
   *
   * They were an array column on the lesson until 0021 promoted them, which is
   * why this reads like a lesson field and writes to a different table.
   */
  objectives?: readonly string[];
}): Promise<string> {
  const db = await seedDb();
  const status = options.status ?? 'draft';
  const [publishedAt, archivedAt] = lifecycleStamps(status);

  // TWO SEEDING ORDERS, and which one runs is decided by whether objectives were
  // asked for. Both are deliberate; neither is a workaround.
  //
  // WITH OBJECTIVES — born a draft, objectives written, then stamped. 0022
  // freezes a published lesson's objectives, so seeding them onto a row that was
  // inserted as `published` is refused exactly as it would be for a real author.
  // This is the authoring order the product actually has, and it requires the
  // ancestors to be published too, because 0022 refuses to publish beneath a
  // draft parent. A test that asks for the impossible combination fails loudly
  // here, which is the right answer.
  //
  // WITHOUT OBJECTIVES — inserted directly at the requested status. The tree
  // consistency trigger fires BEFORE UPDATE, not BEFORE INSERT, so this can
  // construct a published lesson under a draft unit. That state is one the
  // product now refuses to CREATE — and it is precisely the state the RLS and
  // layered-defence suites must still be tested against, for two reasons: a
  // database upgraded from before 0022 can already contain such rows
  // (grandfathered, see docs/api/curriculum.md), and RLS's job is to hide an
  // unpublished chain WITHOUT relying on a trigger having prevented it. A
  // control that is only correct because another control held is not a second
  // layer.
  const bornStatus = options.objectives && options.objectives.length > 0 ? 'draft' : status;
  const [bornPublishedAt, bornArchivedAt] = lifecycleStamps(bornStatus);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO lessons (unit_id, position, title, content_body, status, created_by,
                          published_at, archived_at)
     VALUES ($1,
             COALESCE($2, (SELECT COALESCE(MAX(position), 0) + 1 FROM lessons WHERE unit_id = $1)),
             $3, $4, $6, $5, $7, $8)
     RETURNING id`,
    [
      options.unitId,
      options.position ?? null,
      options.title ?? 'Lesson',
      // A PUBLISHED lesson gets a body it did not ask for. 0022 refuses to
      // publish a lesson with neither content nor an external link, and that
      // rule is right: an empty lesson shown to a child is a bug. A fixture
      // that seeded one would be modelling a state the product cannot reach,
      // so callers that only care about VISIBILITY get default content rather
      // than a special case in the trigger.
      //
      // A DRAFT keeps the empty default, because an empty draft is ordinary —
      // it is what every lesson looks like the moment it is created.
      options.contentBody ?? (status === 'published' ? 'Seeded lesson content.' : ''),
      options.createdBy ?? null,
      bornStatus,
      bornPublishedAt,
      bornArchivedAt,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Failed to seed lesson');
  if (options.objectives && options.objectives.length > 0) {
    await db.query(
      `INSERT INTO learning_objectives (lesson_id, position, statement)
       SELECT $1, ord, statement
         FROM unnest($2::text[]) WITH ORDINALITY AS t(statement, ord)`,
      [id, [...options.objectives]],
    );
  }
  if (bornStatus !== status) {
    await db.query(
      `UPDATE lessons SET status = $2, published_at = $3, archived_at = $4 WHERE id = $1`,
      [id, status, publishedAt, archivedAt],
    );
  }
  return id;
}

/** The objectives of a lesson, in authored order, with their ids. */
export async function objectivesOf(
  lessonId: string,
): Promise<Array<{ id: string; position: number; statement: string }>> {
  const db = await seedDb();
  const { rows } = await db.query<{ id: string; position: number; statement: string }>(
    `SELECT id, position, statement FROM learning_objectives
      WHERE lesson_id = $1 ORDER BY position`,
    [lessonId],
  );
  return rows;
}

/**
 * Assigns a course to a class — the edge a learner reaches content through.
 *
 * Seeded as superuser, so a test can construct states the application role
 * could not: an assignment to an archived class, one naming a draft course, one
 * crossing schools. Those are exactly what the negative tests need.
 */
export async function assignCourseToClass(options: {
  classId: string;
  courseId: string;
  assignedBy?: string | null;
  status?: 'active' | 'inactive' | 'archived';
  startsOn?: string | null;
  dueOn?: string | null;
  /**
   * Constructs a row the database would otherwise REFUSE — a cross-school
   * pairing, or one naming a draft course — by disabling the scope trigger for
   * the insert.
   *
   * This exists for exactly one purpose: proving the READ path defends itself.
   * The write-side trigger makes these rows impossible, which is excellent and
   * also means the read policies' own catalog checks would never be exercised.
   * A defence that is only ever reached through another defence has not been
   * tested. Never used outside a test that says so in its name.
   */
  force?: boolean;
}): Promise<string> {
  const db = await seedDb();
  const status = options.status ?? 'active';
  if (options.force) {
    await db.query(
      'ALTER TABLE class_course_assignments DISABLE TRIGGER class_course_assignments_scope',
    );
  }
  try {
    return await insertAssignment(db, options, status);
  } finally {
    if (options.force) {
      await db.query(
        'ALTER TABLE class_course_assignments ENABLE TRIGGER class_course_assignments_scope',
      );
    }
  }
}

async function insertAssignment(
  db: pg.Client,
  options: {
    classId: string;
    courseId: string;
    assignedBy?: string | null;
    startsOn?: string | null;
    dueOn?: string | null;
  },
  status: 'active' | 'inactive' | 'archived',
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO class_course_assignments
       (class_id, course_id, assigned_by, status, ended_at, starts_on, due_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      options.classId,
      options.courseId,
      options.assignedBy ?? null,
      status,
      status === 'active' ? null : new Date(),
      options.startsOn ?? null,
      options.dueOn ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Failed to seed course assignment');
  return id;
}

/**
 * Records progress for a learner, as superuser.
 *
 * Seeded rather than written through the API so a test can construct states the
 * application role could never reach — progress on a lesson the learner has
 * since lost, or one they never had. Those are exactly what the retention and
 * read-path tests need.
 */
export async function recordProgress(options: {
  userId: string;
  lessonId: string;
  status?: 'not_started' | 'in_progress' | 'completed';
  lastAccessedAt?: Date;
}): Promise<string> {
  const db = await seedDb();
  const status = options.status ?? 'in_progress';
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO lesson_progress (user_id, lesson_id, status, completed_at, last_accessed_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, now())) RETURNING id`,
    [
      options.userId,
      options.lessonId,
      status,
      status === 'completed' ? new Date() : null,
      options.lastAccessedAt ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Failed to seed progress');
  return id;
}

/**
 * Seeds an activity, and its assessment when the type calls for one.
 *
 * Seeding runs as SUPERUSER, so it can construct states the application could
 * never create — a published assessment with a malformed question, a draft the
 * author cannot reach — which is exactly what the negative tests need. The
 * lifecycle timestamps are set to match the CHECK constraints rather than
 * disabled, so a seeded row is a row the database would accept.
 */
export async function createActivity(options: {
  lessonId: string;
  activityType?:
    'assessment' | 'practice' | 'exercise' | 'simulation' | 'experiment' | 'research_task';
  title?: string;
  instructions?: string;
  status?: ContentStatus;
  createdBy?: string | null;
  position?: number;
  /** Assessment configuration. Required in practice for `assessment` activities. */
  passingPercentage?: number;
  maxAttempts?: number;
  /**
   * `on_submission` (the default, and Task 008's behaviour) marks the result
   * released the moment it is scored. `on_release` withholds it until somebody
   * with the authority to do so decides otherwise.
   */
  reviewPolicy?: 'on_submission' | 'on_release';
}): Promise<{ activityId: string; assessmentId: string | null }> {
  const db = await seedDb();
  const status = options.status ?? 'draft';
  const [publishedAt, archivedAt] = lifecycleStamps(status);
  const type = options.activityType ?? 'assessment';

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO learning_activities
       (lesson_id, position, activity_type, title, instructions, status, published_at, archived_at, created_by)
     VALUES ($1,
             COALESCE($2, (SELECT coalesce(max(position), 0) + 1 FROM learning_activities WHERE lesson_id = $1)),
             $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      options.lessonId,
      options.position ?? null,
      type,
      options.title ?? 'Activity',
      options.instructions ?? '',
      status,
      publishedAt,
      archivedAt,
      options.createdBy ?? null,
    ],
  );
  const activityId = rows[0]?.id;
  if (!activityId) throw new Error('Failed to seed activity');

  let assessmentId: string | null = null;
  if (type === 'assessment') {
    const { rows: aRows } = await db.query<{ id: string }>(
      `INSERT INTO assessments (activity_id, passing_percentage, max_attempts, review_policy)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        activityId,
        options.passingPercentage ?? 50,
        options.maxAttempts ?? 1,
        options.reviewPolicy ?? 'on_submission',
      ],
    );
    assessmentId = aRows[0]?.id ?? null;
    if (!assessmentId) throw new Error('Failed to seed assessment');
  }
  return { activityId, assessmentId };
}

/**
 * Seeds a question with its options AND its answer key.
 *
 * `correctOptions` are INDEXES into `options`, matching the API contract, so a
 * fixture can never accidentally point a key at another question's option.
 * Returns the option ids in order, which the submission tests need in order to
 * answer correctly — and which no learner-facing endpoint ever returns
 * alongside their correctness.
 */
export async function createQuestion(options: {
  assessmentId: string;
  questionType?: 'single_choice' | 'multiple_choice' | 'true_false';
  prompt?: string;
  points?: number;
  options: readonly string[];
  correctOptions: readonly number[];
  position?: number;
  /** Shown only in a released review — never in the paper handed out. */
  explanation?: string;
}): Promise<{ questionId: string; optionIds: string[]; correctOptionIds: string[] }> {
  const db = await seedDb();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO assessment_questions (assessment_id, position, question_type, prompt, points, explanation)
     VALUES ($1,
             COALESCE($2, (SELECT coalesce(max(position), 0) + 1 FROM assessment_questions WHERE assessment_id = $1)),
             $3, $4, $5, $6)
     RETURNING id`,
    [
      options.assessmentId,
      options.position ?? null,
      options.questionType ?? 'single_choice',
      options.prompt ?? 'Question?',
      options.points ?? 1,
      options.explanation ?? '',
    ],
  );
  const questionId = rows[0]?.id;
  if (!questionId) throw new Error('Failed to seed question');

  const { rows: optionRows } = await db.query<{ id: string }>(
    `INSERT INTO assessment_options (question_id, position, body)
     SELECT $1, ordinality, body FROM unnest($2::text[]) WITH ORDINALITY AS t(body, ordinality)
     RETURNING id`,
    [questionId, options.options],
  );
  const optionIds = optionRows.map((r) => r.id);

  const correctOptionIds = options.correctOptions.map((index) => {
    const id = optionIds[index];
    if (!id) throw new Error(`correctOptions index ${index} names no option`);
    return id;
  });
  if (correctOptionIds.length > 0) {
    await db.query(
      `INSERT INTO assessment_answer_keys (question_id, option_id) SELECT $1, unnest($2::uuid[])`,
      [questionId, correctOptionIds],
    );
  }
  return { questionId, optionIds, correctOptionIds };
}

/** Seeds an attempt directly. Used to construct states a learner could not. */
export async function createAttempt(options: {
  assessmentId: string;
  userId: string;
  status?: 'in_progress' | 'submitted';
}): Promise<string> {
  const db = await seedDb();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO assessment_attempts (assessment_id, user_id) VALUES ($1, $2) RETURNING id`,
    [options.assessmentId, options.userId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Failed to seed attempt');
  if (options.status === 'submitted') {
    // Through the real submit path, so the score is the one the database
    // computes. A fixture that wrote a score directly would be testing against
    // a number no learner could ever have received.
    await db.query(`UPDATE assessment_attempts SET status = 'submitted' WHERE id = $1`, [id]);
  }
  return id;
}

/**
 * Seeds an experiment with its validation rules, and only then moves the
 * activity to its requested status.
 *
 * The order is not a convenience — it is the only order the schema permits.
 * `experiment_validation_rules_draft_only` refuses an INSERT once the activity
 * is published, and `learning_activities_experiment_publication` refuses the
 * publication until the experiment exists and its rules are well formed. A
 * fixture that created a published activity first would deadlock against its
 * own schema, which is exactly what an author would hit.
 */
export async function createExperiment(options: {
  lessonId: string;
  simulationType?: 'circuit' | 'physics' | 'logic_gate' | 'code_sandbox';
  title?: string;
  initialConfig?: Record<string, unknown>;
  /** `{"rules": [...]}`. Defaults to a rule set nothing has to satisfy. */
  rules?: Record<string, unknown>;
  /** Omit the rules row entirely, to construct the unpublishable state. */
  withoutRules?: boolean;
  status?: ContentStatus;
  createdBy?: string | null;
  activityType?: 'simulation' | 'experiment';
  position?: number;
}): Promise<{ activityId: string; experimentId: string }> {
  const db = await seedDb();
  const status = options.status ?? 'draft';

  const { activityId } = await createActivity({
    lessonId: options.lessonId,
    activityType: options.activityType ?? 'simulation',
    title: options.title ?? 'Close the circuit',
    status: 'draft',
    createdBy: options.createdBy ?? null,
    ...(options.position === undefined ? {} : { position: options.position }),
  });

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO experiments (activity_id, simulation_type, initial_config)
     VALUES ($1, $2, $3) RETURNING id`,
    [
      activityId,
      options.simulationType ?? 'circuit',
      JSON.stringify(options.initialConfig ?? {}),
    ],
  );
  const experimentId = rows[0]?.id;
  if (!experimentId) throw new Error('Failed to seed experiment');

  if (!options.withoutRules) {
    await db.query(`INSERT INTO experiment_validation_rules (experiment_id, rules) VALUES ($1, $2)`, [
      experimentId,
      JSON.stringify(options.rules ?? { rules: [] }),
    ]);
  }

  if (status !== 'draft') {
    const [publishedAt, archivedAt] = lifecycleStamps(status);
    await db.query(
      `UPDATE learning_activities
          SET status = $2, published_at = $3, archived_at = $4
        WHERE id = $1`,
      [activityId, status, publishedAt, archivedAt],
    );
  }

  return { activityId, experimentId };
}

/**
 * Seeds a lab session directly, so a test can construct a state a learner
 * could not reach — a session belonging to somebody who has since left the
 * class, or one already submitted.
 *
 * `submit` goes through the real UPDATE path, so `passed` is whatever the
 * database decided from the rules. A fixture that wrote `passed` itself would
 * be asserting against an outcome no learner could ever have received.
 */
export async function createLabSession(options: {
  experimentId: string;
  userId: string;
  state?: Record<string, unknown>;
  submit?: boolean;
}): Promise<string> {
  const db = await seedDb();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO experiment_sessions (experiment_id, user_id, current_state)
     VALUES ($1, $2, $3) RETURNING id`,
    [options.experimentId, options.userId, JSON.stringify(options.state ?? {})],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Failed to seed lab session');

  if (options.submit) {
    await db.query(`UPDATE experiment_sessions SET status = 'submitted' WHERE id = $1`, [id]);
  }
  return id;
}

/**
 * Seeds a notebook directly.
 *
 * As superuser, like every fixture here — which is exactly why the RLS suite
 * ALSO writes one through `edu_app`. VULN-042 was a write policy no test
 * exercised, because seeding as superuser is what makes fixtures convenient.
 */
export async function createNotebook(options: {
  ownerId: string;
  organizationId?: string | null;
  title?: string;
  description?: string;
}): Promise<string> {
  const db = await seedDb();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO student_notebooks (owner_id, organization_id, title, description)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      options.ownerId,
      options.organizationId ?? null,
      options.title ?? 'Physics',
      options.description ?? '',
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Failed to seed notebook');
  return id;
}

/**
 * Seeds an artifact registration directly.
 *
 * `storageKey` is deliberately NOT a parameter: the insert trigger derives it
 * and discards anything sent in that column. A fixture that could set it would
 * be testing against a key no caller could ever produce.
 */
export async function createArtifact(options: {
  ownerId: string;
  noteId?: string | null;
  sessionId?: string | null;
  artifactType?: 'image' | 'code_snippet' | 'pdf' | 'data_export';
  byteSize?: number;
  declaredContentType?: string;
  originalFilename?: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const db = await seedDb();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO student_artifacts
       (owner_id, note_id, session_id, artifact_type, storage_key,
        declared_content_type, original_filename, byte_size, metadata)
     VALUES ($1, $2, $3, $4, 'ignored-by-the-trigger', $5, $6, $7, $8)
     RETURNING id`,
    [
      options.ownerId,
      options.noteId ?? null,
      options.sessionId ?? null,
      options.artifactType ?? 'image',
      options.declaredContentType ?? 'image/png',
      options.originalFilename ?? 'diagram.png',
      options.byteSize ?? 1024,
      JSON.stringify(options.metadata ?? {}),
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Failed to seed artifact');
  return id;
}

/**
 * The embedding dimension the schema is built for. Mirrors
 * `EMBEDDING_DIMENSIONS` in the API; asserted equal by an architecture test, so
 * the two cannot drift into a shape the column would reject.
 */
export const TEST_EMBEDDING_DIMENSIONS = 768;

/**
 * A deterministic unit vector, so a test can say "these two are close" and
 * "these two are far" without depending on an embedding model.
 *
 * `seed` picks a direction: the same seed always gives the same vector, and
 * different seeds give vectors whose cosine distance grows with the gap. That
 * is all a retrieval test needs — the ORDER is the thing under test, and the
 * security properties are independent of it (0023, restated in 0026).
 */
export function testVector(seed: number, dimensions = TEST_EMBEDDING_DIMENSIONS): number[] {
  const raw = Array.from({ length: dimensions }, (_unused, i) =>
    Math.sin((i + 1) * 0.017 + seed * 1.7),
  );
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

export const asVectorLiteral = (values: readonly number[]): string => `[${values.join(',')}]`;

/**
 * Seeds one embedding row directly.
 *
 * As superuser, like every fixture here — which is why the RLS suite ALSO
 * writes one through `edu_app`. VULN-042 was an insert policy that refused
 * every legitimate author and survived a whole suite, because seeding as
 * superuser is what makes fixtures convenient.
 *
 * `courseId`, `unitId` and `organizationId` are NOT parameters: the ancestry
 * trigger derives all three from the lesson. A fixture that could set them
 * would be testing against rows no writer could produce.
 */
export async function createEmbedding(options: {
  lessonId: string;
  chunkIndex?: number;
  chunkContent?: string;
  seed?: number;
  embeddingModel?: string;
  sourceUpdatedAt?: Date | string | null;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const db = await seedDb();
  const content = options.chunkContent ?? 'Mitochondria are the powerhouse of the cell.';
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO curriculum_embeddings
       (lesson_id, course_id, unit_id, chunk_index, chunk_content,
        embedding, embedding_model, source_updated_at, metadata)
     VALUES ($1,
             '00000000-0000-4000-8000-000000000000',
             '00000000-0000-4000-8000-000000000000',
             $2, $3, $4::vector, $5,
             -- Defaults to the LIVE lesson's timestamp, so a seeded chunk is
             -- fresh unless a test deliberately makes it stale.
             COALESCE($6::timestamptz, (SELECT l.updated_at FROM lessons l WHERE l.id = $1)),
             $7)
     RETURNING id`,
    [
      options.lessonId,
      options.chunkIndex ?? 0,
      content,
      asVectorLiteral(testVector(options.seed ?? 1)),
      options.embeddingModel ?? 'test-deterministic-768',
      options.sourceUpdatedAt ?? null,
      JSON.stringify(options.metadata ?? {}),
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Failed to seed embedding');
  return id;
}
