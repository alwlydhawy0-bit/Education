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
}

export const EMPTY_RELATIONSHIPS: RelationshipSnapshot = Object.freeze({
  guardianOf: Object.freeze([]) as readonly string[],
  teacherOf: Object.freeze([]) as readonly string[],
  teachesClasses: Object.freeze([]) as readonly string[],
  memberOfClasses: Object.freeze([]) as readonly string[],
});

export interface AuthorizationContext {
  readonly actor: Actor;
  readonly relationships: RelationshipSnapshot;
}

// --- Resources -----------------------------------------------------------
// A resource passed to the engine is always the SERVER's copy of the record.

export type ResourceKind =
  'note' | 'user' | 'profile' | 'role_grant' | 'class_membership' | 'guardian_relationship';

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

export interface ClassMembershipResource extends BaseResource {
  readonly kind: 'class_membership';
  readonly classId: string;
  readonly classOrganizationId: string | null;
  readonly memberUserId: string;
  readonly state: 'active' | 'ended';
}

export interface GuardianRelationshipResource extends BaseResource {
  readonly kind: 'guardian_relationship';
  readonly guardianId: string;
  readonly childId: string;
  readonly state: 'pending' | 'verified' | 'revoked';
}

export type Resource =
  | NoteResource
  | UserResource
  | ProfileResource
  | RoleGrantResource
  | ClassMembershipResource
  | GuardianRelationshipResource;

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

export const CLASS_MEMBERSHIP_ACTIONS = [
  'class_membership:read',
  'class_membership:manage',
] as const;

export const GUARDIAN_RELATIONSHIP_ACTIONS = [
  'guardian_relationship:read',
  'guardian_relationship:verify',
  'guardian_relationship:revoke',
] as const;

export type NoteAction = (typeof NOTE_ACTIONS)[number];
export type UserAction = (typeof USER_ACTIONS)[number];
export type ProfileAction = (typeof PROFILE_ACTIONS)[number];
export type RoleGrantAction = (typeof ROLE_GRANT_ACTIONS)[number];
export type ClassMembershipAction = (typeof CLASS_MEMBERSHIP_ACTIONS)[number];
export type GuardianRelationshipAction = (typeof GUARDIAN_RELATIONSHIP_ACTIONS)[number];

export type Action =
  | NoteAction
  | UserAction
  | ProfileAction
  | RoleGrantAction
  | ClassMembershipAction
  | GuardianRelationshipAction;

export const ALL_ACTIONS: readonly Action[] = [
  ...NOTE_ACTIONS,
  ...USER_ACTIONS,
  ...PROFILE_ACTIONS,
  ...ROLE_GRANT_ACTIONS,
  ...CLASS_MEMBERSHIP_ACTIONS,
  ...GUARDIAN_RELATIONSHIP_ACTIONS,
];

/** Maps each action to the resource kind it may be evaluated against. */
export function resourceKindForAction(action: Action): ResourceKind {
  const prefix = action.slice(0, action.indexOf(':'));
  return prefix as ResourceKind;
}
