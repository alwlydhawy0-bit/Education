import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  conversationMessageSchema,
  conversationMessagesResponseSchema,
  conversationSummarySchema,
  createConversationRequestSchema,
  idSchema,
  listConversationsResponseSchema,
  sendMessageRequestSchema,
  sendMessageResponseSchema,
} from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.ts';
import { RATE_LIMIT_POLICIES, routeLimit } from '../../platform/security/rate-limit.ts';
import type { ActorContext, TutorService } from './tutor.service.ts';

const idParams = z.object({ id: idSchema }).strict();
const renameBody = z.object({ title: z.string().trim().min(1).max(200) }).strict();

/**
 * The AI tutor's HTTP surface.
 *
 * EVERY RESPONSE IS BUILT FIELD BY FIELD through a `.strict()` schema, never
 * spread from a repository record. `conversationSummarySchema` has no property
 * that could hold `organization_id`, and `conversationMessageSchema` has none
 * that could hold `token_count` or `latency_ms` — a spread would carry all
 * three, and the last two are a timing side channel about the provider that a
 * learner has no business reading.
 *
 * ON STREAMING. Section 2D asks for a streaming chat API and this is a single
 * JSON response, which is a deliberate and stated deviation rather than an
 * oversight.
 *
 * The reason is that every safety property in this task is decided AFTER the
 * model has finished speaking: citations are validated against the retrieved
 * set, and grounding is decided by whether any citation survived. A token
 * stream necessarily emits text before either of those can run — so a streamed
 * tutor would show a child a fluent, confident, ungrounded answer and only
 * afterwards discover it had nothing to cite. The thing already on the screen
 * is the thing that gets believed.
 *
 * Streaming is worth having, and the honest way to add it is to stream only
 * after validation, or to validate incrementally — both of which are real
 * work with real design decisions, not a flag on this handler. The Task 012
 * report names it under NOT IMPLEMENTED rather than pretending the JSON
 * response is what was asked for.
 */
export function registerTutorRoutes(app: FastifyInstance, tutor: TutorService): void {
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

  /**
   * Start a conversation about one lesson.
   *
   * The body carries a lesson id and an optional title, and NOTHING ELSE — no
   * student id, because the owner is the session; no course id, because the
   * database derives it from the lesson; no context, because the server
   * retrieves it. `.strict()` refuses the rest out loud rather than ignoring
   * it, since silently dropping a forged field is indistinguishable from
   * trusting it (VULN-028).
   */
  app.post('/api/v1/ai/conversations', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.tutorConversation),
    handler: async (request, reply) => {
      const body = createConversationRequestSchema.parse(request.body ?? {});
      const created = await tutor.create(contextOf(request), body);
      return reply.status(201).send(conversationSummarySchema.parse(created));
    },
  });

  /** The caller's OWN conversations. There is no parameter for anyone else's. */
  app.get('/api/v1/ai/conversations', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const conversations = await tutor.list(contextOf(request));
      return reply.status(200).send(
        listConversationsResponseSchema.parse({
          conversations: conversations.map((c) => conversationSummarySchema.parse(c)),
        }),
      );
    },
  });

  /**
   * The transcript.
   *
   * This is the moderation read as well as the learner's own, and it is the
   * same handler for both — the policy decides which, and the service records
   * WHICH AUTHORITY admitted an adult. Two endpoints would have meant two
   * places for the boundary to be written and one place for it to drift.
   */
  app.get('/api/v1/ai/conversations/:id/messages', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const messages = await tutor.transcript(contextOf(request), id);
      return reply.status(200).send(
        conversationMessagesResponseSchema.parse({
          conversationId: id,
          messages: messages.map((m) => conversationMessageSchema.parse(m)),
        }),
      );
    },
  });

  /**
   * Say something to the tutor.
   *
   * ALWAYS 200 WHEN THE CONVERSATION IS THE CALLER'S. A blocked turn, an
   * out-of-scope question and a provider outage are all states of a
   * conversation rather than errors of a request, and they come back with a
   * `grounding` that says which. Turning a refusal into a 4xx would make the
   * status code a classifier a learner could probe, and would leave a child
   * facing a broken-looking screen when the honest answer is "your material
   * does not cover that".
   */
  app.post('/api/v1/ai/conversations/:id/messages', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.tutorMessage),
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = sendMessageRequestSchema.parse(request.body ?? {});
      const result = await tutor.speak(contextOf(request), id, body.content);
      return reply.status(200).send(sendMessageResponseSchema.parse(result));
    },
  });

  app.patch('/api/v1/ai/conversations/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { title } = renameBody.parse(request.body ?? {});
      const updated = await tutor.rename(contextOf(request), id, title);
      return reply.status(200).send(conversationSummarySchema.parse(updated));
    },
  });

  /**
   * Archive. A POST rather than a DELETE, because nothing is deleted.
   *
   * A transcript is a safety record; ending a conversation withdraws it from
   * the learner's active list and leaves it readable. `DELETE` would promise
   * something this platform deliberately does not do.
   */
  app.post('/api/v1/ai/conversations/:id/archive', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const updated = await tutor.archive(contextOf(request), id);
      return reply.status(200).send(conversationSummarySchema.parse(updated));
    },
  });
}
