import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  activityResponseSchema,
  assessmentResponseSchema,
  attemptQuestionSchema,
  attemptResponseSchema,
  attemptReviewSchema,
  createActivityRequestSchema,
  createQuestionRequestSchema,
  emptyRequestSchema,
  idSchema,
  listActivitiesQuerySchema,
  listAttemptsQuerySchema,
  releaseAttemptRequestSchema,
  submitAttemptRequestSchema,
} from '@edu/contracts';
import { requireActor } from '../../platform/http/authentication.ts';
import { RATE_LIMIT_POLICIES, routeLimit } from '../../platform/security/rate-limit.ts';
import type { ActorContext, AssessmentService } from './assessment.service.ts';
import type { ActivityRecord, AssessmentRecord, AttemptRecord } from './assessment.repository.ts';

const idParams = z.object({ id: idSchema }).strict();
const classStudentParams = z.object({ id: idSchema, studentId: idSchema }).strict();
const childParams = z.object({ childId: idSchema }).strict();

/**
 * Every response is built FIELD BY FIELD through a `.strict()` schema.
 *
 * That is the last line of the answer-key defence, and it is a structural one
 * rather than a careful one: `attemptResponseSchema` has no property that could
 * hold a correct answer, so there is nothing for a future `SELECT *` to leak
 * through. A spread of a repository record would not have that property.
 */
const toActivity = (a: ActivityRecord): unknown =>
  activityResponseSchema.parse({
    id: a.id,
    lessonId: a.lessonId,
    position: a.position,
    activityType: a.activityType,
    title: a.title,
    instructions: a.instructions,
    status: a.status,
    assessmentId: a.assessmentId,
    createdAt: a.createdAt.toISOString(),
  });

const toAssessment = (s: AssessmentRecord): unknown =>
  assessmentResponseSchema.parse({
    id: s.id,
    activityId: s.activityId,
    lessonId: s.lessonId,
    title: s.title,
    instructions: s.instructions,
    questionCount: s.questionCount,
    maxScore: s.maxScore,
    passingPercentage: s.passingPercentage,
    maxAttempts: s.maxAttempts,
    attemptsUsed: s.attemptsUsed,
    reviewPolicy: s.reviewPolicy,
  });

const toAttempt = (t: AttemptRecord): unknown =>
  attemptResponseSchema.parse({
    id: t.id,
    assessmentId: t.assessmentId,
    assessmentTitle: t.assessmentTitle,
    lessonId: t.lessonId,
    lessonTitle: t.lessonTitle,
    courseId: t.courseId,
    courseTitle: t.courseTitle,
    attemptNumber: t.attemptNumber,
    status: t.status,
    startedAt: t.startedAt.toISOString(),
    submittedAt: t.submittedAt?.toISOString() ?? null,
    score: t.score,
    maxScore: t.maxScore,
    percentage: t.percentage,
    passed: t.passed,
    passingPercentage: t.passingPercentage,
    released: t.released,
    releasedAt: t.releasedAt?.toISOString() ?? null,
  });

