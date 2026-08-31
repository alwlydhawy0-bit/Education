import { z } from 'zod';
import { idSchema } from './common.ts';

/**
 * Password policy.
 *
 * Length-first, following NIST SP 800-63B: a long passphrase beats a short
 * string with mandatory symbol classes, and composition rules push users toward
 * predictable substitutions. Both bounds are deliberate — the 200-character
 * ceiling bounds the work an attacker can force the Argon2 hasher to do with a
 * single unauthenticated request.
 */
export const passwordSchema = z
  .string()
  .min(12, { message: 'Password must be at least 12 characters' })
  .max(200, { message: 'Password must be at most 200 characters' });

export const emailSchema = z.string().email().max(254).toLowerCase().trim();

/**
 * Rejects C0/C1 control characters and explicit bidirectional overrides.
 *
 * The platform is Arabic-first, so ordinary RTL text must pass untouched. What
 * this blocks is the explicit override/isolate range (U+202A-U+202E and
 * U+2066-U+2069), which can be used to make a display name render deceptively
 * when placed next to other UI text, and the control ranges, which have no
 * legitimate place in a human name.
 *
 * Written as codepoint comparisons rather than a regex literal so that the
 * source file itself contains no control characters.
 */
export function containsDisallowedTextControls(value: string): boolean {
  for (const char of value) {
    const cp = char.codePointAt(0);
    if (cp === undefined) continue;
    const isC0 = cp <= 0x1f;
    const isDelete = cp === 0x7f;
    const isC1 = cp >= 0x80 && cp <= 0x9f;
    const isBidiOverride = cp >= 0x202a && cp <= 0x202e;
    const isBidiIsolate = cp >= 0x2066 && cp <= 0x2069;
    if (isC0 || isDelete || isC1 || isBidiOverride || isBidiIsolate) return true;
  }
  return false;
}

export const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((v) => !containsDisallowedTextControls(v), {
    message: 'Display name contains disallowed control or bidirectional characters',
  });

/**
 * Registration input.
 *
 * There is intentionally NO `roles` field. Roles are assigned by the server; a
 * client that wants to be an admin may ask, but it asks a human. Because the
 * schema is strict, sending one is a 400 rather than a silent no-op.
 */
export const registerRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: displayNameSchema,
    locale: z.enum(['ar', 'en']).default('ar'),
  })
  .strict();

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z
  .object({ email: emailSchema, password: z.string().min(1).max(200) })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const actorRoleSchema = z.enum([
  'student',
  'teacher',
  'guardian',
  'content_author',
  'reviewer',
  'moderator',
  'admin',
  'security_admin',
]);

export const currentUserResponseSchema = z
  .object({
    id: idSchema,
    email: emailSchema,
    displayName: z.string(),
    roles: z.array(actorRoleSchema),
    locale: z.enum(['ar', 'en']),
    organizationId: idSchema.nullable(),
  })
  .strict();

export type CurrentUserResponse = z.infer<typeof currentUserResponseSchema>;
