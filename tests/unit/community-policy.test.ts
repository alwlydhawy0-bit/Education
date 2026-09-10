import { describe, expect, it } from 'vitest';
import {
  CONTENT_FLAG_ACTIONS,
  DISCUSSION_REPLY_ACTIONS,
  DISCUSSION_THREAD_ACTIONS,
  contentFlagPolicy,
  discussionReplyPolicy,
  discussionThreadPolicy,
  type AuthorizationContext,
  type ContentFlagAction,
  type ContentFlagResource,
  type DiscussionReplyAction,
  type DiscussionReplyResource,
  type Decision,
  type DenyDecision,
  type DiscussionThreadAction,
  type DiscussionThreadResource,
} from '@edu/authz';

/**
 * The decision tables for class forums and moderation.
 *
 * PURE FUNCTIONS, SO EVERY CELL IS CHEAP. `tests/security/community.test.ts`
 * proves the boundary holds over HTTP with both gates up;
 * `tests/integration/rls-community.test.ts` proves the database holds it with
 * the application deleted; the layered-defence block proves the application
 * holds it with the database's opinion switched off. THIS file enumerates the
 * grid, including the combinations that are awkward to construct end to end: a
 * learner who is both the author and the questioner, a post whose thread is
 * locked AND hidden, a teacher looking at a post from a class they left.
 *
 * The DISPOSITION is asserted as often as the effect. On a forum for children
 * `hide` and `reveal` are not interchangeable spellings of "no": one tells a
 * child their reply was refused because a teacher locked the thread, and the
 * other tells them nothing and leaves them to conclude the platform is broken.
 * Every deny below is checked for which one it is.
 */

const AUTHOR = 'author-id';
const READER = 'reader-id';
const STAFF = 'staff-id';

const ctx = (actorId: string): AuthorizationContext =>
  ({
    actor: { id: actorId, roles: [], organizationId: 'org' },
    relationships: { teachesStudents: [], guardianOf: [], sharesClassWith: [] },
  }) as unknown as AuthorizationContext;

const thread = (overrides: Partial<DiscussionThreadResource> = {}): DiscussionThreadResource => ({
  kind: 'discussion_thread',
  id: 'thread-id',
  ownerId: AUTHOR,
  organizationId: 'org',
  classId: 'class-id',
  moderationStatus: 'approved',
  isLocked: false,
  actorInForum: true,
  actorModerates: false,
  ...overrides,
});

const reply = (overrides: Partial<DiscussionReplyResource> = {}): DiscussionReplyResource => ({
  kind: 'discussion_reply',
  id: 'reply-id',
  ownerId: AUTHOR,
  organizationId: 'org',
  classId: 'class-id',
  threadId: 'thread-id',
  moderationStatus: 'approved',
  threadIsLocked: false,
  actorInForum: true,
  actorModerates: false,
  actorOwnsThread: false,
  ...overrides,
});

const flag = (overrides: Partial<ContentFlagResource> = {}): ContentFlagResource => ({
  kind: 'content_flag',
  id: 'flag-id',
  reporterId: READER,
  organizationId: 'org',
  actorModerates: false,
  ...overrides,
});

const onThread = (actorId: string, action: DiscussionThreadAction, r: DiscussionThreadResource) =>
  discussionThreadPolicy(ctx(actorId), action, r);
const onReply = (actorId: string, action: DiscussionReplyAction, r: DiscussionReplyResource) =>
  discussionReplyPolicy(ctx(actorId), action, r);
const onFlag = (actorId: string, action: ContentFlagAction, r: ContentFlagResource) =>
  contentFlagPolicy(ctx(actorId), action, r);

/**
 * Narrows a decision to a refusal and hands back the deny branch.
 *
 * `disclosure` lives only on `DenyDecision`, which is the type system saying
 * what this suite keeps asserting: an allow has nothing to disclose. Going
 * through this helper means a test that expected a refusal and got an allow
 * fails on THAT, rather than on a missing field three lines later.
 */
function refusal(decision: Decision): DenyDecision {
  expect(decision.effect, `expected a refusal, got ${decision.effect}: ${decision.reason}`).toBe(
    'deny',
  );
  return decision as DenyDecision;
}

// ---------------------------------------------------------------------------
// Totality
// ---------------------------------------------------------------------------

