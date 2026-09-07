import { z } from 'zod';
import { idSchema } from './common.ts';
import { createListQuerySchema } from './query.ts';

/**
 * Contracts for class discussion forums and moderation.
 *
 * Every request schema is `.strict()`, so a field not listed is a 400 rather
 * than a value some future code path starts trusting.
 *
 * NOT ACCEPTED FROM A CLIENT, ANYWHERE IN THIS FILE:
 *
 *   authorId / reporterId  — the author is the session, on every route.
 *   organizationId         — derived from the class by a database trigger.
 *   classId on a reply     — derived from the thread. A caller who could choose
 *                            it could file a reply into another class's room.
 *   moderationStatus       — set by the automated filter on the way in, and by
 *                            staff through the moderation route. A learner who
 *                            could send it could publish a post the filter
 *                            flagged.
 *   isPinned / isLocked    — moderator columns. There is nowhere to type them.
 *   isAcceptedAnswer       — set through `PATCH /replies/:id/accept` by the
 *                            person who asked, never on the way in.
 *   threadId on a flag     — derived from the reported post, so a report cannot
 *                            be routed into another school's queue.
 *
 * ---------------------------------------------------------------------------
 * MARKDOWN, AND THE SANITIZER THAT DOES NOT EXIST YET
 * ---------------------------------------------------------------------------
 *
 * Section 3 asks that "markdown rendering must strip unsafe HTML/XSS scripts
 * before rendering". NOTHING ON THIS PLATFORM RENDERS MARKDOWN — there is no
 * renderer in the API and none in the web app, and
 * `tests/architecture/workspace-boundaries.test.ts` asserts that structurally
 * by refusing every HTML sink in `apps/web`. A sanitizer with no sink to
 * sanitize for is a comforting no-op.
 *
 * What IS done, and what survives HTML-escaping when a renderer arrives, is the
 * check Task 010 built for notes: a markdown link destination carrying
 * `javascript:`, `vbscript:` or `data:`. A renderer that escapes raw HTML — the
 * safe default — will still happily emit `<a href="javascript:alert(1)">` from
 * markdown's own `[click](javascript:…)` syntax. The scheme is the payload and
 * markdown carries it natively.
 *
 * THE STAKES ARE HIGHER HERE THAN THEY WERE FOR NOTES, which is why the same
 * check is applied to a new domain rather than assumed to be somebody else's
 * problem: a note is read by its author, and a forum post is read by a class.
 * A stored `javascript:` link in a note is a trap one child set for themselves;
 * in a thread it is a trap set for thirty classmates.
 *
 * The Task 014 report records under NOT IMPLEMENTED that render-time
 * sanitization remains the renderer's obligation, and that this contract cannot
 * discharge it.
 */

export const moderationStatusSchema = z.enum(['approved', 'flagged', 'hidden']);
export type ModerationStatus = z.infer<typeof moderationStatusSchema>;

export const flagEntityTypeSchema = z.enum(['thread', 'reply']);
export type FlagEntityType = z.infer<typeof flagEntityTypeSchema>;

export const flagStatusSchema = z.enum(['pending', 'reviewed', 'dismissed']);
export type FlagStatus = z.infer<typeof flagStatusSchema>;

/** Matches the database CHECK exactly. */
export const threadTitleSchema = z.string().trim().min(1).max(200);
export const postBodySchema = z.string().trim().min(1).max(20_000);

export const createThreadRequestSchema = z
  .object({
    title: threadTitleSchema,
    contentMarkdown: postBodySchema,
    /**
     * The course this thread is about, if any. Validated by a database trigger
     * as a course actually assigned to this class — the schema can only say
     * "this is a UUID", and saying so here stops anybody reading the field's
     * presence as the presence of a check.
     */
    courseId: idSchema.nullable().default(null),
  })
  .strict();
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;

export const updateThreadRequestSchema = z
  .object({
    title: threadTitleSchema.optional(),
    contentMarkdown: postBodySchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });
export type UpdateThreadRequest = z.infer<typeof updateThreadRequestSchema>;

export const createReplyRequestSchema = z
  .object({
    contentMarkdown: postBodySchema,
    /**
     * The reply this answers, or null for a top-level reply. Bound to the same
     * thread by a composite foreign key in migration 0029 — a parent in another
     * thread has no matching row, so cross-class nesting is refused by
     * referential integrity rather than by a rule somebody has to remember.
     */
    parentReplyId: idSchema.nullable().default(null),
  })
  .strict();
export type CreateReplyRequest = z.infer<typeof createReplyRequestSchema>;

export const updateReplyRequestSchema = z
  .object({ contentMarkdown: postBodySchema })
  .strict();
export type UpdateReplyRequest = z.infer<typeof updateReplyRequestSchema>;

