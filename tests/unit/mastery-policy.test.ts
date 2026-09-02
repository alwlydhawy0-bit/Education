import { describe, expect, it } from 'vitest';
import {
  createPolicyEngine,
  EMPTY_RELATIONSHIPS,
  Role,
  type Actor,
  type AuthorizationContext,
  type ObjectiveProgressResource,
} from '@edu/authz';
import { assembleCourse, tally } from '../../apps/api/src/modules/mastery/mastery.service.ts';
import type { ObjectiveMasteryRecord } from '../../apps/api/src/modules/mastery/mastery.repository.ts';
import type { MasteryState } from '@edu/contracts';

/**
 * The decision table for objective progress, and the pure aggregation.
 *
 * TWO THINGS ARE DELIBERATELY ABSENT FROM THIS FILE:
 *
 *   1. Any WRITE case. `ObjectiveProgressAction` is `read` and `list`; there is
 *      no action for asserting a mastery state, so there is no denial to test.
 *      "The client submitted MASTERED" is refused by the vocabulary, not by a
 *      branch. `tests/security/mastery.test.ts` proves the same over HTTP by
 *      showing the routes do not exist.
 *   2. The MASTERY RULES themselves. They live in `app_objective_mastery` — SQL,
 *      SECURITY DEFINER — so the answer to "what does this child understand?"
 *      has exactly one implementation. They are enumerated against a real
 *      database in `tests/integration/rls-mastery.test.ts`.
 *
 * What IS here: who may look, and how objective states roll up.
 */
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const LEARNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LESSON = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OBJECTIVE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

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
const teacher = actor({ id: OTHER, roles: [Role.TEACHER] });
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

function progress(overrides: Partial<ObjectiveProgressResource> = {}): ObjectiveProgressResource {
  return {
    kind: 'objective_progress',
    id: `${LEARNER}:${OBJECTIVE}`,
    learnerId: LEARNER,
    learnerOrganizationId: ORG_A,
    objectiveId: OBJECTIVE,
    lessonId: LESSON,
    observableByActorAsTeacher: false,
    ...overrides,
  };
}

const decide = (
  a: Actor,
  action: Parameters<typeof engine.decide>[1],
  resource: ObjectiveProgressResource,
  rel: Partial<typeof EMPTY_RELATIONSHIPS> = {},
) => engine.decide(ctx(a, rel), action, resource);

