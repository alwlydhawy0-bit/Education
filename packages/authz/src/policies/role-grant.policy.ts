import { allow, deny, type Decision } from '../decision.ts';
import {
  hasPermission,
  Role,
  type AuthorizationContext,
  type RoleGrantAction,
  type RoleGrantResource,
} from '../types.ts';

/**
 * Policy for granting and revoking roles.
 *
 * This is the most escalation-sensitive decision in the platform, so it is
 * written as a sequence of refusals rather than a search for a reason to allow.
 *
 * Three containment rules do the real work:
 *
 *   1. NOBODY may change their own roles. Not an administrator, not a security
 *      administrator. Self-grant is the shortest path from "compromised admin
 *      account" to "permanent full control", and there is no legitimate use for
 *      it — an operator needing a new role asks another operator.
 *
 *   2. Only a security administrator may grant the PRIVILEGED roles (`admin`,
 *      `security_admin`). An ordinary admin managing a school cannot mint peers
 *      or superiors, so compromising one admin does not compound.
 *
 *   3. Every grant is confined to the actor's own organization, and a scoped
 *      grant must name a scope. A global grant of a privileged role is refused
 *      outright: it would apply across every school on the platform.
 */
const PRIVILEGED_ROLES: readonly Role[] = [Role.ADMIN, Role.SECURITY_ADMIN];

export function roleGrantPolicy(
  ctx: AuthorizationContext,
  action: RoleGrantAction,
  grant: RoleGrantResource,
): Decision {
  const { actor } = ctx;

  if (!hasPermission(actor, 'roles:assign')) {
    return deny(action, grant.id, 'role_grant.missing_permission', 'hide');
  }

  // Rule 1 — no self-modification of privileges, for anyone.
  if (grant.targetUserId === actor.id) {
    return deny(action, grant.id, 'role_grant.self_modification_forbidden', 'reveal');
  }

  const isSecurityAdmin = actor.roles.includes(Role.SECURITY_ADMIN);
  const isAdmin = actor.roles.includes(Role.ADMIN);

  if (!isSecurityAdmin && !isAdmin) {
    return deny(action, grant.id, 'role_grant.requires_admin_role', 'hide');
  }

  // Rule 3 — the target must belong to the actor's own organization.
  const sameOrg =
    grant.targetUserOrganizationId !== null &&
    grant.targetUserOrganizationId === actor.organizationId;

  if (!sameOrg) {
    return deny(action, grant.id, 'role_grant.cross_organization_forbidden', 'hide');
  }

  // Rule 2 — privileged roles are a security administrator's to give.
  if (PRIVILEGED_ROLES.includes(grant.role) && !isSecurityAdmin) {
    return deny(action, grant.id, 'role_grant.privileged_role_requires_security_admin', 'reveal');
  }

  // A privileged role must never be granted globally: it would reach every
  // organization on the platform, not just this one.
  if (PRIVILEGED_ROLES.includes(grant.role) && grant.scopeType === 'global') {
    return deny(action, grant.id, 'role_grant.privileged_role_may_not_be_global', 'reveal');
  }

  // A non-global grant must actually name its target, or it is not scoped at all.
  if (grant.scopeType !== 'global' && grant.scopeId === null) {
    return deny(action, grant.id, 'role_grant.scoped_grant_requires_scope_id', 'reveal');
  }

  // An organization-scoped grant may only ever name the actor's organization.
  if (grant.scopeType === 'organization' && grant.scopeId !== actor.organizationId) {
    return deny(action, grant.id, 'role_grant.scope_outside_organization', 'reveal');
  }

  return allow(
    action,
    grant.id,
    isSecurityAdmin ? 'role_grant.security_admin' : 'role_grant.admin_same_org',
  );
}
