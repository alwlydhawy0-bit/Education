import { conflict, forbidden, notFound } from '@edu/kernel';
import {
  type Action,
  type Actor,
  type AuthorizationContext,
  type Decision,
  type PolicyEngine,
  type RelationshipSnapshot,
  type Resource,
  type Role,
  type RoleScopeType,
} from '@edu/authz';
import { SecurityEventType } from '@edu/observability';
import type { AssignRoleRequest, UpdateProfileRequest } from '@edu/contracts';
import type { Database, Tx } from '../../platform/db.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import type { ProfileRecord, UserRecord, UsersRepository } from './users.repository.ts';

export interface ActorContext {
  readonly actor: Actor;
  readonly loadRelationships: () => Promise<RelationshipSnapshot>;
  readonly correlationId: string;
  readonly ip: string | null;
}

/** Grants a role. Backed by a SECURITY DEFINER function; see migration 0011. */
export interface RoleAdministration {
  assign(
    tx: Tx,
    userId: string,
    role: Role,
    scopeType: RoleScopeType,
    scopeId: string | null,
    grantedBy: string,
  ): Promise<void>;
  revoke(
    tx: Tx,
    userId: string,
    role: Role,
    scopeType: RoleScopeType,
    scopeId: string | null,
  ): Promise<boolean>;
}

export const roleAdministration: RoleAdministration = {
  async assign(tx, userId, role, scopeType, scopeId, grantedBy) {
    await tx.query('SELECT auth_assign_role($1, $2, $3, $4, $5)', [
      userId,
      role,
      scopeType,
      scopeId,
      grantedBy,
    ]);
  },
  async revoke(tx, userId, role, scopeType, scopeId) {
    const { rows } = await tx.query<{ auth_revoke_role: boolean }>(
      'SELECT auth_revoke_role($1, $2, $3, $4)',
      [userId, role, scopeType, scopeId],
    );
    return rows[0]?.auth_revoke_role ?? false;
  },
};

export interface UsersServiceDeps {
  readonly db: Database;
  readonly repository: UsersRepository;
  readonly roles: RoleAdministration;
  readonly engine: PolicyEngine;
  readonly securityEvents: SecurityEventRecorder;
}

export interface UsersService {
  getOwnProfile(ctx: ActorContext): Promise<ProfileRecord>;
  updateOwnProfile(ctx: ActorContext, input: UpdateProfileRequest): Promise<ProfileRecord>;
  getProfile(ctx: ActorContext, userId: string): Promise<ProfileRecord>;
  listUsers(ctx: ActorContext, limit: number, offset: number): Promise<UserRecord[]>;
  getUser(ctx: ActorContext, userId: string): Promise<UserRecord>;
  setUserStatus(
    ctx: ActorContext,
    userId: string,
    status: UserRecord['status'],
  ): Promise<UserRecord>;
  assignRole(ctx: ActorContext, userId: string, input: AssignRoleRequest): Promise<void>;
  revokeRole(ctx: ActorContext, userId: string, input: AssignRoleRequest): Promise<void>;
  listGrants(
    ctx: ActorContext,
    userId: string,
  ): Promise<{ role: Role; scopeType: string; scopeId: string | null }[]>;
}

