import { Guarded, type StudentPortfolioResource, type StudentProjectResource } from '@edu/authz';
import {
  resolveSortColumn,
  resolveSortDirection,
  type AddPortfolioItemRequest,
  type AttachProjectArtifactRequest,
  type CreatePortfolioRequest,
  type CreateProjectRequest,
  type ListProjectsQuery,
  type ProjectArtifactType,
  type ProjectStatus,
  type ProjectVisibility,
  type UpdatePortfolioRequest,
  type UpdateProjectRequest,
} from '@edu/contracts';
import type { Tx } from '../../platform/db.ts';
import type { PortfolioSourceRow, ProjectSourceRow } from './public-view.ts';

/**
 * Persistence for projects, project artifacts, portfolios and portfolio items.
 *
 * THREE RULES SHAPE EVERY QUERY IN THIS FILE.
 *
 * 1. THE TWO RELATIONSHIP BOOLEANS ARE RESOLVED IN SQL AND CARRIED ON THE
 *    RESOURCE. `sharesClassWithActor` and `reviewableByActor` come from the
 *    same helpers the RLS policies call — `app_actor_shares_project_class` and
 *    `app_actor_reviews_project` — so the policy engine and the database are
 *    answering from one definition rather than two implementations of one idea.
 *    A second implementation in TypeScript would be a second thing to keep
 *    right, and the failure mode of getting it wrong is a policy that says yes
 *    where the database says no, or worse, the reverse.
 *
 * 2. NOTHING WRITES `organization_id`, `share_token`, `featured_by`,
 *    `featured_at` OR `owner_id` ON A CHILD ROW. All are assigned by triggers
 *    or by composite foreign keys in migration 0028. Where a value must be
 *    supplied for a NOT NULL column, the statement passes the caller's own id
 *    and the composite key is what makes that binding rather than a promise.
 *
 * 3. THE PUBLIC READ IS ITS OWN FUNCTION AND ITS OWN SHAPE. `publicPortfolio`
 *    returns `PortfolioSourceRow`/`ProjectSourceRow` — the inputs
 *    `toPublicPortfolio` accepts — and NOT the records the authenticated
 *    endpoints use. Sharing one record type between the two would mean the
 *    sanitizer's input carried ids it then had to be trusted to drop; keeping
 *    them separate means the ids never enter the public pipeline at all.
 */

export interface ProjectArtifactRecord {
  readonly id: string;
  readonly artifactType: ProjectArtifactType;
  readonly filePathOrUrl: string;
  readonly byteSize: number;
  readonly createdAt: Date;
}

