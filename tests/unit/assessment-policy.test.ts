import { describe, expect, it } from 'vitest';
import {
  createPolicyEngine,
  EMPTY_RELATIONSHIPS,
  Role,
  type Actor,
  type AssessmentAttemptResource,
  type AuthorizationContext,
  type LearningActivityResource,
  type Resource,
} from '@edu/authz';
import {
  selectionLimitFor,
  validateAnswerPayload,
} from '../../apps/api/src/modules/assessment/assessment.domain.ts';
import type { AttemptQuestion } from '@edu/contracts';

/**
 * The decision tables for activities and attempts, and the pure parts of the
 * assessment domain.
 *
 * THREE tables rather than one, because the questions are different in kind and
 * collapsing them is the mistake each is designed to prevent:
 *
 *   1. Who may see and edit an ACTIVITY (content, with a duty split).
 *   2. Who may READ an attempt (a graph of relationships).
 *   3. Who may WRITE one (the learner, and nobody else, including an operator).
 *
 * Tables 2 and 3 are enumerated separately on purpose: the read rule and the
 * write rule give DIFFERENT answers for the same actor and the same object, and
 * a single matrix would invite somebody to "simplify" them into agreement.
 *
 * The RLS half of the same rules is asserted in
 * `tests/integration/rls-assessment.test.ts`, with no application code in the
 * path. Neither suite is sufficient alone, and that is the point.
 *
 * WHAT IS NOT TESTED HERE: the scoring rule. It lives in SQL, because scoring
 * needs the answer key and the key never enters application memory. It is
 * enumerated against a real database in the RLS suite instead.
 */
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const LEARNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LESSON = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const COURSE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ASSESSMENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ACTIVITY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ATTEMPT = '99999999-9999-4999-8999-999999999999';

const engine = createPolicyEngine();

function actor(overrides: Partial<Actor> & Pick<Actor, 'id' | 'roles'>): Actor {
  return {
    status: 'active',
    emailVerified: true,
    organizationId: ORG_A,
    permissions: [],
    grants: overrides.roles.map((role) => ({ role, scopeType: 'global' as const, scopeId: null })),
    ...overrides,
  };
}

const ctx = (a: Actor, rel: Partial<typeof EMPTY_RELATIONSHIPS> = {}): AuthorizationContext => ({
  actor: a,
  relationships: { ...EMPTY_RELATIONSHIPS, ...rel },
});

const learner = actor({ id: LEARNER, roles: [Role.STUDENT] });
const peer = actor({ id: OTHER, roles: [Role.STUDENT] });
const guardian = actor({ id: OTHER, roles: [Role.GUARDIAN] });
const admin = actor({ id: OTHER, roles: [Role.ADMIN] });
const foreignAdmin = actor({ id: OTHER, roles: [Role.ADMIN], organizationId: ORG_B });

/** A SCHOOL's security administrator — organization-scoped, not global. */
const securityAdmin = actor({
  id: OTHER,
  roles: [Role.SECURITY_ADMIN],
  grants: [{ role: Role.SECURITY_ADMIN, scopeType: 'organization', scopeId: ORG_A }],
});

/** A PLATFORM operator: `security_admin` held GLOBALLY. */
const operator = actor({
  id: OTHER,
  roles: [Role.SECURITY_ADMIN],
  organizationId: null,
  grants: [{ role: Role.SECURITY_ADMIN, scopeType: 'global', scopeId: null }],
});

const author = actor({
  id: OTHER,
  roles: [Role.CONTENT_AUTHOR],
  permissions: ['content:author'],
});
const reviewer = actor({ id: OTHER, roles: [Role.REVIEWER], permissions: ['content:publish'] });
const foreignAuthor = actor({
  id: OTHER,
  roles: [Role.CONTENT_AUTHOR],
  permissions: ['content:author'],
  organizationId: ORG_B,
});

function activity(overrides: Partial<LearningActivityResource> = {}): LearningActivityResource {
  return {
    kind: 'learning_activity',
    id: ACTIVITY,
    lessonId: LESSON,
    courseId: COURSE,
    organizationId: ORG_A,
    activityType: 'assessment',
    status: 'published',
    lessonVisible: true,
    learnerReachesLesson: true,
    ...overrides,
  };
}

