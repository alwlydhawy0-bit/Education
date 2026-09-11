import { conflict, notFound, validationFailed } from '@edu/kernel';
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
import { forbidden } from '@edu/kernel';
import { SecurityEventType } from '@edu/observability';
import type {
  AddPortfolioItemRequest,
  AttachProjectArtifactRequest,
  CreatePortfolioRequest,
  CreateProjectRequest,
  ListProjectsQuery,
  UpdatePortfolioRequest,
  UpdateProjectRequest,
} from '@edu/contracts';
import type { Database, Tx } from '../../platform/db.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import type {
  PortfolioRecord,
  PortfolioRepository,
  ProjectArtifactRecord,
  ProjectRecord,
} from './portfolio.repository.ts';
import {
  isValidShareToken,
  isValidSlug,
  slugCandidates,
  toPublicPortfolio,
  type PublicPortfolioView,
} from './public-view.ts';

export interface ActorContext {
  readonly actor: Actor;
  readonly loadRelationships: () => Promise<RelationshipSnapshot>;
  readonly correlationId: string;
  readonly ip: string | null;
}

/** What an anonymous request can honestly tell the service about itself. */
export interface PublicRequestContext {
  readonly correlationId: string;
  readonly ip: string | null;
}

export interface PortfolioServiceDeps {
  readonly db: Database;
  readonly repository: PortfolioRepository;
  readonly engine: PolicyEngine;
  readonly securityEvents: SecurityEventRecorder;
}

export interface PortfolioService {
  createProject(ctx: ActorContext, input: CreateProjectRequest): Promise<ProjectRecord>;
  listOwnProjects(ctx: ActorContext, query: ListProjectsQuery): Promise<ProjectRecord[]>;
  listClassProjects(
    ctx: ActorContext,
    classId: string,
    query: ListProjectsQuery,
  ): Promise<ProjectRecord[]>;
  readProject(ctx: ActorContext, id: string): Promise<ProjectRecord>;
  updateProject(ctx: ActorContext, id: string, input: UpdateProjectRequest): Promise<ProjectRecord>;
  featureProject(ctx: ActorContext, id: string): Promise<ProjectRecord>;
  deleteProject(ctx: ActorContext, id: string): Promise<void>;
  attachArtifact(
    ctx: ActorContext,
    projectId: string,
    input: AttachProjectArtifactRequest,
  ): Promise<ProjectArtifactRecord>;

  createPortfolio(ctx: ActorContext, input: CreatePortfolioRequest): Promise<PortfolioRecord>;
  readPortfolio(ctx: ActorContext): Promise<PortfolioRecord>;
  updatePortfolio(ctx: ActorContext, input: UpdatePortfolioRequest): Promise<PortfolioRecord>;
  publish(ctx: ActorContext, published: boolean): Promise<PortfolioRecord>;
  addItem(ctx: ActorContext, input: AddPortfolioItemRequest): Promise<PortfolioRecord>;
  removeItem(ctx: ActorContext, projectId: string): Promise<PortfolioRecord>;

  /**
   * THE UNAUTHENTICATED PATH. No `ActorContext`, because there is no actor.
   *
   * `request` carries the correlation id and address needed to record a miss,
   * and deliberately nothing else — there is no field on it that could be
   * mistaken for an identity.
   */
  resolvePublic(key: string, request: PublicRequestContext): Promise<PublicPortfolioView>;
}

const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';
const INTEGRITY_VIOLATION = '23514';
const INSUFFICIENT_PRIVILEGE = '42501';
const NOT_NULL_VIOLATION = '23502';
const RAISED_INTEGRITY = '23000';

function pgCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : null;
}

/**
 * Projects, portfolios and the one public route on this platform.
 *
 * ---------------------------------------------------------------------------
 * THE PUBLIC RESOLVER RUNS WITHOUT AN ACTOR, ALWAYS
 * ---------------------------------------------------------------------------
 *
 * `resolvePublic` takes no `ActorContext` and calls `db.withoutActor`, even
 * when the request carried a valid session. That is deliberate and it is the
 * single most important line in this file.
 *
 * If it ran as the caller, `student_projects_select` and
 * `portfolio_items_select` would ALSO match their owner branch — so a learner
 * opening their own share link would see their private and draft projects
 * rendered onto the public page, and would reasonably conclude that is what
 * strangers see. The page would then be a liar in the most dangerous
 * direction: it would under-report what is hidden, to the one person deciding
 * what to publish.
 *
 * Running with no actor means the public page is the same page for everybody,
 * including its owner. A learner checking their own link is doing the thing
 * they think they are doing.
 */
