import { describe, expect, it } from 'vitest';
import {
  ALL_ACTIONS,
  createPolicyEngine,
  EMPTY_RELATIONSHIPS,
  EXPERIMENT_SESSION_ACTIONS,
  Role,
  type Actor,
  type AuthorizationContext,
  type ExperimentSessionAction,
  type ExperimentSessionResource,
} from '@edu/authz';

/**
 * The decision table for a learner's run at an interactive lab.
 *
 * TWO tables rather than one, because the read rule and the write rule give
 * DIFFERENT answers for the same actor and the same object, and a single matrix
 * would invite somebody to "simplify" them into agreement:
 *
 *   1. Who may READ a session (a graph of relationships).
 *   2. Who may WRITE one (the learner, and nobody else — an operator included).
 *
 * The write rule is the sharper of the two here, more so than for an
 * assessment. A lab is finished by REACHING A STATE rather than by choosing an
 * answer, so an adult who could save into a child's session could assemble the
 * passing circuit and let the trigger mark it — and the record would say the
 * child did it. Table 2 is what stops that.
 *
 * The RLS half of the same rules is asserted in
 * `tests/integration/rls-experiments.test.ts`, with no application code in the
 * path. Neither suite is sufficient alone, and that is the point.
 *
 * WHAT IS NOT TESTED HERE: whether a state satisfies the lab. That lives in
 * SQL, because marking needs the validation rules and the rules never enter
 * application memory.
 */
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const LEARNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LESSON = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EXPERIMENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SESSION = '99999999-9999-4999-8999-999999999999';

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

function session(overrides: Partial<ExperimentSessionResource> = {}): ExperimentSessionResource {
  return {
    kind: 'experiment_session',
    id: SESSION,
    learnerId: LEARNER,
    learnerOrganizationId: ORG_A,
    experimentId: EXPERIMENT,
    lessonId: LESSON,
    state: 'in_progress',
    learnerMayWork: true,
    observableByActorAsTeacher: false,
    ...overrides,
  };
}

const decide = (
  a: Actor,
  action: ExperimentSessionAction,
  resource: ExperimentSessionResource,
  rel: Partial<typeof EMPTY_RELATIONSHIPS> = {},
) => engine.decide(ctx(a, rel), action, resource);

const WRITES = [
  'experiment_session:start',
  'experiment_session:save',
  'experiment_session:submit',
] as const satisfies readonly ExperimentSessionAction[];

describe('the vocabulary itself', () => {
  it('registers every experiment_session action in ALL_ACTIONS', () => {
    for (const action of EXPERIMENT_SESSION_ACTIONS) {
      expect(ALL_ACTIONS).toContain(action);
    }
  });

  it('has no word for releasing a lab result', () => {
    // A lab result is not withheld. If a future task wanted to withhold one, it
    // would have to add the action here, in a diff somebody reads — rather than
    // reaching for a neighbouring action that happens to fit.
    expect(EXPERIMENT_SESSION_ACTIONS.some((a) => a.endsWith(':release'))).toBe(false);
  });

  it('refuses an action evaluated against the wrong kind of resource', () => {
    expect(() => engine.decide(ctx(learner), 'assessment_attempt:read', session())).toThrow(
      /targets resource kind/,
    );
  });
});