describe('every declared verb has an answer', () => {
  it.each(DISCUSSION_THREAD_ACTIONS)('%s decides for a thread', (action) => {
    // THE VOCABULARY AND THE POLICY CANNOT DRIFT APART SILENTLY. Three of these
    // verbs have no caller in the community module today; if one of them fell
    // through to a thrown error rather than a decision, nothing else in the
    // suite would notice until the day somebody wrote the endpoint.
    for (const actor of [AUTHOR, READER, STAFF]) {
      const decision = onThread(actor, action, thread({ actorModerates: actor === STAFF }));
      expect(['allow', 'deny'], `${action}/${actor}`).toContain(decision.effect);
    }
  });

  it.each(DISCUSSION_REPLY_ACTIONS)('%s decides for a reply', (action) => {
    for (const actor of [AUTHOR, READER, STAFF]) {
      const decision = onReply(actor, action, reply({ actorModerates: actor === STAFF }));
      expect(['allow', 'deny'], `${action}/${actor}`).toContain(decision.effect);
    }
  });

  it.each(CONTENT_FLAG_ACTIONS)('%s decides for a flag', (action) => {
    for (const actor of [AUTHOR, READER, STAFF]) {
      const decision = onFlag(actor, action, flag({ actorModerates: actor === STAFF }));
      expect(['allow', 'deny'], `${action}/${actor}`).toContain(decision.effect);
    }
  });

  it('an unknown verb falls through to a hidden denial, not to an allow', () => {
    // The final `return deny(...)` in each policy. A default that allowed would
    // turn every future typo in an action string into an open door.
    const bogus = 'discussion_thread:approve_everything' as DiscussionThreadAction;
    const decision = onThread(STAFF, bogus, thread({ actorModerates: true }));
    expect(decision.effect).toBe('deny');
    expect(refusal(decision).disclosure).toBe('hide');
  });
});

// ---------------------------------------------------------------------------
// The room is the boundary
// ---------------------------------------------------------------------------

describe('discussionThreadPolicy — the room', () => {
  it('admits a classmate to an approved thread and nobody else', () => {
    expect(onThread(READER, 'discussion_thread:read', thread()).effect).toBe('allow');
    expect(
      onThread(READER, 'discussion_thread:read', thread({ actorInForum: false })).effect,
    ).toBe('deny');
  });

  it('REFUSES a reader outside the room even when they wrote nothing wrong', () => {
    // There is no organization-wide read and no "same year group". A learner in
    // 9A cannot see 9B's forum, whatever else is true about them.
    const decision = onThread(READER, 'discussion_thread:read', thread({ actorInForum: false }));
    expect(decision.effect).toBe('deny');
    expect(refusal(decision).disclosure).toBe('hide');
    expect(decision.reason).toContain('not_visible');
  });

  it('REFUSES posting into a class the actor is not in, with hide', () => {
    const decision = onThread(READER, 'discussion_thread:create', thread({ actorInForum: false }));
    expect(decision.effect).toBe('deny');
    // `hide`, because the id names a CLASS the actor has been granted nothing
    // about: "you are not in this class" confirms the class is real, which
    // Task 012 measured as a cross-tenant existence oracle.
    expect(refusal(decision).disclosure).toBe('hide');
  });

  it('lets the author read their own thread at every moderation status', () => {
    // Including the version a reviewer hid. Silence about a child's own words
    // would be worse than the removal.
    for (const moderationStatus of ['approved', 'flagged', 'hidden'] as const) {
      expect(
        onThread(AUTHOR, 'discussion_thread:read', thread({ moderationStatus })).effect,
        moderationStatus,
      ).toBe('allow');
    }
  });

  it('HIDES a flagged or hidden thread from a classmate', () => {
    // Section 3's zero-leakage clause, as a decision rather than a query.
    for (const moderationStatus of ['flagged', 'hidden'] as const) {
      const decision = onThread(READER, 'discussion_thread:list', thread({ moderationStatus }));
      expect(decision.effect, moderationStatus).toBe('deny');
      expect(refusal(decision).disclosure, moderationStatus).toBe('hide');
    }
  });

  it('lets staff read a thread at any status', () => {
    for (const moderationStatus of ['approved', 'flagged', 'hidden'] as const) {
      expect(
        onThread(
          STAFF,
          'discussion_thread:read',
          thread({ moderationStatus, actorModerates: true, actorInForum: false }),
        ).effect,
        moderationStatus,
      ).toBe('allow');
    }
  });
});