/**
 * An author as other people in the room see them.
 *
 * DISPLAY NAME AND NOTHING ELSE — no email, no id beyond the one the client
 * needs to group posts, no role. A forum shows who said what; it is not a
 * directory of the class.
 */
export const postAuthorSchema = z
  .object({ id: idSchema, displayName: z.string() })
  .strict();

export const threadResponseSchema = z
  .object({
    id: idSchema,
    classId: idSchema,
    courseId: idSchema.nullable(),
    author: postAuthorSchema,
    title: z.string(),
    contentMarkdown: z.string(),
    isPinned: z.boolean(),
    isLocked: z.boolean(),
    moderationStatus: moderationStatusSchema,
    replyCount: z.number().int(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ThreadResponse = z.infer<typeof threadResponseSchema>;

export const replyResponseSchema = z
  .object({
    id: idSchema,
    threadId: idSchema,
    parentReplyId: idSchema.nullable(),
    author: postAuthorSchema,
    contentMarkdown: z.string(),
    isAcceptedAnswer: z.boolean(),
    moderationStatus: moderationStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ReplyResponse = z.infer<typeof replyResponseSchema>;

export const listThreadsQuerySchema = createListQuerySchema({
  sortableFields: ['createdAt', 'updatedAt'],
  defaultSort: 'createdAt',
  defaultOrder: 'desc',
  filters: { courseId: idSchema.optional() },
});
export type ListThreadsQuery = z.infer<typeof listThreadsQuerySchema>;

// --- Moderation ----------------------------------------------------------

/**
 * Reporting a post.
 *
 * `reason` IS REQUIRED AND IS FREE TEXT. A dropdown would be easier to
 * aggregate and worse at the job: the thing a child needs to say about a post
 * that frightened them rarely fits a category somebody chose in advance. It is
 * length-capped and reaches only staff.
 */
export const flagContentRequestSchema = z
  .object({
    entityType: flagEntityTypeSchema,
    entityId: idSchema,
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export type FlagContentRequest = z.infer<typeof flagContentRequestSchema>;

/**
 * A moderation action.
 *
 * ONE ROUTE, ONE BODY, AND THE VERB NAMES THE POWER. `pin` and `lock` are here
 * alongside `hide` and `approve` because section 2D asks for one moderation
 * endpoint — but they are separate values rather than a `{pinned: true}` patch,
 * so that an audit log records which authority was exercised rather than which
 * column moved.
 */
export const moderationActionSchema = z.enum([
  'approve',
  'hide',
  'pin',
  'unpin',
  'lock',
  'unlock',
]);
export type ModerationActionName = z.infer<typeof moderationActionSchema>;

export const moderationActionRequestSchema = z
  .object({
    entityType: flagEntityTypeSchema,
    entityId: idSchema,
    action: moderationActionSchema,
    /**
     * Optionally closes the flags that prompted this. `dismissed` when the
     * report was not upheld, `reviewed` when it was — the distinction is what
     * lets a school ever ask whether its reporting is working.
     */
    resolveFlagsAs: z.enum(['reviewed', 'dismissed']).nullable().default(null),
  })
  .strict()
  .refine((v) => !(v.entityType === 'reply' && ['pin', 'unpin', 'lock', 'unlock'].includes(v.action)), {
    message: 'pin and lock apply to a thread, not to a reply',
    path: ['action'],
  });
export type ModerationActionRequest = z.infer<typeof moderationActionRequestSchema>;

/**
 * A flag as the moderation queue shows it.
 *
 * `reporterId` IS PRESENT AND IS ONLY EVER SENT TO STAFF — the RLS policy and
 * the authz policy both refuse this row to the reported author, and
 * `ContentFlagResource` does not carry their id at all. A queue that could not
 * name the reporter would make repeat false reporting invisible.
 */
export const contentFlagResponseSchema = z
  .object({
    id: idSchema,
    entityType: flagEntityTypeSchema,
    entityId: idSchema,
    threadId: idSchema,
    reporterId: idSchema.nullable(),
    raisedBy: z.enum(['member', 'automated_filter']),
    reason: z.string(),
    status: flagStatusSchema,
    createdAt: z.string().datetime(),
    /** The post's current text, so a moderator need not open two screens. */
    subjectExcerpt: z.string(),
    subjectModerationStatus: moderationStatusSchema,
  })
  .strict();
export type ContentFlagResponse = z.infer<typeof contentFlagResponseSchema>;

export const listFlagsQuerySchema = createListQuerySchema({
  sortableFields: ['createdAt'],
  defaultSort: 'createdAt',
  defaultOrder: 'asc',
  filters: {
    status: flagStatusSchema.optional(),
    classId: idSchema.optional(),
  },
});
export type ListFlagsQuery = z.infer<typeof listFlagsQuerySchema>;

/** How much of a post the moderation queue shows before a moderator opens it. */
export const FLAG_EXCERPT_CHARACTERS = 280;
