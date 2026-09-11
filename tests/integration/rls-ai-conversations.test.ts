import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../apps/api/src/platform/db.ts';
import { TEST_APP_URL } from '../setup/env.ts';
import {
  addClassMember,
  assignCourseToClass,
  assignTeacher,
  closeSeedDb,
  createClass,
  createCourse,
  createCurriculum,
  createEducationLevel,
  createLesson,
  createOrganization,
  createUnit,
  createUser,
  seedDb,
  truncateAll,
} from '../setup/fixtures.ts';

/**
 * Row-Level Security for AI tutor conversations.
 *
 * NO APPLICATION CODE IS IN THE PATH. Every statement runs as `edu_app`
 * (NOBYPASSRLS, non-owner) with `app.actor_id` set exactly as a request would.
 * If the whole tutor module were deleted tomorrow, these are the boundaries
 * that would still hold.
 *
 * This file is the permanent form of the adversarial probe that was run against
 * migration 0027 before any application code existed. That probe found three
 * real defects — a SECURITY DEFINER ownership helper that answered NULL for
 * every row, a refusal that leaked whether a stranger's conversation had any
 * messages, and revocation that never reached an already-open conversation —
 * and each of them has a named test below so it cannot come back quietly.
 */
const db: Database = createDatabase({ connectionString: TEST_APP_URL, poolMax: 4 });

interface World {
  orgA: string;
  orgB: string;
  learnerA: string;
  learnerA2: string;
  learnerB: string;
  teacherA: string;
  teacherUnrelated: string;
  adminA: string;
  moderatorA: string;
  moderatorB: string;
  lessonA: string;
  lessonB: string;
  draftLessonA: string;
  classA: string;
}

/** Two schools, each with a learner, plus the four kinds of adult. */
async function world(): Promise<World> {
  const orgA = await createOrganization('RLS Tutor School A');
  const orgB = await createOrganization('RLS Tutor School B');
  const level = await createEducationLevel('rls_tutor');

  const mk = async (email: string, org: string, roles?: string[]): Promise<string> => {
    const user = await createUser({ email, organizationId: org, ...(roles ? { roles } : {}) });
    return user.id;
  };

  const learnerA = await mk('rls-tutor-a@test.local', orgA);
  const learnerA2 = await mk('rls-tutor-a2@test.local', orgA);
  const learnerB = await mk('rls-tutor-b@test.local', orgB);
  const teacherA = await mk('rls-tutor-teacher@test.local', orgA, ['teacher']);
  const teacherUnrelated = await mk('rls-tutor-teacher2@test.local', orgA, ['teacher']);
  const adminA = await mk('rls-tutor-admin@test.local', orgA, ['admin']);
  const moderatorA = await mk('rls-tutor-mod@test.local', orgA, ['moderator']);
  const moderatorB = await mk('rls-tutor-mod-b@test.local', orgB, ['moderator']);

  const build = async (org: string, code: string) => {
    const curriculumId = await createCurriculum({ organizationId: org, code, status: 'published' });
    const courseId = await createCourse({
      organizationId: org,
      curriculumId,
      levelId: level,
      title: `${code} course`,
      status: 'published',
    });
    const unitId = await createUnit({ courseId, status: 'published' });
    const lessonId = await createLesson({ unitId, title: `${code} lesson`, status: 'published' });
    return { courseId, unitId, lessonId };
  };

  const a = await build(orgA, 'rta');
  const b = await build(orgB, 'rtb');
  const draftLessonA = await createLesson({
    unitId: a.unitId,
    title: 'Draft lesson',
    status: 'draft',
    position: 2,
  });

  const classA = await createClass(orgA, 'RLS Tutor Class A');
  await addClassMember(classA, learnerA);
  await addClassMember(classA, learnerA2);
  await assignCourseToClass({ classId: classA, courseId: a.courseId });
  await assignTeacher(teacherA, classA);

  const classB = await createClass(orgB, 'RLS Tutor Class B');
  await addClassMember(classB, learnerB);
  await assignCourseToClass({ classId: classB, courseId: b.courseId });

  return {
    orgA,
    orgB,
    learnerA,
    learnerA2,
    learnerB,
    teacherA,
    teacherUnrelated,
    adminA,
    moderatorA,
    moderatorB,
    lessonA: a.lessonId,
    lessonB: b.lessonId,
    draftLessonA,
    classA,
  };
}

