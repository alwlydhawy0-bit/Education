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
  | 'lesson_progress';

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

/** A learner's running record for one lesson. Forward-only; see ADR 0010. */
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

export type Resource =
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
  | LessonProgressResource;

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
export const COURSE_ACTIONS = CONTENT_VERBS.map((v) => `course:${v}` as const);
export const COURSE_UNIT_ACTIONS = CONTENT_VERBS.map((v) => `course_unit:${v}` as const);
export const LESSON_ACTIONS = CONTENT_VERBS.map((v) => `lesson:${v}` as const);

export type CurriculumAction = `curriculum:${ContentVerb}`;
export type CourseAction = `course:${ContentVerb}`;
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
export const LESSON_PROGRESS_ACTIONS = [
  'lesson_progress:read',
  'lesson_progress:list',
  'lesson_progress:record',
] as const;

export type LessonProgressAction = (typeof LESSON_PROGRESS_ACTIONS)[number];

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
  | LessonProgressAction;

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
];

/** The two permissions that split authoring from publishing. See ADR 0009. */
export const CONTENT_AUTHOR_PERMISSION = 'content:author';
export const CONTENT_PUBLISH_PERMISSION = 'content:publish';

/** Maps each action to the resource kind it may be evaluated against. */
export function resourceKindForAction(action: Action): ResourceKind {
  const prefix = action.slice(0, action.indexOf(':'));
  return prefix as ResourceKind;
}
