import { describe, expect, it } from 'vitest';
import {
  createPolicyEngine,
  EMPTY_RELATIONSHIPS,
  Role,
  type Actor,
  type AuthorizationContext,
  type ContentStatus,
  type Resource,
} from '@edu/authz';

/**
 * The decision table for assigning a course to a class.
 *
 * The edge is small but consequential: it decides which learners a piece of
 * published content actually reaches. The corners worth enumerating are the
 * cross-tenant ones (a course from one school, a class from another) and the
 * lifecycle ones (a draft course, an inactive class, an archived assignment).
 *
 * The RLS half is asserted in `tests/integration/rls-class-courses.test.ts`,
 * with no application code in the path.
 */
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const CLASS_A = '33333333-3333-4333-8333-333333333333';
const CLASS_B = '44444444-4444-4444-8444-444444444444';
const COURSE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SELF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const engine = createPolicyEngine();

function actor(
  overrides: Partial<Actor> & Pick<Actor, 'roles'> & { permissions: readonly string[] },
): Actor {
  return {
    id: SELF,
    status: 'active',
    emailVerified: true,
    organizationId: ORG_A,
    grants: overrides.roles.map((role) => ({ role, scopeType: 'global' as const, scopeId: null })),
    ...overrides,
  };
}

const ctx = (a: Actor, rel: Partial<typeof EMPTY_RELATIONSHIPS> = {}): AuthorizationContext => ({
  actor: a,
  relationships: { ...EMPTY_RELATIONSHIPS, ...rel },
});

const teacher = actor({ roles: [Role.TEACHER], permissions: ['classes:manage'] });
const admin = actor({ roles: [Role.ADMIN], permissions: ['classes:manage'] });
const student = actor({ roles: [Role.STUDENT], permissions: [] });
const author = actor({ roles: [Role.CONTENT_AUTHOR], permissions: ['content:author'] });
const foreignAdmin = actor({
  roles: [Role.ADMIN],
  permissions: ['classes:manage'],
  organizationId: ORG_B,
});
const platformOperator: Actor = {
  id: SELF,
  roles: [Role.SECURITY_ADMIN],
  grants: [{ role: Role.SECURITY_ADMIN, scopeType: 'global', scopeId: null }],
  permissions: [],
  status: 'active',
  emailVerified: true,
  organizationId: null,
};

const assignment = (over: Record<string, unknown> = {}): Resource =>
  ({
    kind: 'class_course_assignment',
    id: 'assignment-1',
    classId: CLASS_A,
    classOrganizationId: ORG_A,
    courseId: COURSE,
    courseOrganizationId: ORG_A,
    courseStatus: 'published' as ContentStatus,
    classIsActive: true,
    state: 'active',
    ...over,
  }) as never;

/** The two standings that may manage a class's syllabus. */
const teachesIt = { teachesClasses: [CLASS_A] };
const memberOfIt = { memberOfClasses: [CLASS_A] };

// =========================================================================
describe('who may assign a course to a class', () => {
  it('lets a TEACHER OF THAT CLASS assign', () => {
    expect(
      engine.decide(ctx(teacher, teachesIt), 'class_course_assignment:create', assignment()).effect,
    ).toBe('allow');
  });

  it('lets an ADMIN of the class’s organization assign', () => {
    expect(engine.decide(ctx(admin), 'class_course_assignment:create', assignment()).effect).toBe(
      'allow',
    );
  });

  it('REFUSES a teacher of a DIFFERENT class', () => {
    const decision = engine.decide(
      ctx(teacher, { teachesClasses: [CLASS_B] }),
      'class_course_assignment:create',
      assignment(),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'class_course_assignment.requires_teacher_or_admin',
    );
  });

  it('REFUSES a STUDENT, including one enrolled in the class', () => {
    for (const rel of [{}, memberOfIt]) {
      const decision = engine.decide(
        ctx(student, rel),
        'class_course_assignment:create',
        assignment(),
      );
      expect(decision.effect).toBe('deny');
      // A student holds no `classes:manage`, so they are refused before the
      // class relationship is even considered.
      expect(decision.effect === 'deny' && decision.reason).toBe(
        'class_course_assignment.missing_permission',
      );
      expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
    }
  });

  it('REFUSES a content author — writing content is not running a class', () => {
    expect(engine.decide(ctx(author), 'class_course_assignment:create', assignment()).effect).toBe(
      'deny',
    );
  });

  it('lets a platform operator assign', () => {
    expect(
      engine.decide(ctx(platformOperator), 'class_course_assignment:create', assignment()).effect,
    ).toBe('allow');
  });
});

