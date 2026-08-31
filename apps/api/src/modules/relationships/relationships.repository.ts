import type { RelationshipSnapshot } from '@edu/authz';
import type { Tx } from '../../platform/db.ts';

/**
 * Loads the relationship edges that authorization decisions depend on.
 *
 * This module OWNS the `guardian_links` and `teacher_assignments` tables. No
 * other module queries them directly — `notebook` and `identity` consume this
 * snapshot instead. That is the dependency rule from
 * docs/architecture/dependency-rules.md in practice: a domain reaches another
 * domain's data through a contract, never through its tables.
 *
 * Only VERIFIED guardianships and ACTIVE assignments are returned. A pending
 * link or an ended assignment is not an access grant, and filtering here means
 * no caller can forget that.
 */
export interface RelationshipReader {
  loadSnapshot(tx: Tx, actorId: string): Promise<RelationshipSnapshot>;
}

export const relationshipReader: RelationshipReader = {
  async loadSnapshot(tx, actorId) {
    const [guardianRows, teacherRows] = await Promise.all([
      tx.query<{ student_id: string }>(
        `SELECT student_id FROM guardian_links
          WHERE guardian_id = $1 AND status = 'verified'`,
        [actorId],
      ),
      tx.query<{ student_id: string }>(
        `SELECT student_id FROM teacher_assignments
          WHERE teacher_id = $1 AND status = 'active'`,
        [actorId],
      ),
    ]);

    return {
      guardianOf: guardianRows.rows.map((r) => r.student_id),
      teacherOf: teacherRows.rows.map((r) => r.student_id),
    };
  },
};
