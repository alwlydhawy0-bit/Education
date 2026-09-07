import { z } from 'zod';
import { idSchema } from './common.ts';
import { createListQuerySchema } from './query.ts';

/**
 * Contracts for student projects, research artifacts and verifiable portfolios.
 *
 * Read the REQUEST schemas for what is absent. Every one is `.strict()`, so a
 * field not listed is a 400 rather than a value some future code path starts
 * trusting.
 *
 * NOT ACCEPTED FROM A CLIENT, ANYWHERE IN THIS FILE:
 *
 *   studentId / ownerId — the owner is the session, on every route.
 *   organizationId      — derived from the owner by a database trigger.
 *   status              — a project is created `draft` and moves by its own
 *                         verbs. Accepting it would let a learner post a
 *                         `featured` project and award themselves a
 *                         distinction the platform reserves for a teacher.
 *   featuredBy /
 *   featuredAt          — set by the server when a reviewer features the work.
 *   shareToken          — MINTED BY THE DATABASE and never chosen. A caller
 *                         who picks their own token picks a guessable one, and
 *                         a chosen token could collide with a token already
 *                         issued to somebody else's portfolio.
 *   publicSlug on create — see `updatePortfolioRequestSchema`; a slug is
 *                         proposed and may be refused for being taken.
 *
 * ---------------------------------------------------------------------------
 * THE URL RULE
 * ---------------------------------------------------------------------------
 *
 * Section 3 requires "strict regex validation" on `repository_url` and
 * `live_demo_url`. What that has to mean in practice is an ALLOW-LIST OF ONE
 * SCHEME. These two values end up as `href` attributes on a page a stranger is
 * invited to click, which makes them the highest-value injection point in the
 * whole domain: `javascript:` in an href is stored XSS with no script tag in
 * sight, and `data:text/html` is the same attack wearing a different hat.
 *
 * So the rule is not "reject the bad schemes" — that is a deny-list, and the
 * scheme somebody has not thought of yet is the one that gets through. It is
 * `https://` and nothing else, checked here, checked again by a database CHECK,
 * and checked a third time by `publicUrlOrNull` immediately before the bytes
 * reach a browser. Plain `http://` is refused too: a child's portfolio link
 * should not be downgradeable by whoever runs the coffee-shop wifi.
 */

export const projectVisibilitySchema = z.enum(['private', 'class', 'public']);
export type ProjectVisibility = z.infer<typeof projectVisibilitySchema>;

export const projectStatusSchema = z.enum(['draft', 'submitted', 'featured']);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projectArtifactTypeSchema = z.enum(['report_pdf', 'code_file', 'media_asset']);
export type ProjectArtifactType = z.infer<typeof projectArtifactTypeSchema>;

/** 25 MiB, the SQL value. SQL remains the real limit; this makes it a 400. */
export const PROJECT_ARTIFACT_MAX_BYTES = 26_214_400;

/** The longest a URL may be. Matches the database CHECK. */
export const MAX_URL_LENGTH = 2_000;

/**
 * `https://` only. See the header for why this is an allow-list of one.
 *
 * The `\S` class matters as much as the scheme: a URL containing whitespace —
 * a newline in particular — is how a value smuggles a second thing into
 * whatever consumes it, and there is no legitimate URL that needs one.
 */
export const publicUrlSchema = z
  .string()
  .trim()
  .max(MAX_URL_LENGTH)
  .regex(/^https:\/\/\S+$/, { message: 'must be an https:// URL with no whitespace' });

export const projectTitleSchema = z.string().trim().min(1).max(200);
export const projectDescriptionSchema = z.string().max(20_000);

