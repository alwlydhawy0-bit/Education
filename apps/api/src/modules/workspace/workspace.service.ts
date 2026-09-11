import { forbidden, notFound, validationFailed } from '@edu/kernel';
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
  CreateNotebookRequest,
  ListArtifactsQuery,
  ListNotebooksQuery,
  RegisterArtifactRequest,
  UpdateNotebookRequest,
} from '@edu/contracts';
import type { Database, Tx } from '../../platform/db.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import type {
  NotebookRecord,
  QuotaRecord,
  StudentArtifactRecord,
  WorkspaceRepository,
} from './workspace.repository.ts';

export interface ActorContext {
  readonly actor: Actor;
  readonly loadRelationships: () => Promise<RelationshipSnapshot>;
  readonly correlationId: string;
  readonly ip: string | null;
}

export interface WorkspaceServiceDeps {
  readonly db: Database;
  readonly repository: WorkspaceRepository;
  readonly engine: PolicyEngine;
  readonly securityEvents: SecurityEventRecorder;
}

export interface WorkspaceService {
  createNotebook(ctx: ActorContext, input: CreateNotebookRequest): Promise<NotebookRecord>;
  listNotebooks(ctx: ActorContext, query: ListNotebooksQuery): Promise<NotebookRecord[]>;
  readNotebook(ctx: ActorContext, id: string): Promise<NotebookRecord>;
  updateNotebook(
    ctx: ActorContext,
    id: string,
    input: UpdateNotebookRequest,
  ): Promise<NotebookRecord>;
  deleteNotebook(ctx: ActorContext, id: string): Promise<void>;

  registerArtifact(
    ctx: ActorContext,
    input: RegisterArtifactRequest,
  ): Promise<StudentArtifactRecord>;
  listArtifacts(ctx: ActorContext, query: ListArtifactsQuery): Promise<StudentArtifactRecord[]>;
  readArtifact(ctx: ActorContext, id: string): Promise<StudentArtifactRecord>;
  deleteArtifact(ctx: ActorContext, id: string): Promise<void>;
  quota(ctx: ActorContext): Promise<QuotaRecord>;
}

/** PostgreSQL SQLSTATEs this module maps to client-fixable answers. */
const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';
const INTEGRITY_VIOLATION = '23514';
const RAISED_INTEGRITY = '23000';
const DISK_FULL = '53100';

function pgCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : null;
}

