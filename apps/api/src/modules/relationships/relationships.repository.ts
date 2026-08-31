import type { RelationshipSnapshot } from '@edu/authz';
import type { Tx } from '../../platform/db.ts';

/**
 * Loads the relationship edges that authorization decisions depend on.
 *
 * This module OWNS `guardian_relationships`, `classes`, `class_memberships`,
 * `teacher_assignments` and `class_course_assignments`. No other module queries them — `notebook`, `identity`
 * and the admin surfaces all consume this snapshot instead. That is the
 * dependency rule from docs/architecture/dependency-rules.md in practice.
 *
 * THE DERIVATION LIVES HERE, AND ONLY HERE.
 *
 * Teacher-to-student is not a stored edge. It holds when the actor has an
 * ACTIVE assignment to an ACTIVE class in which the student has an ACTIVE
 * membership. Ending any one of those three revokes access immediately, and
 * because the join is written once, no caller can accidentally check two of the
 * three conditions and forget the other.
 *
 * Only VERIFIED guardianships are returned. A pending or revoked claim is not an
 * access grant, and filtering here means no caller can forget that either.
 */
export interface RelationshipReader {
  loadSnapshot(tx: Tx, actorId: string): Promise<RelationshipSnapshot>;
}

export const relationshipReader: RelationshipReader = {
  async loadSnapshot(tx, actorId) {
    const [guardianRows, teacherRows, teachesRows, memberRows, courseRows] = await Promise.all([
      tx.query<{ child_id: string }>(
        `SELECT child_id FROM guardian_relationships
          WHERE guardian_id = $1 AND status = 'verified'`,
        [actorId],
      ),

      // The derivation. Every hop is status-checked.
      tx.query<{ student_id: string }>(
        `SELECT DISTINCT cm.user_id AS student_id
           FROM teacher_assignments ta
           JOIN classes c            ON c.id = ta.class_id
           JOIN class_memberships cm ON cm.class_id = ta.class_id
          WHERE ta.teacher_id = $1
            AND ta.status = 'active'
            AND c.status  = 'active'
            AND cm.status = 'active'
            AND cm.user_id <> $1`,
        [actorId],
      ),

      tx.query<{ class_id: string }>(
        `SELECT ta.class_id
           FROM teacher_assignments ta
           JOIN classes c ON c.id = ta.class_id
          WHERE ta.teacher_id = $1 AND ta.status = 'active' AND c.status = 'active'`,
        [actorId],
      ),

      tx.query<{ class_id: string }>(
        `SELECT cm.class_id
           FROM class_memberships cm
           JOIN classes c ON c.id = cm.class_id
          WHERE cm.user_id = $1 AND cm.status = 'active' AND c.status = 'active'`,
        [actorId],
      ),

      // Courses reachable THROUGH a class, by either route. Every hop is
      // status-checked, and the union is written once — so withdrawing the
      // assignment, ending the membership or archiving the class each revoke
      // access on the next request, with no cache and no second table to
      // remember to update.
      tx.query<{ course_id: string }>(
        `SELECT a.course_id
           FROM class_course_assignments a
           JOIN classes c            ON c.id = a.class_id
           JOIN class_memberships cm ON cm.class_id = a.class_id
          WHERE cm.user_id = $1
            AND a.status  = 'active'
            AND c.status  = 'active'
            AND cm.status = 'active'
          UNION
         SELECT a.course_id
           FROM class_course_assignments a
           JOIN classes c              ON c.id = a.class_id
           JOIN teacher_assignments ta ON ta.class_id = a.class_id
          WHERE ta.teacher_id = $1
            AND a.status  = 'active'
            AND c.status  = 'active'
            AND ta.status = 'active'`,
        [actorId],
      ),
    ]);

    return {
      guardianOf: guardianRows.rows.map((r) => r.child_id),
      teacherOf: teacherRows.rows.map((r) => r.student_id),
      teachesClasses: teachesRows.rows.map((r) => r.class_id),
      memberOfClasses: memberRows.rows.map((r) => r.class_id),
      coursesViaClasses: courseRows.rows.map((r) => r.course_id),
    };
  },
};
