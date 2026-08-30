-- =====================================================================
-- 0002 — Relationship edges (guardian, teacher)
-- =====================================================================
-- These two tables are authorization inputs, not merely descriptive data. A
-- wrong row here silently widens who can read a student's work, so the
-- constraints are tighter than they would be for ordinary reference data.
-- =====================================================================

CREATE TABLE guardian_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guardian_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending',
  verified_at timestamptz,
  verified_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT guardian_links_status_ck CHECK (status IN ('pending', 'verified', 'revoked')),
  -- Blocks the trivial escalation of claiming guardianship over yourself to
  -- unlock guardian-scoped grants.
  CONSTRAINT guardian_links_not_self_ck CHECK (guardian_id <> student_id),
  -- A link is only 'verified' if it actually records when that happened;
  -- authorization keys off status, so the two must not drift apart.
  CONSTRAINT guardian_links_verified_consistency_ck
    CHECK ((status = 'verified') = (verified_at IS NOT NULL))
);

CREATE UNIQUE INDEX guardian_links_pair_uk ON guardian_links (guardian_id, student_id);
CREATE INDEX guardian_links_student_idx ON guardian_links (student_id) WHERE status = 'verified';

-- ---------------------------------------------------------------------
CREATE TABLE teacher_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,

  CONSTRAINT teacher_assignments_status_ck CHECK (status IN ('active', 'ended')),
  CONSTRAINT teacher_assignments_not_self_ck CHECK (teacher_id <> student_id),
  -- An assignment that has ended must say when. Access is granted on
  -- status='active', so an 'ended' row with no timestamp is a bug we refuse to
  -- store rather than a stale grant we silently honour.
  CONSTRAINT teacher_assignments_ended_consistency_ck
    CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);

CREATE UNIQUE INDEX teacher_assignments_triple_uk
  ON teacher_assignments (teacher_id, student_id, organization_id);
CREATE INDEX teacher_assignments_student_idx
  ON teacher_assignments (student_id) WHERE status = 'active';

GRANT SELECT ON guardian_links TO edu_app;
GRANT SELECT ON teacher_assignments TO edu_app;
