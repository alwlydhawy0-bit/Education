import { describe, expect, it } from 'vitest';
import {
  createPolicyEngine,
  CONTENT_AUTHOR_PERMISSION,
  CONTENT_PUBLISH_PERMISSION,
  EMPTY_RELATIONSHIPS,
  Role,
  type Actor,
  type AuthorizationContext,
  type ContentStatus,
  type Resource,
} from '@edu/authz';

/**
 * The decision table for the educational content tree.
 *
 * Written as a table rather than as prose because the surface is a product of
 * four independent axes — catalog (global / own school / another school),
 * lifecycle (draft / published / archived), permission (author / publish /
 * neither) and verb — and the interesting cases are the corners. The engine is
 * pure, so every case here runs without a database.
 *
 * The RLS half of the same rules is asserted in
 * `tests/integration/rls-content.test.ts`, with no application code in the path.
 */
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const SELF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NODE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

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

const ctx = (a: Actor): AuthorizationContext => ({ actor: a, relationships: EMPTY_RELATIONSHIPS });

/**
 * A context where the actor reaches the course through a class (Task 006).
 *
 * Since 0017 a LEARNER sees published content only when it is assigned to a
 * class they are in, so most "a student can read this" cases now need this
 * context rather than the empty one. `COURSE` is the id every content node in
 * this file belongs to.
 */
const COURSE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const enrolledCtx = (a: Actor): AuthorizationContext => ({
  actor: a,
  relationships: { ...EMPTY_RELATIONSHIPS, coursesViaClasses: [COURSE] },
});

