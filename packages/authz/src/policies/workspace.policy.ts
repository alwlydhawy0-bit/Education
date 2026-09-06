import { allow, deny, type Decision } from '../decision.ts';
import type {
  AuthorizationContext,
  NotebookAction,
  NotebookResource,
  StudentArtifactAction,
  StudentArtifactResource,
} from '../types.ts';

/**
 * Policies for the student workspace: notebooks and personal artifacts.
 *
 * ONE RULE, WRITTEN ONCE: the owner, and nobody else, ever.
 *
 * These are the shortest policies on the platform, and their shortness is the
 * point. `notePolicy` is longer because a note has a visibility its owner can
 * open; every other policy here is longer still because it has a relationship
 * graph to consult. A notebook and an artifact have neither, so there is no
 * branch for a teacher, a guardian, an administrator or a platform operator to
 * match on — not a branch that returns deny, but no branch at all.
 *
 * THREE ABSENCES ARE DELIBERATE AND SHOULD NOT BE "FIXED" WITHOUT A REVIEW:
 *
 *   1. NO ADMINISTRATOR ACCESS. Administrators manage accounts, not a minor's
 *      private files. This matches `notePolicy`, which has refused admins since
 *      Task 002, and the same audited break-glass path is still hypothetical.
 *
 *   2. NO PLATFORM-OPERATOR ACCESS. Unusual: an operator can read an
 *      assessment attempt, a lab session and a progress row. Those are records
 *      the PLATFORM authored about a child. A notebook is a record the CHILD
 *      authored, and operating the service does not require reading it. Where
 *      an operator genuinely needs to act — a legal hold, a deletion request —
 *      that is an audited administrative procedure, not an implicit read.
 *
 *   3. NO GUARDIAN ACCESS, even to an artifact hanging off a note the child
 *      HAS shared with them. Sharing a note is a decision about that note's
 *      text. A file is the hardest thing to un-share and the easiest to
 *      misjudge the contents of, so it does not ride along on a share the
 *      child made about something else.
 */

export function notebookPolicy(
  ctx: AuthorizationContext,
  action: NotebookAction,
  notebook: NotebookResource,
): Decision {
  if (notebook.ownerId === ctx.actor.id) {
    return allow(action, notebook.id, 'notebook.owner');
  }
  // `hide`, always. A 403 would confirm that the id names a real notebook,
  // which is the one bit an attacker enumerating ids is trying to buy.
  return deny(action, notebook.id, 'notebook.not_owner', 'hide');
}

export function studentArtifactPolicy(
  ctx: AuthorizationContext,
  action: StudentArtifactAction,
  artifact: StudentArtifactResource,
): Decision {
  if (artifact.ownerId === ctx.actor.id) {
    return allow(action, artifact.id, 'student_artifact.owner');
  }
  return deny(action, artifact.id, 'student_artifact.not_owner', 'hide');
}