export function registerAssessmentRoutes(
  app: FastifyInstance,
  assessment: AssessmentService,
): void {
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

  app.post('/api/v1/lessons/:id/activities', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = createActivityRequestSchema.parse(request.body);
      const created = await assessment.createActivity(contextOf(request), id, input);
      return reply.status(201).send(toActivity(created));
    },
  });

  /**
   * A question, its options and its key in ONE request.
   *
   * Atomic on purpose: three endpoints would leave a window in which a question
   * existed with options but no key, and a question with no key is one the
   * scorer must refuse to award.
   */
  app.post('/api/v1/assessments/:id/questions', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = createQuestionRequestSchema.parse(request.body);
      const { questionId } = await assessment.addQuestion(contextOf(request), id, input);
      // The id only. Echoing the question back would echo the key back.
      return reply.status(201).send({ id: questionId });
    },
  });

  app.post('/api/v1/activities/:id/publish', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      emptyRequestSchema.parse(request.body ?? {});
      const updated = await assessment.setActivityStatus(contextOf(request), id, 'published');
      return reply.status(200).send(toActivity(updated));
    },
  });

  app.post('/api/v1/activities/:id/archive', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      emptyRequestSchema.parse(request.body ?? {});
      const updated = await assessment.setActivityStatus(contextOf(request), id, 'archived');
      return reply.status(200).send(toActivity(updated));
    },
  });

  // --- Reading -----------------------------------------------------------

  app.get('/api/v1/lessons/:id/activities', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const query = listActivitiesQuerySchema.parse(request.query ?? {});
      const found = await assessment.listActivities(contextOf(request), id, query);
      return reply.status(200).send({ items: found.map(toActivity) });
    },
  });

  app.get('/api/v1/activities/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const found = await assessment.readActivity(contextOf(request), id);
      return reply.status(200).send(toActivity(found));
    },
  });

  /** Metadata only. The paper is handed out when an attempt is started. */
  app.get('/api/v1/assessments/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const found = await assessment.readAssessment(contextOf(request), id);
      return reply.status(200).send(toAssessment(found));
    },
  });

  // --- Attempts ----------------------------------------------------------

  /**
   * Starting an attempt is abuse-sensitive: it is the only way to obtain the
   * question set, and on an assessment scored by exact match it is the loop an
   * attacker would run to map the answer key.
   *
   * The named policy below is a SECONDARY control, and the limit is set
   * accordingly. The primary one is the per-assessment attempt limit, which is
   * per LEARNER; this limiter is keyed by IP, and a classroom shares an IP, so
   * a limit tight enough to stop a determined grinder would also stop a class.
   * See docs/security/rate-limiting.md.
   */
  app.post('/api/v1/assessments/:id/attempts', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.assessmentAttempt),
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      // Takes NOTHING from the client but the URL and the session. Parsed
      // rather than ignored, so a forged `userId` is refused out loud instead
      // of being dropped in a way a later change could quietly start trusting.
      emptyRequestSchema.parse(request.body ?? {});
      const { attempt, questions } = await assessment.startAttempt(contextOf(request), id);
      return reply.status(201).send({
        attempt: toAttempt(attempt),
        questions: questions.map((q) => attemptQuestionSchema.parse(q)),
      });
    },
  });

  app.post('/api/v1/attempts/:id/submit', {
    preHandler: requireActor,
    config: routeLimit(RATE_LIMIT_POLICIES.assessmentSubmit),
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = submitAttemptRequestSchema.parse(request.body);
      const submitted = await assessment.submitAttempt(contextOf(request), id, input);
      return reply.status(200).send(toAttempt(submitted));
    },
  });

  app.get('/api/v1/attempts/:id', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { attempt, questions } = await assessment.readAttempt(contextOf(request), id);
      return reply.status(200).send({
        attempt: toAttempt(attempt),
        questions: questions.map((q) => attemptQuestionSchema.parse(q)),
      });
    },
  });

  /**
   * The MARKED PAPER: correctness, the learner's own selections, the correct
   * answers and the authored explanation.
   *
   * A separate endpoint from `GET /attempts/:id`, not a flag on it, because
   * they are different disclosures that open at different moments. Reading an
   * attempt returns a result; reviewing it returns the answer key for that one
   * paper, and only once the result has been released.
   */
  app.get('/api/v1/attempts/:id/review', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { attempt, questions } = await assessment.reviewAttempt(contextOf(request), id);
      // Through the `.strict()` envelope, like every other response in this
      // file. This is the one payload in the system that carries correct
      // answers, so it is the last place to hand-assemble an object literal and
      // trust it to stay minimal.
      return reply.status(200).send(
        attemptReviewSchema.parse({
          attempt: toAttempt(attempt),
          released: attempt.released,
          releasedAt: attempt.releasedAt?.toISOString() ?? null,
          teacherComment: attempt.teacherComment,
          questions,
        }),
      );
    },
  });

  /**
   * Releasing a result to the learner.
   *
   * The body carries an optional comment and nothing else — no learner, no
   * class, no organization, and no score. The attempt is the URL and the actor
   * is the session; `.strict()` turns anything else into a 400 rather than a
   * silently ignored field.
   *
   * No dedicated rate-limit policy: this is a low-volume teacher action already
   * covered by the global limiter, and inventing a named policy for it would
   * imply a threat the attempt limit does not already bound.
   */
  app.post('/api/v1/attempts/:id/release', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = releaseAttemptRequestSchema.parse(request.body ?? {});
      const released = await assessment.releaseAttempt(contextOf(request), id, input);
      return reply.status(200).send(toAttempt(released));
    },
  });

  /** The learner's own attempts. No parameter names a user. */
  app.get('/api/v1/me/attempts', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const query = listAttemptsQuerySchema.parse(request.query ?? {});
      const found = await assessment.listMyAttempts(contextOf(request), query);
      return reply.status(200).send({ items: found.map(toAttempt) });
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
  app.get('/api/v1/classes/:id/students/:studentId/attempts', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { id, studentId } = classStudentParams.parse(request.params);
      const query = listAttemptsQuerySchema.parse(request.query ?? {});
      const found = await assessment.listAttemptsForStudentInClass(
        contextOf(request),
        id,
        studentId,
        query,
      );
      return reply.status(200).send({ items: found.map(toAttempt) });
    },
  });

  /** A verified guardian's view of one child. */
  app.get('/api/v1/guardians/children/:childId/attempts', {
    preHandler: requireActor,
    handler: async (request, reply) => {
      const { childId } = childParams.parse(request.params);
      const query = listAttemptsQuerySchema.parse(request.query ?? {});
      const found = await assessment.listAttemptsForChild(contextOf(request), childId, query);
      return reply.status(200).send({ items: found.map(toAttempt) });
    },
  });
}
