import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  bodylessWriteHeaders,
  buildTestApp,
  sessionCookieFrom,
  writeHeaders,
  type TestApp,
} from '../setup/app.ts';
import { TEST_SUPERUSER_URL } from '../setup/env.ts';
import {
  addClassMember,
  assignTeacher,
  closeSeedDb,
  createClass,
  createOrganization,
  createUser,
  grantRole,
  linkGuardian,
  truncateAll,
} from '../setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';

/**
 * Class discussion forums and moderation, end to end over the real HTTP stack.
 *
 * Nothing is stubbed: the same composition root, the same policy engine, the
 * same `edu_app` role, the same RLS. This is the file section 2E names, and the
 * IDOR/BOLA matrix in the Task 014 report traces to the `IDOR-<letter>` markers
 * below.
 *
 * The RLS half — the same boundaries with no application code in the path — is
 * `tests/integration/rls-community.test.ts`. The pure-function half is
 * `tests/unit/community-content-filter.test.ts`. None of the three is
 * sufficient alone.
 */
const testApp: TestApp = await buildTestApp();

const PASSWORD = 'a-sufficiently-long-passphrase'; // secret-scan-allow: test fixture password

interface Session {
  readonly id: string;
  readonly cookie: string;
}

async function seedAndLogin(options: {
  email: string;
  roles?: readonly string[];
  organizationId?: string | null;
}): Promise<Session> {
  const user = await createUser({
    email: options.email,
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.organizationId !== undefined ? { organizationId: options.organizationId } : {}),
    passwordHash: await hashPassword(PASSWORD),
  });
  const response = await testApp.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: writeHeaders,
    payload: { email: options.email, password: PASSWORD },
  });
  if (response.statusCode !== 204) {
    throw new Error(`login failed for ${options.email}: ${response.statusCode} ${response.body}`);
  }
  return {
    id: user.id,
    cookie: `edu_session=${sessionCookieFrom(response.headers['set-cookie'])}`,
  };
}

const get = (url: string, cookie: string) =>
  testApp.app.inject({ method: 'GET', url, headers: { cookie } });

const post = (url: string, cookie: string, payload?: Record<string, unknown>) =>
  testApp.app.inject({
    method: 'POST',
    url,
    headers: { ...writeHeaders, cookie },
    payload: payload ?? {},
  });

const patch = (url: string, cookie: string, payload?: Record<string, unknown>) =>
  testApp.app.inject({
    method: 'PATCH',
    url,
    headers: { ...writeHeaders, cookie },
    payload: payload ?? {},
  });

const put = (url: string, cookie: string, payload: Record<string, unknown>) =>
  testApp.app.inject({ method: 'PUT', url, headers: { ...writeHeaders, cookie }, payload });

const del = (url: string, cookie: string) =>
  testApp.app.inject({ method: 'DELETE', url, headers: { ...bodylessWriteHeaders, cookie } });

const items = <T>(r: { json: <U>() => U }) => r.json<{ items: T[] }>().items;

async function auditTypes(): Promise<string[]> {
  const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
  await raw.connect();
  try {
    const { rows } = await raw.query<{ event_type: string }>('SELECT event_type FROM audit_log');
    return rows.map((r) => r.event_type);
  } finally {
    await raw.end();
  }
}

async function auditDetails(): Promise<string> {
  const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
  await raw.connect();
  try {
    const { rows } = await raw.query<{ detail: unknown }>('SELECT detail FROM audit_log');
    return JSON.stringify(rows);
  } finally {
    await raw.end();
  }
}

interface World {
  orgA: string;
  orgB: string;
  klass: string;
  otherClass: string;
  learner: Session;
  classmate: Session;
  outsider: Session;
  teacher: Session;
  otherTeacher: Session;
  admin: Session;
  moderator: Session;
  guardian: Session;
  stranger: Session;
}

/**
 * Two schools, two classes in the first, and one adult of every kind.
 *
 * `otherTeacher` teaches `otherClass` in the SAME school — the case that
 * separates "an adult in your organization" from "the adult responsible for
 * your class". Without them the moderation boundary would look correct while
 * actually being school-wide.
 */