export function createUsersService(deps: UsersServiceDeps): UsersService {
  const { db, repository, roles, engine, securityEvents } = deps;

  async function recordDenial(
    ctx: ActorContext,
    action: Action,
    resourceKind: string,
    resourceId: string,
    reason: string,
  ): Promise<void> {
    await securityEvents.record({
      type: SecurityEventType.AUTHZ_DENIED,
      actorId: ctx.actor.id,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
      // Ids and rule names only — never the record's contents.
      detail: { action, resourceKind, resourceId, reason },
      occurredAt: new Date(),
    });
  }

  async function denyToError(
    ctx: ActorContext,
    decision: Decision,
    resourceKind: string,
  ): Promise<never> {
    await recordDenial(ctx, decision.action, resourceKind, decision.resourceId, decision.reason);
    // `hide` becomes 404, not 403: a 403 would confirm the object exists, which
    // is exactly what an actor enumerating ids wants to learn.
    if (decision.effect === 'deny' && decision.disclosure === 'reveal') throw forbidden();
    throw notFound();
  }

  /**
   * The single gate for every individual object in this domain.
   *
   * Load -> build context from server state -> decide -> unwrap. `unwrap`
   * re-verifies the decision was made for THIS resource and THIS action before
   * releasing the payload.
   */
  async function authorize<T>(
    ctx: ActorContext,
    guarded: { resource: Resource; unwrap: (d: Decision, a: Action) => T } | null,
    action: Action,
    resourceKind: string,
    resourceId: string,
  ): Promise<T> {
    if (!guarded) {
      // A record that does not exist and one hidden by RLS are indistinguishable
      // to the caller — by design — but the probe is still recorded.
      await recordDenial(ctx, action, resourceKind, resourceId, 'absent_or_not_visible');
      throw notFound();
    }

    const authContext: AuthorizationContext = {
      actor: ctx.actor,
      relationships: await ctx.loadRelationships(),
    };
    const decision = engine.decide(authContext, action, guarded.resource);
    if (decision.effect !== 'allow') await denyToError(ctx, decision, resourceKind);
    return guarded.unwrap(decision, action);
  }

  return {
    async getOwnProfile(ctx) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const guarded = await repository.findProfileByUserId(tx, ctx.actor.id);
        return authorize(ctx, guarded, 'profile:read', 'profile', ctx.actor.id);
      });
    },

    async updateOwnProfile(ctx, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const guarded = await repository.findProfileByUserId(tx, ctx.actor.id);
        await authorize(ctx, guarded, 'profile:update', 'profile', ctx.actor.id);

        // The target is always the session's own user id — there is no field in
        // the contract that could point this at somebody else.
        const updated = await repository.updateProfile(tx, ctx.actor.id, {
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
          ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
          ...(input.bio !== undefined ? { bio: input.bio } : {}),
          ...(input.locale !== undefined ? { locale: input.locale } : {}),
        });
        if (!updated) throw notFound();
        return updated;
      });
    },

    async getProfile(ctx, userId) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const guarded = await repository.findProfileByUserId(tx, userId);
        return authorize(ctx, guarded, 'profile:read', 'profile', userId);
      });
    },

    async listUsers(ctx, limit, offset) {
      const organizationId = ctx.actor.organizationId;
      if (organizationId === null) {
        // An actor with no organization has no roster to list. Refusing here
        // avoids a query that would otherwise have to mean "everyone".
        await recordDenial(ctx, 'user:list', 'user', 'organization', 'actor.no_organization');
        throw notFound();
      }

      return db.withActor(ctx.actor.id, async (tx) => {
        // Listing is authorized once, against the actor's own organization,
        // before any row is read.
        const decision = engine.decide(
          { actor: ctx.actor, relationships: await ctx.loadRelationships() },
          'user:list',
          { kind: 'user', id: organizationId, organizationId, status: 'active' },
        );
        if (decision.effect !== 'allow') await denyToError(ctx, decision, 'user');
        return repository.listByOrganization(tx, organizationId, limit, offset);
      });
    },

    async getUser(ctx, userId) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const guarded = await repository.findUserById(tx, userId);
        return authorize(ctx, guarded, 'user:read', 'user', userId);
      });
    },

    async setUserStatus(ctx, userId, status) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const guarded = await repository.findUserById(tx, userId);
        const before = await authorize(ctx, guarded, 'user:suspend', 'user', userId);

        if (before.status === status) throw conflict('User already has that status');

        const changed = await repository.updateStatus(tx, userId, status);
        if (!changed) throw notFound();

        await securityEvents.record({
          type: SecurityEventType.USER_STATUS_CHANGED,
          // The ACTOR is the operator who made the change, not the affected
          // user — an investigator needs to know who acted.
          actorId: ctx.actor.id,
          correlationId: ctx.correlationId,
          ip: ctx.ip,
          detail: { targetUserId: userId, from: before.status, to: status },
          occurredAt: new Date(),
        });

        return { ...before, status };
      });
    },

    async assignRole(ctx, userId, input) {
      await db.withActor(ctx.actor.id, async (tx) => {
        const target = await repository.findUserById(tx, userId);
        if (!target) {
          await recordDenial(ctx, 'role_grant:assign', 'role_grant', userId, 'target_not_visible');
          throw notFound();
        }

        // The resource is the GRANT, not the user: "may this actor give THAT
        // role, in THAT scope, to THAT person?"
        const decision = engine.decide(
          { actor: ctx.actor, relationships: await ctx.loadRelationships() },
          'role_grant:assign',
          {
            kind: 'role_grant',
            id: `${userId}:${input.role}:${input.scopeType}:${input.scopeId ?? 'global'}`,
            targetUserId: userId,
            targetUserOrganizationId:
              target.resource.kind === 'user' ? target.resource.organizationId : null,
            role: input.role,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
          },
        );
        if (decision.effect !== 'allow') await denyToError(ctx, decision, 'role_grant');

        await roles.assign(tx, userId, input.role, input.scopeType, input.scopeId, ctx.actor.id);

        await securityEvents.record({
          type: SecurityEventType.ROLE_GRANTED,
          actorId: ctx.actor.id,
          correlationId: ctx.correlationId,
          ip: ctx.ip,
          detail: {
            targetUserId: userId,
            role: input.role,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
          },
          occurredAt: new Date(),
        });
      });
    },

    async revokeRole(ctx, userId, input) {
      await db.withActor(ctx.actor.id, async (tx) => {
        const target = await repository.findUserById(tx, userId);
        if (!target) {
          await recordDenial(ctx, 'role_grant:revoke', 'role_grant', userId, 'target_not_visible');
          throw notFound();
        }

        const decision = engine.decide(
          { actor: ctx.actor, relationships: await ctx.loadRelationships() },
          'role_grant:revoke',
          {
            kind: 'role_grant',
            id: `${userId}:${input.role}:${input.scopeType}:${input.scopeId ?? 'global'}`,
            targetUserId: userId,
            targetUserOrganizationId:
              target.resource.kind === 'user' ? target.resource.organizationId : null,
            role: input.role,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
          },
        );
        if (decision.effect !== 'allow') await denyToError(ctx, decision, 'role_grant');

        const removed = await roles.revoke(tx, userId, input.role, input.scopeType, input.scopeId);
        if (!removed) throw notFound();

        await securityEvents.record({
          type: SecurityEventType.ROLE_REVOKED,
          actorId: ctx.actor.id,
          correlationId: ctx.correlationId,
          ip: ctx.ip,
          detail: {
            targetUserId: userId,
            role: input.role,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
          },
          occurredAt: new Date(),
        });
      });
    },

    async listGrants(ctx, userId) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const guarded = await repository.findUserById(tx, userId);
        // Reading somebody's privileges is a `user:read` on that person: if you
        // may not see the account, you may not see what it can do.
        await authorize(ctx, guarded, 'user:read', 'user', userId);
        return repository.listGrants(tx, userId);
      });
    },
  };
}
