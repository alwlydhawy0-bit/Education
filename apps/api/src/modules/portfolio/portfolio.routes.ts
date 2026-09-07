import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  addPortfolioItemRequestSchema,
  attachProjectArtifactRequestSchema,
  createPortfolioRequestSchema,
  createProjectRequestSchema,
  idSchema,
  listProjectsQuerySchema,
  portfolioResponseSchema,
  projectResponseSchema,
  publicPortfolioResponseSchema,
  updatePortfolioRequestSchema,
  updateProjectRequestSchema,
} from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.ts';
import { RATE_LIMIT_POLICIES, routeLimit } from '../../platform/security/rate-limit.ts';
import type {
  PortfolioRecord,
  ProjectRecord,
} from './portfolio.repository.ts';
import type { ActorContext, PortfolioService } from './portfolio.service.ts';

const idParams = z.object({ id: idSchema }).strict();
const projectIdParams = z.object({ projectId: idSchema }).strict();
const emptyQuerySchema = z.object({}).strict();

/**
 * The share key in the URL.
 *
 * A UNION RATHER THAN `z.string()`, so a key that is neither token-shaped nor
 * slug-shaped is a 404 before anything else runs. It costs no database round
 * trip and, more usefully, means a path segment carrying `../`, a NUL, a very
 * long string or a percent-encoded surprise never reaches the resolver.
 */
const shareKeyParams = z
  .object({
    shareToken: z
      .string()
      .trim()
      .max(64)
      .regex(/^[0-9a-f]{64}$|^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/),
  })
  .strict();

/**
 * The HTTP surface for projects, portfolios and the public share link.
 *
 * EVERY RESPONSE IS BUILT FIELD BY FIELD through a `.strict()` schema, never
 * spread from a repository record. A spread of `ProjectRecord` would carry
 * `organizationId` onto a class showcase; a spread of `PortfolioRecord` would
 * carry `shareToken` onto whatever endpoint somebody added next.
 *
 * ---------------------------------------------------------------------------
 * ONE ROUTE HERE HAS NO `requireActor`, AND IT IS DELIBERATE
 * ---------------------------------------------------------------------------
 *
 * `GET /portfolios/share/:shareToken` is the only unauthenticated content route
 * on this platform. Section 2C asks for it — a portfolio a learner can put on a
 * CV has to open for somebody with no account — and everything else in this
 * task exists to make that safe:
 *
 *   - The service runs it with NO ACTOR even for a caller who has a session, so
 *     the page is identical for everybody including its owner.
 *   - RLS admits a row only while the presented key matches a PUBLISHED
 *     portfolio, and admits a project only if it is public, not a draft, and
 *     listed in that portfolio.
 *   - The response is CONSTRUCTED by `toPublicPortfolio` and then re-parsed
 *     through `publicPortfolioResponseSchema.strict()`, so a field that
 *     appeared without being declared is a 500 rather than a disclosure.
 *   - It is rate-limited harder than any other read, because a slug is a
 *     guessable name and this is the route somebody would walk.
 */
