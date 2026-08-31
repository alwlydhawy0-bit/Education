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

/**
 * Pagination primitives live in `./query.js`, together with sorting and
 * filtering, so that a list endpoint validates all three the same way.
 *
 * The previous schema here accepted a `cursor` that no repository implemented,
 * so a paginating client silently received page one forever. Accepting a
 * parameter you do not honour is worse than not offering it.
 */

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
