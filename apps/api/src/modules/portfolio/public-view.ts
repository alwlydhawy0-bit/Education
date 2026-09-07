/**
 * The public boundary: what a stranger is allowed to be told, and how a
 * portfolio's name is derived.
 *
 * PURE FUNCTIONS, NO DATABASE, NO CLOCK, NO RANDOMNESS EXCEPT WHERE NAMED.
 * Everything here is input -> output, which is what lets
 * `tests/unit/portfolio-public-view.test.ts` enumerate the leak cases without a
 * server.
 *
 * ---------------------------------------------------------------------------
 * THE SANITIZER IS A CONSTRUCTOR, NOT A FILTER
 * ---------------------------------------------------------------------------
 *
 * `toPublicPortfolio` does not take a row and remove fields from it. It takes a
 * row and BUILDS a new object out of named pieces, and the difference is the
 * whole point.
 *
 * A filter is a deny-list: it removes what somebody remembered to remove, and a
 * column added to the table next year arrives on the public page by default. A
 * constructor is an allow-list: a new column is invisible until somebody
 * deliberately writes a line to expose it, and writing that line is the moment
 * a reviewer gets to object.
 *
 * Section 3 requires that the resolver "MUST use a dedicated sanitized DTO to
 * prevent leaking internal database IDs, student emails, or private system
 * metadata". The internal ids are the sharpest of those: a portfolio's own
 * `id`, a project's `id`, an item's `id` and the owner's `student_id` are all
 * primary keys that appear in other endpoints' URLs. Handing them to a stranger
 * turns a public page into a directory of things to try elsewhere.
 *
 * SO NO IDENTIFIER LEAVES THIS FUNCTION. Not the portfolio's, not the
 * projects', not the owner's. A public project is addressed by its position in
 * the list, which is meaningful on the page and meaningless anywhere else.
 */

/** A project as a stranger may see it. Every field is here on purpose. */
export interface PublicProjectView {
  /** Position in the portfolio. NOT a database id — see the header. */
  readonly position: number;
  readonly title: string;
  readonly description: string;
  readonly repositoryUrl: string | null;
  readonly liveDemoUrl: string | null;
  /** Present only when a teacher featured it. Never who, and never when. */
  readonly featured: boolean;
  readonly artifacts: readonly PublicArtifactView[];
}

export interface PublicArtifactView {
  readonly kind: 'report_pdf' | 'code_file' | 'media_asset';
  /**
   * Only ever an `https://` location.
   *
   * The database permits `artifact://<uuid>` as well, for a file the platform
   * itself stores — and that form is DROPPED here rather than rendered. A
   * stranger has no session, so an internal reference would be either a broken
   * link or, worse, a hint about a storage layout. When signed URLs exist this
   * becomes the place that mints one.
   */
  readonly url: string;
  readonly byteSize: number;
}

/**
 * THERE IS NO AUTHOR NAME HERE, and its absence is the most deliberate thing in
 * this file.
 *
 * The first version carried `authorDisplayName`, read from `users.display_name`
 * — the name a child's school registered them under. Two things killed it.
 *
 * The mechanical one: `users` has RLS, the public path runs with no actor, and
 * `users_select` admits nothing to a caller who is not somebody's teacher,
 * guardian or self. The JOIN silently returned zero rows and took down every
 * public page on the platform. That was a bug and could have been fixed.
 *
 * The real one is that fixing it would have been the wrong thing to do. An
 * account display name is registration data a child gave their school, not
 * something they composed for the internet, and this page is served to anybody
 * holding a link. A portfolio already carries a `title` and a `bio` the learner
 * WROTE, knowing they were writing them for this page — so if they want their
 * name on it, they can put it there, and if they want to be "Y10 Physics" they
 * can be that instead. The platform does not decide for them.
 *
 * The task specification never asked for an author name. It was invented here,
 * and removing it is the correction.
 */
export interface PublicPortfolioView {
  readonly title: string;
  readonly bio: string;
  readonly projects: readonly PublicProjectView[];
}

/** The shape the repository hands in. Deliberately wider than the view. */
export interface PortfolioSourceRow {
  readonly title: string;
  readonly bio: string;
}

export interface ProjectSourceRow {
  readonly displayOrder: number;
  readonly title: string;
  readonly descriptionMarkdown: string;
  readonly repositoryUrl: string | null;
  readonly liveDemoUrl: string | null;
  readonly status: string;
  readonly artifacts: ReadonlyArray<{
    readonly artifactType: string;
    readonly filePathOrUrl: string;
    readonly byteSize: number;
  }>;
}

const PUBLIC_ARTIFACT_KINDS = new Set(['report_pdf', 'code_file', 'media_asset']);

