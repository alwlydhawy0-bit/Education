import { allow, deny, type Decision } from '../decision.ts';
import {
  isPlatformOperator,
  Role,
  type AssessmentAttemptAction,
  type AssessmentAttemptResource,
  type AuthorizationContext,
} from '../types.ts';

/**
 * Policy for one learner's attempt at one assessment.
 *
 * This is `lessonProgressPolicy`'s rule applied to a heavier record, and it is
 * written to the same shape ON PURPOSE. Both answer "who may look at what this
 * child did?", and a second, subtly different answer to a settled question is
 * not extra safety — it is a disagreement waiting to be exploited from
 * whichever side is looser.
 *
 * What makes an attempt heavier is that the platform, not the child, wrote the
 * conclusion. A progress row says "I studied this". An attempt says "you scored
 * 4 out of 10", and a teacher will act on it. That raises the cost of every
 * mistake here without changing who should be reading it.
 *
 * **WRITING IS THE LEARNER'S ALONE.** There is no branch below through which a
 * teacher, an administrator, a guardian or a platform operator may open or
 * submit an attempt in somebody else's name. `start` and `submit` are both
 * checked BEFORE the platform-operator branch — the same inversion of the usual
 * ordering as in `lessonProgressPolicy`, for the same reason: an attempt an
 * adult can create is not evidence that a child sat anything.
 *
 * **AND THE POLICY NEVER SEES A SCORE.** `AssessmentAttemptResource` carries no
 * marks, deliberately. Authorization decides who may look at a result; it takes
 * no part in computing one. A policy that could read the score would invite a
 * branch that decided something based on whether a child had done well.
 */
export function assessmentAttemptPolicy(
  ctx: AuthorizationContext,
  action: AssessmentAttemptAction,
  attempt: AssessmentAttemptResource,
): Decision {
  const { actor, relationships } = ctx;
  const isOwn = attempt.learnerId === actor.id;

  // --- Writing ------------------------------------------------------------
  if (action === 'assessment_attempt:start' || action === 'assessment_attempt:submit') {
    if (!isOwn) {
      return deny(action, attempt.id, 'assessment_attempt.only_the_learner_may_attempt', 'hide');
    }
    if (!attempt.learnerMayAttempt) {
      // Covers all of: never had access, lost it, the activity is a draft, the
      // activity was archived, the course was withdrawn, the class ended. A
      // learner cannot tell these apart, which is why this is `hide` — the
      // difference is a fact about their school's administration, not a fact
      // about them, and a 403 on a draft would confirm the id names something
      // real.
      return deny(action, attempt.id, 'assessment_attempt.assessment_not_accessible', 'hide');
    }
    if (action === 'assessment_attempt:submit' && attempt.state !== 'in_progress') {
      // `reveal`: it is their own attempt and they can already see it, so
      // hiding it would only be confusing. Refused independently by the RLS
      // update policy and by the submit trigger.
      return deny(action, attempt.id, 'assessment_attempt.already_submitted', 'reveal');
    }
    return allow(action, attempt.id, 'assessment_attempt.own_and_accessible');
  }

  // --- Reading ------------------------------------------------------------
  if (isPlatformOperator(actor)) {
    return allow(action, attempt.id, 'assessment_attempt.platform_operator');
  }

  if (isOwn) {
    // No access check, and that absence is the retention rule. A learner who
    // has left the class keeps the record of what they sat; an administrative
    // change to a timetable must not delete a child's marks from their own
    // view.
    return allow(action, attempt.id, 'assessment_attempt.own_attempt');
  }

  if (relationships.guardianOf.includes(attempt.learnerId)) {
    // VERIFIED guardianships only — pending and revoked claims are filtered out
    // of the snapshot before the policy ever sees them (ADR 0008, Task 003).
    return allow(action, attempt.id, 'assessment_attempt.verified_guardian');
  }

  if (attempt.observableByActorAsTeacher) {
    return allow(action, attempt.id, 'assessment_attempt.teacher_of_shared_class');
  }

  // An administrator OF THAT SCHOOL. `admin` specifically: a security
  // administrator manages accounts and lockouts, and every child's marks is a
  // different authority that should not ride along with it. An actor with no
  // organization matches nothing.
  if (
    actor.roles.includes(Role.ADMIN) &&
    actor.organizationId !== null &&
    attempt.learnerOrganizationId === actor.organizationId
  ) {
    return allow(action, attempt.id, 'assessment_attempt.admin_same_organization');
  }

  return deny(action, attempt.id, 'assessment_attempt.not_visible', 'hide');
}
