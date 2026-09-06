import { forbidden, notFound, validationFailed } from '@edu/kernel';
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
import { checkMarkdown } from './markdown-safety.ts';

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

  /**
   * The markdown gate.
   *
   * Refuses a body carrying an executable scheme in a LINK DESTINATION — the
   * one XSS vector that survives HTML-escaping, because `[x](javascript:…)` is
   * markdown's own syntax rather than embedded HTML. See `markdown-safety.ts`
   * for why this rejects instead of stripping, and why prose and code fences
   * mentioning such a scheme are left alone.
   */
  async function guardMarkdown(ctx: ActorContext, body: string | undefined): Promise<void> {
    if (body === undefined) return;
    const rejection = checkMarkdown(body);
    if (!rejection) return;

    await securityEvents.record({
      type: SecurityEventType.WORKSPACE_MARKDOWN_REFUSED,
      actorId: ctx.actor.id,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
      // The SCHEME and nothing else. Not the note, not the URL, not the text
      // around it — this is a minor's private writing.
      detail: { scheme: rejection.scheme, reason: rejection.reason },
      occurredAt: new Date(),
    });

    throw validationFailed(
      `A link in this note uses the ${rejection.scheme}: scheme, which is not allowed`,
    );
  }

  /** PostgreSQL SQLSTATEs the workspace rules surface through. */
  const FK_VIOLATION = '23503';
  const INTEGRITY_VIOLATION = '23514';
  const RAISED_INTEGRITY = '23000';

  function pgCode(error: unknown): string | null {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : null;
  }

  /**
   * Turns the database's own refusals into answers a client can act on.
   *
   * Each is a rule the DATABASE owns, and owns for a reason — the composite
   * foreign keys hold against writers this service is not. Without this
   * mapping they would surface as 500s, hiding a working control behind an
   * apparent fault.
   */
  function translate(error: unknown): never {
    const code = pgCode(error);
    const message = error instanceof Error ? error.message : '';

    // A parent that belongs to somebody else. A 404, not a 422: confirming the
    // id names a real notebook is the one bit the caller is fishing for.
    if (code === FK_VIOLATION && message.includes('same_owner_fk')) throw notFound();
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
      await guardMarkdown(ctx, input.body);
      return guarded(() =>
        db.withActor(ctx.actor.id, (tx) =>
          // Ownership comes from the session, never from the request body — and
          // the contract has no field for it either. The RLS INSERT policy
          // (`owner_id = app_current_actor()`) rejects any other value.
          //
          // The ANCHOR does come from the body, and is checked twice against
          // the database rather than once here: `notes_insert_own` asks
          // `app_actor_may_anchor_here`, and `notes_anchor` asks it again in a
          // trigger. Neither is this service's opinion, which is the point —
          // "may I study this?" is a question about live enrolment, and a copy
          // of the answer in TypeScript would be a copy that could go stale.
          repository.insert(tx, {
            ownerId: ctx.actor.id,
            organizationId: ctx.actor.organizationId,
            title: input.title,
            body: input.body,
            visibility: input.visibility,
            notebookId: input.notebookId ?? null,
            courseId: input.courseId ?? null,
            unitId: input.unitId ?? null,
            lessonId: input.lessonId ?? null,
          }),
        ),
      );
    },

    async update(ctx, noteId, input) {
      await guardMarkdown(ctx, input.body);
      return guarded(() =>
        db.withActor(ctx.actor.id, async (tx) => {
          await authorizeNote(ctx, tx, noteId, 'note:update');
          const updated = await repository.applyUpdate(tx, noteId, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
            // Spread only when SENT, so `null` reaches the repository as a
            // deliberate clear and an omitted field never touches the column.
            ...(input.notebookId !== undefined ? { notebookId: input.notebookId } : {}),
            ...(input.courseId !== undefined ? { courseId: input.courseId } : {}),
            ...(input.unitId !== undefined ? { unitId: input.unitId } : {}),
            ...(input.lessonId !== undefined ? { lessonId: input.lessonId } : {}),
          });
          if (!updated) throw notFound();
          return updated;
        }),
      );
    },

    async remove(ctx, noteId) {
      await db.withActor(ctx.actor.id, async (tx) => {
        await authorizeNote(ctx, tx, noteId, 'note:delete');
        await repository.softDelete(tx, noteId);
      });
    },
  };
}