function attempt(overrides: Partial<AssessmentAttemptResource> = {}): AssessmentAttemptResource {
  return {
    kind: 'assessment_attempt',
    id: ATTEMPT,
    learnerId: LEARNER,
    learnerOrganizationId: ORG_A,
    assessmentId: ASSESSMENT,
    lessonId: LESSON,
    state: 'in_progress',
    released: false,
    learnerMayAttempt: true,
    observableByActorAsTeacher: false,
    ...overrides,
  };
}

const decide = (
  a: Actor,
  action: Parameters<typeof engine.decide>[1],
  resource: Resource,
  rel: Partial<typeof EMPTY_RELATIONSHIPS> = {},
) => engine.decide(ctx(a, rel), action, resource);

// =====================================================================
// 1. Activities — content, with the author/publisher duty split
// =====================================================================

describe('learning activity — reading', () => {
  it('a learner reads a published activity on a lesson they can see', () => {
    expect(decide(learner, 'learning_activity:read', activity()).effect).toBe('allow');
  });

  it('a learner cannot read one whose LESSON is invisible to them', () => {
    // One test standing in for the tenancy check, the ancestor chain and the
    // Task 006 class narrowing at once: `lessons_select` performed all three
    // before answering, and this policy asks it rather than restating it.
    const decision = decide(learner, 'learning_activity:read', activity({ lessonVisible: false }));
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
  });

  it.each([['draft'], ['archived']] as const)(
    'a learner cannot read a %s activity even on a visible lesson',
    (status) => {
      const decision = decide(learner, 'learning_activity:read', activity({ status }));
      expect(decision.effect).toBe('deny');
      // `hide`, not `reveal`. A 403 would confirm the id names real content.
      expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
    },
  );

  it('an author of the owning school reads a draft', () => {
    expect(decide(author, 'learning_activity:read', activity({ status: 'draft' })).effect).toBe(
      'allow',
    );
  });

  it('a REVIEWER reads a draft too — they must, in order to review it', () => {
    expect(decide(reviewer, 'learning_activity:read', activity({ status: 'draft' })).effect).toBe(
      'allow',
    );
  });

  it('an author of ANOTHER school cannot read the draft', () => {
    expect(
      decide(foreignAuthor, 'learning_activity:read', activity({ status: 'draft' })).effect,
    ).toBe('deny');
  });

  it('an author cannot read a GLOBAL draft — that is the platform operator’s', () => {
    expect(
      decide(author, 'learning_activity:read', activity({ status: 'draft', organizationId: null }))
        .effect,
    ).toBe('deny');
  });

  it('a platform operator reads anything', () => {
    expect(
      decide(
        operator,
        'learning_activity:read',
        activity({ status: 'draft', organizationId: null }),
      ).effect,
    ).toBe('allow');
  });
});

describe('learning activity — the duty split', () => {
  it('an author may create a draft', () => {
    expect(decide(author, 'learning_activity:create', activity({ status: 'draft' })).effect).toBe(
      'allow',
    );
  });

  it('an author may NOT publish', () => {
    const decision = decide(author, 'learning_activity:publish', activity({ status: 'draft' }));
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'learning_activity.requires_publish_permission',
    );
  });

  it('a reviewer may publish', () => {
    expect(
      decide(reviewer, 'learning_activity:publish', activity({ status: 'draft' })).effect,
    ).toBe('allow');
  });

  it('a reviewer may NOT author', () => {
    expect(decide(reviewer, 'learning_activity:update', activity({ status: 'draft' })).effect).toBe(
      'deny',
    );
  });

  it('an activity must be born a draft', () => {
    expect(
      decide(author, 'learning_activity:create', activity({ status: 'published' })).effect,
    ).toBe('deny');
  });

  it('a PUBLISHED activity can no longer be edited, even by its author', () => {
    // Stricter than the content policy, deliberately: an activity's content is
    // the paper a learner sits, and changing it after publication would mean
    // two attempts had been marked against different papers.
    const decision = decide(author, 'learning_activity:update', activity({ status: 'published' }));
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'learning_activity.only_a_draft_may_be_edited',
    );
  });

  it('only a draft may be published', () => {
    expect(
      decide(reviewer, 'learning_activity:publish', activity({ status: 'archived' })).effect,
    ).toBe('deny');
  });

  it('an already-archived activity cannot be archived again', () => {
    expect(
      decide(reviewer, 'learning_activity:archive', activity({ status: 'archived' })).effect,
    ).toBe('deny');
  });

  it('a teacher holding content:author may still not touch the GLOBAL catalog', () => {
    expect(
      decide(
        author,
        'learning_activity:create',
        activity({ status: 'draft', organizationId: null }),
      ).effect,
    ).toBe('deny');
  });

  it('a learner may not create an activity', () => {
    expect(decide(learner, 'learning_activity:create', activity({ status: 'draft' })).effect).toBe(
      'deny',
    );
  });
});