/** An author writes drafts. A reviewer publishes them. Neither is the other. */
const author = actor({ roles: [Role.CONTENT_AUTHOR], permissions: [CONTENT_AUTHOR_PERMISSION] });
const teacher = actor({ roles: [Role.TEACHER], permissions: [CONTENT_AUTHOR_PERMISSION] });
const reviewer = actor({ roles: [Role.REVIEWER], permissions: [CONTENT_PUBLISH_PERMISSION] });
const admin = actor({
  roles: [Role.ADMIN],
  permissions: [CONTENT_AUTHOR_PERMISSION, CONTENT_PUBLISH_PERMISSION],
});
const student = actor({ roles: [Role.STUDENT], permissions: [] });
const foreignAuthor = actor({
  roles: [Role.CONTENT_AUTHOR],
  permissions: [CONTENT_AUTHOR_PERMISSION],
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

/** A content node of any kind. The rule is identical at every level. */
const node = (
  kind: 'curriculum' | 'course' | 'course_unit' | 'lesson',
  over: Record<string, unknown> = {},
): Resource =>
  ({
    kind,
    id: NODE,
    organizationId: ORG_A,
    status: 'draft' as ContentStatus,
    ancestorsPublished: true,
    ...(kind === 'course' ? { id: COURSE, curriculumId: 'c', levelId: 'l' } : {}),
    ...(kind === 'course_unit' ? { courseId: COURSE } : {}),
    ...(kind === 'lesson' ? { unitId: 'u', courseId: COURSE } : {}),
    ...over,
  }) as never;

const KINDS = ['curriculum', 'course', 'course_unit', 'lesson'] as const;

// =========================================================================
describe('contentPolicy — reading', () => {
  it.each(KINDS)('lets an ENROLLED learner read PUBLISHED %s in their own school', (kind) => {
    expect(
      engine.decide(enrolledCtx(student), `${kind}:read`, node(kind, { status: 'published' }))
        .effect,
    ).toBe('allow');
  });

  it.each(KINDS)('lets an ENROLLED learner read PUBLISHED %s in the GLOBAL catalog', (kind) => {
    expect(
      engine.decide(
        enrolledCtx(student),
        `${kind}:read`,
        node(kind, { status: 'published', organizationId: null }),
      ).effect,
    ).toBe('allow');
  });

  // --- The Task 006 narrowing -------------------------------------------
  // Published is no longer enough for a learner. Curricula are the deliberate
  // exception: the subject catalog names subjects, not content.
  it.each(['course', 'course_unit', 'lesson'] as const)(
    'HIDES a published %s from a learner whose class was not assigned it',
    (kind) => {
      const decision = engine.decide(
        ctx(student),
        `${kind}:read`,
        node(kind, { status: 'published' }),
      );
      expect(decision.effect).toBe('deny');
      expect(decision.effect === 'deny' && decision.reason).toBe('content.not_visible');
      // `hide`, not `reveal`: "assigned to somebody else's class" and "does not
      // exist" must be indistinguishable.
      expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
    },
  );

  it('still shows a published CURRICULUM without any assignment', () => {
    // The catalog stays browsable. A learner may know their school teaches
    // mathematics before anybody assigns them a maths course.
    expect(
      engine.decide(ctx(student), 'curriculum:read', node('curriculum', { status: 'published' }))
        .effect,
    ).toBe('allow');
  });

  it.each(['course', 'course_unit', 'lesson'] as const)(
    'REFUSES an assignment to a %s in ANOTHER school, so it cannot widen',
    (kind) => {
      // The reachability edge is present, but the catalog check runs first and
      // still refuses. An assignment can only ever narrow.
      expect(
        engine.decide(
          enrolledCtx(student),
          `${kind}:read`,
          node(kind, { status: 'published', organizationId: ORG_B }),
        ).effect,
      ).toBe('deny');
    },
  );

  it.each(KINDS)('HIDES a draft %s from a student', (kind) => {
    const decision = engine.decide(ctx(student), `${kind}:read`, node(kind));
    expect(decision.effect).toBe('deny');
    // `hide`, not `reveal`: a 403 here would confirm the id names real content.
    expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
    expect(decision.effect === 'deny' && decision.reason).toBe('content.not_visible');
  });

  it.each(KINDS)('HIDES an ARCHIVED %s from a student', (kind) => {
    const decision = engine.decide(
      ctx(student),
      `${kind}:read`,
      node(kind, { status: 'archived' }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
  });

  it.each(KINDS)('HIDES another school’s published %s', (kind) => {
    expect(
      engine.decide(
        ctx(student),
        `${kind}:read`,
        node(kind, { status: 'published', organizationId: ORG_B }),
      ).effect,
    ).toBe('deny');
  });

  it.each(KINDS)('lets an author of the same school read a draft %s', (kind) => {
    expect(engine.decide(ctx(author), `${kind}:read`, node(kind)).effect).toBe('allow');
  });

  it.each(KINDS)('lets an editor read PUBLISHED %s with NO class attachment', (kind) => {
    // Editorial standing is not a learner relationship: an author reads their
    // school's content because they maintain it, not because they study it.
    for (const editor of [author, teacher, reviewer, admin]) {
      expect(
        engine.decide(ctx(editor), `${kind}:read`, node(kind, { status: 'published' })).effect,
      ).toBe('allow');
    }
  });

  it.each(KINDS)('lets a REVIEWER read a draft %s — they must, to review it', (kind) => {
    expect(engine.decide(ctx(reviewer), `${kind}:read`, node(kind)).effect).toBe('allow');
  });

  it.each(KINDS)('HIDES a draft %s from an author of ANOTHER school', (kind) => {
    expect(engine.decide(ctx(foreignAuthor), `${kind}:read`, node(kind)).effect).toBe('deny');
  });

  it('refuses a published lesson whose UNIT is still a draft', () => {
    // The tree is only as visible as its least-visible ancestor.
    const decision = engine.decide(
      ctx(student),
      'lesson:read',
      node('lesson', { status: 'published', ancestorsPublished: false }),
    );
    expect(decision.effect).toBe('deny');
  });

  it('refuses a published unit whose COURSE is still a draft', () => {
    expect(
      engine.decide(
        ctx(student),
        'course_unit:read',
        node('course_unit', { status: 'published', ancestorsPublished: false }),
      ).effect,
    ).toBe('deny');
  });
});

// =========================================================================
describe('contentPolicy — authoring', () => {
  it.each(KINDS)('lets an author create a draft %s in their own school', (kind) => {
    expect(engine.decide(ctx(author), `${kind}:create`, node(kind, { id: 'new' })).effect).toBe(
      'allow',
    );
  });

  it.each(KINDS)('lets a TEACHER author a draft %s', (kind) => {
    expect(engine.decide(ctx(teacher), `${kind}:create`, node(kind, { id: 'new' })).effect).toBe(
      'allow',
    );
  });

  it.each(KINDS)('REFUSES a student creating a %s', (kind) => {
    expect(engine.decide(ctx(student), `${kind}:create`, node(kind, { id: 'new' })).effect).toBe(
      'deny',
    );
  });

  it.each(KINDS)('REFUSES a reviewer creating a %s — publishing is not authoring', (kind) => {
    const decision = engine.decide(ctx(reviewer), `${kind}:create`, node(kind, { id: 'new' }));
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'content.create_requires_author_permission',
    );
  });

  it.each(KINDS)('REFUSES creating a %s that arrives already published', (kind) => {
    const decision = engine.decide(
      ctx(author),
      `${kind}:create`,
      node(kind, { id: 'new', status: 'published' }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe('content.must_start_as_draft');
  });

  it.each(KINDS)('REFUSES an ordinary author creating a GLOBAL %s', (kind) => {
    const decision = engine.decide(
      ctx(author),
      `${kind}:create`,
      node(kind, { id: 'new', organizationId: null }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'content.global_catalog_is_operator_only',
    );
  });

  it.each(KINDS)('REFUSES an author of another school editing a %s', (kind) => {
    expect(engine.decide(ctx(foreignAuthor), `${kind}:update`, node(kind)).effect).toBe('deny');
  });

  it.each(KINDS)('REFUSES a reviewer EDITING a %s', (kind) => {
    const decision = engine.decide(ctx(reviewer), `${kind}:update`, node(kind));
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'content.edit_requires_author_permission',
    );
  });

  it.each(KINDS)('treats an ARCHIVED %s as immutable', (kind) => {
    const decision = engine.decide(
      ctx(author),
      `${kind}:update`,
      node(kind, { status: 'archived' }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe('content.archived_is_immutable');
    // `reveal`: the author can see it, so hiding it would only confuse.
    expect(decision.effect === 'deny' && decision.disclosure).toBe('reveal');
  });

  it.each(KINDS)('lets an author edit a PUBLISHED %s — corrections are normal', (kind) => {
    expect(
      engine.decide(ctx(author), `${kind}:update`, node(kind, { status: 'published' })).effect,
    ).toBe('allow');
  });
});

// =========================================================================
describe('contentPolicy — the lifecycle, and who moves it', () => {
  it.each(KINDS)('REFUSES an author publishing their own draft %s', (kind) => {
    // The separation of duties in one assertion: writing and releasing are
    // different authorities, and an author holds only the first.
    const decision = engine.decide(ctx(author), `${kind}:publish`, node(kind));
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'content.requires_publish_permission',
    );
  });

  it.each(KINDS)('REFUSES a teacher publishing a %s', (kind) => {
    expect(engine.decide(ctx(teacher), `${kind}:publish`, node(kind)).effect).toBe('deny');
  });

  it.each(KINDS)('lets a REVIEWER publish a draft %s', (kind) => {
    expect(engine.decide(ctx(reviewer), `${kind}:publish`, node(kind)).effect).toBe('allow');
  });

  it.each(KINDS)('lets an ADMIN publish a draft %s', (kind) => {
    expect(engine.decide(ctx(admin), `${kind}:publish`, node(kind)).effect).toBe('allow');
  });

  it.each(KINDS)('REFUSES publishing an already-published %s', (kind) => {
    const decision = engine.decide(
      ctx(reviewer),
      `${kind}:publish`,
      node(kind, { status: 'published' }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'content.only_a_draft_may_be_published',
    );
  });

  it.each(KINDS)('lets a publisher archive a draft or a published %s', (kind) => {
    expect(engine.decide(ctx(reviewer), `${kind}:archive`, node(kind)).effect).toBe('allow');
    expect(
      engine.decide(ctx(reviewer), `${kind}:archive`, node(kind, { status: 'published' })).effect,
    ).toBe('allow');
  });

  it.each(KINDS)('REFUSES archiving an already-archived %s', (kind) => {
    expect(
      engine.decide(ctx(reviewer), `${kind}:archive`, node(kind, { status: 'archived' })).effect,
    ).toBe('deny');
  });

  it.each(KINDS)('REFUSES a student publishing anything (%s)', (kind) => {
    expect(engine.decide(ctx(student), `${kind}:publish`, node(kind)).effect).toBe('deny');
  });
});

// =========================================================================
describe('contentPolicy — deletion', () => {
  it.each(KINDS)('lets an author delete a DRAFT %s', (kind) => {
    expect(engine.decide(ctx(author), `${kind}:delete`, node(kind)).effect).toBe('allow');
  });

  it.each(KINDS)('REFUSES deleting a PUBLISHED %s — archive it instead', (kind) => {
    const decision = engine.decide(
      ctx(author),
      `${kind}:delete`,
      node(kind, { status: 'published' }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'content.published_cannot_be_deleted',
    );
  });

  it.each(KINDS)('REFUSES deleting an ARCHIVED %s', (kind) => {
    expect(
      engine.decide(ctx(author), `${kind}:delete`, node(kind, { status: 'archived' })).effect,
    ).toBe('deny');
  });

  it.each(KINDS)('HIDES a %s from a student attempting to delete it', (kind) => {
    // Order matters: the SCOPE check runs before the STATE check, so a student
    // gets 404 rather than a 403 that would confirm the content exists.
    const decision = engine.decide(
      ctx(student),
      `${kind}:delete`,
      node(kind, { status: 'published' }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
  });
});

// =========================================================================
describe('contentPolicy — the global catalog', () => {
  it.each(KINDS)('lets a platform operator do anything to a global %s', (kind) => {
    for (const verb of ['read', 'update', 'publish', 'archive', 'delete'] as const) {
      expect(
        engine.decide(
          ctx(platformOperator),
          `${kind}:${verb}`,
          node(kind, { organizationId: null }),
        ).effect,
      ).toBe('allow');
    }
  });

  it.each(KINDS)('REFUSES an ADMIN writing to a global %s', (kind) => {
    // The strongest role inside a school still has no standing in the shared
    // catalog. This is the "unauthorized teacher cannot modify global content"
    // requirement, asserted at its most permissive end.
    for (const verb of ['update', 'publish', 'archive', 'delete'] as const) {
      const decision = engine.decide(
        ctx(admin),
        `${kind}:${verb}`,
        node(kind, { organizationId: null }),
      );
      expect(decision.effect).toBe('deny');
      expect(decision.effect === 'deny' && decision.reason).toBe(
        'content.global_catalog_is_operator_only',
      );
    }
  });

  it.each(['course', 'course_unit', 'lesson'] as const)(
    'HIDES published global %s from a LEARNER with no class attachment to it',
    (kind) => {
      // The narrowing reaches the global catalog too: publication makes content
      // available to a school, not to every child in it.
      expect(
        engine.decide(
          ctx(student),
          `${kind}:read`,
          node(kind, { organizationId: null, status: 'published' }),
        ).effect,
      ).toBe('deny');
    },
  );

  it.each(['course', 'course_unit', 'lesson'] as const)(
    'still lets CONTENT STAFF browse published global %s with no assignment',
    (kind) => {
      // Staff must be able to see the shared catalog in order to choose what to
      // assign — a person who cannot read a course cannot assign it. This
      // grants nothing publication had not already made public to their school.
      for (const staff of [author, teacher, reviewer, admin]) {
        const decision = engine.decide(
          ctx(staff),
          `${kind}:read`,
          node(kind, { organizationId: null, status: 'published' }),
        );
        expect(decision.effect).toBe('allow');
        expect(decision.effect === 'allow' && decision.reason).toBe(
          'content.published_and_actor_is_content_staff',
        );
      }
    },
  );

  it.each(['course', 'course_unit', 'lesson'] as const)(
    'does NOT let content staff read another school’s published %s',
    (kind) => {
      // The catalog check still runs first. Staff standing widens nothing
      // across a tenancy boundary.
      expect(
        engine.decide(
          ctx(author),
          `${kind}:read`,
          node(kind, { organizationId: ORG_B, status: 'published' }),
        ).effect,
      ).toBe('deny');
    },
  );

  it.each(KINDS)('still lets an ENROLLED admin READ published global %s', (kind) => {
    expect(
      engine.decide(
        enrolledCtx(admin),
        `${kind}:read`,
        node(kind, { organizationId: null, status: 'published' }),
      ).effect,
    ).toBe('allow');
  });
});

// =========================================================================
describe('educationLevelPolicy', () => {
  const level = { kind: 'education_level' as const, id: NODE };

  it('lets any authenticated actor read and list levels', () => {
    for (const a of [student, teacher, author, reviewer, admin]) {
      expect(engine.decide(ctx(a), 'education_level:read', level).effect).toBe('allow');
      expect(engine.decide(ctx(a), 'education_level:list', level).effect).toBe('allow');
    }
  });

  it('REFUSES everyone but a platform operator writing one', () => {
    for (const a of [student, teacher, author, reviewer, admin]) {
      const decision = engine.decide(ctx(a), 'education_level:create', level);
      expect(decision.effect).toBe('deny');
      // `reveal`: levels are readable by everyone, so hiding is pointless.
      expect(decision.effect === 'deny' && decision.disclosure).toBe('reveal');
    }
    expect(engine.decide(ctx(platformOperator), 'education_level:create', level).effect).toBe(
      'allow',
    );
  });
});

// =========================================================================
describe('the global pre-checks still apply to content', () => {
  it.each(KINDS)('denies a SUSPENDED author every action on a %s', (kind) => {
    const suspended = { ...author, status: 'suspended' as const };
    for (const verb of ['read', 'create', 'update', 'publish', 'delete'] as const) {
      expect(engine.decide(ctx(suspended), `${kind}:${verb}`, node(kind)).effect).toBe('deny');
    }
  });

  it.each(KINDS)('denies an actor with NO roles reading a published %s', (kind) => {
    const roleless = { ...student, roles: [] as never[] };
    expect(
      engine.decide(ctx(roleless), `${kind}:read`, node(kind, { status: 'published' })).effect,
    ).toBe('deny');
  });
});