describe('writing a lab session is the learner’s alone', () => {
  it.each(WRITES)('allows the learner their own live session: %s', (action) => {
    expect(decide(learner, action, session()).effect).toBe('allow');
  });

  it.each(WRITES)('refuses a peer: %s', (action) => {
    const d = decide(peer, action, session());
    expect(d.effect === 'deny' && d.disclosure).toBe('hide');
  });

  it.each(WRITES)('refuses the teacher of the shared class: %s', (action) => {
    // Reading a child's lab and doing it for them are different acts. This is
    // the denial that stops an adult assembling the passing circuit and letting
    // the trigger record it as the child's work.
    const d = decide(teacher, action, session({ observableByActorAsTeacher: true }));
    expect(d.effect).toBe('deny');
  });

  it.each(WRITES)('refuses a verified guardian: %s', (action) => {
    const d = decide(guardian, action, session(), { guardianOf: [LEARNER] });
    expect(d.effect).toBe('deny');
  });

  it.each(WRITES)('refuses an administrator of the learner’s own school: %s', (action) => {
    expect(decide(admin, action, session()).effect).toBe('deny');
  });

  it.each(WRITES)('refuses a PLATFORM OPERATOR: %s', (action) => {
    // The one branch that is deliberately inverted relative to the read table
    // below. An operator may look at anything; a session an operator can create
    // is not evidence that a child did anything.
    const d = decide(operator, action, session());
    expect(d.effect).toBe('deny');
    expect(d.reason).toBe('experiment_session.only_the_learner_may_work');
  });

  it.each(WRITES)('refuses the learner once they no longer reach the lab: %s', (action) => {
    // §3 instant state isolation. `hide`, because the learner cannot tell a
    // withdrawn course from a draft lab from a lab that never existed, and the
    // difference is a fact about their school rather than about them.
    const d = decide(learner, action, session({ learnerMayWork: false }));
    expect(d.effect).toBe('deny');
    expect(d.reason).toBe('experiment_session.lab_not_accessible');
    expect(d.effect === 'deny' && d.disclosure).toBe('hide');
  });

  it.each(['submitted', 'completed'] as const)(
    'refuses a save or submit once the session is %s',
    (state) => {
      for (const action of ['experiment_session:save', 'experiment_session:submit'] as const) {
        const d = decide(learner, action, session({ state }));
        expect(d.effect).toBe('deny');
        expect(d.reason).toBe('experiment_session.already_submitted');
        // `reveal`, not `hide`: it is their own session and they can see it.
        expect(d.effect === 'deny' && d.disclosure).toBe('reveal');
      }
    },
  );

  it('still allows START while a previous session is finished', () => {
    // `start` is asked about the LAB, not about the session in hand, so a
    // finished run must not bar a new one. The one-live-session-per-lab rule is
    // the partial unique index's job, not the policy's.
    expect(
      decide(learner, 'experiment_session:start', session({ state: 'completed' })).effect,
    ).toBe('allow');
  });
});

describe('reading a lab session follows the relationship graph', () => {
  const READS = ['experiment_session:read', 'experiment_session:list'] as const;

  it.each(READS)('allows the learner their own, with no access check: %s', (action) => {
    // Retention. Losing the class must not erase the record of what they did.
    const d = decide(learner, action, session({ learnerMayWork: false, state: 'completed' }));
    expect(d.effect).toBe('allow');
    expect(d.reason).toBe('experiment_session.own_session');
  });

  it.each(READS)('allows a VERIFIED guardian: %s', (action) => {
    expect(decide(guardian, action, session(), { guardianOf: [LEARNER] }).effect).toBe('allow');
  });

  it.each(READS)('refuses a guardian of a different child: %s', (action) => {
    expect(decide(guardian, action, session(), { guardianOf: [OTHER] }).effect).toBe('deny');
  });

  it.each(READS)('allows the teacher of the shared class: %s', (action) => {
    expect(decide(teacher, action, session({ observableByActorAsTeacher: true })).effect).toBe(
      'allow',
    );
  });

  it.each(READS)('refuses a teacher who does not share the class: %s', (action) => {
    // The conjunction — teaches the class AND this lesson's course is assigned
    // to that same class — is computed in SQL. `false` here is the whole answer.
    expect(decide(teacher, action, session()).effect).toBe('deny');
  });

  it.each(READS)('allows an administrator of the learner’s school: %s', (action) => {
    expect(decide(admin, action, session()).effect).toBe('allow');
  });

  it.each(READS)('refuses an administrator of ANOTHER school: %s', (action) => {
    expect(decide(foreignAdmin, action, session()).effect).toBe('deny');
  });

  it.each(READS)('refuses a school security administrator: %s', (action) => {
    // Accounts and lockouts are one authority; every child's lab work is
    // another, and it must not ride along.
    expect(decide(securityAdmin, action, session()).effect).toBe('deny');
  });

  it.each(READS)('allows a platform operator: %s', (action) => {
    expect(decide(operator, action, session()).effect).toBe('allow');
  });

  it.each(READS)('refuses a peer, and hides rather than refuses: %s', (action) => {
    const d = decide(peer, action, session());
    expect(d.effect === 'deny' && d.disclosure).toBe('hide');
  });

  it('refuses an administrator with no organization at all', () => {
    const homeless = actor({ id: OTHER, roles: [Role.ADMIN], organizationId: null });
    expect(decide(homeless, 'experiment_session:read', session()).effect).toBe('deny');
  });

  it('refuses an administrator when the LEARNER has no organization', () => {
    expect(
      decide(admin, 'experiment_session:read', session({ learnerOrganizationId: null })).effect,
    ).toBe('deny');
  });
});

describe('the policy is never told the verdict', () => {
  it('has no field on the resource that could carry one', () => {
    // Structural, not careful. Authorization decides who may look at a result;
    // it takes no part in deciding one, and a policy that could read `passed`
    // would invite a branch that behaved differently for a child who did badly.
    expect(Object.keys(session())).not.toContain('passed');
    expect(Object.keys(session())).not.toContain('score');
  });
});
