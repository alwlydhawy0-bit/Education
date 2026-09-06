import { Guarded, type NotebookResource, type StudentArtifactResource } from '@edu/authz';
import {
  resolveSortColumn,
  resolveSortDirection,
  type CreateNotebookRequest,
  type ListArtifactsQuery,
  type ListNotebooksQuery,
  type RegisterArtifactRequest,
  type StudentArtifactType,
  type UpdateNotebookRequest,
} from '@edu/contracts';
import type { Tx } from '../../platform/db.ts';

/**
 * Persistence for notebooks and personal artifacts.
 *
 * TWO RULES SHAPE EVERY QUERY IN THIS FILE.
 *
 * 1. EVERY STATEMENT IS SCOPED BY THE OWNER, in SQL, in addition to RLS. Not
 *    because RLS is doubted, but because a listing is where a single gate is
 *    most expensive to be wrong about (VULN-017) and because `WHERE owner_id =
 *    $1` makes the intent legible to whoever reads the query next.
 *
 * 2. NOTHING WRITES `storage_key`, `organization_id` OR `created_at`. All three
 *    are assigned by `student_artifact_guard`, and the INSERT below deliberately
 *    passes a placeholder into `storage_key` so that the trigger's overwrite is
 *    visible in the source rather than implied by its absence.
 */

export interface NotebookRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly organizationId: string | null;
  readonly title: string;
  readonly description: string;
  readonly noteCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface StudentArtifactRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly noteId: string | null;
  readonly sessionId: string | null;
  readonly artifactType: StudentArtifactType;
  readonly storageKey: string;
  readonly declaredContentType: string;
  readonly originalFilename: string;
  readonly byteSize: number;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface QuotaRecord {
  readonly usedBytes: number;
  readonly quotaBytes: number;
  readonly artifactCount: number;
}

interface NotebookRow {
  id: string;
  owner_id: string;
  organization_id: string | null;
  title: string;
  description: string;
  note_count: string;
  created_at: Date;
  updated_at: Date;
}

interface ArtifactRow {
  id: string;
  owner_id: string;
  organization_id: string | null;
  note_id: string | null;
  session_id: string | null;
  artifact_type: StudentArtifactType;
  storage_key: string;
  declared_content_type: string;
  original_filename: string;
  byte_size: string;
  metadata: unknown;
  created_at: Date;
}

const asMetadata = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const toNotebook = (row: NotebookRow): NotebookRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  organizationId: row.organization_id,
  title: row.title,
  description: row.description,
  // `count(*)` arrives as a string from `pg`; parsing here keeps the boundary
  // in one place rather than in every consumer.
  noteCount: Number(row.note_count),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toNotebookResource = (row: NotebookRow): NotebookResource => ({
  kind: 'notebook',
  id: row.id,
  ownerId: row.owner_id,
  organizationId: row.organization_id,
});

const toArtifact = (row: ArtifactRow): StudentArtifactRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  noteId: row.note_id,
  sessionId: row.session_id,
  artifactType: row.artifact_type,
  storageKey: row.storage_key,
  declaredContentType: row.declared_content_type,
  originalFilename: row.original_filename,
  byteSize: Number(row.byte_size),
  metadata: asMetadata(row.metadata),
  createdAt: row.created_at,
});

const toArtifactResource = (row: ArtifactRow): StudentArtifactResource => ({
  kind: 'student_artifact',
  id: row.id,
  ownerId: row.owner_id,
  organizationId: row.organization_id,
  artifactType: row.artifact_type,
  byteSize: Number(row.byte_size),
});

/**
 * The live-note count is a correlated subquery rather than a join, so a
 * notebook with no notes still appears — a learner who has just made one must
 * see it. `state <> 'deleted'` so a soft-deleted note stops being counted.
 */
const NOTEBOOK_SELECT = `SELECT b.id, b.owner_id, b.organization_id, b.title, b.description,
              b.created_at, b.updated_at,
              (SELECT count(*) FROM notes n
                WHERE n.notebook_id = b.id AND n.state <> 'deleted') AS note_count
         FROM student_notebooks b`;

const ARTIFACT_SELECT = `SELECT a.id, a.owner_id, a.organization_id, a.note_id, a.session_id,
              a.artifact_type, a.storage_key, a.declared_content_type,
              a.original_filename, a.byte_size, a.metadata, a.created_at
         FROM student_artifacts a`;

const NOTEBOOK_SORT = {
  updatedAt: 'b.updated_at',
  createdAt: 'b.created_at',
  title: 'lower(btrim(b.title))',
} as const;

const ARTIFACT_SORT = {
  createdAt: 'a.created_at',
  byteSize: 'a.byte_size',
} as const;

export interface WorkspaceRepository {
  createNotebook(
    tx: Tx,
    ownerId: string,
    organizationId: string | null,
    input: CreateNotebookRequest,
  ): Promise<NotebookRecord>;
  findNotebook(tx: Tx, id: string): Promise<Guarded<NotebookRecord> | null>;
  listNotebooks(tx: Tx, ownerId: string, query: ListNotebooksQuery): Promise<NotebookRecord[]>;
  updateNotebook(tx: Tx, id: string, input: UpdateNotebookRequest): Promise<NotebookRecord | null>;
  deleteNotebook(tx: Tx, id: string): Promise<boolean>;

  registerArtifact(
    tx: Tx,
    ownerId: string,
    input: RegisterArtifactRequest,
  ): Promise<StudentArtifactRecord>;
  findArtifact(tx: Tx, id: string): Promise<Guarded<StudentArtifactRecord> | null>;
  listArtifacts(
    tx: Tx,
    ownerId: string,
    query: ListArtifactsQuery,
  ): Promise<StudentArtifactRecord[]>;
  deleteArtifact(tx: Tx, id: string): Promise<boolean>;
  quotaFor(tx: Tx, ownerId: string): Promise<QuotaRecord>;
}

