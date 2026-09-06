import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  appendArtifactRequestSchema,
  artifactResponseSchema,
  authoredExperimentResponseSchema,
  emptyQuerySchema,
  emptyRequestSchema,
  experimentResponseSchema,
  idSchema,
  labSessionResponseSchema,
  labSessionWithExperimentSchema,
  listLabSessionsQuerySchema,
  putExperimentRequestSchema,
  saveLabStateRequestSchema,
  submitLabRequestSchema,
} from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.ts';
import { RATE_LIMIT_POLICIES, routeLimit } from '../../platform/security/rate-limit.ts';
import type { ActorContext, ExperimentService } from './experiment.service.ts';
import type { ArtifactRecord, ExperimentRecord, LabSessionRecord } from './experiment.repository.ts';

const idParams = z.object({ id: idSchema }).strict();
const classStudentParams = z.object({ id: idSchema, studentId: idSchema }).strict();
const childParams = z.object({ childId: idSchema }).strict();

/**
 * Every response is built FIELD BY FIELD through a `.strict()` schema.
 *
 * That is the last line of the answer-key defence, and it is a STRUCTURAL one
 * rather than a careful one: `experimentResponseSchema` has no property that
 * could hold a validation rule, so there is nothing for a future `SELECT *` to
 * leak through. A spread of a repository record would not have that property.
 */
const toExperiment = (e: ExperimentRecord): unknown =>
  experimentResponseSchema.parse({
    id: e.id,
    activityId: e.activityId,
    lessonId: e.lessonId,
    title: e.title,
    instructions: e.instructions,
    simulationType: e.simulationType,
    status: e.status,
    initialConfig: e.initialConfig,
  });

const toSession = (s: LabSessionRecord): unknown =>
  labSessionResponseSchema.parse({
    id: s.id,
    experimentId: s.experimentId,
    experimentTitle: s.experimentTitle,
    simulationType: s.simulationType,
    lessonId: s.lessonId,
    lessonTitle: s.lessonTitle,
    courseId: s.courseId,
    courseTitle: s.courseTitle,
    status: s.status,
    currentState: s.currentState,
    passed: s.passed,
    startedAt: s.startedAt.toISOString(),
    submittedAt: s.submittedAt?.toISOString() ?? null,
    completedAt: s.completedAt?.toISOString() ?? null,
    updatedAt: s.updatedAt.toISOString(),
  });

const toArtifact = (a: ArtifactRecord): unknown =>
  artifactResponseSchema.parse({
    id: a.id,
    sessionId: a.sessionId,
    artifactType: a.artifactType,
    payload: a.payload,
    createdAt: a.createdAt.toISOString(),
  });

