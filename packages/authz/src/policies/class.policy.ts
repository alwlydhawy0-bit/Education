import { allow, deny, type Decision } from '../decision.ts';
import {
  hasPermission,
  isPlatformOperator,
  Role,
  type AuthorizationContext,
  type ClassAction,
  type ClassResource,
} from '../types.ts';

/**
 * Policy for classes.
 *
 * A class is an authorization hub, not just a label: teacher-to-student access
 * is derived from shared class membership (ADR 0008). So deciding which classes
 * exist, and who is attached to them, is administration — a teacher RUNS a
 * class, they do not decide which classes exist or which organization owns them.
 *
 * Reading is broader than writing: anyone actually attached to a class (a
 * teacher of it, a member of it) may see it.
 */
export function classPolicy(
  ctx: AuthorizationContext,
  action: ClassAction,
  klass: ClassResource,
): Decision {
  const { actor, relationships } = ctx;

  if (isPlatformOperator(actor)) {
    return allow(action, klass.id, 'class.platform_operator');
  }

  const sameOrg = actor.organizationId !== null && klass.organizationId === actor.organizationId;

  // --- Reads ------------------------------------------------------------
  if (action === 'class:read' || action === 'class:list') {
    if (relationships.teachesClasses.includes(klass.id)) {
      return allow(action, klass.id, 'class.teacher_of_class');
    }
    if (relationships.memberOfClasses.includes(klass.id)) {
      return allow(action, klass.id, 'class.member_of_class');
    }
    if (sameOrg && actor.roles.includes(Role.ADMIN) && hasPermission(actor, 'classes:manage')) {
      return allow(action, klass.id, 'class.admin_same_org');
    }
    return deny(action, klass.id, 'class.no_matching_grant', 'hide');
  }

  // --- Writes: administrators only --------------------------------------
  if (!hasPermission(actor, 'classes:manage')) {
    return deny(action, klass.id, 'class.missing_permission', 'hide');
  }
  if (!actor.roles.includes(Role.ADMIN)) {
    // Deliberately excludes teachers. Letting a teacher create or reshape
    // classes would make "teacher of this class" partly self-asserted, and that
    // relationship is what unlocks students' shared work.
    return deny(action, klass.id, 'class.write_requires_admin', 'hide');
  }
  if (!sameOrg) {
    return deny(action, klass.id, 'class.cross_organization_forbidden', 'hide');
  }

  // An archived class is settled history. Reopening it is not supported; a new
  // term gets a new class, which keeps rosters and their audit trail distinct.
  if (klass.state === 'archived') {
    return deny(action, klass.id, 'class.archived_is_immutable', 'reveal');
  }

  return allow(action, klass.id, 'class.admin_same_org');
}
