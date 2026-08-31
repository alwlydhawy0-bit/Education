import { allow, deny, type Decision } from '../decision.ts';
import {
  isPlatformOperator,
  Role,
  type AuthorizationContext,
  type LessonProgressAction,
  type LessonProgressResource,
} from '../types.ts';

/**
 * Policy for a learner's progress on a lesson.
 *
 * This is the platform's first per-child record authored by that child, and the
 * shape of the rule is different from everything before it:
 *
 * **WRITING IS THE LEARNER'S ALONE.** There is no branch below through which a
 * teacher, an administrator, a guardian or a platform operator may author a
 * claim about what somebody else studied. That is not an oversight to be
 * relaxed later — a progress row is a statement in the learner's own voice, and
 * a record a third party can write is not evidence of anything.
 *
 * **READING YOUR OWN IS UNCONDITIONAL.** The write gate asks whether the
 * learner still reaches the lesson; the read gate does not ask at all. That
 * asymmetry IS the retention rule: removing a child from a class stops them
 * adding to their record, and must not erase the record they already have from
 * their own view.
 *
 * Every third-party read passes through a relationship built in an earlier
 * task — a verified guardianship (003), a shared class (004), or a course
 * assignment to that class (006). None of them is a role check alone.
 */
export function lessonProgressPolicy(
  ctx: AuthorizationContext,
  action: LessonProgressAction,
  progress: LessonProgressResource,
): Decision {
  const { actor, relationships } = ctx;
  const isOwn = progress.learnerId === actor.id;

  // --- Writing -----------------------------------------------------------
  // Checked BEFORE the platform-operator branch, deliberately. Everywhere else
  // in this codebase an operator may do anything; here they may not, because
  // "who studied this" is not an administrative fact and no operator should be
  // able to manufacture one. An operator who needs to correct a record does it
  // out of band, where `granted_by`-style attribution applies.
  if (action === 'lesson_progress:record') {
    if (!isOwn) {
      return deny(action, progress.id, 'lesson_progress.only_the_learner_may_record', 'hide');
    }
    if (!progress.learnerMayStudy) {
      // Covers all of: never had access, lost it, the lesson is unpublished,
      // the course was withdrawn, the class was archived. A learner cannot tell
      // these apart, which is the point — and it is why this is `hide`.
      return deny(action, progress.id, 'lesson_progress.lesson_not_accessible', 'hide');
    }
    return allow(action, progress.id, 'lesson_progress.own_and_accessible');
  }

  // --- Reading -----------------------------------------------------------
  if (isPlatformOperator(actor)) {
    return allow(action, progress.id, 'lesson_progress.platform_operator');
  }

  if (isOwn) {
    // No access check. See the retention rule above.
    return allow(action, progress.id, 'lesson_progress.own_record');
  }

  if (relationships.guardianOf.includes(progress.learnerId)) {
    // VERIFIED guardianships only — the snapshot filters pending and revoked
    // claims before the policy ever sees them (ADR 0008, Task 003).
    return allow(action, progress.id, 'lesson_progress.verified_guardian');
  }

  if (progress.observableByActorAsTeacher) {
    return allow(action, progress.id, 'lesson_progress.teacher_of_shared_class');
  }

  // An administrator OF THAT SCHOOL. `admin` specifically: a security
  // administrator manages accounts and lockouts, and giving them every child's
  // learning record would merge two unrelated authorities in one compromise.
  // An actor with no organization matches nothing.
  if (
    actor.roles.includes(Role.ADMIN) &&
    actor.organizationId !== null &&
    progress.learnerOrganizationId === actor.organizationId
  ) {
    return allow(action, progress.id, 'lesson_progress.admin_same_organization');
  }

  return deny(action, progress.id, 'lesson_progress.not_visible', 'hide');
}
