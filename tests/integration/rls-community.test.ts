import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../apps/api/src/platform/db.ts';
import { TEST_APP_URL } from '../setup/env.ts';
import {
  addClassMember,
  assignTeacher,
  closeSeedDb,
  createClass,
  createOrganization,
  createUser,
  grantRole,
  truncateAll,
} from '../setup/fixtures.ts';

/**
 * Row-Level Security for discussion threads, replies and flags.
 *
 * No application code is in the path. Every statement runs as `edu_app`
 * (NOBYPASSRLS, non-owner) with `app.actor_id` set exactly as a request would
 * set it. If the entire policy engine were deleted tomorrow, these are the
 * boundaries that would still hold.
 *
 * THE FIXTURES CREATE ONLY PEOPLE AND CLASSES. Every thread, reply and flag
 * below is written by the application role through the real policies —
 * VULN-042 was an insert policy that refused every legitimate author and
 * survived a whole RLS suite because the fixtures seeded as superuser.
 */
const db: Database = createDatabase({ connectionString: TEST_APP_URL, poolMax: 4 });

afterAll(async () => {
  await db.close();
  await closeSeedDb();
});

beforeEach(truncateAll);

/**
 * Did the statement actually do anything?
 *
 * NOT simply "did it throw". An UPDATE or DELETE excluded by a USING clause
 * does not raise — it matches nothing and reports zero rows. `WITH CHECK`
 * raises; `USING` goes quiet; both are refusals.
 */