async function world(): Promise<World> {
  const orgA = await createOrganization('School A');
  const orgB = await createOrganization('School B');

  const mk = (email: string, roles?: readonly string[], org: string | null = orgA) =>
    seedAndLogin({ email, ...(roles ? { roles } : {}), organizationId: org });

  const learner = await mk('learner@a.test', ['student']);
  const classmate = await mk('classmate@a.test', ['student']);
  const outsider = await mk('outsider@a.test', ['student']);
  const teacher = await mk('teacher@a.test', ['teacher']);
  const otherTeacher = await mk('other-teacher@a.test', ['teacher']);
  const admin = await mk('admin@a.test', ['admin']);
  await grantRole(admin.id, 'admin', 'organization', orgA);
  const moderator = await mk('moderator@a.test', ['moderator']);
  await grantRole(moderator.id, 'moderator', 'organization', orgA);
  const guardian = await mk('guardian@a.test', ['guardian']);
  const stranger = await mk('stranger@b.test', ['student'], orgB);

  const klass = await createClass(orgA, 'A1');
  const otherClass = await createClass(orgA, 'A2');
  await addClassMember(klass, learner.id);
  await addClassMember(klass, classmate.id);
  await addClassMember(otherClass, outsider.id);
  await assignTeacher(teacher.id, klass);
  await assignTeacher(otherTeacher.id, otherClass);
  await linkGuardian(guardian.id, learner.id, 'verified');

  return {
    orgA,
    orgB,
    klass,
    otherClass,
    learner,
    classmate,
    outsider,
    teacher,
    otherTeacher,
    admin,
    moderator,
    guardian,
    stranger,
  };
}

interface ThreadBody {
  id: string;
  classId: string;
  title: string;
  contentMarkdown: string;
  isPinned: boolean;
  isLocked: boolean;
  moderationStatus: string;
  author: { id: string; displayName: string };
  replyCount: number;
}

interface ReplyBody {
  id: string;
  threadId: string;
  parentReplyId: string | null;
  contentMarkdown: string;
  isAcceptedAnswer: boolean;
  moderationStatus: string;
}

