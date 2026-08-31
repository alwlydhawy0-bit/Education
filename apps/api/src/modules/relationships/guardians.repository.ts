import { Guarded, type GuardianRelationshipResource } from '@edu/authz';
import type { Tx } from '../../platform/db.ts';

export interface GuardianLinkRecord {
  readonly id: string;
  readonly guardianId: string;
  readonly childId: string;
  /**
   * The child's organization. Carried for the authorization decision, NOT part
   * of the API response — `relationships.routes.ts` maps every field it returns
   * through `guardianLinkResponseSchema`, which does not include this one.
   */
  readonly childOrganizationId: string | null;
  readonly relationshipType: 'parent' | 'guardian' | 'caregiver';
  readonly status: 'pending' | 'verified' | 'revoked';
  readonly createdAt: Date;
  readonly verifiedAt: Date | null;
}

interface LinkRow {
  id: string;
  guardian_id: string;
  child_id: string;
  relationship_type: GuardianLinkRecord['relationshipType'];
  status: GuardianLinkRecord['status'];
  created_at: Date;
  verified_at: Date | null;
  child_organization_id: string | null;
}

const toRecord = (row: LinkRow): GuardianLinkRecord => ({
  id: row.id,
  guardianId: row.guardian_id,
  childId: row.child_id,
  childOrganizationId: row.child_organization_id,
  relationshipType: row.relationship_type,
  status: row.status,
  createdAt: row.created_at,
  verifiedAt: row.verified_at,
});

const toResource = (row: LinkRow): GuardianRelationshipResource => ({
  kind: 'guardian_relationship',
  id: row.id,
  guardianId: row.guardian_id,
  childId: row.child_id,
  childOrganizationId: row.child_organization_id,
  state: row.status,
});

/** Raised when a claim names a child that does not exist. */
export class UnknownChildError extends Error {
  constructor() {
    super('Unknown child');
    this.name = 'UnknownChildError';
  }
}

/** Raised when a claim for this pair already exists. */
export class DuplicateLinkError extends Error {
  constructor() {
    super('Link already exists');
    this.name = 'DuplicateLinkError';
  }
}

export interface GuardiansRepository {
  findById(tx: Tx, id: string): Promise<Guarded<GuardianLinkRecord> | null>;
  /**
   * The organization of an arbitrary user, for authorizing a link that does not
   * exist yet. Answers `null` for an unknown user, which denies rather than
   * allows.
   */
  organizationOfUser(tx: Tx, userId: string): Promise<string | null>;
  /** Links where the given user is either participant. RLS scopes it further. */
  listForUser(tx: Tx, userId: string, limit: number, offset: number): Promise<GuardianLinkRecord[]>;
  create(
    tx: Tx,
    guardianId: string,
    childId: string,
    relationshipType: GuardianLinkRecord['relationshipType'],
  ): Promise<GuardianLinkRecord>;
  verify(tx: Tx, id: string, verifiedBy: string): Promise<GuardianLinkRecord | null>;
  revoke(tx: Tx, id: string): Promise<boolean>;
}

/**
 * `app_user_organization` rather than a join to `users`.
 *
 * The child's school is needed to decide the request, but a JOIN would be
 * subject to `users_select` — and a guardian with a PENDING claim cannot yet
 * read the child, so the join would drop the guardian's own link from their own
 * listing. The SECURITY DEFINER helper (migration 0014) answers the one
 * question without widening what the caller can read, and RLS still decides
 * which link rows are visible at all.
 */
const COLUMNS = `id, guardian_id, child_id, relationship_type, status, created_at, verified_at,
       app_user_organization(child_id) AS child_organization_id`;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23503'
  );
}

export const guardiansRepository: GuardiansRepository = {
  async organizationOfUser(tx, userId) {
    const { rows } = await tx.query<{ organization_id: string | null }>(
      'SELECT app_user_organization($1) AS organization_id',
      [userId],
    );
    return rows[0]?.organization_id ?? null;
  },

  async findById(tx, id) {
    const { rows } = await tx.query<LinkRow>(
      `SELECT ${COLUMNS} FROM guardian_relationships WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return Guarded.of(toRecord(row), toResource(row));
  },

  async listForUser(tx, userId, limit, offset) {
    const { rows } = await tx.query<LinkRow>(
      `SELECT ${COLUMNS} FROM guardian_relationships
        WHERE guardian_id = $1 OR child_id = $1
        ORDER BY created_at DESC, id ASC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return rows.map(toRecord);
  },

  async create(tx, guardianId, childId, relationshipType) {
    try {
      const { rows } = await tx.query<LinkRow>(
        `INSERT INTO guardian_relationships (guardian_id, child_id, relationship_type, status)
         VALUES ($1, $2, $3, 'pending') RETURNING ${COLUMNS}`,
        [guardianId, childId, relationshipType],
      );
      const row = rows[0];
      if (!row) throw new Error('Insert returned no row');
      return toRecord(row);
    } catch (error) {
      // Both are translated so the caller can answer identically either way —
      // otherwise the endpoint reports whether a given user id exists.
      if (isForeignKeyViolation(error)) throw new UnknownChildError();
      if (isUniqueViolation(error)) throw new DuplicateLinkError();
      throw error;
    }
  },

  async verify(tx, id, verifiedBy) {
    // Only a PENDING link may be verified, enforced in the statement so a
    // concurrent second verification cannot re-stamp an existing one.
    const { rows } = await tx.query<LinkRow>(
      `UPDATE guardian_relationships
          SET status = 'verified', verified_at = now(), verified_by = $2
        WHERE id = $1 AND status = 'pending'
      RETURNING ${COLUMNS}`,
      [id, verifiedBy],
    );
    const row = rows[0];
    return row ? toRecord(row) : null;
  },

  async revoke(tx, id) {
    // Revocation clears the verification stamp, because the CHECK constraint
    // ties `verified_at` to the `verified` status.
    const result = await tx.query(
      `UPDATE guardian_relationships
          SET status = 'revoked', verified_at = NULL, verified_by = NULL
        WHERE id = $1 AND status <> 'revoked'`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
