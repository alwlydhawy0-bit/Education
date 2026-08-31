import { conflict, forbidden, notFound } from '@edu/kernel';
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
import type { CreateGuardianLinkRequest } from '@edu/contracts';
import type { Database } from '../../platform/db.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import {
  DuplicateLinkError,
  UnknownChildError,
  type GuardianLinkRecord,
  type GuardiansRepository,
} from './guardians.repository.ts';

export interface ActorContext {
  readonly actor: Actor;
  readonly loadRelationships: () => Promise<RelationshipSnapshot>;
  readonly correlationId: string;
  readonly ip: string | null;
}

export interface GuardiansServiceDeps {
  readonly db: Database;
  readonly repository: GuardiansRepository;
  readonly engine: PolicyEngine;
  readonly securityEvents: SecurityEventRecorder;
}

export interface GuardiansService {
  requestLink(ctx: ActorContext, input: CreateGuardianLinkRequest): Promise<void>;
  listForSelf(ctx: ActorContext, limit: number, offset: number): Promise<GuardianLinkRecord[]>;
  listForUser(
    ctx: ActorContext,
    userId: string,
    limit: number,
    offset: number,
  ): Promise<GuardianLinkRecord[]>;
  verify(ctx: ActorContext, linkId: string): Promise<GuardianLinkRecord>;
  revoke(ctx: ActorContext, linkId: string): Promise<void>;
}

export function createGuardiansService(deps: GuardiansServiceDeps): GuardiansService {
  const { db, repository, engine, securityEvents } = deps;

  const emit = (
    ctx: ActorContext,
    type: SecurityEventType,
    detail: Record<string, unknown>,
  ): Promise<void> =>
    securityEvents.record({
      type,
      actorId: ctx.actor.id,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
      detail,
      occurredAt: new Date(),
    });

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
      detail: { action, resourceKind: 'guardian_relationship', resourceId, reason },
      occurredAt: new Date(),
    });
  }

  async function decide(ctx: ActorContext, action: Action, resource: Resource): Promise<Decision> {
    const authContext: AuthorizationContext = {
      actor: ctx.actor,
      relationships: await ctx.loadRelationships(),
    };
    const decision = engine.decide(authContext, action, resource);
    if (decision.effect !== 'allow') {
      await recordDenial(ctx, decision.action, decision.resourceId, decision.reason);
      if (decision.effect === 'deny' && decision.disclosure === 'reveal') throw forbidden();
      throw notFound();
    }
    return decision;
  }

  return {
    /**
     * A guardian claims a link to a child.
     *
     * Returns nothing, and the route answers 202 REGARDLESS of whether the child
     * exists or a claim already existed. Reporting either would turn this into
     * an oracle for "is this user id real?", callable by anyone holding the
     * guardian role. The claim is created only when the child is real, and the
     * guardian sees the outcome by listing their own links.
     *
     * The claim is always `pending` and grants nothing until an administrator
     * verifies it.
     */
    async requestLink(ctx, input) {
      await db.withActor(ctx.actor.id, async (tx) => {
        // Resolved before the decision so the policy can confine an
        // administrator to their own school without consulting RLS. A guardian
        // claiming about themselves is allowed whatever this answers, so the
        // "always 202" property is untouched for them; an administrator naming
        // a child outside their organization (or one that does not exist) is
        // denied, which tells them nothing they could not already learn from
        // `GET /admin/users`.
        const childOrganizationId = await repository.organizationOfUser(tx, input.childId);
        await decide(ctx, 'guardian_relationship:create', {
          kind: 'guardian_relationship',
          id: `${ctx.actor.id}:${input.childId}`,
          guardianId: ctx.actor.id,
          childId: input.childId,
          childOrganizationId,
          state: 'pending',
        });

        try {
          const created = await repository.create(
            tx,
            // The guardian is always the SESSION's user. The request cannot name
            // somebody else as the guardian.
            ctx.actor.id,
            input.childId,
            input.relationshipType,
          );
          await emit(ctx, SecurityEventType.GUARDIAN_LINK_CREATED, {
            linkId: created.id,
            childId: input.childId,
          });
        } catch (error) {
          if (error instanceof UnknownChildError || error instanceof DuplicateLinkError) {
            // Recorded so a burst of these is visible as probing, while the
            // response stays uninformative.
            await recordDenial(
              ctx,
              'guardian_relationship:create',
              input.childId,
              error instanceof UnknownChildError ? 'unknown_child' : 'duplicate_claim',
            );
            return;
          }
          throw error;
        }
      });
    },

    async listForSelf(ctx, limit, offset) {
      return db.withActor(ctx.actor.id, (tx) =>
        repository.listForUser(tx, ctx.actor.id, limit, offset),
      );
    },

    /**
     * Links for a named user.
     *
     * RLS restricts the rows to ones the actor participates in or administers,
     * so a teacher asking about their own student receives nothing. Each row is
     * then authorized individually, so the two gates agree.
     */
    async listForUser(ctx, userId, limit, offset) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const rows = await repository.listForUser(tx, userId, limit, offset);
        const visible: GuardianLinkRecord[] = [];
        for (const row of rows) {
          const authContext: AuthorizationContext = {
            actor: ctx.actor,
            relationships: await ctx.loadRelationships(),
          };
          const decision = engine.decide(authContext, 'guardian_relationship:read', {
            kind: 'guardian_relationship',
            id: row.id,
            guardianId: row.guardianId,
            childId: row.childId,
            childOrganizationId: row.childOrganizationId,
            state: row.status,
          });
          if (decision.effect === 'allow') visible.push(row);
        }
        return visible;
      });
    },

    async verify(ctx, linkId) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const guarded = await repository.findById(tx, linkId);
        if (!guarded) {
          await recordDenial(ctx, 'guardian_relationship:verify', linkId, 'absent_or_not_visible');
          throw notFound();
        }

        // The policy refuses BOTH participants outright: verification is what
        // turns a claim into access over a minor's work, so a guardian
        // confirming their own claim is the whole attack on this table.
        const decision = await decide(ctx, 'guardian_relationship:verify', guarded.resource);
        guarded.unwrap(decision, 'guardian_relationship:verify');

        const verified = await repository.verify(tx, linkId, ctx.actor.id);
        if (!verified) throw conflict('Only a pending link can be verified');

        await emit(ctx, SecurityEventType.GUARDIAN_LINK_VERIFIED, {
          linkId,
          guardianId: verified.guardianId,
          childId: verified.childId,
        });
        return verified;
      });
    },

    async revoke(ctx, linkId) {
      await db.withActor(ctx.actor.id, async (tx) => {
        const guarded = await repository.findById(tx, linkId);
        if (!guarded) {
          await recordDenial(ctx, 'guardian_relationship:revoke', linkId, 'absent_or_not_visible');
          throw notFound();
        }

        // Revocation only ever REMOVES access, so either participant may do it —
        // a student can cut off an adult without needing anyone's approval.
        const decision = await decide(ctx, 'guardian_relationship:revoke', guarded.resource);
        const link = guarded.unwrap(decision, 'guardian_relationship:revoke');

        const revoked = await repository.revoke(tx, linkId);
        if (!revoked) throw conflict('Link is already revoked');

        await emit(ctx, SecurityEventType.GUARDIAN_LINK_REVOKED, {
          linkId,
          guardianId: link.guardianId,
          childId: link.childId,
        });
      });
    },
  };
}
