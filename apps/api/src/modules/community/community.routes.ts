import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createReplyRequestSchema,
  createThreadRequestSchema,
  flagContentRequestSchema,
  idSchema,
  listFlagsQuerySchema,
  listThreadsQuerySchema,
  moderationActionRequestSchema,
  replyResponseSchema,
  threadResponseSchema,
  contentFlagResponseSchema,
  updateReplyRequestSchema,
  updateThreadRequestSchema,
} from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.ts';
import { RATE_LIMIT_POLICIES, routeLimit } from '../../platform/security/rate-limit.ts';
import type { FlagRecord, ReplyRecord, ThreadRecord } from './community.repository.ts';
import type { ActorContext, CommunityService } from './community.service.ts';

const idParams = z.object({ id: idSchema }).strict();
const classIdParams = z.object({ classId: idSchema }).strict();
const emptyQuerySchema = z.object({}).strict();

/**
 * The class forum's HTTP surface.
 *
 * EVERY RESPONSE IS BUILT FIELD BY FIELD through a `.strict()` schema, never
 * spread from a repository record. A spread of `ThreadRecord` would carry
 * `organizationId` to every classmate; a spread of `FlagRecord` would carry the
 * reported post's text to whoever the next endpoint hands a flag to.
 *
 * ---------------------------------------------------------------------------
 * THE REPORTING ROUTE IS RATE-LIMITED HARDER THAN THE POSTING ROUTE
 * ---------------------------------------------------------------------------
 *
 * That looks backwards and is not. Posting is the thing the forum is for, and a
 * learner who posts too much is a teacher's problem rather than a security one.
 * REPORTING is the route that can be turned against a person: file enough
 * reports and you bury a moderation queue, or — before the one-report-per-person
 * index existed — you drown one classmate's post in flags. The index makes the
 * second attack structurally impossible; the limit is for the first.
 */
