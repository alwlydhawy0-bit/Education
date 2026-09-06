import { allow, deny, type Decision } from '../decision.ts';
import {
  isPlatformOperator,
  Role,
  type AuthorizationContext,
  type ExperimentSessionAction,
  type ExperimentSessionResource,
} from '../types.ts';

/**
 * Policy for one learner's run at one interactive lab.
 *
 * This is `assessmentAttemptPolicy`'s rule applied to a different record, and
 * it is written to the same shape ON PURPOSE. Both answer "who may look at what
 * this child did?" about the same child, and a second, subtly different answer
 * to a settled question is not extra safety — it is a disagreement waiting to
 * be exploited from whichever side is looser.
 *
 * **WORKING IS THE LEARNER'S ALONE.** There is no branch below through which a
 * teacher, an administrator, a guardian or a platform operator may open, save
 * or submit a lab session in somebody else's name. All three write actions are
 * checked BEFORE the platform-operator branch — the same inversion of the usual
 * ordering as in `lessonProgressPolicy` and `assessmentAttemptPolicy`, for the
 * same reason: a session an adult can create is not evidence that a child did
 * anything.
 *
 * That is a stronger rule than it looks, because a lab is the one place on this
 * platform where finishing the work is a matter of reaching a state rather than
 * choosing an answer. If an adult could save into a child's session, they could
 * assemble the passing circuit themselves and let the trigger mark it — and the
 * record would say the child did it. The denial below is what stops that, and
 * it is why `save` is a write action rather than an incidental part of reading.
 *
 * **AND THE POLICY NEVER SEES THE VERDICT.** `ExperimentSessionResource` carries
 * no `passed`, deliberately. Authorization decides who may look at a result; it
 * takes no part in deciding one.
 */
export function experimentSessionPolicy(
  ctx: AuthorizationContext,
  action: ExperimentSessionAction,
  session: ExperimentSessionResource,
): Decision {
  const { actor, relationships } = ctx;
  const isOwn = session.learnerId === actor.id;

  // --- Writing ------------------------------------------------------------
  if (
    action === 'experiment_session:start' ||
    action === 'experiment_session:save' ||
    action === 'experiment_session:submit'
  ) {
    if (!isOwn) {
      return deny(action, session.id, 'experiment_session.only_the_learner_may_work', 'hide');
    }
    if (!session.learnerMayWork) {
      // §3 INSTANT STATE ISOLATION, asked here and again by the RLS update
      // policy on the write itself. Covers all of: never had access, lost it,
      // the activity is a draft, the activity was archived, the course was
      // withdrawn, the class ended. A learner cannot tell those apart, which is
      // why this is `hide` — the difference is a fact about their school's
      // administration, not about them, and a 403 on a draft would confirm the
      // id names something real.
      return deny(action, session.id, 'experiment_session.lab_not_accessible', 'hide');
    }
    if (action !== 'experiment_session:start' && session.state !== 'in_progress') {
      // `reveal`: it is their own session and they can already see it, so
      // hiding it would only confuse. Refused independently by the RLS update
      // policy, whose USING clause requires `status = 'in_progress'`, and by the
      // submit trigger.
      return deny(action, session.id, 'experiment_session.already_submitted', 'reveal');
    }
    return allow(action, session.id, 'experiment_session.own_and_accessible');
  }

  // --- Reading ------------------------------------------------------------
  if (isPlatformOperator(actor)) {
    return allow(action, session.id, 'experiment_session.platform_operator');
  }

  if (isOwn) {
    // No access check, and that absence is the retention rule. A learner who has
    // left the class keeps the record of the labs they ran; an administrative
    // change to a timetable must not delete a child's work from their own view.
    return allow(action, session.id, 'experiment_session.own_session');
  }

  if (relationships.guardianOf.includes(session.learnerId)) {
    // VERIFIED guardianships only — pending and revoked claims are filtered out
    // of the snapshot before the policy ever sees them (ADR 0008, Task 003).
    return allow(action, session.id, 'experiment_session.verified_guardian');
  }

  if (session.observableByActorAsTeacher) {
    return allow(action, session.id, 'experiment_session.teacher_of_shared_class');
  }

  // An administrator OF THAT SCHOOL. `admin` specifically: a security
  // administrator manages accounts and lockouts, and every child's lab work is a
  // different authority that should not ride along with it. An actor with no
  // organization matches nothing.
  if (
    actor.roles.includes(Role.ADMIN) &&
    actor.organizationId !== null &&
    session.learnerOrganizationId === actor.organizationId
  ) {
    return allow(action, session.id, 'experiment_session.admin_same_organization');
  }

  return deny(action, session.id, 'experiment_session.not_visible', 'hide');
}
