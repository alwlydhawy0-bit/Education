import { Guarded, type NoteResource } from '@edu/authz';
import {
  resolveSortColumn,
  resolveSortDirection,
  type ListNotesQuery,
  type NoteSortField,
} from '@edu/contracts';
import type { Tx } from '../../platform/db.ts';

/**
 * Allow-listed sort fields mapped to literal SQL columns.
 *
 * This map is the reason a sort parameter cannot become SQL injection: the
 * request supplies a KEY, and only a value from this table ever reaches the
 * query. A parameter placeholder would not help here — an ORDER BY target is an
 * identifier, not a value, so it cannot be bound.
 *
 * The Record is exhaustive over `NoteSortField`, so adding a sortable field to
 * the contract without deciding its column is a compile error.
 */
const NOTE_SORT_COLUMNS: Readonly<Record<NoteSortField, string>> = {
  updatedAt: 'updated_at',
  createdAt: 'created_at',
  title: 'title',
};

export interface NoteRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly organizationId: string | null;
  readonly title: string;
  readonly body: string;
  readonly visibility: 'private' | 'shared_with_teacher' | 'shared_with_guardian';
  readonly state: 'active' | 'archived' | 'deleted';
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface NoteRow {
  id: string;
  owner_id: string;
  organization_id: string | null;
  title: string;
  body: string;
  visibility: NoteRecord['visibility'];
  state: NoteRecord['state'];
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: NoteRow): NoteRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    organizationId: row.organization_id,
    title: row.title,
    body: row.body,
    visibility: row.visibility,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The authorization-relevant projection handed to the policy engine. */
function toResource(row: NoteRow): NoteResource {
  return {
    kind: 'note',
    id: row.id,
    ownerId: row.owner_id,
    organizationId: row.organization_id,
    visibility: row.visibility,
    state: row.state,
  };
}

/**
 * Notebook persistence.
 *
 * `findById` returns `Guarded<NoteRecord>`, never a bare record. A caller
 * physically cannot read the title or body without first producing an
 * allow-decision for that exact note id — see `Guarded` in @edu/authz.
 *
 * Note what is NOT here: there is no `findByOwner(ownerId)` taking an arbitrary
 * owner. Listing is expressed as "the caller's own notes" so that no route can
 * pass someone else's id into a list query. When teacher-facing listing is
 * built, it will take the assignment edge as its input, not a raw owner id.
 */
export interface NotebookRepository {
  findById(tx: Tx, id: string): Promise<Guarded<NoteRecord> | null>;
  listOwn(tx: Tx, ownerId: string, query: ListNotesQuery): Promise<NoteRecord[]>;
  insert(
    tx: Tx,
    input: {
      ownerId: string;
      organizationId: string | null;
      title: string;
      body: string;
      visibility: NoteRecord['visibility'];
    },
  ): Promise<NoteRecord>;
  applyUpdate(
    tx: Tx,
    id: string,
    patch: { title?: string; body?: string; visibility?: NoteRecord['visibility'] },
  ): Promise<NoteRecord | null>;
  softDelete(tx: Tx, id: string): Promise<boolean>;
}

const SELECT_COLUMNS = `id, owner_id, organization_id, title, body, visibility, state, created_at, updated_at`;

export const notebookRepository: NotebookRepository = {
  async findById(tx, id) {
    const { rows } = await tx.query<NoteRow>(`SELECT ${SELECT_COLUMNS} FROM notes WHERE id = $1`, [
      id,
    ]);
    const row = rows[0];
    if (!row) return null;
    return Guarded.of(toRecord(row), toResource(row));
  },

  async listOwn(tx, ownerId, query) {
    // Both of these come from the exhaustive maps above, never from the request.
    const sortColumn = resolveSortColumn(NOTE_SORT_COLUMNS, query.sort);
    const sortDirection = resolveSortDirection(query.order);

    const { rows } = await tx.query<NoteRow>(
      `SELECT ${SELECT_COLUMNS} FROM notes
        WHERE owner_id = $1
          AND state <> 'deleted'
          AND ($2::text IS NULL OR visibility = $2)
          AND ($3::text IS NULL OR state = $3)
        ORDER BY ${sortColumn} ${sortDirection}, id ASC
        LIMIT $4 OFFSET $5`,
      [ownerId, query.visibility ?? null, query.state ?? null, query.limit, query.offset],
    );
    return rows.map(toRecord);
  },

  async insert(tx, input) {
    const { rows } = await tx.query<NoteRow>(
      `INSERT INTO notes (owner_id, organization_id, title, body, visibility)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SELECT_COLUMNS}`,
      [input.ownerId, input.organizationId, input.title, input.body, input.visibility],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toRecord(row);
  },

  async applyUpdate(tx, id, patch) {
    // COALESCE keeps this a single statement for a partial update, so there is
    // no read-modify-write window another request could interleave with.
    const { rows } = await tx.query<NoteRow>(
      `UPDATE notes
          SET title      = COALESCE($2, title),
              body       = COALESCE($3, body),
              visibility = COALESCE($4, visibility),
              updated_at = now()
        WHERE id = $1 AND state <> 'deleted'
      RETURNING ${SELECT_COLUMNS}`,
      [id, patch.title ?? null, patch.body ?? null, patch.visibility ?? null],
    );
    const row = rows[0];
    return row ? toRecord(row) : null;
  },

  async softDelete(tx, id) {
    // Soft delete: the row is retained for the retention window but is
    // invisible to every reader, including the owner (both the RLS policy and
    // `notePolicy` treat state='deleted' as non-existent).
    const result = await tx.query(
      `UPDATE notes SET state = 'deleted', updated_at = now()
        WHERE id = $1 AND state <> 'deleted'`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