/** Starts a conversation AS the learner, through the real write path. */
async function startAs(actorId: string, lessonId: string, title = 'Conversation'): Promise<string> {
  return db.withActor(actorId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO ai_conversations (student_id, lesson_id, course_id, title)
       VALUES ($1, $2, $2, $3) RETURNING id`,
      [actorId, lessonId, title],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('no conversation id');
    return id;
  });
}

async function sayAs(actorId: string, conversationId: string, text: string): Promise<void> {
  await db.withActor(actorId, async (tx) => {
    await tx.query(
      `INSERT INTO ai_messages (conversation_id, owner_id, sender_type, content_text)
       VALUES ($1, $2, 'student', $3)`,
      [conversationId, actorId, text],
    );
  });
}

const countConversations = (actorId: string): Promise<number> =>
  db.withActor(actorId, async (tx) => {
    const { rows } = await tx.query<{ n: string }>('SELECT count(*) AS n FROM ai_conversations');
    return Number(rows[0]?.n ?? 0);
  });

const countMessages = (actorId: string): Promise<number> =>
  db.withActor(actorId, async (tx) => {
    const { rows } = await tx.query<{ n: string }>('SELECT count(*) AS n FROM ai_messages');
    return Number(rows[0]?.n ?? 0);
  });

beforeEach(truncateAll);

afterAll(async () => {
  await db.close();
  await closeSeedDb();
});

describe('creating a conversation', () => {
  it('works for a lesson the learner is currently studying', async () => {
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);
    expect(id).toBeTruthy();
  });

  it('DERIVES the course rather than trusting the one supplied', async () => {
    // The insert above passes `lesson_id` in the `course_id` position on
    // purpose. Two ids supplied independently are two answers to "what is this
    // conversation about", and they can disagree; one accepted and one derived
    // cannot.
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);

    const seed = await seedDb();
    const { rows } = await seed.query<{ course_id: string; organization_id: string }>(
      'SELECT course_id, organization_id FROM ai_conversations WHERE id = $1',
      [id],
    );
    expect(rows[0]?.course_id).not.toBe(w.lessonA);
    expect(rows[0]?.organization_id).toBe(w.orgA);
  });

  it('refuses a conversation owned by somebody else', async () => {
    const w = await world();
    await expect(
      db.withActor(w.learnerA, (tx) =>
        tx.query(
          `INSERT INTO ai_conversations (student_id, lesson_id, course_id, title)
           VALUES ($1, $2, $2, 'forged')`,
          [w.learnerA2, w.lessonA],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses another school’s lesson', async () => {
    const w = await world();
    await expect(startAs(w.learnerA, w.lessonB)).rejects.toThrow();
  });

  it('refuses a draft lesson in the learner’s own course', async () => {
    const w = await world();
    await expect(startAs(w.learnerA, w.draftLessonA)).rejects.toThrow();
  });

  it('refuses a learner in no class at all', async () => {
    const w = await world();
    const outsider = await createUser({
      email: 'rls-tutor-outsider@test.local',
      organizationId: w.orgA,
    });
    await expect(startAs(outsider.id, w.lessonA)).rejects.toThrow();
  });
});

describe('the anchor and the owner are immutable', () => {
  it('refuses re-anchoring to another lesson', async () => {
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);
    await expect(
      db.withActor(w.learnerA, (tx) =>
        tx.query('UPDATE ai_conversations SET lesson_id = $2 WHERE id = $1', [id, w.lessonB]),
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it('refuses giving a conversation away', async () => {
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);
    await expect(
      db.withActor(w.learnerA, (tx) =>
        tx.query('UPDATE ai_conversations SET student_id = $2 WHERE id = $1', [id, w.learnerA2]),
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it('allows the owner to rename and archive', async () => {
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);
    await db.withActor(w.learnerA, async (tx) => {
      await tx.query(`UPDATE ai_conversations SET title = 'Renamed' WHERE id = $1`, [id]);
      await tx.query(`UPDATE ai_conversations SET status = 'archived' WHERE id = $1`, [id]);
    });
    const seed = await seedDb();
    const { rows } = await seed.query<{ title: string; status: string }>(
      'SELECT title, status FROM ai_conversations WHERE id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ title: 'Renamed', status: 'archived' });
  });
});

describe('messages: ownership, forgery and the transcript', () => {
  it('lets the owner append their own turn, with a database-assigned position', async () => {
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);

    // `seq` is supplied and IGNORED. A client-chosen position would let a
    // learner insert a turn between two existing ones and rewrite the order of
    // a conversation an adult may later read.
    await db.withActor(w.learnerA, (tx) =>
      tx.query(
        `INSERT INTO ai_messages (conversation_id, owner_id, sender_type, content_text, seq)
         VALUES ($1, $2, 'student', 'first', 99)`,
        [id, w.learnerA],
      ),
    );
    const seed = await seedDb();
    const { rows } = await seed.query<{ seq: number }>(
      'SELECT seq FROM ai_messages WHERE conversation_id = $1',
      [id],
    );
    expect(rows[0]?.seq).toBe(1);
  });

  it('REFUSES A FORGED TUTOR TURN through the ordinary insert path', async () => {
    // The attack this stops: a child fabricating a transcript in which the
    // school's assistant told them something it never said. Against a homework
    // dispute or a safeguarding review, a forged transcript is a serious thing.
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);
    await expect(
      db.withActor(w.learnerA, (tx) =>
        tx.query(
          `INSERT INTO ai_messages (conversation_id, owner_id, sender_type, content_text)
           VALUES ($1, $2, 'ai_tutor', 'I told you the answer was 42')`,
          [id, w.learnerA],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('admits a tutor turn ONLY after the named marker, and only for that conversation', async () => {
    const w = await world();
    const first = await startAs(w.learnerA, w.lessonA, 'First');
    const second = await startAs(w.learnerA, w.lessonA, 'Second');

    await db.withActor(w.learnerA, async (tx) => {
      await tx.query('SELECT ai_begin_platform_turn($1)', [first]);
      await tx.query(
        `INSERT INTO ai_messages (conversation_id, owner_id, sender_type, content_text)
         VALUES ($1, $2, 'ai_tutor', 'A cell is...')`,
        [first, w.learnerA],
      );
    });
    expect(await countMessages(w.learnerA)).toBe(1);

    // MARKING ONE CONVERSATION DOES NOT OPEN THE OTHERS.
    await expect(
      db.withActor(w.learnerA, async (tx) => {
        await tx.query('SELECT ai_begin_platform_turn($1)', [first]);
        await tx.query(
          `INSERT INTO ai_messages (conversation_id, owner_id, sender_type, content_text)
           VALUES ($1, $2, 'ai_tutor', 'wrong conversation')`,
          [second, w.learnerA],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('does NOT let the marker survive into a later transaction', async () => {
    // `set_config(..., true)` is transaction-local. A session-level setting
    // would leak across a pooled connection into the next request, which would
    // hand the forgery gate to whoever borrowed the connection next.
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);
    await db.withActor(w.learnerA, (tx) => tx.query('SELECT ai_begin_platform_turn($1)', [id]));

    await expect(
      db.withActor(w.learnerA, (tx) =>
        tx.query(
          `INSERT INTO ai_messages (conversation_id, owner_id, sender_type, content_text)
           VALUES ($1, $2, 'ai_tutor', 'marker leaked?')`,
          [id, w.learnerA],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('REFUSES A PEER IDENTICALLY WHETHER OR NOT THE CONVERSATION HAS MESSAGES', async () => {
    // The oracle the probe found. `seq` was computed as max()+1 under the
    // CALLER'S row security, so a stranger saw no rows, computed seq = 1, and
    // got "duplicate key" when the conversation already had a first message and
    // a row-security refusal when it did not. Any authenticated user holding a
    // conversation id could tell an empty conversation from a used one, in
    // another class or another school.
    const w = await world();
    const empty = await startAs(w.learnerA, w.lessonA, 'Empty');
    const used = await startAs(w.learnerA, w.lessonA, 'Used');
    await sayAs(w.learnerA, used, 'a first message');

    const intrude = (conversationId: string): Promise<unknown> =>
      db.withActor(w.learnerA2, (tx) =>
        tx.query(
          `INSERT INTO ai_messages (conversation_id, owner_id, sender_type, content_text)
           VALUES ($1, $2, 'student', 'peeking')`,
          [conversationId, w.learnerA2],
        ),
      );

    const emptyError = await intrude(empty).catch((error: Error) => error.message);
    const usedError = await intrude(used).catch((error: Error) => error.message);

    expect(emptyError).toBe(usedError);
    expect(String(emptyError)).toMatch(/only append to your own conversation/i);
  });

  it('refuses a claimed owner_id that is not the conversation’s owner', async () => {
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);
    await expect(
      db.withActor(w.learnerA, (tx) =>
        tx.query(
          `INSERT INTO ai_messages (conversation_id, owner_id, sender_type, content_text)
           VALUES ($1, $2, 'student', 'wrong owner')`,
          [id, w.learnerA2],
        ),
      ),
    ).rejects.toThrow(/only append to your own conversation/i);
  });

  it('grants NO update and NO delete on messages, to anybody', async () => {
    // A transcript that can be edited after the fact is not a moderation
    // record; it is a draft.
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);
    await sayAs(w.learnerA, id, 'said once');

    await expect(
      db.withActor(w.learnerA, (tx) =>
        tx.query(`UPDATE ai_messages SET content_text = 'rewritten'`),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      db.withActor(w.learnerA, (tx) => tx.query('DELETE FROM ai_messages')),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('revocation reaches an already-open conversation', () => {
  it('STOPS THE LEARNER TALKING once they leave the class', async () => {
    // The third probe finding. Creation asked `app_actor_may_study_lesson`;
    // nothing re-asked it, so a learner removed from a class mid-term could
    // carry on adding turns to a conversation opened in September.
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);
    await sayAs(w.learnerA, id, 'while enrolled');

    const seed = await seedDb();
    await seed.query(
      `UPDATE class_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1`,
      [w.learnerA],
    );

    await expect(sayAs(w.learnerA, id, 'after leaving')).rejects.toThrow(/no longer studying/i);
  });

  it('but LEAVES THEM their own history, readable and tidyable', async () => {
    // Revocation takes away the ability to keep talking, not the record of
    // having talked. A learner keeps their own history when a course ends.
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);
    await sayAs(w.learnerA, id, 'while enrolled');

    const seed = await seedDb();
    await seed.query(
      `UPDATE class_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1`,
      [w.learnerA],
    );

    expect(await countConversations(w.learnerA)).toBe(1);
    expect(await countMessages(w.learnerA)).toBe(1);
    await db.withActor(w.learnerA, (tx) =>
      tx.query(`UPDATE ai_conversations SET status = 'archived' WHERE id = $1`, [id]),
    );
  });
});

describe('who may read a transcript', () => {
  it('the owner, always', async () => {
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);
    await sayAs(w.learnerA, id, 'mine');
    expect(await countConversations(w.learnerA)).toBe(1);
    expect(await countMessages(w.learnerA)).toBe(1);
  });

  it('NOT a classmate, even in the same class and the same lesson', async () => {
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);
    await sayAs(w.learnerA, id, 'mine');
    expect(await countConversations(w.learnerA2)).toBe(0);
    expect(await countMessages(w.learnerA2)).toBe(0);
  });

  it('the teacher who actually teaches this learner this lesson', async () => {
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);
    await sayAs(w.learnerA, id, 'mine');
    expect(await countConversations(w.teacherA)).toBe(1);
    expect(await countMessages(w.teacherA)).toBe(1);
  });

  it('NOT another teacher in the same school who teaches nobody here', async () => {
    // The narrow reading of "within their organization boundary": the
    // organization is the ceiling, not the grant.
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);
    await sayAs(w.learnerA, id, 'mine');
    expect(await countConversations(w.teacherUnrelated)).toBe(0);
  });

  it('an organization administrator, within their own school', async () => {
    const w = await world();
    await startAs(w.learnerA, w.lessonA);
    expect(await countConversations(w.adminA)).toBe(1);
  });

  it('a safety moderator, within their own school', async () => {
    const w = await world();
    await startAs(w.learnerA, w.lessonA);
    expect(await countConversations(w.moderatorA)).toBe(1);
  });

  it('NOT a moderator of another school, on either table', async () => {
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);
    await sayAs(w.learnerA, id, 'mine');
    expect(await countConversations(w.moderatorB)).toBe(0);
    expect(await countMessages(w.moderatorB)).toBe(0);
  });

  it('NOT a learner in another school', async () => {
    const w = await world();
    await startAs(w.learnerA, w.lessonA);
    expect(await countConversations(w.learnerB)).toBe(0);
  });

  it('nobody at all with no actor set', async () => {
    const w = await world();
    await startAs(w.learnerA, w.lessonA);
    // `withoutActor` is the same connection shape a request would use before
    // authentication had established who is asking. Under RLS that must see
    // nothing, which is what makes `app.actor_id` load-bearing rather than
    // decorative.
    const visible = await db.withoutActor(async (tx) => {
      const { rows } = await tx.query<{ n: string }>('SELECT count(*) AS n FROM ai_conversations');
      return Number(rows[0]?.n ?? -1);
    });
    expect(visible).toBe(0);
  });
});

describe('adults may read but never write', () => {
  it('a teacher cannot archive, rename or delete a conversation', async () => {
    // Reading a transcript is oversight; editing one is tampering. A moderator
    // who could archive a conversation could hide it from the next moderator.
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);

    await db.withActor(w.teacherA, async (tx) => {
      const archived = await tx.query(
        `UPDATE ai_conversations SET status = 'archived' WHERE id = $1`,
        [id],
      );
      expect(archived.rowCount).toBe(0);
      const deleted = await tx.query('DELETE FROM ai_conversations WHERE id = $1', [id]);
      expect(deleted.rowCount).toBe(0);
    });

    const seed = await seedDb();
    const { rows } = await seed.query<{ status: string }>(
      'SELECT status FROM ai_conversations WHERE id = $1',
      [id],
    );
    expect(rows[0]?.status).toBe('active');
  });

  it('a moderator cannot append a message either', async () => {
    const w = await world();
    const id = await startAs(w.learnerA, w.lessonA);
    await expect(
      db.withActor(w.moderatorA, (tx) =>
        tx.query(
          `INSERT INTO ai_messages (conversation_id, owner_id, sender_type, content_text)
           VALUES ($1, $2, 'student', 'moderator speaking')`,
          [id, w.moderatorA],
        ),
      ),
    ).rejects.toThrow();
  });
});
