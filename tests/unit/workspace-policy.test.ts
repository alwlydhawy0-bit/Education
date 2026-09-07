import { describe, expect, it } from 'vitest';
import {
  ALL_ACTIONS,
  createPolicyEngine,
  EMPTY_RELATIONSHIPS,
  NOTEBOOK_ACTIONS,
  Role,
  STUDENT_ARTIFACT_ACTIONS,
  type Actor,
  type AuthorizationContext,
  type NotebookResource,
  type StudentArtifactResource,
} from '@edu/authz';
import {
  ALLOWED_CONTENT_TYPES,
  ARTIFACT_MAX_BYTES,
  createNoteRequestSchema,
  registerArtifactRequestSchema,
  updateNoteRequestSchema,
} from '@edu/contracts';
import { checkMarkdown } from '../../apps/api/src/platform/security/markdown-safety.ts';

/**
 * The student workspace: its decision tables, its markdown gate, and the parts
 * of its contract that are security controls rather than shape checks.
 *
 * The decision tables here are the shortest in the suite, and that is the
 * property being asserted. Every other policy on this platform has a
 * relationship graph to walk; these have one question. A test file that grew a
 * branch would be the signal that somebody had added a share nobody argued for.
 *
 * The RLS half of the same rules is in `tests/integration/rls-workspace.test.ts`
 * with no application code in the path; the HTTP half is in
 * `tests/security/workspace.test.ts`. None of the three is sufficient alone.
 */
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOTEBOOK = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ARTIFACT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const LESSON = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const COURSE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

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

const owner = actor({ id: OWNER, roles: [Role.STUDENT] });
const peer = actor({ id: OTHER, roles: [Role.STUDENT] });
const teacher = actor({ id: OTHER, roles: [Role.TEACHER] });
const guardian = actor({ id: OTHER, roles: [Role.GUARDIAN] });
const admin = actor({ id: OTHER, roles: [Role.ADMIN] });
const foreignAdmin = actor({ id: OTHER, roles: [Role.ADMIN], organizationId: ORG_B });
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

const notebook = (overrides: Partial<NotebookResource> = {}): NotebookResource => ({
  kind: 'notebook',
  id: NOTEBOOK,
  ownerId: OWNER,
  organizationId: ORG_A,
  ...overrides,
});

const artifact = (overrides: Partial<StudentArtifactResource> = {}): StudentArtifactResource => ({
  kind: 'student_artifact',
  id: ARTIFACT,
  ownerId: OWNER,
  organizationId: ORG_A,
  artifactType: 'image',
  byteSize: 1024,
  ...overrides,
});

/** Everyone who is not the owner. The whole point is that this list is uniform. */
const STRANGERS: ReadonlyArray<readonly [string, Actor, Partial<typeof EMPTY_RELATIONSHIPS>]> = [
  ['a peer', peer, {}],
  ['the teacher of their class', teacher, { teacherOf: [OWNER] }],
  ['a verified guardian', guardian, { guardianOf: [OWNER] }],
  ['an administrator of their school', admin, {}],
  ['an administrator of another school', foreignAdmin, {}],
  ['a platform operator', operator, {}],
  ['a content author', author, {}],
];

describe('the notebook decision table', () => {
  it.each(NOTEBOOK_ACTIONS)('allows the owner: %s', (action) => {
    const d = engine.decide(ctx(owner), action, notebook());
    expect(d.effect).toBe('allow');
    expect(d.reason).toBe('notebook.owner');
  });

  for (const [label, who, rel] of STRANGERS) {
    it.each(NOTEBOOK_ACTIONS)(`refuses ${label}: %s`, (action) => {
      const d = engine.decide(ctx(who, rel), action, notebook());
      expect(d.effect).toBe('deny');
      // `hide`, always. A 403 would confirm the id names a real notebook, which
      // is the one bit an attacker enumerating ids is trying to buy.
      expect(d.effect === 'deny' && d.disclosure).toBe('hide');
    });
  }

  it('does not soften for a notebook in the actor’s own organization', () => {
    // Same school, same everything but the owner. There is no organization
    // branch in this policy and this asserts its absence.
    const d = engine.decide(ctx(admin), 'notebook:read', notebook({ organizationId: ORG_A }));
    expect(d.effect).toBe('deny');
  });
});