export function createPortfolioService(deps: PortfolioServiceDeps): PortfolioService {
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
   * Every denial is recorded with IDS ONLY — never a title, a description or a
   * URL. A project may be a minor's unfinished work, and the audit trail is
   * read by more people than the project is.
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
      if (decision.disclosure === 'reveal') throw forbidden();
      throw notFound();
    }
    return decision;
  }

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
   * The second gate over a list.
   *
   * RLS HAS ALREADY FILTERED THESE ROWS. Running the policy again over each one
   * is the other half of the platform's two-gate rule, and a list endpoint is
   * where it earns its cost: VULN-017 was a listing that trusted a single gate,
   * and a listing is where one missing condition leaks many rows at once
   * instead of one.
   *
   * A row the policy declines is DROPPED, not an error, and it is not recorded
   * as a denial. A learner opening their class showcase is not probing — a
   * dropped row means the two gates disagree about an edge, which is worth a
   * metric rather than an alert per row. The rows themselves stay guarded until
   * they are admitted, so a row that is dropped is never unwrapped.
   */
  async function admit<T>(
    ctx: ActorContext,
    guarded: readonly Guarded<T>[],
    action: Action,
  ): Promise<T[]> {
    const authContext: AuthorizationContext = {
      actor: ctx.actor,
      relationships: await ctx.loadRelationships(),
    };
    const admitted: T[] = [];
    for (const row of guarded) {
      const decision = engine.decide(authContext, action, row.resource);
      if (decision.effect === 'allow') admitted.push(row.unwrap(decision, action));
    }
    return admitted;
  }

  function translate(error: unknown): never {
    const code = pgCode(error);
    const message = error instanceof Error ? error.message : '';

    if (code === UNIQUE_VIOLATION && message.includes('student_portfolios_one_per_student_uk')) {
      throw conflict('You already have a portfolio');
    }
    if (code === UNIQUE_VIOLATION && message.includes('student_portfolios_slug_uk')) {
      // Handled ahead of time in `updatePortfolio` so the client gets
      // alternatives; this is the race that beat the check.
      throw conflict('That portfolio address is already taken');
    }
    if (code === UNIQUE_VIOLATION && message.includes('portfolio_items_unique_project_uk')) {
      throw conflict('That project is already in your portfolio');
    }
    if (code === FK_VIOLATION && /portfolio_owner_fk|project_owner_fk/.test(message)) {
      // THE COMPOSITE FOREIGN KEY REFUSING SOMEBODY ELSE'S ROW. A 404, not a
      // 403: confirming that the id names a real project is the one bit a
      // caller trying other people's ids is fishing for.
      throw notFound();
    }
    if (code === FK_VIOLATION) {
      throw validationFailed('That reference does not name anything you can attach to');
    }
    if (code === NOT_NULL_VIOLATION && /must be created in a class/i.test(message)) {
      throw validationFailed('A project belongs to a class you are in');
    }
    if (code === INSUFFICIENT_PRIVILEGE && /class you are in/i.test(message)) {
      // `student_project_guard` refusing a writer who is not a MEMBER of the
      // class. A teacher hits this too, and correctly: a project is a learner's
      // work, and teaching a class is not being in it.
      throw forbidden('A project belongs to a class you are a learner in');
    }
    if (code === INSUFFICIENT_PRIVILEGE) {
      throw forbidden('That is not something you may do to this project');
    }
    if (code === RAISED_INTEGRITY) {
      // The review guard refusing a reviewer who tried to change more than
      // status. Surfacing the database's own words would leak column names, so
      // this says what the caller may do instead.
      throw forbidden('A reviewer may feature a project and nothing else');
    }
    if (code === INTEGRITY_VIOLATION) {
      throw validationFailed('That value is not one this field accepts');
    }
    throw error;
  }

  async function guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      return translate(error);
    }
  }

  async function ownPortfolioOr404(ctx: ActorContext, tx: Tx, action: Action) {
    const guarded = await repository.findOwnPortfolio(tx, ctx.actor.id);
    if (!guarded) {
      throw notFound();
    }
    const record = await authorize(ctx, guarded, action, 'student_portfolio', guarded.resource.id);
    return { record, id: guarded.resource.id };
  }

  return {
    async createProject(ctx, input) {
      return guard(() =>
        db.withActor(ctx.actor.id, (tx) => repository.createProject(tx, ctx.actor.id, input)),
      );
    },

    async listOwnProjects(ctx, query) {
      return db.withActor(ctx.actor.id, (tx) =>
        repository.listOwnProjects(tx, ctx.actor.id, query),
      );
    },

    /**
     * A class showcase.
     *
     * THE CLASS ID IS NOT AUTHORIZED SEPARATELY, and that is not an omission.
     * A caller naming a class they are not in gets an empty list, because every
     * row in it fails `student_projects_select` — there is no 403 to give
     * because there is no object to refuse. Adding a membership check here
     * would turn "not in this class" into a distinguishable answer from "this
     * class has no shared projects", which is a class-existence oracle across
     * the whole platform.
     */
    async listClassProjects(ctx, classId, query) {
      const rows = await db.withActor(ctx.actor.id, (tx) =>
        repository.listClassProjects(tx, classId, query),
      );
      return admit(ctx, rows, 'student_project:list');
    },

    async readProject(ctx, id) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const guarded = await repository.findProject(tx, id);
        return authorize(ctx, guarded, 'student_project:read', 'student_project', id);
      });
    },

    async updateProject(ctx, id, input) {
      return guard(() =>
        db.withActor(ctx.actor.id, async (tx) => {
          const guarded = await repository.findProject(tx, id);
          await authorize(ctx, guarded, 'student_project:update', 'student_project', id);
          const updated = await repository.updateProject(tx, id, input);
          if (!updated) throw notFound();
          return updated;
        }),
      );
    },

    /**
     * A teacher features a project.
     *
     * Both gates run and the database runs a third: the policy admits only a
     * reviewer of this class, `student_projects_feature` admits only the same,
     * and `student_project_review_guard` refuses any column but `status`,
     * `featured_by` and `featured_at`. The repository's SET list is narrow
     * anyway — the trigger is there for the writer who edits it later.
     */
    async featureProject(ctx, id) {
      return guard(() =>
        db.withActor(ctx.actor.id, async (tx) => {
          const guarded = await repository.findProject(tx, id);
          await authorize(ctx, guarded, 'student_project:feature', 'student_project', id);
          const featured = await repository.featureProject(tx, id, ctx.actor.id);
          if (!featured) throw notFound();
          await emit(ctx, SecurityEventType.PROJECT_FEATURED, {
            projectId: id,
            ownerId: featured.studentId,
            classId: featured.classId,
          });
          return featured;
        }),
      );
    },

    async deleteProject(ctx, id) {
      await db.withActor(ctx.actor.id, async (tx) => {
        const guarded = await repository.findProject(tx, id);
        await authorize(ctx, guarded, 'student_project:delete', 'student_project', id);
        if (!(await repository.deleteProject(tx, id))) throw notFound();
      });
    },

    async attachArtifact(ctx, projectId, input) {
      return guard(() =>
        db.withActor(ctx.actor.id, async (tx) => {
          const guarded = await repository.findProject(tx, projectId);
          await authorize(ctx, guarded, 'student_project:update', 'student_project', projectId);
          return repository.attachArtifact(tx, projectId, ctx.actor.id, input);
        }),
      );
    },

    async createPortfolio(ctx, input) {
      return guard(() =>
        db.withActor(ctx.actor.id, (tx) => repository.createPortfolio(tx, ctx.actor.id, input)),
      );
    },

    async readPortfolio(ctx) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const { record } = await ownPortfolioOr404(ctx, tx, 'student_portfolio:read');
        return record;
      });
    },

    /**
     * Editing the portfolio, including proposing a public address.
     *
     * A TAKEN SLUG IS A 409 WITH ALTERNATIVES, not a silent suffix. `alex-chen`
     * quietly becoming `alex-chen-4` hands a learner a URL they did not choose
     * and will not recognise on a poster; being told it is taken lets them
     * decide. The candidates are computed from what they typed, so the offer is
     * still theirs.
     */
    async updatePortfolio(ctx, input) {
      return guard(() =>
        db.withActor(ctx.actor.id, async (tx) => {
          const { id } = await ownPortfolioOr404(ctx, tx, 'student_portfolio:update');

          if (typeof input.publicSlug === 'string' && !isValidSlug(input.publicSlug)) {
            // Belt and braces: the contract's regex is the same one. This
            // catches a caller that reached the service another way.
            throw validationFailed('That portfolio address is not a usable name');
          }

          const updated = await repository
            .updatePortfolio(tx, id, input)
            .catch((error: unknown) => {
              if (
                pgCode(error) === UNIQUE_VIOLATION &&
                String((error as Error).message).includes('student_portfolios_slug_uk') &&
                typeof input.publicSlug === 'string'
              ) {
                throw conflict('That portfolio address is already taken', {
                  suggestions: slugCandidates(input.publicSlug, 5).slice(1),
                });
              }
              throw error;
            });
          if (!updated) throw notFound();
          return updated;
        }),
      );
    },

    /**
     * Publish, or take it down.
     *
     * TAKING IT DOWN IS NOT AUTHORIZED THE SAME WAY AS PUTTING IT UP, and the
     * asymmetry is deliberate. `publish` is refused for an empty portfolio;
     * `unpublish` is refused for nothing at all beyond not being the owner. A
     * child who wants their work off the internet must never meet a policy
     * that argues with them.
     *
     * The token rotation that makes the revocation real happens in
     * `student_portfolio_guard`, so it holds for any writer, not just this one.
     */
    async publish(ctx, published) {
      return guard(() =>
        db.withActor(ctx.actor.id, async (tx) => {
          const action: Action = published
            ? 'student_portfolio:publish'
            : 'student_portfolio:unpublish';
          const { id } = await ownPortfolioOr404(ctx, tx, action);
          const updated = await repository.setPublished(tx, id, published);
          if (!updated) throw notFound();
          await emit(
            ctx,
            published
              ? SecurityEventType.PORTFOLIO_PUBLISHED
              : SecurityEventType.PORTFOLIO_UNPUBLISHED,
            {
              portfolioId: id,
              // NEVER THE TOKEN. A share token in an audit log is a working
              // capability sitting in a file read by more people than the page
              // it opens. `tokenRotated` records that the revocation happened
              // without recording what was revoked.
              tokenRotated: !published,
              publicItemCount: updated.items.filter(
                (item) => item.visibility === 'public' && item.status !== 'draft',
              ).length,
            },
          );
          return updated;
        }),
      );
    },

    async addItem(ctx, input) {
      return guard(() =>
        db.withActor(ctx.actor.id, async (tx) => {
          const { id } = await ownPortfolioOr404(ctx, tx, 'student_portfolio:curate');
          const updated = await repository.addItem(tx, id, ctx.actor.id, input);
          if (!updated) throw notFound();
          return updated;
        }),
      );
    },

    async removeItem(ctx, projectId) {
      return guard(() =>
        db.withActor(ctx.actor.id, async (tx) => {
          const { id } = await ownPortfolioOr404(ctx, tx, 'student_portfolio:curate');
          // REMOVAL IS REVOCATION. The item row is what makes a public project
          // appear on the page, so deleting it takes the project off the
          // public view on the very next request — no cache to expire and no
          // second step to forget.
          if (!(await repository.removeItem(tx, id, projectId))) throw notFound();
          const { record } = await ownPortfolioOr404(ctx, tx, 'student_portfolio:read');
          return record;
        }),
      );
    },

    /**
     * The public resolver. NO ACTOR, by construction — see the file header.
     *
     * The shape check happens BEFORE the database is touched, so a malformed
     * key costs no round trip. It is not an authorization check: a well-formed
     * token belonging to nobody matches no row, which is the same outcome.
     *
     * A missing portfolio and a portfolio whose owner just unpublished it
     * answer identically, because they are the same fact — the key opens
     * nothing right now.
     */
    async resolvePublic(key, request) {
      const trimmed = key.trim();
      const tokenShaped = isValidShareToken(trimmed);

      const miss = async (reason: string): Promise<never> => {
        await securityEvents.record({
          type: SecurityEventType.PORTFOLIO_PUBLIC_RESOLVE_FAILED,
          // No actor. This is the one route on the platform that answers
          // without a session, so there is nobody to attribute the attempt to
          // and the address is all the record can carry.
          actorId: null,
          correlationId: request.correlationId,
          ip: request.ip,
          // THE KEY ITSELF IS NEVER RECORDED — see the event's declaration.
          // Its SHAPE is, because a burst of slug-shaped misses is somebody
          // walking the public namespace and a token-shaped miss is not.
          detail: { reason, keyShape: tokenShaped ? 'token' : 'slug' },
          occurredAt: new Date(),
        });
        throw notFound();
      };

      if (!tokenShaped && !isValidSlug(trimmed)) return miss('malformed');

      const resolved = await db.withoutActor(async (tx) => {
        await repository.beginPublicResolution(tx, trimmed);
        return repository.publicPortfolio(tx);
      });

      // A key that names nothing, a portfolio its owner just withdrew, and a
      // token rotated by that withdrawal all answer identically, because they
      // are the same fact: this key opens nothing right now.
      if (!resolved) return miss('no_match');
      return toPublicPortfolio(resolved.portfolio, resolved.projects);
    },
  };
}
