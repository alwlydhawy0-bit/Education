import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_REPORT_ACTIONS,
  analyticsPolicy,
  type AnalyticsReportAction,
  type AnalyticsReportResource,
  type AuthorizationContext,
  type Decision,
  type DenyDecision,
} from '@edu/authz';

/**
 * The decision table for institutional analytics.
 *
 * PURE FUNCTIONS, SO EVERY CELL IS CHEAP. `tests/security/analytics.test.ts`
 * proves the boundary holds over HTTP with both gates up;
 * `tests/integration/rls-analytics.test.ts` proves the database holds it with
 * the application deleted; the layered-defence block proves the application
 * holds it with RLS bypassed. THIS enumerates the grid, including the
 * combinations that are awkward to construct end to end — an administrator who
 * also teaches a class, an actor with no organization at all, a class-grained
 * request from somebody who holds neither claim.
 *
 * THE DISCLOSURE IS ASSERTED AS OFTEN AS THE EFFECT. In this domain the two
 * refusals mean different things to the person reading them: a teacher told
 * "this is an administrator's report" knows who to ask, and a caller probing
 * class ids from another school must learn nothing at all. Getting that
 * backwards is not a cosmetic bug — one direction leaks the existence of a
 * class, the other makes a colleague think the product is broken.
 */

const ACTOR = 'actor-id';

const ctx = (): AuthorizationContext =>
  ({
    actor: { id: ACTOR, roles: [], organizationId: 'org' },
    relationships: { teachesStudents: [], guardianOf: [], sharesClassWith: [] },
  }) as unknown as AuthorizationContext;

const school = (
  overrides: Partial<AnalyticsReportResource> = {},
): AnalyticsReportResource => ({
  kind: 'analytics_report',
  id: 'school:org',
  grain: 'school',
  organizationId: 'org',
  classId: null,
  actorIsOrgAdmin: false,
  actorTeachesClass: null,
  ...overrides,
});

const klass = (overrides: Partial<AnalyticsReportResource> = {}): AnalyticsReportResource => ({
  ...school(),
  id: 'class:c1',
  grain: 'class',
  classId: 'c1',
  actorTeachesClass: false,
  ...overrides,
});

const decide = (action: AnalyticsReportAction, resource: AnalyticsReportResource) =>
  analyticsPolicy(ctx(), action, resource);

/**
 * Narrows a decision to a refusal.
 *
 * `disclosure` lives only on `DenyDecision`, which is the type system saying
 * what this suite keeps asserting: an allow has nothing to disclose. Going
 * through this helper means a test that expected a refusal and got an allow
 * fails on THAT, rather than on a missing field three lines later.
 */
function refusal(decision: Decision): DenyDecision {
  expect(decision.effect, `expected a refusal, got ${decision.effect}: ${decision.reason}`).toBe(
    'deny',
  );
  return decision as DenyDecision;
}

// ---------------------------------------------------------------------------
// Totality
// ---------------------------------------------------------------------------

describe('every declared verb has an answer', () => {
  it.each(ANALYTICS_REPORT_ACTIONS)('%s decides for every shape', (action) => {
    // A verb that fell through to a thrown error rather than a decision would
    // be invisible until the day somebody wrote the endpoint.
    for (const resource of [
      school(),
      school({ actorIsOrgAdmin: true }),
      klass(),
      klass({ actorTeachesClass: true }),
      klass({ actorIsOrgAdmin: true }),
    ]) {
      const decision = decide(action, resource);
      expect(['allow', 'deny'], `${action}/${resource.id}`).toContain(decision.effect);
    }
  });

  it('an unknown verb falls through to a hidden denial, not an allow', () => {
    // The final `return deny(...)`. A default that allowed would turn every
    // future typo in an action string into an open door.
    const bogus = 'analytics_report:read_everything' as AnalyticsReportAction;
    const decision = refusal(decide(bogus, school({ actorIsOrgAdmin: true })));
    expect(decision.disclosure).toBe('hide');
  });

  it('every reason is namespaced to the resource kind', () => {
    // A reason reaches a security event and, for `reveal`, a colleague's
    // screen. An unnamespaced one is ambiguous in both places.
    for (const action of ANALYTICS_REPORT_ACTIONS) {
      expect(decide(action, klass()).reason).toMatch(/^analytics_report\./);
    }
  });

  it('every decision names the action and the id it was made about', () => {
    // `unwrap` re-checks both, which is what stops a decision taken about one
    // report being spent on another.
    for (const action of ANALYTICS_REPORT_ACTIONS) {
      const decision = decide(action, klass());
      expect(decision.action, action).toBe(action);
      expect(decision.resourceId, action).toBe('class:c1');
    }
  });
});

