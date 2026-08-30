import { allow, deny, type Decision } from '../decision.js';
import { Role, type AuthorizationContext, type UserAction, type UserResource } from '../types.js';

/**
 * Policy for user profile records.
 *
 * Note the asymmetry against `notePolicy`: an administrator CAN read and
 * suspend user records, because account lifecycle is exactly what the role
 * exists for — but that grant is scoped to their own organization, so an admin
 * of one school cannot enumerate another school's roster.
 */
export function userPolicy(
  ctx: AuthorizationContext,
  action: UserAction,
  target: UserResource,
): Decision {
  const { actor, relationships } = ctx;

  if (target.id === actor.id) {
    // Self-service: a user may read and edit their own profile, but may not
    // suspend themselves (that is an operator action with audit consequences).
    if (action === 'user:suspend') {
      return deny(action, target.id, 'user.self_suspend_not_permitted', 'reveal');
    }
    return allow(action, target.id, 'user.self');
  }

  const sameOrg = target.organizationId !== null && target.organizationId === actor.organizationId;

  if (actor.roles.includes(Role.SECURITY_ADMIN) && sameOrg) {
    return allow(action, target.id, 'user.security_admin_same_org');
  }

  if (actor.roles.includes(Role.ADMIN) && sameOrg) {
    return allow(action, target.id, 'user.admin_same_org');
  }

  // Teachers and guardians get read-only visibility of the people they are
  // actually responsible for — never write access, never enumeration.
  if (action === 'user:read') {
    if (
      actor.roles.includes(Role.TEACHER) &&
      relationships.teacherOf.includes(target.id) &&
      sameOrg
    ) {
      return allow(action, target.id, 'user.assigned_teacher');
    }
    if (actor.roles.includes(Role.GUARDIAN) && relationships.guardianOf.includes(target.id)) {
      return allow(action, target.id, 'user.verified_guardian');
    }
  }

  return deny(action, target.id, 'user.no_matching_grant', 'hide');
}
