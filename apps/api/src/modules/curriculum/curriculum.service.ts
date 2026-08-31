import { conflict, forbidden, notFound } from '@edu/kernel';
import {
  type Action,
  type Actor,
  type AuthorizationContext,
  type ContentStatus,
  type Decision,
  type Guarded,
  type PolicyEngine,
  type RelationshipSnapshot,
  type Resource,
} from '@edu/authz';
import { SecurityEventType } from '@edu/observability';
import type {
  CreateCourseRequest,
  CreateCurriculumRequest,
  CreateEducationLevelRequest,
  CreateLessonRequest,
  CreateUnitRequest,
  ListChildrenQuery,
  ListCoursesQuery,
  ListCurriculaQuery,
  ReorderRequest,
  UpdateCourseRequest,
  UpdateCurriculumRequest,
  UpdateEducationLevelRequest,
  UpdateLessonRequest,
  UpdateUnitRequest,
} from '@edu/contracts';
import type { Database, Tx } from '../../platform/db.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import {
  ContentInUseError,
  DuplicateCodeError,
  type CourseRecord,
  type CurriculumRecord,
  type CurriculumRepository,
  type EducationLevelRecord,
  type LessonRecord,
  type UnitRecord,
} from './curriculum.repository.ts';

export interface ActorContext {
  readonly actor: Actor;
  readonly loadRelationships: () => Promise<RelationshipSnapshot>;
  readonly correlationId: string;
  readonly ip: string | null;
}

export interface CurriculumServiceDeps {
  readonly db: Database;
  readonly repository: CurriculumRepository;
  readonly engine: PolicyEngine;
  readonly securityEvents: SecurityEventRecorder;
}

export interface CurriculumService {
  listLevels(ctx: ActorContext): Promise<EducationLevelRecord[]>;
  createLevel(ctx: ActorContext, input: CreateEducationLevelRequest): Promise<EducationLevelRecord>;
  updateLevel(
    ctx: ActorContext,
    id: string,
    input: UpdateEducationLevelRequest,
  ): Promise<EducationLevelRecord>;

  listCurricula(ctx: ActorContext, query: ListCurriculaQuery): Promise<CurriculumRecord[]>;
  getCurriculum(ctx: ActorContext, id: string): Promise<CurriculumRecord>;
  createCurriculum(ctx: ActorContext, input: CreateCurriculumRequest): Promise<CurriculumRecord>;
  updateCurriculum(
    ctx: ActorContext,
    id: string,
    input: UpdateCurriculumRequest,
  ): Promise<CurriculumRecord>;
  setCurriculumStatus(
    ctx: ActorContext,
    id: string,
    status: Exclude<ContentStatus, 'draft'>,
  ): Promise<CurriculumRecord>;
  deleteCurriculum(ctx: ActorContext, id: string): Promise<void>;

  listCourses(ctx: ActorContext, query: ListCoursesQuery): Promise<CourseRecord[]>;
  getCourse(ctx: ActorContext, id: string): Promise<CourseRecord>;
  createCourse(ctx: ActorContext, input: CreateCourseRequest): Promise<CourseRecord>;
  updateCourse(ctx: ActorContext, id: string, input: UpdateCourseRequest): Promise<CourseRecord>;
  setCourseStatus(
    ctx: ActorContext,
    id: string,
    status: Exclude<ContentStatus, 'draft'>,
  ): Promise<CourseRecord>;
  deleteCourse(ctx: ActorContext, id: string): Promise<void>;

  listUnits(ctx: ActorContext, courseId: string, query: ListChildrenQuery): Promise<UnitRecord[]>;
  getUnit(ctx: ActorContext, id: string): Promise<UnitRecord>;
  createUnit(ctx: ActorContext, courseId: string, input: CreateUnitRequest): Promise<UnitRecord>;
  updateUnit(ctx: ActorContext, id: string, input: UpdateUnitRequest): Promise<UnitRecord>;
  setUnitStatus(
    ctx: ActorContext,
    id: string,
    status: Exclude<ContentStatus, 'draft'>,
  ): Promise<UnitRecord>;
  deleteUnit(ctx: ActorContext, id: string): Promise<void>;
  reorderUnits(ctx: ActorContext, courseId: string, input: ReorderRequest): Promise<UnitRecord[]>;