// =====================================================================
// 2. Attempts — WRITING. The learner, and nobody else.
// =====================================================================

describe('assessment attempt — starting and submitting', () => {
  it('the learner may start their own attempt', () => {
    expect(decide(learner, 'assessment_attempt:start', attempt()).effect).toBe('allow');
  });

  it('the learner may submit their own in-progress attempt', () => {
    expect(decide(learner, 'assessment_attempt:submit', attempt()).effect).toBe('allow');
  });

  it.each([
    ['a peer', peer],
    ['a guardian', guardian],
    ['an administrator', admin],
    ['a security administrator', securityAdmin],
    // The one that matters most. Everywhere else in this codebase a platform
    // operator may do anything; here they may not, because a mark an adult can
    // manufacture is not evidence that a child sat anything.
    ['a PLATFORM OPERATOR', operator],
  ])('%s may NOT start an attempt for the learner', (_label, who) => {
    const decision = decide(who, 'assessment_attempt:start', attempt(), {
      guardianOf: [LEARNER],
      teacherOf: [LEARNER],
    });
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'assessment_attempt.only_the_learner_may_attempt',
    );
  });

  it.each([
    ['a peer', peer],
    ['a teacher of the shared class', actor({ id: OTHER, roles: [Role.TEACHER] })],
    ['a PLATFORM OPERATOR', operator],
  ])('%s may NOT submit somebody else’s attempt', (_label, who) => {
    const decision = decide(
      who,
      'assessment_attempt:submit',
      attempt({ observableByActorAsTeacher: true }),
    );
    expect(decision.effect).toBe('deny');
  });

  it('the learner may not start when they no longer reach the assessment', () => {
    const decision = decide(
      learner,
      'assessment_attempt:start',
      attempt({ learnerMayAttempt: false }),
    );
    expect(decision.effect).toBe('deny');
    // `hide`: a learner cannot tell "never had access" from "lost it" from
    // "it is a draft", and should not be able to.
    expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
  });

  it('a submitted attempt cannot be submitted again', () => {
    const decision = decide(learner, 'assessment_attempt:submit', attempt({ state: 'submitted' }));
    expect(decision.effect).toBe('deny');
    // `reveal`: it is their own attempt and they can already see it.
    expect(decision.effect === 'deny' && decision.disclosure).toBe('reveal');
  });
});

// =====================================================================
// 3. Attempts — READING. A different table, giving different answers.
// =====================================================================

