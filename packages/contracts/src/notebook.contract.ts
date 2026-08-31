import { z } from 'zod';
import { idSchema } from './common.ts';
import { createListQuerySchema } from './query.ts';

export const noteVisibilitySchema = z.enum([
  'private',
  'shared_with_teacher',
  'shared_with_guardian',
]);

export const noteTitleSchema = z.string().trim().min(1).max(200);

/**
 * Note body size cap. 64 KiB is generous for a study note and bounds both
 * storage growth and the cost of any future parsing/indexing pass.
 */
export const noteBodySchema = z.string().max(65_536);

/**
 * Create/update inputs carry NO `ownerId` and NO `id`.
 *
 * Ownership is taken from the authenticated session, never from the request.
 * This is the contract-level half of the IDOR defence: even if a handler were
 * careless, there is no field here for an attacker to put someone else's id in.
 */
export const createNoteRequestSchema = z
  .object({
    title: noteTitleSchema,
    body: noteBodySchema.default(''),
    visibility: noteVisibilitySchema.default('private'),
  })
  .strict();

export type CreateNoteRequest = z.infer<typeof createNoteRequestSchema>;

export const updateNoteRequestSchema = z
  .object({
    title: noteTitleSchema.optional(),
    body: noteBodySchema.optional(),
    visibility: noteVisibilitySchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export type UpdateNoteRequest = z.infer<typeof updateNoteRequestSchema>;

export const noteResponseSchema = z
  .object({
    id: idSchema,
    ownerId: idSchema,
    title: z.string(),
    body: z.string(),
    visibility: noteVisibilitySchema,
    state: z.enum(['active', 'archived', 'deleted']),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type NoteResponse = z.infer<typeof noteResponseSchema>;

/**
 * Query contract for `GET /notes`.
 *
 * `state` is filterable but the enum deliberately omits `deleted`: a
 * soft-deleted note behaves as if it does not exist, and offering a filter for
 * it would be a way to ask "what did I delete?" that the policy does not grant.
 */
export const NOTE_SORTABLE_FIELDS = ['updatedAt', 'createdAt', 'title'] as const;
export type NoteSortField = (typeof NOTE_SORTABLE_FIELDS)[number];

export const listNotesQuerySchema = createListQuerySchema({
  sortableFields: NOTE_SORTABLE_FIELDS,
  defaultSort: 'updatedAt',
  defaultOrder: 'desc',
  filters: {
    visibility: noteVisibilitySchema.optional(),
    state: z.enum(['active', 'archived']).optional(),
  },
});

export type ListNotesQuery = z.infer<typeof listNotesQuerySchema>;
