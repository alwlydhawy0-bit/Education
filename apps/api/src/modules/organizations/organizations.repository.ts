import { Guarded, type OrganizationResource } from '@edu/authz';
import type { Tx } from '../../platform/db.ts';

export interface OrganizationRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
}

interface OrganizationRow {
  id: string;
  name: string;
  created_at: Date;
}

const toRecord = (row: OrganizationRow): OrganizationRecord => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
});

const toResource = (row: OrganizationRow): OrganizationResource => ({
  kind: 'organization',
  id: row.id,
});

/**
 * Organization persistence.
 *
 * `findById` returns `Guarded<T>`: the payload cannot be read without an
 * allow-decision for that exact organization. `list` returns only what RLS
 * permits — the caller's own organization, or every organization for a platform
 * operator — so there is no parameter a caller could widen.
 */
export interface OrganizationsRepository {
  findById(tx: Tx, id: string): Promise<Guarded<OrganizationRecord> | null>;
  list(tx: Tx, limit: number, offset: number): Promise<OrganizationRecord[]>;
  insert(tx: Tx, name: string): Promise<OrganizationRecord>;
  updateName(tx: Tx, id: string, name: string): Promise<OrganizationRecord | null>;
}

export const organizationsRepository: OrganizationsRepository = {
  async findById(tx, id) {
    const { rows } = await tx.query<OrganizationRow>(
      'SELECT id, name, created_at FROM organizations WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return Guarded.of(toRecord(row), toResource(row));
  },

  async list(tx, limit, offset) {
    const { rows } = await tx.query<OrganizationRow>(
      `SELECT id, name, created_at FROM organizations
        ORDER BY created_at DESC, id ASC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.map(toRecord);
  },

  async insert(tx, name) {
    const { rows } = await tx.query<OrganizationRow>(
      'INSERT INTO organizations (name) VALUES ($1) RETURNING id, name, created_at',
      [name],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return toRecord(row);
  },

  async updateName(tx, id, name) {
    const { rows } = await tx.query<OrganizationRow>(
      'UPDATE organizations SET name = $2 WHERE id = $1 RETURNING id, name, created_at',
      [id, name],
    );
    const row = rows[0];
    return row ? toRecord(row) : null;
  },
};
