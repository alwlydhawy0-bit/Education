-- =====================================================================
-- 0008 — Classes, class membership, and reshaped relationships
-- =====================================================================
-- The authorization-relevant change in this migration:
--
--   BEFORE:  teacher --(teacher_assignments.student_id)--> student
--   AFTER:   teacher --(teacher_assignments.class_id)--> class
--                                                          ^
--            student --(class_memberships.class_id)--------+
--
-- Teacher-to-student is now DERIVED through a shared class rather than stored
-- as a direct edge. That matches how schools actually work, and it removes a
-- whole class of stale-grant bug: when a student leaves a class, every teacher
-- of that class loses access in the same instant, with no second table to
-- remember to update.
--
-- It also means the derivation lives in exactly one place. `teacher_of(actor)`
-- below is that place, and `relationshipReader` is its only caller.
--
-- BREAKING: `teacher_assignments` and `guardian_links` are dropped and
-- recreated. Approved deliberately; nothing is deployed.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Drop the policies that reference the tables being replaced.
--
-- `notes_select` and `users_select` both read `teacher_assignments` and
-- `guardian_links`, so PostgreSQL would refuse the DROP TABLE below. Using
-- CASCADE instead would silently delete the policies and leave `notes` with no
-- SELECT policy — fail-closed, but invisibly broken. Both are recreated at the
-- end of this migration against the new shape, so the schema is never left
-- half-migrated.
-- ---------------------------------------------------------------------
DROP POLICY notes_select ON notes;
DROP POLICY users_select ON users;

-- ---------------------------------------------------------------------
CREATE TABLE classes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  -- e.g. '2026' or '2026-S1'. Kept as text because academic calendars differ.
  academic_term   text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz,

  CONSTRAINT classes_name_len_ck CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT classes_status_ck CHECK (status IN ('active', 'archived')),
  -- Status and evidence must not drift: access is granted on status='active'.
  CONSTRAINT classes_archived_consistency_ck CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

CREATE INDEX classes_organization_idx ON classes (organization_id) WHERE status = 'active';

-- ---------------------------------------------------------------------
-- Students (and other participants) in a class.
-- ---------------------------------------------------------------------
CREATE TABLE class_memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id      uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_in_class text NOT NULL DEFAULT 'student',
  status        text NOT NULL DEFAULT 'active',
  joined_at     timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,

  CONSTRAINT class_memberships_role_ck CHECK (role_in_class IN ('student', 'assistant', 'observer')),
  CONSTRAINT class_memberships_status_ck CHECK (status IN ('active', 'ended')),
  CONSTRAINT class_memberships_ended_consistency_ck CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);

CREATE UNIQUE INDEX class_memberships_pair_uk ON class_memberships (class_id, user_id);
CREATE INDEX class_memberships_user_idx ON class_memberships (user_id) WHERE status = 'active';
CREATE INDEX class_memberships_class_idx ON class_memberships (class_id) WHERE status = 'active';

-- ---------------------------------------------------------------------
-- Teacher assignments — now class-scoped.
-- ---------------------------------------------------------------------
DROP TABLE teacher_assignments;

CREATE TABLE teacher_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id      uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  role_in_class text NOT NULL DEFAULT 'teacher',
  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,

  CONSTRAINT teacher_assignments_role_ck CHECK (role_in_class IN ('teacher', 'assistant_teacher', 'substitute')),
  CONSTRAINT teacher_assignments_status_ck CHECK (status IN ('active', 'ended')),
  CONSTRAINT teacher_assignments_ended_consistency_ck CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);

CREATE UNIQUE INDEX teacher_assignments_pair_uk ON teacher_assignments (teacher_id, class_id);
CREATE INDEX teacher_assignments_class_idx ON teacher_assignments (class_id) WHERE status = 'active';
CREATE INDEX teacher_assignments_teacher_idx ON teacher_assignments (teacher_id) WHERE status = 'active';

-- ---------------------------------------------------------------------
-- Guardian relationships (replaces guardian_links; adds relationship_type).
-- ---------------------------------------------------------------------
DROP TABLE guardian_links;

CREATE TABLE guardian_relationships (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guardian_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  child_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relationship_type text NOT NULL DEFAULT 'guardian',
  status            text NOT NULL DEFAULT 'pending',
  verified_at       timestamptz,
  verified_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT guardian_relationships_type_ck
    CHECK (relationship_type IN ('parent', 'guardian', 'caregiver')),
  CONSTRAINT guardian_relationships_status_ck
    CHECK (status IN ('pending', 'verified', 'revoked')),
  -- Blocks the trivial escalation of claiming guardianship over yourself.
  CONSTRAINT guardian_relationships_not_self_ck CHECK (guardian_id <> child_id),
  -- Authorization keys off status='verified', so a verified row must record
  -- when and by whom it was verified.
  CONSTRAINT guardian_relationships_verified_consistency_ck
    CHECK ((status = 'verified') = (verified_at IS NOT NULL))
);