describe('discussionThreadPolicy — writing is the author alone', () => {
  it.each(['discussion_thread:update', 'discussion_thread:delete'] as const)(
    'REFUSES %s to a classmate, with hide',
    (action) => {
      const decision = onThread(READER, action, thread());
      expect(decision.effect).toBe('deny');
      expect(refusal(decision).disclosure).toBe('hide');
      expect(decision.reason).toContain('not_author');
    },
  );

  it('REFUSES the author while the thread is locked, with REVEAL', () => {
    // The author is looking at their own post and knows it exists. The true
    // answer — a teacher locked this — is one they are entitled to.
    const decision = onThread(AUTHOR, 'discussion_thread:update', thread({ isLocked: true }));
    expect(decision.effect).toBe('deny');
    expect(refusal(decision).disclosure).toBe('reveal');
    expect(decision.reason).toContain('locked');
  });

  it('REFUSES the author while the thread is hidden, with reveal', () => {
    const decision = onThread(
      AUTHOR,
      'discussion_thread:update',
      thread({ moderationStatus: 'hidden' }),
    );
    expect(decision.effect).toBe('deny');
    expect(refusal(decision).disclosure).toBe('reveal');
  });

  it('REFUSES an author who has left the class, and keeps their words readable', () => {
    const left = thread({ actorInForum: false });
    expect(onThread(AUTHOR, 'discussion_thread:update', left).effect).toBe('deny');
    expect(refusal(onThread(AUTHOR, 'discussion_thread:update', left)).disclosure).toBe('reveal');
    // Reading their own post still works: leaving a class does not delete what
    // was said in it, for them or for the people who stayed.
    expect(onThread(AUTHOR, 'discussion_thread:read', left).effect).toBe('allow');
  });

  it('checks the lock BEFORE ownership is rewarded, not after', () => {
    // A locked thread the actor also authored is still locked. If the order
    // were reversed, the author would edit round every lock on the platform.
    const decision = onThread(
      AUTHOR,
      'discussion_thread:update',
      thread({ isLocked: true, moderationStatus: 'hidden' }),
    );
    // Locked is reported first because it is the condition a teacher just
    // applied and the one the author can ask about.
    expect(decision.reason).toContain('locked');
  });
});