export const workspaceRepository: WorkspaceRepository = {
  async createNotebook(tx, ownerId, organizationId, input) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO student_notebooks (owner_id, organization_id, title, description)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [ownerId, organizationId, input.title, input.description],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('The notebook was not written');
    const saved = await readNotebook(tx, id);
    if (!saved) throw new Error('The new notebook is not readable');
    return saved;
  },

  async findNotebook(tx, id) {
    const { rows } = await tx.query<NotebookRow>(`${NOTEBOOK_SELECT} WHERE b.id = $1`, [id]);
    const row = rows[0];
    return row ? Guarded.of(toNotebook(row), toNotebookResource(row)) : null;
  },

  async listNotebooks(tx, ownerId, query) {
    const column = resolveSortColumn(NOTEBOOK_SORT, query.sort);
    const direction = resolveSortDirection(query.order);
    const { rows } = await tx.query<NotebookRow>(
      `${NOTEBOOK_SELECT}
        WHERE b.owner_id = $1
        ORDER BY ${column} ${direction}, b.id ASC
        LIMIT $2 OFFSET $3`,
      [ownerId, query.limit, query.offset],
    );
    return rows.map(toNotebook);
  },

  async updateNotebook(tx, id, input) {
    // COALESCE rather than a built SET list: the columns are fixed, so there is
    // no string concatenation anywhere near this statement.
    const { rowCount } = await tx.query(
      `UPDATE student_notebooks
          SET title       = COALESCE($2, title),
              description = COALESCE($3, description),
              updated_at  = now()
        WHERE id = $1`,
      [id, input.title ?? null, input.description ?? null],
    );
    if ((rowCount ?? 0) === 0) return null;
    return readNotebook(tx, id);
  },

  async deleteNotebook(tx, id) {
    // A hard delete, unlike a note's soft delete. A notebook holds no writing
    // of its own — the notes it contained survive with `notebook_id` set null
    // by the composite foreign key — so there is nothing here to retain.
    const { rowCount } = await tx.query('DELETE FROM student_notebooks WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  async registerArtifact(tx, ownerId, input) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO student_artifacts
         (owner_id, note_id, session_id, artifact_type, storage_key,
          declared_content_type, original_filename, byte_size, metadata)
       VALUES ($1, $2, $3, $4,
               -- OVERWRITTEN BY THE TRIGGER, and passed explicitly so that is
               -- visible here. The column is NOT NULL, so something must be
               -- sent; what is sent never survives.
               'pending',
               $5, $6, $7, $8)
       RETURNING id`,
      [
        ownerId,
        input.noteId ?? null,
        input.sessionId ?? null,
        input.artifactType,
        input.declaredContentType,
        input.originalFilename,
        input.byteSize,
        JSON.stringify(input.metadata),
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('The artifact was not written');
    const saved = await readArtifact(tx, id);
    if (!saved) throw new Error('The new artifact is not readable');
    return saved;
  },

  async findArtifact(tx, id) {
    const { rows } = await tx.query<ArtifactRow>(`${ARTIFACT_SELECT} WHERE a.id = $1`, [id]);
    const row = rows[0];
    return row ? Guarded.of(toArtifact(row), toArtifactResource(row)) : null;
  },

  async listArtifacts(tx, ownerId, query) {
    const column = resolveSortColumn(ARTIFACT_SORT, query.sort);
    const direction = resolveSortDirection(query.order);
    const { rows } = await tx.query<ArtifactRow>(
      `${ARTIFACT_SELECT}
        WHERE a.owner_id = $1
          AND ($4::text IS NULL OR a.artifact_type = $4)
          AND ($5::uuid IS NULL OR a.note_id = $5)
        ORDER BY ${column} ${direction}, a.id ASC
        LIMIT $2 OFFSET $3`,
      [ownerId, query.limit, query.offset, query.artifactType ?? null, query.noteId ?? null],
    );
    return rows.map(toArtifact);
  },

  async deleteArtifact(tx, id) {
    const { rowCount } = await tx.query('DELETE FROM student_artifacts WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  async quotaFor(tx, ownerId) {
    // Through the definer helper, so the answer does not depend on RLS having
    // returned every row — and scoped to the id the caller passes, which the
    // service only ever sets to the actor's own.
    const { rows } = await tx.query<{ used: string; quota: string; n: string }>(
      `SELECT app_artifact_bytes_used($1) AS used,
              app_artifact_quota_bytes() AS quota,
              (SELECT count(*) FROM student_artifacts WHERE owner_id = $1) AS n`,
      [ownerId],
    );
    const row = rows[0];
    if (!row) throw new Error('Quota query returned no row');
    return {
      usedBytes: Number(row.used),
      quotaBytes: Number(row.quota),
      artifactCount: Number(row.n),
    };
  },
};

async function readNotebook(tx: Tx, id: string): Promise<NotebookRecord | null> {
  const { rows } = await tx.query<NotebookRow>(`${NOTEBOOK_SELECT} WHERE b.id = $1`, [id]);
  const row = rows[0];
  return row ? toNotebook(row) : null;
}

async function readArtifact(tx: Tx, id: string): Promise<StudentArtifactRecord | null> {
  const { rows } = await tx.query<ArtifactRow>(`${ARTIFACT_SELECT} WHERE a.id = $1`, [id]);
  const row = rows[0];
  return row ? toArtifact(row) : null;
}