  listLessons(ctx: ActorContext, unitId: string, query: ListChildrenQuery): Promise<LessonRecord[]>;
  getLesson(ctx: ActorContext, id: string): Promise<LessonRecord>;
  createLesson(
    ctx: ActorContext,
    unitId: string,
    input: CreateLessonRequest,
  ): Promise<LessonRecord>;
  updateLesson(ctx: ActorContext, id: string, input: UpdateLessonRequest): Promise<LessonRecord>;
  setLessonStatus(
    ctx: ActorContext,
    id: string,
    status: Exclude<ContentStatus, 'draft'>,
  ): Promise<LessonRecord>;
  deleteLesson(ctx: ActorContext, id: string): Promise<void>;
  reorderLessons(ctx: ActorContext, unitId: string, input: ReorderRequest): Promise<LessonRecord[]>;
}

export function createCurriculumService(deps: CurriculumServiceDeps): CurriculumService {
  const { db, repository, engine, securityEvents } = deps;

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
      detail: { action, resourceKind, resourceId, reason },
      occurredAt: new Date(),
    });
  }

  const emit = (
    ctx: ActorContext,
    type: SecurityEventType,
    detail: Record<string, unknown>,
  ): Promise<void> =>
    securityEvents.record({
      type,
      actorId: ctx.actor.id,
      correlationId: ctx.correlationId,
      ip: ctx.ip,
      detail,
      occurredAt: new Date(),
    });

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
   * The single gate for reaching one content node by id.
   *
   * Every read, write, lifecycle move and delete goes through here, so "may
   * this actor touch this node at all?" is answered in one place. A caller that
   * loaded a row some other way would hold a `Guarded<T>` it cannot open.
   */
  async function authorize<T>(
    ctx: ActorContext,
    guarded: Guarded<T> | null,
    action: Action,
    kind: string,
    id: string,
  ): Promise<T> {
    if (!guarded) {
      // A node that does not exist and one RLS hid are indistinguishable to the
      // caller — deliberately — but the probe is still recorded.
      await recordDenial(ctx, action, kind, id, 'absent_or_not_visible');
      throw notFound();
    }
    const decision = await decide(ctx, action, guarded.resource);
    return guarded.unwrap(decision, action);
  }

  /**
   * Resolves the organization a new node belongs to.
   *
   * `global: true` asks for the shared catalog; anything else means the
   * caller's own school. The request never names an organization id, so there
   * is no field through which a caller could aim at another school — and an
   * actor with no organization asking for a non-global node matches nothing.
   */
  function ownerOrganization(ctx: ActorContext, wantsGlobal: boolean): string | null {
    return wantsGlobal ? null : ctx.actor.organizationId;
  }

  /**
   * Rewrites a sequence, having proved the submitted ids are exactly the
   * current ones.
   *
   * The equality check is the security control, not a convenience: without it a
   * reorder could name an id from another course (silently repositioning it, or
   * confirming it exists) or omit one (leaving a hole in the sequence). The
   * comparison is on SETS, so a caller learns nothing about ids it did not
   * already have.
   */
  async function rewriteOrder(
    current: readonly string[],
    submitted: readonly string[],
  ): Promise<void> {
    const currentSet = new Set(current);
    const submittedSet = new Set(submitted);
    const sameSize = currentSet.size === submittedSet.size;
    const sameMembers = [...currentSet].every((id) => submittedSet.has(id));
    if (!sameSize || !sameMembers) {
      throw conflict('The submitted order must list exactly the current items, once each');
    }
  }

  return {
    // ================= Education levels =================================
    async listLevels(ctx) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const levels = await repository.listLevels(tx);
        const authContext: AuthorizationContext = {
          actor: ctx.actor,
          relationships: await ctx.loadRelationships(),
        };
        // Filtered by the policy as well as by RLS. Levels are readable by
        // every actor, so this is a no-op today — and it is exactly the sort of
        // listing that would otherwise quietly rest on one gate (VULN-017).
        return levels.filter(
          (level) =>
            engine.decide(authContext, 'education_level:list', {
              kind: 'education_level',
              id: level.id,
            }).effect === 'allow',
        );
      });
    },

    async createLevel(ctx, input) {
      await decide(ctx, 'education_level:create', { kind: 'education_level', id: 'new' });
      return db.withActor(ctx.actor.id, async (tx) => {
        const created = await withDuplicateCodeAsConflict(() =>
          repository.insertLevel(tx, {
            code: input.code,
            name: input.name,
            stage: input.stage,
            grade: input.grade,
            sortOrder: input.sortOrder,
          }),
        );
        await emit(ctx, SecurityEventType.EDUCATION_LEVEL_CHANGED, {
          levelId: created.id,
          change: 'created',
        });
        return created;
      });
    },

    async updateLevel(ctx, id, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const existing = await repository.findLevel(tx, id);
        if (!existing) {
          await recordDenial(ctx, 'education_level:update', 'education_level', id, 'absent');
          throw notFound();
        }
        await decide(ctx, 'education_level:update', { kind: 'education_level', id });
        const updated = await repository.updateLevel(tx, id, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        });
        if (!updated) throw notFound();
        await emit(ctx, SecurityEventType.EDUCATION_LEVEL_CHANGED, {
          levelId: id,
          change: 'updated',
        });
        return updated;
      });
    },

    // ================= Curricula ========================================
    async listCurricula(ctx, query) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const rows = await repository.listCurricula(tx, query, ctx.actor.organizationId);
        const authContext: AuthorizationContext = {
          actor: ctx.actor,
          relationships: await ctx.loadRelationships(),
        };
        return rows.filter(
          (row) =>
            engine.decide(authContext, 'curriculum:list', {
              kind: 'curriculum',
              id: row.id,
              organizationId: row.organizationId,
              status: row.status,
              ancestorsPublished: true,
            }).effect === 'allow',
        );
      });
    },

    async getCurriculum(ctx, id) {
      return db.withActor(ctx.actor.id, async (tx) =>
        authorize(
          ctx,
          await repository.findCurriculum(tx, id),
          'curriculum:read',
          'curriculum',
          id,
        ),
      );
    },

    async createCurriculum(ctx, input) {
      const organizationId = ownerOrganization(ctx, input.global);
      await decide(ctx, 'curriculum:create', {
        kind: 'curriculum',
        id: 'new',
        organizationId,
        status: 'draft',
        ancestorsPublished: true,
      });
      return db.withActor(ctx.actor.id, async (tx) => {
        const created = await withDuplicateCodeAsConflict(() =>
          repository.insertCurriculum(tx, {
            organizationId,
            code: input.code,
            name: input.name,
            description: input.description,
            createdBy: ctx.actor.id,
          }),
        );
        await emit(ctx, SecurityEventType.CONTENT_CREATED, {
          resourceKind: 'curriculum',
          resourceId: created.id,
          organizationId,
        });
        return created;
      });
    },

    async updateCurriculum(ctx, id, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        await authorize(
          ctx,
          await repository.findCurriculum(tx, id),
          'curriculum:update',
          'curriculum',
          id,
        );
        const updated = await repository.updateCurriculum(tx, id, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        });
        if (!updated) throw notFound();
        await emit(ctx, SecurityEventType.CONTENT_UPDATED, {
          resourceKind: 'curriculum',
          resourceId: id,
        });
        return updated;
      });
    },

    async setCurriculumStatus(ctx, id, status) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const action = status === 'published' ? 'curriculum:publish' : 'curriculum:archive';
        await authorize(ctx, await repository.findCurriculum(tx, id), action, 'curriculum', id);
        const updated = await repository.setCurriculumStatus(tx, id, status);
        if (!updated) throw notFound();
        await emit(
          ctx,
          status === 'published'
            ? SecurityEventType.CONTENT_PUBLISHED
            : SecurityEventType.CONTENT_ARCHIVED,
          { resourceKind: 'curriculum', resourceId: id, organizationId: updated.organizationId },
        );
        return updated;
      });
    },

    async deleteCurriculum(ctx, id) {
      await db.withActor(ctx.actor.id, async (tx) => {
        await authorize(
          ctx,
          await repository.findCurriculum(tx, id),
          'curriculum:delete',
          'curriculum',
          id,
        );
        try {
          if (!(await repository.deleteCurriculum(tx, id))) throw notFound();
        } catch (error) {
          // A catalog entry with courses under it is a state the caller can
          // resolve — by moving or deleting those courses — so it is a
          // conflict, not an internal error.
          if (error instanceof ContentInUseError) {
            throw conflict('This curriculum still has courses filed under it');
          }
          throw error;
        }
        await emit(ctx, SecurityEventType.CONTENT_DELETED, {
          resourceKind: 'curriculum',
          resourceId: id,
        });
      });
    },

    // ================= Courses ==========================================
    async listCourses(ctx, query) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const rows = await repository.listCourses(tx, query, ctx.actor.organizationId);
        const authContext: AuthorizationContext = {
          actor: ctx.actor,
          relationships: await ctx.loadRelationships(),
        };
        return rows.filter(
          (row) =>
            engine.decide(authContext, 'course:list', {
              kind: 'course',
              id: row.id,
              organizationId: row.organizationId,
              curriculumId: row.curriculumId,
              levelId: row.levelId,
              status: row.status,
              ancestorsPublished: true,
            }).effect === 'allow',
        );
      });
    },

    async getCourse(ctx, id) {
      return db.withActor(ctx.actor.id, async (tx) =>
        authorize(ctx, await repository.findCourse(tx, id), 'course:read', 'course', id),
      );
    },

    async createCourse(ctx, input) {
      const organizationId = ownerOrganization(ctx, input.global);
      await decide(ctx, 'course:create', {
        kind: 'course',
        id: 'new',
        organizationId,
        curriculumId: input.curriculumId,
        levelId: input.levelId,
        status: 'draft',
        ancestorsPublished: true,
      });
      return db.withActor(ctx.actor.id, async (tx) => {
        // The curriculum and level must be ones this actor can actually SEE.
        // Without this, a caller could file a course under an id they guessed —
        // and the resulting 201 would confirm the id names something real.
        await requireVisibleParents(ctx, tx, input.curriculumId, input.levelId);
        const created = await repository.insertCourse(tx, {
          organizationId,
          curriculumId: input.curriculumId,
          levelId: input.levelId,
          title: input.title,
          summary: input.summary,
          createdBy: ctx.actor.id,
        });
        await emit(ctx, SecurityEventType.CONTENT_CREATED, {
          resourceKind: 'course',
          resourceId: created.id,
          organizationId,
        });
        return created;
      });
    },

    async updateCourse(ctx, id, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        await authorize(ctx, await repository.findCourse(tx, id), 'course:update', 'course', id);
        if (input.curriculumId !== undefined || input.levelId !== undefined) {
          await requireVisibleParents(ctx, tx, input.curriculumId, input.levelId);
        }
        const updated = await repository.updateCourse(tx, id, {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.curriculumId !== undefined ? { curriculumId: input.curriculumId } : {}),
          ...(input.levelId !== undefined ? { levelId: input.levelId } : {}),
        });
        if (!updated) throw notFound();
        await emit(ctx, SecurityEventType.CONTENT_UPDATED, {
          resourceKind: 'course',
          resourceId: id,
        });
        return updated;
      });
    },

    async setCourseStatus(ctx, id, status) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const action = status === 'published' ? 'course:publish' : 'course:archive';
        await authorize(ctx, await repository.findCourse(tx, id), action, 'course', id);
        const updated = await repository.setCourseStatus(tx, id, status);
        if (!updated) throw notFound();
        await emit(
          ctx,
          status === 'published'
            ? SecurityEventType.CONTENT_PUBLISHED
            : SecurityEventType.CONTENT_ARCHIVED,
          { resourceKind: 'course', resourceId: id, organizationId: updated.organizationId },
        );
        return updated;
      });
    },

    async deleteCourse(ctx, id) {
      await db.withActor(ctx.actor.id, async (tx) => {
        await authorize(ctx, await repository.findCourse(tx, id), 'course:delete', 'course', id);
        if (!(await repository.deleteCourse(tx, id))) throw notFound();
        await emit(ctx, SecurityEventType.CONTENT_DELETED, {
          resourceKind: 'course',
          resourceId: id,
        });
      });
    },

    // ================= Units ============================================
    async listUnits(ctx, courseId, query) {
      return db.withActor(ctx.actor.id, async (tx) => {
        // Reaching the children requires being able to read the parent first.
        await authorize(
          ctx,
          await repository.findCourse(tx, courseId),
          'course:read',
          'course',
          courseId,
        );
        const rows = await repository.listUnits(tx, courseId, query);
        const authContext: AuthorizationContext = {
          actor: ctx.actor,
          relationships: await ctx.loadRelationships(),
        };
        const course = await repository.findCourse(tx, courseId);
        const courseResource = course?.resource;
        const organizationId =
          courseResource?.kind === 'course' ? courseResource.organizationId : null;
        const coursePublished =
          courseResource?.kind === 'course' && courseResource.status === 'published';
        return rows.filter(
          (row) =>
            engine.decide(authContext, 'course_unit:list', {
              kind: 'course_unit',
              id: row.id,
              courseId,
              organizationId,
              status: row.status,
              ancestorsPublished: coursePublished,
            }).effect === 'allow',
        );
      });
    },

    async getUnit(ctx, id) {
      return db.withActor(ctx.actor.id, async (tx) =>
        authorize(ctx, await repository.findUnit(tx, id), 'course_unit:read', 'course_unit', id),
      );
    },

    async createUnit(ctx, courseId, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const course = await repository.findCourse(tx, courseId);
        // Adding to a course is a WRITE to that course's structure, so the
        // parent is authorized for update — not merely for read.
        const parent = await authorize(ctx, course, 'course:update', 'course', courseId);
        await decide(ctx, 'course_unit:create', {
          kind: 'course_unit',
          id: 'new',
          courseId,
          organizationId: parent.organizationId,
          status: 'draft',
          ancestorsPublished: parent.status === 'published',
        });
        const created = await repository.insertUnit(tx, {
          courseId,
          title: input.title,
          summary: input.summary,
          createdBy: ctx.actor.id,
        });
        await emit(ctx, SecurityEventType.CONTENT_CREATED, {
          resourceKind: 'course_unit',
          resourceId: created.id,
          courseId,
        });
        return created;
      });
    },

    async updateUnit(ctx, id, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        await authorize(
          ctx,
          await repository.findUnit(tx, id),
          'course_unit:update',
          'course_unit',
          id,
        );
        const updated = await repository.updateUnit(tx, id, {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
        });
        if (!updated) throw notFound();
        await emit(ctx, SecurityEventType.CONTENT_UPDATED, {
          resourceKind: 'course_unit',
          resourceId: id,
        });
        return updated;
      });
    },

    async setUnitStatus(ctx, id, status) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const action = status === 'published' ? 'course_unit:publish' : 'course_unit:archive';
        await authorize(ctx, await repository.findUnit(tx, id), action, 'course_unit', id);
        const updated = await repository.setUnitStatus(tx, id, status);
        if (!updated) throw notFound();
        await emit(
          ctx,
          status === 'published'
            ? SecurityEventType.CONTENT_PUBLISHED
            : SecurityEventType.CONTENT_ARCHIVED,
          { resourceKind: 'course_unit', resourceId: id, courseId: updated.courseId },
        );
        return updated;
      });
    },

    async deleteUnit(ctx, id) {
      await db.withActor(ctx.actor.id, async (tx) => {
        await authorize(
          ctx,
          await repository.findUnit(tx, id),
          'course_unit:delete',
          'course_unit',
          id,
        );
        if (!(await repository.deleteUnit(tx, id))) throw notFound();
        await emit(ctx, SecurityEventType.CONTENT_DELETED, {
          resourceKind: 'course_unit',
          resourceId: id,
        });
      });
    },

    async reorderUnits(ctx, courseId, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        // Reordering restructures the COURSE, so it is authorized as a course
        // update rather than as a write to each unit.
        await authorize(
          ctx,
          await repository.findCourse(tx, courseId),
          'course:update',
          'course',
          courseId,
        );
        const current = await repository.unitIdsInOrder(tx, courseId);
        await rewriteOrder(current, input.order);
        await repository.applyUnitOrder(tx, courseId, input.order);
        await emit(ctx, SecurityEventType.CONTENT_REORDERED, {
          resourceKind: 'course_unit',
          courseId,
          count: input.order.length,
        });
        return repository.listUnits(tx, courseId, {
          limit: 100,
          offset: 0,
          sort: 'position',
          order: 'asc',
        });
      });
    },

    // ================= Lessons ==========================================
    async listLessons(ctx, unitId, query) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const unit = await repository.findUnit(tx, unitId);
        await authorize(ctx, unit, 'course_unit:read', 'course_unit', unitId);
        const unitResource = unit?.resource;
        const rows = await repository.listLessons(tx, unitId, query);
        const authContext: AuthorizationContext = {
          actor: ctx.actor,
          relationships: await ctx.loadRelationships(),
        };
        const organizationId =
          unitResource?.kind === 'course_unit' ? unitResource.organizationId : null;
        const courseId = unitResource?.kind === 'course_unit' ? unitResource.courseId : '';
        // A lesson's ancestors are the unit AND the course above it. The unit's
        // own resource already answers "is my course published?", so the chain
        // is `unit published AND its ancestors published`.
        const ancestorsPublished =
          unitResource?.kind === 'course_unit' &&
          unitResource.status === 'published' &&
          unitResource.ancestorsPublished;
        return rows.filter(
          (row) =>
            engine.decide(authContext, 'lesson:list', {
              kind: 'lesson',
              id: row.id,
              unitId,
              courseId,
              organizationId,
              status: row.status,
              ancestorsPublished,
            }).effect === 'allow',
        );
      });
    },

    async getLesson(ctx, id) {
      return db.withActor(ctx.actor.id, async (tx) =>
        authorize(ctx, await repository.findLesson(tx, id), 'lesson:read', 'lesson', id),
      );
    },

    async createLesson(ctx, unitId, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const unit = await repository.findUnit(tx, unitId);
        const parent = await authorize(ctx, unit, 'course_unit:update', 'course_unit', unitId);
        const unitResource = unit?.resource;
        const organizationId =
          unitResource?.kind === 'course_unit' ? unitResource.organizationId : null;
        await decide(ctx, 'lesson:create', {
          kind: 'lesson',
          id: 'new',
          unitId,
          courseId: parent.courseId,
          organizationId,
          status: 'draft',
          ancestorsPublished:
            unitResource?.kind === 'course_unit' &&
            unitResource.status === 'published' &&
            unitResource.ancestorsPublished,
        });
        const created = await repository.insertLesson(tx, {
          unitId,
          title: input.title,
          summary: input.summary,
          contentFormat: input.contentFormat,
          contentBody: input.contentBody,
          externalUrl: input.externalUrl,
          estimatedMinutes: input.estimatedMinutes,
          objectives: input.objectives,
          createdBy: ctx.actor.id,
        });
        await emit(ctx, SecurityEventType.CONTENT_CREATED, {
          resourceKind: 'lesson',
          resourceId: created.id,
          unitId,
        });
        return created;
      });
    },

    async updateLesson(ctx, id, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        await authorize(ctx, await repository.findLesson(tx, id), 'lesson:update', 'lesson', id);
        const updated = await repository.updateLesson(tx, id, {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.contentFormat !== undefined ? { contentFormat: input.contentFormat } : {}),
          ...(input.contentBody !== undefined ? { contentBody: input.contentBody } : {}),
          ...(input.externalUrl !== undefined ? { externalUrl: input.externalUrl } : {}),
          ...(input.estimatedMinutes !== undefined
            ? { estimatedMinutes: input.estimatedMinutes }
            : {}),
          ...(input.objectives !== undefined ? { objectives: input.objectives } : {}),
        });
        if (!updated) throw notFound();
        await emit(ctx, SecurityEventType.CONTENT_UPDATED, {
          resourceKind: 'lesson',
          resourceId: id,
        });
        return updated;
      });
    },

    async setLessonStatus(ctx, id, status) {
      return db.withActor(ctx.actor.id, async (tx) => {
        const action = status === 'published' ? 'lesson:publish' : 'lesson:archive';
        await authorize(ctx, await repository.findLesson(tx, id), action, 'lesson', id);
        const updated = await repository.setLessonStatus(tx, id, status);
        if (!updated) throw notFound();
        await emit(
          ctx,
          status === 'published'
            ? SecurityEventType.CONTENT_PUBLISHED
            : SecurityEventType.CONTENT_ARCHIVED,
          { resourceKind: 'lesson', resourceId: id, unitId: updated.unitId },
        );
        return updated;
      });
    },

    async deleteLesson(ctx, id) {
      await db.withActor(ctx.actor.id, async (tx) => {
        await authorize(ctx, await repository.findLesson(tx, id), 'lesson:delete', 'lesson', id);
        if (!(await repository.deleteLesson(tx, id))) throw notFound();
        await emit(ctx, SecurityEventType.CONTENT_DELETED, {
          resourceKind: 'lesson',
          resourceId: id,
        });
      });
    },

    async reorderLessons(ctx, unitId, input) {
      return db.withActor(ctx.actor.id, async (tx) => {
        await authorize(
          ctx,
          await repository.findUnit(tx, unitId),
          'course_unit:update',
          'course_unit',
          unitId,
        );
        const current = await repository.lessonIdsInOrder(tx, unitId);
        await rewriteOrder(current, input.order);
        await repository.applyLessonOrder(tx, unitId, input.order);
        await emit(ctx, SecurityEventType.CONTENT_REORDERED, {
          resourceKind: 'lesson',
          unitId,
          count: input.order.length,
        });
        return repository.listLessons(tx, unitId, {
          limit: 100,
          offset: 0,
          sort: 'position',
          order: 'asc',
        });
      });
    },
  };

  /**
   * Turns a taken code into a 409.
   *
   * A duplicate code is a state the caller can resolve by choosing another one,
   * so it is a conflict — not an internal error, which is what an untranslated
   * unique violation becomes. It also discloses nothing: a caller may only
   * insert into a catalog they can already read.
   */
  async function withDuplicateCodeAsConflict<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DuplicateCodeError) {
        throw conflict('That code is already used in this catalog');
      }
      throw error;
    }
  }

  /**
   * A course may only be filed under a curriculum and a level the caller can
   * see.
   *
   * The database enforces the structural half (a course may not use another
   * school's private subject — trigger `course_curriculum_is_in_scope`). This
   * enforces the disclosure half: without it, `POST /courses` with a guessed
   * curriculum id would answer 201 or 409 depending on whether that id is real.
   */
  async function requireVisibleParents(
    ctx: ActorContext,
    tx: Tx,
    curriculumId: string | undefined,
    levelId: string | undefined,
  ): Promise<void> {
    if (curriculumId !== undefined) {
      await authorize(
        ctx,
        await repository.findCurriculum(tx, curriculumId),
        'curriculum:read',
        'curriculum',
        curriculumId,
      );
    }
    if (levelId !== undefined) {
      const level = await repository.findLevel(tx, levelId);
      if (!level) {
        await recordDenial(ctx, 'education_level:read', 'education_level', levelId, 'absent');
        throw notFound();
      }
    }
  }
}
