import type { FastifyInstance, FastifyRequest } from 'fastify';
import { unauthenticated } from '@edu/kernel';
import { EMPTY_RELATIONSHIPS, type Actor, type RelationshipSnapshot } from '@edu/authz';
import { SecurityEventType } from '@edu/observability';
import type { Database, Tx } from '../db.ts';
import type { SecurityEventRecorder } from '../security/security-events.ts';

/**
 * Authentication wiring.
 *
 * DEPENDENCY INVERSION: this file declares the two narrow interfaces it needs
 * and imports NOTHING from `modules/`. The identity module happens to satisfy
 * `SessionAuthenticator`, and the relationships module happens to satisfy
 * `RelationshipLoader`, but `platform` does not know that — the composition
 * root does the matching.
 *
 * That direction matters: `platform` sits BELOW the domain modules in the
 * dependency order (see docs/architecture/dependency-rules.md), so an import
 * pointing the other way would be a cycle waiting to happen and would block
 * extracting any module into its own service later. The rule is enforced
 * mechanically by tests/architecture/dependency-rules.test.ts.
 */

/** Satisfied by the identity module's service. */
export interface SessionAuthenticator {
  authenticate(token: string): Promise<{ actor: Actor } | null>;
}

/** Satisfied by the relationships module's reader. */
export interface RelationshipLoader {
  loadSnapshot(tx: Tx, actorId: string): Promise<RelationshipSnapshot>;
}

export interface AuthenticationDeps {
  readonly identity: SessionAuthenticator;
  readonly relationships: RelationshipLoader;
  readonly db: Database;
  readonly securityEvents: SecurityEventRecorder;
  readonly cookieName: string;
}

/**
 * Populates `request.actor` from the session cookie, if one is present and
 * valid. It does NOT reject anonymous requests — that is `requireActor`'s job,
 * applied per route.
 *
 * The split matters: authentication is ambient, authorization is explicit. A
 * route that forgets `requireActor` gets `request.actor === null` and fails at
 * the first authorization call, rather than silently running as nobody.
 */
export function registerAuthentication(app: FastifyInstance, deps: AuthenticationDeps): void {
  const { identity, relationships, db, securityEvents, cookieName } = deps;

  app.addHook('preHandler', async (request: FastifyRequest) => {
    const token = request.cookies[cookieName];

    // Memoized per request: several authorization decisions in one request must
    // not each pay for a relationship query.
    let cached: RelationshipSnapshot | null = null;
    request.loadRelationships = async (): Promise<RelationshipSnapshot> => {
      if (cached) return cached;
      const actor = request.actor;
      if (!actor) return EMPTY_RELATIONSHIPS;
      cached = await db.withActor(actor.id, (tx) => relationships.loadSnapshot(tx, actor.id));
      return cached;
    };

    if (!token) return;

    const resolved = await identity.authenticate(token);
    if (!resolved) {
      // A cookie that does not resolve is a revoked, expired, or forged token.
      // Worth recording: a burst of these is credential stuffing, or a stolen
      // cookie being replayed after revocation.
      await securityEvents.record({
        type: SecurityEventType.AUTH_SESSION_REJECTED,
        actorId: null,
        correlationId: request.correlationId,
        ip: request.ip,
        detail: {},
        occurredAt: new Date(),
      });
      return;
    }

    request.actor = resolved.actor;
  });
}

/** Route-level guard. Use on every route that touches non-public data. */
export async function requireActor(request: FastifyRequest): Promise<void> {
  if (!request.actor) throw unauthenticated();
}
