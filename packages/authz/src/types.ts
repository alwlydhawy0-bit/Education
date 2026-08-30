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
export interface Actor {
  readonly id: string;
  readonly roles: readonly Role[];
  readonly status: ActorStatus;
  /** Null for actors not attached to a school/organization. */
  readonly organizationId: string | null;
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
  /** Student ids for which this actor is a verified, active guardian. */
  readonly guardianOf: readonly string[];
  /** Student ids currently assigned to this actor as a teacher. */
  readonly teacherOf: readonly string[];
}

export const EMPTY_RELATIONSHIPS: RelationshipSnapshot = Object.freeze({
  guardianOf: Object.freeze([]) as readonly string[],
  teacherOf: Object.freeze([]) as readonly string[],
});

export interface AuthorizationContext {
  readonly actor: Actor;
  readonly relationships: RelationshipSnapshot;
}

// --- Resources -----------------------------------------------------------
// A resource passed to the engine is always the SERVER's copy of the record.

export type ResourceKind = 'note' | 'user';

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

export type Resource = NoteResource | UserResource;

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

export const USER_ACTIONS = ['user:read', 'user:update', 'user:suspend'] as const;

export type NoteAction = (typeof NOTE_ACTIONS)[number];
export type UserAction = (typeof USER_ACTIONS)[number];
export type Action = NoteAction | UserAction;

export const ALL_ACTIONS: readonly Action[] = [...NOTE_ACTIONS, ...USER_ACTIONS];

/** Maps each action to the resource kind it may be evaluated against. */
export function resourceKindForAction(action: Action): ResourceKind {
  const prefix = action.slice(0, action.indexOf(':'));
  return prefix as ResourceKind;
}