CREATE UNIQUE INDEX guardian_relationships_pair_uk
  ON guardian_relationships (guardian_id, child_id);
CREATE INDEX guardian_relationships_child_idx
  ON guardian_relationships (child_id) WHERE status = 'verified';
CREATE INDEX guardian_relationships_guardian_idx
  ON guardian_relationships (guardian_id) WHERE status = 'verified';

GRANT SELECT ON classes TO edu_app;
GRANT SELECT ON class_memberships TO edu_app;
GRANT SELECT ON teacher_assignments TO edu_app;
GRANT SELECT ON guardian_relationships TO edu_app;

-- =====================================================================
-- Row-Level Security for the new tables
-- =====================================================================
-- ORDER MATTERS. These policies reference each other, and PostgreSQL raises
-- "infinite recursion detected in policy" on a cycle. The reference graph is
-- kept strictly acyclic:
--
--     classes  ->  class_memberships  ->  teacher_assignments  ->  (nothing)
--
-- `teacher_assignments` is the base case: it matches on the actor's own id only
-- and consults no other table.
-- =====================================================================

ALTER TABLE teacher_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_assignments FORCE ROW LEVEL SECURITY;

-- Base case: a teacher sees their own assignments and nobody else's.
CREATE POLICY teacher_assignments_select_own ON teacher_assignments FOR SELECT TO edu_app
  USING (teacher_id = app_current_actor());

ALTER TABLE class_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_memberships FORCE ROW LEVEL SECURITY;

-- A member sees their own membership; a teacher sees the roster of a class they
-- actively teach.
CREATE POLICY class_memberships_select ON class_memberships FOR SELECT TO edu_app
  USING (
    user_id = app_current_actor()
    OR EXISTS (
      SELECT 1 FROM teacher_assignments ta
      WHERE ta.class_id = class_memberships.class_id
        AND ta.teacher_id = app_current_actor()
        AND ta.status = 'active'
    )
  );

ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE classes FORCE ROW LEVEL SECURITY;

CREATE POLICY classes_select ON classes FOR SELECT TO edu_app
  USING (
    EXISTS (
      SELECT 1 FROM teacher_assignments ta
      WHERE ta.class_id = classes.id AND ta.teacher_id = app_current_actor() AND ta.status = 'active'
    )
    OR EXISTS (
      SELECT 1 FROM class_memberships cm
      WHERE cm.class_id = classes.id AND cm.user_id = app_current_actor() AND cm.status = 'active'
    )
  );

ALTER TABLE guardian_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardian_relationships FORCE ROW LEVEL SECURITY;

-- Either participant may see the edge. A guardian must be able to see their own
-- link; a student must be able to see who claims guardianship over them.
CREATE POLICY guardian_relationships_select_participant ON guardian_relationships
  FOR SELECT TO edu_app
  USING (guardian_id = app_current_actor() OR child_id = app_current_actor());

-- =====================================================================
-- Recreate the policies dropped at the top, against the new shape
-- =====================================================================
-- The teacher branch is the substantive change: teacher-to-student is now
-- DERIVED through a shared, active class rather than read from a direct edge.
-- Every hop is checked for status, so an archived class, an ended assignment or
-- an ended membership each independently revoke access.
--
-- The organization check is preserved: it now rides on the class's organization,
-- which is a stronger guarantee than the old denormalized column because a class
-- cannot belong to two schools.

CREATE POLICY notes_select ON notes FOR SELECT TO edu_app
  USING (
    owner_id = app_current_actor()
    OR (
      state <> 'deleted'
      AND (
        (
          visibility = 'shared_with_teacher'
          AND EXISTS (
            SELECT 1
            FROM teacher_assignments ta
            JOIN classes c ON c.id = ta.class_id
            JOIN class_memberships cm ON cm.class_id = ta.class_id
            WHERE ta.teacher_id = app_current_actor()
              AND ta.status = 'active'
              AND c.status = 'active'
              AND c.organization_id = notes.organization_id
              AND cm.user_id = notes.owner_id
              AND cm.status = 'active'
          )
        )
        OR (
          visibility = 'shared_with_guardian'
          AND EXISTS (
            SELECT 1 FROM guardian_relationships gr
            WHERE gr.guardian_id = app_current_actor()
              AND gr.child_id = notes.owner_id
              AND gr.status = 'verified'
          )
        )
      )
    )
  );

CREATE POLICY users_select ON users FOR SELECT TO edu_app
  USING (
    id = app_current_actor()
    OR EXISTS (
      SELECT 1
      FROM teacher_assignments ta
      JOIN classes c ON c.id = ta.class_id
      JOIN class_memberships cm ON cm.class_id = ta.class_id
      WHERE ta.teacher_id = app_current_actor()
        AND ta.status = 'active'
        AND c.status = 'active'
        AND cm.user_id = users.id
        AND cm.status = 'active'
    )
    OR EXISTS (
      SELECT 1 FROM guardian_relationships gr
      WHERE gr.guardian_id = app_current_actor()
        AND gr.child_id = users.id
        AND gr.status = 'verified'
    )
  );
