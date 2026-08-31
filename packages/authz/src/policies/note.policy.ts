import { allow, deny, type Decision } from '../decision.ts';
import { Role, type AuthorizationContext, type NoteAction, type NoteResource } from '../types.ts';

/**
 * Policy for the student notebook.
 *
 * The notebook is the platform's most privacy-sensitive ordinary resource: it
 * holds a minor's unfiltered working thoughts. The policy is therefore written
 * privacy-first, and two of its rules are deliberate product decisions that
 * should not be "fixed" without a conscious review:
 *
 *   1. An administrator has NO implicit read access to note content. Admins
 *      manage accounts, not private student writing. A future audited
 *      break-glass path is tracked in docs/security/authorization.md; it does
 *      not exist today.
 *   2. Teacher and guardian access is opt-in by the STUDENT via `visibility`,
 *      and additionally requires a real relationship edge. Either condition
 *      alone is insufficient.
 */
export function notePolicy(
  ctx: AuthorizationContext,
  action: NoteAction,
  note: NoteResource,
): Decision {
  const { actor, relationships } = ctx;
  const isOwner = note.ownerId === actor.id;

  // A soft-deleted note behaves as if it does not exist, for everyone.
  // Keeping the row is a data-retention concern, not an access grant.
  if (note.state === 'deleted') {
    return deny(action, note.id, 'note.deleted', 'hide');
  }

  // --- Owner ------------------------------------------------------------
  if (isOwner) {
    if (note.state === 'archived' && action !== 'note:read' && action !== 'note:delete') {
      return deny(action, note.id, 'note.archived.read_only', 'reveal');
    }
    return allow(action, note.id, 'note.owner');
  }

  // From here the actor is NOT the owner. Only reads are ever possible, and
  // only through an explicit share. Mutating another student's notebook is
  // never permitted by any role.
  if (action !== 'note:read') {
    return deny(action, note.id, 'note.non_owner_may_not_mutate', 'hide');
  }

  // Cross-organization access is refused even when a relationship edge exists.
  // A stale edge left behind by a transfer must not survive as an access grant.
  const sameOrg = note.organizationId !== null && note.organizationId === actor.organizationId;

  if (
    actor.roles.includes(Role.TEACHER) &&
    note.visibility === 'shared_with_teacher' &&
    relationships.teacherOf.includes(note.ownerId) &&
    sameOrg
  ) {
    return allow(action, note.id, 'note.shared_with_assigned_teacher');
  }

  if (
    actor.roles.includes(Role.GUARDIAN) &&
    note.visibility === 'shared_with_guardian' &&
    relationships.guardianOf.includes(note.ownerId)
  ) {
    // Guardianship is a family relationship, not an organizational one, so it
    // is intentionally not gated on `sameOrg`.
    return allow(action, note.id, 'note.shared_with_verified_guardian');
  }

  // Default deny. Administrators and moderators fall through to here by design.
  return deny(action, note.id, 'note.no_matching_grant', 'hide');
}
