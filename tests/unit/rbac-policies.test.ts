import { describe, expect, it } from 'vitest';
import {
  createPolicyEngine,
  EMPTY_RELATIONSHIPS,
  hasPermission,
  hasRole,
  hasRoleInScope,
  Role,
  type Actor,
  type AuthorizationContext,
  type RelationshipSnapshot,
  type RoleGrant,
} from '@edu/authz';

/**
 * Decision tables for the identity-domain policies.
 *
 * Written as explicit tables so a reviewer can read the whole access surface in
 * one place, and so adding a role or a scope forces a visible change here.
 * The engine is pure, so every case runs without a database.
 */
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const CLASS_A = '33333333-3333-4333-8333-333333333333';
const CLASS_B = '44444444-4444-4444-8444-444444444444';

const SELF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHILD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const engine = createPolicyEngine();

const ALL_PERMISSIONS = [
  'notes:read',
  'profiles:read',
  'profiles:update',
  'users:read',
  'users:update',
  'users:list',
  'users:suspend',
  'roles:assign',
  'classes:manage',
  'students:read',
];

function actor(overrides: Partial<Actor> & Pick<Actor, 'id' | 'roles'>): Actor {
  return {
    status: 'active',
    emailVerified: true,
    organizationId: ORG_A,
    grants: overrides.roles.map((role) => ({
      role,
      scopeType: 'global' as const,
      scopeId: null,
    })),
    permissions: ALL_PERMISSIONS,
    ...overrides,
  };
}

const ctx = (a: Actor, rel: RelationshipSnapshot = EMPTY_RELATIONSHIPS): AuthorizationContext => ({
  actor: a,
  relationships: rel,
});

const rel = (over: Partial<RelationshipSnapshot>): RelationshipSnapshot => ({
  ...EMPTY_RELATIONSHIPS,
  ...over,
});

// =========================================================================
describe('scope helpers', () => {
  const teacherOfClassA: RoleGrant = {
    role: Role.TEACHER,
    scopeType: 'class',
    scopeId: CLASS_A,
  };
  const scoped = actor({ id: SELF, roles: [Role.TEACHER], grants: [teacherOfClassA] });

  it('reports the role as held, scope-blind', () => {
    expect(hasRole(scoped, Role.TEACHER)).toBe(true);
  });

  it('matches the scope it was granted in', () => {
    expect(hasRoleInScope(scoped, Role.TEACHER, 'class', CLASS_A)).toBe(true);
  });

  it('does NOT match a different scope of the same type', () => {
    expect(hasRoleInScope(scoped, Role.TEACHER, 'class', CLASS_B)).toBe(false);
  });

  it('does not let an organization-scoped grant cover a class', () => {
    // Deliberate: class containment is a relationship question, and answering it
    // from an id alone would mean guessing at data this package cannot see.
    const orgScoped = actor({
      id: SELF,
      roles: [Role.TEACHER],
      grants: [{ role: Role.TEACHER, scopeType: 'organization', scopeId: ORG_A }],
    });
    expect(hasRoleInScope(orgScoped, Role.TEACHER, 'class', CLASS_A)).toBe(false);
  });

  it('lets a global grant cover every scope', () => {
    const global = actor({ id: SELF, roles: [Role.TEACHER] });
    expect(hasRoleInScope(global, Role.TEACHER, 'class', CLASS_A)).toBe(true);
    expect(hasRoleInScope(global, Role.TEACHER, 'organization', ORG_B)).toBe(true);
  });

  it('reports permissions independently of roles', () => {
    expect(hasPermission(scoped, 'notes:read')).toBe(true);
    expect(hasPermission(scoped, 'nonexistent:action')).toBe(false);
  });
});

