import { describe, expect, it } from 'vitest';
import {
  createPolicyEngine,
  EMPTY_RELATIONSHIPS,
  Role,
  type Actor,
  type AuthorizationContext,
  type LessonProgressState,
  type Resource,
} from '@edu/authz';
import {
  isForwardTransition,
  isProgressAdvance,
} from '../../apps/api/src/modules/progress/progress.domain.ts';
import type { ProgressStatus } from '@edu/contracts';

/**
 * The decision table for learner progress, and the progress state machine.
 *
 * Two things are being pinned here, and they are different in kind. The POLICY
 * decides who may read and who may write; the STATE MACHINE decides which moves
 * are legal for somebody already permitted to write. Conflating them is how a
 * "can they?" check ends up accidentally answering "should they?".
 *
 * The RLS half of the same rules is asserted in
 * `tests/integration/rls-progress.test.ts`, with no application code in the path.
 */
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const LEARNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LESSON = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const COURSE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

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
const teacher = actor({ id: OTHER, roles: [Role.TEACHER] });
const guardian = actor({ id: OTHER, roles: [Role.GUARDIAN] });
const admin = actor({ id: OTHER, roles: [Role.ADMIN] });
/**
 * A SCHOOL's security administrator: the role scoped to their organization.
 *
 * Scoped explicitly, because the default in `actor()` grants globally — and a
 * GLOBAL `security_admin` is a platform operator, which is a different actor
 * with different standing.
 */
const securityAdmin = actor({
  id: OTHER,
  roles: [Role.SECURITY_ADMIN],
  grants: [{ role: Role.SECURITY_ADMIN, scopeType: 'organization', scopeId: ORG_A }],
});
const foreignAdmin = actor({ id: OTHER, roles: [Role.ADMIN], organizationId: ORG_B });
const platformOperator: Actor = {
  id: OTHER,
  roles: [Role.SECURITY_ADMIN],
  grants: [{ role: Role.SECURITY_ADMIN, scopeType: 'global', scopeId: null }],
  permissions: [],
  status: 'active',
  emailVerified: true,
  organizationId: null,
};

const progress = (over: Record<string, unknown> = {}): Resource =>
  ({
    kind: 'lesson_progress',
    id: 'progress-1',
    learnerId: LEARNER,
    learnerOrganizationId: ORG_A,
    lessonId: LESSON,
    courseId: COURSE,
    state: 'in_progress' as LessonProgressState,
    learnerMayStudy: true,
    observableByActorAsTeacher: false,
    ...over,
  }) as never;