async function attempt(actorId: string, sql: string, params: unknown[] = []): Promise<boolean> {
  try {
    const result = await db.withActor(actorId, (tx) => tx.query(sql, params));
    return (result.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

async function rows<T extends Record<string, unknown>>(
  actorId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return db.withActor(actorId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

async function world() {
  const orgA = await createOrganization('School A');
  const orgB = await createOrganization('School B');

  const mk = (email: string, roles?: readonly string[], org: string | null = orgA) =>
    createUser({ email, ...(roles ? { roles } : {}), organizationId: org });

  const learner = await mk('learner@a.test', ['student']);
  const peer = await mk('peer@a.test', ['student']);
  const outsider = await mk('outsider@a.test', ['student']);
  const teacher = await mk('teacher@a.test', ['teacher']);
  const otherTeacher = await mk('other-teacher@a.test', ['teacher']);
  const stranger = await mk('stranger@b.test', ['student'], orgB);
  const admin = await mk('admin@a.test', ['admin']);
  await grantRole(admin.id, 'admin', 'organization', orgA);

  const klass = await createClass(orgA, 'A1');
  const otherClass = await createClass(orgA, 'A2');
  await addClassMember(klass, learner.id);
  await addClassMember(klass, peer.id);
  await addClassMember(otherClass, outsider.id);
  await assignTeacher(teacher.id, klass);
  await assignTeacher(otherTeacher.id, otherClass);

  return { orgA, orgB, klass, otherClass, learner, peer, outsider, teacher, otherTeacher, stranger, admin };
}

/** A thread written BY the actor THROUGH `edu_app`. */
async function insertThread(
  actorId: string,
  classId: string,
  options: { status?: string; title?: string } = {},
): Promise<string> {
  const [row] = await rows<{ id: string }>(
    actorId,
    `INSERT INTO discussion_threads
       (class_id, organization_id, author_id, title, content_markdown, moderation_status)
     VALUES ($1, NULL, $2, $3, 'A body long enough to be real.', $4) RETURNING id`,
    [classId, actorId, options.title ?? 'A question', options.status ?? 'approved'],
  );
  if (!row) throw new Error('the thread was refused by RLS or a trigger');
  return row.id;
}

async function insertReply(
  actorId: string,
  threadId: string,
  parentId: string | null = null,
): Promise<string | null> {
  try {
    const [row] = await rows<{ id: string }>(
      actorId,
      `INSERT INTO discussion_replies
         (thread_id, class_id, parent_reply_id, author_id, content_markdown)
       VALUES ($1, '00000000-0000-0000-0000-000000000000', $2, $3, 'A reply.') RETURNING id`,
      [threadId, parentId, actorId],
    );
    return row?.id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

describe('an author writes through the application role', () => {
  it('creates a thread and a reply as edu_app', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    expect(await rows(w.learner.id, 'SELECT id FROM discussion_threads')).toHaveLength(1);
    expect(await insertReply(w.peer.id, thread)).not.toBeNull();
  });

  it('has class_id derived from the thread, not from the caller', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    await insertReply(w.peer.id, thread);
    const [reply] = await rows<{ class_id: string }>(
      w.peer.id,
      'SELECT class_id FROM discussion_replies',
    );
    expect(reply?.class_id).toBe(w.klass);
  });

  it('has organization_id derived from the class', async () => {
    const w = await world();
    await insertThread(w.learner.id, w.klass);
    const [thread] = await rows<{ organization_id: string }>(
      w.learner.id,
      'SELECT organization_id FROM discussion_threads',
    );
    expect(thread?.organization_id).toBe(w.orgA);
  });

  it('refuses a thread whose author is somebody else', async () => {
    const w = await world();
    expect(
      await attempt(
        w.peer.id,
        `INSERT INTO discussion_threads (class_id, organization_id, author_id, title, content_markdown)
         VALUES ($1, NULL, $2, 'Forged', 'body')`,
        [w.klass, w.learner.id],
      ),
    ).toBe(false);
  });

  it('refuses a thread born pinned or locked', async () => {
    const w = await world();
    for (const column of ['is_pinned', 'is_locked']) {
      expect(
        await attempt(
          w.learner.id,
          `INSERT INTO discussion_threads
             (class_id, organization_id, author_id, title, content_markdown, ${column})
           VALUES ($1, NULL, $2, 'Self-managed', 'body', true)`,
          [w.klass, w.learner.id],
        ),
        column,
      ).toBe(false);
    }
  });

  it('refuses a thread born hidden', async () => {
    const w = await world();
    expect(
      await attempt(
        w.learner.id,
        `INSERT INTO discussion_threads
           (class_id, organization_id, author_id, title, content_markdown, moderation_status)
         VALUES ($1, NULL, $2, 'Prehidden', 'body', 'hidden')`,
        [w.klass, w.learner.id],
      ),
    ).toBe(false);
  });
});

describe('the class is the boundary', () => {
  it('a classmate reads it; another class and another school do not', async () => {
    const w = await world();
    await insertThread(w.learner.id, w.klass);
    expect(await rows(w.peer.id, 'SELECT id FROM discussion_threads')).toHaveLength(1);
    expect(await rows(w.outsider.id, 'SELECT id FROM discussion_threads')).toHaveLength(0);
    expect(await rows(w.stranger.id, 'SELECT id FROM discussion_threads')).toHaveLength(0);
  });

  it('the class teacher reads it; a teacher of another class does not', async () => {
    const w = await world();
    await insertThread(w.learner.id, w.klass);
    expect(await rows(w.teacher.id, 'SELECT id FROM discussion_threads')).toHaveLength(1);
    expect(await rows(w.otherTeacher.id, 'SELECT id FROM discussion_threads')).toHaveLength(0);
  });

  it('an organization admin reads it', async () => {
    const w = await world();
    await insertThread(w.learner.id, w.klass);
    expect(await rows(w.admin.id, 'SELECT id FROM discussion_threads')).toHaveLength(1);
  });

  it('refuses posting into a class the actor is not in, in either school', async () => {
    const w = await world();
    for (const actor of [w.outsider, w.stranger]) {
      expect(
        await attempt(
          actor.id,
          `INSERT INTO discussion_threads (class_id, organization_id, author_id, title, content_markdown)
           VALUES ($1, NULL, $2, 'Intruder', 'body')`,
          [w.klass, actor.id],
        ),
        actor.id,
      ).toBe(false);
    }
  });

  it('refuses replying from outside the class', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    expect(await insertReply(w.outsider.id, thread)).toBeNull();
    expect(await insertReply(w.stranger.id, thread)).toBeNull();
  });

  it('a departed learner loses the room and keeps their words', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    const reply = await insertReply(w.peer.id, thread);
    expect(reply).not.toBeNull();

    // THE TEACHER ENDS THE MEMBERSHIP, not a bare `withoutActor` UPDATE.
    // `class_memberships_update` (migration 0014) restricts removal to somebody
    // who teaches the class or administers the school, and its USING clause
    // goes QUIET rather than raising: with no actor set the statement matches
    // no row, the roster is untouched, and a test that did not check the row
    // count would have gone on to assert against a learner who never left.
    // That is exactly the shape of VULN-042 — a fixture that did not do what it
    // claimed — so the removal is driven through the real policy and asserted.
    expect(
      await attempt(
        w.teacher.id,
        `UPDATE class_memberships SET status='ended', ended_at=now()
          WHERE class_id=$1 AND user_id=$2`,
        [w.klass, w.peer.id],
      ),
    ).toBe(true);

    expect(await rows(w.peer.id, 'SELECT id FROM discussion_threads')).toHaveLength(0);
    expect(await insertReply(w.peer.id, thread)).toBeNull();
    // Their reply is still in the thread for everybody who stayed.
    expect(await rows(w.learner.id, 'SELECT id FROM discussion_replies')).toHaveLength(1);
  });
});

describe('the reply tree cannot cross a thread', () => {
  it('nests within one thread', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    const first = await insertReply(w.peer.id, thread);
    expect(await insertReply(w.learner.id, thread, first)).not.toBeNull();
  });

  it('REFUSES a parent that lives in another class’s thread', async () => {
    // The composite foreign key. Every policy would admit this row.
    const w = await world();
    const mine = await insertThread(w.learner.id, w.klass);
    const theirs = await insertThread(w.outsider.id, w.otherClass);
    const theirReply = await insertReply(w.outsider.id, theirs);
    expect(theirReply).not.toBeNull();

    expect(await insertReply(w.learner.id, mine, theirReply)).toBeNull();
  });

  it('refuses a parent in another thread of the SAME class', async () => {
    const w = await world();
    const first = await insertThread(w.learner.id, w.klass, { title: 'One' });
    const second = await insertThread(w.learner.id, w.klass, { title: 'Two' });
    const replyInFirst = await insertReply(w.peer.id, first);
    expect(await insertReply(w.peer.id, second, replyInFirst)).toBeNull();
  });

  it('deleting a reply takes its subtree', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    const root = await insertReply(w.peer.id, thread);
    const child = await insertReply(w.peer.id, thread, root);
    expect(child).not.toBeNull();

    expect(
      await attempt(w.peer.id, 'DELETE FROM discussion_replies WHERE id = $1', [root]),
    ).toBe(true);
    expect(await rows(w.learner.id, 'SELECT id FROM discussion_replies')).toHaveLength(0);
  });
});

describe('the locked-thread enforcer', () => {
  it('refuses every new reply once locked, and permits them again after', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);

    expect(
      await attempt(w.teacher.id, 'UPDATE discussion_threads SET is_locked = true WHERE id = $1', [
        thread,
      ]),
    ).toBe(true);
    expect(await insertReply(w.peer.id, thread)).toBeNull();

    await attempt(w.teacher.id, 'UPDATE discussion_threads SET is_locked = false WHERE id = $1', [
      thread,
    ]);
    expect(await insertReply(w.peer.id, thread)).not.toBeNull();
  });

  it('refuses the author editing or deleting while locked', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    const reply = await insertReply(w.peer.id, thread);
    await attempt(w.teacher.id, 'UPDATE discussion_threads SET is_locked = true WHERE id = $1', [
      thread,
    ]);

    expect(
      await attempt(w.learner.id, `UPDATE discussion_threads SET title = 'Edited' WHERE id = $1`, [
        thread,
      ]),
    ).toBe(false);
    expect(
      await attempt(w.peer.id, `UPDATE discussion_replies SET content_markdown = 'E' WHERE id = $1`, [
        reply,
      ]),
    ).toBe(false);
    expect(
      await attempt(w.peer.id, 'DELETE FROM discussion_replies WHERE id = $1', [reply]),
    ).toBe(false);
  });

  it('the AUTHOR cannot unlock their own thread', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    await attempt(w.teacher.id, 'UPDATE discussion_threads SET is_locked = true WHERE id = $1', [
      thread,
    ]);
    await attempt(w.learner.id, 'UPDATE discussion_threads SET is_locked = false WHERE id = $1', [
      thread,
    ]);
    const [row] = await rows<{ is_locked: boolean }>(
      w.learner.id,
      'SELECT is_locked FROM discussion_threads WHERE id = $1',
      [thread],
    );
    expect(row?.is_locked).toBe(true);
  });

  it('a locked thread stays readable', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    await insertReply(w.peer.id, thread);
    await attempt(w.teacher.id, 'UPDATE discussion_threads SET is_locked = true WHERE id = $1', [
      thread,
    ]);
    expect(await rows(w.peer.id, 'SELECT id FROM discussion_threads')).toHaveLength(1);
    expect(await rows(w.peer.id, 'SELECT id FROM discussion_replies')).toHaveLength(1);
  });
});