// ---------------------------------------------------------------------------
// The executive dashboard
// ---------------------------------------------------------------------------

describe('read_school — the institution’s own report', () => {
  it('allows an administrator of THIS school', () => {
    expect(decide('analytics_report:read_school', school({ actorIsOrgAdmin: true })).effect).toBe(
      'allow',
    );
  });

  it('REFUSES A TEACHER WITH reveal, not hide', () => {
    /**
     * Section 2E asks for 403 here specifically, and the policy agrees for a
     * reason worth stating: the caller is staff asking about the school they
     * work in, an institution whose front door they can see. Pretending the
     * dashboard does not exist would read as a broken product and they would
     * try again — and there is no id to protect, because the "resource" is
     * their own workplace.
     */
    const decision = refusal(decide('analytics_report:read_school', school()));
    expect(decision.disclosure).toBe('reveal');
    expect(decision.reason).toContain('not_an_administrator');
  });

  it('REFUSES A TEACHER EVEN OF A CLASS IN THIS SCHOOL', () => {
    // Teaching here does not confer a view of the institution. Section 2C
    // separates the audiences and this is the separation.
    const decision = refusal(
      decide('analytics_report:read_school', school({ actorTeachesClass: true })),
    );
    expect(decision.reason).toContain('not_an_administrator');
  });

  it('refuses an actor with no organization', () => {
    // The null-tenant case. `actorIsOrgAdmin` is resolved in SQL as the role
    // AND the tenant together, so a null organization cannot satisfy it.
    expect(
      decide('analytics_report:read_school', school({ organizationId: null })).effect,
    ).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// Course performance
// ---------------------------------------------------------------------------

describe('read_courses — the school’s classes, or your own', () => {
  it('allows this school’s administrator', () => {
    expect(decide('analytics_report:read_courses', klass({ actorIsOrgAdmin: true })).effect).toBe(
      'allow',
    );
  });

  it('allows the teacher of this class', () => {
    expect(decide('analytics_report:read_courses', klass({ actorTeachesClass: true })).effect).toBe(
      'allow',
    );
  });

  it('REFUSES EVERYBODY ELSE WITH hide, not reveal', () => {
    /**
     * The opposite disposition to `read_school`, for the opposite reason: this
     * grain NAMES A CLASS. A caller probing class ids from another school must
     * not learn which ones are real, and 404 is what says nothing.
     */
    const decision = refusal(decide('analytics_report:read_courses', klass()));
    expect(decision.disclosure).toBe('hide');
    expect(decision.reason).toContain('not_this_class');
  });

  it('refuses a learner, whatever else is true of them', () => {
    for (const resource of [
      klass(),
      klass({ organizationId: null }),
      school({ actorTeachesClass: false }),
    ]) {
      expect(decide('analytics_report:read_courses', resource).effect, resource.id).toBe('deny');
    }
  });
});

// ---------------------------------------------------------------------------
// The FERPA line
// ---------------------------------------------------------------------------

describe('at_risk — seniority narrows rather than widens', () => {
  it('allows a teacher', () => {
    expect(decide('analytics_report:at_risk', klass({ actorTeachesClass: true })).effect).toBe(
      'allow',
    );
  });

  it('REFUSES AN ADMINISTRATOR WHO TEACHES NOTHING, with reveal', () => {
    /**
     * THE BRANCH THIS WHOLE FILE EXISTS TO PIN.
     *
     * Section 2B forbids leaking individual student data "outside assigned
     * teacher-student boundaries", and an organization administrator has no
     * such boundary with any particular child. Their legitimate view is the
     * COUNT in the course-performance report, which tells them where to put
     * resources without handing them a browsable list of minors.
     *
     * Not a shorter list, not pseudonyms — refused. And refused with `reveal`,
     * because this is a deliberate boundary a colleague should be told about
     * rather than left to think the endpoint is broken.
     */
    const decision = refusal(
      decide('analytics_report:at_risk', klass({ actorIsOrgAdmin: true, actorTeachesClass: false })),
    );
    expect(decision.disclosure).toBe('reveal');
    expect(decision.reason).toContain('at_risk_is_for_teachers');
  });

  it('ALLOWS AN ADMINISTRATOR WHO ALSO TEACHES, for the classes they teach', () => {
    /**
     * The combination that is awkward to build end to end and trivial here: a
     * head of department who administers the school and still has a timetable.
     *
     * They are allowed, and the reason names the right thing — they hold this
     * because they TEACH, not because they administer. The at-risk function
     * underneath is bounded by `app_actor_teaches_class`, so what they get is
     * their own classes' learners and nobody else's, which is exactly what the
     * teacher branch means.
     */
    const decision = decide(
      'analytics_report:at_risk',
      klass({ actorIsOrgAdmin: true, actorTeachesClass: true }),
    );
    expect(decision.effect).toBe('allow');
    expect(decision.reason).toContain('teaches_this_class');
  });

  it('refuses somebody who neither teaches nor administers, with hide', () => {
    const decision = refusal(decide('analytics_report:at_risk', klass()));
    expect(decision.disclosure).toBe('hide');
  });

  it('refuses a null actorTeachesClass — unknown is not yes', () => {
    // `actorTeachesClass` is null when the grain has no class. The branch tests
    // `=== true` rather than truthiness precisely so an unresolved value cannot
    // be mistaken for a held claim.
    expect(
      decide('analytics_report:at_risk', klass({ actorTeachesClass: null })).effect,
    ).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe('export — the same data through a different door', () => {
  it('allows an administrator both grains', () => {
    expect(decide('analytics_report:export', school({ actorIsOrgAdmin: true })).effect).toBe(
      'allow',
    );
    expect(decide('analytics_report:export', klass({ actorIsOrgAdmin: true })).effect).toBe(
      'allow',
    );
  });

  it('allows a teacher the CLASS grain and refuses them the SCHOOL grain', () => {
    // IT IS NOT WIDER THAN READ, and this is the assertion that says so. A
    // caller who may read a grain may export it; nobody gains anything by
    // switching doors.
    expect(decide('analytics_report:export', klass({ actorTeachesClass: true })).effect).toBe(
      'allow',
    );
    const refused = refusal(
      decide('analytics_report:export', school({ actorTeachesClass: true })),
    );
    expect(refused.disclosure).toBe('reveal');
    expect(refused.reason).toContain('not_an_administrator');
  });

  it('refuses everybody else', () => {
    expect(decide('analytics_report:export', school()).effect).toBe('deny');
    expect(decide('analytics_report:export', klass()).effect).toBe('deny');
  });

  it('EXPORT AND READ AGREE, GRAIN FOR GRAIN, FOR EVERY ACTOR SHAPE', () => {
    /**
     * The property rather than a case of it — and the one that would have
     * caught the defect the HTTP suite found, where the export path built its
     * resource with `actorTeachesClass` left null and refused every teacher the
     * read allowed.
     *
     * Two doors onto the same data must be authorized by the same facts, or one
     * of them is wrong; and it is always the one nobody opens on screen.
     */
    for (const isAdmin of [false, true]) {
      for (const teaches of [null, false, true] as const) {
        const schoolShape = school({ actorIsOrgAdmin: isAdmin, actorTeachesClass: teaches });
        expect(
          decide('analytics_report:export', schoolShape).effect,
          `school admin=${isAdmin} teaches=${teaches}`,
        ).toBe(decide('analytics_report:read_school', schoolShape).effect);

        const classShape = klass({ actorIsOrgAdmin: isAdmin, actorTeachesClass: teaches });
        expect(
          decide('analytics_report:export', classShape).effect,
          `class admin=${isAdmin} teaches=${teaches}`,
        ).toBe(decide('analytics_report:read_courses', classShape).effect);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Properties across the domain
// ---------------------------------------------------------------------------

describe('properties that hold for every verb', () => {
  it('AN ACTOR WITH NO CLAIM AT ALL IS ALLOWED NOTHING', () => {
    // The learner and guardian case, stated as a property rather than a list of
    // roles: hold neither claim and every door is shut.
    for (const action of ANALYTICS_REPORT_ACTIONS) {
      expect(decide(action, school()).effect, `school ${action}`).toBe('deny');
      expect(decide(action, klass()).effect, `class ${action}`).toBe('deny');
    }
  });

  it('A NULL ORGANIZATION IS NEVER A MATCH', () => {
    /**
     * The case a `= app_actor_organization()` predicate gets wrong if it
     * forgets that NULL is not equal to anything, including itself. The
     * resource's `actorIsOrgAdmin` is resolved in SQL with an explicit
     * `IS NOT NULL`, so a null-tenant actor arrives here already false — this
     * asserts the policy does not somehow restore them.
     */
    for (const action of ANALYTICS_REPORT_ACTIONS) {
      const orphan = school({ organizationId: null, actorIsOrgAdmin: false });
      expect(decide(action, orphan).effect, action).toBe('deny');
    }
  });

  it('every denial to an actor with no claim over a CLASS hides rather than explains', () => {
    // A class-grained refusal must never confirm that a class id is real.
    for (const action of ['analytics_report:read_courses', 'analytics_report:export'] as const) {
      expect(refusal(decide(action, klass())).disclosure, action).toBe('hide');
    }
  });
});
