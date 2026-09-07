import {
  Guarded,
  type ContentFlagResource,
  type DiscussionReplyResource,
  type DiscussionThreadResource,
} from '@edu/authz';
import {
  resolveSortColumn,
  resolveSortDirection,
  type CreateReplyRequest,
  type CreateThreadRequest,
  type FlagEntityType,
  type FlagStatus,
  type ListFlagsQuery,
  type ListThreadsQuery,
  type ModerationStatus,
  type UpdateReplyRequest,
  type UpdateThreadRequest,
} from '@edu/contracts';
import type { Tx } from '../../platform/db.ts';

/**
 * Persistence for threads, replies and flags.
 *
 * THREE RULES SHAPE EVERY QUERY HERE.
 *
 * 1. THE RELATIONSHIP BOOLEANS COME FROM THE SAME SQL HELPERS THE RLS POLICIES
 *    CALL — `app_actor_in_class_forum` and `app_actor_moderates_class`. The
 *    policy engine and the database answer from one definition rather than from
 *    two implementations of one idea, so they cannot disagree about who is in
 *    the room.
 *
 * 2. NOTHING WRITES `organization_id`, `class_id` ON A REPLY, `reporter_id`, OR
 *    `thread_id` ON A FLAG. All are derived by triggers in migration 0029.
 *    Where a NOT NULL column must be supplied, the statement passes a
 *    placeholder so the trigger's overwrite is visible in the source rather
 *    than implied by an absent column.
 *
 * 3. LISTS RETURN `Guarded` ROWS. Unlike `/me/...` listings elsewhere on this
 *    platform, a forum feed contains OTHER PEOPLE'S posts by definition, so
 *    every row needs its own decision. VULN-017 was a listing that trusted a
 *    single gate, and a listing is where one missing condition leaks many rows
 *    rather than one.
 */

export interface PostAuthor {
  readonly id: string;
  readonly displayName: string;
}

