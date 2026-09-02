import { allow, deny, type Decision } from '../decision.ts';
import {
  isPlatformOperator,
  Role,
  type AuthorizationContext,
  type ObjectiveProgressAction,
  type ObjectiveProgressResource,
} from '../types.ts';

/**
 * Policy for a learner's standing against one learning objective.
 *
 * The same five readers as `lessonProgressPolicy`, through the same
 * relationships, deliberately restated rather than reinvented. It is the same
 * question about the same child, and this file exists only because the resource
 * reaches its lesson through an objective rather than holding one directly.
 *
 * **THERE IS NO WRITE BRANCH, AND NO WRITE ACTION TO PUT IN ONE.**
 * `ObjectiveProgressAction` is `read` and `list`. Mastery is derived from
 * evidence on every read, and evidence is emitted by database triggers on
 * events that already happened — so there is no request through which a
 * learner, a teacher, an administrator or a platform operator could assert what
 * somebody understands. "The client submitted MASTERED" is not a threat this
 * policy has to refuse; it is a request the vocabulary cannot express.
 *
 * **THE POLICY NEVER SEES A MASTERY STATE.** `ObjectiveProgressResource`
 * carries none, on purpose. Authorization decides who may look at a judgement;
 * it takes no part in making one. A policy that could read the level would
 * invite a branch that behaved differently for a child who had done well.
 *
 * **READING YOUR OWN IS UNCONDITIONAL**, exactly as in 0018: a learner who has
 * left the class keeps the record of what they demonstrated. An administrative
 * change to a timetable must not delete a child's evidence from their own view.
 */
export function objectiveProgressPolicy(
  ctx: AuthorizationContext,
  action: ObjectiveProgressAction,
  progress: ObjectiveProgressResource,
): Decision {
  const { actor, relationships } = ctx;

  if (isPlatformOperator(actor)) {
    return allow(action, progress.id, 'objective_progress.platform_operator');
  }

  if (progress.learnerId === actor.id) {
    return allow(action, progress.id, 'objective_progress.own_record');
  }

  if (relationships.guardianOf.includes(progress.learnerId)) {
    // VERIFIED guardianships only — pending and revoked claims are filtered out
    // of the snapshot before the policy ever sees them (ADR 0008, Task 003).
    return allow(action, progress.id, 'objective_progress.verified_guardian');
  }

  if (progress.observableByActorAsTeacher) {
    // Computed by the database from the class roster AND the course assignment,
    // on the objective's own lesson. Holding `teacherOf` is not enough: "I teach
    // them somewhere" and "I reach that lesson somewhere" would both be true for
    // a teacher who reaches the course through a different class, and would leak.
    return allow(action, progress.id, 'objective_progress.teacher_of_shared_class');
  }

  // An administrator OF THAT SCHOOL. `admin` specifically: a security
  // administrator manages accounts and lockouts, and every child's learning
  // record is a different authority that must not ride along with it (VULN-020).
  // An actor with no organization matches nothing.
  if (
    actor.roles.includes(Role.ADMIN) &&
    actor.organizationId !== null &&
    progress.learnerOrganizationId === actor.organizationId
  ) {
    return allow(action, progress.id, 'objective_progress.admin_same_organization');
  }

  // `hide`: a reader with no standing must not learn that this learner, or this
  // objective, exists.
  return deny(action, progress.id, 'objective_progress.not_visible', 'hide');
}