describe('the artifact decision table', () => {
  it.each(STUDENT_ARTIFACT_ACTIONS)('allows the owner: %s', (action) => {
    expect(engine.decide(ctx(owner), action, artifact()).effect).toBe('allow');
  });

  for (const [label, who, rel] of STRANGERS) {
    it.each(STUDENT_ARTIFACT_ACTIONS)(`refuses ${label}: %s`, (action) => {
      const d = engine.decide(ctx(who, rel), action, artifact());
      expect(d.effect).toBe('deny');
      expect(d.effect === 'deny' && d.disclosure).toBe('hide');
    });
  }

  it('refuses a guardian even though a guardian may read a SHARED note', () => {
    // The asymmetry that is easiest to mistake for a bug. Sharing a note is a
    // decision about that note's text; a file does not ride along on it.
    const d = engine.decide(ctx(guardian, { guardianOf: [OWNER] }), 'student_artifact:read', artifact());
    expect(d.effect).toBe('deny');
  });
});

describe('the vocabulary itself', () => {
  it('registers every workspace action in ALL_ACTIONS', () => {
    for (const action of [...NOTEBOOK_ACTIONS, ...STUDENT_ARTIFACT_ACTIONS]) {
      expect(ALL_ACTIONS).toContain(action);
    }
  });

  it('has no word for sharing a notebook', () => {
    // `note:share` exists because a note can be shared. Adding the verb here
    // would advertise a capability no branch implements.
    expect(NOTEBOOK_ACTIONS.some((a) => a.endsWith(':share'))).toBe(false);
  });

  it('has no word for updating or downloading an artifact', () => {
    // No UPDATE: `edu_app` holds no UPDATE grant, because a mutable row would
    // make the quota a suggestion. No download: nothing scans these bytes.
    expect(STUDENT_ARTIFACT_ACTIONS.some((a) => a.endsWith(':update'))).toBe(false);
    expect(STUDENT_ARTIFACT_ACTIONS.some((a) => a.endsWith(':download'))).toBe(false);
  });

  it('refuses an action evaluated against the wrong kind of resource', () => {
    expect(() => engine.decide(ctx(owner), 'notebook:read', artifact())).toThrow(
      /targets resource kind/,
    );
  });

  it('carries no storage key on the artifact resource', () => {
    // The policy decides who may act on the row. It has no business knowing
    // where the bytes would live, and a policy that carried the key would be
    // one leak away from disclosing the storage layout.
    expect(Object.keys(artifact())).not.toContain('storageKey');
  });
});

describe('the markdown gate refuses executable link schemes', () => {
  const REFUSED = [
    ['an inline link', '[click](javascript:alert(1))'],
    ['an image', '![img](javascript:alert(1))'],
    ['a mixed-case scheme', '[x](JaVaScRiPt:alert(1))'],
    ['an angle-bracketed destination', '[a](<javascript:alert(1)>)'],
    ['a bare autolink', 'see <javascript:alert(1)>'],
    ['a reference definition', '[ref]: javascript:alert(1)\n\n[use][ref]'],
    ['a tab inside the scheme', '[x](java\tscript:alert(1))'],
    ['a newline inside the scheme', '[x](java\nscript:alert(1))'],
    ['a data: document', '[x](data:text/html;base64,PHN2Zz4=)'],
    ['vbscript', '[x](vbscript:msgbox)'],
  ] as const;

  it.each(REFUSED)('refuses %s', (_label, body) => {
    expect(checkMarkdown(body)).not.toBeNull();
  });

  it('names the scheme it found, so the error can say which', () => {
    expect(checkMarkdown('[x](vbscript:msgbox)')?.scheme).toBe('vbscript');
    expect(checkMarkdown('[x](data:text/html,x)')?.scheme).toBe('data');
  });
});

describe('the markdown gate leaves schoolwork alone', () => {
  const ACCEPTED = [
    ['plain prose', 'Ohm’s law is V = IR.'],
    ['an ordinary link', '[the lesson](https://school.example/lessons/1)'],
    ['a relative link', '[next](/lessons/2)'],
    ['a mailto link', '[email](mailto:teacher@school.example)'],
    ['prose ABOUT the scheme', 'A javascript: URL in an href is how XSS happens.'],
    ['a fenced code block', '```js\nconst u = "javascript:alert(1)";\n```'],
    ['inline code', 'Never write `javascript:alert(1)` into an href.'],
    ['an empty body', ''],
    ['unicode and emoji', 'الدرس الأول — 物理 ⚡'],
  ] as const;

  it.each(ACCEPTED)('accepts %s', (_label, body) => {
    expect(checkMarkdown(body)).toBeNull();
  });

  it('is why the gate rejects rather than strips', () => {
    // A stripping sanitizer would have to decide what to do with the code
    // block above. Every answer it could give silently edits a child's
    // homework; refusing only what is actually dangerous never has to.
    const homework = '```js\nlocation.href = "javascript:alert(1)";\n```';
    expect(checkMarkdown(homework)).toBeNull();
  });
});

