import { z } from 'zod';
import { idSchema } from './common.ts';
import { createListQuerySchema } from './query.ts';
import { contentStatusSchema } from './curriculum.contract.ts';

/**
 * Contracts for assigning a course to a class.
 *
 * The request names a COURSE and nothing else. The class comes from the URL,
 * the assigner from the session, and the status is always `active` — so the
 * only thing a caller can express is "this class studies that course", which is
 * the whole of the decision anyone should be making here.
 *
 * There is deliberately no `organizationId` and no `status` field: both would
 * be routes around the tenancy and lifecycle rules, and `.strict()` rejects
 * them with a 400 rather than dropping them silently.
 */

export const assignmentStatusSchema = z.enum(['active', 'inactive', 'archived']);
export type AssignmentStatus = z.infer<typeof assignmentStatusSchema>;

/**
 * Dates are DESCRIPTIVE. Neither gates access.
 *
 * A date that silently controlled visibility would be an authorization rule
 * hiding in a calendar field, and it would depend on a clock — server time,
 * client time, a timezone — that this system does not treat as a gate. What a
 * class may see is decided by the assignment's status, not by today's date.
 */
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)')
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'must be a real date' });

export const assignCourseRequestSchema = z
  .object({
    courseId: idSchema,
    startsOn: isoDateSchema.nullable().default(null),
    dueOn: isoDateSchema.nullable().default(null),
  })
  .strict()
  .refine((v) => v.startsOn === null || v.dueOn === null || v.dueOn >= v.startsOn, {
    message: 'dueOn must not precede startsOn',
    path: ['dueOn'],
  });
export type AssignCourseRequest = z.infer<typeof assignCourseRequestSchema>;

export const classCourseResponseSchema = z
  .object({
    id: idSchema,
    classId: idSchema,
    courseId: idSchema,
    courseTitle: z.string(),
    courseStatus: contentStatusSchema,
    status: assignmentStatusSchema,
    assignedAt: z.string().datetime(),
    startsOn: z.string().nullable(),
    dueOn: z.string().nullable(),
  })
  .strict();
export type ClassCourseResponse = z.infer<typeof classCourseResponseSchema>;

/**
 * A course a learner reaches through one of their classes.
 *
 * Carries the class it came through, because "why can I see this?" is a
 * question a learner interface has to be able to answer — and because the
 * answer is the whole access rule in one field.
 */
export const enrolledCourseResponseSchema = z
  .object({
    courseId: idSchema,
    classId: idSchema,
    className: z.string(),
    title: z.string(),
    summary: z.string(),
    levelId: idSchema,
    curriculumId: idSchema,
    assignedAt: z.string().datetime(),
    startsOn: z.string().nullable(),
    dueOn: z.string().nullable(),
  })
  .strict();
export type EnrolledCourseResponse = z.infer<typeof enrolledCourseResponseSchema>;

export const listClassCoursesQuerySchema = createListQuerySchema({
  sortableFields: ['assignedAt', 'courseTitle'],
  defaultSort: 'assignedAt',
  defaultOrder: 'desc',
  filters: { status: assignmentStatusSchema.optional() },
});
export type ListClassCoursesQuery = z.infer<typeof listClassCoursesQuerySchema>;

/**
 * `GET /me/courses` offers NO status filter.
 *
 * A learner's own list is by definition the ACTIVE assignments — a withdrawn
 * course is not one they are studying. Offering the filter would imply the
 * endpoint could return the others, which it cannot and should not.
 */
export const listMyCoursesQuerySchema = createListQuerySchema({
  sortableFields: ['assignedAt', 'title'],
  defaultSort: 'assignedAt',
  defaultOrder: 'desc',
});
export type ListMyCoursesQuery = z.infer<typeof listMyCoursesQuerySchema>;