describe('objective progress — who may read', () => {
  it('the learner reads their own with NO access check', () => {
    // The retention rule, stated as a test: losing the class must not erase what
    // a child demonstrated from their own view. The resource carries no
    // "still reaches the lesson" flag for this branch to consult.
    expect(decide(learner, 'objective_progress:read', progress()).effect).toBe('allow');
  });

  it('a verified guardian reads it', () => {
    expect(
      decide(guardian, 'objective_progress:read', progress(), { guardianOf: [LEARNER] }).effect,
    ).toBe('allow');
  });

  it('a guardian of a DIFFERENT child does not', () => {
    expect(
      decide(guardian, 'objective_progress:read', progress(), { guardianOf: [OTHER] }).effect,
    ).toBe('deny');
  });

  it('a teacher who shares the class reads it', () => {
    expect(
      decide(teacher, 'objective_progress:read', progress({ observableByActorAsTeacher: true }), {
        teacherOf: [LEARNER],
      }).effect,
    ).toBe('allow');
  });

  it('a teacher who does NOT share the class does not — even holding teacherOf', () => {
    // `observableByActorAsTeacher` is computed by the database from the class
    // roster AND the course assignment, on this objective's own lesson. A
    // snapshot saying "teaches this learner somewhere" is not the same claim.
    const decision = decide(
      teacher,
      'objective_progress:read',
      progress({ observableByActorAsTeacher: false }),
      { teacherOf: [LEARNER] },
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
  });

  it('an administrator of the learner’s school reads it', () => {
    expect(decide(admin, 'objective_progress:read', progress()).effect).toBe('allow');
  });

  it('an administrator of ANOTHER school does not', () => {
    expect(decide(foreignAdmin, 'objective_progress:read', progress()).effect).toBe('deny');
  });

  it('an administrator with NO organization matches nothing', () => {
    // `organizationId !== null` is what stops null === null from admitting an
    // organization-less admin to an organization-less learner.
    expect(
      decide(
        actor({ id: OTHER, roles: [Role.ADMIN], organizationId: null }),
        'objective_progress:read',
        progress({ learnerOrganizationId: null }),
      ).effect,
    ).toBe('deny');
  });

  it('a SECURITY administrator of the same school does not', () => {
    // Accounts and lockouts are their remit. Every child's learning record is a
    // different authority that must not ride along with it (VULN-020).
    expect(decide(securityAdmin, 'objective_progress:read', progress()).effect).toBe('deny');
  });

  it('a peer reads nothing, and is not told the objective exists', () => {
    const decision = decide(peer, 'objective_progress:read', progress());
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
  });

  it('a platform operator reads it', () => {
    expect(decide(operator, 'objective_progress:read', progress()).effect).toBe('allow');
  });

  it('the same table governs list as read', () => {
    expect(decide(peer, 'objective_progress:list', progress()).effect).toBe('deny');
    expect(decide(learner, 'objective_progress:list', progress()).effect).toBe('allow');
  });
});

describe('objective progress — the engine’s global pre-checks still apply', () => {
  it.each([['suspended'], ['pending_verification']] as const)(
    'a %s learner cannot read even their own record',
    (status) => {
      expect(
        decide(
          actor({ id: LEARNER, roles: [Role.STUDENT], status }),
          'objective_progress:read',
          progress(),
        ).effect,
      ).toBe('deny');
    },
  );

  it('an actor with no roles is denied', () => {
    expect(
      decide(actor({ id: LEARNER, roles: [] }), 'objective_progress:read', progress()).effect,
    ).toBe('deny');
  });
});

// =====================================================================
// Aggregation — counts, never a blended average
// =====================================================================

describe('tally', () => {
  it('counts each state separately', () => {
    const states: MasteryState[] = [
      'no_evidence',
      'attempted',
      'attempted',
      'developing',
      'demonstrated',
      'mastered',
    ];
    expect(tally(states)).toEqual({
      total: 6,
      noEvidence: 1,
      attempted: 2,
      developing: 1,
      demonstrated: 1,
      mastered: 1,
      demonstratedPercentage: 33.3,
    });
  });

  it('reports NULL rather than 0 for an empty set', () => {
    // A course with nothing to demonstrate is unmeasurable, not failed.
    // Reporting 0% would read as failure to a child who has done nothing wrong.
    expect(tally([]).demonstratedPercentage).toBeNull();
  });

  it('counts only `demonstrated` and `mastered` towards the percentage', () => {
    // `attempted` and `developing` are engagement, not demonstration. Folding
    // them in at half weight would be an invented number nobody could defend.
    expect(tally(['attempted', 'developing']).demonstratedPercentage).toBe(0);
    expect(tally(['demonstrated', 'mastered']).demonstratedPercentage).toBe(100);
  });

  it('rounds to one decimal rather than pretending to more precision', () => {
    expect(tally(['mastered', 'no_evidence', 'no_evidence']).demonstratedPercentage).toBe(33.3);
  });
});

describe('assembleCourse', () => {
  const row = (over: Partial<ObjectiveMasteryRecord>): ObjectiveMasteryRecord => ({
    objectiveId: 'o1',
    statement: 'Statement',
    position: 1,
    lessonId: 'l1',
    lessonTitle: 'Lesson 1',
    unitId: 'u1',
    unitTitle: 'Unit 1',
    unitPosition: 1,
    courseId: 'c1',
    courseTitle: 'Physics',
    mastery: 'no_evidence',
    evidenceCount: 0,
    lastEvidenceAt: null,
    lessonStatus: 'not_started',
    learnerId: LEARNER,
    learnerOrganizationId: ORG_A,
    observableByActorAsTeacher: false,
    ...over,
  });

  it('returns null for no rows', () => {
    expect(assembleCourse([])).toBeNull();
  });

  it('groups objectives under lessons under units, preserving order', () => {
    const assembled = assembleCourse([
      row({ objectiveId: 'o1', lessonId: 'l1', unitId: 'u1', position: 1 }),
      row({ objectiveId: 'o2', lessonId: 'l1', unitId: 'u1', position: 2 }),
      row({ objectiveId: 'o3', lessonId: 'l2', unitId: 'u1', lessonTitle: 'Lesson 2' }),
      row({
        objectiveId: 'o4',
        lessonId: 'l3',
        unitId: 'u2',
        unitTitle: 'Unit 2',
        unitPosition: 2,
      }),
    ]);
    expect(assembled?.units).toHaveLength(2);
    expect(assembled?.units[0]?.lessons).toHaveLength(2);
    expect(assembled?.units[0]?.lessons[0]?.objectives.map((o) => o.objectiveId)).toEqual([
      'o1',
      'o2',
    ]);
    expect(assembled?.units[1]?.unitTitle).toBe('Unit 2');
  });

  it('COUNTS LESSONS ONCE, however many objectives they carry', () => {
    // Otherwise a lesson written with four objectives would count four times,
    // and a course would appear more complete the more finely it was authored.
    const assembled = assembleCourse([
      row({ objectiveId: 'o1', lessonId: 'l1', lessonStatus: 'completed' }),
      row({ objectiveId: 'o2', lessonId: 'l1', lessonStatus: 'completed' }),
      row({ objectiveId: 'o3', lessonId: 'l1', lessonStatus: 'completed' }),
      row({ objectiveId: 'o4', lessonId: 'l2', lessonStatus: 'not_started' }),
    ]);
    expect(assembled?.lessonsTotal).toBe(2);
    expect(assembled?.lessonsCompleted).toBe(1);
  });

  it('reports objective mastery and lesson completion SEPARATELY', () => {
    // A learner can finish every lesson and demonstrate nothing. A view that
    // blended the two would hide exactly that, which is the case a teacher most
    // needs to see.
    const assembled = assembleCourse([
      row({ objectiveId: 'o1', lessonId: 'l1', lessonStatus: 'completed', mastery: 'attempted' }),
      row({ objectiveId: 'o2', lessonId: 'l2', lessonStatus: 'completed', mastery: 'attempted' }),
    ]);
    expect(assembled?.lessonsCompleted).toBe(2);
    expect(assembled?.tally.demonstratedPercentage).toBe(0);
    expect(assembled?.tally.attempted).toBe(2);
  });

  it('tallies at every level from the same states', () => {
    const assembled = assembleCourse([
      row({ objectiveId: 'o1', lessonId: 'l1', unitId: 'u1', mastery: 'mastered' }),
      row({ objectiveId: 'o2', lessonId: 'l1', unitId: 'u1', mastery: 'no_evidence' }),
      row({ objectiveId: 'o3', lessonId: 'l2', unitId: 'u2', mastery: 'demonstrated' }),
    ]);
    expect(assembled?.units[0]?.lessons[0]?.tally.total).toBe(2);
    expect(assembled?.units[0]?.tally.demonstratedPercentage).toBe(50);
    expect(assembled?.units[1]?.tally.demonstratedPercentage).toBe(100);
    expect(assembled?.tally.total).toBe(3);
    expect(assembled?.tally.demonstratedPercentage).toBe(66.7);
  });
});