// =========================================================================
describe('profilePolicy', () => {
  const profile = (userId: string, organizationId: string | null = ORG_A) =>
    ({ kind: 'profile', id: userId, userId, organizationId }) as const;

  it('lets a user read and update their own profile', () => {
    const me = actor({ id: SELF, roles: [Role.STUDENT] });
    expect(engine.decide(ctx(me), 'profile:read', profile(SELF)).effect).toBe('allow');
    expect(engine.decide(ctx(me), 'profile:update', profile(SELF)).effect).toBe('allow');
  });

  it.each([Role.TEACHER, Role.ADMIN, Role.SECURITY_ADMIN, Role.MODERATOR])(
    'refuses %s any update of another person profile',
    (role) => {
      // A profile is self-description. Removing inappropriate content is a
      // moderation action against the account, which is a different capability.
      const other = actor({ id: SELF, roles: [role] });
      const decision = engine.decide(
        ctx(other, rel({ teacherOf: [OTHER] })),
        'profile:update',
        profile(OTHER),
      );
      expect(decision.effect).toBe('deny');
    },
  );

  it('lets a teacher read the profile of a student they teach', () => {
    const teacher = actor({ id: SELF, roles: [Role.TEACHER] });
    const decision = engine.decide(
      ctx(teacher, rel({ teacherOf: [OTHER] })),
      'profile:read',
      profile(OTHER),
    );
    expect(decision.effect).toBe('allow');
  });

  it('refuses a teacher with no relationship to that student', () => {
    const teacher = actor({ id: SELF, roles: [Role.TEACHER] });
    expect(engine.decide(ctx(teacher), 'profile:read', profile(OTHER)).effect).toBe('deny');
  });

  it('refuses a teacher whose student is in another organization', () => {
    const teacher = actor({ id: SELF, roles: [Role.TEACHER], organizationId: ORG_B });
    const decision = engine.decide(
      ctx(teacher, rel({ teacherOf: [OTHER] })),
      'profile:read',
      profile(OTHER, ORG_A),
    );
    expect(decision.effect).toBe('deny');
  });

  it('refuses a read when the role carries no profiles:read permission', () => {
    const teacher = actor({ id: SELF, roles: [Role.TEACHER], permissions: [] });
    const decision = engine.decide(
      ctx(teacher, rel({ teacherOf: [OTHER] })),
      'profile:read',
      profile(OTHER),
    );
    expect(decision.effect).toBe('deny');
  });
});

