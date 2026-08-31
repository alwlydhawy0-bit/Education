import { describe, expect, it } from 'vitest';
import {
  createPolicyEngine,
  EMPTY_RELATIONSHIPS,
  NOTE_ACTIONS,
  Role,
  type Actor,
  type AuthorizationContext,
  type NoteAction,
  type NoteResource,
  type RelationshipSnapshot,
} from '@edu/authz';

/**
 * The notebook authorization decision table.
 *
 * This file is the specification of who can reach a student's notes. It is
 * written as an explicit table rather than as scattered assertions so that a
 * reviewer can read the whole access surface in one screen, and so that adding
 * a role or a visibility value forces a visible change here.
 *
 * The engine is pure, so every case below is exercised with no database.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const STUDENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_STUDENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TEACHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GUARDIAN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ADMIN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NOTE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const engine = createPolicyEngine();

function actor(overrides: Partial<Actor> & Pick<Actor, 'id' | 'roles'>): Actor {
  const roles = overrides.roles;
  return {
    status: 'active',
    organizationId: ORG_A,
    emailVerified: true,
    // Default the scoped grants to the global equivalent of the role list, so a
    // test that only cares about roles does not have to restate them.
    grants: roles.map((role) => ({ role, scopeType: 'global' as const, scopeId: null })),
    // The notebook policy does not consult permissions, but the Actor type
    // requires them; a permissive default keeps these cases about the policy.
    permissions: ['notes:read', 'notes:create', 'notes:update', 'notes:delete', 'students:read'],
    ...overrides,
  };
}

function ctx(
  a: Actor,
  relationships: RelationshipSnapshot = EMPTY_RELATIONSHIPS,
): AuthorizationContext {
  return { actor: a, relationships };
}

function note(overrides: Partial<NoteResource> = {}): NoteResource {
  return {
    kind: 'note',
    id: NOTE_ID,
    ownerId: STUDENT,
    organizationId: ORG_A,
    visibility: 'private',
    state: 'active',
    ...overrides,
  };
}

const studentOwner = actor({ id: STUDENT, roles: [Role.STUDENT] });
const strangerStudent = actor({ id: OTHER_STUDENT, roles: [Role.STUDENT] });
const assignedTeacher = actor({ id: TEACHER, roles: [Role.TEACHER] });
const verifiedGuardian = actor({ id: GUARDIAN, roles: [Role.GUARDIAN] });
const administrator = actor({ id: ADMIN, roles: [Role.ADMIN] });

const teacherOfStudent: RelationshipSnapshot = {
  guardianOf: [],
  teacherOf: [STUDENT],
  teachesClasses: [],
  memberOfClasses: [],
  coursesViaClasses: [],
};
const guardianOfStudent: RelationshipSnapshot = {
  guardianOf: [STUDENT],
  teacherOf: [],
  teachesClasses: [],
  memberOfClasses: [],
  coursesViaClasses: [],
};

describe('notePolicy — owner', () => {
  it.each(NOTE_ACTIONS)('allows the owner to %s their own active note', (action) => {
    const decision = engine.decide(ctx(studentOwner), action, note());
    expect(decision.effect).toBe('allow');
  });

  it('allows the owner to read an archived note', () => {
    expect(engine.decide(ctx(studentOwner), 'note:read', note({ state: 'archived' })).effect).toBe(
      'allow',
    );
  });

  it('refuses to let the owner edit an archived note, and says so plainly', () => {
    const decision = engine.decide(ctx(studentOwner), 'note:update', note({ state: 'archived' }));
    expect(decision.effect).toBe('deny');
    // The owner already knows this note exists, so hiding it would be confusing
    // rather than protective — 403, not 404.
    expect(decision.effect === 'deny' && decision.disclosure).toBe('reveal');
  });

  it('treats a soft-deleted note as non-existent, even for its owner', () => {
    const decision = engine.decide(ctx(studentOwner), 'note:read', note({ state: 'deleted' }));
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
  });
});

describe('notePolicy — horizontal privilege escalation (student to student)', () => {
  it.each(NOTE_ACTIONS)('denies an unrelated student attempting to %s', (action) => {
    const decision = engine.decide(ctx(strangerStudent), action, note());
    expect(decision.effect).toBe('deny');
  });

  it('hides existence from an unrelated student, so ids cannot be probed', () => {
    const decision = engine.decide(ctx(strangerStudent), 'note:read', note());
    expect(decision.effect === 'deny' && decision.disclosure).toBe('hide');
  });

  it('denies a stranger even when the note is shared with teachers', () => {
    const decision = engine.decide(
      ctx(strangerStudent),
      'note:read',
      note({ visibility: 'shared_with_teacher' }),
    );
    expect(decision.effect).toBe('deny');
  });
});

describe('notePolicy — teacher', () => {
  it('allows an assigned teacher to read a note shared with teachers', () => {
    const decision = engine.decide(
      ctx(assignedTeacher, teacherOfStudent),
      'note:read',
      note({ visibility: 'shared_with_teacher' }),
    );
    expect(decision.effect).toBe('allow');
  });

  it('denies an assigned teacher when the note is still private', () => {
    // Sharing is the STUDENT's decision. An assignment alone is not consent.
    const decision = engine.decide(
      ctx(assignedTeacher, teacherOfStudent),
      'note:read',
      note({ visibility: 'private' }),
    );
    expect(decision.effect).toBe('deny');
  });

  it('denies a teacher who is NOT assigned to this student', () => {
    // The share is real, but the relationship is not.
    const decision = engine.decide(
      ctx(assignedTeacher, EMPTY_RELATIONSHIPS),
      'note:read',
      note({ visibility: 'shared_with_teacher' }),
    );
    expect(decision.effect).toBe('deny');
  });

  it('denies an assigned teacher from a different organization', () => {
    // Guards against a stale assignment surviving a school transfer.
    const foreignTeacher = actor({ id: TEACHER, roles: [Role.TEACHER], organizationId: ORG_B });
    const decision = engine.decide(
      ctx(foreignTeacher, teacherOfStudent),
      'note:read',
      note({ visibility: 'shared_with_teacher', organizationId: ORG_A }),
    );
    expect(decision.effect).toBe('deny');
  });

  it.each(['note:update', 'note:delete', 'note:share'] as const)(
    'denies an assigned teacher attempting to %s a shared note',
    (action: NoteAction) => {
      const decision = engine.decide(
        ctx(assignedTeacher, teacherOfStudent),
        action,
        note({ visibility: 'shared_with_teacher' }),
      );
      expect(decision.effect).toBe('deny');
    },
  );
});

describe('notePolicy — guardian', () => {
  it('allows a verified guardian to read a note shared with guardians', () => {
    const decision = engine.decide(
      ctx(verifiedGuardian, guardianOfStudent),
      'note:read',
      note({ visibility: 'shared_with_guardian' }),
    );
    expect(decision.effect).toBe('allow');
  });

  it('denies a guardian reading a note shared only with teachers', () => {
    const decision = engine.decide(
      ctx(verifiedGuardian, guardianOfStudent),
      'note:read',
      note({ visibility: 'shared_with_teacher' }),
    );
    expect(decision.effect).toBe('deny');
  });

  it('denies an unlinked guardian', () => {
    const decision = engine.decide(
      ctx(verifiedGuardian, EMPTY_RELATIONSHIPS),
      'note:read',
      note({ visibility: 'shared_with_guardian' }),
    );
    expect(decision.effect).toBe('deny');
  });

  it('allows a guardian across organizations — guardianship is a family tie', () => {
    const outOfOrgGuardian = actor({
      id: GUARDIAN,
      roles: [Role.GUARDIAN],
      organizationId: null,
    });
    const decision = engine.decide(
      ctx(outOfOrgGuardian, guardianOfStudent),
      'note:read',
      note({ visibility: 'shared_with_guardian' }),
    );
    expect(decision.effect).toBe('allow');
  });
});

describe('notePolicy — vertical privilege escalation (privileged roles)', () => {
  it.each([Role.ADMIN, Role.SECURITY_ADMIN, Role.MODERATOR, Role.REVIEWER, Role.CONTENT_AUTHOR])(
    'denies %s read access to a private student note',
    (role) => {
      const privileged = actor({ id: ADMIN, roles: [role] });
      const decision = engine.decide(ctx(privileged), 'note:read', note());
      expect(decision.effect).toBe('deny');
    },
  );

  it('denies an administrator even for a note shared with teachers', () => {
    // Deliberate: an admin is not a teacher of this student. Break-glass access
    // is a future, audited capability that does not exist yet.
    const decision = engine.decide(
      ctx(administrator),
      'note:read',
      note({ visibility: 'shared_with_teacher' }),
    );
    expect(decision.effect).toBe('deny');
  });

  it('denies an actor holding every role at once', () => {
    const superRole = actor({ id: ADMIN, roles: Object.values(Role) });
    expect(engine.decide(ctx(superRole), 'note:read', note()).effect).toBe('deny');
  });
});

describe('policy engine — global pre-checks', () => {
  it('denies a suspended actor access to their OWN note', () => {
    const suspended = actor({ id: STUDENT, roles: [Role.STUDENT], status: 'suspended' });
    const decision = engine.decide(ctx(suspended), 'note:read', note());
    expect(decision.effect).toBe('deny');
    expect(decision.effect === 'deny' && decision.reason).toBe('actor.suspended');
  });

  it('denies an unverified actor access to their own note', () => {
    const pending = actor({ id: STUDENT, roles: [Role.STUDENT], status: 'pending_verification' });
    expect(engine.decide(ctx(pending), 'note:read', note()).effect).toBe('deny');
  });

  it('denies an actor with no roles at all', () => {
    const roleless = actor({ id: STUDENT, roles: [] });
    expect(engine.decide(ctx(roleless), 'note:read', note()).effect).toBe('deny');
  });

  it('a pre-check can only remove access, never grant it', () => {
    // A suspended stranger is denied for the suspension reason, not silently
    // allowed by some later rule.
    const suspendedStranger = actor({
      id: OTHER_STUDENT,
      roles: [Role.STUDENT],
      status: 'suspended',
    });
    expect(engine.decide(ctx(suspendedStranger), 'note:read', note()).effect).toBe('deny');
  });
});

describe('policy engine — decisions are bound to their subject', () => {
  it('reports the resource id and action it decided about', () => {
    const decision = engine.decide(ctx(studentOwner), 'note:read', note());
    expect(decision.resourceId).toBe(NOTE_ID);
    expect(decision.action).toBe('note:read');
  });

  it('throws when an action is evaluated against the wrong resource kind', () => {
    expect(() => engine.decide(ctx(studentOwner), 'user:read', note() as never)).toThrowError(
      /targets resource kind "user"/,
    );
  });
});