// =========================================================================
describe('writing progress is the learner’s alone', () => {
  it('lets the learner record their own, while they still reach the lesson', () => {
    expect(engine.decide(ctx(learner), 'lesson_progress:record', progress()).effect).toBe('allow');
  });

  it.each([
    ['a peer', peer],
    ['their teacher', teacher],
    ['their guardian', guardian],
    ['an administrator', admin],
  ])('REFUSES %s writing a record about somebody else', (_label, who) => {
    const decision = engine.decide(
      ctx(who, { guardianOf: [LEARNER], teacherOf: [LEARNER] }),
      'lesson_progress:record',
      progress({ observableByActorAsTeacher: true }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'lesson_progress.only_the_learner_may_record',
    );
    expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
  });

  it('REFUSES even a PLATFORM OPERATOR writing somebody else’s record', () => {
    // The one place in the codebase where an operator is not above the rule.
    // "Who studied this" is not an administrative fact and no operator should
    // be able to manufacture one.
    const decision = engine.decide(ctx(platformOperator), 'lesson_progress:record', progress());
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'lesson_progress.only_the_learner_may_record',
    );
  });

  it('REFUSES the learner writing when they no longer reach the lesson', () => {
    const decision = engine.decide(
      ctx(learner),
      'lesson_progress:record',
      progress({ learnerMayStudy: false }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'lesson_progress.lesson_not_accessible',
    );
    // `hide`: never had access, lost it, unpublished, withdrawn and archived
    // must all look the same from outside.
    expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
  });
});

// =========================================================================
describe('reading your own record is unconditional', () => {
  it('lets the learner read their own record even after losing access', () => {
    // The retention rule. An administrative change to a timetable must not
    // erase a child's history from their own view.
    for (const action of ['lesson_progress:read', 'lesson_progress:list'] as const) {
      const decision = engine.decide(ctx(learner), action, progress({ learnerMayStudy: false }));
      expect(decision.effect).toBe('allow');
      expect(decision.effect === 'allow' && decision.reason).toBe('lesson_progress.own_record');
    }
  });

  it('reads and writes diverge exactly at access loss', () => {
    const lost = progress({ learnerMayStudy: false });
    expect(engine.decide(ctx(learner), 'lesson_progress:read', lost).effect).toBe('allow');
    expect(engine.decide(ctx(learner), 'lesson_progress:record', lost).effect).toBe('deny');
  });
});

// =========================================================================
describe('third-party reads pass through a relationship, never a role alone', () => {
  it('lets a VERIFIED guardian read their child’s record', () => {
    expect(
      engine.decide(ctx(guardian, { guardianOf: [LEARNER] }), 'lesson_progress:read', progress())
        .effect,
    ).toBe('allow');
  });

  it('REFUSES a guardian of a DIFFERENT child', () => {
    const decision = engine.decide(
      ctx(guardian, { guardianOf: ['ffffffff-ffff-4fff-8fff-ffffffffffff'] }),
      'lesson_progress:read',
      progress(),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
  });

  it('REFUSES a guardian with no verified link at all', () => {
    expect(engine.decide(ctx(guardian), 'lesson_progress:read', progress()).effect).toBe('deny');
  });

  it('lets a teacher read when the class-and-course conjunction holds', () => {
    expect(
      engine.decide(
        ctx(teacher),
        'lesson_progress:read',
        progress({ observableByActorAsTeacher: true }),
      ).effect,
    ).toBe('allow');
  });

  it('REFUSES a teacher when it does not — even if they teach the learner', () => {
    // The case a coarser check would miss: the actor teaches this learner in
    // one class and reaches this course through ANOTHER. `teacherOf` alone is
    // not enough, and the policy does not consult it.
    const decision = engine.decide(
      ctx(teacher, { teacherOf: [LEARNER], coursesViaClasses: [COURSE] }),
      'lesson_progress:read',
      progress({ observableByActorAsTeacher: false }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe('lesson_progress.not_visible');
  });

  it('lets an ADMIN of the learner’s own school read', () => {
    expect(engine.decide(ctx(admin), 'lesson_progress:read', progress()).effect).toBe('allow');
  });

  it('REFUSES an admin of another school', () => {
    expect(engine.decide(ctx(foreignAdmin), 'lesson_progress:read', progress()).effect).toBe(
      'deny',
    );
  });

  it('REFUSES an admin when the learner has no organization', () => {
    expect(
      engine.decide(ctx(admin), 'lesson_progress:read', progress({ learnerOrganizationId: null }))
        .effect,
    ).toBe('deny');
  });

  it('REFUSES a SECURITY ADMIN — accounts and learning records are different authorities', () => {
    // Deliberately narrower than `app_actor_is_org_admin`, which covers both
    // roles. A security administrator manages lockouts, not children's records.
    const decision = engine.decide(ctx(securityAdmin), 'lesson_progress:read', progress());
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe('lesson_progress.not_visible');
  });

  it('REFUSES an unrelated peer in the same school', () => {
    expect(engine.decide(ctx(peer), 'lesson_progress:read', progress()).effect).toBe('deny');
  });

  it('lets a platform operator READ, though not write', () => {
    expect(engine.decide(ctx(platformOperator), 'lesson_progress:read', progress()).effect).toBe(
      'allow',
    );
  });
});

// =========================================================================
describe('the global pre-checks still apply', () => {
  it.each(['lesson_progress:read', 'lesson_progress:record'] as const)(
    'denies a SUSPENDED learner %s on their own record',
    (action) => {
      const suspended = { ...learner, status: 'suspended' as const };
      expect(engine.decide(ctx(suspended), action, progress()).effect).toBe('deny');
    },
  );

  it('denies an actor with no roles', () => {
    const roleless = { ...learner, roles: [] as never[] };
    expect(engine.decide(ctx(roleless), 'lesson_progress:read', progress()).effect).toBe('deny');
  });
});

// =========================================================================
describe('the progress state machine', () => {
  const ALL: ProgressStatus[] = ['not_started', 'in_progress', 'completed'];

  it.each([
    ['not_started', 'in_progress'],
    ['not_started', 'completed'],
    ['in_progress', 'completed'],
  ] as const)('permits %s -> %s', (from, to) => {
    expect(isForwardTransition(from, to)).toBe(true);
    expect(isProgressAdvance(from, to)).toBe(true);
  });

  it.each([
    ['in_progress', 'not_started'],
    ['completed', 'in_progress'],
    ['completed', 'not_started'],
  ] as const)('REFUSES %s -> %s', (from, to) => {
    expect(isForwardTransition(from, to)).toBe(false);
  });

  it.each(ALL)('treats %s -> itself as permitted but not an advance', (status) => {
    // Idempotence: a double-tap or a retry after a timeout must not be an error.
    expect(isForwardTransition(status, status)).toBe(true);
    expect(isProgressAdvance(status, status)).toBe(false);
  });

  it('is a total order — every pair is decided, and never both ways', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const forward = isForwardTransition(from, to);
        const backward = isForwardTransition(to, from);
        // Exactly one direction, unless they are the same status.
        expect(forward || backward).toBe(true);
        if (from !== to) expect(forward && backward).toBe(false);
      }
    }
  });

  it('makes `completed` terminal', () => {
    for (const to of ALL) {
      expect(isProgressAdvance('completed', to)).toBe(false);
    }
  });
});
