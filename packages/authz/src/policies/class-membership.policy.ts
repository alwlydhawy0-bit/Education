import { allow, deny, type Decision } from '../decision.ts';
import {
  hasPermission,
  Role,
  type AuthorizationContext,
  type ClassMembershipAction,
  type ClassMembershipResource,
} from '../types.ts';

/**
 * Policy for class membership.
 *
 * Class membership is an authorization INPUT, not merely descriptive data:
 * teacher-to-student access is derived from it. A wrong row here silently
 * widens who can read a child's work, so managing membership is treated as a
 * privileged operation rather than routine bookkeeping.
 */
export function classMembershipPolicy(
  ctx: AuthorizationContext,
  action: ClassMembershipAction,
  membership: ClassMembershipResource,
): Decision {
  const { actor, relationships } = ctx;

  // An ended membership is historical. It grants nothing and is not editable;
  // re-adding someone is a new membership, which keeps the audit trail honest.
  if (membership.state === 'ended' && action === 'class_membership:manage') {
    return deny(action, membership.id, 'class_membership.ended_is_immutable', 'reveal');
  }

  if (action === 'class_membership:read') {
    if (membership.memberUserId === actor.id) {
      return allow(action, membership.id, 'class_membership.self');
    }
    if (relationships.teachesClasses.includes(membership.classId)) {
      return allow(action, membership.id, 'class_membership.teacher_of_class');
    }
    if (relationships.guardianOf.includes(membership.memberUserId)) {
      return allow(action, membership.id, 'class_membership.guardian_of_member');
    }
  }

  if (action === 'class_membership:manage') {
    if (!hasPermission(actor, 'classes:manage')) {
      return deny(action, membership.id, 'class_membership.missing_permission', 'hide');
    }

    const sameOrg =
      membership.classOrganizationId !== null &&
      membership.classOrganizationId === actor.organizationId;

    if (!sameOrg) {
      return deny(action, membership.id, 'class_membership.cross_organization_forbidden', 'hide');
    }

    // A teacher may manage the roster of a class they actually teach...
    if (relationships.teachesClasses.includes(membership.classId)) {
      return allow(action, membership.id, 'class_membership.teacher_of_class');
    }

    // ...and an administrator may manage any class in their own organization.
    if (actor.roles.includes(Role.ADMIN)) {
      return allow(action, membership.id, 'class_membership.admin_same_org');
    }
  }

  return deny(action, membership.id, 'class_membership.no_matching_grant', 'hide');
}
