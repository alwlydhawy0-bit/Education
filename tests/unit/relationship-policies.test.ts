import { describe, expect, it } from 'vitest';
import {
  createPolicyEngine,
  EMPTY_RELATIONSHIPS,
  isPlatformOperator,
  Role,
  type Actor,
  type AuthorizationContext,
  type RelationshipSnapshot,
} from '@edu/authz';

/**
 * Decision tables for organizations, classes, teacher assignments and guardian
 * link creation.
 *
 * Written as explicit tables so the whole management surface is readable in one
 * place. The engine is pure, so every case runs without a database.
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
  'classes:manage',
  'users:read',
  'users:list',
  'profiles:read',
  'roles:assign',
  'students:read',
];

function actor(overrides: Partial<Actor> & Pick<Actor, 'id' | 'roles'>): Actor {
  return {
    status: 'active',
    emailVerified: true,
    organizationId: ORG_A,
    grants: overrides.roles.map((role) => ({ role, scopeType: 'global' as const, scopeId: null })),
    permissions: ALL_PERMISSIONS,
    ...overrides,
  };
}

/** A platform operator holds `security_admin` at GLOBAL scope. */
const platformOperator = actor({
  id: SELF,
  roles: [Role.SECURITY_ADMIN],
  organizationId: null,
  grants: [{ role: Role.SECURITY_ADMIN, scopeType: 'global', scopeId: null }],
});

/** A school's security administrator: the same role, scoped to one school. */
const schoolSecurityAdmin = actor({
  id: SELF,
  roles: [Role.SECURITY_ADMIN],
  grants: [{ role: Role.SECURITY_ADMIN, scopeType: 'organization', scopeId: ORG_A }],
});

const ctx = (a: Actor, rel: RelationshipSnapshot = EMPTY_RELATIONSHIPS): AuthorizationContext => ({
  actor: a,
  relationships: rel,
});

const rel = (over: Partial<RelationshipSnapshot>): RelationshipSnapshot => ({
  ...EMPTY_RELATIONSHIPS,
  ...over,
});

// =========================================================================
describe('isPlatformOperator', () => {
  it('is true only for a GLOBAL security_admin grant', () => {
    expect(isPlatformOperator(platformOperator)).toBe(true);
    expect(isPlatformOperator(schoolSecurityAdmin)).toBe(false);
    expect(isPlatformOperator(actor({ id: SELF, roles: [Role.ADMIN] }))).toBe(false);
  });
});

// =========================================================================
describe('organizationPolicy', () => {
  const organization = (id = ORG_A) => ({ kind: 'organization', id }) as const;

  it('lets only a platform operator create an organization', () => {
    expect(engine.decide(ctx(platformOperator), 'organization:create', organization()).effect).toBe(
      'allow',
    );
  });

  it.each([Role.ADMIN, Role.SECURITY_ADMIN, Role.TEACHER, Role.STUDENT])(
    'refuses an organization-scoped %s creating one',
    (role) => {
      // A school's own administrator manages their school; they do not get to
      // conjure new ones.
      const scoped = actor({
        id: SELF,
        roles: [role],
        grants: [{ role, scopeType: 'organization', scopeId: ORG_A }],
      });
      expect(engine.decide(ctx(scoped), 'organization:create', organization()).effect).toBe('deny');
    },
  );

  it('lets any member read their own organization', () => {
    const student = actor({ id: SELF, roles: [Role.STUDENT] });
    expect(engine.decide(ctx(student), 'organization:read', organization(ORG_A)).effect).toBe(
      'allow',
    );
  });

  it('refuses reading another organization', () => {
    const student = actor({ id: SELF, roles: [Role.STUDENT] });
    expect(engine.decide(ctx(student), 'organization:read', organization(ORG_B)).effect).toBe(
      'deny',
    );
  });

  it('lets an admin update their own organization but not another', () => {
    const admin = actor({ id: SELF, roles: [Role.ADMIN] });
    expect(engine.decide(ctx(admin), 'organization:update', organization(ORG_A)).effect).toBe(
      'allow',
    );
    expect(engine.decide(ctx(admin), 'organization:update', organization(ORG_B)).effect).toBe(
      'deny',
    );
  });

  it('refuses a student updating even their own organization', () => {
    const student = actor({ id: SELF, roles: [Role.STUDENT] });
    expect(engine.decide(ctx(student), 'organization:update', organization(ORG_A)).effect).toBe(
      'deny',
    );
  });

  it('gives an actor with no organization nothing', () => {
    const orphan = actor({ id: SELF, roles: [Role.STUDENT], organizationId: null });
    expect(engine.decide(ctx(orphan), 'organization:read', organization(ORG_A)).effect).toBe(
      'deny',
    );
  });
});