// =========================================================================
describe('roleGrantPolicy — privilege containment', () => {
  const grant = (over: Partial<Parameters<typeof engine.decide>[2]> = {}) =>
    ({
      kind: 'role_grant',
      id: 'grant-1',
      targetUserId: OTHER,
      targetUserOrganizationId: ORG_A,
      role: Role.TEACHER,
      scopeType: 'organization',
      scopeId: ORG_A,
      ...over,
    }) as never;

  const admin = actor({ id: SELF, roles: [Role.ADMIN] });
  const securityAdmin = actor({ id: SELF, roles: [Role.SECURITY_ADMIN] });

  it('lets an admin grant an ordinary role inside their own organization', () => {
    expect(engine.decide(ctx(admin), 'role_grant:assign', grant()).effect).toBe('allow');
  });

  it('REFUSES anyone granting a role to themselves', () => {
    // Self-grant is the shortest path from a compromised admin account to
    // permanent full control, and has no legitimate use.
    for (const who of [admin, securityAdmin]) {
      const decision = engine.decide(ctx(who), 'role_grant:assign', grant({ targetUserId: SELF }));
      expect(decision.effect).toBe('deny');
      expect(decision.effect === 'deny' && decision.reason).toBe(
        'role_grant.self_modification_forbidden',
      );
    }
  });

  it.each([Role.ADMIN, Role.SECURITY_ADMIN])(
    'refuses an ordinary admin granting the privileged role %s',
    (role) => {
      // An admin cannot mint peers or superiors, so compromising one does not
      // compound into control of the organization.
      const decision = engine.decide(ctx(admin), 'role_grant:assign', grant({ role }));
      expect(decision.effect).toBe('deny');
    },
  );

  it('lets a security administrator grant a privileged role in their organization', () => {
    const decision = engine.decide(
      ctx(securityAdmin),
      'role_grant:assign',
      grant({ role: Role.ADMIN }),
    );
    expect(decision.effect).toBe('allow');
  });

  it('refuses a privileged role granted GLOBALLY, even by a security admin', () => {
    // A global admin grant would reach every school on the platform.
    const decision = engine.decide(
      ctx(securityAdmin),
      'role_grant:assign',
      grant({ role: Role.ADMIN, scopeType: 'global', scopeId: null }),
    );
    expect(decision.effect).toBe('deny');
  });

  it('refuses a grant to a user in another organization', () => {
    const decision = engine.decide(
      ctx(admin),
      'role_grant:assign',
      grant({ targetUserOrganizationId: ORG_B }),
    );
    expect(decision.effect).toBe('deny');
  });

  it('refuses an organization-scoped grant naming a different organization', () => {
    const decision = engine.decide(
      ctx(admin),
      'role_grant:assign',
      grant({ scopeType: 'organization', scopeId: ORG_B }),
    );
    expect(decision.effect).toBe('deny');
  });

  it('refuses a scoped grant with no scope id', () => {
    const decision = engine.decide(
      ctx(admin),
      'role_grant:assign',
      grant({ scopeType: 'class', scopeId: null }),
    );
    expect(decision.effect).toBe('deny');
  });

  it.each([Role.STUDENT, Role.TEACHER, Role.GUARDIAN, Role.MODERATOR, Role.REVIEWER])(
    'refuses %s any role assignment at all',
    (role) => {
      const ordinary = actor({ id: SELF, roles: [role] });
      expect(engine.decide(ctx(ordinary), 'role_grant:assign', grant()).effect).toBe('deny');
    },
  );

  it('refuses an actor whose roles carry no roles:assign permission', () => {
    const permissionless = actor({ id: SELF, roles: [Role.ADMIN], permissions: [] });
    expect(engine.decide(ctx(permissionless), 'role_grant:assign', grant()).effect).toBe('deny');
  });

  it('applies the same containment to revocation', () => {
    expect(
      engine.decide(ctx(admin), 'role_grant:revoke', grant({ targetUserId: SELF })).effect,
    ).toBe('deny');
    expect(
      engine.decide(ctx(admin), 'role_grant:revoke', grant({ role: Role.SECURITY_ADMIN })).effect,
    ).toBe('deny');
  });
});

// =========================================================================
describe('guardianRelationshipPolicy', () => {
  const relationship = (over: Record<string, unknown> = {}) =>
    ({
      kind: 'guardian_relationship',
      id: 'rel-1',
      guardianId: SELF,
      childId: CHILD,
      state: 'pending',
      ...over,
    }) as never;

  const guardian = actor({ id: SELF, roles: [Role.GUARDIAN] });
  const child = actor({ id: CHILD, roles: [Role.STUDENT] });
  const admin = actor({ id: OTHER, roles: [Role.ADMIN] });

  it('lets either participant read the relationship', () => {
    expect(engine.decide(ctx(guardian), 'guardian_relationship:read', relationship()).effect).toBe(
      'allow',
    );
    expect(engine.decide(ctx(child), 'guardian_relationship:read', relationship()).effect).toBe(
      'allow',
    );
  });

  it('REFUSES a guardian verifying their own claim', () => {
    // This is the whole attack on this table: claim guardianship of any student
    // and confirm it yourself.
    const decision = engine.decide(ctx(guardian), 'guardian_relationship:verify', relationship());
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'guardian_relationship.self_verification_forbidden',
    );
  });

  it('refuses the child verifying it either', () => {
    expect(engine.decide(ctx(child), 'guardian_relationship:verify', relationship()).effect).toBe(
      'deny',
    );
  });

  it('lets an uninvolved administrator verify a pending claim', () => {
    expect(engine.decide(ctx(admin), 'guardian_relationship:verify', relationship()).effect).toBe(
      'allow',
    );
  });

  it('refuses verifying anything that is not pending', () => {
    for (const state of ['verified', 'revoked']) {
      expect(
        engine.decide(ctx(admin), 'guardian_relationship:verify', relationship({ state })).effect,
      ).toBe('deny');
    }
  });

  it('lets the CHILD revoke the relationship without anyone approval', () => {
    // Revocation only ever removes access, so a student must always be able to
    // cut off an adult without asking permission.
    const decision = engine.decide(
      ctx(child),
      'guardian_relationship:revoke',
      relationship({ state: 'verified' }),
    );
    expect(decision.effect).toBe('allow');
  });

  it('refuses an unrelated actor reading or revoking', () => {
    const stranger = actor({ id: OTHER, roles: [Role.STUDENT] });
    expect(engine.decide(ctx(stranger), 'guardian_relationship:read', relationship()).effect).toBe(
      'deny',
    );
    expect(
      engine.decide(ctx(stranger), 'guardian_relationship:revoke', relationship()).effect,
    ).toBe('deny');
  });
});

