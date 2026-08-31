import { forbidden, notFound } from '@edu/kernel';
import {
  type Actor,
  type AuthorizationContext,
  type Decision,
  type NoteAction,
  type PolicyEngine,
  type RelationshipSnapshot,
} from '@edu/authz';
import { SecurityEventType } from '@edu/observability';
import type { CreateNoteRequest, ListNotesQuery, UpdateNoteRequest } from '@edu/contracts';
import type { Database } from '../../platform/db.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import type { NoteRecord, NotebookRepository } from './notebook.repository.ts';

export interface ActorContext {
  readonly actor: Actor;
  readonly loadRelationships: () => Promise<RelationshipSnapshot>;
  readonly correlationId: string;
  readonly ip: string | null;
}

export interface NotebookServiceDeps {
  readonly db: Database;
  readonly repository: NotebookRepository;
  readonly engine: PolicyEngine;
  readonly securityEvents: SecurityEventRecorder;
}

export interface NotebookService {
  get(ctx: ActorContext, noteId: string): Promise<NoteRecord>;
  list(ctx: ActorContext, query: ListNotesQuery): Promise<NoteRecord[]>;
  create(ctx: ActorContext, input: CreateNoteRequest): Promise<NoteRecord>;
  update(ctx: ActorContext, noteId: string, input: UpdateNoteRequest): Promise<NoteRecord>;
  remove(ctx: ActorContext, noteId: string): Promise<void>;
}

export function createNotebookService(deps: NotebookServiceDeps): NotebookService {
  const { db, repository, engine, securityEvents } = deps;

  /**
   * Turns a deny into the right HTTP error, and records it.
   *
   * `disclosure: 'hide'` becomes 404, not 403. Returning 403 would confirm that
   * the id names a real note, which is exactly the signal an attacker
   * enumerating ids is looking for. 403 is reserved for cases where the actor
   * already knows the object exists (their own archived note, say).
   */
  async function recordDenial(
    ctx: ActorContext,
    action: NoteAction,
    resourceId: string,
    reason: string,
  ): Promise<void> {
    // Routed through the recorder so a run of denials by one actor escalates
    // to AUTHZ_REPEATED_DENIAL. This is the single denial funnel for the domain,
    // which is what makes that detection complete.
    await securityEvents.record({
      type: SecurityEventType.AUTHZ_DENIED,
      actorId: ctx.actor.id,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
      // Ids and rule names only — never the note's title or body. A denial
      // record must not become a copy of the content it denied access to.
      detail: { action, resourceKind: 'note', resourceId, reason },
      occurredAt: new Date(),
    });
  }

  async function denyToError(ctx: ActorContext, decision: Decision): Promise<never> {
    await recordDenial(ctx, decision.action as NoteAction, decision.resourceId, decision.reason);

    if (decision.effect === 'deny' && decision.disclosure === 'reveal') {
      throw forbidden();
    }
    throw notFound();
  }

  /**
   * The single path by which any individual note is read or mutated.
   *
   * Load -> build context from SERVER state -> decide -> unwrap. Every mutating
   * operation below funnels through here, so there is exactly one place to
   * review for the object-level authorization of this domain.
   */
  async function authorizeNote(
    ctx: ActorContext,
    tx: Parameters<NotebookRepository['findById']>[0],
    noteId: string,
    action: NoteAction,
  ): Promise<{ note: NoteRecord; decision: Decision }> {
    const guarded = await repository.findById(tx, noteId);

    // A note that does not exist and a note the RLS layer hid from us are
    // indistinguishable here — by design, so that the API cannot be used to
    // probe which ids are real.
    //
    // But it is recorded. Without this, an attacker enumerating note ids would
    // generate NO security signal at all whenever RLS filtered the row before
    // the policy engine ran — the request would simply 404 in silence. A burst
    // of these from one actor across many ids is the primary IDOR/BOLA probing
    // indicator, so the event is emitted even though the RESPONSE stays
    // deliberately uninformative.
    //
    // It also fires for genuinely nonexistent ids (a stale bookmark, a typo),
    // which is why detection should threshold on rate and distinct-id count
    // rather than on any single occurrence.
    if (!guarded) {
      await recordDenial(ctx, action, noteId, 'note.absent_or_not_visible');
      throw notFound();
    }

    const authContext: AuthorizationContext = {
      actor: ctx.actor,
      relationships: await ctx.loadRelationships(),
    };

    const decision = engine.decide(authContext, action, guarded.resource);
    if (decision.effect !== 'allow') await denyToError(ctx, decision);

    // `unwrap` re-verifies that this decision was made for THIS note and THIS
    // action before releasing the payload.
    return { note: guarded.unwrap(decision, action), decision };
  }

  return {
    async get(ctx, noteId) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const { note } = await authorizeNote(ctx, tx, noteId, 'note:read');
        return note;
      });
    },

    async list(ctx, query) {
      // Listing is scoped to the caller by construction: the repository takes
      // the actor's own id, and RLS independently confirms it. There is no
      // per-object decision because there is no object the caller could name.
      //
      // The query has already been validated against the sort/filter allow-list
      // by the route, so nothing here can reach SQL as an identifier.
      return db.withActor(ctx.actor.id, (tx) => repository.listOwn(tx, ctx.actor.id, query));
    },

    async create(ctx, input) {
      return db.withActor(ctx.actor.id, (tx) =>
        // Ownership comes from the session, never from the request body — and
        // the contract has no field for it either. The RLS INSERT policy
        // (`owner_id = app_current_actor()`) rejects any other value.
        repository.insert(tx, {
          ownerId: ctx.actor.id,
          organizationId: ctx.actor.organizationId,
          title: input.title,
          body: input.body,
          visibility: input.visibility,
        }),
      );
    },

    async update(ctx, noteId, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        await authorizeNote(ctx, tx, noteId, 'note:update');
        const updated = await repository.applyUpdate(tx, noteId, {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        });
        if (!updated) throw notFound();
        return updated;
      });
    },

    async remove(ctx, noteId) {
      await db.withActor(ctx.actor.id, async (tx) => {
        await authorizeNote(ctx, tx, noteId, 'note:delete');
        await repository.softDelete(tx, noteId);
      });
    },
  };
}