describe('assessment attempt — reading', () => {
  it('the learner reads their own attempt with NO access check', () => {
    // The retention rule, stated as a test: losing the class must not erase the
    // record of what they sat.
    expect(
      decide(learner, 'assessment_attempt:read', attempt({ learnerMayAttempt: false })).effect,
    ).toBe('allow');
  });

  it('a verified guardian reads it', () => {
    expect(
      decide(guardian, 'assessment_attempt:read', attempt(), { guardianOf: [LEARNER] }).effect,
    ).toBe('allow');
  });

  it('a guardian of a DIFFERENT child does not', () => {
    expect(
      decide(guardian, 'assessment_attempt:read', attempt(), { guardianOf: [OTHER] }).effect,
    ).toBe('deny');
  });

  it('a teacher who shares the class reads it', () => {
    expect(
      decide(
        actor({ id: OTHER, roles: [Role.TEACHER] }),
        'assessment_attempt:read',
        attempt({ observableByActorAsTeacher: true }),
      ).effect,
    ).toBe('allow');
  });

  it('a teacher who does NOT share the class does not — even holding teacherOf', () => {
    // The conjunction is the whole rule. `teacherOf` says "I teach them
    // somewhere"; it is not "I teach them THIS", and only the SQL-computed
    // field can tell the difference.
    const decision = decide(
      actor({ id: OTHER, roles: [Role.TEACHER] }),
      'assessment_attempt:read',
      attempt({ observableByActorAsTeacher: false }),
      { teacherOf: [LEARNER] },
    );
    expect(decision.effect).toBe('deny');
  });

  it('an administrator of the learner’s school reads it', () => {
    expect(decide(admin, 'assessment_attempt:read', attempt()).effect).toBe('allow');
  });

  it('an administrator of ANOTHER school does not', () => {
    expect(decide(foreignAdmin, 'assessment_attempt:read', attempt()).effect).toBe('deny');
  });

  it('a SECURITY administrator of the same school does not', () => {
    // Managing accounts and lockouts is a different authority from reading
    // every child's marks; merging them would put both in one compromise.
    expect(decide(securityAdmin, 'assessment_attempt:read', attempt()).effect).toBe('deny');
  });

  it('an administrator with NO organization matches nothing', () => {
    expect(
      decide(
        actor({ id: OTHER, roles: [Role.ADMIN], organizationId: null }),
        'assessment_attempt:read',
        attempt({ learnerOrganizationId: null }),
      ).effect,
    ).toBe('deny');
  });

  it('a peer reads nothing', () => {
    const decision = decide(peer, 'assessment_attempt:read', attempt());
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
  });

  it('a platform operator may READ', () => {
    expect(decide(operator, 'assessment_attempt:read', attempt()).effect).toBe('allow');
  });

  it('the same table governs list as read', () => {
    expect(decide(peer, 'assessment_attempt:list', attempt()).effect).toBe('deny');
    expect(decide(learner, 'assessment_attempt:list', attempt()).effect).toBe('allow');
  });
});

// =====================================================================
// 3b. Attempts — RELEASING. A fourth table, and the narrowest of them all.
//
// Releasing is not reading. It is the act of deciding that a learner is now
// told what they scored, and the whole reason results can be withheld is that
// the decision belongs to somebody other than the person being measured. So
// this table is enumerated separately from the read table even though several
// rows agree with it — the agreement is a coincidence of the current rules,
// not a property anyone should be able to rely on while editing them.
// =====================================================================

