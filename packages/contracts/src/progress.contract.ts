import { z } from 'zod';
import { idSchema } from './common.ts';
import { createListQuerySchema } from './query.ts';

/**
 * Contracts for learner progress.
 *
 * The request body carries ONE field: the status the learner is claiming. Not
 * the learner (that is the session), not the lesson (that is the URL), and not
 * a timestamp of any kind.
 *
 * Timestamps are especially deliberate. `completedAt` and `lastAccessedAt` come
 * from the SERVER clock, always. A client-supplied completion time is a client
 * writing history — backdating work, or claiming to have finished something
 * before it was published — and there is no reason to accept one.
 */

export const progressStatusSchema = z.enum(['not_started', 'in_progress', 'completed']);
export type ProgressStatus = z.infer<typeof progressStatusSchema>;

export const recordProgressRequestSchema = z.object({ status: progressStatusSchema }).strict();
export type RecordProgressRequest = z.infer<typeof recordProgressRequestSchema>;

/**
 * A progress row, with the names around its lesson.
 *
 * The names are here because a record the reader cannot interpret is not a
 * record. They are resolved server-side through a definer helper rather than a
 * join, so a learner who has left the class still sees a legible history — see
 * `app_lesson_label` in migration 0018.
 *
 * What is deliberately ABSENT: any lesson CONTENT. The body, the objectives and
 * the external link stay behind the content policy; a progress row discloses
 * what was studied, never the material itself.
 */
export const progressResponseSchema = z
  .object({
    lessonId: idSchema,
    lessonTitle: z.string(),
    unitTitle: z.string(),
    courseId: idSchema,
    courseTitle: z.string(),
    status: progressStatusSchema,
    completedAt: z.string().datetime().nullable(),
    lastAccessedAt: z.string().datetime(),
  })
  .strict();
export type ProgressResponse = z.infer<typeof progressResponseSchema>;

/**
 * Sortable by when it was last touched or when it was completed — the two
 * questions anyone actually asks of a progress list. Filterable by status only.
 *
 * There is no `userId` filter on any of these. Whose progress is being read is
 * decided by the ROUTE and the session, never by a query parameter.
 */
export const listProgressQuerySchema = createListQuerySchema({
  sortableFields: ['lastAccessedAt', 'completedAt', 'lessonTitle'],
  defaultSort: 'lastAccessedAt',
  defaultOrder: 'desc',
  filters: { status: progressStatusSchema.optional(), courseId: idSchema.optional() },
});
export type ListProgressQuery = z.infer<typeof listProgressQuerySchema>;
