import { z } from 'zod';
import { idSchema } from './common.ts';
import { createListQuerySchema } from './query.ts';

/**
 * Contracts for the educational content tree.
 *
 * Three properties hold across every schema in this file, and each is a
 * security control rather than a convenience:
 *
 *   - **No request body carries `status`.** The lifecycle moves through its own
 *     endpoints, gated on a different permission. A `status` field here would
 *     let an author publish by writing JSON.
 *   - **No request body carries `organizationId`.** Ownership comes from the
 *     session; a cross-tenant write is not expressible before any policy runs.
 *   - **No request body carries `createdBy`.** Authorship is the session's user,
 *     recorded by the server and pinned immutable by a trigger.
 *
 * All three are also enforced by `.strict()`: sending any of them is a 400, not
 * a silently-dropped field. A field that is quietly ignored is a lie to the
 * client, and eventually to whoever starts reading it.
 */

export const contentStatusSchema = z.enum(['draft', 'published', 'archived']);
export type ContentStatus = z.infer<typeof contentStatusSchema>;

const titleSchema = z.string().trim().min(1).max(200);
const descriptionSchema = z.string().trim().max(4000);
/** Stable machine key. Lower-case, matching the database CHECK exactly. */
const codeSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,49}$/, 'must be lower-case letters, digits and underscores');

// --- Education levels ------------------------------------------------------

export const educationStageSchema = z.enum(['primary', 'middle', 'secondary', 'university']);

export const createEducationLevelRequestSchema = z
  .object({
    code: codeSchema,
    name: z.string().trim().min(1).max(120),
    stage: educationStageSchema,
    grade: z.number().int().min(1).max(12).nullable().default(null),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();
export type CreateEducationLevelRequest = z.infer<typeof createEducationLevelRequestSchema>;

export const updateEducationLevelRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });
export type UpdateEducationLevelRequest = z.infer<typeof updateEducationLevelRequestSchema>;

export const educationLevelResponseSchema = z
  .object({
    id: idSchema,
    code: z.string(),
    name: z.string(),
    stage: educationStageSchema,
    grade: z.number().int().nullable(),
    sortOrder: z.number().int(),
  })
  .strict();

// --- Curricula (the subject catalog) ---------------------------------------

export const createCurriculumRequestSchema = z
  .object({
    code: codeSchema,
    name: titleSchema,
    description: descriptionSchema.default(''),
    /**
     * Requests the GLOBAL catalog rather than the caller's own organization.
     *
     * A boolean, not an organization id: the only two destinations are "my
     * school" and "the shared catalog", and only a platform operator passes the
     * policy for the second. Modelling it as an id would invite a caller to
     * name somebody else's school.
     */
    global: z.boolean().default(false),
  })
  .strict();
export type CreateCurriculumRequest = z.infer<typeof createCurriculumRequestSchema>;

export const updateCurriculumRequestSchema = z
  .object({
    name: titleSchema.optional(),
    description: descriptionSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });
export type UpdateCurriculumRequest = z.infer<typeof updateCurriculumRequestSchema>;

export const curriculumResponseSchema = z
  .object({
    id: idSchema,
    organizationId: idSchema.nullable(),
    code: z.string(),
    name: z.string(),
    description: z.string(),
    status: contentStatusSchema,
    createdAt: z.string().datetime(),
    publishedAt: z.string().datetime().nullable(),
  })
  .strict();

// --- Courses ---------------------------------------------------------------

export const createCourseRequestSchema = z
  .object({
    curriculumId: idSchema,
    levelId: idSchema,
    title: titleSchema,
    summary: descriptionSchema.default(''),
    global: z.boolean().default(false),
  })
  .strict();
export type CreateCourseRequest = z.infer<typeof createCourseRequestSchema>;

export const updateCourseRequestSchema = z
  .object({
    title: titleSchema.optional(),
    summary: descriptionSchema.optional(),
    // The curriculum and level a course is filed under are editorial metadata
    // and may be corrected. Its ORGANIZATION may not — that is ownership, and a
    // trigger refuses the change even if this schema ever admitted it.
    curriculumId: idSchema.optional(),
    levelId: idSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });
export type UpdateCourseRequest = z.infer<typeof updateCourseRequestSchema>;

export const courseResponseSchema = z
  .object({
    id: idSchema,
    organizationId: idSchema.nullable(),
    curriculumId: idSchema,
    levelId: idSchema,
    title: z.string(),
    summary: z.string(),
    status: contentStatusSchema,
    createdAt: z.string().datetime(),
    publishedAt: z.string().datetime().nullable(),
  })
  .strict();

// --- Units -----------------------------------------------------------------

export const createUnitRequestSchema = z
  .object({ title: titleSchema, summary: descriptionSchema.default('') })
  .strict();
export type CreateUnitRequest = z.infer<typeof createUnitRequestSchema>;

export const updateUnitRequestSchema = z
  .object({ title: titleSchema.optional(), summary: descriptionSchema.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });
export type UpdateUnitRequest = z.infer<typeof updateUnitRequestSchema>;

export const unitResponseSchema = z
  .object({
    id: idSchema,
    courseId: idSchema,
    position: z.number().int(),
    title: z.string(),
    summary: z.string(),
    status: contentStatusSchema,
    createdAt: z.string().datetime(),
    publishedAt: z.string().datetime().nullable(),
  })
  .strict();

// --- Lessons ---------------------------------------------------------------

