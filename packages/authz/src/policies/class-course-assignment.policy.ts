import { allow, deny, type Decision } from '../decision.ts';
import {
  hasPermission,
  isPlatformOperator,
  Role,
  type AuthorizationContext,
  type ClassCourseAssignmentAction,
  type ClassCourseAssignmentResource,
} from '../types.ts';

/**
 * Policy for assigning a course to a class.
 *
 * This edge decides which learners a piece of published content actually
 * reaches, so it is an authorization INPUT rather than descriptive scheduling
 * data — the same status `class_memberships` has, and for the same reason: a
 * wrong row here silently changes what a child is shown.
 *
 * TWO RULES DO THE WORK.
 *
 * 1. **Tenancy is checked before anything else.** A course may be assigned only
 *    to a class in its own organization, or from the global catalog. This is
 *    what makes the whole feature safe to add: an assignment can only ever
 *    NARROW the set of content a learner sees, because it cannot reach content
 *    the catalog rules would not already have permitted.
 *
 * 2. **Only PUBLISHED content is assignable.** A draft is unreviewed by
 *    definition (ADR 0009). Allowing a draft to be assigned would let content
 *    become visible to a class the instant it was published, with nobody
 *    looking at the assignment again.
 */
export function classCourseAssignmentPolicy(
  ctx: AuthorizationContext,
  action: ClassCourseAssignmentAction,
  assignment: ClassCourseAssignmentResource,
): Decision {
  const { actor, relationships } = ctx;

  if (isPlatformOperator(actor)) {
    return allow(action, assignment.id, 'class_course_assignment.platform_operator');
  }

  const teachesThisClass = relationships.teachesClasses.includes(assignment.classId);
  const memberOfThisClass = relationships.memberOfClasses.includes(assignment.classId);
  const sameOrganization =
    actor.organizationId !== null && assignment.classOrganizationId === actor.organizationId;
  const isOrgAdmin = sameOrganization && actor.roles.includes(Role.ADMIN);

  // --- Reads -------------------------------------------------------------
  // A learner may see which courses their own class studies: that list is the
  // syllabus, and hiding it from the people following it protects nothing.
  if (action === 'class_course_assignment:read' || action === 'class_course_assignment:list') {
    if (memberOfThisClass) {
      return allow(action, assignment.id, 'class_course_assignment.member_of_class');
    }
    if (teachesThisClass) {
      return allow(action, assignment.id, 'class_course_assignment.teacher_of_class');
    }
    if (isOrgAdmin) {
      return allow(action, assignment.id, 'class_course_assignment.admin_same_org');
    }
    return deny(action, assignment.id, 'class_course_assignment.not_attached_to_class', 'hide');
  }

  // --- Writes ------------------------------------------------------------
  // Managing a class's syllabus is the same standing as managing its roster
  // (0014): a teacher OF THAT CLASS, or an administrator of its organization.
  // Choosing among published courses is running the class; it is not deciding
  // what content exists, which a teacher may not do.
  if (!hasPermission(actor, 'classes:manage')) {
    return deny(action, assignment.id, 'class_course_assignment.missing_permission', 'hide');
  }
  if (!sameOrganization) {
    // Covers both directions of the cross-tenant attempt: another school's
    // class, and an actor with no organization at all.
    return deny(
      action,
      assignment.id,
      'class_course_assignment.cross_organization_forbidden',
      'hide',
    );
  }
  if (!teachesThisClass && !isOrgAdmin) {
    return deny(action, assignment.id, 'class_course_assignment.requires_teacher_or_admin', 'hide');
  }

  // The course must belong to this class's school, or to the global catalog.
  // Checked AFTER the actor's standing, so an actor who may not touch this
  // class at all learns nothing about the course either way.
  const courseIsGlobal = assignment.courseOrganizationId === null;
  if (!courseIsGlobal && assignment.courseOrganizationId !== assignment.classOrganizationId) {
    return deny(
      action,
      assignment.id,
      'class_course_assignment.course_outside_class_organization',
      'hide',
    );
  }

  if (action === 'class_course_assignment:create') {
    if (!assignment.classIsActive) {
      return deny(action, assignment.id, 'class_course_assignment.class_is_not_active', 'reveal');
    }
    if (assignment.courseStatus !== 'published') {
      // `reveal`: the actor can see this course (they are an editor in its
      // school, or it is global), so hiding it would only be confusing.
      return deny(
        action,
        assignment.id,
        'class_course_assignment.only_published_may_be_assigned',
        'reveal',
      );
    }
    if (assignment.state !== 'active') {
      return deny(action, assignment.id, 'class_course_assignment.must_start_active', 'reveal');
    }
    return allow(action, assignment.id, 'class_course_assignment.teacher_or_admin_of_class');
  }

  if (action === 'class_course_assignment:remove') {
    if (assignment.state === 'archived') {
      // Archived means the class itself ended. That record is history.
      return deny(action, assignment.id, 'class_course_assignment.archived_is_final', 'reveal');
    }
    if (assignment.state !== 'active') {
      return deny(action, assignment.id, 'class_course_assignment.already_withdrawn', 'reveal');
    }
    return allow(action, assignment.id, 'class_course_assignment.teacher_or_admin_of_class');
  }

  return deny(action, assignment.id, 'class_course_assignment.no_matching_grant', 'hide');
}
