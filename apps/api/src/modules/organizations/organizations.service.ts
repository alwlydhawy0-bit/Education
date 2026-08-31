import { forbidden, notFound } from '@edu/kernel';
import {
  type Action,
  type Actor,
  type AuthorizationContext,
  type Decision,
  type PolicyEngine,
  type RelationshipSnapshot,
  type Resource,
} from '@edu/authz';
import { SecurityEventType } from '@edu/observability';
import type { CreateOrganizationRequest, UpdateOrganizationRequest } from '@edu/contracts';
import type { Database } from '../../platform/db.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import type { OrganizationRecord, OrganizationsRepository } from './organizations.repository.ts';

export interface ActorContext {
  readonly actor: Actor;
  readonly loadRelationships: () => Promise<RelationshipSnapshot>;
  readonly correlationId: string;
  readonly ip: string | null;
}

export interface OrganizationsServiceDeps {
  readonly db: Database;
  readonly repository: OrganizationsRepository;
  readonly engine: PolicyEngine;
  readonly securityEvents: SecurityEventRecorder;
}

export interface OrganizationsService {
  create(ctx: ActorContext, input: CreateOrganizationRequest): Promise<OrganizationRecord>;
  get(ctx: ActorContext, id: string): Promise<OrganizationRecord>;
  list(ctx: ActorContext, limit: number, offset: number): Promise<OrganizationRecord[]>;
  update(
    ctx: ActorContext,
    id: string,
    input: UpdateOrganizationRequest,
  ): Promise<OrganizationRecord>;
}

export function createOrganizationsService(deps: OrganizationsServiceDeps): OrganizationsService {
  const { db, repository, engine, securityEvents } = deps;

  async function recordDenial(
    ctx: ActorContext,
    action: Action,
    resourceId: string,
    reason: string,
  ): Promise<void> {
    await securityEvents.record({
      type: SecurityEventType.AUTHZ_DENIED,
      actorId: ctx.actor.id,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
      detail: { action, resourceKind: 'organization', resourceId, reason },
      occurredAt: new Date(),
    });
  }

  async function denyToError(ctx: ActorContext, decision: Decision): Promise<never> {
    await recordDenial(ctx, decision.action, decision.resourceId, decision.reason);
    if (decision.effect === 'deny' && decision.disclosure === 'reveal') throw forbidden();
    throw notFound();
  }

  async function decide(ctx: ActorContext, action: Action, resource: Resource): Promise<Decision> {
    const authContext: AuthorizationContext = {
      actor: ctx.actor,
      relationships: await ctx.loadRelationships(),
    };
    const decision = engine.decide(authContext, action, resource);
    if (decision.effect !== 'allow') await denyToError(ctx, decision);
    return decision;
  }

  return {
    async create(ctx, input) {
      // Authorized BEFORE the insert: there is no row to guard yet, so the
      // decision is made against a prospective resource. Only a platform
      // operator passes, and RLS refuses the insert independently.
      await decide(ctx, 'organization:create', { kind: 'organization', id: 'new' });

      return db.withActor(ctx.actor.id, async (tx) => {
        const created = await repository.insert(tx, input.name);
        await securityEvents.record({
          type: SecurityEventType.ORGANIZATION_CREATED,
          actorId: ctx.actor.id,
          correlationId: ctx.correlationId,
          ip: ctx.ip,
          detail: { organizationId: created.id },
          occurredAt: new Date(),
        });
        return created;
      });
    },

    async get(ctx, id) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const guarded = await repository.findById(tx, id);
        if (!guarded) {
          await recordDenial(ctx, 'organization:read', id, 'absent_or_not_visible');
          throw notFound();
        }
        const decision = await decide(ctx, 'organization:read', guarded.resource);
        return guarded.unwrap(decision, 'organization:read');
      });
    },

    async list(ctx, limit, offset) {
      // RLS scopes the result set — an ordinary actor sees only their own
      // organization, a platform operator sees all — and then the policy is
      // applied to every row that comes back.
      //
      // The second pass is deliberately redundant: without it, a listing would
      // be guarded by RLS ALONE, and the "two independent gates" claim would be
      // false for exactly the endpoint that returns the most rows. It is a
      // no-op whenever RLS is doing its job, which is the point.
      return db.withActor(ctx.actor.id, async (tx) => {
        const rows = await repository.list(tx, limit, offset);
        const authContext: AuthorizationContext = {
          actor: ctx.actor,
          relationships: await ctx.loadRelationships(),
        };
        return rows.filter(
          (row) =>
            engine.decide(authContext, 'organization:list', {
              kind: 'organization',
              id: row.id,
            }).effect === 'allow',
        );
      });
    },

    async update(ctx, id, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const guarded = await repository.findById(tx, id);
        if (!guarded) {
          await recordDenial(ctx, 'organization:update', id, 'absent_or_not_visible');
          throw notFound();
        }
        const decision = await decide(ctx, 'organization:update', guarded.resource);
        guarded.unwrap(decision, 'organization:update');

        const updated = await repository.updateName(tx, id, input.name);
        if (!updated) throw notFound();

        await securityEvents.record({
          type: SecurityEventType.ORGANIZATION_UPDATED,
          actorId: ctx.actor.id,
          correlationId: ctx.correlationId,
          ip: ctx.ip,
          detail: { organizationId: id },
          occurredAt: new Date(),
        });
        return updated;
      });
    },
  };
}
