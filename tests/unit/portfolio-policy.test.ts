import { describe, expect, it } from 'vitest';
import {
  studentPortfolioPolicy,
  studentProjectPolicy,
  type AuthorizationContext,
  type StudentPortfolioAction,
  type StudentPortfolioResource,
  type StudentProjectAction,
  type StudentProjectResource,
} from '@edu/authz';

/**
 * The decision tables for projects and portfolios.
 *
 * PURE FUNCTIONS, SO EVERY CELL IS CHEAP. `tests/security/portfolio.test.ts`
 * proves the boundary holds over HTTP and `tests/integration/rls-projects.test.ts`
 * proves the database holds it alone; this enumerates the grid, including the
 * combinations that are awkward to construct end to end — a teacher who owns a
 * project in a class they teach, a project whose class was deleted, a reviewer
 * looking at a draft.
 */

const OWNER = 'owner-id';
const OTHER = 'other-id';

const ctx = (actorId: string): AuthorizationContext =>
  ({
    actor: { id: actorId, roles: [], organizationId: 'org' },
    relationships: { teachesStudents: [], guardianOf: [], sharesClassWith: [] },
  }) as unknown as AuthorizationContext;

const project = (overrides: Partial<StudentProjectResource> = {}): StudentProjectResource => ({
  kind: 'student_project',
  id: 'project-id',
  ownerId: OWNER,
  organizationId: 'org',
  classId: 'class-id',
  visibility: 'private',
  status: 'submitted',
  sharesClassWithActor: false,
  reviewableByActor: false,
  ...overrides,
});

const portfolio = (
  overrides: Partial<StudentPortfolioResource> = {},
): StudentPortfolioResource => ({
  kind: 'student_portfolio',
  id: 'portfolio-id',
  ownerId: OWNER,
  organizationId: 'org',
  isPublished: false,
  publicItemCount: 1,
  ...overrides,
});

const decide = (actorId: string, action: StudentProjectAction, resource: StudentProjectResource) =>
  studentProjectPolicy(ctx(actorId), action, resource);

const decidePortfolio = (
  actorId: string,
  action: StudentPortfolioAction,
  resource: StudentPortfolioResource,
) => studentPortfolioPolicy(ctx(actorId), action, resource);

describe('studentProjectPolicy — the owner', () => {
  it.each([
    'student_project:create',
    'student_project:read',
    'student_project:list',
    'student_project:update',
    'student_project:delete',
  ] as const)('allows %s', (action) => {
    expect(decide(OWNER, action, project()).effect).toBe('allow');
  });

  it('allows the owner every verb regardless of visibility or status', () => {
    for (const visibility of ['private', 'class', 'public'] as const) {
      for (const status of ['draft', 'submitted', 'featured'] as const) {
        const decision = decide(OWNER, 'student_project:update', project({ visibility, status }));
        expect(decision.effect, `${visibility}/${status}`).toBe('allow');
      }
    }
  });

  it('REFUSES the owner featuring their own work, with reveal', () => {
    // Even when every reviewer condition is true — a teacher who owns a project
    // in a class they teach. A self-conferred distinction is not one.
    const decision = decide(OWNER, 'student_project:feature', project({ reviewableByActor: true }));
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.disclosure).toBe('reveal');
    expect(decision.reason).toBe('student_project.no_self_feature');
  });
});

describe('studentProjectPolicy — a classmate', () => {
  it('reads class-visible and public work that is not a draft', () => {
    for (const visibility of ['class', 'public'] as const) {
      expect(
        decide(OTHER, 'student_project:read', project({ visibility, sharesClassWithActor: true }))
          .effect,
        visibility,
      ).toBe('allow');
    }
  });

  it('is refused a private project even in a shared class', () => {
    // The whole meaning of the column: a `private` project is invisible to
    // classmates even though the class is shared.
    expect(
      decide(
        OTHER,
        'student_project:read',
        project({ visibility: 'private', sharesClassWithActor: true }),
      ).effect,
    ).toBe('deny');
  });

  it('is refused a draft at any visibility', () => {
    for (const visibility of ['class', 'public'] as const) {
      expect(
        decide(
          OTHER,
          'student_project:read',
          project({ visibility, status: 'draft', sharesClassWithActor: true }),
        ).effect,
        visibility,
      ).toBe('deny');
    }
  });

  it('is refused when the class is not shared', () => {
    expect(decide(OTHER, 'student_project:read', project({ visibility: 'public' })).effect).toBe(
      'deny',
    );
  });

  it('cannot write, whatever they can read', () => {
    const shared = project({ visibility: 'class', sharesClassWithActor: true });
    expect(decide(OTHER, 'student_project:read', shared).effect).toBe('allow');
    for (const action of [
      'student_project:update',
      'student_project:delete',
      'student_project:feature',
    ] as const) {
      const decision = decide(OTHER, action, shared);
      expect(decision.effect, action).toBe('deny');
      // `hide`, so a classmate refused a write learns nothing they did not
      // already know from being able to read it, and an attacker walking ids
      // cannot separate "exists but not yours" from "does not exist".
      expect(decision.effect === 'deny' && decision.disclosure, action).toBe('hide');
    }
  });
});