// =========================================================================
describe('cross-tenant assignments are refused in both directions', () => {
  it('REFUSES an admin of another school assigning to this class', () => {
    const decision = engine.decide(
      ctx(foreignAdmin),
      'class_course_assignment:create',
      assignment(),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'class_course_assignment.cross_organization_forbidden',
    );
    expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
  });

  it('REFUSES assigning ANOTHER school’s course to this class', () => {
    const decision = engine.decide(
      ctx(admin),
      'class_course_assignment:create',
      assignment({ courseOrganizationId: ORG_B }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'class_course_assignment.course_outside_class_organization',
    );
    // `hide`: a 403 would confirm that the course id names something real in
    // another school.
    expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
  });

  it('REFUSES assigning to a class in another school even with the right course', () => {
    expect(
      engine.decide(
        ctx(admin),
        'class_course_assignment:create',
        assignment({ classOrganizationId: ORG_B }),
      ).effect,
    ).toBe('deny');
  });

  it('ALLOWS a GLOBAL course — the one case where the organizations differ', () => {
    expect(
      engine.decide(
        ctx(admin),
        'class_course_assignment:create',
        assignment({ courseOrganizationId: null }),
      ).effect,
    ).toBe('allow');
  });

  it('REFUSES an actor with no organization at all', () => {
    const orphan = actor({
      roles: [Role.ADMIN],
      permissions: ['classes:manage'],
      organizationId: null,
    });
    expect(engine.decide(ctx(orphan), 'class_course_assignment:create', assignment()).effect).toBe(
      'deny',
    );
  });
});

// =========================================================================
describe('what may be assigned, and when', () => {
  it.each(['draft', 'archived'] as const)('REFUSES assigning a %s course', (courseStatus) => {
    const decision = engine.decide(
      ctx(admin),
      'class_course_assignment:create',
      assignment({ courseStatus }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'class_course_assignment.only_published_may_be_assigned',
    );
    // `reveal`: the admin can see this course, so hiding it would be confusing.
    expect(decision.effect === 'deny' && decision.disclosure).toBe('reveal');
  });

  it('REFUSES assigning to an ARCHIVED class', () => {
    const decision = engine.decide(
      ctx(admin),
      'class_course_assignment:create',
      assignment({ classIsActive: false }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'class_course_assignment.class_is_not_active',
    );
  });

  it('REFUSES an assignment that arrives already withdrawn', () => {
    const decision = engine.decide(
      ctx(admin),
      'class_course_assignment:create',
      assignment({ state: 'inactive' }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'class_course_assignment.must_start_active',
    );
  });
});

// =========================================================================
describe('withdrawing an assignment', () => {
  it('lets a teacher of the class and an admin withdraw', () => {
    expect(
      engine.decide(ctx(teacher, teachesIt), 'class_course_assignment:remove', assignment()).effect,
    ).toBe('allow');
    expect(engine.decide(ctx(admin), 'class_course_assignment:remove', assignment()).effect).toBe(
      'allow',
    );
  });

  it('REFUSES a student withdrawing, enrolled or not', () => {
    expect(
      engine.decide(ctx(student, memberOfIt), 'class_course_assignment:remove', assignment())
        .effect,
    ).toBe('deny');
  });

  it('REFUSES withdrawing one that is already withdrawn', () => {
    const decision = engine.decide(
      ctx(admin),
      'class_course_assignment:remove',
      assignment({ state: 'inactive' }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'class_course_assignment.already_withdrawn',
    );
  });

  it('REFUSES touching an ARCHIVED assignment — the class itself ended', () => {
    const decision = engine.decide(
      ctx(admin),
      'class_course_assignment:remove',
      assignment({ state: 'archived' }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'class_course_assignment.archived_is_final',
    );
  });
});

// =========================================================================
describe('reading the syllabus', () => {
  it('lets an ENROLLED learner see which courses their class studies', () => {
    // The syllabus is not a secret from the people following it.
    expect(
      engine.decide(ctx(student, memberOfIt), 'class_course_assignment:list', assignment()).effect,
    ).toBe('allow');
  });

  it('lets a teacher of the class and an admin of its school see it', () => {
    expect(
      engine.decide(ctx(teacher, teachesIt), 'class_course_assignment:read', assignment()).effect,
    ).toBe('allow');
    expect(engine.decide(ctx(admin), 'class_course_assignment:read', assignment()).effect).toBe(
      'allow',
    );
  });

  it('HIDES it from a learner in a DIFFERENT class', () => {
    const decision = engine.decide(
      ctx(student, { memberOfClasses: [CLASS_B] }),
      'class_course_assignment:read',
      assignment(),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
  });

  it('HIDES it from an admin of another school', () => {
    expect(
      engine.decide(ctx(foreignAdmin), 'class_course_assignment:read', assignment()).effect,
    ).toBe('deny');
  });

  it('still shows a WITHDRAWN assignment to the class — it is history, not a secret', () => {
    expect(
      engine.decide(
        ctx(teacher, teachesIt),
        'class_course_assignment:read',
        assignment({ state: 'inactive' }),
      ).effect,
    ).toBe('allow');
  });
});

// =========================================================================
describe('the global pre-checks still apply', () => {
  it('denies a SUSPENDED admin every action', () => {
    const suspended = { ...admin, status: 'suspended' as const };
    for (const action of [
      'class_course_assignment:create',
      'class_course_assignment:read',
      'class_course_assignment:remove',
    ] as const) {
      expect(engine.decide(ctx(suspended), action, assignment()).effect).toBe('deny');
    }
  });
});
