/**
 * Authorization vocabulary.
 *
 * Everything in this package is a PURE function of its inputs. It performs no
 * I/O, reads no globals, and consults no clock. That is a deliberate security
 * property: the full decision table can be enumerated in unit tests without a
 * database, so "who can reach what" is provable rather than assumed.
 *
 * The corollary is a rule the callers must honour, enforced by `Guarded<T>`:
 * every attribute a policy reads must be loaded from the server's own store.
 * A policy input that came from the request body is an authorization bypass.
 */

export const Role = {
  STUDENT: 'student',
  TEACHER: 'teacher',
  GUARDIAN: 'guardian',
  CONTENT_AUTHOR: 'content_author',
  REVIEWER: 'reviewer',
  MODERATOR: 'moderator',
  ADMIN: 'admin',
  SECURITY_ADMIN: 'security_admin',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export const ALL_ROLES: readonly Role[] = Object.values(Role);

export type ActorStatus = 'active' | 'suspended' | 'pending_verification';

/**
 * The authenticated principal.
 *
 * Every field here is server-derived: it is loaded from the session and the
 * users table on each request. None of it is ever read from a client-supplied
 * header, body field, or JWT claim that the client could mint.
 */
/**
 * A role held within a scope.
 *
 * "Teacher" is never a global fact in a school — it is "teacher OF this class".
 * Storing the scope alongside the role is what lets a policy ask the precise
 * question instead of re-deriving it from somewhere else each time.
 */
export type RoleScopeType = 'global' | 'organization' | 'class';

export interface RoleGrant {
  readonly role: Role;
  readonly scopeType: RoleScopeType;
  /** Null exactly when the scope is global. */
  readonly scopeId: string | null;
}

/**
 * A `resource:action` permission name, e.g. `notes:read`.
 *
 * A permission is NECESSARY but never SUFFICIENT. Holding `notes:read` says the
 * actor's roles permit reading notes in general; it says nothing about any
 * particular note. Object-level authorization always still runs.
 */
export type PermissionName = string;

export interface Actor {
  readonly id: string;
  /** Every role name the actor holds, in any scope. Scope-blind by design. */
  readonly roles: readonly Role[];
  /** The same roles with their scopes attached, for scope-aware checks. */
  readonly grants: readonly RoleGrant[];
  /** Flattened permissions from every role the actor holds. */
  readonly permissions: readonly PermissionName[];
  readonly status: ActorStatus;
  readonly emailVerified: boolean;
  /** Null for actors not attached to a school/organization. */
  readonly organizationId: string | null;
}

/** True when the actor holds `role` anywhere (any scope). */
export function hasRole(actor: Actor, role: Role): boolean {
  return actor.roles.includes(role);
}

/**
 * True when the actor holds `role` in a scope that COVERS the target.
 *
 * A global grant covers everything; a scoped grant covers only its own target.
 * Note what this deliberately does NOT do: an organization-scoped grant does not
 * automatically cover classes inside that organization. Class containment is a
 * relationship question, and answering it here from an id alone would mean
 * guessing at data this package cannot see.
 */
export function hasRoleInScope(
  actor: Actor,
  role: Role,
  scopeType: RoleScopeType,
  scopeId: string | null,
): boolean {
  return actor.grants.some(
    (grant) =>
      grant.role === role &&
      (grant.scopeType === 'global' ||
        (grant.scopeType === scopeType && grant.scopeId === scopeId && scopeId !== null)),
  );
}

/** True when any of the actor's roles carries `permission`. */
export function hasPermission(actor: Actor, permission: PermissionName): boolean {
  return actor.permissions.includes(permission);
}

/**
 * A PLATFORM operator: `security_admin` held at GLOBAL scope.
 *
 * Distinct from a school's security administrator, whose grant is
 * organization-scoped. Only a platform operator may create organizations, and
 * the grant cannot be made through the API at all — migration 0013 refuses to
 * assign any privileged role globally, so it is an out-of-band operator action.
 */
export function isPlatformOperator(actor: Actor): boolean {
  return actor.grants.some(
    (grant) => grant.role === Role.SECURITY_ADMIN && grant.scopeType === 'global',
  );
}

/**
 * Relationship edges relevant to the current decision, loaded from the database
 * by the caller immediately before the decision is made.
 *
 * Passing a snapshot (rather than a live repository) is what keeps this package
 * pure. It also forces the caller to be explicit about which edges it fetched,
 * which makes an accidentally-empty relationship set visible in tests.
 */
export interface RelationshipSnapshot {
  /** Child ids for which this actor is a VERIFIED guardian. */
  readonly guardianOf: readonly string[];
  /**
   * Student ids the actor currently teaches.
   *
   * DERIVED, not stored: the actor has an active assignment to a class, that
   * class is active, and the student has an active membership in it. Because it
   * is derived, ending any one of those three revokes access immediately, with
   * no second table to remember to update.
   */
  readonly teacherOf: readonly string[];
  /** Class ids the actor actively teaches. */
  readonly teachesClasses: readonly string[];
  /** Class ids the actor is an active member of. */
  readonly memberOfClasses: readonly string[];
  /**
   * Course ids the actor reaches THROUGH A CLASS — actively assigned to an
   * active class they are actively enrolled in or actively teach.
   *
   * DERIVED, like `teacherOf`, and derived from four statuses at once: the
   * assignment, the class, the membership or teacher assignment, and (for a
   * learner) the course's own publication. Breaking any one of them revokes
   * access on the next request, because the edge is recomputed per request and
   * never cached.
   *
   * This is what NARROWS content visibility from "everything published in my
   * school" to "what my class is actually studying". It can only remove
   * content from the set the catalog rules already permitted — the tenancy
   * check still runs first and still decides.
   */
  readonly coursesViaClasses: readonly string[];
}

export const EMPTY_RELATIONSHIPS: RelationshipSnapshot = Object.freeze({
  guardianOf: Object.freeze([]) as readonly string[],
  teacherOf: Object.freeze([]) as readonly string[],
  teachesClasses: Object.freeze([]) as readonly string[],
  memberOfClasses: Object.freeze([]) as readonly string[],
  coursesViaClasses: Object.freeze([]) as readonly string[],
});

export interface AuthorizationContext {
  readonly actor: Actor;
  readonly relationships: RelationshipSnapshot;
}

// --- Resources -----------------------------------------------------------
// A resource passed to the engine is always the SERVER's copy of the record.

export type ResourceKind =
  | 'note'
  | 'user'
  | 'profile'
  | 'role_grant'
  | 'organization'
  | 'class'
  | 'teacher_assignment'
  | 'class_membership'
  | 'guardian_relationship'
  | 'education_level'
  | 'curriculum'
  | 'course'
  | 'course_unit'
  | 'lesson'
  | 'class_course_assignment'
  | 'lesson_progress'
  | 'objective_progress'
  | 'learning_activity'
  | 'assessment_attempt'
  | 'experiment_session'
  | 'ai_conversation'
  | 'notebook'
  | 'student_artifact';

export interface BaseResource {
  readonly kind: ResourceKind;
  readonly id: string;
}

export type NoteVisibility = 'private' | 'shared_with_teacher' | 'shared_with_guardian';
export type NoteState = 'active' | 'archived' | 'deleted';

export interface NoteResource extends BaseResource {
  readonly kind: 'note';
  readonly ownerId: string;
  readonly organizationId: string | null;
  readonly visibility: NoteVisibility;
  readonly state: NoteState;
}

export interface UserResource extends BaseResource {
  readonly kind: 'user';
  readonly organizationId: string | null;
  readonly status: ActorStatus;
}

export interface ProfileResource extends BaseResource {
  readonly kind: 'profile';
  /** The profile's owner. Profiles are keyed by user id. */
  readonly userId: string;
  readonly organizationId: string | null;
}

/**
 * A role assignment being granted or revoked.
 *
 * The resource is the GRANT, not the user: "may this actor give that role, in
 * that scope, to that person?" Modelling it this way is what allows an admin to
 * be permitted to grant `teacher` in their own organization while being refused
 * `security_admin` anywhere.
 */
export interface RoleGrantResource extends BaseResource {
  readonly kind: 'role_grant';
  readonly targetUserId: string;
  readonly targetUserOrganizationId: string | null;
  readonly role: Role;
  readonly scopeType: RoleScopeType;
  readonly scopeId: string | null;
}

export interface OrganizationResource extends BaseResource {
  readonly kind: 'organization';
}

export type ClassState = 'active' | 'archived';

export interface ClassResource extends BaseResource {
  readonly kind: 'class';
  readonly organizationId: string;
  readonly state: ClassState;
}

export interface TeacherAssignmentResource extends BaseResource {
  readonly kind: 'teacher_assignment';
  readonly classId: string;
  readonly classOrganizationId: string | null;
  readonly teacherId: string;
  readonly state: 'active' | 'ended';
}

export interface ClassMembershipResource extends BaseResource {
  readonly kind: 'class_membership';
  readonly classId: string;
  readonly classOrganizationId: string | null;
  /**
   * The member this row is about, or `null` when the resource is the class
   * ROSTER as a whole rather than one person's row.
   *
   * The distinction matters: "may I see my own membership?" and "may I
   * enumerate everyone in this class?" are different questions, and answering
   * the second with the first is how a student ends up reading the roster.
   * Only `class_membership:list` accepts `null`; every other action requires a
   * named member and denies without one.
   */
  readonly memberUserId: string | null;
  readonly state: 'active' | 'ended';
}

export interface GuardianRelationshipResource extends BaseResource {
  readonly kind: 'guardian_relationship';
  readonly guardianId: string;
  readonly childId: string;
  /**
   * The organization the CHILD belongs to, or `null` when it is unknown or the
   * child has none.
   *
   * Present so the policy can confine an administrator to their own school
   * without asking the database. RLS confines them the same way
   * (`app_user_organization(child_id) = app_actor_organization()`); carrying it
   * here is what stops that confinement from being RLS's alone.
   */
  readonly childOrganizationId: string | null;
  readonly state: 'pending' | 'verified' | 'revoked';
}

/**
 * The lifecycle every piece of educational content moves through, one way.
 *
 * `published` is the only state a learner may see. `draft` and `archived` are
 * both editorial states, and both are HIDDEN (404) rather than refused (403)
 * from anyone without editorial standing — a 403 would confirm that the id
 * names real content.
 */
export type ContentStatus = 'draft' | 'published' | 'archived';

/**
 * Reference data: the grades and stages content is filed under.
 *
 * Global by construction — "Grade 7" means the same thing in every school, and
 * letting each mint its own would fork the vocabulary that makes content
 * shareable. There is no organization field to compare, so the resource carries
 * no attributes at all.
 */
export interface EducationLevelResource extends BaseResource {
  readonly kind: 'education_level';
}

/**
 * Shared shape of every content node.
 *
 * `organizationId === null` means the GLOBAL catalog. That is not "no
 * organization" in the way a user's null organization is — it is a distinct,
 * deliberate ownership state with its own authority (a platform operator), and
 * the policy treats it as such rather than as an absence.
 */
export interface ContentNodeResource extends BaseResource {
  readonly organizationId: string | null;
  readonly status: ContentStatus;
  /**
   * Whether every ancestor of this node is published.
   *
   * The tree is only as visible as its least-visible ancestor: a published
   * lesson inside a draft unit is not a published lesson as far as a learner is
   * concerned. Carrying the answer here — rather than having each policy walk
   * the tree — is what keeps this package pure, and what stops one level of the
   * hierarchy from being checked while another is forgotten.
   *
   * Always `true` for a curriculum and a course, which have no content ancestor.
   */
  readonly ancestorsPublished: boolean;
}

export interface CurriculumResource extends ContentNodeResource {
  readonly kind: 'curriculum';
}

export interface CourseResource extends ContentNodeResource {
  readonly kind: 'course';
  readonly curriculumId: string;
  readonly levelId: string;
}

export interface CourseUnitResource extends ContentNodeResource {
  readonly kind: 'course_unit';
  readonly courseId: string;
}

export interface LessonResource extends ContentNodeResource {
  readonly kind: 'lesson';
  readonly unitId: string;
  readonly courseId: string;
}

/**
 * A course assigned to a class: the edge that decides which learners a piece of
 * published content actually reaches.
 *
 * Both organizations are carried, and both are needed. `classOrganizationId` is
 * never null — a class always belongs to a school. `courseOrganizationId` IS
 * null for the global catalog, which is the one case where the two may legally
 * differ.
 */
export interface ClassCourseAssignmentResource extends BaseResource {
  readonly kind: 'class_course_assignment';
  readonly classId: string;
  readonly classOrganizationId: string | null;
  readonly courseId: string;
  readonly courseOrganizationId: string | null;
  readonly courseStatus: ContentStatus;
  readonly classIsActive: boolean;
  readonly state: 'active' | 'inactive' | 'archived';
}

/** A learner's running record for one lesson. Forward-only; see migration 0018. */
export type LessonProgressState = 'not_started' | 'in_progress' | 'completed';

/**
 * One learner's progress on one lesson.
 *
 * The first resource in the platform whose subject is a NAMED CHILD and whose
 * author is that same child. Two fields carry facts the pure policy cannot
 * derive, both computed in the same query that loads the row:
 *
 *   `learnerMayStudy` — does the row's SUBJECT still reach this lesson through
 *   a class? Only the subject writes, so on a write this is a fact about the
 *   actor; on a read it is not consulted at all, which is the retention rule.
 *
 *   `observableByActorAsTeacher` — ACTOR-RELATIVE, unusually. It answers the
 *   task's precise teacher rule: the learner is enrolled in a class the actor
 *   teaches AND the lesson's course is assigned to THAT SAME class. Two coarser
 *   snapshot edges ("I teach them" and "I reach that course") would both be true
 *   for a teacher who reaches the course through a DIFFERENT class, so the
 *   conjunction has to be evaluated where the class ids can be compared.
 */
export interface LessonProgressResource extends BaseResource {
  readonly kind: 'lesson_progress';
  readonly learnerId: string;
  readonly learnerOrganizationId: string | null;
  readonly lessonId: string;
  readonly courseId: string;
  readonly state: LessonProgressState;
  readonly learnerMayStudy: boolean;
  readonly observableByActorAsTeacher: boolean;
}

/**
 * A learner's standing against ONE learning objective.
 *
 * Deliberately shaped after `LessonProgressResource`, because it answers the
 * same question about the same child — "who may look at what this learner
 * did?" — and a second, subtly different answer would be a disagreement waiting
 * to be exploited from whichever side is looser.
 *
 * IT CARRIES NO MASTERY STATE, and that absence is the point. Authorization
 * decides who may look; it takes no part in judging what a child understands.
 * A policy that could read the mastery level would invite a branch that
 * disclosed more to a learner who had done well, or less to one who had not.
 *
 * There is no WRITE action either (see `OBJECTIVE_PROGRESS_ACTIONS`). Evidence
 * is emitted by database triggers on events that already happened, so there is
 * no request through which anyone — learner, teacher, administrator or platform
 * operator — could author a claim about what another person understands.
 */
export interface ObjectiveProgressResource extends BaseResource {
  readonly kind: 'objective_progress';
  readonly learnerId: string;
  readonly learnerOrganizationId: string | null;
  readonly objectiveId: string;
  readonly lessonId: string;
  readonly observableByActorAsTeacher: boolean;
}

/**
 * The kinds of activity a lesson can carry.
 *
 * Only `assessment` has an implementation. The rest are declared so the
 * vocabulary is settled once — a 2D chemistry simulation and a physics
 * experiment are different `activity_type` values on the same table, not a new
 * shape for the lesson model — and so that a policy written today cannot
 * accidentally assume there is only ever one kind.
 */
export type ActivityType =
  'assessment' | 'practice' | 'exercise' | 'simulation' | 'experiment' | 'research_task';

/**
 * A learning activity: the generic thing a learner DOES inside a lesson.
 *
 * It is a content node, and it is authorized as one — the same two axes, the
 * same duty split, the same disclosure rule. What it adds is that an activity
 * is only ever as visible as the lesson above it, which the caller answers in
 * `lessonVisible` rather than the policy walking the tree.
 *
 * `learnerReachesLesson` is the Task 006 chain for the ACTOR: is this lesson
 * assigned to a class they are in? It separates a learner (who needs the
 * assignment) from content staff (who do not), exactly as `contentPolicy` does
 * — and it is what a learner needs in order to START an assessment rather than
 * merely read about one.
 *
 * There is deliberately no separate `assessment` resource kind. An assessment
 * has no lifecycle of its own — its activity's status IS its status — so
 * modelling it separately would create two rules for one visible object, and
 * two rules can disagree.
 */
export interface LearningActivityResource extends BaseResource {
  readonly kind: 'learning_activity';
  readonly lessonId: string;
  readonly courseId: string;
  /** Null for the global catalog, exactly as on a content node. */
  readonly organizationId: string | null;
  readonly activityType: ActivityType;
  readonly status: ContentStatus;
  /** Whether the actor can see the lesson this hangs off. Computed in SQL. */
  readonly lessonVisible: boolean;
  /** Whether the actor reaches that lesson AS A LEARNER, through a class. */
  readonly learnerReachesLesson: boolean;
}

export type AttemptState = 'in_progress' | 'submitted';

/**
 * One learner's attempt at one assessment.
 *
 * Shaped after `LessonProgressResource`, because it answers the same question
 * about the same child and a different answer here would be a second opinion,
 * not extra safety. The asymmetry is the same and so is its reason:
 *
 *   WRITE — start and submit are the learner's alone, and only while they still
 *           reach the assessment through a class.
 *   READ  — the learner's own attempts, always, with no access check. Losing a
 *           class must not erase the record of what they sat.
 *
 * NOTHING HERE IS A SCORE. The policy decides who may look at a result; it
 * plays no part in computing one, and it is never given the marks. Passing them
 * in would invite a future branch that decided something based on whether a
 * child had done well.
 */
export interface AssessmentAttemptResource extends BaseResource {
  readonly kind: 'assessment_attempt';
  readonly learnerId: string;
  readonly learnerOrganizationId: string | null;
  readonly assessmentId: string;
  readonly lessonId: string;
  readonly state: AttemptState;
  /**
   * Whether the RESULT has been released to the learner (Task 009).
   *
   * Scoring and disclosure are separate events. An attempt is scored the
   * instant it is submitted; whether the learner may see that score and review
   * the paper is a second decision with its own authority. `false` here means
   * the marks exist but are withheld.
   *
   * A third party who may read the attempt is NOT gated on this — a teacher
   * decides whether to release, so they must be able to see what they are
   * deciding about.
   */
  readonly released: boolean;
  /** Whether the SUBJECT still reaches this assessment through a class. */
  readonly learnerMayAttempt: boolean;
  /**
   * ACTOR-RELATIVE. The learner is enrolled in a class the actor teaches AND
   * this assessment's lesson belongs to a course assigned to THAT SAME class.
   * The conjunction is computed in SQL for the reason given on
   * `LessonProgressResource`: teaching a class must never imply reading a
   * student, and two coarser edges cannot express "the same class".
   */
  readonly observableByActorAsTeacher: boolean;
}

export type LabSessionState = 'in_progress' | 'submitted' | 'completed';

/**
 * One learner's run at one interactive lab.
 *
 * THERE IS NO `experiment` RESOURCE KIND, for the reason 0019 gives for having
 * no `assessment` one: a lab has no lifecycle of its own. Its activity's status
 * IS its status, so authoring, publishing and archiving a lab are
 * `learning_activity:*` against the activity that carries it. Modelling the lab
 * separately would create two rules for one visible object, and two rules can
 * disagree.
 *
 * What DOES need its own kind is the session, because it is a record about a
 * child. It is shaped after `AssessmentAttemptResource` deliberately: both
 * answer "who may look at what this child did?", and a second, subtly different
 * answer to a settled question is not extra safety — it is a disagreement
 * waiting to be exploited from whichever side is looser.
 *
 * THE POLICY NEVER SEES THE OUTCOME. There is no `passed` here, exactly as
 * there is no score on an attempt. Authorization decides who may look at a
 * result; it takes no part in deciding one, and a policy that could read the
 * verdict would invite a branch that behaved differently for a child who had
 * done badly.
 *
 * There is also no `release`. A lab result is not withheld — there is no
 * review policy on an experiment — so the vocabulary has no word for releasing
 * one, and an endpoint that wanted to withhold a result would have to add the
 * action here, in a diff somebody reads.
 */
export interface ExperimentSessionResource extends BaseResource {
  readonly kind: 'experiment_session';
  readonly learnerId: string;
  readonly learnerOrganizationId: string | null;
  readonly experimentId: string;
  readonly lessonId: string;
  readonly state: LabSessionState;
  /**
   * Whether the SUBJECT still reaches this lab through a class — §3's instant
   * state isolation, asked at the application layer. The RLS update policy asks
   * the same question independently on every write, so a stale `true` here
   * costs nothing; a stale `false` merely refuses early.
   */
  readonly learnerMayWork: boolean;
  /**
   * ACTOR-RELATIVE. The learner is enrolled in a class the actor teaches AND
   * this lab's lesson belongs to a course assigned to THAT SAME class. The
   * conjunction is computed in SQL for the reason given on
   * `LessonProgressResource`: teaching a class must never imply reading a
   * student, and two coarser edges cannot express "the same class".
   */
  readonly observableByActorAsTeacher: boolean;
}

/**
 * A notebook: the folder a learner files their notes in.
 *
 * IT HAS NO `visibility`, AND THAT IS THE DESIGN RATHER THAN AN OMISSION.
 * `NoteResource` carries one because a student may choose to show a single note
 * to their teacher. A notebook is a container whose contents are individually
 * shareable, so sharing the container would share things the child never opened
 * — including notes they write into it tomorrow. When per-notebook sharing is
 * wanted it needs its own field, its own branch and its own review.
 *
 * The consequence is that `notebookPolicy` has no relationship branch at all.
 * There is nothing for a teacher, a guardian, an administrator or a platform
 * operator to match on.
 */
export interface NotebookResource extends BaseResource {
  readonly kind: 'notebook';
  readonly ownerId: string;
  readonly organizationId: string | null;
}

export type ArtifactKind = 'image' | 'code_snippet' | 'pdf' | 'data_export';

/**
 * A registered personal file.
 *
 * STRICTER THAN A NOTE, deliberately. A note has a visibility its owner can
 * open; an artifact has none, so a verified guardian who may read a SHARED note
 * still cannot read the file attached to it. Files are the hardest thing to
 * un-share and the easiest to misjudge the contents of, so the first version of
 * this resource has no sharing at all.
 *
 * There is no `storageKey` here. The policy decides who may act on the row; it
 * has no business knowing where the bytes would live, and a policy that carried
 * the key would be one leak away from disclosing the storage layout.
 */
export interface StudentArtifactResource extends BaseResource {
  readonly kind: 'student_artifact';
  readonly ownerId: string;
  readonly organizationId: string | null;
  readonly artifactType: ArtifactKind;
  readonly byteSize: number;
}

/**
 * One learner's conversation with the AI tutor.
 *
 * `observableByActorAsTeacher` and `moderatableByActor` are RESOLVED FROM THE
 * DATABASE and handed to the policy, not derived here. The same shape
 * `LessonProgressResource` uses, for the same reason: the policy engine is pure,
 * so a relationship it cannot look up has to arrive as a fact.
 *
 * They are two fields rather than one because they answer different questions
 * and carry different weight. Teaching this learner this lesson is the ordinary
 * boundary the platform already uses everywhere; moderating a school is a
 * SAFETY power that reaches conversations of learners the holder does not
 * teach. Collapsing them into `canRead` would hide which one admitted a
 * particular read, and "which authority did this adult use to read a child's
 * conversation" is exactly the question an audit of this domain has to answer.
 */
export interface AiConversationResource extends BaseResource {
  readonly kind: 'ai_conversation';
  readonly ownerId: string;
  readonly organizationId: string | null;
  readonly lessonId: string;
  readonly courseId: string;
  readonly status: 'active' | 'archived';
  /** The actor teaches this learner, on this lesson. Resolved in SQL. */
  readonly observableByActorAsTeacher: boolean;
  /** The actor holds a safety-moderation role in this school. Resolved in SQL. */
  readonly moderatableByActor: boolean;
  /** The learner is CURRENTLY studying the anchor lesson. Resolved in SQL. */
  readonly anchorStillAssigned: boolean;
}

export type Resource =
  | AiConversationResource
  | NoteResource
  | UserResource
  | ProfileResource
  | RoleGrantResource
  | OrganizationResource
  | ClassResource
  | TeacherAssignmentResource
  | ClassMembershipResource
  | GuardianRelationshipResource
  | EducationLevelResource
  | CurriculumResource
  | CourseResource
  | CourseUnitResource
  | LessonResource
  | ClassCourseAssignmentResource
  | LessonProgressResource
  | ObjectiveProgressResource
  | LearningActivityResource
  | AssessmentAttemptResource
  | ExperimentSessionResource
  | NotebookResource
  | StudentArtifactResource;

// --- Actions -------------------------------------------------------------
// An action is `<resourceKind>:<verb>`. The engine enforces that the prefix
// matches the resource kind, which rules out a whole class of copy-paste bugs
// where a handler authorizes the wrong action against the right object.

export const NOTE_ACTIONS = [
  'note:create',
  'note:read',
  'note:update',
  'note:delete',
  'note:share',
] as const;

export const USER_ACTIONS = ['user:read', 'user:update', 'user:suspend', 'user:list'] as const;

export const PROFILE_ACTIONS = ['profile:read', 'profile:update'] as const;

export const ROLE_GRANT_ACTIONS = [
  'role_grant:assign',
  'role_grant:revoke',
  'role_grant:list',
] as const;

export const ORGANIZATION_ACTIONS = [
  'organization:create',
  'organization:read',
  'organization:update',
  'organization:list',
] as const;

export const CLASS_ACTIONS = [
  'class:create',
  'class:read',
  'class:update',
  'class:archive',
  'class:list',
] as const;

export const TEACHER_ASSIGNMENT_ACTIONS = [
  'teacher_assignment:create',
  'teacher_assignment:read',
  'teacher_assignment:remove',
] as const;

export const CLASS_MEMBERSHIP_ACTIONS = [
  'class_membership:read',
  'class_membership:list',
  'class_membership:manage',
] as const;

export const GUARDIAN_RELATIONSHIP_ACTIONS = [
  'guardian_relationship:create',
  'guardian_relationship:read',
  'guardian_relationship:verify',
  'guardian_relationship:revoke',
] as const;

export const EDUCATION_LEVEL_ACTIONS = [
  'education_level:read',
  'education_level:list',
  'education_level:create',
  'education_level:update',
] as const;

/**
 * The same seven verbs at every level of the content tree.
 *
 * `publish` and `archive` are separate from `update` deliberately: they are the
 * editorial acts, gated on `content:publish`, while `update` is authoring and
 * gated on `content:author`. Collapsing them into one verb is exactly how
 * unreviewed material reaches a classroom.
 */
const CONTENT_VERBS = ['create', 'read', 'list', 'update', 'publish', 'archive', 'delete'] as const;
type ContentVerb = (typeof CONTENT_VERBS)[number];

export const CURRICULUM_ACTIONS = CONTENT_VERBS.map((v) => `curriculum:${v}` as const);

/**
 * `course:index` — rebuilding a course's entry in the knowledge base.
 *
 * A verb on COURSES ONLY, which is why it is appended here rather than added to
 * `CONTENT_VERBS`: there is no such thing as indexing a curriculum or a unit,
 * and a vocabulary that offered one would advertise a capability no route
 * implements.
 *
 * It is NOT `course:publish` re-used. Publishing requires a DRAFT — you publish
 * something not yet visible — and indexing requires the opposite: you index
 * what learners can already see. Reaching for the nearest existing verb would
 * have produced an endpoint that could only ever index courses no learner could
 * search.
 *
 * It carries the same AUTHORITY as publishing, though, and `contentPolicy`
 * enforces that: indexing decides what the assistant can retrieve and quote to a
 * child, which is a publication decision wearing an operational hat.
 */
export const COURSE_ACTIONS = [
  ...CONTENT_VERBS.map((v) => `course:${v}` as const),
  'course:index' as const,
];
export const COURSE_UNIT_ACTIONS = CONTENT_VERBS.map((v) => `course_unit:${v}` as const);
export const LESSON_ACTIONS = CONTENT_VERBS.map((v) => `lesson:${v}` as const);

export type CurriculumAction = `curriculum:${ContentVerb}`;
export type CourseAction = `course:${ContentVerb}` | 'course:index';
export type CourseUnitAction = `course_unit:${ContentVerb}`;
export type LessonAction = `lesson:${ContentVerb}`;
export type EducationLevelAction = (typeof EDUCATION_LEVEL_ACTIONS)[number];

/** The verb of any content action, with the resource prefix removed. */
export type ContentAction = CurriculumAction | CourseAction | CourseUnitAction | LessonAction;

export const CLASS_COURSE_ASSIGNMENT_ACTIONS = [
  'class_course_assignment:create',
  'class_course_assignment:read',
  'class_course_assignment:list',
  'class_course_assignment:remove',
] as const;

export type ClassCourseAssignmentAction = (typeof CLASS_COURSE_ASSIGNMENT_ACTIONS)[number];

/**
 * `record` rather than `create`/`update`, because the endpoint is an upsert and
 * the distinction carries no authority: whoever may start a record may continue
 * it, and nobody else may do either.
 */
/**
 * Reading a learner's objective progress. READS ONLY.
 *
 * There is no `record`, no `set`, and no `override`. Mastery is derived from
 * evidence, evidence is emitted by triggers, and neither is reachable through a
 * request — so the vocabulary has no word for writing one, and a future
 * endpoint that wanted to would have to add the action here in a visible diff.
 */
export const OBJECTIVE_PROGRESS_ACTIONS = [
  'objective_progress:read',
  'objective_progress:list',
] as const;

export type ObjectiveProgressAction = (typeof OBJECTIVE_PROGRESS_ACTIONS)[number];

export const LESSON_PROGRESS_ACTIONS = [
  'lesson_progress:read',
  'lesson_progress:list',
  'lesson_progress:record',
] as const;

export type LessonProgressAction = (typeof LESSON_PROGRESS_ACTIONS)[number];

/**
 * The same content verbs an activity actually supports.
 *
 * `delete` is absent because there is no DELETE grant on `learning_activities`
 * and no endpoint that would use one: deleting an activity would cascade its
 * assessment, its questions and every learner's attempt into nothing. Archiving
 * is the supported way to withdraw one, and it keeps the attempts already
 * recorded against it interpretable.
 */
export const LEARNING_ACTIVITY_ACTIONS = [
  'learning_activity:create',
  'learning_activity:read',
  'learning_activity:list',
  'learning_activity:update',
  'learning_activity:publish',
  'learning_activity:archive',
] as const;

export type LearningActivityAction = (typeof LEARNING_ACTIVITY_ACTIONS)[number];

/**
 * `start` and `submit` are separate actions, not one `write`.
 *
 * They are different authorities over different objects: `start` is asked about
 * an assessment before any attempt exists, `submit` about an attempt that does.
 * Collapsing them would mean the decision that opened an attempt could be
 * replayed to close somebody else's.
 */
export const ASSESSMENT_ATTEMPT_ACTIONS = [
  'assessment_attempt:start',
  'assessment_attempt:read',
  'assessment_attempt:list',
  'assessment_attempt:submit',
  /**
   * Reading the MARKED PAPER — per-question correctness, the learner's own
   * selections, the correct answers and the explanation.
   *
   * Separate from `:read`, which returns the attempt and its marks. They are
   * different disclosures and they open at different moments: a teacher may
   * read an unreleased attempt in order to decide about it, while nobody may
   * review one. Collapsing them would make the release gate unreachable.
   */
  'assessment_attempt:review',
  /**
   * Deciding that the learner may see their result. Held by the teacher of the
   * shared class or an administrator of the learner's school — never by the
   * learner, and never by their guardian.
   */
  'assessment_attempt:release',
] as const;

export type AssessmentAttemptAction = (typeof ASSESSMENT_ATTEMPT_ACTIONS)[number];

/**
 * `start`, `save` and `submit` are three actions, not one `write`.
 *
 * They are different authorities over different objects at different moments.
 * `start` is asked about a lab before any session exists. `save` is asked about
 * a live session and is repeatable and reversible — it moves the scene the
 * learner is building. `submit` is asked once, is final, and produces a verdict
 * the school will act on.
 *
 * Collapsing `save` into `submit` would mean the decision that permitted a
 * keystroke could be replayed to mark the work; collapsing `start` into either
 * would mean the decision that opened a session could be replayed to close
 * somebody else's.
 */
export const EXPERIMENT_SESSION_ACTIONS = [
  'experiment_session:start',
  'experiment_session:read',
  'experiment_session:list',
  'experiment_session:save',
  'experiment_session:submit',
] as const;

export type ExperimentSessionAction = (typeof EXPERIMENT_SESSION_ACTIONS)[number];

/**
 * A notebook is created, read, listed, renamed and deleted by one person.
 *
 * There is no `notebook:share`. `NOTE_ACTIONS` has `note:share` because a note
 * can be shared; adding the verb here would create a vocabulary for something
 * no policy branch implements, which is how a taxonomy starts advertising
 * capabilities the system does not have.
 */
export const NOTEBOOK_ACTIONS = [
  'notebook:create',
  'notebook:read',
  'notebook:list',
  'notebook:update',
  'notebook:delete',
] as const;

export type NotebookAction = (typeof NOTEBOOK_ACTIONS)[number];

/**
 * An artifact is registered, read, listed and deleted. THERE IS NO `:update`.
 *
 * Not an oversight to be filled in later: `edu_app` holds no UPDATE grant on
 * `student_artifacts`, because a mutable row would make the storage quota a
 * suggestion — register one byte, then edit the row to 25 MiB. Replacing an
 * artifact is a delete and a fresh registration, and the vocabulary says so.
 *
 * There is also no `:download`. Nothing serves these bytes, because
 * docs/security/file-security.md makes "never serve unscanned content" a
 * non-negotiable and this platform has no scanner. When the pipeline exists,
 * adding the action here is the visible diff that says so.
 */
export const STUDENT_ARTIFACT_ACTIONS = [
  'student_artifact:create',
  'student_artifact:read',
  'student_artifact:list',
  'student_artifact:delete',
] as const;

export type StudentArtifactAction = (typeof STUDENT_ARTIFACT_ACTIONS)[number];

export type NoteAction = (typeof NOTE_ACTIONS)[number];
export type UserAction = (typeof USER_ACTIONS)[number];
export type ProfileAction = (typeof PROFILE_ACTIONS)[number];
export type OrganizationAction = (typeof ORGANIZATION_ACTIONS)[number];
export type ClassAction = (typeof CLASS_ACTIONS)[number];
export type TeacherAssignmentAction = (typeof TEACHER_ASSIGNMENT_ACTIONS)[number];
export type RoleGrantAction = (typeof ROLE_GRANT_ACTIONS)[number];
export type ClassMembershipAction = (typeof CLASS_MEMBERSHIP_ACTIONS)[number];
export type GuardianRelationshipAction = (typeof GUARDIAN_RELATIONSHIP_ACTIONS)[number];

export type Action =
  | AiConversationAction
  | NoteAction
  | UserAction
  | ProfileAction
  | RoleGrantAction
  | OrganizationAction
  | ClassAction
  | TeacherAssignmentAction
  | ClassMembershipAction
  | GuardianRelationshipAction
  | EducationLevelAction
  | ContentAction
  | ClassCourseAssignmentAction
  | LessonProgressAction
  | ObjectiveProgressAction
  | LearningActivityAction
  | AssessmentAttemptAction
  | ExperimentSessionAction
  | NotebookAction
  | StudentArtifactAction;

/**
 * What may be done with a tutor conversation.
 *
 * THERE IS NO `ai_conversation:update` AND NO `ai_conversation:moderate`.
 *
 * The first is absent because the only mutable things about a conversation are
 * its title and its status, and both are covered by `archive` and `rename` —
 * naming the two operations that exist is more honest than one verb that means
 * "change something".
 *
 * The second is absent because moderation is not a separate ACTION; it is a
 * separate reason for granting `read`. Making it its own action would let a
 * future caller ask for `moderate` on a conversation and get a different answer
 * from `read`, which is precisely the drift that produces two policies
 * disagreeing about one boundary.
 */
export const AI_CONVERSATION_ACTIONS = [
  'ai_conversation:create',
  'ai_conversation:read',
  'ai_conversation:list',
  'ai_conversation:speak',
  'ai_conversation:rename',
  'ai_conversation:archive',
] as const;
export type AiConversationAction = (typeof AI_CONVERSATION_ACTIONS)[number];

export const ALL_ACTIONS: readonly Action[] = [
  ...NOTE_ACTIONS,
  ...USER_ACTIONS,
  ...PROFILE_ACTIONS,
  ...ROLE_GRANT_ACTIONS,
  ...ORGANIZATION_ACTIONS,
  ...CLASS_ACTIONS,
  ...TEACHER_ASSIGNMENT_ACTIONS,
  ...CLASS_MEMBERSHIP_ACTIONS,
  ...GUARDIAN_RELATIONSHIP_ACTIONS,
  ...EDUCATION_LEVEL_ACTIONS,
  ...CURRICULUM_ACTIONS,
  ...COURSE_ACTIONS,
  ...COURSE_UNIT_ACTIONS,
  ...LESSON_ACTIONS,
  ...CLASS_COURSE_ASSIGNMENT_ACTIONS,
  ...LESSON_PROGRESS_ACTIONS,
  ...OBJECTIVE_PROGRESS_ACTIONS,
  ...LEARNING_ACTIVITY_ACTIONS,
  ...ASSESSMENT_ATTEMPT_ACTIONS,
  ...EXPERIMENT_SESSION_ACTIONS,
  ...NOTEBOOK_ACTIONS,
  ...STUDENT_ARTIFACT_ACTIONS,
  ...AI_CONVERSATION_ACTIONS,
];

/** The two permissions that split authoring from publishing. See ADR 0009. */
export const CONTENT_AUTHOR_PERMISSION = 'content:author';
export const CONTENT_PUBLISH_PERMISSION = 'content:publish';

/** Maps each action to the resource kind it may be evaluated against. */
export function resourceKindForAction(action: Action): ResourceKind {
  const prefix = action.slice(0, action.indexOf(':'));
  return prefix as ResourceKind;
}