export function registerPortfolioRoutes(app: FastifyInstance, portfolio: PortfolioService): void {
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

  const toProject = (project: ProjectRecord) =>
    projectResponseSchema.parse({
      id: project.id,
      studentId: project.studentId,
      classId: project.classId,
      courseId: project.courseId,
      title: project.title,
      descriptionMarkdown: project.descriptionMarkdown,
      repositoryUrl: project.repositoryUrl,
      liveDemoUrl: project.liveDemoUrl,
      visibility: project.visibility,
      status: project.status,
      // `featuredAt` is here and `featuredBy` is NOT. That a project was
      // recognised is part of the work; WHICH member of staff signed it off is
      // school-internal and no business of a classmate reading the showcase.
      featuredAt: project.featuredAt?.toISOString() ?? null,
      artifacts: project.artifacts.map((artifact) => ({
        id: artifact.id,
        artifactType: artifact.artifactType,
        filePathOrUrl: artifact.filePathOrUrl,
        byteSize: artifact.byteSize,
        createdAt: artifact.createdAt.toISOString(),
      })),
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    });

  const toPortfolio = (record: PortfolioRecord) =>
    portfolioResponseSchema.parse({
      id: record.id,
      studentId: record.studentId,
      title: record.title,
      bio: record.bio,
      publicSlug: record.publicSlug,
      // The token, to its owner and to nobody else. They need the link in order
      // to share it, and this is the only response shape that can carry one.
      shareToken: record.shareToken,
      isPublished: record.isPublished,
      items: record.items.map((item) => ({
        projectId: item.projectId,
        displayOrder: item.displayOrder,
        title: item.title,
        visibility: item.visibility,
        status: item.status,
      })),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    });

  // --- Projects ----------------------------------------------------------

  app.post('/api/v1/projects', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.projectWrite),
    handler: async (request, reply) => {
      const input = createProjectRequestSchema.parse(request.body ?? {});
      const created = await portfolio.createProject(contextOf(request), input);
      return reply.status(201).send(toProject(created));
    },
  });

  /** The caller's OWN projects. There is no parameter for anyone else's. */
  app.get('/api/v1/me/projects', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const query = listProjectsQuerySchema.parse(request.query ?? {});
      const found = await portfolio.listOwnProjects(contextOf(request), query);
      return reply.status(200).send({ items: found.map(toProject) });
    },
  });

  app.get('/api/v1/projects/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      emptyQuerySchema.parse(request.query ?? {});
      const { id } = idParams.parse(request.params);
      const found = await portfolio.readProject(contextOf(request), id);
      return reply.status(200).send(toProject(found));
    },
  });

  for (const method of ['PUT', 'PATCH'] as const) {
    app.route({
      method,
      url: '/api/v1/projects/:id',
      preHandler: requireActor,
      config: routeLimit(RATE_LIMIT_POLICIES.projectWrite),
      handler: async (request, reply) => {
        const { id } = idParams.parse(request.params);
        const input = updateProjectRequestSchema.parse(request.body ?? {});
        const saved = await portfolio.updateProject(contextOf(request), id, input);
        return reply.status(200).send(toProject(saved));
      },
    });
  }

  /**
   * Deleting a project deletes its artifacts and removes it from the portfolio.
   *
   * All three happen in one statement through the composite foreign keys, which
   * is what makes deletion a complete revocation rather than a first step. A
   * project taken down does not linger on the public page waiting for a second
   * request that might never come.
   */
  app.delete('/api/v1/projects/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      await portfolio.deleteProject(contextOf(request), id);
      return reply.status(204).send();
    },
  });

  app.post('/api/v1/projects/:id/artifacts', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.projectWrite),
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = attachProjectArtifactRequestSchema.parse(request.body ?? {});
      const created = await portfolio.attachArtifact(contextOf(request), id, input);
      return reply.status(201).send({
        id: created.id,
        artifactType: created.artifactType,
        filePathOrUrl: created.filePathOrUrl,
        byteSize: created.byteSize,
        createdAt: created.createdAt.toISOString(),
      });
    },
  });

  /**
   * A teacher or administrator features a submitted project.
   *
   * The body is EMPTY and the schema says so. There is nothing to send: the
   * status is the only thing that changes and it can only change one way, so a
   * body would be a place for a caller to put a column name.
   */
  app.post('/api/v1/projects/:id/feature', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.projectWrite),
    handler: async (request, reply) => {
      emptyQuerySchema.parse(request.body ?? {});
      const { id } = idParams.parse(request.params);
      const featured = await portfolio.featureProject(contextOf(request), id);
      return reply.status(200).send(toProject(featured));
    },
  });

  /**
   * One class's showcase.
   *
   * A caller not in this class gets an empty list rather than a 403 — see the
   * service. There is no object to refuse, because every row failed RLS, and
   * distinguishing "not your class" from "no shared work here" would be a
   * class-existence oracle across the platform.
   */
  app.get('/api/v1/classes/:id/projects', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const query = listProjectsQuerySchema.parse(request.query ?? {});
      const found = await portfolio.listClassProjects(contextOf(request), id, query);
      return reply.status(200).send({ items: found.map(toProject) });
    },
  });

  // --- The portfolio -----------------------------------------------------

  app.post('/api/v1/me/portfolio', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.projectWrite),
    handler: async (request, reply) => {
      const input = createPortfolioRequestSchema.parse(request.body ?? {});
      const created = await portfolio.createPortfolio(contextOf(request), input);
      return reply.status(201).send(toPortfolio(created));
    },
  });

  app.get('/api/v1/me/portfolio', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      emptyQuerySchema.parse(request.query ?? {});
      const found = await portfolio.readPortfolio(contextOf(request));
      return reply.status(200).send(toPortfolio(found));
    },
  });

  for (const method of ['PUT', 'PATCH'] as const) {
    app.route({
      method,
      url: '/api/v1/me/portfolio',
      preHandler: requireActor,
      config: routeLimit(RATE_LIMIT_POLICIES.projectWrite),
      handler: async (request, reply) => {
        const input = updatePortfolioRequestSchema.parse(request.body ?? {});
        const saved = await portfolio.updatePortfolio(contextOf(request), input);
        return reply.status(200).send(toPortfolio(saved));
      },
    });
  }

  /**
   * Publish, and take down.
   *
   * TWO ROUTES RATHER THAN A FLAG IN A PATCH BODY. "Who made this child's work
   * visible to the internet, and when did they take it down again" has to be
   * answerable from an access log and an audit trail, and a method plus a path
   * answers it where a JSON field does not.
   *
   * The DELETE is the revocation path and it is the one that must never fail
   * for a policy reason. Unpublishing rotates the share token in the database
   * trigger, so every link ever handed out stops resolving — including links
   * this platform never saw.
   */
  app.post('/api/v1/me/portfolio/publish', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.projectWrite),
    handler: async (request, reply) => {
      emptyQuerySchema.parse(request.body ?? {});
      const saved = await portfolio.publish(contextOf(request), true);
      return reply.status(200).send(toPortfolio(saved));
    },
  });

  app.delete('/api/v1/me/portfolio/publish', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const saved = await portfolio.publish(contextOf(request), false);
      return reply.status(200).send(toPortfolio(saved));
    },
  });

  app.post('/api/v1/me/portfolio/items', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.projectWrite),
    handler: async (request, reply) => {
      const input = addPortfolioItemRequestSchema.parse(request.body ?? {});
      const saved = await portfolio.addItem(contextOf(request), input);
      return reply.status(201).send(toPortfolio(saved));
    },
  });

  app.delete('/api/v1/me/portfolio/items/:projectId', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { projectId } = projectIdParams.parse(request.params);
      const saved = await portfolio.removeItem(contextOf(request), projectId);
      return reply.status(200).send(toPortfolio(saved));
    },
  });

  // --- The public boundary -----------------------------------------------

  /**
   * THE ONE UNAUTHENTICATED CONTENT ROUTE. See the file header.
   *
   * The parameter is named `shareToken` because section 2C names it that, and
   * it accepts a `public_slug` too — one route for both entry points, because
   * they differ in how somebody comes to know them and not at all in what they
   * admit. Two routes would be two places to keep the rule.
   *
   * `Cache-Control: no-store` because the answer depends on a revocation that
   * can happen at any moment. A portfolio a learner withdrew must stop being
   * served immediately, and a shared cache holding the old page would be
   * exactly the failure the token rotation exists to prevent.
   *
   * `X-Robots-Tag: noindex` IS A JUDGEMENT, NOT A CONTROL, and both halves of
   * that matter. The judgement: a child clicking "publish" is choosing to hand
   * a link to people they name, not to have their name, school work and face
   * indexed and kept by a search engine after they graduate. "Shareable" and
   * "discoverable by strangers searching your name" are different consents, and
   * the safer of the two is the default here.
   *
   * Not a control, because this is a JSON API. A crawler that reaches THIS
   * response honours the header; nothing here can stop a frontend from
   * rendering the same content into an indexable HTML page without it. The real
   * control belongs to whatever serves that HTML, and until one exists the
   * header states the platform's intent where a reader of this file can see it.
   */
  app.get('/api/v1/portfolios/share/:shareToken', {
    config: routeLimit(RATE_LIMIT_POLICIES.publicPortfolio),
    handler: async (request, reply) => {
      emptyQuerySchema.parse(request.query ?? {});
      const { shareToken } = shareKeyParams.parse(request.params);
      const view = await portfolio.resolvePublic(shareToken, {
        correlationId: request.correlationId,
        ip: request.ip,
      });
      return reply
        .status(200)
        .header('Cache-Control', 'no-store')
        .header('X-Robots-Tag', 'noindex')
        .send(publicPortfolioResponseSchema.parse(view));
    },
  });
}
