import { allow, deny, type Decision } from '../decision.ts';
import {
  isPlatformOperator,
  Role,
  type AuthorizationContext,
  type OrganizationAction,
  type OrganizationResource,
} from '../types.ts';

/**
 * Policy for organizations (schools).
 *
 * The distinction that carries this file: a **platform operator** is
 * `security_admin` held at GLOBAL scope, whereas a school's own security
 * administrator holds it scoped to their organization. Only the former may
 * create an organization — a school's administrator manages their school, they
 * do not get to conjure new ones.
 *
 * That role cannot be granted through the API at all: migration 0013 refuses to
 * assign any privileged role globally, so a platform operator is provisioned out
 * of band by someone with database access. Making the escalation path impossible
 * to reach over HTTP is the point.
 */
export function organizationPolicy(
  ctx: AuthorizationContext,
  action: OrganizationAction,
  organization: OrganizationResource,
): Decision {
  const { actor } = ctx;
  const platformOperator = isPlatformOperator(actor);

  if (action === 'organization:create') {
    return platformOperator
      ? allow(action, organization.id, 'organization.platform_operator')
      : deny(action, organization.id, 'organization.create_requires_platform_operator', 'hide');
  }

  if (platformOperator) {
    return allow(action, organization.id, 'organization.platform_operator');
  }

  // Everyone else sees and edits only their own organization. An actor with no
  // organization matches nothing, so a stray grant cannot become platform-wide
  // reach.
  const isOwnOrganization =
    actor.organizationId !== null && actor.organizationId === organization.id;

  if (!isOwnOrganization) {
    return deny(action, organization.id, 'organization.outside_actor_organization', 'hide');
  }

  if (action === 'organization:read' || action === 'organization:list') {
    return allow(action, organization.id, 'organization.own');
  }

  if (action === 'organization:update') {
    if (actor.roles.includes(Role.ADMIN) || actor.roles.includes(Role.SECURITY_ADMIN)) {
      return allow(action, organization.id, 'organization.admin_of_own_organization');
    }
    return deny(action, organization.id, 'organization.update_requires_admin', 'hide');
  }

  return deny(action, organization.id, 'organization.no_matching_grant', 'hide');
}