export function registerExperimentRoutes(app: FastifyInstance, experiment: ExperimentService): void {
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

  // --- Authoring ---------------------------------------------------------

  /**
   * Attaching a lab body to an activity that already exists.
   *
   * THERE IS NO `POST /experiments`, and no publish route in this file. A lab
   * hangs off a `learning_activity` of type `simulation` or `experiment`, and
   * the existing activity endpoints already create, publish and archive one.
   * A second publish path would mean two places deciding when children can see
   * a lab, and the database's publication gate would only be enforcing one of
   * them.
   *
   * A PUT because it is an upsert: the scene and the rules travel together, and
   * re-sending them while the activity is a draft replaces both. Once the
   * activity is published, the policy and a database trigger each refuse.
   */
  app.put('/api/v1/activities/:id/experiment', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = putExperimentRequestSchema.parse(request.body);
      const { experiment: saved, rules } = await experiment.putExperiment(
        contextOf(request),
        id,
        input,
      );
      return reply.status(200).send(
        authoredExperimentResponseSchema.parse({
          ...(toExperiment(saved) as Record<string, unknown>),
          rules,
        }),
      );
    },
  });

  /**
   * Reading a lab.
   *
   * TWO RESPONSE SHAPES, chosen by whether the database handed over a rules row
   * — which it does for an author or a publisher in the same school, and for
   * nobody else. An optional `rules` field on one shape would be a response
   * whose safety depended on somebody remembering to omit it; two shapes make
   * the disclosure a decision taken on this line, where a reviewer can see it.
   */
  app.get('/api/v1/experiments/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      emptyQuerySchema.parse(request.query ?? {});
      const { id } = idParams.parse(request.params);
      const { experiment: found, rules } = await experiment.readExperiment(contextOf(request), id);
      const body = toExperiment(found) as Record<string, unknown>;
      return reply
        .status(200)
        .send(
          rules === null
            ? body
            : authoredExperimentResponseSchema.parse({ ...body, rules }),
        );
    },
  });

  // --- Working -----------------------------------------------------------

  /**
   * Starting — or RESUMING — a lab session.
   *
   * Idempotent by design: a learner may hold one live session per lab, so a
   * second start returns the one they already have rather than failing on a
   * unique index. Reopening a lab you left open is what a learner expects, and
   * it means a flaky network cannot cost somebody their work.
   */
  app.post('/api/v1/experiments/:id/sessions', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.labSessionStart),
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      // Takes NOTHING from the client but the URL and the session. Parsed
      // rather than ignored, so a forged `userId` or `passed` is refused out
      // loud instead of being dropped in a way a later change could quietly
      // start trusting (VULN-028).
      emptyRequestSchema.parse(request.body ?? {});
      const { session, experiment: lab } = await experiment.startSession(contextOf(request), id);
      return reply.status(201).send(
        labSessionWithExperimentSchema.parse({
          session: toSession(session),
          experiment: toExperiment(lab),
        }),
      );
    },
  });

  /**
   * Saving the scene so far.
   *
   * No dedicated rate-limit policy: a lab autosaves, so a limit tight enough to
   * matter would fight the feature, and a limit loose enough not to would be
   * indistinguishable from the global one. What actually bounds this request is
   * its SIZE — capped by the contract and again by a database CHECK — and its
   * shape, capped by `checkStatePayload`.
   */
  app.put('/api/v1/experiment-sessions/:id/state', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = saveLabStateRequestSchema.parse(request.body);
      const saved = await experiment.saveState(contextOf(request), id, input);
      return reply.status(200).send(toSession(saved));
    },
  });

  /**
   * Submitting.
   *
   * The response carries `passed` and `status` AS THE DATABASE LEFT THEM. The
   * request has nowhere to claim either: the submit trigger marks the state
   * against rules this process cannot read, using a function the application
   * role may not execute.
   */
  app.post('/api/v1/experiment-sessions/:id/submit', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.labSubmit),
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = submitLabRequestSchema.parse(request.body);
      const submitted = await experiment.submitSession(contextOf(request), id, input);
      return reply.status(200).send(toSession(submitted));
    },
  });

  app.get('/api/v1/experiment-sessions/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      emptyQuerySchema.parse(request.query ?? {});
      const { id } = idParams.parse(request.params);
      const found = await experiment.readSession(contextOf(request), id);
      return reply.status(200).send(toSession(found));
    },
  });

  /**
   * Appending an artifact.
   *
   * There is no PATCH and no DELETE here, and their absence is not an oversight
   * to be filled in later: `edu_app` holds SELECT and INSERT on
   * `experiment_artifacts` and neither UPDATE nor DELETE, so a route for either
   * could not carry out what it promised. A telemetry log that can be rewritten
   * is not telemetry.
   */
  app.post('/api/v1/experiment-sessions/:id/artifacts', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = appendArtifactRequestSchema.parse(request.body);
      const created = await experiment.appendArtifact(contextOf(request), id, input);
      return reply.status(201).send(toArtifact(created));
    },
  });

  app.get('/api/v1/experiment-sessions/:id/artifacts', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      emptyQuerySchema.parse(request.query ?? {});
      const { id } = idParams.parse(request.params);
      const found = await experiment.listArtifacts(contextOf(request), id);
      return reply.status(200).send({ items: found.map(toArtifact) });
    },
  });

  // --- Listing -----------------------------------------------------------

  /** The learner's own sessions. No parameter names a user. */
  app.get('/api/v1/me/experiment-sessions', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const query = listLabSessionsQuerySchema.parse(request.query ?? {});
      const found = await experiment.listMySessions(contextOf(request), query);
      return reply.status(200).send({ items: found.map(toSession) });
    },
  });

  /**
   * A teacher's or administrator's view of one student, in one class.
   *
   * Both ids are in the PATH because both are part of the authorization
   * question: the actor must have standing in that class, the student must be
   * enrolled in it, and the rows are restricted to the courses assigned to it.
   * A query parameter for either would invite a caller to vary one and probe.
   */
  app.get('/api/v1/classes/:id/students/:studentId/experiment-sessions', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id, studentId } = classStudentParams.parse(request.params);
      const query = listLabSessionsQuerySchema.parse(request.query ?? {});
      const found = await experiment.listSessionsForStudentInClass(
        contextOf(request),
        id,
        studentId,
        query,
      );
      return reply.status(200).send({ items: found.map(toSession) });
    },
  });

  /** A verified guardian's view of one child. */
  app.get('/api/v1/guardians/children/:childId/experiment-sessions', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { childId } = childParams.parse(request.params);
      const query = listLabSessionsQuerySchema.parse(request.query ?? {});
      const found = await experiment.listSessionsForChild(contextOf(request), childId, query);
      return reply.status(200).send({ items: found.map(toSession) });
    },
  });
}