export const createProjectRequestSchema = z
  .object({
    title: projectTitleSchema,
    descriptionMarkdown: projectDescriptionSchema.default(''),
    /**
     * The class this work belongs to, or null for work made outside one.
     *
     * VALIDATED AS A MEMBERSHIP, NOT AS A UUID. The schema can only say "this
     * is a UUID"; that the caller is actually a learner in that class is
     * decided by the service and by a composite foreign key, because a contract
     * has no way to look it up. Naming that here so nobody reads the presence
     * of the field as the presence of a check.
     */
    classId: idSchema.nullable().default(null),
    courseId: idSchema.nullable().default(null),
    repositoryUrl: publicUrlSchema.nullable().default(null),
    liveDemoUrl: publicUrlSchema.nullable().default(null),
    /**
     * Defaults to `private`. A project a learner has not thought about yet is
     * not published; the safe state is the one you get by saying nothing.
     */
    visibility: projectVisibilitySchema.default('private'),
  })
  .strict();
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const updateProjectRequestSchema = z
  .object({
    title: projectTitleSchema.optional(),
    descriptionMarkdown: projectDescriptionSchema.optional(),
    repositoryUrl: publicUrlSchema.nullable().optional(),
    liveDemoUrl: publicUrlSchema.nullable().optional(),
    visibility: projectVisibilitySchema.optional(),
    /**
     * A learner may submit their own work — moving `draft` to `submitted` — and
     * may not name any other status. `featured` is a reviewer's word, and it is
     * absent from this enum rather than present-and-rejected so that a client
     * reading the contract can see there is no way to ask for it.
     */
    status: z.literal('submitted').optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

/**
 * A project as its owner, a classmate or a reviewer sees it.
 *
 * DISTINCT FROM `PublicPortfolioView`, which is built in
 * `apps/api/src/modules/portfolio/public-view.ts` and carries no identifiers at
 * all. This one is for an authenticated reader who already holds a session and
 * will need the id to open the next endpoint; that one is for a stranger.
 * Keeping them as two shapes is what stops "the field the API returns" and "the
 * field a stranger may see" from ever being the same list.
 */
export const projectResponseSchema = z
  .object({
    id: idSchema,
    studentId: idSchema,
    classId: idSchema.nullable(),
    courseId: idSchema.nullable(),
    title: z.string(),
    descriptionMarkdown: z.string(),
    repositoryUrl: z.string().nullable(),
    liveDemoUrl: z.string().nullable(),
    visibility: projectVisibilitySchema,
    status: projectStatusSchema,
    featuredAt: z.string().datetime().nullable(),
    artifacts: z.array(
      z
        .object({
          id: idSchema,
          artifactType: projectArtifactTypeSchema,
          filePathOrUrl: z.string(),
          byteSize: z.number().int(),
          createdAt: z.string().datetime(),
        })
        .strict(),
    ),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ProjectResponse = z.infer<typeof projectResponseSchema>;

/**
 * Attaching an artifact to a project.
 *
 * `filePathOrUrl` accepts `https://` only, for the reason in the header. The
 * database also accepts `artifact://<uuid>` for a file the platform stores
 * itself, and that form is deliberately NOT offered here: nothing on this
 * platform can produce one yet, because `docs/security/file-security.md` makes
 * "never serve unscanned content" a non-negotiable and there is no scanner. The
 * column permits the shape so the migration does not need rewriting when the
 * pipeline exists; the contract stays narrower until it does.
 */
export const attachProjectArtifactRequestSchema = z
  .object({
    artifactType: projectArtifactTypeSchema,
    filePathOrUrl: publicUrlSchema,
    byteSize: z.number().int().positive().max(PROJECT_ARTIFACT_MAX_BYTES),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .refine((v) => Buffer.byteLength(JSON.stringify(v.metadata), 'utf8') <= 16_384, {
    message: 'metadata must serialize to at most 16384 bytes',
    path: ['metadata'],
  });
export type AttachProjectArtifactRequest = z.infer<typeof attachProjectArtifactRequestSchema>;

export const listProjectsQuerySchema = createListQuerySchema({
  sortableFields: ['updatedAt', 'createdAt', 'title'],
  defaultSort: 'updatedAt',
  defaultOrder: 'desc',
  filters: {
    visibility: projectVisibilitySchema.optional(),
    status: projectStatusSchema.optional(),
  },
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

// --- Portfolios ----------------------------------------------------------

export const portfolioTitleSchema = z.string().trim().min(1).max(200);
export const portfolioBioSchema = z.string().max(5_000);

/** Matches `student_portfolios_slug_ck` exactly. Three characters minimum. */
export const publicSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])$/, {
    message: 'must be 3-64 lowercase letters, digits and hyphens, not starting or ending with -',
  });

export const createPortfolioRequestSchema = z
  .object({
    title: portfolioTitleSchema,
    bio: portfolioBioSchema.default(''),
  })
  .strict();
export type CreatePortfolioRequest = z.infer<typeof createPortfolioRequestSchema>;

/**
 * Editing the portfolio.
 *
 * `publicSlug` IS PROPOSED, NOT SET. The namespace is global and the unique
 * index is the arbiter, so a slug already taken comes back as a 409 with
 * alternatives rather than being silently suffixed. Silently changing what a
 * learner typed would hand them a URL they did not choose and would not
 * recognise on a poster.
 *
 * `isPublished` IS NOT HERE. Publishing has its own routes, because "who made
 * this child's work visible to the internet, and when did they take it down"
 * has to be answerable from an action name, not inferred from a PATCH body.
 */
export const updatePortfolioRequestSchema = z
  .object({
    title: portfolioTitleSchema.optional(),
    bio: portfolioBioSchema.optional(),
    publicSlug: publicSlugSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });
export type UpdatePortfolioRequest = z.infer<typeof updatePortfolioRequestSchema>;

/**
 * The portfolio as its OWNER sees it, which is the only authenticated reader
 * there is.
 *
 * `shareToken` and `shareUrl` are returned HERE and nowhere else. The owner
 * needs the link in order to share it, and the person the token was minted for
 * learns nothing new from being shown it. Every other response in this file
 * omits it, and `PublicPortfolioView` cannot carry it at all.
 */
export const portfolioResponseSchema = z
  .object({
    id: idSchema,
    studentId: idSchema,
    title: z.string(),
    bio: z.string(),
    publicSlug: z.string().nullable(),
    shareToken: z.string(),
    isPublished: z.boolean(),
    items: z.array(
      z
        .object({
          projectId: idSchema,
          displayOrder: z.number().int(),
          title: z.string(),
          visibility: projectVisibilitySchema,
          status: projectStatusSchema,
        })
        .strict(),
    ),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type PortfolioResponse = z.infer<typeof portfolioResponseSchema>;

export const addPortfolioItemRequestSchema = z
  .object({
    projectId: idSchema,
    /** 1..500, matching `portfolio_items_order_ck`. Server-assigned if absent. */
    displayOrder: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export type AddPortfolioItemRequest = z.infer<typeof addPortfolioItemRequestSchema>;

// --- The public view -----------------------------------------------------

/**
 * What a stranger holding a share link is told.
 *
 * DECLARED HERE AS A SCHEMA SO THE BOUNDARY IS TESTABLE FROM BOTH SIDES. The
 * constructor in `public-view.ts` builds this shape; the route parses its own
 * output through this schema before sending it. That is not belt and braces for
 * its own sake — `.strict()` means a field that appears in the constructed
 * object without appearing here is a 500 rather than a leak, so the failure
 * mode of a mistake in this domain is an error page instead of a disclosure.
 *
 * NO IDENTIFIER APPEARS BELOW. Not the portfolio's, not a project's, not the
 * owner's. That is section 3's requirement stated as a type.
 */
export const publicPortfolioResponseSchema = z
  .object({
    title: z.string(),
    bio: z.string(),
    // No author name. See `PublicPortfolioView` for why the field was removed
    // rather than repaired: the title and bio are what the learner wrote FOR
    // this page, and an account display name is not.
    projects: z.array(
      z
        .object({
          position: z.number().int().positive(),
          title: z.string(),
          description: z.string(),
          repositoryUrl: z.string().nullable(),
          liveDemoUrl: z.string().nullable(),
          featured: z.boolean(),
          artifacts: z.array(
            z
              .object({
                kind: projectArtifactTypeSchema,
                url: z.string(),
                byteSize: z.number().int(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
export type PublicPortfolioResponse = z.infer<typeof publicPortfolioResponseSchema>;