/**
 * Lesson content is MARKDOWN or PLAIN TEXT, never HTML.
 *
 * Accepting HTML would make every lesson a stored-XSS vector aimed at children,
 * and the renderer that would have to neutralise it does not live in this
 * repository to be audited. `plain` exists so a body can be stored verbatim
 * when it must not be interpreted at all.
 */
export const lessonContentFormatSchema = z.enum(['markdown', 'plain']);

/**
 * Maximum lesson body, in CHARACTERS.
 *
 * Deliberately well under the 256 KiB request-body limit rather than equal to
 * it. A limit the transport rejects before validation ever runs is not a limit,
 * it is a lie: the client is told 262,144 and receives a 413 at 200,000. The
 * gap also has to hold for ARABIC, where a character is two UTF-8 bytes — so
 * 64,000 characters is at most ~128 KB on the wire, and the rest of the request
 * still fits.
 *
 * The database CHECK is deliberately looser (65,536), so it remains a true
 * backstop for anything that reaches the table without passing through here.
 */
export const LESSON_BODY_MAX_CHARS = 64_000;

/**
 * `https://` only, matching the database CHECK.
 *
 * A `javascript:` URL is script injection and a `data:` URL is the same thing
 * wearing a hat; an arbitrary scheme becomes an SSRF vector the moment anything
 * server-side follows it. The same reasoning as `avatarUrl` in the identity
 * contract.
 */
const externalUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => v.startsWith('https://'), { message: 'must be an https:// URL' })
  .refine((v) => !/\s/.test(v), { message: 'must not contain whitespace' });

export const createLessonRequestSchema = z
  .object({
    title: titleSchema,
    summary: descriptionSchema.default(''),
    contentFormat: lessonContentFormatSchema.default('markdown'),
    contentBody: z.string().max(LESSON_BODY_MAX_CHARS).default(''),
    externalUrl: externalUrlSchema.nullable().default(null),
    estimatedMinutes: z.number().int().min(1).max(1440).nullable().default(null),
    objectives: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  })
  .strict();
export type CreateLessonRequest = z.infer<typeof createLessonRequestSchema>;

export const updateLessonRequestSchema = z
  .object({
    title: titleSchema.optional(),
    summary: descriptionSchema.optional(),
    contentFormat: lessonContentFormatSchema.optional(),
    contentBody: z.string().max(LESSON_BODY_MAX_CHARS).optional(),
    externalUrl: externalUrlSchema.nullable().optional(),
    estimatedMinutes: z.number().int().min(1).max(1440).nullable().optional(),
    objectives: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });
export type UpdateLessonRequest = z.infer<typeof updateLessonRequestSchema>;

export const lessonResponseSchema = z
  .object({
    id: idSchema,
    unitId: idSchema,
    position: z.number().int(),
    title: z.string(),
    summary: z.string(),
    contentFormat: lessonContentFormatSchema,
    contentBody: z.string(),
    externalUrl: z.string().nullable(),
    estimatedMinutes: z.number().int().nullable(),
    objectives: z.array(z.string()),
    status: contentStatusSchema,
    createdAt: z.string().datetime(),
    publishedAt: z.string().datetime().nullable(),
  })
  .strict();

// --- Reordering ------------------------------------------------------------

/**
 * A reorder names the COMPLETE new sequence, not a move.
 *
 * "Put item X at position 4" is ambiguous the moment two clients send it at
 * once, and it cannot be validated against anything. A full ordering can:
 * the service checks the submitted set is exactly the current set, so a
 * reorder can neither add an id the caller does not own nor silently drop one.
 */
export const reorderRequestSchema = z
  .object({ order: z.array(idSchema).min(1).max(500) })
  .strict()
  .refine((v) => new Set(v.order).size === v.order.length, {
    message: 'ids must not repeat',
    path: ['order'],
  });
export type ReorderRequest = z.infer<typeof reorderRequestSchema>;

// --- List queries ----------------------------------------------------------
// Every sortable field and every filter is allow-listed. A sort field reaches
// SQL as an identifier, where a parameter placeholder cannot help, so the
// allow-list IS the injection defence. Filters are allow-listed too: filtering
// by an attribute the caller may not read and counting the results discloses it.

export const listCurriculaQuerySchema = createListQuerySchema({
  sortableFields: ['createdAt', 'name', 'code'],
  defaultSort: 'name',
  defaultOrder: 'asc',
  filters: {
    status: contentStatusSchema.optional(),
    /** `global` restricts to the shared catalog; `organization` to the caller's own. */
    scope: z.enum(['global', 'organization']).optional(),
  },
});
export type ListCurriculaQuery = z.infer<typeof listCurriculaQuerySchema>;

export const listCoursesQuerySchema = createListQuerySchema({
  sortableFields: ['createdAt', 'title'],
  defaultSort: 'title',
  defaultOrder: 'asc',
  filters: {
    status: contentStatusSchema.optional(),
    scope: z.enum(['global', 'organization']).optional(),
    levelId: idSchema.optional(),
    curriculumId: idSchema.optional(),
  },
});
export type ListCoursesQuery = z.infer<typeof listCoursesQuerySchema>;

/** Units and lessons are always returned in sequence; position is the order. */
export const listChildrenQuerySchema = createListQuerySchema({
  sortableFields: ['position'],
  defaultSort: 'position',
  defaultOrder: 'asc',
  filters: { status: contentStatusSchema.optional() },
});
export type ListChildrenQuery = z.infer<typeof listChildrenQuerySchema>;