describe('discussionThreadPolicy — moderation is staff alone, in three verbs', () => {
  it.each([
    'discussion_thread:pin',
    'discussion_thread:lock',
    'discussion_thread:moderate',
  ] as const)('allows %s to somebody who moderates this class', (action) => {
    expect(onThread(STAFF, action, thread({ actorModerates: true })).effect).toBe('allow');
  });

  it.each([
    'discussion_thread:pin',
    'discussion_thread:lock',
    'discussion_thread:moderate',
  ] as const)('REFUSES %s to the AUTHOR of the thread, with hide', (action) => {
    // Pinning your own question to the top of the class feed is not
    // self-service, and hiding your own thread is not a delete button.
    const decision = onThread(AUTHOR, action, thread());
    expect(decision.effect).toBe('deny');
    expect(refusal(decision).disclosure).toBe('hide');
  });

  it('REFUSES a learner who can plainly see the thread, with hide rather than 403', () => {
    // A 403 would confirm that moderation exists on this object and invite the
    // learner to go looking for the route.
    const decision = onThread(READER, 'discussion_thread:lock', thread());
    expect(refusal(decision).disclosure).toBe('hide');
  });

  it('lets staff moderate a post they could not edit', () => {
    // The moderation branch runs FIRST, before the ownership and lock branches.
    // A teacher must be able to hide a post inside a thread they already locked.
    const decision = onThread(
      STAFF,
      'discussion_thread:moderate',
      thread({ actorModerates: true, isLocked: true, moderationStatus: 'hidden' }),
    );
    expect(decision.effect).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Replies: the same shape, plus a lock overhead and an accept verb
// ---------------------------------------------------------------------------

describe('discussionReplyPolicy — the lock belongs to the room', () => {
  it('REFUSES a new reply in a locked thread, with reveal', () => {
    const decision = onReply(READER, 'discussion_reply:create', reply({ threadIsLocked: true }));
    expect(decision.effect).toBe('deny');
    expect(refusal(decision).disclosure).toBe('reveal');
    expect(decision.reason).toContain('thread_locked');
  });

  it('checks the room BEFORE the lock', () => {
    // An outsider must not learn that a class's thread exists and is locked.
    const decision = onReply(
      READER,
      'discussion_reply:create',
      reply({ actorInForum: false, threadIsLocked: true }),
    );
    expect(refusal(decision).disclosure).toBe('hide');
    expect(decision.reason).toContain('not_in_this_class');
  });

  it('REFUSES the author editing a perfectly fine reply in a locked thread', () => {
    // The reply is not the problem; the room is closed. Carrying
    // `threadIsLocked` separately from the reply's own status is what lets the
    // refusal say so.
    const decision = onReply(
      AUTHOR,
      'discussion_reply:update',
      reply({ threadIsLocked: true, moderationStatus: 'approved' }),
    );
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toContain('thread_locked');
  });

  it('still allows READING inside a locked thread', () => {
    // Locking ends a conversation; it does not delete one.
    expect(onReply(READER, 'discussion_reply:read', reply({ threadIsLocked: true })).effect).toBe(
      'allow',
    );
  });
});

describe('discussionReplyPolicy — accepting an answer', () => {
  it('allows the person who asked the question', () => {
    expect(
      onReply(READER, 'discussion_reply:accept', reply({ actorOwnsThread: true })).effect,
    ).toBe('allow');
  });

  it('REFUSES THE ANSWERER EVEN WHEN THEY ALSO OPENED THE THREAD', () => {
    /**
     * The combination that is awkward to build over HTTP and trivial here: a
     * learner who asks a question, answers it themselves, and then accepts
     * their own answer.
     *
     * The self-check runs BEFORE the ownership branch precisely so the two
     * cannot be combined. The accepted flag means "this resolved it" to
     * everyone who reads the thread later, and a self-award makes the signal
     * worthless.
     */
    const decision = onReply(
      AUTHOR,
      'discussion_reply:accept',
      reply({ actorOwnsThread: true, actorInForum: true }),
    );
    expect(decision.effect).toBe('deny');
    expect(refusal(decision).disclosure).toBe('reveal');
    expect(decision.reason).toContain('no_self_accept');
  });

  it('REFUSES somebody who neither asked nor moderates, with hide', () => {
    const decision = onReply(READER, 'discussion_reply:accept', reply());
    expect(decision.effect).toBe('deny');
    expect(refusal(decision).disclosure).toBe('hide');
  });

  it('allows staff, so a question whose asker left can still be resolved', () => {
    expect(
      onReply(STAFF, 'discussion_reply:accept', reply({ actorModerates: true })).effect,
    ).toBe('allow');
  });

  it('REFUSES the questioner who has left the class', () => {
    // `actorOwnsThread` alone is not enough: the room is still the boundary.
    expect(
      onReply(READER, 'discussion_reply:accept', reply({ actorOwnsThread: true, actorInForum: false }))
        .effect,
    ).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

describe('contentFlagPolicy — the shortest policy with the most at stake', () => {
  it('lets anyone report; the room is decided by the database', () => {
    // The flag's thread is derived from the post being reported, so
    // `content_flags_insert` is what stops a learner filing into a class they
    // are not in. The policy would have nothing to check it against.
    expect(onFlag(READER, 'content_flag:create', flag()).effect).toBe('allow');
    expect(onFlag('anybody', 'content_flag:create', flag()).effect).toBe('allow');
  });

  it('lets the reporter read their own report', () => {
    // A reporting mechanism that swallows reports silently is one children stop
    // using.
    expect(onFlag(READER, 'content_flag:read', flag({ reporterId: READER })).effect).toBe('allow');
  });

  it('lets staff read and review it', () => {
    expect(onFlag(STAFF, 'content_flag:read', flag({ actorModerates: true })).effect).toBe('allow');
    expect(onFlag(STAFF, 'content_flag:review', flag({ actorModerates: true })).effect).toBe(
      'allow',
    );
  });

  it('REFUSES review to the reporter — nobody withdraws a flag', () => {
    // A report that can be retracted can be retracted under pressure, and
    // pressure is what the reporting path exists to survive.
    const decision = onFlag(READER, 'content_flag:review', flag({ reporterId: READER }));
    expect(decision.effect).toBe('deny');
    expect(refusal(decision).disclosure).toBe('hide');
    expect(decision.reason).toContain('not_a_moderator');
  });

  it('REFUSES an automated flag to everybody but staff', () => {
    // `reporterId` is null when the filter raised it, and the reporter branch
    // requires a non-null match. Without that guard every actor whose id
    // happened to be absent would match a null reporter.
    const automated = flag({ reporterId: null });
    for (const actor of [AUTHOR, READER, 'anybody']) {
      expect(onFlag(actor, 'content_flag:read', automated).effect, actor).toBe('deny');
    }
    expect(onFlag(STAFF, 'content_flag:read', flag({ reporterId: null, actorModerates: true })).effect).toBe(
      'allow',
    );
  });

  it('CANNOT BE ASKED ABOUT THE REPORTED AUTHOR AT ALL', () => {
    /**
     * THE ABSENCE THAT IS THE POLICY.
     *
     * `ContentFlagResource` has no `subjectAuthorId`, so there is no branch a
     * future edit could add that tells a child who reported them. On a forum
     * for minors, naming the reporter converts the reporting system into a
     * targeting system: the next thing that happens is retaliation, and the
     * child who reported the bullying learns not to.
     *
     * The author is told their post was actioned — the moderation status is
     * visible to them — and never by whom.
     */
    expect(Object.keys(flag())).not.toContain('subjectAuthorId');
    expect(Object.keys(flag())).not.toContain('subjectOwnerId');
    // And a reader who is neither reporter nor staff gets a hidden denial,
    // which is the same answer a nonexistent flag would produce.
    const decision = onFlag(AUTHOR, 'content_flag:read', flag());
    expect(decision.effect).toBe('deny');
    expect(refusal(decision).disclosure).toBe('hide');
  });
});

// ---------------------------------------------------------------------------
// The properties that hold across all three
// ---------------------------------------------------------------------------

describe('properties that hold for every resource in this domain', () => {
  it('an actor outside the room is allowed nothing on a thread or a reply', () => {
    const outsider = 'outsider-id';
    for (const action of DISCUSSION_THREAD_ACTIONS) {
      const decision = onThread(
        outsider,
        action,
        thread({ actorInForum: false, actorModerates: false }),
      );
      expect(decision.effect, `thread ${action}`).toBe('deny');
    }
    for (const action of DISCUSSION_REPLY_ACTIONS) {
      const decision = onReply(
        outsider,
        action,
        reply({ actorInForum: false, actorModerates: false, actorOwnsThread: false }),
      );
      expect(decision.effect, `reply ${action}`).toBe('deny');
    }
  });

  it('every denial to an outsider hides rather than explains', () => {
    // An outsider must not be able to distinguish "this thread exists and you
    // may not touch it" from "there is no such thread".
    const outsider = 'outsider-id';
    for (const action of DISCUSSION_THREAD_ACTIONS) {
      const decision = onThread(outsider, action, thread({ actorInForum: false }));
      expect(refusal(decision).disclosure, `thread ${action}`).toBe('hide');
    }
  });

  it('every decision names the action and the id it was made about', () => {
    // `unwrap` re-checks both, which is what stops a decision taken about one
    // row being spent on another.
    for (const action of DISCUSSION_THREAD_ACTIONS) {
      const decision = onThread(AUTHOR, action, thread());
      expect(decision.action, action).toBe(action);
      expect(decision.resourceId, action).toBe('thread-id');
    }
  });

  it('every reason is namespaced to its resource kind', () => {
    // A reason string reaches a security event and, for `reveal`, a learner's
    // screen. An unnamespaced one would be ambiguous in both places.
    for (const action of DISCUSSION_THREAD_ACTIONS) {
      expect(onThread(READER, action, thread()).reason).toMatch(/^discussion_thread\./);
    }
    for (const action of DISCUSSION_REPLY_ACTIONS) {
      expect(onReply(READER, action, reply()).reason).toMatch(/^discussion_reply\./);
    }
    for (const action of CONTENT_FLAG_ACTIONS) {
      expect(onFlag(READER, action, flag()).reason).toMatch(/^content_flag\./);
    }
  });
});
