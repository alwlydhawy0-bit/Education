import { z } from 'zod';

/**
 * Shared primitives for every API contract.
 *
 * Contracts are declared once and used on BOTH sides of the wire: the API
 * validates incoming requests against them, and the web client derives its
 * types from them. A field can therefore not drift between client and server
 * without a type error.
 *
 * Validation here is a security control, not a convenience. Every request
 * schema is `.strict()` so that unknown properties are REJECTED rather than
 * ignored — this is the mass-assignment defence. A request carrying
 * `{"ownerId": "..."}` or `{"roles": ["admin"]}` fails validation instead of
 * being silently dropped (and thus instead of being silently trusted by some
 * future code path that starts reading it).
 */

/** API version prefix. Bumping this is how a breaking change ships safely. */
export const API_VERSION = 'v1' as const;

export const uuidSchema = z.string().uuid({ message: 'must be a UUID' });

/**
 * Note on identifiers: UUIDv4 is used because it is unguessable enough to make
 * bulk enumeration impractical. It is NOT an access control. Every read of an
 * object by id still goes through the policy engine.
 * See docs/security/authorization.md.
 */
export const idSchema = uuidSchema;

export const paginationSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(200).optional(),
  })
  .strict();

export type Pagination = z.infer<typeof paginationSchema>;

export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      detail: z.record(z.unknown()).optional(),
      correlationId: z.string(),
    }),
  })
  .strict();

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