/**
 * Builds the public view. The ONLY function that may produce one.
 *
 * It assumes its inputs were already filtered by the database — the RLS
 * policies decide which projects a token opens — and does not re-derive that
 * decision, because two places deciding one thing is how they come to disagree.
 * What it guarantees is narrower and complementary: whatever reaches it, only
 * these fields leave.
 */
export function toPublicPortfolio(
  portfolio: PortfolioSourceRow,
  projects: readonly ProjectSourceRow[],
): PublicPortfolioView {
  return {
    title: portfolio.title,
    bio: portfolio.bio,
    projects: [...projects]
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((project, index) => ({
        // RENUMBERED FROM THE SORTED ORDER, not copied from `displayOrder`.
        // The stored value can have gaps — a learner deletes item 2 of 3 — and
        // a gap tells a stranger something was removed. Position is 1..n.
        position: index + 1,
        title: project.title,
        description: project.descriptionMarkdown,
        repositoryUrl: publicUrlOrNull(project.repositoryUrl),
        liveDemoUrl: publicUrlOrNull(project.liveDemoUrl),
        featured: project.status === 'featured',
        artifacts: project.artifacts
          .filter(
            (artifact) =>
              PUBLIC_ARTIFACT_KINDS.has(artifact.artifactType) &&
              artifact.filePathOrUrl.startsWith('https://'),
          )
          .map((artifact) => ({
            kind: artifact.artifactType as PublicArtifactView['kind'],
            url: artifact.filePathOrUrl,
            byteSize: artifact.byteSize,
          })),
      })),
  };
}

/**
 * A URL a public page may link to, or null.
 *
 * BELT AND BRACES. The database CHECK and the request contract both already
 * refuse anything that is not `https://`, so this should never have work to do.
 * It is here because this is the last function before the bytes reach a
 * stranger's browser, and a link is the one thing on a public page that a
 * reader is invited to click. A row that reached the table another way — a
 * migration, a fixture, a future import — stops here.
 */
export function publicUrlOrNull(url: string | null): string | null {
  if (url === null) return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith('https://')) return null;
  if (/\s/.test(trimmed)) return null;
  if (trimmed.length > 2000) return null;
  return trimmed;
}

/** Longest slug the database CHECK accepts. */
export const MAX_SLUG_LENGTH = 64;

/**
 * Turns a title into a URL-safe name.
 *
 * TRANSLITERATION IS DELIBERATELY NOT ATTEMPTED. This platform teaches in
 * Arabic and English, and a title in Arabic reduced to ASCII would either be
 * mangled into something meaningless or silently become empty. The function
 * strips to `[a-z0-9-]`, and when nothing survives it returns null so the
 * caller can ask the learner for a name rather than inventing one.
 *
 * Returning null is the honest outcome. The alternative — falling back to a
 * random string — would give a child a public URL they did not choose and could
 * not read.
 */
export function slugFromTitle(title: string): string | null {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks so "café" becomes "cafe" rather than "caf".
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    // A trailing hyphen can reappear after the slice.
    .replace(/-+$/g, '');

  // The database CHECK requires at least three characters: one, then one or
  // more, then one. Anything shorter is not a name anybody can share.
  return slug.length >= 3 ? slug : null;
}

/**
 * The candidate slugs to try, in order, when the first choice is taken.
 *
 * NUMBERED SUFFIXES RATHER THAN RANDOM ONES. `alex-chen-2` tells a reader that
 * somebody else already has `alex-chen`; a random suffix would hide that at the
 * cost of a URL nobody can remember. The information disclosed is that a
 * similarly-named portfolio exists, which is inherent to a public namespace.
 *
 * The list is finite. A caller that exhausts it should ask the learner to
 * choose a name rather than looping forever — an unbounded search would be a
 * denial-of-service on a unique index.
 */
export function slugCandidates(base: string, attempts = 10): string[] {
  const candidates = [base];
  for (let n = 2; n <= attempts; n += 1) {
    const suffix = `-${n}`;
    const trimmed = base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/g, '');
    candidates.push(`${trimmed}${suffix}`);
  }
  return candidates;
}

/** Whether a slug is one the database will accept. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])$/.test(slug);
}

/**
 * Whether a string could be a share token this platform minted.
 *
 * Checked BEFORE the key reaches a query, so a resolver never spends a database
 * round trip on a value that cannot be a token. It is a shape check and not an
 * authorization check: a well-formed token that belongs to nobody matches no
 * row, which is the same outcome as a malformed one.
 */
export function isValidShareToken(token: string): boolean {
  return /^[0-9a-f]{64}$/.test(token);
}
