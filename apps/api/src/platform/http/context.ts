import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Actor, RelationshipSnapshot } from '@edu/authz';

/**
 * Per-request context.
 *
 * `actor` is populated ONLY by the authentication hook, from a validated
 * session. Nothing else in the codebase writes it, and no route may construct
 * an Actor from request data.
 */
declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    actor: Actor | null;
    /**
     * Relationship edges for the actor, loaded lazily and memoized per request.
     * Lazy because most requests never need them; memoized because a single
     * request may make several authorization decisions.
     */
    loadRelationships(): Promise<RelationshipSnapshot>;
  }
}

export function registerRequestContext(app: FastifyInstance): void {
  app.decorateRequest('correlationId', '');
  app.decorateRequest('actor', null);
  app.decorateRequest('loadRelationships', async () => {
    throw new Error('loadRelationships was not initialized for this request.');
  });

  app.addHook('onRequest', async (request: FastifyRequest) => {
    // A client-supplied correlation id would let an attacker poison logs and
    // collide their trail with somebody else's. We accept nothing from the
    // request here; the id is ours.
    request.correlationId = randomUUID();
    request.actor = null;
  });
}
