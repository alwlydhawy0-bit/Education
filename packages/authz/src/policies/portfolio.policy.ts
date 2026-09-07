import { allow, deny, type Decision } from '../decision.ts';
import type {
  AuthorizationContext,
  StudentPortfolioAction,
  StudentPortfolioResource,
  StudentProjectAction,
  StudentProjectResource,
} from '../types.ts';

/**
 * Who may do what with a learner's projects and their portfolio.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS POLICY IS NOT ASKED
 * ---------------------------------------------------------------------------
 *
 * IT NEVER DECIDES THE PUBLIC PATH. A stranger holding a share link has no
 * actor, so there is no `ctx` to evaluate and this file is not consulted at
 * all. That boundary is held by two other things: the RLS policies in migration
 * 0028, which admit a row only while a matching key is set on the transaction,
 * and `public-view.ts`, which decides what may be said about an admitted row.
 *
 * Adding a "public" branch here would be actively harmful, not merely
 * redundant. It would create a second place that decides publication, free to
 * drift from the database's answer, and the drift would be invisible because
 * both would keep returning rows. So the rule stands where it can be enforced
 * without an actor, and this file governs only what a logged-in person may do.
 *
 * ---------------------------------------------------------------------------
 * THE OWNER PUBLISHES, THE TEACHER FEATURES, AND THE TWO DO NOT MEET
 * ---------------------------------------------------------------------------
 *
 * Section 2B gives teachers and administrators a review power over projects in
 * their classes. It is deliberately read plus one verb wide:
 *
 *   - They may READ a submitted project in a class they are responsible for,
 *     whatever its visibility. A `private` project inside a school class is
 *     private from OTHER LEARNERS, not from the adult accountable for the work.
 *
 *   - They may FEATURE it, which moves `status` and nothing else.
 *
 *   - They may NOT update it, delete it, or change its `visibility`. A teacher
 *     cannot publish a child's work to the internet on the child's behalf, and
 *     the refusal is written here, in `student_project_review_guard`, and in the
 *     column CHECK — three layers, because this is the one power in this domain
 *     whose misuse a child could not undo.
 *
 * A DRAFT IS INVISIBLE TO EVERY ADULT. Not "visible but not editable": absent.
 * A draft is work in progress that nobody has offered, and a supervisor reading
 * one is reading over a child's shoulder. Submitting is the act that consents.
 */
export function studentProjectPolicy(
  ctx: AuthorizationContext,
  action: StudentProjectAction,
  project: StudentProjectResource,
): Decision {
  const isOwner = project.ownerId === ctx.actor.id;
  const verb = action.slice(action.indexOf(':') + 1);
  const isDraft = project.status === 'draft';

  if (isOwner) {
    if (verb === 'feature') {
      // NOBODY FEATURES THEIR OWN WORK, including a teacher who happens to own
      // a project in a class they teach. Featuring is a distinction one person
      // confers on another; a self-conferred one is not a distinction, it is a
      // self-assigned badge that a school's leaderboard would then rank.
      //
      // `reveal`, because the owner plainly knows the project exists and the
      // honest answer is that this is not theirs to do.
      return deny(action, project.id, 'student_project.no_self_feature', 'reveal');
    }
    return allow(action, project.id, 'student_project.owner');
  }

  if (verb === 'read' || verb === 'list') {
    // A CLASSMATE, and note the three conditions. The project must SAY it is
    // shareable — a `private` project is invisible to classmates even though
    // they share the class, which is the entire meaning of the column.
    if (
      !isDraft &&
      (project.visibility === 'class' || project.visibility === 'public') &&
      project.sharesClassWithActor
    ) {
      return allow(action, project.id, 'student_project.classmate_of_shared_work');
    }

    if (!isDraft && project.reviewableByActor) {
      return allow(action, project.id, 'student_project.reviewer_of_this_class');
    }
  }

  if (verb === 'feature' && !isDraft && project.reviewableByActor) {
    return allow(action, project.id, 'student_project.reviewer_of_this_class');
  }

  // `hide`, for every remaining case at once: another learner's project, a
  // draft, another school's, a classmate attempting to edit, a reviewer
  // attempting to delete, and an id that names nothing. A learner walking ids
  // must not be able to tell those apart, and an adult refused a write learns
  // nothing about whether the row exists.
  return deny(action, project.id, 'student_project.no_matching_grant', 'hide');
}

/**
 * The portfolio: the owner, and nobody else, ever.
 *
 * As short as `notebookPolicy` and for a related reason — there is no
 * relationship branch, so there is nothing for a teacher, a guardian, an
 * administrator or an operator to match on. See `StudentPortfolioResource` for
 * why the teacher who may read the projects still may not read the arrangement.
 *
 * THE ONE PIECE OF LOGIC HERE IS THE REFUSAL TO PUBLISH AN EMPTY PORTFOLIO, and
 * it protects the learner from a specific disappointment rather than the
 * platform from an attack. Publishing a portfolio whose every project is
 * `private` produces a live public URL showing a name, a bio and nothing else —
 * the learner believes they have shared their work, and a stranger following
 * the link sees a blank page. The database cannot refuse this, because "how
 * many public projects does this portfolio list" is a question about other
 * tables. So it is refused here, with `reveal`, because the learner needs to be
 * told what to fix.
 *
 * UNPUBLISHING IS NEVER REFUSED. Not when the portfolio is already unpublished,
 * not for any reason. Revocation is the one operation in this domain that must
 * never fail for a policy reason: a child who wants their work off the internet
 * is not in a mood to debug a 409, and an idempotent success is both safer and
 * truer — the state they asked for is the state they end in.
 */
export function studentPortfolioPolicy(
  ctx: AuthorizationContext,
  action: StudentPortfolioAction,
  portfolio: StudentPortfolioResource,
): Decision {
  if (portfolio.ownerId !== ctx.actor.id) {
    // `hide`, always. A 403 would confirm that this learner has a portfolio,
    // which for an unpublished one is itself private.
    return deny(action, portfolio.id, 'student_portfolio.not_owner', 'hide');
  }

  const verb = action.slice(action.indexOf(':') + 1);

  if (verb === 'publish' && portfolio.publicItemCount === 0) {
    return deny(action, portfolio.id, 'student_portfolio.nothing_public_to_show', 'reveal');
  }

  return allow(action, portfolio.id, 'student_portfolio.owner');
}