export function createWorkspaceService(deps: WorkspaceServiceDeps): WorkspaceService {
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
   * Every denial is recorded with IDS ONLY.
   *
   * Never a title, never a body, never a filename. This is a minor's private
   * writing, and the audit trail is read by more people than the notebook is —
   * a denial record that carried the thing it refused would be a way to read it.
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
      if (decision.effect === 'deny' && decision.disclosure === 'reveal') throw forbidden();
      throw notFound();
    }
    return decision;
  }

  /**
   * The by-id pipeline, in one place: resolve, decide, unwrap.
   *
   * `Guarded.unwrap` re-checks that the decision was made for THIS id and THIS
   * action, so a handler cannot authorize one object and return another. An
   * absent row and a refused one answer the same way — and both are recorded,
   * because a burst of them from one actor across many ids is the primary
   * IDOR/BOLA probing signal and RLS filtering the row first would otherwise
   * make it silent.
   */
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
   * Turns the database's refusals into the answers a client can act on.
   *
   * Each of these is a rule the database owns — and owns for good reason, since
   * the quota and the parent-ownership checks must hold against writers this
   * service is not. Without this mapping they would surface as 500s, which
   * tells the caller nothing and hides a working control behind an apparent
   * fault.
   */
  function translate(error: unknown): never {
    const code = pgCode(error);
    const message = error instanceof Error ? error.message : '';

    if (code === DISK_FULL) {
      throw validationFailed('You have used all of your workspace storage allowance');
    }
    if (code === UNIQUE_VIOLATION && message.includes('student_notebooks_owner_title_uk')) {
      throw validationFailed('You already have a notebook with that name');
    }
    if (code === FK_VIOLATION && message.includes('same_owner_fk')) {
      // The composite foreign key refusing a parent that belongs to somebody
      // else. `hide`-equivalent: a 404, because confirming that the id names a
      // real note is the one bit the caller is fishing for.
      throw notFound();
    }
    if (code === FK_VIOLATION) {
      throw validationFailed('That reference does not name anything you can attach to');
    }
    if (
      (code === INTEGRITY_VIOLATION || code === RAISED_INTEGRITY) &&
      /not studying/i.test(message)
    ) {
      throw validationFailed('You cannot attach a note to coursework you are not studying');
    }
    if (code === INTEGRITY_VIOLATION && message.includes('notes_single_anchor_ck')) {
      throw validationFailed('A note is anchored to a course, a unit or a lesson — at most one');
    }
    throw error;
  }

  async function guarded<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      return translate(error);
    }
  }

  return {
    async createNotebook(ctx, input) {
      return guarded(() =>
        db.withActor(ctx.actor.id, (tx) =>
          // Ownership comes from the session, never from the request body — and
          // the contract has no field for it either. The RLS INSERT policy
          // (`owner_id = app_current_actor()`) rejects any other value.
          repository.createNotebook(tx, ctx.actor.id, ctx.actor.organizationId, input),
        ),
      );
    },

    async listNotebooks(ctx, query) {
      // Scoped to the caller by construction: the repository takes the actor's
      // own id and RLS independently confirms it. There is no per-object
      // decision because there is no object the caller could name.
      return db.withActor(ctx.actor.id, (tx) => repository.listNotebooks(tx, ctx.actor.id, query));
    },

    async readNotebook(ctx, id) {
      return db.withActor(ctx.actor.id, async (tx) =>
        authorize(ctx, await repository.findNotebook(tx, id), 'notebook:read', 'notebook', id),
      );
    },

    async updateNotebook(ctx, id, input) {
      return guarded(() =>
        db.withActor(ctx.actor.id, async (tx) => {
          await authorize(
            ctx,
            await repository.findNotebook(tx, id),
            'notebook:update',
            'notebook',
            id,
          );
          const saved = await repository.updateNotebook(tx, id, input);
          if (!saved) throw notFound();
          return saved;
        }),
      );
    },

    async deleteNotebook(ctx, id) {
      await db.withActor(ctx.actor.id, async (tx) => {
        await authorize(
          ctx,
          await repository.findNotebook(tx, id),
          'notebook:delete',
          'notebook',
          id,
        );
        await repository.deleteNotebook(tx, id);
      });
    },

    async registerArtifact(ctx, input) {
      return guarded(() =>
        db.withActor(ctx.actor.id, async (tx) => {
          const saved = await repository.registerArtifact(tx, ctx.actor.id, input);
          await emit(ctx, SecurityEventType.WORKSPACE_ARTIFACT_REGISTERED, {
            resourceKind: 'student_artifact',
            resourceId: saved.id,
            artifactType: saved.artifactType,
            byteSize: saved.byteSize,
            // The declared type and the size, never the filename and never the
            // metadata. Both are the learner's own words about their own file.
            declaredContentType: saved.declaredContentType,
          });
          return saved;
        }),
      );
    },

    async listArtifacts(ctx, query) {
      return db.withActor(ctx.actor.id, (tx) => repository.listArtifacts(tx, ctx.actor.id, query));
    },

    async readArtifact(ctx, id) {
      return db.withActor(ctx.actor.id, async (tx) =>
        authorize(
          ctx,
          await repository.findArtifact(tx, id),
          'student_artifact:read',
          'student_artifact',
          id,
        ),
      );
    },

    async deleteArtifact(ctx, id) {
      await db.withActor(ctx.actor.id, async (tx) => {
        await authorize(
          ctx,
          await repository.findArtifact(tx, id),
          'student_artifact:delete',
          'student_artifact',
          id,
        );
        await repository.deleteArtifact(tx, id);
      });
    },

    async quota(ctx) {
      // The actor's own id, always. There is no route and no parameter through
      // which another learner's id could reach this call.
      return db.withActor(ctx.actor.id, (tx) => repository.quotaFor(tx, ctx.actor.id));
    },
  };
}

export type { Tx };
