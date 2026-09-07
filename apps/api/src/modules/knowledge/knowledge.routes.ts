import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  idSchema,
  indexCourseRequestSchema,
  indexCourseResponseSchema,
  ragChunkSchema,
  ragRetrieveRequestSchema,
  ragRetrieveResponseSchema,
} from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.ts';
import { RATE_LIMIT_POLICIES, routeLimit } from '../../platform/security/rate-limit.ts';
import type { ActorContext, KnowledgeService } from './knowledge.service.ts';
import type { RetrievedVectorChunk } from './knowledge.repository.ts';

const idParams = z.object({ id: idSchema }).strict();

/**
 * Every response is built FIELD BY FIELD through a `.strict()` schema.
 *
 * `ragChunkSchema` has no property that could hold an embedding, a source
 * timestamp or an organization id. A spread of a repository record would carry
 * all three — the vector especially, which is the one field that would let a
 * caller reconstruct the index it is not allowed to enumerate.
 */
const toChunk = (c: RetrievedVectorChunk): unknown =>
  ragChunkSchema.parse({
    id: c.id,
    kind: c.kind,
    courseId: c.courseId,
    courseTitle: c.courseTitle,
    unitId: c.unitId,
    lessonId: c.lessonId,
    lessonTitle: c.lessonTitle,
    chunkIndex: c.chunkIndex,
    content: c.content,
    distance: c.distance,
  });

export function registerKnowledgeRoutes(app: FastifyInstance, knowledge: KnowledgeService): void {
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
   * Rebuilding a course's index.
   *
   * Authorized as `course:index`, which takes PUBLISH standing — indexing
   * decides what the assistant may quote to a child, which is a publication
   * decision wearing an operational hat. It is deliberately not `course:publish`
   * re-used: that action requires a DRAFT, and indexing requires the opposite.
   *
   * Rate-limited because it is the most expensive request on the platform: it
   * reads a whole course, chunks every published lesson and embeds every chunk.
   */
  app.post('/api/v1/curriculum/courses/:id/index', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.knowledgeIndex),
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      // Takes NOTHING from the client but the URL and the session. Parsed
      // rather than ignored, so a forged `organizationId` is refused out loud
      // instead of being dropped in a way a later change could start trusting
      // (VULN-028).
      indexCourseRequestSchema.parse(request.body ?? {});
      const result = await knowledge.indexCourse(contextOf(request), id);
      return reply.status(200).send(indexCourseResponseSchema.parse(result));
    },
  });

  /**
   * Semantic retrieval.
   *
   * A POST rather than a GET, and not for length: a query string lands in
   * access logs, proxy logs and browser history, and a learner's question is a
   * record of what they did not understand. The body keeps it out of all three.
   *
   * ALWAYS 200. A caller with no courses in scope, or one naming a course they
   * cannot reach, receives an empty `chunks` array rather than a 403 — because
   * a 403 would confirm the course id names something real, which is the one
   * bit somebody enumerating another school's catalog is trying to buy.
   * `coursesInScope` lets a legitimate client tell "you are enrolled in
   * nothing" from "nothing matched" without disclosing anything about anyone
   * else.
   */
  app.post('/api/v1/rag/retrieve', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.knowledgeRetrieve),
    handler: async (request, reply) => {
      const input = ragRetrieveRequestSchema.parse(request.body);
      const result = await knowledge.retrieve(contextOf(request), input);
      return reply.status(200).send(
        ragRetrieveResponseSchema.parse({
          chunks: result.chunks.map(toChunk),
          coursesInScope: result.coursesInScope,
          embeddingModel: result.embeddingModel,
        }),
      );
    },
  });
}
