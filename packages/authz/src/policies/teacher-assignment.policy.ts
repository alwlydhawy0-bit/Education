import { allow, deny, type Decision } from '../decision.ts';
import {
  hasPermission,
  isPlatformOperator,
  Role,
  type AuthorizationContext,
  type TeacherAssignmentAction,
  type TeacherAssignmentResource,
} from '../types.ts';

/**
 * Policy for teacher assignments.
 *
 * The rule that matters: **a teacher may never create or remove an assignment,
 * including their own.** "Teacher of this class" is what grants access to the
 * shared work of every student in it, so allowing self-assignment would make
 * that access self-asserted. Assignment is an administrator's act, scoped to
 * their own organization.
 *
 * Reading is wider: a teacher sees their own assignments and their co-teachers
 * on a class they share, because knowing who else teaches your class is
 * ordinary, non-sensitive information.
 */
export function teacherAssignmentPolicy(
  ctx: AuthorizationContext,
  action: TeacherAssignmentAction,
  assignment: TeacherAssignmentResource,
): Decision {
  const { actor, relationships } = ctx;

  if (isPlatformOperator(actor)) {
    return allow(action, assignment.id, 'teacher_assignment.platform_operator');
  }

  const sameOrg =
    actor.organizationId !== null &&
    assignment.classOrganizationId !== null &&
    assignment.classOrganizationId === actor.organizationId;

  if (action === 'teacher_assignment:read') {
    if (assignment.teacherId === actor.id) {
      return allow(action, assignment.id, 'teacher_assignment.own');
    }
    if (relationships.teachesClasses.includes(assignment.classId)) {
      return allow(action, assignment.id, 'teacher_assignment.co_teacher');
    }
    if (sameOrg && actor.roles.includes(Role.ADMIN) && hasPermission(actor, 'classes:manage')) {
      return allow(action, assignment.id, 'teacher_assignment.admin_same_org');
    }
    return deny(action, assignment.id, 'teacher_assignment.no_matching_grant', 'hide');
  }

  // --- create / remove: administrators only -----------------------------
  if (!hasPermission(actor, 'classes:manage')) {
    return deny(action, assignment.id, 'teacher_assignment.missing_permission', 'hide');
  }
  if (!actor.roles.includes(Role.ADMIN)) {
    return deny(action, assignment.id, 'teacher_assignment.write_requires_admin', 'hide');
  }
  if (!sameOrg) {
    return deny(action, assignment.id, 'teacher_assignment.cross_organization_forbidden', 'hide');
  }

  // Even an administrator may not assign themselves: the same
  // no-self-modification rule that governs role grants. An admin who should also
  // teach is assigned by another administrator.
  if (assignment.teacherId === actor.id) {
    return deny(action, assignment.id, 'teacher_assignment.self_assignment_forbidden', 'reveal');
  }

  if (action === 'teacher_assignment:remove' && assignment.state === 'ended') {
    return deny(action, assignment.id, 'teacher_assignment.already_ended', 'reveal');
  }

  return allow(action, assignment.id, 'teacher_assignment.admin_same_org');
}