describe('what a moderator may change', () => {
  it('may pin, lock and hide; may NOT rewrite or retitle', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);

    expect(
      await attempt(
        w.teacher.id,
        `UPDATE discussion_threads SET is_pinned = true, moderation_status = 'hidden' WHERE id = $1`,
        [thread],
      ),
    ).toBe(true);
    expect(
      await attempt(
        w.teacher.id,
        `UPDATE discussion_threads SET content_markdown = 'Teacher wrote this' WHERE id = $1`,
        [thread],
      ),
    ).toBe(false);
    expect(
      await attempt(w.teacher.id, `UPDATE discussion_threads SET title = 'Retitled' WHERE id = $1`, [
        thread,
      ]),
    ).toBe(false);
  });

  it('a classmate cannot moderate anything', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    for (const sql of [
      `UPDATE discussion_threads SET is_pinned = true WHERE id = $1`,
      `UPDATE discussion_threads SET is_locked = true WHERE id = $1`,
      `UPDATE discussion_threads SET moderation_status = 'hidden' WHERE id = $1`,
    ]) {
      expect(await attempt(w.peer.id, sql, [thread]), sql).toBe(false);
    }
  });

  it('a teacher of another class cannot moderate here', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    expect(
      await attempt(
        w.otherTeacher.id,
        `UPDATE discussion_threads SET moderation_status = 'hidden' WHERE id = $1`,
        [thread],
      ),
    ).toBe(false);
  });
});