export interface ThreadRecord {
  readonly id: string;
  readonly classId: string;
  readonly courseId: string | null;
  readonly organizationId: string | null;
  readonly author: PostAuthor;
  readonly title: string;
  readonly contentMarkdown: string;
  readonly isPinned: boolean;
  readonly isLocked: boolean;
  readonly moderationStatus: ModerationStatus;
  readonly replyCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ReplyRecord {
  readonly id: string;
  readonly threadId: string;
  readonly classId: string;
  readonly parentReplyId: string | null;
  readonly author: PostAuthor;
  readonly contentMarkdown: string;
  readonly isAcceptedAnswer: boolean;
  readonly moderationStatus: ModerationStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FlagRecord {
  readonly id: string;
  readonly entityType: FlagEntityType;
  readonly entityId: string;
  readonly threadId: string;
  readonly organizationId: string | null;
  readonly reporterId: string | null;
  readonly raisedBy: 'member' | 'automated_filter';
  readonly reason: string;
  readonly status: FlagStatus;
  readonly createdAt: Date;
  readonly subjectExcerpt: string;
  readonly subjectModerationStatus: ModerationStatus;
}

interface ThreadRow {
  id: string;
  class_id: string;
  course_id: string | null;
  organization_id: string | null;
  author_id: string;
  author_display_name: string | null;
  title: string;
  content_markdown: string;
  is_pinned: boolean;
  is_locked: boolean;
  moderation_status: ModerationStatus;
  reply_count: string;
  created_at: Date;
  updated_at: Date;
  actor_in_forum: boolean;
  actor_moderates: boolean;
}

interface ReplyRow {
  id: string;
  thread_id: string;
  class_id: string;
  parent_reply_id: string | null;
  author_id: string;
  author_display_name: string | null;
  content_markdown: string;
  is_accepted_answer: boolean;
  moderation_status: ModerationStatus;
  created_at: Date;
  updated_at: Date;
  thread_is_locked: boolean;
  actor_in_forum: boolean;
  actor_moderates: boolean;
  actor_owns_thread: boolean;
}

interface FlagRow {
  id: string;
  entity_type: FlagEntityType;
  entity_id: string;
  thread_id: string;
  organization_id: string | null;
  reporter_id: string | null;
  raised_by: 'member' | 'automated_filter';
  reason: string;
  status: FlagStatus;
  created_at: Date;
  subject_excerpt: string | null;
  subject_moderation_status: ModerationStatus | null;
  actor_moderates: boolean;
}

/**
 * The author's display name, resolved without joining `users`.
 *
 * `users` HAS RLS AND A FORUM READER IS NOT ENTITLED TO THE ROW. A classmate is
 * not somebody's teacher, guardian or self, so `users_select` admits nothing —
 * and an INNER JOIN would silently return zero rows for every post. That is
 * VULN-055 exactly: the Task 013 public portfolio joined `users` for a display
 * name and killed every public page.
 *
 * A LEFT JOIN would return the post with a null name, which is correct and
 * useless: a forum where nobody has a name is not a forum, and you cannot tell
 * who answered you.
 *
 * So the name comes from `app_forum_display_name` (migration 0030), which is
 * bounded twice — the caller must be in the room, and so must the person being
 * named. It discloses exactly one thing: the names of people the caller is
 * already sitting in a class with, which the class register already tells them.
 * It is deliberately NOT a general `display_name(uuid)` lookup.
 */
const AUTHOR_NAME = `app_forum_display_name(t.author_id, t.class_id)`;

const asAuthor = (id: string, name: string | null): PostAuthor => ({
  id,
  // A post whose author the reader may not look up still has an author. The
  // fallback is deliberate and visible rather than an empty string that would
  // render as a gap somebody later "fixes" by joining `users`.
  displayName: name ?? 'A member of this class',
});

const toThread = (row: ThreadRow): ThreadRecord => ({
  id: row.id,
  classId: row.class_id,
  courseId: row.course_id,
  organizationId: row.organization_id,
  author: asAuthor(row.author_id, row.author_display_name),
  title: row.title,
  contentMarkdown: row.content_markdown,
  isPinned: row.is_pinned,
  isLocked: row.is_locked,
  moderationStatus: row.moderation_status,
  replyCount: Number(row.reply_count),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * The authorization-relevant attributes, and only those.
 *
 * No title, no body. `Guarded.resource` is readable WITHOUT a decision — that
 * is what lets the policy engine be handed its input before the payload is
 * released — so anything placed here is readable by code that has not yet been
 * authorized to read the row.
 */
const toThreadResource = (row: ThreadRow): DiscussionThreadResource => ({
  kind: 'discussion_thread',
  id: row.id,
  ownerId: row.author_id,
  organizationId: row.organization_id,
  classId: row.class_id,
  moderationStatus: row.moderation_status,
  isLocked: row.is_locked,
  actorInForum: row.actor_in_forum,
  actorModerates: row.actor_moderates,
});

const toReply = (row: ReplyRow): ReplyRecord => ({
  id: row.id,
  threadId: row.thread_id,
  classId: row.class_id,
  parentReplyId: row.parent_reply_id,
  author: asAuthor(row.author_id, row.author_display_name),
  contentMarkdown: row.content_markdown,
  isAcceptedAnswer: row.is_accepted_answer,
  moderationStatus: row.moderation_status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toReplyResource = (row: ReplyRow): DiscussionReplyResource => ({
  kind: 'discussion_reply',
  id: row.id,
  ownerId: row.author_id,
  organizationId: null,
  classId: row.class_id,
  threadId: row.thread_id,
  moderationStatus: row.moderation_status,
  threadIsLocked: row.thread_is_locked,
  actorInForum: row.actor_in_forum,
  actorModerates: row.actor_moderates,
  actorOwnsThread: row.actor_owns_thread,
});

const toFlag = (row: FlagRow): FlagRecord => ({
  id: row.id,
  entityType: row.entity_type,
  entityId: row.entity_id,
  threadId: row.thread_id,
  organizationId: row.organization_id,
  reporterId: row.reporter_id,
  raisedBy: row.raised_by,
  reason: row.reason,
  status: row.status,
  createdAt: row.created_at,
  // A flag whose subject the reader cannot see shows nothing rather than a
  // placeholder that might be mistaken for the post's actual text.
  subjectExcerpt: row.subject_excerpt ?? '',
  subjectModerationStatus: row.subject_moderation_status ?? 'approved',
});

const toFlagResource = (row: FlagRow): ContentFlagResource => ({
  kind: 'content_flag',
  id: row.id,
  reporterId: row.reporter_id,
  organizationId: row.organization_id,
  actorModerates: row.actor_moderates,
});

const THREAD_SELECT = `SELECT t.id, t.class_id, t.course_id, t.organization_id, t.author_id,
              ${AUTHOR_NAME} AS author_display_name,
              t.title, t.content_markdown, t.is_pinned, t.is_locked,
              t.moderation_status, t.created_at, t.updated_at,
              (SELECT count(*) FROM discussion_replies r
                WHERE r.thread_id = t.id AND r.moderation_status = 'approved') AS reply_count,
              app_actor_in_class_forum(t.class_id) AS actor_in_forum,
              app_actor_moderates_class(t.class_id, t.organization_id) AS actor_moderates
         FROM discussion_threads t`;

const REPLY_SELECT = `SELECT t.id, t.thread_id, t.class_id, t.parent_reply_id, t.author_id,
              ${AUTHOR_NAME} AS author_display_name,
              t.content_markdown, t.is_accepted_answer, t.moderation_status,
              t.created_at, t.updated_at,
              (SELECT th.is_locked FROM discussion_threads th WHERE th.id = t.thread_id)
                AS thread_is_locked,
              app_actor_in_class_forum(t.class_id) AS actor_in_forum,
              app_actor_moderates_class(t.class_id, app_class_organization(t.class_id))
                AS actor_moderates,
              app_actor_owns_thread(t.thread_id) AS actor_owns_thread
         FROM discussion_replies t`;

const THREAD_SORT = { createdAt: 't.created_at', updatedAt: 't.updated_at' } as const;

export interface CommunityRepository {
  createThread(
    tx: Tx,
    authorId: string,
    classId: string,
    input: CreateThreadRequest,
    moderationStatus: ModerationStatus,
  ): Promise<ThreadRecord>;
  findThread(tx: Tx, id: string): Promise<Guarded<ThreadRecord> | null>;
  /** A synthetic resource for a class nobody has posted in yet. */
  forumResourceFor(tx: Tx, classId: string): Promise<DiscussionThreadResource>;
  listClassThreads(
    tx: Tx,
    classId: string,
    query: ListThreadsQuery,
  ): Promise<Guarded<ThreadRecord>[]>;
  updateThread(tx: Tx, id: string, input: UpdateThreadRequest): Promise<ThreadRecord | null>;
  deleteThread(tx: Tx, id: string): Promise<boolean>;

  createReply(
    tx: Tx,
    authorId: string,
    threadId: string,
    input: CreateReplyRequest,
    moderationStatus: ModerationStatus,
  ): Promise<ReplyRecord>;
  findReply(tx: Tx, id: string): Promise<Guarded<ReplyRecord> | null>;
  listReplies(tx: Tx, threadId: string): Promise<Guarded<ReplyRecord>[]>;
  updateReply(tx: Tx, id: string, input: UpdateReplyRequest): Promise<ReplyRecord | null>;
  deleteReply(tx: Tx, id: string): Promise<boolean>;
  acceptReply(tx: Tx, id: string, threadId: string): Promise<ReplyRecord | null>;

  setThreadModeration(
    tx: Tx,
    id: string,
    fields: { moderationStatus?: ModerationStatus; isPinned?: boolean; isLocked?: boolean },
  ): Promise<ThreadRecord | null>;
  setReplyModeration(
    tx: Tx,
    id: string,
    moderationStatus: ModerationStatus,
  ): Promise<ReplyRecord | null>;

  /**
   * Files a report. Returns whether a NEW row was written.
   *
   * IT RETURNS A BOOLEAN RATHER THAN THE ROW, and that is not a simplification
   * — see the implementation. Reading the row back is a read the caller is not
   * always entitled to make.
   */
  createFlag(
    tx: Tx,
    entityType: FlagEntityType,
    entityId: string,
    reason: string,
    raisedBy: 'member' | 'automated_filter',
  ): Promise<boolean>;
  listFlags(tx: Tx, query: ListFlagsQuery): Promise<Guarded<FlagRecord>[]>;
  resolveFlagsFor(
    tx: Tx,
    entityType: FlagEntityType,
    entityId: string,
    status: Exclude<FlagStatus, 'pending'>,
  ): Promise<number>;
}

export const communityRepository: CommunityRepository = {
  async createThread(tx, authorId, classId, input, moderationStatus) {
    // `organization_id` is a placeholder the trigger overwrites, passed
    // explicitly so the overwrite is visible here rather than implied.
    // `is_pinned` and `is_locked` are absent entirely: they default false and
    // the insert policy refuses a row where either is true.
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO discussion_threads
         (class_id, course_id, organization_id, author_id, title, content_markdown,
          moderation_status)
       VALUES ($1, $2, NULL, $3, $4, $5, $6)
       RETURNING id`,
      [classId, input.courseId, authorId, input.title, input.contentMarkdown, moderationStatus],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('The thread was not written');
    const saved = await readThread(tx, id);
    if (!saved) throw new Error('The new thread is not readable');
    return saved;
  },

  async findThread(tx, id) {
    const { rows } = await tx.query<ThreadRow>(`${THREAD_SELECT} WHERE t.id = $1`, [id]);
    const row = rows[0];
    return row ? Guarded.of(toThread(row), toThreadResource(row)) : null;
  },

  /**
   * The resource for a FORUM rather than a post.
   *
   * `POST /classes/:id/threads` has no row to authorize yet, and "may I create"
   * still has to be a decision rather than an assumption. So the repository
   * builds a resource whose relationship booleans come from the same helpers,
   * with an id naming the class. The policy's `create` branch reads only
   * `actorInForum`, which is exactly what is known at this point.
   */
  async forumResourceFor(tx, classId) {
    const { rows } = await tx.query<{
      organization_id: string | null;
      in_forum: boolean;
      moderates: boolean;
    }>(
      `SELECT app_class_organization($1) AS organization_id,
              app_actor_in_class_forum($1) AS in_forum,
              app_actor_moderates_class($1, app_class_organization($1)) AS moderates`,
      [classId],
    );
    const row = rows[0];
    return {
      kind: 'discussion_thread',
      id: classId,
      ownerId: '',
      organizationId: row?.organization_id ?? null,
      classId,
      moderationStatus: 'approved',
      isLocked: false,
      actorInForum: row?.in_forum ?? false,
      actorModerates: row?.moderates ?? false,
    };
  },

  /**
   * One class's feed.
   *
   * PINNED FIRST, THEN THE CHOSEN SORT, matching the index in migration 0029.
   * The moderation filter is left to RLS and re-decided per row by the service:
   * restating "approved, or mine, or I am staff" here would be a third copy of
   * a rule that already exists in two places.
   */
  async listClassThreads(tx, classId, query) {
    const column = resolveSortColumn(THREAD_SORT, query.sort);
    const direction = resolveSortDirection(query.order);
    const { rows } = await tx.query<ThreadRow>(
      `${THREAD_SELECT}
        WHERE t.class_id = $1
          AND ($4::uuid IS NULL OR t.course_id = $4)
        ORDER BY t.is_pinned DESC, ${column} ${direction}, t.id ASC
        LIMIT $2 OFFSET $3`,
      [classId, query.limit, query.offset, query.courseId ?? null],
    );
    return rows.map((row) => Guarded.of(toThread(row), toThreadResource(row)));
  },

  async updateThread(tx, id, input) {
    // COALESCE over a fixed column list. `is_pinned`, `is_locked` and
    // `moderation_status` are absent, so an author's edit cannot touch them
    // even if the policy and the trigger were both removed.
    const { rowCount } = await tx.query(
      `UPDATE discussion_threads
          SET title = COALESCE($2, title),
              content_markdown = COALESCE($3, content_markdown),
              updated_at = now()
        WHERE id = $1`,
      [id, input.title ?? null, input.contentMarkdown ?? null],
    );
    if ((rowCount ?? 0) === 0) return null;
    return readThread(tx, id);
  },

  async deleteThread(tx, id) {
    const { rowCount } = await tx.query(`DELETE FROM discussion_threads WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  },

  async createReply(tx, authorId, threadId, input, moderationStatus) {
    // `class_id` is a placeholder the trigger overwrites from the thread — a
    // caller who could choose it could file a reply into another class's room.
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO discussion_replies
         (thread_id, class_id, parent_reply_id, author_id, content_markdown, moderation_status)
       VALUES ($1, '00000000-0000-0000-0000-000000000000', $2, $3, $4, $5)
       RETURNING id`,
      [threadId, input.parentReplyId, authorId, input.contentMarkdown, moderationStatus],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('The reply was not written');
    const saved = await readReply(tx, id);
    if (!saved) throw new Error('The new reply is not readable');
    return saved;
  },

  async findReply(tx, id) {
    const { rows } = await tx.query<ReplyRow>(`${REPLY_SELECT} WHERE t.id = $1`, [id]);
    const row = rows[0];
    return row ? Guarded.of(toReply(row), toReplyResource(row)) : null;
  },

  /**
   * A thread's replies, oldest first, flat.
   *
   * FLAT RATHER THAN NESTED, and the nesting is rebuilt by the caller from
   * `parentReplyId`. A recursive query would put the tree walk in SQL where the
   * depth limit is enforced by a trigger rather than by the query, and a cycle
   * introduced by any future bug would hang the endpoint instead of returning
   * an odd-looking list.
   */
  async listReplies(tx, threadId) {
    const { rows } = await tx.query<ReplyRow>(
      `${REPLY_SELECT} WHERE t.thread_id = $1 ORDER BY t.created_at ASC, t.id ASC LIMIT 500`,
      [threadId],
    );
    return rows.map((row) => Guarded.of(toReply(row), toReplyResource(row)));
  },

  async updateReply(tx, id, input) {
    const { rowCount } = await tx.query(
      `UPDATE discussion_replies SET content_markdown = $2, updated_at = now() WHERE id = $1`,
      [id, input.contentMarkdown],
    );
    if ((rowCount ?? 0) === 0) return null;
    return readReply(tx, id);
  },

  async deleteReply(tx, id) {
    const { rowCount } = await tx.query(`DELETE FROM discussion_replies WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  },

  /**
   * Marks one reply accepted, and clears any previous one in the same thread.
   *
   * BOTH STATEMENTS OR NEITHER — they run inside the caller's transaction. The
   * partial unique index in 0029 permits one accepted answer per thread, so
   * doing these in the wrong order would fail on the index; clearing first is
   * what makes changing your mind possible.
   */
  async acceptReply(tx, id, threadId) {
    await tx.query(
      `UPDATE discussion_replies SET is_accepted_answer = false, updated_at = now()
        WHERE thread_id = $1 AND is_accepted_answer AND id <> $2`,
      [threadId, id],
    );
    const { rowCount } = await tx.query(
      `UPDATE discussion_replies SET is_accepted_answer = true, updated_at = now() WHERE id = $1`,
      [id],
    );
    if ((rowCount ?? 0) === 0) return null;
    return readReply(tx, id);
  },

  /**
   * The moderation write. THE SET LIST IS THE FOURTH PLACE the column rule is
   * stated — after the RLS policy, the moderation guard trigger and the authz
   * policy — and it is the one a reader of this file can see.
   */
  async setThreadModeration(tx, id, fields) {
    const { rowCount } = await tx.query(
      `UPDATE discussion_threads
          SET moderation_status = COALESCE($2, moderation_status),
              is_pinned         = COALESCE($3, is_pinned),
              is_locked         = COALESCE($4, is_locked),
              updated_at        = now()
        WHERE id = $1`,
      [id, fields.moderationStatus ?? null, fields.isPinned ?? null, fields.isLocked ?? null],
    );
    if ((rowCount ?? 0) === 0) return null;
    return readThread(tx, id);
  },

  async setReplyModeration(tx, id, moderationStatus) {
    const { rowCount } = await tx.query(
      `UPDATE discussion_replies SET moderation_status = $2, updated_at = now() WHERE id = $1`,
      [id, moderationStatus],
    );
    if ((rowCount ?? 0) === 0) return null;
    return readReply(tx, id);
  },

  /**
   * Files a report.
   *
   * `thread_id` AND `organization_id` ARE PLACEHOLDERS the guard overwrites from
   * the reported entity. `reporter_id` likewise, for a member's report. An
   * automated flag passes `raised_by = 'automated_filter'`, which the CHECK
   * pairs with a null reporter.
   *
   * THERE IS NO `RETURNING` CLAUSE, AND THAT IS THE WHOLE POINT OF THIS
   * COMMENT. The first version ended `ON CONFLICT DO NOTHING RETURNING id`, and
   * every post the automated filter caught died with
   * "new row violates row-level security policy for table content_flags" —
   * pointing at the INSERT, which was fine.
   *
   * PostgreSQL applies SELECT policies to a RETURNING clause. An automated flag
   * has a NULL `reporter_id`, so `content_flags_select` admits it only to
   * somebody who moderates the class — and the caller here is the LEARNER whose
   * post was just flagged. The write succeeded; reading the result back did
   * not, and the error named the write.
   *
   * The fix is not to widen the read policy. Letting the flagged author see the
   * automated flag would show them its `reason`, which names the term that
   * matched — turning the queue into the word-list oracle that `content-filter.ts`
   * is careful not to be. So the row is written and not read: `rowCount` says
   * whether it was new, which is all any caller needs.
   *
   * A DUPLICATE IS `false` RATHER THAN AN ERROR. One person reporting the same
   * post twice is a double-click, not something to tell a child off for.
   */
  async createFlag(tx, entityType, entityId, reason, raisedBy) {
    const { rowCount } = await tx.query(
      `INSERT INTO content_flags (entity_type, entity_id, thread_id, reason, raised_by)
       VALUES ($1, $2, '00000000-0000-0000-0000-000000000000', $3, $4)
       ON CONFLICT DO NOTHING`,
      [entityType, entityId, reason, raisedBy],
    );
    return (rowCount ?? 0) > 0;
  },

  async listFlags(tx, query) {
    const direction = resolveSortDirection(query.order);
    const { rows } = await tx.query<FlagRow>(
      `${flagSelect()}
        WHERE ($3::text IS NULL OR f.status = $3)
          AND ($4::uuid IS NULL OR EXISTS (
                SELECT 1 FROM discussion_threads t
                 WHERE t.id = f.thread_id AND t.class_id = $4))
        ORDER BY f.created_at ${direction}, f.id ASC
        LIMIT $1 OFFSET $2`,
      [query.limit, query.offset, query.status ?? null, query.classId ?? null],
    );
    return rows.map((row) => Guarded.of(toFlag(row), toFlagResource(row)));
  },

  async resolveFlagsFor(tx, entityType, entityId, status) {
    const { rowCount } = await tx.query(
      `UPDATE content_flags SET status = $3
        WHERE entity_type = $1 AND entity_id = $2 AND status = 'pending'`,
      [entityType, entityId, status],
    );
    return rowCount ?? 0;
  },
};

/**
 * The flag query, with the reported post's text pulled in.
 *
 * THE EXCERPT SUBQUERIES RUN UNDER THE CALLER'S RLS, deliberately. A moderator
 * sees the text because their policy admits the post; anybody else gets NULL
 * and `toFlag` turns that into an empty string. The queue therefore cannot
 * become a way to read posts the reader is not entitled to — which matters,
 * because a reporter can see their own flags.
 */
function flagSelect(): string {
  return `SELECT f.id, f.entity_type, f.entity_id, f.thread_id, f.organization_id,
              f.reporter_id, f.raised_by, f.reason, f.status, f.created_at,
              CASE WHEN f.entity_type = 'thread'
                   THEN (SELECT left(t.content_markdown, 280) FROM discussion_threads t
                          WHERE t.id = f.entity_id)
                   ELSE (SELECT left(r.content_markdown, 280) FROM discussion_replies r
                          WHERE r.id = f.entity_id)
              END AS subject_excerpt,
              CASE WHEN f.entity_type = 'thread'
                   THEN (SELECT t.moderation_status FROM discussion_threads t
                          WHERE t.id = f.entity_id)
                   ELSE (SELECT r.moderation_status FROM discussion_replies r
                          WHERE r.id = f.entity_id)
              END AS subject_moderation_status,
              app_actor_moderates_class(
                (SELECT t.class_id FROM discussion_threads t WHERE t.id = f.thread_id),
                f.organization_id) AS actor_moderates
         FROM content_flags f`;
}

async function readThread(tx: Tx, id: string): Promise<ThreadRecord | null> {
  const { rows } = await tx.query<ThreadRow>(`${THREAD_SELECT} WHERE t.id = $1`, [id]);
  const row = rows[0];
  return row ? toThread(row) : null;
}

async function readReply(tx: Tx, id: string): Promise<ReplyRecord | null> {
  const { rows } = await tx.query<ReplyRow>(`${REPLY_SELECT} WHERE t.id = $1`, [id]);
  const row = rows[0];
  return row ? toReply(row) : null;
}
