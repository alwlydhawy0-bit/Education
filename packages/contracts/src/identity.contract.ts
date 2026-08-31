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

/**
 * Opaque token carried in a link (email verification, password reset).
 *
 * Bounded and character-restricted so a malformed value is rejected before it
 * reaches a hash function or the database. 43 characters is the base64url
 * encoding of 32 random bytes; the range allows for future token sizes without
 * accepting arbitrary input.
 */
export const opaqueTokenSchema = z
  .string()
  .min(20)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, { message: 'Malformed token' });

export const verifyEmailRequestSchema = z.object({ token: opaqueTokenSchema }).strict();
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;

export const forgotPasswordRequestSchema = z.object({ email: emailSchema }).strict();
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

/**
 * Reset carries the new password, so the full registration password policy
 * applies — a reset must not be a way to set a weaker password than signup
 * would have allowed.
 */
export const resetPasswordRequestSchema = z
  .object({ token: opaqueTokenSchema, password: passwordSchema })
  .strict();
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

/** The authenticated user's own view of themselves. */
export const currentUserV2Schema = z
  .object({
    id: idSchema,
    email: emailSchema,
    displayName: z.string(),
    roles: z.array(actorRoleSchema),
    grants: z.array(
      z.object({
        role: actorRoleSchema,
        scopeType: z.enum(['global', 'organization', 'class']),
        scopeId: idSchema.nullable(),
      }),
    ),
    permissions: z.array(z.string()),
    locale: z.enum(['ar', 'en']),
    organizationId: idSchema.nullable(),
    emailVerified: z.boolean(),
  })
  .strict();

export type CurrentUserV2 = z.infer<typeof currentUserV2Schema>;

// --- Profile ---------------------------------------------------------------

export const profileResponseSchema = z
  .object({
    userId: idSchema,
    displayName: z.string(),
    fullName: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    bio: z.string(),
    locale: z.enum(['ar', 'en']),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ProfileResponse = z.infer<typeof profileResponseSchema>;

/**
 * Profile updates carry no `userId`: ownership comes from the session. There is
 * no field here for an attacker to point at somebody else's profile.
 */
export const updateProfileRequestSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    fullName: z.string().trim().min(1).max(200).nullable().optional(),
    // https only. A `data:` or `javascript:` URL rendered as an avatar is an
    // XSS vector, and an arbitrary scheme is an SSRF vector for any future
    // server-side fetch. Mirrored by a CHECK constraint in migration 0009.
    avatarUrl: z.string().url().startsWith('https://').max(2000).nullable().optional(),
    bio: z.string().max(2000).optional(),
    locale: z.enum(['ar', 'en']).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

// --- Administration --------------------------------------------------------

export const userStatusSchema = z.enum(['active', 'suspended', 'pending_verification']);

export const adminUserResponseSchema = z
  .object({
    id: idSchema,
    email: emailSchema,
    displayName: z.string(),
    status: userStatusSchema,
    organizationId: idSchema.nullable(),
    emailVerified: z.boolean(),
    roles: z.array(actorRoleSchema),
    createdAt: z.string().datetime(),
  })
  .strict();

export type AdminUserResponse = z.infer<typeof adminUserResponseSchema>;

/** Only the status is settable here. Everything else belongs to the user. */
export const adminUpdateUserRequestSchema = z.object({ status: userStatusSchema }).strict();

export type AdminUpdateUserRequest = z.infer<typeof adminUpdateUserRequestSchema>;

export const roleScopeTypeSchema = z.enum(['global', 'organization', 'class']);

export const assignRoleRequestSchema = z
  .object({
    role: actorRoleSchema,
    scopeType: roleScopeTypeSchema.default('global'),
    scopeId: idSchema.nullable().default(null),
  })
  .strict()
  // A scoped grant with no target is not scoped at all; a global grant with one
  // is a contradiction. Rejecting both here mirrors the CHECK constraint on
  // user_roles, so the two layers cannot disagree.
  .refine((v) => (v.scopeType === 'global') === (v.scopeId === null), {
    message: 'scopeId must be provided for scoped grants and omitted for global grants',
  });

export type AssignRoleRequest = z.infer<typeof assignRoleRequestSchema>;
