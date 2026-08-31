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

  const sameOrg =
    membership.classOrganizationId !== null &&
    membership.classOrganizationId === actor.organizationId;

  // --- The roster as a whole ---------------------------------------------
  // Enumerating a class is an administrative read, NOT a consequence of being
  // in it. A student who is enrolled can see the class and their own row; the
  // list of everyone else is a separate grant they do not hold.
  if (action === 'class_membership:list') {
    if (membership.memberUserId !== null) {
      // A roster read must not be aimed at one person: allowing that would let
      // this branch stand in for `class_membership:read`.
      return deny(action, membership.id, 'class_membership.list_is_not_row_scoped', 'hide');
    }
    if (relationships.teachesClasses.includes(membership.classId)) {
      return allow(action, membership.id, 'class_membership.teacher_of_class');
    }
    if (sameOrg && actor.roles.includes(Role.ADMIN) && hasPermission(actor, 'classes:manage')) {
      return allow(action, membership.id, 'class_membership.admin_same_org');
    }
    return deny(action, membership.id, 'class_membership.roster_requires_teacher_or_admin', 'hide');
  }

  // Every remaining action is about one named member. Without one there is no
  // subject to decide about, so there is nothing to allow.
  if (membership.memberUserId === null) {
    return deny(action, membership.id, 'class_membership.member_required', 'hide');
  }
  const memberUserId = membership.memberUserId;

  // An ended membership is historical. It grants nothing and is not editable;
  // re-adding someone is a new membership, which keeps the audit trail honest.
  if (membership.state === 'ended' && action === 'class_membership:manage') {
    return deny(action, membership.id, 'class_membership.ended_is_immutable', 'reveal');
  }

  if (action === 'class_membership:read') {
    if (memberUserId === actor.id) {
      return allow(action, membership.id, 'class_membership.self');
    }
    if (relationships.teachesClasses.includes(membership.classId)) {
      return allow(action, membership.id, 'class_membership.teacher_of_class');
    }
    if (sameOrg && actor.roles.includes(Role.ADMIN) && hasPermission(actor, 'classes:manage')) {
      return allow(action, membership.id, 'class_membership.admin_same_org');
    }
    if (relationships.guardianOf.includes(memberUserId)) {
      return allow(action, membership.id, 'class_membership.guardian_of_member');
    }
  }

  if (action === 'class_membership:manage') {
    if (!hasPermission(actor, 'classes:manage')) {
      return deny(action, membership.id, 'class_membership.missing_permission', 'hide');
    }

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
