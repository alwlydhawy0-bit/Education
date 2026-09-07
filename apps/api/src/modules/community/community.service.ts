import { conflict, forbidden, notFound, validationFailed } from '@edu/kernel';
import type {
  Action,
  Actor,
  AuthorizationContext,
  Decision,
  Guarded,
  PolicyEngine,
  RelationshipSnapshot,
  Resource,
} from '@edu/authz';
import { SecurityEventType } from '@edu/observability';
import type {
  CreateReplyRequest,
  CreateThreadRequest,
  FlagContentRequest,
  ListFlagsQuery,
  ListThreadsQuery,
  ModerationActionRequest,
  ModerationStatus,
  UpdateReplyRequest,
  UpdateThreadRequest,
} from '@edu/contracts';
import type { Database } from '../../platform/db.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import { checkMarkdown } from '../../platform/security/markdown-safety.ts';
import { nextModerationState, screenContent } from './content-filter.ts';
import type {
  CommunityRepository,
  FlagRecord,
  ReplyRecord,
  ThreadRecord,
} from './community.repository.ts';

export interface ActorContext {
  readonly actor: Actor;
  readonly loadRelationships: () => Promise<RelationshipSnapshot>;
  readonly correlationId: string;
  readonly ip: string | null;
}

export interface CommunityServiceDeps {
  readonly db: Database;
  readonly repository: CommunityRepository;
  readonly engine: PolicyEngine;
  readonly securityEvents: SecurityEventRecorder;
}

export interface CommunityService {
  createThread(ctx: ActorContext, classId: string, input: CreateThreadRequest): Promise<ThreadRecord>;
  listClassThreads(ctx: ActorContext, classId: string, query: ListThreadsQuery): Promise<ThreadRecord[]>;
  readThread(ctx: ActorContext, id: string): Promise<{ thread: ThreadRecord; replies: ReplyRecord[] }>;
  updateThread(ctx: ActorContext, id: string, input: UpdateThreadRequest): Promise<ThreadRecord>;
  deleteThread(ctx: ActorContext, id: string): Promise<void>;

  createReply(ctx: ActorContext, threadId: string, input: CreateReplyRequest): Promise<ReplyRecord>;
  updateReply(ctx: ActorContext, id: string, input: UpdateReplyRequest): Promise<ReplyRecord>;
  deleteReply(ctx: ActorContext, id: string): Promise<void>;
  acceptReply(ctx: ActorContext, id: string): Promise<ReplyRecord>;

  flagContent(ctx: ActorContext, input: FlagContentRequest): Promise<{ recorded: boolean }>;
  listFlags(ctx: ActorContext, query: ListFlagsQuery): Promise<FlagRecord[]>;
  moderate(ctx: ActorContext, input: ModerationActionRequest): Promise<void>;
}

const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const RAISED = '23000';
const INSUFFICIENT_PRIVILEGE = '42501';
const PROGRAM_LIMIT = '54000';

function pgCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : null;
}

/**
 * Threads, replies, reports and moderation.
 *
 * ---------------------------------------------------------------------------
 * THE FILTER RUNS BEFORE THE WRITE, AND SETS A COLUMN RATHER THAN REFUSING
 * ---------------------------------------------------------------------------
 *
 * Section 2B asks for an "automatic pre-check on content_markdown to auto-flag
 * questionable text before storage". `screenContent` decides the
 * `moderation_status` the row is created with, so a flagged post is never
 * visible to the class for even one request — there is no window in which it is
 * approved and then corrected.
 *
 * A MATCH ALSO FILES A FLAG, so the post lands in the same queue a human report
 * would. A moderation queue with two sources and one shape is one a teacher can
 * actually work; two parallel lists would mean the automated one is the one
 * nobody opens.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE MARKDOWN CHECK DOES AND DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * `checkMarkdown` is Task 010's, reused rather than reimplemented. It refuses a
 * `javascript:`, `vbscript:` or `data:` scheme in a LINK DESTINATION, which is
 * the one vector that survives HTML-escaping — a renderer that escapes raw HTML
 * will still emit `<a href="javascript:...">` from markdown's own syntax.
 *
 * IT REJECTS RATHER THAN STRIPPING, which for a note was about not corrupting a
 * child's private writing. Here the reasoning is different and stronger: a
 * stripped link in a forum post changes what a child said to their class, and
 * the class cannot tell that the platform edited it. A refusal is visible.
 *
 * It is NOT a sanitizer and this platform has no renderer to sanitize for. The
 * Task 014 report records under NOT IMPLEMENTED that render-time sanitization
 * remains the renderer's obligation.
 */