describe('studentProjectPolicy — a reviewer', () => {
  const reviewer = project({ reviewableByActor: true });

  it('reads a submitted project at every visibility, private included', () => {
    for (const visibility of ['private', 'class', 'public'] as const) {
      expect(
        decide(OTHER, 'student_project:read', project({ visibility, reviewableByActor: true }))
          .effect,
        visibility,
      ).toBe('allow');
    }
  });

  it('is refused a draft', () => {
    // Not "visible but not editable": absent. Submitting is the act that
    // consents to an adult reading it.
    expect(
      decide(OTHER, 'student_project:read', project({ status: 'draft', reviewableByActor: true }))
        .effect,
    ).toBe('deny');
    expect(
      decide(
        OTHER,
        'student_project:feature',
        project({ status: 'draft', reviewableByActor: true }),
      ).effect,
    ).toBe('deny');
  });

  it('may feature, and may not update or delete', () => {
    expect(decide(OTHER, 'student_project:feature', reviewer).effect).toBe('allow');
    for (const action of ['student_project:update', 'student_project:delete'] as const) {
      expect(decide(OTHER, action, reviewer).effect, action).toBe('deny');
    }
  });

  it('has no reach without the resolved relationship', () => {
    // `reviewableByActor` is resolved in SQL from the organization AND the
    // class. A teacher of another class in the same school arrives here false.
    expect(decide(OTHER, 'student_project:feature', project()).effect).toBe('deny');
  });
});

describe('studentProjectPolicy — everybody else', () => {
  it('refuses a stranger every verb, always with hide', () => {
    for (const action of [
      'student_project:read',
      'student_project:list',
      'student_project:update',
      'student_project:delete',
      'student_project:feature',
    ] as const) {
      const decision = decide(OTHER, action, project({ visibility: 'public' }));
      expect(decision.effect, action).toBe('deny');
      expect(decision.effect === 'deny' && decision.disclosure, action).toBe('hide');
    }
  });

  it('gives a project whose class was deleted no class-based readers', () => {
    // `class_id IS NULL` after a class deletion, and the SQL helper answers
    // false for a null class. Losing the anchor fails closed.
    expect(
      decide(
        OTHER,
        'student_project:read',
        project({ classId: null, visibility: 'class', sharesClassWithActor: false }),
      ).effect,
    ).toBe('deny');
  });

  it('NEVER decides the public path — there is no branch that could', () => {
    // A stranger has no actor, so this policy is not consulted at all. A public
    // project with nobody's relationship is still refused here, which is what
    // proves the public boundary lives in RLS and the sanitizer instead.
    expect(
      decide(OTHER, 'student_project:read', project({ visibility: 'public', status: 'featured' }))
        .effect,
    ).toBe('deny');
  });
});

describe('studentPortfolioPolicy', () => {
  it.each([
    'student_portfolio:create',
    'student_portfolio:read',
    'student_portfolio:update',
    'student_portfolio:curate',
    'student_portfolio:publish',
    'student_portfolio:unpublish',
  ] as const)('allows the owner %s', (action) => {
    expect(decidePortfolio(OWNER, action, portfolio()).effect).toBe('allow');
  });

  it.each([
    'student_portfolio:read',
    'student_portfolio:update',
    'student_portfolio:curate',
    'student_portfolio:publish',
    'student_portfolio:unpublish',
  ] as const)('refuses everybody else %s, with hide', (action) => {
    const decision = decidePortfolio(OTHER, action, portfolio());
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
  });

  it('refuses publishing a portfolio with nothing public, with reveal', () => {
    const decision = decidePortfolio(
      OWNER,
      'student_portfolio:publish',
      portfolio({ publicItemCount: 0 }),
    );
    expect(decision.effect).toBe('deny');
    // `reveal`: the learner needs to be told what to fix, or they get a live
    // URL showing a name, a bio and a blank space.
    expect(decision.effect === 'deny' && decision.disclosure).toBe('reveal');
  });

  it('NEVER refuses the owner unpublishing, in any state', () => {
    // Revocation is the one operation that must not argue with a child who
    // wants their work off the internet.
    for (const publicItemCount of [0, 1, 500]) {
      for (const isPublished of [true, false]) {
        expect(
          decidePortfolio(
            OWNER,
            'student_portfolio:unpublish',
            portfolio({ publicItemCount, isPublished }),
          ).effect,
          `${publicItemCount}/${isPublished}`,
        ).toBe('allow');
      }
    }
  });

  it('has no adult branch at all', () => {
    // Not "a branch that denies" — no branch. A teacher who may read the
    // projects inside it has no reach over the arrangement, because composing
    // a presentation is not part of supervising the work.
    const decision = decidePortfolio(OTHER, 'student_portfolio:read', portfolio());
    expect(decision.reason).toBe('student_portfolio.not_owner');
  });
});
