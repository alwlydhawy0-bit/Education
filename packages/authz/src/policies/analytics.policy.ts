import { allow, deny, type Decision } from '../decision.ts';
import type {
  AnalyticsReportAction,
  AnalyticsReportResource,
  AuthorizationContext,
} from '../types.ts';

/**
 * Who may be told what about a school.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE FIRST DOMAIN WHERE THE SUBJECT IS AN INSTITUTION
 * ---------------------------------------------------------------------------
 *
 * Every other policy on this platform decides about a thing somebody made and
 * compares the actor to its owner. Here there is no owner: an analytics report
 * is an aggregate over the work of hundreds of people, and the question is not
 * "is this yours" but "is this yours to know".
 *
 * Three consequences run through everything below.
 *
 * THE TENANT IS THE CEILING AND NOTHING CROSSES IT. `actorIsOrgAdmin` on the
 * resource means "administers THIS organization" — the role and the tenant
 * resolved together, in SQL, by the same helpers the RLS policies call. The
 * policy never sees a bare "is an admin" it could pair with the wrong school.
 * Section 2C's cross-tenant rule is that pairing, and it is made in the
 * repository so this file cannot get it wrong.
 *
 * SENIORITY DOES NOT WIDEN, IT NARROWS. An administrator sees more schools-worth
 * of totals than a teacher and FEWER named children: `at_risk` is refused to
 * them entirely. That inverts the usual shape of a permission hierarchy and it
 * is deliberate — see the verb below.
 *
 * A LEARNER IS NEVER A READER HERE, at any grain, under any role. Not their own
 * class's completion rate, not their own school's index. That is not a
 * conservative default to be relaxed later: a mastery index computed from the
 * STAFF vantage point contains results a teacher has not released, so serving
 * one to a learner would announce a mark through a side door. The database
 * enforces the same thing, and this is the layer that can explain it.
 */
export function analyticsPolicy(
  _ctx: AuthorizationContext,
  action: AnalyticsReportAction,
  report: AnalyticsReportResource,
): Decision {
  const verb = action.slice(action.indexOf(':') + 1);

  // ── The executive dashboard: administrators of this school, and nobody else ──
  if (verb === 'read_school') {
    if (report.actorIsOrgAdmin) {
      return allow(action, report.id, 'analytics_report.administers_this_school');
    }
    /**
     * `reveal`, and this is the one deny in the file that explains itself.
     *
     * Section 2E asks that a teacher reaching for school-wide executive metrics
     * be refused with 403. A 404 would be wrong here for once: the caller is a
     * member of staff asking about their own school, an institution they can
     * see the front door of. Pretending the school's dashboard does not exist
     * would read as a broken product, and they would try again.
     *
     * There is no id to protect either — the "resource" is the school they
     * already work in. What is withheld is the numbers, and saying "this is an
     * administrator's report" withholds them without pretending.
     */
    return deny(action, report.id, 'analytics_report.not_an_administrator', 'reveal');
  }

  // ── Course performance: this school's administrators, or this class's teacher ──
  if (verb === 'read_courses') {
    if (report.actorIsOrgAdmin) {
      return allow(action, report.id, 'analytics_report.administers_this_school');
    }
    if (report.actorTeachesClass === true) {
      return allow(action, report.id, 'analytics_report.teaches_this_class');
    }
    // `hide`, unlike the branch above, because this grain NAMES A CLASS. A
    // teacher probing class ids from another school must not learn which ones
    // are real, and 404 is what says nothing.
    return deny(action, report.id, 'analytics_report.not_this_class', 'hide');
  }

  // ── At-risk learners: the teacher who will act, and only them ──
  if (verb === 'at_risk') {
    /**
     * THE FERPA LINE, AND THE PLACE IT IS DRAWN.
     *
     * Section 2B: "high-level admin reports must summarize trends without
     * leaking raw individual student responses outside assigned
     * teacher-student boundaries."
     *
     * This is the one endpoint in the domain that returns rows about NAMED
     * CHILDREN, so it is the one where that sentence has to be a rule rather
     * than an intention. The rule is: the named list goes to the adult who has
     * the teacher-student relationship, and to nobody else.
     *
     * AN ADMINISTRATOR IS REFUSED. Not given a shorter list, not given
     * pseudonyms — refused. A head teacher running a school does not need the
     * names of struggling children to do it; their legitimate view is the COUNT
     * in `analytics_course_performance`, which tells them where to put
     * resources without handing them a list of individual minors to browse.
     * Somebody who genuinely needs a name can ask the teacher, and that
     * conversation leaves a trace that an endpoint does not.
     *
     * `reveal`, because this is a deliberate boundary a colleague should be
     * told about rather than left to think the endpoint is broken.
     */
    if (report.actorIsOrgAdmin && report.actorTeachesClass !== true) {
      return deny(action, report.id, 'analytics_report.at_risk_is_for_teachers', 'reveal');
    }
    if (report.actorTeachesClass === true) {
      return allow(action, report.id, 'analytics_report.teaches_this_class');
    }
    return deny(action, report.id, 'analytics_report.not_this_class', 'hide');
  }

  // ── Export: the same data through a different door, so a separate decision ──
  if (verb === 'export') {
    /**
     * EXPORT IS AUTHORIZED SEPARATELY FROM READ, AND IT IS NOT WIDER.
     *
     * A caller who may read the school grain may export it; a teacher who may
     * read their class's row may export that. Nothing new is unlocked. What the
     * separate verb buys is the AUDIT TRAIL: `analytics.exported` is a distinct
     * security event, so an investigation can tell "opened the dashboard" from
     * "took a copy of the school's data onto a laptop". Those are different
     * acts even when the bytes are identical.
     */
    if (report.grain === 'school') {
      if (report.actorIsOrgAdmin) {
        return allow(action, report.id, 'analytics_report.administers_this_school');
      }
      return deny(action, report.id, 'analytics_report.not_an_administrator', 'reveal');
    }
    if (report.actorIsOrgAdmin || report.actorTeachesClass === true) {
      return allow(action, report.id, 'analytics_report.authorized_for_this_grain');
    }
    return deny(action, report.id, 'analytics_report.not_this_class', 'hide');
  }

  return deny(action, report.id, 'analytics_report.no_matching_grant', 'hide');
}