export function createCommunityService(deps: CommunityServiceDeps): CommunityService {
  const { db, repository, engine, securityEvents } = deps;

  async function emit(
    ctx: ActorContext,
    type: SecurityEventType,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await securityEvents.record({
      type,
      actorId: ctx.actor.id,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
      detail,
      occurredAt: new Date(),
    });
  }

  /**
   * Every denial is recorded with IDS AND RULE NAMES ONLY.
   *
   * Never a title, never a body, never a reason a child typed. This is
   * children's writing about each other, and the audit trail is read by more
   * people than the thread is.
   */
  async function recordDenial(
    ctx: ActorContext,
    action: Action,
    resourceKind: string,
    resourceId: string,
    reason: string,
  ): Promise<void> {
    await emit(ctx, SecurityEventType.AUTHZ_DENIED, {
      action,
      resourceKind,
      resourceId,
      reason,
    });
  }

  async function decide(ctx: ActorContext, action: Action, resource: Resource): Promise<Decision> {
    const authContext: AuthorizationContext = {
      actor: ctx.actor,
      relationships: await ctx.loadRelationships(),
    };
    const decision = engine.decide(authContext, action, resource);
    if (decision.effect !== 'allow') {
      await recordDenial(ctx, action, resource.kind, resource.id, decision.reason);
      if (decision.disclosure === 'reveal') throw forbidden(explain(decision.reason));
      throw notFound();
    }
    return decision;
  }

  /**
   * Turns a policy reason into something a learner can act on.
   *
   * ONLY FOR `reveal` DENIALS, so this can never disclose the existence of
   * something a `hide` denial is concealing. A child whose edit is refused
   * because a teacher locked the thread is entitled to know that; the
   * alternative is a silent failure they will read as the platform being broken.
   */
  function explain(reason: string): string {
    if (reason.endsWith('.locked') || reason.endsWith('.thread_locked')) {
      return 'This conversation has been locked by a teacher';
    }
    if (reason.endsWith('.hidden')) {
      return 'This post is under review and cannot be edited';
    }
    if (reason.endsWith('.no_longer_in_class')) {
      return 'You are no longer a member of this class';
    }
    if (reason.endsWith('.no_self_accept')) {
      return 'You cannot mark your own reply as the accepted answer';
    }
    return 'Forbidden';
  }

  async function authorize<T>(
    ctx: ActorContext,
    guarded: Guarded<T> | null,
    action: Action,
    resourceKind: string,
    resourceId: string,
  ): Promise<T> {
    if (!guarded) {
      await recordDenial(ctx, action, resourceKind, resourceId, 'absent_or_not_visible');
      throw notFound();
    }
    const decision = await decide(ctx, action, guarded.resource);
    return guarded.unwrap(decision, action);
  }

  /**
   * The second gate over a list.
   *
   * RLS HAS ALREADY FILTERED THESE ROWS, and a forum feed is precisely where
   * running the policy again earns its cost: unlike a `/me/...` listing, this
   * one contains other people's posts by construction. A row the policy
   * declines is dropped rather than erroring, and is not recorded as a denial —
   * a learner opening their class feed is not probing.
   */
  async function admit<T>(
    ctx: ActorContext,
    guarded: readonly Guarded<T>[],
    action: Action,
  ): Promise<T[]> {
    const authContext: AuthorizationContext = {
      actor: ctx.actor,
      relationships: await ctx.loadRelationships(),
    };
    const admitted: T[] = [];
    for (const row of guarded) {
      const decision = engine.decide(authContext, action, row.resource);
      if (decision.effect === 'allow') admitted.push(row.unwrap(decision, action));
    }
    return admitted;
  }

  /** Refuses a link scheme a renderer would turn into a click. */
  function checkBody(body: string): void {
    const rejection = checkMarkdown(body);
    if (rejection) {
      throw validationFailed(
        `Links using ${rejection.scheme}: are not allowed`,
        { reason: rejection.reason, scheme: rejection.scheme },
      );
    }
  }

  /**
   * Screens content and, when it matches, records the finding.
   *
   * Returns the status the row should be created with. The flag is filed AFTER
   * the post exists, because a flag names an entity that has to be there.
   */
  function screen(body: string, title = ''): { status: ModerationStatus; reason: string } {
    const verdict = screenContent(`${title}\n${body}`);
    return verdict.flagged
      ? { status: 'flagged', reason: verdict.reason }
      : { status: 'approved', reason: '' };
  }

  function translate(error: unknown): never {
    const code = pgCode(error);
    const message = error instanceof Error ? error.message : '';

    if (code === PROGRAM_LIMIT || /nested more than/i.test(message)) {
      throw validationFailed('Replies cannot be nested that deeply');
    }
    if (code === UNIQUE_VIOLATION && message.includes('one_accepted')) {
      throw conflict('This thread already has an accepted answer');
    }
    if (code === UNIQUE_VIOLATION && message.includes('one_per_reporter')) {
      // A double-click, not an error worth showing a child.
      throw conflict('You have already reported this post');
    }
    if (code === FK_VIOLATION && /parent_fk/.test(message)) {
      // THE COMPOSITE KEY REFUSING A PARENT IN ANOTHER THREAD. A 404, not a
      // 403: confirming the id names a real reply is the bit a caller trying
      // other threads' ids is fishing for.
      throw notFound();
    }
    if (code === FK_VIOLATION) {
      throw notFound();
    }
    if (code === INSUFFICIENT_PRIVILEGE && /class you are in/i.test(message)) {
      throw forbidden('You can only post in a class you are in');
    }
    if (code === INSUFFICIENT_PRIVILEGE && /accept an answer/i.test(message)) {
      throw forbidden('Only the person who asked, or a teacher, may accept an answer');
    }
    if (code === INSUFFICIENT_PRIVILEGE && /course is not assigned/i.test(message)) {
      throw validationFailed('That course is not taught to this class');
    }
    if (code === RAISED && /hidden post cannot be edited/i.test(message)) {
      throw forbidden('This post is under review and cannot be edited');
    }
    if (code === RAISED && /moderator may/i.test(message)) {
      throw forbidden('A moderator may pin, lock and change moderation status, and nothing else');
    }
    if (code === RAISED) {
      throw forbidden('That is not something you may change');
    }
    if (code === CHECK_VIOLATION) {
      throw validationFailed('That value is not one this field accepts');
    }
    throw error;
  }

  async function guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      return translate(error);
    }
  }

  return {
    async createThread(ctx, classId, input) {
      checkBody(input.contentMarkdown);
      const screened = screen(input.contentMarkdown, input.title);

      return guard(() =>
        db.withActor(ctx.actor.id, async (tx) => {
          // "MAY I CREATE" IS A DECISION, NOT AN ASSUMPTION. There is no row
          // yet, so the repository builds a resource for the FORUM whose
          // relationship booleans come from the same SQL helpers.
          const forum = await repository.forumResourceFor(tx, classId);
          await decide(ctx, 'discussion_thread:create', forum);

          const thread = await repository.createThread(
            tx,
            ctx.actor.id,
            classId,
            input,
            screened.status,
          );

          if (screened.status === 'flagged') {
            await repository.createFlag(tx, 'thread', thread.id, screened.reason, 'automated_filter');
            await emit(ctx, SecurityEventType.MODERATION_AUTO_FLAGGED, {
              entityType: 'thread',
              entityId: thread.id,
              classId,
            });
          }
          return thread;
        }),
      );
    },

    async listClassThreads(ctx, classId, query) {
      const rows = await db.withActor(ctx.actor.id, (tx) =>
        repository.listClassThreads(tx, classId, query),
      );
      return admit(ctx, rows, 'discussion_thread:list');
    },

    /**
     * A thread and its replies.
     *
     * THE REPLIES ARE ADMITTED SEPARATELY, per row. A reply can be hidden while
     * its thread is fine, and a reader entitled to the thread is not thereby
     * entitled to every reply in it.
     */
    async readThread(ctx, id) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const guarded = await repository.findThread(tx, id);
        const thread = await authorize(
          ctx,
          guarded,
          'discussion_thread:read',
          'discussion_thread',
          id,
        );
        const replies = await admit(
          ctx,
          await repository.listReplies(tx, id),
          'discussion_reply:list',
        );
        return { thread, replies };
      });
    },

    async updateThread(ctx, id, input) {
      if (input.contentMarkdown) checkBody(input.contentMarkdown);
      return guard(() =>
        db.withActor(ctx.actor.id, async (tx) => {
          const guarded = await repository.findThread(tx, id);
          await authorize(ctx, guarded, 'discussion_thread:update', 'discussion_thread', id);

          // AN EDIT IS RE-SCREENED. Otherwise the filter is a one-time check a
          // learner walks past by posting something innocuous and editing it.
          const body = input.contentMarkdown ?? '';
          const screened = body ? screen(body, input.title ?? '') : { status: 'approved' as const, reason: '' };

          const updated = await repository.updateThread(tx, id, input);
          if (!updated) throw notFound();

          if (screened.status === 'flagged') {
            await repository.setThreadModeration(tx, id, { moderationStatus: 'flagged' });
            await repository.createFlag(tx, 'thread', id, screened.reason, 'automated_filter');
            await emit(ctx, SecurityEventType.MODERATION_AUTO_FLAGGED, {
              entityType: 'thread',
              entityId: id,
              onEdit: true,
            });
            return { ...updated, moderationStatus: 'flagged' as const };
          }
          return updated;
        }),
      );
    },

    async deleteThread(ctx, id) {
      await db.withActor(ctx.actor.id, async (tx) => {
        const guarded = await repository.findThread(tx, id);
        await authorize(ctx, guarded, 'discussion_thread:delete', 'discussion_thread', id);
        if (!(await repository.deleteThread(tx, id))) throw notFound();
      });
    },

    async createReply(ctx, threadId, input) {
      checkBody(input.contentMarkdown);
      const screened = screen(input.contentMarkdown);

      return guard(() =>
        db.withActor(ctx.actor.id, async (tx) => {
          const guardedThread = await repository.findThread(tx, threadId);
          if (!guardedThread) {
            await recordDenial(
              ctx,
              'discussion_reply:create',
              'discussion_thread',
              threadId,
              'absent_or_not_visible',
            );
            throw notFound();
          }
          const thread = guardedThread.resource;
          if (thread.kind !== 'discussion_thread') throw notFound();

          // A synthetic reply resource, because there is no row yet. The lock
          // and the room come from the thread; the author is the session.
          await decide(ctx, 'discussion_reply:create', {
            kind: 'discussion_reply',
            id: threadId,
            ownerId: ctx.actor.id,
            organizationId: thread.organizationId,
            classId: thread.classId,
            threadId,
            moderationStatus: 'approved',
            threadIsLocked: thread.isLocked,
            actorInForum: thread.actorInForum,
            actorModerates: thread.actorModerates,
            actorOwnsThread: false,
          });

          const reply = await repository.createReply(
            tx,
            ctx.actor.id,
            threadId,
            input,
            screened.status,
          );

          if (screened.status === 'flagged') {
            await repository.createFlag(tx, 'reply', reply.id, screened.reason, 'automated_filter');
            await emit(ctx, SecurityEventType.MODERATION_AUTO_FLAGGED, {
              entityType: 'reply',
              entityId: reply.id,
              threadId,
            });
          }
          return reply;
        }),
      );
    },

    async updateReply(ctx, id, input) {
      checkBody(input.contentMarkdown);
      const screened = screen(input.contentMarkdown);
      return guard(() =>
        db.withActor(ctx.actor.id, async (tx) => {
          const guarded = await repository.findReply(tx, id);
          await authorize(ctx, guarded, 'discussion_reply:update', 'discussion_reply', id);
          const updated = await repository.updateReply(tx, id, input);
          if (!updated) throw notFound();

          if (screened.status === 'flagged') {
            await repository.setReplyModeration(tx, id, 'flagged');
            await repository.createFlag(tx, 'reply', id, screened.reason, 'automated_filter');
            await emit(ctx, SecurityEventType.MODERATION_AUTO_FLAGGED, {
              entityType: 'reply',
              entityId: id,
              onEdit: true,
            });
            return { ...updated, moderationStatus: 'flagged' as const };
          }
          return updated;
        }),
      );
    },

    async deleteReply(ctx, id) {
      await guard(() =>
        db.withActor(ctx.actor.id, async (tx) => {
          const guarded = await repository.findReply(tx, id);
          await authorize(ctx, guarded, 'discussion_reply:delete', 'discussion_reply', id);
          if (!(await repository.deleteReply(tx, id))) throw notFound();
        }),
      );
    },

    async acceptReply(ctx, id) {
      return guard(() =>
        db.withActor(ctx.actor.id, async (tx) => {
          const guarded = await repository.findReply(tx, id);
          if (!guarded) {
            await recordDenial(ctx, 'discussion_reply:accept', 'discussion_reply', id, 'absent');
            throw notFound();
          }
          const resource = guarded.resource;
          if (resource.kind !== 'discussion_reply') throw notFound();
          await decide(ctx, 'discussion_reply:accept', resource);
          const accepted = await repository.acceptReply(tx, id, resource.threadId);
          if (!accepted) throw notFound();
          return accepted;
        }),
      );
    },

    /**
     * Reporting a post.
     *
     * THE RESPONSE DOES NOT SAY WHETHER THE POST EXISTS. `{ recorded: true }`
     * comes back for a real post, a duplicate report, and — because the guard
     * refuses an entity it cannot find, and that refusal is translated to 404
     * only when the entity is genuinely absent — the shape is deliberately
     * uninformative. A reporting endpoint that confirms existence is an
     * enumeration oracle wearing a safety feature's clothes.
     */
    async flagContent(ctx, input) {
      return guard(() =>
        db.withActor(ctx.actor.id, async (tx) => {
          await decide(ctx, 'content_flag:create', {
            kind: 'content_flag',
            id: input.entityId,
            reporterId: ctx.actor.id,
            organizationId: null,
            actorModerates: false,
          });

          const flag = await repository.createFlag(
            tx,
            input.entityType,
            input.entityId,
            input.reason,
            'member',
          );

          await emit(ctx, SecurityEventType.MODERATION_CONTENT_REPORTED, {
            entityType: input.entityType,
            entityId: input.entityId,
            // NEVER THE REASON TEXT. A child's account of why a post frightened
            // them belongs in the moderation queue a teacher opens, not in an
            // audit log read by operators.
            duplicate: flag === null,
          });

          return { recorded: true };
        }),
      );
    },

    async listFlags(ctx, query) {
      const rows = await db.withActor(ctx.actor.id, (tx) => repository.listFlags(tx, query));
      return admit(ctx, rows, 'content_flag:list');
    },

    /**
     * A moderation action.
     *
     * BOTH GATES PLUS A TRIGGER. The policy admits only somebody who moderates
     * this class; `discussion_threads_moderate` admits the same; and
     * `discussion_thread_moderation_guard` limits the change to four columns —
     * because a policy admits a ROW and only a trigger can limit a COLUMN.
     */
    async moderate(ctx, input) {
      await guard(() =>
        db.withActor(ctx.actor.id, async (tx) => {
          if (input.entityType === 'thread') {
            const guarded = await repository.findThread(tx, input.entityId);
            const resource = guarded?.resource;
            if (!guarded || resource?.kind !== 'discussion_thread') {
              await recordDenial(
                ctx,
                'discussion_thread:moderate',
                'discussion_thread',
                input.entityId,
                'absent_or_not_visible',
              );
              throw notFound();
            }
            const action: Action =
              input.action === 'pin' || input.action === 'unpin'
                ? 'discussion_thread:pin'
                : input.action === 'lock' || input.action === 'unlock'
                  ? 'discussion_thread:lock'
                  : 'discussion_thread:moderate';
            await decide(ctx, action, resource);

            const fields: {
              moderationStatus?: ModerationStatus;
              isPinned?: boolean;
              isLocked?: boolean;
            } = {};
            if (input.action === 'approve' || input.action === 'hide') {
              fields.moderationStatus = nextModerationState(
                resource.moderationStatus,
                input.action,
              );
            }
            if (input.action === 'pin') fields.isPinned = true;
            if (input.action === 'unpin') fields.isPinned = false;
            if (input.action === 'lock') fields.isLocked = true;
            if (input.action === 'unlock') fields.isLocked = false;

            if (!(await repository.setThreadModeration(tx, input.entityId, fields))) {
              throw notFound();
            }
          } else {
            const guarded = await repository.findReply(tx, input.entityId);
            const resource = guarded?.resource;
            if (!guarded || resource?.kind !== 'discussion_reply') {
              await recordDenial(
                ctx,
                'discussion_reply:moderate',
                'discussion_reply',
                input.entityId,
                'absent_or_not_visible',
              );
              throw notFound();
            }
            await decide(ctx, 'discussion_reply:moderate', resource);
            if (input.action !== 'approve' && input.action !== 'hide') {
              throw validationFailed('pin and lock apply to a thread, not to a reply');
            }
            const next = nextModerationState(resource.moderationStatus, input.action);
            if (!(await repository.setReplyModeration(tx, input.entityId, next))) {
              throw notFound();
            }
          }

          if (input.resolveFlagsAs) {
            await repository.resolveFlagsFor(
              tx,
              input.entityType,
              input.entityId,
              input.resolveFlagsAs,
            );
          }

          // THE EVENT THE TAXONOMY RESERVED IN 2024 AND NEVER EMITTED. An adult
          // acting on a child's words in front of their class is exactly the
          // thing a school needs a record of.
          await emit(ctx, SecurityEventType.MODERATION_ACTION, {
            entityType: input.entityType,
            entityId: input.entityId,
            action: input.action,
            flagsResolvedAs: input.resolveFlagsAs,
          });
        }),
      );
    },
  };
}
