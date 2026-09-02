import type { FastifyInstance, FastifyRequest } from 'fastify';
import { askAssistantRequestSchema, askAssistantResponseSchema } from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.ts';
import { actorRateLimiter, RATE_LIMIT_POLICIES } from '../../platform/security/rate-limit.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import type { ActorContext, AssistantService } from './assistant.service.ts';

/**
 * The learning assistant's only route.
 *
 * ONE ENDPOINT, and the smallness is the point. There is no conversation
 * endpoint, no history endpoint, no "explain this to me differently", no model
 * selector and no context endpoint — each of those is a surface, and a
 * foundation should have as few as the job requires.
 *
 * WHAT THE CLIENT MAY SEND is a question and a lesson id, and `.strict()` makes
 * anything else a 400. There is no field for a learner id, an organization, a
 * class, a role, a source, a system prompt or a model, so those are not
 * "ignored" — they are unrepresentable.
 *
 * WHAT THE CLIENT GETS BACK is parsed through the strict response schema on the
 * way out. That is the last line of defence against a future change leaking an
 * internal field: the prompt, the retrieval internals, the provider name and
 * the raw completion have no place in the schema, so a change that started
 * returning one would fail here rather than reaching a browser.
 */
export interface AssistantRouteDeps {
  readonly assistant: AssistantService;
  readonly securityEvents: SecurityEventRecorder;
  readonly rateLimitEnabled: boolean;
}

export function registerAssistantRoutes(app: FastifyInstance, deps: AssistantRouteDeps): void {
  const { assistant, securityEvents, rateLimitEnabled } = deps;

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
   * Two preHandlers, and the ORDER is load-bearing.
   *
   * `requireActor` first, because the limiter is keyed by the authenticated
   * actor and has nobody to key on until authentication has run. Reversing them
   * would silently make the quota a no-op — the limiter would see a null actor
   * and defer on every request.
   */
  const limitPerActor = actorRateLimiter(RATE_LIMIT_POLICIES.aiRequest, {
    enabled: rateLimitEnabled,
    securityEvents,
  });

  app.post('/api/v1/assistant/ask', {
    preHandler: [requireActor, limitPerActor],
    handler: async (request, reply) => {
      const input = askAssistantRequestSchema.parse(request.body);
      const answer = await assistant.ask(contextOf(request), input);

      // Field by field through the strict schema. Nothing is spread from an
      // internal record, so a field added to `AssistantAnswer` later does not
      // silently become public.
      return reply.status(200).send(
        askAssistantResponseSchema.parse({
          grounding: answer.grounding,
          answer: answer.answer,
          sources: answer.sources.map((source) => ({
            id: source.id,
            kind: source.kind,
            lessonId: source.lessonId,
            lessonTitle: source.lessonTitle,
            excerpt: source.excerpt,
          })),
          searchedSources: answer.searchedSources,
        }),
      );
    },
  });
}