export function registerCommunityRoutes(app: FastifyInstance, community: CommunityService): void {
  function contextOf(request: FastifyRequest): ActorContext {
    const actor = request.actor;
    if (!actor) throw new Error('unreachable: requireActor guarantees an actor');
    return {
      actor,
      loadRelationships: () => request.loadRelationships(),
      correlationId: request.correlationId,
      ip: request.ip,
    };
  }

  const toThread = (thread: ThreadRecord) =>
    threadResponseSchema.parse({
      id: thread.id,
      classId: thread.classId,
      courseId: thread.courseId,
      // `organizationId` IS ABSENT. A classmate reading a thread has no use for
      // the school's internal id, and a response shape that carries one is a
      // response shape somebody will later log.
      author: { id: thread.author.id, displayName: thread.author.displayName },
      title: thread.title,
      contentMarkdown: thread.contentMarkdown,
      isPinned: thread.isPinned,
      isLocked: thread.isLocked,
      moderationStatus: thread.moderationStatus,
      replyCount: thread.replyCount,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
    });

  const toReply = (reply: ReplyRecord) =>
    replyResponseSchema.parse({
      id: reply.id,
      threadId: reply.threadId,
      parentReplyId: reply.parentReplyId,
      author: { id: reply.author.id, displayName: reply.author.displayName },
      contentMarkdown: reply.contentMarkdown,
      isAcceptedAnswer: reply.isAcceptedAnswer,
      moderationStatus: reply.moderationStatus,
      createdAt: reply.createdAt.toISOString(),
      updatedAt: reply.updatedAt.toISOString(),
    });

  const toFlag = (flag: FlagRecord) =>
    contentFlagResponseSchema.parse({
      id: flag.id,
      entityType: flag.entityType,
      entityId: flag.entityId,
      threadId: flag.threadId,
      reporterId: flag.reporterId,
      raisedBy: flag.raisedBy,
      reason: flag.reason,
      status: flag.status,
      createdAt: flag.createdAt.toISOString(),
      subjectExcerpt: flag.subjectExcerpt,
      subjectModerationStatus: flag.subjectModerationStatus,
    });

  // --- Forum lifecycle ---------------------------------------------------

  app.post('/api/v1/classes/:classId/threads', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.forumPost),
    handler: async (request, reply) => {
      const { classId } = classIdParams.parse(request.params);
      const input = createThreadRequestSchema.parse(request.body ?? {});
      const created = await community.createThread(contextOf(request), classId, input);
      return reply.status(201).send(toThread(created));
    },
  });

  /**
   * One class's feed.
   *
   * A caller not in the class gets an EMPTY LIST rather than a 403. There is no
   * object to refuse — every row failed RLS — and distinguishing "not your
   * class" from "nothing posted here" would be a class-existence oracle across
   * the platform. The same reasoning as `GET /classes/:id/projects`.
   */
  app.get('/api/v1/classes/:classId/threads', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { classId } = classIdParams.parse(request.params);
      const query = listThreadsQuerySchema.parse(request.query ?? {});
      const found = await community.listClassThreads(contextOf(request), classId, query);
      return reply.status(200).send({ items: found.map(toThread) });
    },
  });

  /** A thread and its replies, each admitted separately. */
  app.get('/api/v1/threads/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      emptyQuerySchema.parse(request.query ?? {});
      const { id } = idParams.parse(request.params);
      const { thread, replies } = await community.readThread(contextOf(request), id);
      return reply
        .status(200)
        .send({ thread: toThread(thread), replies: replies.map(toReply) });
    },
  });

  for (const method of ['PUT', 'PATCH'] as const) {
    app.route({
      method,
      url: '/api/v1/threads/:id',
      preHandler: requireActor,
      config: routeLimit(RATE_LIMIT_POLICIES.forumPost),
      handler: async (request, reply) => {
        const { id } = idParams.parse(request.params);
        const input = updateThreadRequestSchema.parse(request.body ?? {});
        const saved = await community.updateThread(contextOf(request), id, input);
        return reply.status(200).send(toThread(saved));
      },
    });
  }

  app.delete('/api/v1/threads/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      await community.deleteThread(contextOf(request), id);
      return reply.status(204).send();
    },
  });

  // --- Replies -----------------------------------------------------------

  app.post('/api/v1/threads/:id/replies', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.forumPost),
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = createReplyRequestSchema.parse(request.body ?? {});
      const created = await community.createReply(contextOf(request), id, input);
      return reply.status(201).send(toReply(created));
    },
  });

  for (const method of ['PUT', 'PATCH'] as const) {
    app.route({
      method,
      url: '/api/v1/replies/:id',
      preHandler: requireActor,
      config: routeLimit(RATE_LIMIT_POLICIES.forumPost),
      handler: async (request, reply) => {
        const { id } = idParams.parse(request.params);
        const input = updateReplyRequestSchema.parse(request.body ?? {});
        const saved = await community.updateReply(contextOf(request), id, input);
        return reply.status(200).send(toReply(saved));
      },
    });
  }

  app.delete('/api/v1/replies/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      await community.deleteReply(contextOf(request), id);
      return reply.status(204).send();
    },
  });

  /**
   * Marks a reply as the accepted answer.
   *
   * THE BODY IS EMPTY AND THE SCHEMA SAYS SO. There is nothing to send: the
   * only thing that changes is one boolean and it can only change one way
   * through this route. A body would be a place for a caller to put a column.
   */
  app.patch('/api/v1/replies/:id/accept', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.forumPost),
    handler: async (request, reply) => {
      emptyQuerySchema.parse(request.body ?? {});
      const { id } = idParams.parse(request.params);
      const accepted = await community.acceptReply(contextOf(request), id);
      return reply.status(200).send(toReply(accepted));
    },
  });

  // --- Moderation --------------------------------------------------------

  /**
   * Reporting a post.
   *
   * THE RESPONSE IS THE SAME WHETHER OR NOT THE REPORT WAS NEW. A duplicate —
   * the same person reporting the same post twice — answers 202 exactly like a
   * first report, because a child who double-clicks should not be told off, and
   * because a differing response would say something about what the queue
   * already holds.
   */
  app.post('/api/v1/discussions/flag', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.contentReport),
    handler: async (request, reply) => {
      const input = flagContentRequestSchema.parse(request.body ?? {});
      await community.flagContent(contextOf(request), input);
      return reply.status(202).send({ recorded: true });
    },
  });

  /**
   * The teacher's queue.
   *
   * A learner calling this gets an empty list, not a 403 — the flags they
   * raised themselves are the exception, and those are theirs to see. Nothing
   * here distinguishes "you are not staff" from "the queue is empty", which is
   * what stops the endpoint reporting on a school's moderation load to somebody
   * who is not part of it.
   */
  app.get('/api/v1/moderation/flags', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const query = listFlagsQuerySchema.parse(request.query ?? {});
      const found = await community.listFlags(contextOf(request), query);
      return reply.status(200).send({ items: found.map(toFlag) });
    },
  });

  /**
   * Hide, approve, pin, lock — and optionally close the flags that prompted it.
   *
   * ONE ROUTE FOR FOUR POWERS, because section 2D asks for one; the ACTION in
   * the body is what the audit event records, so "who locked this conversation"
   * is answerable from the trail rather than from a diff of two rows.
   */
  app.patch('/api/v1/moderation/action', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.moderationAction),
    handler: async (request, reply) => {
      const input = moderationActionRequestSchema.parse(request.body ?? {});
      await community.moderate(contextOf(request), input);
      return reply.status(204).send();
    },
  });
}