export interface ProjectRecord {
  readonly id: string;
  readonly studentId: string;
  readonly organizationId: string | null;
  readonly classId: string | null;
  readonly courseId: string | null;
  readonly title: string;
  readonly descriptionMarkdown: string;
  readonly repositoryUrl: string | null;
  readonly liveDemoUrl: string | null;
  readonly visibility: ProjectVisibility;
  readonly status: ProjectStatus;
  readonly featuredAt: Date | null;
  readonly artifacts: readonly ProjectArtifactRecord[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PortfolioItemRecord {
  readonly projectId: string;
  readonly displayOrder: number;
  readonly title: string;
  readonly visibility: ProjectVisibility;
  readonly status: ProjectStatus;
}

export interface PortfolioRecord {
  readonly id: string;
  readonly studentId: string;
  readonly title: string;
  readonly bio: string;
  readonly publicSlug: string | null;
  readonly shareToken: string;
  readonly isPublished: boolean;
  readonly items: readonly PortfolioItemRecord[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface ProjectRow {
  id: string;
  student_id: string;
  organization_id: string | null;
  class_id: string | null;
  course_id: string | null;
  title: string;
  description_markdown: string;
  repository_url: string | null;
  live_demo_url: string | null;
  visibility: ProjectVisibility;
  status: ProjectStatus;
  featured_at: Date | null;
  created_at: Date;
  updated_at: Date;
  shares_class: boolean;
  reviewable: boolean;
  artifacts: unknown;
}

interface PortfolioRow {
  id: string;
  student_id: string;
  organization_id: string | null;
  title: string;
  bio: string;
  public_slug: string | null;
  share_token: string;
  is_published: boolean;
  created_at: Date;
  updated_at: Date;
  public_item_count: string;
  items: unknown;
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const toArtifact = (value: unknown): ProjectArtifactRecord => {
  const row = asRecord(value);
  return {
    id: String(row.id),
    artifactType: row.artifact_type as ProjectArtifactType,
    filePathOrUrl: String(row.file_path_or_url),
    byteSize: Number(row.byte_size),
    createdAt: new Date(String(row.created_at)),
  };
};

const toProject = (row: ProjectRow): ProjectRecord => ({
  id: row.id,
  studentId: row.student_id,
  organizationId: row.organization_id,
  classId: row.class_id,
  courseId: row.course_id,
  title: row.title,
  descriptionMarkdown: row.description_markdown,
  repositoryUrl: row.repository_url,
  liveDemoUrl: row.live_demo_url,
  visibility: row.visibility,
  status: row.status,
  featuredAt: row.featured_at,
  artifacts: asArray(row.artifacts).map(toArtifact),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * The authorization-relevant attributes, and only those.
 *
 * No title, no description, no URL. `Guarded.resource` is readable WITHOUT a
 * decision — that is what lets the policy engine be handed its input before the
 * payload is released — so anything placed here is readable by code that has
 * not yet been authorized to read the row.
 */
const toProjectResource = (row: ProjectRow): StudentProjectResource => ({
  kind: 'student_project',
  id: row.id,
  ownerId: row.student_id,
  organizationId: row.organization_id,
  classId: row.class_id,
  visibility: row.visibility,
  status: row.status,
  sharesClassWithActor: row.shares_class,
  reviewableByActor: row.reviewable,
});

const toItem = (value: unknown): PortfolioItemRecord => {
  const row = asRecord(value);
  return {
    projectId: String(row.project_id),
    displayOrder: Number(row.display_order),
    title: String(row.title ?? ''),
    visibility: row.visibility as ProjectVisibility,
    status: row.status as ProjectStatus,
  };
};

const toPortfolio = (row: PortfolioRow): PortfolioRecord => ({
  id: row.id,
  studentId: row.student_id,
  title: row.title,
  bio: row.bio,
  publicSlug: row.public_slug,
  shareToken: row.share_token,
  isPublished: row.is_published,
  items: asArray(row.items).map(toItem),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toPortfolioResource = (row: PortfolioRow): StudentPortfolioResource => ({
  kind: 'student_portfolio',
  id: row.id,
  ownerId: row.student_id,
  organizationId: row.organization_id,
  isPublished: row.is_published,
  publicItemCount: Number(row.public_item_count),
});

/**
 * Artifacts arrive as an aggregated JSON array rather than as extra rows.
 *
 * A LEFT JOIN would multiply the project row per artifact and force the caller
 * to re-group; a correlated aggregate keeps one row per project, so a project
 * with no artifacts still appears. `ORDER BY` inside the aggregate makes the
 * order deterministic instead of whatever the plan happened to produce.
 */
const ARTIFACTS_JSON = `(SELECT coalesce(json_agg(json_build_object(
            'id', a.id,
            'artifact_type', a.artifact_type,
            'file_path_or_url', a.file_path_or_url,
            'byte_size', a.byte_size,
            'created_at', a.created_at
          ) ORDER BY a.created_at, a.id), '[]'::json)
     FROM project_artifacts a WHERE a.project_id = p.id)`;

/**
 * The two relationship booleans, resolved by the SAME helpers the RLS policies
 * call. See rule 1 in the header.
 */
const PROJECT_SELECT = `SELECT p.id, p.student_id, p.organization_id, p.class_id, p.course_id,
              p.title, p.description_markdown, p.repository_url, p.live_demo_url,
              p.visibility, p.status, p.featured_at, p.created_at, p.updated_at,
              app_actor_shares_project_class(p.class_id) AS shares_class,
              app_actor_reviews_project(p.class_id, p.organization_id) AS reviewable,
              ${ARTIFACTS_JSON} AS artifacts
         FROM student_projects p`;

/**
 * A portfolio's items, joined to their projects for the titles the owner sees.
 *
 * INNER JOIN, deliberately, and it is doing authorization work by accident of
 * structure: an item whose project the caller cannot read through
 * `student_projects_select` drops out. For the owner that never removes
 * anything, because they can read all of their own. It matters if this query is
 * ever reused for a reader who is not the owner.
 */
const PORTFOLIO_ITEMS_JSON = `(SELECT coalesce(json_agg(json_build_object(
            'project_id', i.project_id,
            'display_order', i.display_order,
            'title', pr.title,
            'visibility', pr.visibility,
            'status', pr.status
          ) ORDER BY i.display_order, i.created_at), '[]'::json)
     FROM portfolio_items i
     JOIN student_projects pr ON pr.id = i.project_id
    WHERE i.portfolio_id = f.id)`;

const PUBLIC_ITEM_COUNT = `(SELECT count(*)
     FROM portfolio_items i
     JOIN student_projects pr ON pr.id = i.project_id
    WHERE i.portfolio_id = f.id
      AND pr.visibility = 'public'
      AND pr.status <> 'draft')`;

const PORTFOLIO_SELECT = `SELECT f.id, f.student_id, f.organization_id, f.title, f.bio,
              f.public_slug, f.share_token, f.is_published, f.created_at, f.updated_at,
              ${PUBLIC_ITEM_COUNT} AS public_item_count,
              ${PORTFOLIO_ITEMS_JSON} AS items
         FROM student_portfolios f`;

const PROJECT_SORT = {
  updatedAt: 'p.updated_at',
  createdAt: 'p.created_at',
  title: 'lower(btrim(p.title))',
} as const;

export interface PortfolioRepository {
  createProject(tx: Tx, ownerId: string, input: CreateProjectRequest): Promise<ProjectRecord>;
  findProject(tx: Tx, id: string): Promise<Guarded<ProjectRecord> | null>;
  listOwnProjects(tx: Tx, ownerId: string, query: ListProjectsQuery): Promise<ProjectRecord[]>;
  listClassProjects(
    tx: Tx,
    classId: string,
    query: ListProjectsQuery,
  ): Promise<Guarded<ProjectRecord>[]>;
  updateProject(tx: Tx, id: string, input: UpdateProjectRequest): Promise<ProjectRecord | null>;
  featureProject(tx: Tx, id: string, reviewerId: string): Promise<ProjectRecord | null>;
  deleteProject(tx: Tx, id: string): Promise<boolean>;
  attachArtifact(
    tx: Tx,
    projectId: string,
    ownerId: string,
    input: AttachProjectArtifactRequest,
  ): Promise<ProjectArtifactRecord>;

  createPortfolio(tx: Tx, ownerId: string, input: CreatePortfolioRequest): Promise<PortfolioRecord>;
  findOwnPortfolio(tx: Tx, ownerId: string): Promise<Guarded<PortfolioRecord> | null>;
  updatePortfolio(
    tx: Tx,
    id: string,
    input: UpdatePortfolioRequest,
  ): Promise<PortfolioRecord | null>;
  setPublished(tx: Tx, id: string, published: boolean): Promise<PortfolioRecord | null>;
  addItem(
    tx: Tx,
    portfolioId: string,
    ownerId: string,
    input: AddPortfolioItemRequest,
  ): Promise<PortfolioRecord | null>;
  removeItem(tx: Tx, portfolioId: string, projectId: string): Promise<boolean>;

  beginPublicResolution(tx: Tx, key: string): Promise<void>;
  publicPortfolio(
    tx: Tx,
  ): Promise<{ portfolio: PortfolioSourceRow; projects: ProjectSourceRow[] } | null>;
}

export const portfolioRepository: PortfolioRepository = {
  async createProject(tx, ownerId, input) {
    // `organization_id` is a placeholder the trigger overwrites, passed
    // explicitly so the overwrite is visible in the source rather than implied
    // by an absent column. `status` is not in the list at all: a project is
    // born a draft and there is no way to ask otherwise.
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO student_projects
         (student_id, organization_id, class_id, course_id, title,
          description_markdown, repository_url, live_demo_url, visibility)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        ownerId,
        input.classId,
        input.courseId,
        input.title,
        input.descriptionMarkdown,
        input.repositoryUrl,
        input.liveDemoUrl,
        input.visibility,
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('The project was not written');
    const saved = await readProject(tx, id);
    if (!saved) throw new Error('The new project is not readable');
    return saved;
  },

  async findProject(tx, id) {
    const { rows } = await tx.query<ProjectRow>(`${PROJECT_SELECT} WHERE p.id = $1`, [id]);
    const row = rows[0];
    return row ? Guarded.of(toProject(row), toProjectResource(row)) : null;
  },

  async listOwnProjects(tx, ownerId, query) {
    const column = resolveSortColumn(PROJECT_SORT, query.sort);
    const direction = resolveSortDirection(query.order);
    const { rows } = await tx.query<ProjectRow>(
      `${PROJECT_SELECT}
        WHERE p.student_id = $1
          AND ($4::text IS NULL OR p.visibility = $4)
          AND ($5::text IS NULL OR p.status = $5)
        ORDER BY ${column} ${direction}, p.id ASC
        LIMIT $2 OFFSET $3`,
      [ownerId, query.limit, query.offset, query.visibility ?? null, query.status ?? null],
    );
    return rows.map(toProject);
  },

  /**
   * One class's projects.
   *
   * `status <> 'draft'` IS IN THE SQL, not only in RLS and not only in the
   * policy. A draft is work nobody has offered, and this is the query most
   * likely to be copied into a future dashboard; leaving the condition to a
   * layer the copy might not carry is how a draft ends up on a wall display.
   *
   * Everything else — whether the caller is in this class, whether they teach
   * it, whether a `private` project is theirs — is left to RLS and re-decided
   * by the policy engine per row. Restating it here would be a third rule to
   * keep in step with two others.
   */
  async listClassProjects(tx, classId, query) {
    const column = resolveSortColumn(PROJECT_SORT, query.sort);
    const direction = resolveSortDirection(query.order);
    const { rows } = await tx.query<ProjectRow>(
      `${PROJECT_SELECT}
        WHERE p.class_id = $1
          AND p.status <> 'draft'
        ORDER BY ${column} ${direction}, p.id ASC
        LIMIT $2 OFFSET $3`,
      [classId, query.limit, query.offset],
    );
    // GUARDED, unlike `listOwnProjects`. That list is scoped to the caller in
    // SQL, so every row is theirs by construction; this one contains other
    // learners' work, which makes it exactly the shape VULN-017 was — a listing
    // where one missing condition leaks many rows rather than one. So each row
    // carries its resource and the service re-decides it.
    return rows.map((row) => Guarded.of(toProject(row), toProjectResource(row)));
  },

  async updateProject(tx, id, input) {
    // COALESCE over a fixed column list: nothing about this statement is built
    // from a string. `featured_by` and `featured_at` are absent, so an owner's
    // update cannot touch them even if the trigger were removed.
    //
    // `repository_url` and `live_demo_url` need the three-state dance — absent,
    // set, or explicitly cleared — so each takes a value plus a "was it
    // provided" flag rather than collapsing null-to-clear into null-to-keep.
    const { rowCount } = await tx.query(
      `UPDATE student_projects
          SET title                = COALESCE($2, title),
              description_markdown = COALESCE($3, description_markdown),
              repository_url       = CASE WHEN $4 THEN $5 ELSE repository_url END,
              live_demo_url        = CASE WHEN $6 THEN $7 ELSE live_demo_url END,
              visibility           = COALESCE($8, visibility),
              status               = COALESCE($9, status),
              updated_at           = now()
        WHERE id = $1`,
      [
        id,
        input.title ?? null,
        input.descriptionMarkdown ?? null,
        'repositoryUrl' in input,
        input.repositoryUrl ?? null,
        'liveDemoUrl' in input,
        input.liveDemoUrl ?? null,
        input.visibility ?? null,
        input.status ?? null,
      ],
    );
    if ((rowCount ?? 0) === 0) return null;
    return readProject(tx, id);
  },

  /**
   * Featuring: three columns and nothing else.
   *
   * The SET list is the fourth place this rule is written — after the RLS
   * policy, the `student_project_review_guard` trigger and the authz policy —
   * and it is the one a reader of this file can see. A statement that also set
   * `title` would be refused by the trigger, which is the point of having it.
   */
  async featureProject(tx, id, reviewerId) {
    const { rowCount } = await tx.query(
      `UPDATE student_projects
          SET status      = 'featured',
              featured_by = $2,
              featured_at = now()
        WHERE id = $1
          AND status <> 'draft'`,
      [id, reviewerId],
    );
    if ((rowCount ?? 0) === 0) return null;
    return readProject(tx, id);
  },

  async deleteProject(tx, id) {
    // A hard delete. The artifacts and any portfolio items cascade through the
    // composite foreign keys, so removing a project removes it from the public
    // page in the same statement — which is what section 3's revocation
    // requirement means for a deleted project.
    const { rowCount } = await tx.query(`DELETE FROM student_projects WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  },

  async attachArtifact(tx, projectId, ownerId, input) {
    const { rows } = await tx.query<{
      id: string;
      artifact_type: ProjectArtifactType;
      file_path_or_url: string;
      byte_size: string;
      created_at: Date;
    }>(
      `INSERT INTO project_artifacts
         (project_id, owner_id, artifact_type, file_path_or_url, byte_size, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id, artifact_type, file_path_or_url, byte_size, created_at`,
      [
        projectId,
        // The caller's own id, and the composite foreign key to
        // `student_projects (id, student_id)` is what makes that binding: a
        // mismatched pair has no parent row, so attaching to somebody else's
        // project fails on a key rather than on a check somebody wrote.
        ownerId,
        input.artifactType,
        input.filePathOrUrl,
        input.byteSize,
        JSON.stringify(input.metadata),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('The artifact was not written');
    return {
      id: row.id,
      artifactType: row.artifact_type,
      filePathOrUrl: row.file_path_or_url,
      byteSize: Number(row.byte_size),
      createdAt: row.created_at,
    };
  },

  async createPortfolio(tx, ownerId, input) {
    // No `share_token` and no `public_slug`. The token is minted by the trigger
    // — a caller who picks their own picks a guessable one — and a slug is
    // proposed later, through `updatePortfolio`, where a collision can be
    // reported as a 409 instead of failing a creation.
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO student_portfolios (student_id, organization_id, title, bio)
       VALUES ($1, NULL, $2, $3) RETURNING id`,
      [ownerId, input.title, input.bio],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('The portfolio was not written');
    const saved = await readPortfolio(tx, id);
    if (!saved) throw new Error('The new portfolio is not readable');
    return saved;
  },

  /**
   * The caller's own portfolio, by owner rather than by id.
   *
   * There is one per learner and every route addresses it as `/me/portfolio`,
   * so there is no id for a caller to substitute — the IDOR surface is absent
   * rather than defended. It still returns `Guarded`, because the service must
   * still run the policy before releasing the row: `share_token` is in there.
   */
  async findOwnPortfolio(tx, ownerId) {
    const { rows } = await tx.query<PortfolioRow>(`${PORTFOLIO_SELECT} WHERE f.student_id = $1`, [
      ownerId,
    ]);
    const row = rows[0];
    return row ? Guarded.of(toPortfolio(row), toPortfolioResource(row)) : null;
  },

  async updatePortfolio(tx, id, input) {
    const { rowCount } = await tx.query(
      `UPDATE student_portfolios
          SET title       = COALESCE($2, title),
              bio         = COALESCE($3, bio),
              public_slug = CASE WHEN $4 THEN $5 ELSE public_slug END,
              updated_at  = now()
        WHERE id = $1`,
      [id, input.title ?? null, input.bio ?? null, 'publicSlug' in input, input.publicSlug ?? null],
    );
    if ((rowCount ?? 0) === 0) return null;
    return readPortfolio(tx, id);
  },

  /**
   * Publishing and unpublishing.
   *
   * UNPUBLISHING ROTATES THE SHARE TOKEN, and the rotation happens in
   * `student_portfolio_guard` rather than here — see migration 0028. That is
   * section 3's revocation requirement made structural: every link ever handed
   * out stops resolving the moment the flag goes false, including links this
   * service never saw and links pasted into somebody else's chat history.
   *
   * Doing it in the trigger rather than in this statement matters, because a
   * future writer who unpublishes by some other route still rotates.
   */
  async setPublished(tx, id, published) {
    const { rowCount } = await tx.query(
      `UPDATE student_portfolios SET is_published = $2, updated_at = now() WHERE id = $1`,
      [id, published],
    );
    if ((rowCount ?? 0) === 0) return null;
    return readPortfolio(tx, id);
  },

  async addItem(tx, portfolioId, ownerId, input) {
    // `display_order` defaults to one past the current end, computed inside the
    // statement so two concurrent adds cannot both read the same maximum. The
    // unique key on (portfolio_id, project_id) is what refuses a duplicate.
    const { rowCount } = await tx.query(
      `INSERT INTO portfolio_items (portfolio_id, project_id, owner_id, display_order)
       SELECT $1, $2, $3,
              COALESCE($4::integer,
                       LEAST(500, (SELECT COALESCE(max(i.display_order), 0) + 1
                                     FROM portfolio_items i
                                    WHERE i.portfolio_id = $1)))`,
      [portfolioId, input.projectId, ownerId, input.displayOrder ?? null],
    );
    if ((rowCount ?? 0) === 0) return null;
    return readPortfolio(tx, portfolioId);
  },

  async removeItem(tx, portfolioId, projectId) {
    const { rowCount } = await tx.query(
      `DELETE FROM portfolio_items WHERE portfolio_id = $1 AND project_id = $2`,
      [portfolioId, projectId],
    );
    return (rowCount ?? 0) > 0;
  },

  /**
   * Opens the named door for one public key, for this transaction only.
   *
   * `app_begin_public_portfolio` sets a transaction-local GUC. It GRANTS
   * NOTHING: every policy still checks that the key matches a published row, so
   * a caller who invents a key gets exactly what a caller who presents none
   * gets. What it does is make the public path a thing you can see in the
   * source and grep for, rather than an implicit consequence of a query shape.
   */
  async beginPublicResolution(tx, key) {
    await tx.query(`SELECT app_begin_public_portfolio($1)`, [key]);
  },

  /**
   * The public read: two queries, no ids in the result, and no parameters.
   *
   * NO PARAMETERS IS THE POINT. The key is never an argument — it lives in the
   * transaction's GUC, read by `app_portfolio_key()`. So this function cannot
   * be made to return a different portfolio by passing it a different value,
   * because there is nothing to pass.
   *
   * THE WHERE CLAUSES ARE THE SECOND GATE, AND THEY WERE ADDED AFTER THE FACT.
   * The first version had none: it selected from the tables and let RLS do all
   * the filtering, on the reasoning that two places deciding one thing is how
   * they come to disagree. Running the suite against `edu_app_norls` showed
   * what that reasoning missed — with RLS removed, the resolver returned
   * whatever portfolio happened to be first, to anybody, for any key. The
   * platform's ONLY unauthenticated route was standing on a single gate, which
   * is precisely the arrangement the rest of this architecture exists to avoid.
   *
   * These conditions are not a re-derivation of the rule from different facts,
   * which is the drift the original reasoning feared. They are the SAME
   * predicate — published, and the presented key matches this row — asked from
   * the same GUC, in the layer that would still be running if the database's
   * copy were dropped. Where they could disagree with RLS they answer more
   * narrowly, and more narrowly on a public route is the safe direction.
   *
   * The SELECT lists are the sanitizer's input and nothing more. No `id`, no
   * `student_id`, no `share_token`, no `organization_id`, no timestamps — not
   * because `toPublicPortfolio` would drop them, but so that they are never in
   * the same object as the thing being serialized.
   */
  async publicPortfolio(tx) {
    // NO JOIN TO `users`. The first version had one, to fetch the owner's
    // display name, and it took down every public page: `users` has RLS, this
    // path has no actor, and `users_select` admits nothing to a caller who is
    // not somebody's self, teacher or guardian — so the inner join returned
    // zero rows for every portfolio on the platform. The same shape as
    // VULN-054, where an inner join to `lessons` silently vetoed a policy.
    //
    // It is not repaired with a definer function, because the field should not
    // have existed: see `PublicPortfolioView`. The title and the bio are what
    // the learner wrote for this page.
    const { rows: portfolioRows } = await tx.query<{
      title: string;
      bio: string;
    }>(
      `SELECT f.title, f.bio
         FROM student_portfolios f
        WHERE f.is_published
          AND app_portfolio_key() IS NOT NULL
          AND (f.share_token = app_portfolio_key() OR f.public_slug = app_portfolio_key())
        LIMIT 2`,
    );

    // TWO ROWS IS IMPOSSIBLE AND THEREFORE WORTH REFUSING. `share_token` and
    // `public_slug` are both UNIQUE, so a key can match at most one portfolio;
    // if it ever matched two, something has gone wrong below this line and the
    // safe answer is to serve nothing rather than to pick one. `LIMIT 2` exists
    // to make that detectable — `LIMIT 1` would silently serve the first.
    const portfolioRow = portfolioRows.length === 1 ? portfolioRows[0] : undefined;
    if (!portfolioRow) return null;

    const { rows: projectRows } = await tx.query<{
      display_order: number;
      title: string;
      description_markdown: string;
      repository_url: string | null;
      live_demo_url: string | null;
      status: string;
      artifacts: unknown;
    }>(
      `SELECT i.display_order, p.title, p.description_markdown,
              p.repository_url, p.live_demo_url, p.status,
              ${ARTIFACTS_JSON} AS artifacts
         FROM portfolio_items i
         JOIN student_projects p ON p.id = i.project_id
         JOIN student_portfolios f ON f.id = i.portfolio_id
        WHERE f.is_published
          AND app_portfolio_key() IS NOT NULL
          AND (f.share_token = app_portfolio_key() OR f.public_slug = app_portfolio_key())
          AND p.visibility = 'public'
          AND p.status <> 'draft'
        ORDER BY i.display_order, i.created_at
        LIMIT 500`,
    );

    return {
      portfolio: { title: portfolioRow.title, bio: portfolioRow.bio },
      projects: projectRows.map((row) => ({
        displayOrder: Number(row.display_order),
        title: row.title,
        descriptionMarkdown: row.description_markdown,
        repositoryUrl: row.repository_url,
        liveDemoUrl: row.live_demo_url,
        status: row.status,
        artifacts: asArray(row.artifacts).map((value) => {
          const artifact = asRecord(value);
          return {
            artifactType: String(artifact.artifact_type),
            filePathOrUrl: String(artifact.file_path_or_url),
            byteSize: Number(artifact.byte_size),
          };
        }),
      })),
    };
  },
};

async function readProject(tx: Tx, id: string): Promise<ProjectRecord | null> {
  const { rows } = await tx.query<ProjectRow>(`${PROJECT_SELECT} WHERE p.id = $1`, [id]);
  const row = rows[0];
  return row ? toProject(row) : null;
}

async function readPortfolio(tx: Tx, id: string): Promise<PortfolioRecord | null> {
  const { rows } = await tx.query<PortfolioRow>(`${PORTFOLIO_SELECT} WHERE f.id = $1`, [id]);
  const row = rows[0];
  return row ? toPortfolio(row) : null;
}
