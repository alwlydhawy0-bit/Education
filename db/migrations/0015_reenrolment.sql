-- =====================================================================
-- 0015 — Make removal from a roster reversible
-- =====================================================================
-- Migration 0008 declared:
--
--   CREATE UNIQUE INDEX class_memberships_pair_uk    ON class_memberships (class_id, user_id);
--   CREATE UNIQUE INDEX teacher_assignments_pair_uk  ON teacher_assignments (teacher_id, class_id);
--
-- ...one row per pair, FOR ALL TIME. Task 004 then made removal a status
-- change rather than a DELETE, because the roster history is the audit trail
-- for who could read whose work, and when. The two rules together say
-- something nobody intended: a student removed from a class can NEVER be put
-- back, and a teacher unassigned from a class can never be reassigned to it.
-- The insert fails on the unique index and the API answers 409 or 500.
--
-- That is not a security boundary — it is an accident of two correct decisions
-- meeting. Both tables already carry a `status`, and reinstating an ENDED row
-- is deliberately impossible (`class_memberships_update` and
-- `teacher_assignments_update` both require `status = 'active'` in USING, and
-- the immutability triggers from 0014 forbid re-pointing the parties). So the
-- only way to re-enrol somebody is a NEW row, which is also the honest one:
-- each spell on the roster gets its own record, with its own joined_at and
-- ended_at, and the audit trail reads as a sequence rather than a mutation.
--
-- The uniqueness that must hold is therefore over ACTIVE rows only: nobody may
-- be on a roster twice at once. History may repeat.
-- =====================================================================

DROP INDEX class_memberships_pair_uk;
DROP INDEX teacher_assignments_pair_uk;

-- At most one ACTIVE membership per (class, user). Ended rows accumulate.
CREATE UNIQUE INDEX class_memberships_active_uk
  ON class_memberships (class_id, user_id) WHERE status = 'active';

-- At most one ACTIVE assignment per (teacher, class).
CREATE UNIQUE INDEX teacher_assignments_active_uk
  ON teacher_assignments (teacher_id, class_id) WHERE status = 'active';

-- The non-unique lookup indexes from 0008 (`*_class_idx`, `*_user_idx`,
-- `*_teacher_idx`) are all partial on `status = 'active'` and still serve the
-- reads; nothing indexed the historical rows before and nothing does now.
