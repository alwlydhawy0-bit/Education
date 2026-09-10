import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  atRiskQuerySchema,
  atRiskResponseSchema,
  coursePerformanceQuerySchema,
  coursePerformanceResponseSchema,
  exportQuerySchema,
  schoolOverviewQuerySchema,
  schoolOverviewResponseSchema,
} from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.ts';
import { RATE_LIMIT_POLICIES, routeLimit } from '../../platform/security/rate-limit.ts';
import type { ActorContext, AnalyticsService } from './analytics.service.ts';

/**
 * The institutional analytics HTTP surface.
 *
 * ---------------------------------------------------------------------------
 * NO ROUTE HERE TAKES AN ORGANIZATION
 * ---------------------------------------------------------------------------
 *
 * Not in a path parameter, not in a query string, not in a body. Section 2B
 * asks that the tenant be "derived directly from the authenticated user's auth
 * context", and the strongest way to satisfy that is to leave no place to put
 * one: the schemas are `.strict()`, so `?organizationId=<other school>` is a
 * 400 naming a field that does not exist rather than a value somebody has to
 * remember to check.
 *
 * `/analytics/school/overview` has no id in it AT ALL. There is exactly one
 * school a caller can ask about — theirs — so a path segment would be
 * decoration at best and an injection point at worst.
 *
 * ---------------------------------------------------------------------------
 * EVERY RESPONSE IS PARSED THROUGH A STRICT SCHEMA ON THE WAY OUT
 * ---------------------------------------------------------------------------
 *
 * `.parse()` on a `.strict()` schema means a field that appeared without being
 * declared is a 500 rather than a disclosure. On a domain whose payloads are
 * assembled from aggregate rows, the field most likely to appear by accident is
 * `organization_id` — an internal key, in a response, on the one surface whose
 * whole job is keeping schools apart.
 */
export function registerAnalyticsRoutes(app: FastifyInstance, analytics: AnalyticsService): void {
  function contextOf(request: FastifyRequest): ActorContext {
    const actor = request.actor;
    if (!actor) throw new Error('unreachable: requireActor guarantees an actor');
    return {
      actor,
      loadRelationships: request.loadRelationships,
      correlationId: request.correlationId,
      ip: request.ip ?? null,
    };
  }

  /**
   * The executive dashboard.
   *
   * Administrators of the caller's own school. A teacher reaching for this gets
   * 403 with a message naming who does hold it — section 2E's requirement, and
   * the one refusal in this domain that explains itself rather than pretending
   * the endpoint is not there.
   */
  app.get('/api/v1/analytics/school/overview', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.analyticsRead),
    handler: async (request, reply) => {
      const query = schoolOverviewQuerySchema.parse(request.query ?? {});
      const overview = await analytics.schoolOverview(contextOf(request), query);
      return reply
        .header('Cache-Control', 'no-store')
        .status(200)
        .send(schoolOverviewResponseSchema.parse(overview));
    },
  });

  /**
   * Course and class performance.
   *
   * An administrator sees every class in their school; a teacher sees the ones
   * they actively teach. Naming a `classId` they do not hold is a 404 — the
   * grain names a class, and a 403 would confirm the id is real.
   */
  app.get('/api/v1/analytics/courses/performance', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.analyticsRead),
    handler: async (request, reply) => {
      const query = coursePerformanceQuerySchema.parse(request.query ?? {});
      const items = await analytics.coursePerformance(contextOf(request), query);
      return reply
        .header('Cache-Control', 'no-store')
        .status(200)
        .send(coursePerformanceResponseSchema.parse({ items }));
    },
  });

  /**
   * Learners a teacher should look at.
   *
   * THE ONLY ROUTE IN THIS DOMAIN THAT NAMES CHILDREN, and the only one an
   * organization administrator is refused. See `analytics.policy.ts` for why
   * seniority narrows rather than widens here.
   *
   * `no-store` matters more on this response than on the others: a shared
   * staffroom machine with a cached page of struggling children's names is the
   * mundane version of this endpoint leaking.
   */
  app.get('/api/v1/analytics/students/at-risk', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.analyticsRead),
    handler: async (request, reply) => {
      const query = atRiskQuerySchema.parse(request.query ?? {});
      const items = await analytics.atRisk(contextOf(request), query);
      return reply
        .header('Cache-Control', 'no-store')
        .status(200)
        .send(atRiskResponseSchema.parse({ threshold: query.threshold, items }));
    },
  });

  /**
   * The compliance export.
   *
   * THREE HEADERS, EACH DOING A SPECIFIC JOB.
   *
   * `Content-Disposition: attachment` makes a browser SAVE rather than render.
   * A rendered CSV is a document in the origin, which is where content sniffing
   * and any future markup handling start to matter; an attachment is a file.
   * The filename comes from `csvFilename`, which strips anything that could end
   * the header early — a CRLF here is header injection, not a formula.
   *
   * `X-Content-Type-Options: nosniff` stops a browser second-guessing the
   * declared type, which is the other half of the same defence.
   *
   * `Cache-Control: no-store` keeps a whole school's figures out of a shared
   * machine's disk cache.
   */
  app.get('/api/v1/analytics/export', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.analyticsExport),
    handler: async (request, reply) => {
      const query = exportQuerySchema.parse(request.query ?? {});
      const file = await analytics.exportReport(contextOf(request), query);
      return reply
        .header('Content-Type', file.contentType)
        .header('Content-Disposition', `attachment; filename="${file.filename}"`)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'no-store')
        .status(200)
        .send(file.body);
    },
  });
}