// =========================================================================
describe('classPolicy', () => {
  const klass = (over: Record<string, unknown> = {}) =>
    ({ kind: 'class', id: CLASS_A, organizationId: ORG_A, state: 'active', ...over }) as never;

  const admin = actor({ id: SELF, roles: [Role.ADMIN] });
  const teacher = actor({ id: SELF, roles: [Role.TEACHER] });
  const student = actor({ id: SELF, roles: [Role.STUDENT] });

  it('lets an admin create a class in their own organization', () => {
    expect(engine.decide(ctx(admin), 'class:create', klass()).effect).toBe('allow');
  });

  it('refuses an admin creating one in another organization', () => {
    expect(engine.decide(ctx(admin), 'class:create', klass({ organizationId: ORG_B })).effect).toBe(
      'deny',
    );
  });

  it.each(['class:create', 'class:update', 'class:archive'] as const)(
    'refuses a TEACHER the write action %s',
    (action) => {
      // A teacher runs a class; they do not decide which classes exist. Letting
      // them would make "teacher of this class" partly self-asserted.
      expect(
        engine.decide(ctx(teacher, rel({ teachesClasses: [CLASS_A] })), action, klass()).effect,
      ).toBe('deny');
    },
  );

  it('lets a teacher of the class read it', () => {
    expect(
      engine.decide(ctx(teacher, rel({ teachesClasses: [CLASS_A] })), 'class:read', klass()).effect,
    ).toBe('allow');
  });

  it('lets an enrolled student read it', () => {
    expect(
      engine.decide(ctx(student, rel({ memberOfClasses: [CLASS_A] })), 'class:read', klass())
        .effect,
    ).toBe('allow');
  });

  it('refuses a teacher of a DIFFERENT class', () => {
    expect(
      engine.decide(ctx(teacher, rel({ teachesClasses: [CLASS_B] })), 'class:read', klass()).effect,
    ).toBe('deny');
  });

  it('refuses an unattached student', () => {
    expect(engine.decide(ctx(student), 'class:read', klass()).effect).toBe('deny');
  });

  it('treats an archived class as immutable', () => {
    const decision = engine.decide(ctx(admin), 'class:update', klass({ state: 'archived' }));
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe('class.archived_is_immutable');
  });

  it('refuses an admin without the classes:manage permission', () => {
    const permissionless = actor({ id: SELF, roles: [Role.ADMIN], permissions: [] });
    expect(engine.decide(ctx(permissionless), 'class:create', klass()).effect).toBe('deny');
  });
});

