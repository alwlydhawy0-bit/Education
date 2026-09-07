import { forbidden, notFound } from '@edu/kernel';
import type {
  Action,
  Actor,
  AuthorizationContext,
  Decision,
  PolicyEngine,
  RelationshipSnapshot,
  Resource,
} from '@edu/authz';
import { SecurityEventType } from '@edu/observability';
import type { IndexCourseResponse, RagRetrieveRequest } from '@edu/contracts';
import type { Database } from '../../platform/db.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import type { EmbeddingProvider } from '../../platform/ai/embeddings.ts';
import { chunkLesson, type CurriculumChunk } from './chunking.ts';
import type { KnowledgeRepository, RetrievedVectorChunk } from './knowledge.repository.ts';

export interface ActorContext {
  readonly actor: Actor;
  readonly loadRelationships: () => Promise<RelationshipSnapshot>;
  readonly correlationId: string;
  readonly ip: string | null;
}

export interface KnowledgeServiceDeps {
  readonly db: Database;
  readonly repository: KnowledgeRepository;
  readonly engine: PolicyEngine;
  readonly securityEvents: SecurityEventRecorder;
  readonly embeddings: EmbeddingProvider;
}

export interface RetrievalResult {
  readonly chunks: RetrievedVectorChunk[];
  readonly coursesInScope: number;
  readonly embeddingModel: string;
}

export interface KnowledgeService {
  indexCourse(ctx: ActorContext, courseId: string): Promise<IndexCourseResponse>;
  retrieve(ctx: ActorContext, input: RagRetrieveRequest): Promise<RetrievalResult>;
}

export function createKnowledgeService(deps: KnowledgeServiceDeps): KnowledgeService {
  const { db, repository, engine, securityEvents, embeddings } = deps;

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
   * Never a query string and never a chunk. A learner's question is a record of
   * what they did not understand, which is close enough to private that the
   * audit trail — read by more people than the lesson is — must not hold it.
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

  return {
    /**
     * Rebuilds a course's entry in the knowledge base.
     *
     * REPLACE, NEVER APPEND. The course's rows for this model are deleted
     * first, in the same transaction as the insert, so a re-index cannot leave
     * chunks of a lesson that has since been unpublished or deleted. Appending
     * would make the index a growing record of everything the course has ever
     * said — including the paragraph an author removed because it was wrong.
     *
     * ONE TRANSACTION, so a failure halfway leaves the previous index intact
     * rather than a course indexed to its third lesson.
     */
    async indexCourse(ctx, courseId) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const guarded = await repository.findCourse(tx, courseId);
        if (!guarded) {
          await recordDenial(ctx, 'course:index', 'course', courseId, 'absent_or_not_visible');
          throw notFound();
        }
        const decision = await decide(ctx, 'course:index', guarded.resource);
        const course = guarded.unwrap(decision, 'course:index');

        // PUBLISHED LESSONS ONLY, and the repository enforces it in SQL. The
        // service does not filter afterwards, because a filter that can be
        // forgotten is a filter that will be.
        const lessons = await repository.publishedLessons(tx, courseId);
        const skipped = await repository.unpublishedLessonCount(tx, courseId);

        const removed = await repository.clearCourseIndex(tx, courseId, embeddings.model);

        const chunks: CurriculumChunk[] = [];
        const sourceUpdatedAt = new Map<string, Date>();
        for (const lesson of lessons) {
          chunks.push(...chunkLesson(lesson));
          sourceUpdatedAt.set(lesson.lessonId, lesson.updatedAt);
        }

        let written = 0;
        if (chunks.length > 0) {
          const vectors = await embeddings.embed(chunks.map((chunk) => chunk.content));
          written = await repository.insertChunks(
            tx,
            chunks,
            vectors,
            embeddings.model,
            sourceUpdatedAt,
          );
        }

        await emit(ctx, SecurityEventType.KNOWLEDGE_INDEX_REBUILT, {
          resourceKind: 'course',
          resourceId: courseId,
          organizationId: course.organizationId,
          lessonsIndexed: lessons.length,
          chunksWritten: written,
          chunksRemoved: removed,
          embeddingModel: embeddings.model,
        });

        return {
          courseId,
          lessonsIndexed: lessons.length,
          chunksWritten: written,
          chunksRemoved: removed,
          embeddingModel: embeddings.model,
          lessonsSkipped: skipped,
        };
      });
    },

    /**
     * THE PRE-FILTER, and the order of the three steps below is the whole
     * security property of this endpoint.
     *
     *   1. Compute the courses this actor reaches, from the live enrolment
     *      graph. Nothing the client sent participates.
     *   2. INTERSECT any client filter with that set. A `courseId` outside it
     *      does not raise — it narrows to nothing, because distinguishing "not
     *      yours" from "does not exist" is an oracle for other schools'
     *      catalogs.
     *   3. Only then search, scoped to what step 2 produced.
     *
     * A version that searched first and filtered afterwards would read every
     * tenant's vectors into memory in order to decide it was not allowed to,
     * and would leak through timing and through any future logging of the
     * pre-filter result set. Section 3 of the task forbids it and this ordering
     * is how the forbidding is implemented.
     */
    async retrieve(ctx, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const reachable = await repository.coursesInScope(tx, ctx.actor.id);

        const scoped =
          input.courseId === undefined
            ? reachable
            : reachable.filter((id) => id === input.courseId);

        if (scoped.length === 0) {
          // Recorded, not raised. A learner asking about a course they have
          // just been unenrolled from is an ordinary event; a burst of them
          // across many course ids from one actor is catalog probing, and the
          // difference is visible in the audit trail rather than in the
          // response, which stays identical either way.
          await emit(ctx, SecurityEventType.KNOWLEDGE_RETRIEVAL_EMPTY_SCOPE, {
            requestedCourseId: input.courseId ?? null,
            coursesReachable: reachable.length,
          });
          return { chunks: [], coursesInScope: reachable.length, embeddingModel: embeddings.model };
        }

        // The QUERY is embedded here, server-side. The contract has no field
        // for a raw vector: a caller supplying one would be choosing its own
        // neighbourhood in the index rather than describing a question.
        const [queryVector] = await embeddings.embed([input.query]);
        if (!queryVector) throw new Error('The embedding provider returned no vector');

        const chunks = await repository.similar(tx, {
          courseIds: scoped,
          queryVector,
          model: embeddings.model,
          topK: input.topK,
          lessonId: input.lessonId,
        });

        return {
          chunks,
          coursesInScope: reachable.length,
          embeddingModel: embeddings.model,
        };
      });
    },
  };
}