async function makeThread(
  w: World,
  session: Session,
  overrides: Record<string, unknown> = {},
): Promise<ThreadBody> {
  const created = await post(`/api/v1/classes/${w.klass}/threads`, session.cookie, {
    title: 'How do pendulums work?',
    contentMarkdown: 'I ran twenty trials and the period barely moved.',
    ...overrides,
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json<ThreadBody>();
}

async function makeReply(
  session: Session,
  threadId: string,
  overrides: Record<string, unknown> = {},
): Promise<ReplyBody> {
  const created = await post(`/api/v1/threads/${threadId}/replies`, session.cookie, {
    contentMarkdown: 'Try measuring from the pivot rather than the bob.',
    ...overrides,
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json<ReplyBody>();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await testApp.db.close();
  await closeSeedDb();
});

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

describe('a forum is a class, and the class is the boundary', () => {
  it('a learner posts in their own class and their classmate reads it', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    expect(thread.moderationStatus).toBe('approved');

    const read = await get(`/api/v1/threads/${thread.id}`, w.classmate.cookie);
    expect(read.statusCode).toBe(200);
    expect(read.json<{ thread: ThreadBody }>().thread.title).toBe('How do pendulums work?');
  });

  it('shows the author a name, which requires reaching past users RLS safely', async () => {
    // A classmate is not somebody's self, teacher or guardian, so `users_select`
    // admits nothing. The first version of this query joined `users` and would
    // have produced a forum where every post is by nobody — VULN-055's shape.
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const read = await get(`/api/v1/threads/${thread.id}`, w.classmate.cookie);
    expect(read.json<{ thread: ThreadBody }>().thread.author.displayName).not.toBe(
      'A member of this class',
    );
  });

  it('IDOR-A: a learner in another class of the same school cannot read it', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    expect((await get(`/api/v1/threads/${thread.id}`, w.outsider.cookie)).statusCode).toBe(404);
  });

  it('IDOR-B: a learner in another school cannot read it', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    expect((await get(`/api/v1/threads/${thread.id}`, w.stranger.cookie)).statusCode).toBe(404);
  });

  it('IDOR-C: a learner cannot post into a class they are not in', async () => {
    const w = await world();
    const attempt = await post(`/api/v1/classes/${w.klass}/threads`, w.outsider.cookie, {
      title: 'Intruder',
      contentMarkdown: 'I am not in this class.',
    });
    expect(attempt.statusCode).toBe(404);
  });

  it('IDOR-D: a learner in another school cannot post either', async () => {
    const w = await world();
    const attempt = await post(`/api/v1/classes/${w.klass}/threads`, w.stranger.cookie, {
      title: 'Cross tenant',
      contentMarkdown: 'Hello from School B.',
    });
    expect(attempt.statusCode).toBe(404);
  });

  it('IDOR-E: a learner cannot reply to a thread in a class they are not in', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const attempt = await post(`/api/v1/threads/${thread.id}/replies`, w.outsider.cookie, {
      contentMarkdown: 'Not my class.',
    });
    expect(attempt.statusCode).toBe(404);
  });

  it('IDOR-F: the class feed for a class the caller is not in is empty, not 403', async () => {
    const w = await world();
    await makeThread(w, w.learner);
    const response = await get(`/api/v1/classes/${w.klass}/threads`, w.outsider.cookie);
    expect(response.statusCode).toBe(200);
    expect(items(response)).toEqual([]);

    const invented = await get(
      '/api/v1/classes/11111111-1111-4111-8111-111111111111/threads',
      w.learner.cookie,
    );
    expect(invented.statusCode).toBe(200);
    expect(items(invented)).toEqual([]);
  });

  it('IDOR-G: a made-up thread id is indistinguishable from somebody else’s', async () => {
    const w = await world();
    const real = await makeThread(w, w.learner);
    const [a, b] = await Promise.all([
      get(`/api/v1/threads/${real.id}`, w.outsider.cookie),
      get('/api/v1/threads/11111111-1111-4111-8111-111111111111', w.outsider.cookie),
    ]);
    expect(a.statusCode).toBe(b.statusCode);
    const shape = (r: { json: <T>() => T }) => {
      const { error } = r.json<{ error: { code: string; message: string } }>();
      return { code: error.code, message: error.message };
    };
    expect(shape(a)).toEqual(shape(b));
  });

  it('a guardian of a learner in the class still sees nothing', async () => {
    // A guardian is not in the room. Reading their child's coursework is one
    // thing; reading a conversation between thirty children is another.
    const w = await world();
    const thread = await makeThread(w, w.learner);
    expect((await get(`/api/v1/threads/${thread.id}`, w.guardian.cookie)).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Authorship
// ---------------------------------------------------------------------------

describe('a post belongs to the person who wrote it', () => {
  it('IDOR-H: a classmate cannot edit or delete somebody else’s thread', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    expect(
      (await put(`/api/v1/threads/${thread.id}`, w.classmate.cookie, { title: 'Mine now' }))
        .statusCode,
    ).toBe(404);
    expect((await del(`/api/v1/threads/${thread.id}`, w.classmate.cookie)).statusCode).toBe(404);
  });

  it('IDOR-I: a classmate cannot edit or delete somebody else’s reply', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const reply = await makeReply(w.classmate, thread.id);
    expect(
      (await put(`/api/v1/replies/${reply.id}`, w.learner.cookie, { contentMarkdown: 'Changed.' }))
        .statusCode,
    ).toBe(404);
    expect((await del(`/api/v1/replies/${reply.id}`, w.learner.cookie)).statusCode).toBe(404);
  });

  it('the author edits their own', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const saved = await put(`/api/v1/threads/${thread.id}`, w.learner.cookie, {
      title: 'How do pendulums really work?',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<ThreadBody>().title).toBe('How do pendulums really work?');
  });

  it('refuses a forged authorId in the body outright', async () => {
    const w = await world();
    const created = await post(`/api/v1/classes/${w.klass}/threads`, w.learner.cookie, {
      title: 'Forged',
      contentMarkdown: 'Signed by somebody else.',
      authorId: w.classmate.id,
    });
    expect(created.statusCode).toBe(400);
  });

  it('refuses a caller-supplied moderationStatus, isPinned or isLocked', async () => {
    const w = await world();
    for (const forged of [
      { moderationStatus: 'approved' },
      { isPinned: true },
      { isLocked: true },
    ]) {
      const created = await post(`/api/v1/classes/${w.klass}/threads`, w.learner.cookie, {
        title: 'Forged field',
        contentMarkdown: 'body',
        ...forged,
      });
      expect(created.statusCode, JSON.stringify(forged)).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 3: the locked-thread enforcer
// ---------------------------------------------------------------------------

describe('a locked thread', () => {
  async function lock(w: World, threadId: string): Promise<void> {
    const locked = await patch('/api/v1/moderation/action', w.teacher.cookie, {
      entityType: 'thread',
      entityId: threadId,
      action: 'lock',
    });
    expect(locked.statusCode, locked.body).toBe(204);
  }

  it('IDOR-J: refuses a new reply, and says why', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    await lock(w, thread.id);

    const attempt = await post(`/api/v1/threads/${thread.id}/replies`, w.classmate.cookie, {
      contentMarkdown: 'Sneaking past the lock.',
    });
    // `reveal`, not `hide`: the learner is looking at the thread and knows it
    // exists. A silent 404 would read as the platform being broken.
    expect(attempt.statusCode).toBe(403);
    expect(attempt.body).toContain('locked');
  });

  it('IDOR-K: refuses the author editing their own thread', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    await lock(w, thread.id);
    const attempt = await put(`/api/v1/threads/${thread.id}`, w.learner.cookie, {
      title: 'Editing round the lock',
    });
    expect(attempt.statusCode).toBe(403);
  });

  it('refuses the author editing a reply inside it', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const reply = await makeReply(w.classmate, thread.id);
    await lock(w, thread.id);
    const attempt = await put(`/api/v1/replies/${reply.id}`, w.classmate.cookie, {
      contentMarkdown: 'Edited while locked.',
    });
    expect(attempt.statusCode).toBe(403);
  });

  it('stays READABLE — locking ends a conversation, it does not delete it', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    await makeReply(w.classmate, thread.id);
    await lock(w, thread.id);

    const read = await get(`/api/v1/threads/${thread.id}`, w.classmate.cookie);
    expect(read.statusCode).toBe(200);
    expect(read.json<{ replies: ReplyBody[] }>().replies).toHaveLength(1);
  });

  it('a learner cannot unlock it', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    await lock(w, thread.id);
    const attempt = await patch('/api/v1/moderation/action', w.learner.cookie, {
      entityType: 'thread',
      entityId: thread.id,
      action: 'unlock',
    });
    expect(attempt.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Section 2E: moderation actions by a non-moderator
// ---------------------------------------------------------------------------

describe('moderation is staff only', () => {
  it.each(['pin', 'lock', 'hide', 'approve'])(
    'IDOR-L: a learner cannot %s a thread',
    async (action) => {
      const w = await world();
      const thread = await makeThread(w, w.learner);
      const attempt = await patch('/api/v1/moderation/action', w.classmate.cookie, {
        entityType: 'thread',
        entityId: thread.id,
        action,
      });
      expect(attempt.statusCode).toBe(404);
    },
  );

  it('IDOR-M: the AUTHOR cannot moderate their own thread either', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const attempt = await patch('/api/v1/moderation/action', w.learner.cookie, {
      entityType: 'thread',
      entityId: thread.id,
      action: 'pin',
    });
    expect(attempt.statusCode).toBe(404);
  });

  it('IDOR-N: a teacher of another class cannot moderate here', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const attempt = await patch('/api/v1/moderation/action', w.otherTeacher.cookie, {
      entityType: 'thread',
      entityId: thread.id,
      action: 'hide',
    });
    expect(attempt.statusCode).toBe(404);
  });

  it('the class teacher, an org admin and a moderator all can', async () => {
    for (const who of ['teacher', 'admin', 'moderator'] as const) {
      await truncateAll();
      const w = await world();
      const thread = await makeThread(w, w.learner);
      const response = await patch('/api/v1/moderation/action', w[who].cookie, {
        entityType: 'thread',
        entityId: thread.id,
        action: 'hide',
      });
      expect(response.statusCode, `${who}: ${response.body}`).toBe(204);
    }
  });

  it('IDOR-O: a moderator cannot rewrite a child’s post', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const attempt = await put(`/api/v1/threads/${thread.id}`, w.teacher.cookie, {
      contentMarkdown: 'Teacher wrote this.',
    });
    expect(attempt.statusCode).toBe(404);

    const unchanged = await get(`/api/v1/threads/${thread.id}`, w.learner.cookie);
    expect(unchanged.json<{ thread: ThreadBody }>().thread.contentMarkdown).toContain(
      'twenty trials',
    );
  });

  it('records the action, naming which power was used', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    await patch('/api/v1/moderation/action', w.teacher.cookie, {
      entityType: 'thread',
      entityId: thread.id,
      action: 'lock',
    });
    expect(await auditTypes()).toContain('moderation.action');
    expect(await auditDetails()).toContain('lock');
  });
});

// ---------------------------------------------------------------------------
// Section 3: zero leakage of flagged and hidden posts
// ---------------------------------------------------------------------------

describe('hidden and flagged posts', () => {
  async function hide(w: World, threadId: string): Promise<void> {
    const hidden = await patch('/api/v1/moderation/action', w.teacher.cookie, {
      entityType: 'thread',
      entityId: threadId,
      action: 'hide',
    });
    expect(hidden.statusCode, hidden.body).toBe(204);
  }

  it('IDOR-P: a hidden thread disappears from a classmate’s feed and reads 404', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    await hide(w, thread.id);

    expect((await get(`/api/v1/threads/${thread.id}`, w.classmate.cookie)).statusCode).toBe(404);
    const feed = items<ThreadBody>(
      await get(`/api/v1/classes/${w.klass}/threads`, w.classmate.cookie),
    );
    expect(feed.map((t) => t.id)).not.toContain(thread.id);
  });

  it('the AUTHOR still sees their own hidden post, marked as such', async () => {
    // A child whose post vanishes without trace learns the platform is
    // unreliable and posts it again. It is their own text, so showing it to
    // them discloses nothing.
    const w = await world();
    const thread = await makeThread(w, w.learner);
    await hide(w, thread.id);

    const read = await get(`/api/v1/threads/${thread.id}`, w.learner.cookie);
    expect(read.statusCode).toBe(200);
    expect(read.json<{ thread: ThreadBody }>().thread.moderationStatus).toBe('hidden');
  });

  it('and cannot edit their way out of it', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    await hide(w, thread.id);
    const attempt = await put(`/api/v1/threads/${thread.id}`, w.learner.cookie, {
      contentMarkdown: 'Rewritten after hiding.',
    });
    expect(attempt.statusCode).toBe(403);
    expect(attempt.body).toContain('review');
  });

  it('staff still see it, which is what makes a queue possible', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    await hide(w, thread.id);
    expect((await get(`/api/v1/threads/${thread.id}`, w.teacher.cookie)).statusCode).toBe(200);
  });

  it('a hidden REPLY drops out of the thread for a classmate but not its author', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const reply = await makeReply(w.classmate, thread.id);
    const hidden = await patch('/api/v1/moderation/action', w.teacher.cookie, {
      entityType: 'reply',
      entityId: reply.id,
      action: 'hide',
    });
    expect(hidden.statusCode, hidden.body).toBe(204);

    const asOther = await get(`/api/v1/threads/${thread.id}`, w.learner.cookie);
    expect(asOther.json<{ replies: ReplyBody[] }>().replies).toHaveLength(0);

    const asAuthor = await get(`/api/v1/threads/${thread.id}`, w.classmate.cookie);
    expect(asAuthor.json<{ replies: ReplyBody[] }>().replies).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Section 2B: the automated filter, over HTTP
// ---------------------------------------------------------------------------

describe('the automated filter', () => {
  it('creates an offensive post as flagged, never approved for even one request', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner, {
      title: 'A question',
      contentMarkdown: 'you are an idiot and nobody likes you',
    });
    expect(thread.moderationStatus).toBe('flagged');
  });

  it('hides that post from classmates immediately', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner, {
      contentMarkdown: 'you are an idiot',
    });
    expect((await get(`/api/v1/threads/${thread.id}`, w.classmate.cookie)).statusCode).toBe(404);
  });

  it('files it into the same queue a human report would', async () => {
    const w = await world();
    await makeThread(w, w.learner, { contentMarkdown: 'you are an idiot' });
    const queue = items<{ raisedBy: string; entityType: string }>(
      await get('/api/v1/moderation/flags', w.teacher.cookie),
    );
    expect(queue).toHaveLength(1);
    expect(queue[0]?.raisedBy).toBe('automated_filter');
    expect(await auditTypes()).toContain('moderation.auto_flagged');
  });

  it('IDOR-Q: catches evasions that would pass a naive substring check', async () => {
    const w = await world();
    for (const body of ['you are an 1d10t', 'you are an i d i o t', 'you are an idiiiiot']) {
      const thread = await makeThread(w, w.learner, { contentMarkdown: body });
      expect(thread.moderationStatus, body).toBe('flagged');
    }
  });

  it('MISSES a partially-spaced evasion, and that is recorded rather than hidden', async () => {
    // `1d1 0t` splits the word across a single space in the middle. The
    // normalizer collapses letter-by-letter runs, which needs two or more
    // letter-separator pairs; one interior space is not a run.
    //
    // This test asserts the CURRENT behaviour on purpose. A word-list filter has
    // an infinite input space and will always have a next evasion; pretending
    // otherwise is how a filter comes to be mistaken for a safety boundary.
    // What catches this in practice is the class, who can report it — which is
    // why the reporting path is the load-bearing half of this domain.
    // Recorded as RISK-COM-02 in docs/security/limitations.md.
    const w = await world();
    const thread = await makeThread(w, w.learner, { contentMarkdown: 'you are an 1d1 0t' });
    expect(thread.moderationStatus).toBe('approved');
  });

  it('re-screens an EDIT, so the filter is not a one-time check', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    expect(thread.moderationStatus).toBe('approved');

    const edited = await put(`/api/v1/threads/${thread.id}`, w.learner.cookie, {
      contentMarkdown: 'actually you are an idiot',
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json<ThreadBody>().moderationStatus).toBe('flagged');
  });

  it('re-screens an edited REPLY, not only an edited thread', async () => {
    /**
     * DEFECT INJECTION ROUND 13, F14, FOUND THIS FILE'S BLIND SPOT.
     *
     * Removing the re-screen from `updateReply` was caught only by the
     * architecture suite's source-text assertion — every behavioural test still
     * passed, because the test above exercises the THREAD edit path and there
     * was nothing exercising the reply one. A learner posts an innocuous reply,
     * edits it a second later, and the filter never runs.
     *
     * Two paths do the same job, and testing one of them is testing one of them.
     */
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const reply = await makeReply(w.classmate, thread.id);
    expect(reply.moderationStatus).toBe('approved');

    const edited = await put(`/api/v1/replies/${reply.id}`, w.classmate.cookie, {
      contentMarkdown: 'actually you are an idiot',
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json<ReplyBody>().moderationStatus).toBe('flagged');
  });

  it('leaves homework alone', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner, {
      title: 'Assignment help',
      contentMarkdown: 'I did the classic analysis for my class assessment. Any tips?',
    });
    expect(thread.moderationStatus).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// Section 3: markdown link schemes
// ---------------------------------------------------------------------------

describe('markdown link destinations', () => {
  it.each([
    '[click](javascript:alert(1))',
    '[click](JavaScript:alert(1))',
    '[click](data:text/html;base64,PHNjcmlwdD4=)',
    '[click](vbscript:msgbox)',
    '<javascript:alert(1)>',
  ])('refuses %s in a thread', async (body) => {
    const w = await world();
    const created = await post(`/api/v1/classes/${w.klass}/threads`, w.learner.cookie, {
      title: 'Link test',
      contentMarkdown: `Look at this ${body}`,
    });
    expect(created.statusCode, created.body).toBe(400);
  });

  it('refuses a reference definition, which must start its own line', async () => {
    // `[ref]: javascript:...` is only a markdown reference definition at the
    // start of a line. Mid-sentence it is literal text and no renderer would
    // turn it into an href — so the check correctly ignores it there, and this
    // asserts the position that actually matters.
    const w = await world();
    const created = await post(`/api/v1/classes/${w.klass}/threads`, w.learner.cookie, {
      title: 'Link test',
      contentMarkdown: 'See the notes below.\n\n[ref]: javascript:alert(1)',
    });
    expect(created.statusCode, created.body).toBe(400);
  });

  it('refuses them in a reply too', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const attempt = await post(`/api/v1/threads/${thread.id}/replies`, w.classmate.cookie, {
      contentMarkdown: 'See [here](javascript:alert(document.cookie))',
    });
    expect(attempt.statusCode).toBe(400);
  });

  it('allows an ordinary https link and a code block discussing the scheme', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner, {
      contentMarkdown:
        'See [the notes](https://example.org/notes). We learned that `javascript:` URLs are unsafe.',
    });
    expect(thread.moderationStatus).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// Replies, nesting and accepted answers
// ---------------------------------------------------------------------------

describe('the reply tree', () => {
  it('nests a reply under another in the same thread', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const first = await makeReply(w.classmate, thread.id);
    const second = await makeReply(w.learner, thread.id, { parentReplyId: first.id });
    expect(second.parentReplyId).toBe(first.id);
  });

  it('IDOR-R: refuses a parent that lives in another class’s thread', async () => {
    // The composite foreign key. Every policy would admit this row — it is in a
    // thread the author may post to — and referential integrity refuses it.
    const w = await world();
    const mine = await makeThread(w, w.learner);

    const theirs = await post(`/api/v1/classes/${w.otherClass}/threads`, w.outsider.cookie, {
      title: 'Other class',
      contentMarkdown: 'Private to A2.',
    });
    expect(theirs.statusCode).toBe(201);
    const theirReply = await post(
      `/api/v1/threads/${theirs.json<ThreadBody>().id}/replies`,
      w.outsider.cookie,
      { contentMarkdown: 'Words from another room.' },
    );
    expect(theirReply.statusCode).toBe(201);

    const attempt = await post(`/api/v1/threads/${mine.id}/replies`, w.learner.cookie, {
      contentMarkdown: 'Nesting across a class boundary.',
      parentReplyId: theirReply.json<ReplyBody>().id,
    });
    expect(attempt.statusCode).toBe(404);
  });

  it('the person who asked accepts an answer', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const reply = await makeReply(w.classmate, thread.id);
    const accepted = await patch(`/api/v1/replies/${reply.id}/accept`, w.learner.cookie);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json<ReplyBody>().isAcceptedAnswer).toBe(true);
  });

  it('IDOR-S: the ANSWERER cannot accept their own answer', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const reply = await makeReply(w.classmate, thread.id);
    const attempt = await patch(`/api/v1/replies/${reply.id}/accept`, w.classmate.cookie);
    expect(attempt.statusCode).toBe(403);
  });

  it('IDOR-T: somebody who neither asked nor answered cannot accept', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const reply = await makeReply(w.classmate, thread.id);
    const attempt = await patch(`/api/v1/replies/${reply.id}/accept`, w.outsider.cookie);
    expect(attempt.statusCode).toBe(404);
  });

  it('answering your OWN question and accepting it is still refused', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const own = await makeReply(w.learner, thread.id);
    const attempt = await patch(`/api/v1/replies/${own.id}/accept`, w.learner.cookie);
    expect(attempt.statusCode).toBe(403);
  });

  it('accepting a second answer moves the marker rather than failing', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const first = await makeReply(w.classmate, thread.id);
    const second = await makeReply(w.classmate, thread.id, { contentMarkdown: 'Or try this.' });

    expect((await patch(`/api/v1/replies/${first.id}/accept`, w.learner.cookie)).statusCode).toBe(
      200,
    );
    expect((await patch(`/api/v1/replies/${second.id}/accept`, w.learner.cookie)).statusCode).toBe(
      200,
    );

    const read = await get(`/api/v1/threads/${thread.id}`, w.learner.cookie);
    const accepted = read
      .json<{ replies: ReplyBody[] }>()
      .replies.filter((r) => r.isAcceptedAnswer);
    expect(accepted.map((r) => r.id)).toEqual([second.id]);
  });
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