describe('assessment attempt — releasing the result', () => {
  const submitted = (overrides: Partial<AssessmentAttemptResource> = {}) =>
    attempt({ state: 'submitted', ...overrides });

  it('THE LEARNER MAY NOT RELEASE THEIR OWN RESULT', () => {
    // The single most important denial in Task 009. If this ever flips, the
    // review policy `on_release` becomes decorative: every learner simply
    // releases themselves and withholding means nothing.
    const decision = decide(learner, 'assessment_attempt:release', submitted());
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'assessment_attempt.learner_may_not_release',
    );
  });

  it('…not even when they are also a teacher of the class the attempt sits in', () => {
    // The escalation path: hold a second role, mark yourself observable, and
    // try to walk in through the teacher branch. `isOwn` is checked FIRST, so
    // the teacher branch is never reached for your own paper.
    const learnerWhoAlsoTeaches = actor({
      id: LEARNER,
      roles: [Role.STUDENT, Role.TEACHER],
    });
    const decision = decide(
      learnerWhoAlsoTeaches,
      'assessment_attempt:release',
      submitted({ observableByActorAsTeacher: true }),
      { teacherOf: [LEARNER] },
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'assessment_attempt.learner_may_not_release',
    );
  });

  it('a teacher who shares the class may release', () => {
    const teacher = actor({ id: OTHER, roles: [Role.TEACHER] });
    expect(
      decide(
        teacher,
        'assessment_attempt:release',
        submitted({ observableByActorAsTeacher: true }),
        {
          teacherOf: [LEARNER],
        },
      ).effect,
    ).toBe('allow');
  });

  it('a teacher who does NOT share the class may not — holding teacherOf is not enough', () => {
    // `observableByActorAsTeacher` is computed by the database from the class
    // roster. A relationship snapshot that says "teaches this learner
    // somewhere" does not say "teaches THIS class", and only the latter grants
    // authority over this paper.
    const teacher = actor({ id: OTHER, roles: [Role.TEACHER] });
    const decision = decide(
      teacher,
      'assessment_attempt:release',
      submitted({ observableByActorAsTeacher: false }),
      { teacherOf: [LEARNER] },
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe('assessment_attempt.not_a_releaser');
  });

  it('an administrator of the learner’s school may release', () => {
    expect(decide(admin, 'assessment_attempt:release', submitted()).effect).toBe('allow');
  });

  it('an administrator of ANOTHER school may not', () => {
    expect(decide(foreignAdmin, 'assessment_attempt:release', submitted()).effect).toBe('deny');
  });

  it('an administrator with no organization matches nothing', () => {
    expect(
      decide(
        actor({ id: OTHER, roles: [Role.ADMIN], organizationId: null }),
        'assessment_attempt:release',
        submitted({ learnerOrganizationId: null }),
      ).effect,
    ).toBe('deny');
  });

  it('a school SECURITY administrator may not release', () => {
    // Accounts and lockouts are their remit. Deciding what a child is told
    // about their marks is not, and must not ride along with it.
    expect(decide(securityAdmin, 'assessment_attempt:release', submitted()).effect).toBe('deny');
  });

  it('a VERIFIED guardian may READ the result but may NOT release it', () => {
    // The two tables disagree for the same actor and the same object, which is
    // exactly why they are enumerated separately. A parent may see what their
    // child was told; deciding what the child is told is a teaching act.
    const rel = { guardianOf: [LEARNER] };
    expect(decide(guardian, 'assessment_attempt:read', submitted(), rel).effect).toBe('allow');
    const decision = decide(guardian, 'assessment_attempt:release', submitted(), rel);
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe('assessment_attempt.not_a_releaser');
    // `hide`, because the guardian branch is a read branch they never reach
    // here; they should not learn that a release decision is pending.
    expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
  });

  it('a peer may not release', () => {
    expect(decide(peer, 'assessment_attempt:release', submitted()).effect).toBe('deny');
  });

  it('a platform operator may release — unlike start and submit', () => {
    // The direction of the act is what separates them. Releasing discloses a
    // mark the database already computed; starting or submitting would
    // manufacture evidence about what a child did.
    expect(decide(operator, 'assessment_attempt:release', submitted()).effect).toBe('allow');
  });

  it('there is nothing to release on an in-progress attempt, even for a teacher', () => {
    {
      const state = 'in_progress' as const;
      const teacher = actor({ id: OTHER, roles: [Role.TEACHER] });
      const decision = decide(
        teacher,
        'assessment_attempt:release',
        attempt({ state, observableByActorAsTeacher: true }),
        { teacherOf: [LEARNER] },
      );
      expect(decision.effect).toBe('deny');
      expect(decision.effect === 'deny' && decision.reason).toBe(
        'assessment_attempt.nothing_to_release',
      );
    }
  });

  it('a suspended teacher may not release', () => {
    expect(
      decide(
        actor({ id: OTHER, roles: [Role.TEACHER], status: 'suspended' }),
        'assessment_attempt:release',
        submitted({ observableByActorAsTeacher: true }),
        { teacherOf: [LEARNER] },
      ).effect,
    ).toBe('deny');
  });
});

// =====================================================================
// 3c. Attempts — REVIEWING the marked paper.
//
// Review carries the correct answers and the explanations. It is the read
// table PLUS the release gate — and the gate binds only the learner and their
// guardian, because a teacher must be able to look at an unreleased paper in
// order to decide whether to release it.
// =====================================================================