describe('hidden and flagged posts', () => {
  it('a hidden thread is invisible to classmates, visible to its author and staff', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    await attempt(
      w.teacher.id,
      `UPDATE discussion_threads SET moderation_status = 'hidden' WHERE id = $1`,
      [thread],
    );

    expect(await rows(w.peer.id, 'SELECT id FROM discussion_threads')).toHaveLength(0);
    expect(await rows(w.learner.id, 'SELECT id FROM discussion_threads')).toHaveLength(1);
    expect(await rows(w.teacher.id, 'SELECT id FROM discussion_threads')).toHaveLength(1);
  });

  it('a FLAGGED thread behaves the same way', async () => {
    const w = await world();
    await insertThread(w.learner.id, w.klass, { status: 'flagged' });
    expect(await rows(w.peer.id, 'SELECT id FROM discussion_threads')).toHaveLength(0);
    expect(await rows(w.learner.id, 'SELECT id FROM discussion_threads')).toHaveLength(1);
    expect(await rows(w.teacher.id, 'SELECT id FROM discussion_threads')).toHaveLength(1);
  });

  it('the author cannot edit a hidden post, and cannot un-hide it', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    await attempt(
      w.teacher.id,
      `UPDATE discussion_threads SET moderation_status = 'hidden' WHERE id = $1`,
      [thread],
    );
    expect(
      await attempt(
        w.learner.id,
        `UPDATE discussion_threads SET content_markdown = 'Rewritten' WHERE id = $1`,
        [thread],
      ),
    ).toBe(false);
    expect(
      await attempt(
        w.learner.id,
        `UPDATE discussion_threads SET moderation_status = 'approved' WHERE id = $1`,
        [thread],
      ),
    ).toBe(false);
  });

  it('a hidden REPLY drops out for others and stays for its author', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    const reply = await insertReply(w.peer.id, thread);
    await attempt(
      w.teacher.id,
      `UPDATE discussion_replies SET moderation_status = 'hidden' WHERE id = $1`,
      [reply],
    );
    expect(await rows(w.learner.id, 'SELECT id FROM discussion_replies')).toHaveLength(0);
    expect(await rows(w.peer.id, 'SELECT id FROM discussion_replies')).toHaveLength(1);
  });
});

describe('accepting an answer', () => {
  it('the questioner may; the answerer may not', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    const reply = await insertReply(w.peer.id, thread);

    expect(
      await attempt(
        w.peer.id,
        'UPDATE discussion_replies SET is_accepted_answer = true WHERE id = $1',
        [reply],
      ),
    ).toBe(false);
    expect(
      await attempt(
        w.learner.id,
        'UPDATE discussion_replies SET is_accepted_answer = true WHERE id = $1',
        [reply],
      ),
    ).toBe(true);
  });

  it('at most one accepted answer per thread', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    const first = await insertReply(w.peer.id, thread);
    const second = await insertReply(w.peer.id, thread);
    await attempt(
      w.learner.id,
      'UPDATE discussion_replies SET is_accepted_answer = true WHERE id = $1',
      [first],
    );
    // The partial unique index refuses the second while the first stands.
    expect(
      await attempt(
        w.learner.id,
        'UPDATE discussion_replies SET is_accepted_answer = true WHERE id = $1',
        [second],
      ),
    ).toBe(false);
  });

  it('a reply born claiming acceptance is written, with the claim dropped', async () => {
    // NOT a refusal, and the difference is deliberate. `discussion_reply_guard`
    // pins `is_accepted_answer := false` on every INSERT rather than raising,
    // so the row is created and only the self-awarded badge is discarded.
    //
    // Refusing the whole statement would be the worse behaviour: a learner who
    // posted a genuine answer through a client that happened to send the column
    // would lose their writing to an error about a field they never chose. The
    // control that matters is that NOBODY IS ACCEPTED BY SELF-ASSERTION, and
    // that holds either way — acceptance can then only arrive through the
    // UPDATE path above, where the guard requires the questioner or staff.
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    const [row] = await rows<{ id: string; is_accepted_answer: boolean }>(
      w.peer.id,
      `INSERT INTO discussion_replies
         (thread_id, class_id, author_id, content_markdown, is_accepted_answer)
       VALUES ($1, '00000000-0000-0000-0000-000000000000', $2, 'Mine', true)
       RETURNING id, is_accepted_answer`,
      [thread, w.peer.id],
    );
    expect(row).toBeDefined();
    expect(row?.is_accepted_answer).toBe(false);
  });
});