describe('reporting a post', () => {
  it('a classmate reports, and the teacher sees it in the queue', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const reported = await post('/api/v1/discussions/flag', w.classmate.cookie, {
      entityType: 'thread',
      entityId: thread.id,
      reason: 'This is unkind about somebody in our class.',
    });
    expect(reported.statusCode, reported.body).toBe(202);

    const queue = items<{ reporterId: string; reason: string; subjectExcerpt: string }>(
      await get('/api/v1/moderation/flags', w.teacher.cookie),
    );
    expect(queue).toHaveLength(1);
    expect(queue[0]?.reporterId).toBe(w.classmate.id);
    expect(queue[0]?.subjectExcerpt).toContain('twenty trials');
  });

  it('IDOR-U: the reported author never sees who reported them', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    await post('/api/v1/discussions/flag', w.classmate.cookie, {
      entityType: 'thread',
      entityId: thread.id,
      reason: 'Unkind.',
    });

    const asAuthor = await get('/api/v1/moderation/flags', w.learner.cookie);
    expect(asAuthor.statusCode).toBe(200);
    expect(items(asAuthor)).toEqual([]);
    expect(asAuthor.body).not.toContain(w.classmate.id);
  });

  it('IDOR-V: a teacher of another class does not see this queue', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    await post('/api/v1/discussions/flag', w.classmate.cookie, {
      entityType: 'thread',
      entityId: thread.id,
      reason: 'Unkind.',
    });
    expect(items(await get('/api/v1/moderation/flags', w.otherTeacher.cookie))).toEqual([]);
  });

  it('IDOR-W: another school does not see it', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    await post('/api/v1/discussions/flag', w.classmate.cookie, {
      entityType: 'thread',
      entityId: thread.id,
      reason: 'Unkind.',
    });
    expect(items(await get('/api/v1/moderation/flags', w.stranger.cookie))).toEqual([]);
  });

  it('the reporter sees their own report', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    await post('/api/v1/discussions/flag', w.classmate.cookie, {
      entityType: 'thread',
      entityId: thread.id,
      reason: 'Unkind.',
    });
    expect(items(await get('/api/v1/moderation/flags', w.classmate.cookie))).toHaveLength(1);
  });

  it('a second report of the same post by the same person answers identically', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    const body = { entityType: 'thread', entityId: thread.id, reason: 'Unkind.' };
    const first = await post('/api/v1/discussions/flag', w.classmate.cookie, body);
    const second = await post('/api/v1/discussions/flag', w.classmate.cookie, body);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.body).toBe(first.body);

    const queue = items(await get('/api/v1/moderation/flags', w.teacher.cookie));
    expect(queue).toHaveLength(1);
  });

  it('never records the reason text in the audit trail', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    await post('/api/v1/discussions/flag', w.classmate.cookie, {
      entityType: 'thread',
      entityId: thread.id,
      reason: 'SENSITIVEACCOUNTOFWHATHAPPENED',
    });
    expect(await auditTypes()).toContain('moderation.content_reported');
    expect(await auditDetails()).not.toContain('SENSITIVEACCOUNTOFWHATHAPPENED');
  });

  it('a moderation action can close the flags that prompted it', async () => {
    const w = await world();
    const thread = await makeThread(w, w.learner);
    await post('/api/v1/discussions/flag', w.classmate.cookie, {
      entityType: 'thread',
      entityId: thread.id,
      reason: 'Unkind.',
    });
    await patch('/api/v1/moderation/action', w.teacher.cookie, {
      entityType: 'thread',
      entityId: thread.id,
      action: 'hide',
      resolveFlagsAs: 'reviewed',
    });
    const queue = items<{ status: string }>(
      await get('/api/v1/moderation/flags?status=pending', w.teacher.cookie),
    );
    expect(queue).toEqual([]);
  });
});