// =========================================================================
describe('classMembershipPolicy', () => {
  const membership = (over: Record<string, unknown> = {}) =>
    ({
      kind: 'class_membership',
      id: 'mem-1',
      classId: CLASS_A,
      classOrganizationId: ORG_A,
      memberUserId: OTHER,
      state: 'active',
      ...over,
    }) as never;

  it('lets a teacher of that class manage its roster', () => {
    const teacher = actor({ id: SELF, roles: [Role.TEACHER] });
    const decision = engine.decide(
      ctx(teacher, rel({ teachesClasses: [CLASS_A] })),
      'class_membership:manage',
      membership(),
    );
    expect(decision.effect).toBe('allow');
  });

  it('refuses a teacher of a DIFFERENT class', () => {
    const teacher = actor({ id: SELF, roles: [Role.TEACHER] });
    const decision = engine.decide(
      ctx(teacher, rel({ teachesClasses: [CLASS_B] })),
      'class_membership:manage',
      membership(),
    );
    expect(decision.effect).toBe('deny');
  });

  it('refuses an admin from another organization', () => {
    const admin = actor({ id: SELF, roles: [Role.ADMIN], organizationId: ORG_B });
    expect(engine.decide(ctx(admin), 'class_membership:manage', membership()).effect).toBe('deny');
  });

  it('lets the member read their own membership', () => {
    const member = actor({ id: OTHER, roles: [Role.STUDENT] });
    expect(engine.decide(ctx(member), 'class_membership:read', membership()).effect).toBe('allow');
  });

  it('treats an ended membership as immutable history', () => {
    const teacher = actor({ id: SELF, roles: [Role.TEACHER] });
    const decision = engine.decide(
      ctx(teacher, rel({ teachesClasses: [CLASS_A] })),
      'class_membership:manage',
      membership({ state: 'ended' }),
    );
    expect(decision.effect).toBe('deny');
  });
});

// =========================================================================
describe('global pre-checks still apply to every new policy', () => {
  it.each([
    ['profile:read', { kind: 'profile', id: SELF, userId: SELF, organizationId: ORG_A }],
    [
      'class_membership:read',
      {
        kind: 'class_membership',
        id: 'm',
        classId: CLASS_A,
        classOrganizationId: ORG_A,
        memberUserId: SELF,
        state: 'active',
      },
    ],
  ])('denies a suspended actor %s on their own resource', (action, resource) => {
    const suspended = actor({ id: SELF, roles: [Role.STUDENT], status: 'suspended' });
    const decision = engine.decide(ctx(suspended), action as never, resource as never);
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe('actor.suspended');
  });
});