describe('flags', () => {
  async function flag(actorId: string, entityId: string, type = 'thread'): Promise<boolean> {
    return attempt(
      actorId,
      `INSERT INTO content_flags (entity_type, entity_id, thread_id, reason)
       VALUES ($1, $2, '00000000-0000-0000-0000-000000000000', 'A reason.')`,
      [type, entityId],
    );
  }

  it('a member of the room reports; the reporter and thread are derived', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    expect(await flag(w.peer.id, thread)).toBe(true);

    const [row] = await rows<{ reporter_id: string; thread_id: string; organization_id: string }>(
      w.peer.id,
      'SELECT reporter_id, thread_id, organization_id FROM content_flags',
    );
    expect(row?.reporter_id).toBe(w.peer.id);
    expect(row?.thread_id).toBe(thread);
    expect(row?.organization_id).toBe(w.orgA);
  });

  it('the same person cannot report the same post twice', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    expect(await flag(w.peer.id, thread)).toBe(true);
    expect(await flag(w.peer.id, thread)).toBe(false);
  });

  it('the reported author never sees the flag', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    await flag(w.peer.id, thread);
    expect(await rows(w.learner.id, 'SELECT id FROM content_flags')).toHaveLength(0);
  });

  it('the reporter and the class teacher see it; nobody else does', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    await flag(w.peer.id, thread);
    expect(await rows(w.peer.id, 'SELECT id FROM content_flags')).toHaveLength(1);
    expect(await rows(w.teacher.id, 'SELECT id FROM content_flags')).toHaveLength(1);
    expect(await rows(w.otherTeacher.id, 'SELECT id FROM content_flags')).toHaveLength(0);
    expect(await rows(w.stranger.id, 'SELECT id FROM content_flags')).toHaveLength(0);
  });

  it('a reporter cannot close their own flag; a teacher can', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    await flag(w.peer.id, thread);
    expect(
      await attempt(w.peer.id, `UPDATE content_flags SET status = 'dismissed'`),
    ).toBe(false);
    expect(
      await attempt(w.teacher.id, `UPDATE content_flags SET status = 'reviewed'`),
    ).toBe(true);
  });

  it('NOBODY may delete a flag — there is no grant and no policy', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    await flag(w.peer.id, thread);
    for (const actor of [w.peer, w.teacher, w.admin, w.learner]) {
      expect(await attempt(actor.id, 'DELETE FROM content_flags'), actor.id).toBe(false);
    }
    expect(await rows(w.teacher.id, 'SELECT id FROM content_flags')).toHaveLength(1);
  });

  it('deleting a reported REPLY removes its flags, and does not fail', async () => {
    // The cleanup trigger. Written first as invoker-rights, it raised
    // permission denied and made any reported reply undeletable by its author —
    // report-to-freeze. It is SECURITY DEFINER now.
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    const reply = await insertReply(w.peer.id, thread);
    expect(await flag(w.learner.id, reply as string, 'reply')).toBe(true);

    expect(
      await attempt(w.peer.id, 'DELETE FROM discussion_replies WHERE id = $1', [reply]),
    ).toBe(true);
    expect(await rows(w.teacher.id, 'SELECT id FROM content_flags')).toHaveLength(0);
  });

  it('deleting a thread takes its flags through the foreign key', async () => {
    const w = await world();
    const thread = await insertThread(w.learner.id, w.klass);
    await flag(w.peer.id, thread);
    expect(
      await attempt(w.learner.id, 'DELETE FROM discussion_threads WHERE id = $1', [thread]),
    ).toBe(true);
    expect(await rows(w.teacher.id, 'SELECT id FROM content_flags')).toHaveLength(0);
  });
});