describe('assessment attempt — reviewing the marked paper', () => {
  const teacher = actor({ id: OTHER, roles: [Role.TEACHER] });
  const asTeacher = { teacherOf: [LEARNER] };

  it('a learner may review their own RELEASED attempt', () => {
    expect(
      decide(learner, 'assessment_attempt:review', attempt({ state: 'submitted', released: true }))
        .effect,
    ).toBe('allow');
  });

  it('A LEARNER MAY NOT REVIEW THEIR OWN UNRELEASED ATTEMPT', () => {
    // The withholding rule itself. Note this is a denial on the learner's OWN
    // record — the one place in this file where ownership is not enough.
    const decision = decide(
      learner,
      'assessment_attempt:review',
      attempt({ state: 'submitted', released: false }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'assessment_attempt.result_not_released',
    );
    // `reveal`: they sat it, so they know it exists. The only thing disclosed
    // is that a result is pending, which is what a learner should be told.
    expect(decision.effect === 'deny' && decision.disclosure).toBe('reveal');
  });

  it('a guardian is bound by the same gate as the child', () => {
    const rel = { guardianOf: [LEARNER] };
    expect(
      decide(guardian, 'assessment_attempt:review', attempt({ state: 'submitted' }), rel).effect,
    ).toBe('deny');
    expect(
      decide(
        guardian,
        'assessment_attempt:review',
        attempt({ state: 'submitted', released: true }),
        rel,
      ).effect,
    ).toBe('allow');
  });

  it('A TEACHER MAY REVIEW AN UNRELEASED PAPER — that is how they decide', () => {
    expect(
      decide(
        teacher,
        'assessment_attempt:review',
        attempt({ state: 'submitted', released: false, observableByActorAsTeacher: true }),
        asTeacher,
      ).effect,
    ).toBe('allow');
  });

  it('an administrator of the school may review an unreleased paper', () => {
    expect(
      decide(admin, 'assessment_attempt:review', attempt({ state: 'submitted', released: false }))
        .effect,
    ).toBe('allow');
  });

  it('the release gate does not widen the read table', () => {
    // Released does NOT mean public. A peer, a foreign administrator and a
    // teacher of another class are refused a released paper exactly as they
    // are refused an unreleased one.
    const released = attempt({ state: 'submitted', released: true });
    expect(decide(peer, 'assessment_attempt:review', released).effect).toBe('deny');
    expect(decide(foreignAdmin, 'assessment_attempt:review', released).effect).toBe('deny');
    expect(decide(securityAdmin, 'assessment_attempt:review', released).effect).toBe('deny');
    expect(decide(teacher, 'assessment_attempt:review', released, asTeacher).effect).toBe('deny');
  });

  it('a guardian of a DIFFERENT child is refused a released paper', () => {
    expect(
      decide(
        guardian,
        'assessment_attempt:review',
        attempt({ state: 'submitted', released: true }),
        {
          guardianOf: [OTHER],
        },
      ).effect,
    ).toBe('deny');
  });

  it('there is no marked paper to review on an in-progress attempt', () => {
    {
      const state = 'in_progress' as const;
      // Checked BEFORE the release gate, so a learner mid-attempt cannot use
      // the review endpoint as a back door to the answer key.
      const decision = decide(learner, 'assessment_attempt:review', attempt({ state }));
      expect(decision.effect).toBe('deny');
      expect(decision.effect === 'deny' && decision.reason).toBe(
        'assessment_attempt.not_submitted',
      );
    }
  });

  it('an in-progress attempt is refused review even when the flag says released', () => {
    // Defence in depth against a malformed resource: `released` is never
    // consulted before `state`.
    const decision = decide(
      learner,
      'assessment_attempt:review',
      attempt({ state: 'in_progress', released: true }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe('assessment_attempt.not_submitted');
  });

  it('a suspended learner may not review their own released attempt', () => {
    expect(
      decide(
        actor({ id: LEARNER, roles: [Role.STUDENT], status: 'suspended' }),
        'assessment_attempt:review',
        attempt({ state: 'submitted', released: true }),
      ).effect,
    ).toBe('deny');
  });

  it('a released paper grants no write on itself', () => {
    // Review is a read. Reaching a marked paper must not carry the right to
    // change it or to decide its disclosure.
    //
    // `start` is absent from this list on purpose: it is decided against a
    // PROSPECTIVE attempt the service synthesizes (see `startAttempt`), never
    // against an existing row, so asserting it here would test a resource the
    // engine is never handed. The attempt LIMIT, not this policy, is what
    // stops a learner re-sitting an assessment, and it is enforced by a
    // trigger over a definer count.
    const released = attempt({ state: 'submitted', released: true });
    expect(decide(learner, 'assessment_attempt:submit', released).effect).toBe('deny');
    expect(decide(learner, 'assessment_attempt:release', released).effect).toBe('deny');
  });
});

describe('assessment attempt — the engine’s global pre-checks still apply', () => {
  it.each([['suspended'], ['pending_verification']] as const)(
    'a %s learner cannot read even their own attempt',
    (status) => {
      expect(
        decide(
          actor({ id: LEARNER, roles: [Role.STUDENT], status }),
          'assessment_attempt:read',
          attempt(),
        ).effect,
      ).toBe('deny');
    },
  );

  it('an actor with no roles is denied', () => {
    expect(
      decide(actor({ id: LEARNER, roles: [] }), 'assessment_attempt:read', attempt()).effect,
    ).toBe('deny');
  });
});

// =====================================================================
// 4. The pure domain
// =====================================================================

describe('selectionLimitFor', () => {
  it('single-choice and true/false require exactly one', () => {
    expect(selectionLimitFor('single_choice')).toBe(1);
    expect(selectionLimitFor('true_false')).toBe(1);
  });

  it('multiple-choice says only "one or more"', () => {
    // Publishing the SIZE of a multiple-choice key would narrow the guess space
    // from 2^n subsets to n-choose-k, for free.
    expect(selectionLimitFor('multiple_choice')).toBeNull();
  });
});

describe('validateAnswerPayload', () => {
  const question = (
    id: string,
    type: AttemptQuestion['questionType'],
    optionIds: string[],
  ): AttemptQuestion => ({
    id,
    position: 1,
    questionType: type,
    prompt: 'Q',
    points: 1,
    selectionLimit: selectionLimitFor(type),
    options: optionIds.map((oid, i) => ({ id: oid, position: i + 1, body: 'o' })),
  });

  const Q1 = '10000000-0000-4000-8000-000000000001';
  const O1 = '20000000-0000-4000-8000-000000000001';
  const O2 = '20000000-0000-4000-8000-000000000002';
  const FOREIGN_Q = '10000000-0000-4000-8000-000000000009';
  const FOREIGN_O = '20000000-0000-4000-8000-000000000009';
  const questions = [question(Q1, 'single_choice', [O1, O2])];

  it('accepts a well-formed answer', () => {
    const result = validateAnswerPayload(questions, {
      answers: [{ questionId: Q1, selectedOptionIds: [O1] }],
    });
    expect(result.violations).toEqual([]);
    expect(result.rows).toEqual([[Q1, O1]]);
  });

  it('accepts an EMPTY selection — that is how a question is left unanswered', () => {
    const result = validateAnswerPayload(questions, {
      answers: [{ questionId: Q1, selectedOptionIds: [] }],
    });
    expect(result.violations).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it('accepts an omitted question for the same reason', () => {
    const result = validateAnswerPayload(questions, { answers: [] });
    expect(result.violations).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it('flags a question from another assessment', () => {
    const result = validateAnswerPayload(questions, {
      answers: [{ questionId: FOREIGN_Q, selectedOptionIds: [O1] }],
    });
    expect(result.violations.map((v) => v.kind)).toEqual(['unknown_question']);
    expect(result.rows).toEqual([]);
  });

  it('flags an option belonging to another question', () => {
    const result = validateAnswerPayload(questions, {
      answers: [{ questionId: Q1, selectedOptionIds: [FOREIGN_O] }],
    });
    expect(result.violations.map((v) => v.kind)).toEqual(['unknown_option']);
    expect(result.rows).toEqual([]);
  });

  it('flags two selections on a single-choice question', () => {
    const result = validateAnswerPayload(questions, {
      answers: [{ questionId: Q1, selectedOptionIds: [O1, O2] }],
    });
    expect(result.violations.map((v) => v.kind)).toEqual(['too_many_options']);
  });

  it('permits several selections on a multiple-choice question', () => {
    const multi = [question(Q1, 'multiple_choice', [O1, O2])];
    const result = validateAnswerPayload(multi, {
      answers: [{ questionId: Q1, selectedOptionIds: [O1, O2] }],
    });
    expect(result.violations).toEqual([]);
    expect(result.rows).toHaveLength(2);
  });

  it('absorbs a duplicated selection instead of flagging it', () => {
    // The one malformed shape that is plausibly a client retry rather than an
    // attack, so it collapses silently rather than raising an alarm.
    const result = validateAnswerPayload(questions, {
      answers: [{ questionId: Q1, selectedOptionIds: [O1, O1] }],
    });
    expect(result.violations).toEqual([]);
    expect(result.rows).toEqual([[Q1, O1]]);
  });

  it('never emits a row for a question it flagged', () => {
    const result = validateAnswerPayload(questions, {
      answers: [
        { questionId: Q1, selectedOptionIds: [FOREIGN_O] },
        { questionId: FOREIGN_Q, selectedOptionIds: [O1] },
      ],
    });
    expect(result.rows).toEqual([]);
    expect(result.violations).toHaveLength(2);
  });
});