describe('the note contract bounds where a note may hang', () => {
  it('accepts at most one anchor', () => {
    expect(
      createNoteRequestSchema.safeParse({ title: 'n', lessonId: LESSON }).success,
    ).toBe(true);
    expect(
      createNoteRequestSchema.safeParse({ title: 'n', lessonId: LESSON, courseId: COURSE }).success,
    ).toBe(false);
  });

  it('accepts a free-standing note with no anchor', () => {
    expect(createNoteRequestSchema.safeParse({ title: 'diary' }).success).toBe(true);
  });

  it('distinguishes an omitted anchor from an explicit null', () => {
    // `null` is how a learner unfiles a note; `undefined` means leave it alone.
    // A contract that collapsed them would make unanchoring impossible.
    const cleared = updateNoteRequestSchema.safeParse({ lessonId: null });
    expect(cleared.success).toBe(true);
    expect(cleared.success && 'lessonId' in cleared.data).toBe(true);

    const untouched = updateNoteRequestSchema.safeParse({ title: 'x' });
    expect(untouched.success && 'lessonId' in untouched.data).toBe(false);
  });

  it('has no ownerId field to forge', () => {
    expect(
      createNoteRequestSchema.safeParse({ title: 'n', ownerId: OTHER }).success,
    ).toBe(false);
  });
});

describe('the artifact contract is the first storage control', () => {
  const valid = {
    artifactType: 'image' as const,
    declaredContentType: 'image/png',
    byteSize: 1024,
  };

  it('accepts a well-formed registration', () => {
    expect(registerArtifactRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('refuses a size over the per-artifact ceiling', () => {
    expect(
      registerArtifactRequestSchema.safeParse({ ...valid, byteSize: ARTIFACT_MAX_BYTES + 1 })
        .success,
    ).toBe(false);
  });

  it('refuses a zero or negative size', () => {
    for (const byteSize of [0, -1]) {
      expect(registerArtifactRequestSchema.safeParse({ ...valid, byteSize }).success).toBe(false);
    }
  });

  it('enforces an ALLOW-LIST per artifact type', () => {
    expect(
      registerArtifactRequestSchema.safeParse({
        ...valid,
        artifactType: 'image',
        declaredContentType: 'application/pdf',
      }).success,
    ).toBe(false);
  });

  it('refuses image/svg+xml, which is a document and not a picture', () => {
    // The classic stored-XSS payload dressed as an image.
    expect(ALLOWED_CONTENT_TYPES.image).not.toContain('image/svg+xml');
    expect(
      registerArtifactRequestSchema.safeParse({
        ...valid,
        declaredContentType: 'image/svg+xml',
      }).success,
    ).toBe(false);
  });

  it('has NO field for a path, a URL or a storage key', () => {
    // The structural half of the tenant-scoping rule: there is nowhere for a
    // caller to name a location, so there is nothing to validate and nothing
    // to get wrong.
    for (const forged of [
      { filePath: '/etc/passwd' },
      { fileUrl: 'https://evil.example/x' },
      { storageKey: 'org/other/user/other/x' },
      { url: 'file:///etc/passwd' },
    ]) {
      expect(
        registerArtifactRequestSchema.safeParse({ ...valid, ...forged }).success,
        JSON.stringify(forged),
      ).toBe(false);
    }
  });

  it('has no ownerId field to forge', () => {
    expect(registerArtifactRequestSchema.safeParse({ ...valid, ownerId: OTHER }).success).toBe(
      false,
    );
  });

  it('refuses an artifact claiming two parents', () => {
    expect(
      registerArtifactRequestSchema.safeParse({ ...valid, noteId: NOTEBOOK, sessionId: ARTIFACT })
        .success,
    ).toBe(false);
  });

  it('refuses oversized metadata', () => {
    expect(
      registerArtifactRequestSchema.safeParse({
        ...valid,
        metadata: { blob: 'x'.repeat(20_000) },
      }).success,
    ).toBe(false);
  });

  it('keeps a filename as display metadata, bounded', () => {
    expect(
      registerArtifactRequestSchema.safeParse({ ...valid, originalFilename: '../../etc/passwd' })
        .success,
      'a traversal filename is ACCEPTED as text — it can never become a path',
    ).toBe(true);
    expect(
      registerArtifactRequestSchema.safeParse({ ...valid, originalFilename: 'x'.repeat(256) })
        .success,
    ).toBe(false);
  });
});
