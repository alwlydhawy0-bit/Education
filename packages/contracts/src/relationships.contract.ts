import { z } from 'zod';
import { idSchema } from './common.ts';
import { createListQuerySchema } from './query.ts';

/**
 * Contracts for organizations, classes, rosters and guardian links.
 *
 * The consistent shape across all of them: **no request body ever names the
 * organization**. Organization scope comes from the authenticated session, so
 * there is no field for a caller to point at another school. That is the
 * contract-level half of the cross-tenant defence; the policy engine and RLS are
 * the other two.
 */

// --- Organizations ---------------------------------------------------------

export const organizationNameSchema = z.string().trim().min(1).max(200);

export const createOrganizationRequestSchema = z.object({ name: organizationNameSchema }).strict();
export type CreateOrganizationRequest = z.infer<typeof createOrganizationRequestSchema>;

export const updateOrganizationRequestSchema = z.object({ name: organizationNameSchema }).strict();
export type UpdateOrganizationRequest = z.infer<typeof updateOrganizationRequestSchema>;

export const organizationResponseSchema = z
  .object({ id: idSchema, name: z.string(), createdAt: z.string().datetime() })
  .strict();
export type OrganizationResponse = z.infer<typeof organizationResponseSchema>;

// --- Classes ---------------------------------------------------------------

export const classNameSchema = z.string().trim().min(1).max(200);
/** Free-form because academic calendars differ; bounded so it cannot grow. */
export const academicTermSchema = z.string().trim().max(50);

/**
 * Creating a class takes no `organizationId`: it is always the caller's own
 * organization. A cross-tenant create is therefore not expressible.
 */
export const createClassRequestSchema = z
  .object({ name: classNameSchema, academicTerm: academicTermSchema.default('') })
  .strict();
export type CreateClassRequest = z.infer<typeof createClassRequestSchema>;

export const updateClassRequestSchema = z
  .object({ name: classNameSchema.optional(), academicTerm: academicTermSchema.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });
export type UpdateClassRequest = z.infer<typeof updateClassRequestSchema>;

export const classResponseSchema = z
  .object({
    id: idSchema,
    organizationId: idSchema,
    name: z.string(),
    academicTerm: z.string(),
    status: z.enum(['active', 'archived']),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ClassResponse = z.infer<typeof classResponseSchema>;

export const listClassesQuerySchema = createListQuerySchema({
  sortableFields: ['createdAt', 'name'],
  defaultSort: 'createdAt',
  defaultOrder: 'desc',
  filters: { status: z.enum(['active', 'archived']).optional() },
});
export type ListClassesQuery = z.infer<typeof listClassesQuerySchema>;

// --- Rosters ---------------------------------------------------------------

export const classMemberRoleSchema = z.enum(['student', 'assistant', 'observer']);
export const teacherRoleInClassSchema = z.enum(['teacher', 'assistant_teacher', 'substitute']);

export const addClassMemberRequestSchema = z
  .object({ userId: idSchema, roleInClass: classMemberRoleSchema.default('student') })
  .strict();
export type AddClassMemberRequest = z.infer<typeof addClassMemberRequestSchema>;

export const addTeacherRequestSchema = z
  .object({ teacherId: idSchema, roleInClass: teacherRoleInClassSchema.default('teacher') })
  .strict();
export type AddTeacherRequest = z.infer<typeof addTeacherRequestSchema>;

export const classMemberResponseSchema = z
  .object({
    id: idSchema,
    classId: idSchema,
    userId: idSchema,
    displayName: z.string(),
    roleInClass: classMemberRoleSchema,
    status: z.enum(['active', 'ended']),
    joinedAt: z.string().datetime(),
  })
  .strict();
export type ClassMemberResponse = z.infer<typeof classMemberResponseSchema>;

export const classTeacherResponseSchema = z
  .object({
    id: idSchema,
    classId: idSchema,
    teacherId: idSchema,
    displayName: z.string(),
    roleInClass: teacherRoleInClassSchema,
    status: z.enum(['active', 'ended']),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ClassTeacherResponse = z.infer<typeof classTeacherResponseSchema>;

// --- Guardian links --------------------------------------------------------

export const guardianRelationshipTypeSchema = z.enum(['parent', 'guardian', 'caregiver']);

/**
 * A guardian claims a link to a child.
 *
 * There is no `status` field: a new claim is always `pending` and grants
 * nothing. Verification is a separate, administrator-only action, so the
 * request cannot assert its own approval.
 */
export const createGuardianLinkRequestSchema = z
  .object({
    childId: idSchema,
    relationshipType: guardianRelationshipTypeSchema.default('guardian'),
  })
  .strict();
export type CreateGuardianLinkRequest = z.infer<typeof createGuardianLinkRequestSchema>;

export const guardianLinkResponseSchema = z
  .object({
    id: idSchema,
    guardianId: idSchema,
    childId: idSchema,
    relationshipType: guardianRelationshipTypeSchema,
    status: z.enum(['pending', 'verified', 'revoked']),
    createdAt: z.string().datetime(),
    verifiedAt: z.string().datetime().nullable(),
  })
  .strict();
export type GuardianLinkResponse = z.infer<typeof guardianLinkResponseSchema>;
