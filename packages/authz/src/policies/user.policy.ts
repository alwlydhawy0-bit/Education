import { allow, deny, type Decision } from '../decision.ts';
import {
  hasPermission,
  Role,
  type AuthorizationContext,
  type UserAction,
  type UserResource,
} from '../types.ts';

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

  // `user:list` is not about one record, so it is answered by permission and
  // scope alone. The LISTING itself is still scoped to the actor's organization
  // by the query — a permission is never a licence to enumerate the platform.
  if (action === 'user:list') {
    if (!hasPermission(actor, 'users:list')) {
      return deny(action, target.id, 'user.missing_list_permission', 'hide');
    }
    if (target.organizationId === null || target.organizationId !== actor.organizationId) {
      return deny(action, target.id, 'user.list_outside_organization', 'hide');
    }
    return allow(action, target.id, 'user.list_within_organization');
  }

  if (target.id === actor.id) {
    // Self-service: a user may read and edit their own profile, but may not
    // suspend themselves (that is an operator action with audit consequences).
    if (action === 'user:suspend') {
      return deny(action, target.id, 'user.self_suspend_not_permitted', 'reveal');
    }
    return allow(action, target.id, 'user.self');
  }

  const sameOrg = target.organizationId !== null && target.organizationId === actor.organizationId;

  // Suspension is an account-lifecycle action reserved to security
  // administrators. An ordinary admin can read and correct a record but cannot
  // lock a person out of the platform, so the two capabilities stay separable
  // and compromising an admin account does not immediately deny service.
  if (action === 'user:suspend') {
    if (!hasPermission(actor, 'users:suspend')) {
      return deny(action, target.id, 'user.missing_suspend_permission', 'hide');
    }
    if (actor.roles.includes(Role.SECURITY_ADMIN) && sameOrg) {
      return allow(action, target.id, 'user.security_admin_same_org');
    }
    return deny(action, target.id, 'user.suspend_requires_security_admin', 'hide');
  }

  // A permission is NECESSARY but never SUFFICIENT: it says the actor's roles
  // permit this kind of action in general, and the scope check below says
  // whether it is permitted against THIS record.
  const requiredPermission = action === 'user:update' ? 'users:update' : 'users:read';
  const hasRequired = hasPermission(actor, requiredPermission);

  if (actor.roles.includes(Role.SECURITY_ADMIN) && sameOrg && hasRequired) {
    return allow(action, target.id, 'user.security_admin_same_org');
  }

  if (actor.roles.includes(Role.ADMIN) && sameOrg && hasRequired) {
    return allow(action, target.id, 'user.admin_same_org');
  }

  // Teachers and guardians get read-only visibility of the people they are
  // actually responsible for — never write access, never enumeration.
  if (action === 'user:read') {
    if (
      actor.roles.includes(Role.TEACHER) &&
      relationships.teacherOf.includes(target.id) &&
      sameOrg &&
      hasPermission(actor, 'students:read')
    ) {
      return allow(action, target.id, 'user.assigned_teacher');
    }
    if (
      actor.roles.includes(Role.GUARDIAN) &&
      relationships.guardianOf.includes(target.id) &&
      hasPermission(actor, 'students:read')
    ) {
      return allow(action, target.id, 'user.verified_guardian');
    }
  }

  return deny(action, target.id, 'user.no_matching_grant', 'hide');
}