// =========================================================================
describe('teacherAssignmentPolicy', () => {
  const assignment = (over: Record<string, unknown> = {}) =>
    ({
      kind: 'teacher_assignment',
      id: 'assign-1',
      classId: CLASS_A,
      classOrganizationId: ORG_A,
      teacherId: OTHER,
      state: 'active',
      ...over,
    }) as never;

  const admin = actor({ id: SELF, roles: [Role.ADMIN] });
  const teacher = actor({ id: SELF, roles: [Role.TEACHER] });

  it('lets an admin assign a teacher in their own organization', () => {
    expect(engine.decide(ctx(admin), 'teacher_assignment:create', assignment()).effect).toBe(
      'allow',
    );
  });

  it('REFUSES a teacher assigning themselves', () => {
    // "Teacher of this class" grants access to every enrolled student's shared
    // work, so it must never be self-asserted.
    const decision = engine.decide(
      ctx(teacher, rel({ teachesClasses: [CLASS_A] })),
      'teacher_assignment:create',
      assignment({ teacherId: SELF }),
    );
    expect(decision.effect).toBe('deny');
  });

  it('refuses a teacher assigning anybody else either', () => {
    expect(engine.decide(ctx(teacher), 'teacher_assignment:create', assignment()).effect).toBe(
      'deny',
    );
  });

  it('refuses an ADMIN assigning themselves', () => {
    // The same no-self-modification rule that governs role grants.
    const decision = engine.decide(
      ctx(admin),
      'teacher_assignment:create',
      assignment({ teacherId: SELF }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'teacher_assignment.self_assignment_forbidden',
    );
  });

  it('refuses an admin assigning into another organization', () => {
    expect(
      engine.decide(
        ctx(admin),
        'teacher_assignment:create',
        assignment({ classOrganizationId: ORG_B }),
      ).effect,
    ).toBe('deny');
  });

  it('lets a teacher read their own assignment', () => {
    expect(
      engine.decide(ctx(teacher), 'teacher_assignment:read', assignment({ teacherId: SELF }))
        .effect,
    ).toBe('allow');
  });

  it('lets co-teachers see each other on a shared class', () => {
    expect(
      engine.decide(
        ctx(teacher, rel({ teachesClasses: [CLASS_A] })),
        'teacher_assignment:read',
        assignment(),
      ).effect,
    ).toBe('allow');
  });

  it('refuses removing an already-ended assignment', () => {
    expect(
      engine.decide(ctx(admin), 'teacher_assignment:remove', assignment({ state: 'ended' })).effect,
    ).toBe('deny');
  });
});

// =========================================================================
describe('guardianRelationshipPolicy — creating a claim', () => {
  const claim = (over: Record<string, unknown> = {}) =>
    ({
      kind: 'guardian_relationship',
      id: 'claim-1',
      guardianId: SELF,
      childId: CHILD,
      childOrganizationId: ORG_A,
      state: 'pending',
      ...over,
    }) as never;

  const guardian = actor({ id: SELF, roles: [Role.GUARDIAN] });
  const admin = actor({ id: OTHER, roles: [Role.ADMIN] });

  it('lets a guardian claim a link about themselves, pending', () => {
    expect(engine.decide(ctx(guardian), 'guardian_relationship:create', claim()).effect).toBe(
      'allow',
    );
  });

  it('refuses a claim that arrives already verified', () => {
    const decision = engine.decide(
      ctx(guardian),
      'guardian_relationship:create',
      claim({ state: 'verified' }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe(
      'guardian_relationship.must_start_pending',
    );
  });

  it('refuses a guardian creating a claim naming SOMEBODY ELSE as guardian', () => {
    // Otherwise an actor could manufacture a link between two accounts they do
    // not control.
    const decision = engine.decide(
      ctx(guardian),
      'guardian_relationship:create',
      claim({ guardianId: OTHER }),
    );
    expect(decision.effect).toBe('deny');
  });

  it('refuses a child creating a claim about their own guardian', () => {
    const child = actor({ id: CHILD, roles: [Role.STUDENT] });
    expect(engine.decide(ctx(child), 'guardian_relationship:create', claim()).effect).toBe('deny');
  });

  it('refuses a student with no guardian role', () => {
    const student = actor({ id: SELF, roles: [Role.STUDENT] });
    expect(engine.decide(ctx(student), 'guardian_relationship:create', claim()).effect).toBe(
      'deny',
    );
  });

  it('lets an administrator of the CHILD’S school create one on a family behalf', () => {
    expect(engine.decide(ctx(admin), 'guardian_relationship:create', claim()).effect).toBe('allow');
  });

  it('refuses an administrator of another school, and one whose child has no school', () => {
    const foreignAdmin = actor({ id: OTHER, roles: [Role.ADMIN], organizationId: ORG_B });
    expect(engine.decide(ctx(foreignAdmin), 'guardian_relationship:create', claim()).effect).toBe(
      'deny',
    );
    expect(
      engine.decide(
        ctx(admin),
        'guardian_relationship:create',
        claim({
          childOrganizationId: null,
        }),
      ).effect,
    ).toBe('deny');
  });
});
