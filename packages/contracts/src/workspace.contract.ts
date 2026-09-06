import { z } from 'zod';
import { idSchema } from './common.ts';
import { createListQuerySchema } from './query.ts';

/**
 * Contracts for the student workspace: notebooks and personal artifacts.
 *
 * Read the REQUEST schemas for what is absent rather than what is present.
 * Every one is `.strict()`, so a field not listed is a 400 rather than a
 * silently-ignored value that some future code path starts trusting.
 *
 * NOT ACCEPTED FROM A CLIENT, ANYWHERE IN THIS FILE:
 *
 *   ownerId / studentId — the owner is the session, on every route.
 *   organizationId      — derived from the owner by a database trigger.
 *   storageKey          — DERIVED, and the reason is below.
 *   createdAt           — the server clock.
 *
 * THERE IS NO FIELD FOR A PATH OR A URL, and that is the sharpest decision in
 * this file. `student_artifacts.storage_key` is built by a database trigger
 * from the owner's organization, the owner and the row's own id. A path chosen
 * by a caller is an arbitrary-reference bug wearing a metadata field's clothes:
 * it lets a client name a location inside another tenant's prefix, or somewhere
 * outside the store altogether, and every later reader inherits that choice.
 * `docs/security/file-security.md` already says a filename is never a storage
 * path; this is that rule with nowhere to type the filename in the first place.
 */

export const studentArtifactTypeSchema = z.enum(['image', 'code_snippet', 'pdf', 'data_export']);
export type StudentArtifactType = z.infer<typeof studentArtifactTypeSchema>;

// --- Notebooks -----------------------------------------------------------

export const notebookTitleSchema = z.string().trim().min(1).max(200);
export const notebookDescriptionSchema = z.string().max(2_000);

export const createNotebookRequestSchema = z
  .object({
    title: notebookTitleSchema,
    description: notebookDescriptionSchema.default(''),
  })
  .strict();
export type CreateNotebookRequest = z.infer<typeof createNotebookRequestSchema>;

export const updateNotebookRequestSchema = z
  .object({
    title: notebookTitleSchema.optional(),
    description: notebookDescriptionSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });
export type UpdateNotebookRequest = z.infer<typeof updateNotebookRequestSchema>;

/**
 * A notebook.
 *
 * There is no `visibility` and no `sharedWith`. A notebook is a container whose
 * contents are individually shareable; sharing the container would share things
 * the child never opened, including notes they write into it tomorrow.
 */
export const notebookResponseSchema = z
  .object({
    id: idSchema,
    ownerId: idSchema,
    title: z.string(),
    description: z.string(),
    /** How many live notes are filed here. Server-derived. */
    noteCount: z.number().int(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type NotebookResponse = z.infer<typeof notebookResponseSchema>;

export const listNotebooksQuerySchema = createListQuerySchema({
  sortableFields: ['updatedAt', 'createdAt', 'title'],
  defaultSort: 'updatedAt',
  defaultOrder: 'desc',
});
export type ListNotebooksQuery = z.infer<typeof listNotebooksQuerySchema>;

// --- Artifacts -----------------------------------------------------------

/**
 * 25 MiB per artifact, 256 MiB per learner. Both are the SQL values, and SQL
 * remains the real limit — the quota especially, because a service that reads
 * a total and then inserts races two concurrent registrations straight past the
 * ceiling. This bound exists so an oversized request is a 400 naming the field
 * rather than a constraint violation surfacing as a 500.
 */
export const ARTIFACT_MAX_BYTES = 26_214_400;
export const ARTIFACT_QUOTA_BYTES = 268_435_456;

/**
 * AN ALLOW-LIST PER ARTIFACT TYPE, never a deny-list — non-negotiable 1 of
 * `docs/security/file-security.md`.
 *
 * This is the DECLARED type, and it is metadata only. When an upload pipeline
 * exists the real type must be determined from magic bytes and must match what
 * was declared; until then this bounds what a client may claim, which is the
 * most a registry without bytes can honestly do.
 *
 * `image/svg+xml` is absent on purpose. SVG is a document that can carry script,
 * not a picture, and it is the classic stored-XSS payload dressed as an image.
 */
export const ALLOWED_CONTENT_TYPES: Readonly<Record<StudentArtifactType, readonly string[]>> =
  Object.freeze({
    image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    code_snippet: ['text/plain', 'text/markdown', 'application/json', 'text/csv'],
    pdf: ['application/pdf'],
    data_export: ['application/json', 'text/csv', 'text/plain'],
  });

/**
 * Registering an artifact.
 *
 * `originalFilename` is kept for DISPLAY and is never used as a path — the
 * storage key does not contain it and cannot be influenced by it, so traversal
 * has nowhere to land.
 */
export const registerArtifactRequestSchema = z
  .object({
    artifactType: studentArtifactTypeSchema,
    declaredContentType: z.string().trim().min(1).max(128),
    originalFilename: z.string().max(255).default(''),
    byteSize: z.number().int().positive().max(ARTIFACT_MAX_BYTES),
    /** At most one parent, and it must be the caller's own. Enforced by FK. */
    noteId: idSchema.nullable().optional(),
    sessionId: idSchema.nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .refine((v) => ALLOWED_CONTENT_TYPES[v.artifactType].includes(v.declaredContentType), {
    message: 'that content type is not accepted for this artifact type',
    path: ['declaredContentType'],
  })
  .refine((v) => !(v.noteId && v.sessionId), {
    message: 'an artifact hangs off a note or a lab session, not both',
    path: ['sessionId'],
  })
  .refine((v) => Buffer.byteLength(JSON.stringify(v.metadata), 'utf8') <= 16_384, {
    message: 'metadata must serialize to at most 16384 bytes',
    path: ['metadata'],
  });
export type RegisterArtifactRequest = z.infer<typeof registerArtifactRequestSchema>;

/**
 * A registered artifact.
 *
 * `storageKey` IS RETURNED, to its owner and to nobody else. It names a
 * location in a store that has no reader yet, and disclosing it to the person
 * whose organization and user id it is built from tells them nothing they did
 * not supply. It is not a capability: there is no route that exchanges it for
 * bytes, because nothing scans them.
 */
export const studentArtifactResponseSchema = z
  .object({
    id: idSchema,
    ownerId: idSchema,
    noteId: idSchema.nullable(),
    sessionId: idSchema.nullable(),
    artifactType: studentArtifactTypeSchema,
    storageKey: z.string(),
    declaredContentType: z.string(),
    originalFilename: z.string(),
    byteSize: z.number().int(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime(),
  })
  .strict();
export type StudentArtifactResponse = z.infer<typeof studentArtifactResponseSchema>;

/** What the learner has spent of their own allowance. Their own id only. */
export const storageQuotaResponseSchema = z
  .object({
    usedBytes: z.number().int(),
    quotaBytes: z.number().int(),
    artifactCount: z.number().int(),
  })
  .strict();
export type StorageQuotaResponse = z.infer<typeof storageQuotaResponseSchema>;

export const listArtifactsQuerySchema = createListQuerySchema({
  sortableFields: ['createdAt', 'byteSize'],
  defaultSort: 'createdAt',
  defaultOrder: 'desc',
  filters: {
    artifactType: studentArtifactTypeSchema.optional(),
    noteId: idSchema.optional(),
  },
});
export type ListArtifactsQuery = z.infer<typeof listArtifactsQuerySchema>;
