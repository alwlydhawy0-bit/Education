-- =====================================================================
-- 0003 — Student notebook
-- =====================================================================
-- The notebook is the worked example for the platform's protected-resource
-- pattern: an owned, private-by-default record whose visibility the STUDENT
-- controls. Later domains (projects, submissions, portfolios, files) follow the
-- same shape: owner_id + organization_id + visibility + state.
-- =====================================================================

CREATE TABLE notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Denormalized from the owner at write time so that RLS can evaluate the
  -- organization check without a join back to `users` (which is itself
  -- protected by RLS, and would make the policy recursive).
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  title           text NOT NULL,
  body            text NOT NULL DEFAULT '',
  visibility      text NOT NULL DEFAULT 'private',
  state           text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notes_title_len_ck  CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT notes_body_len_ck   CHECK (length(body) <= 65536),
  CONSTRAINT notes_visibility_ck CHECK (visibility IN ('private', 'shared_with_teacher', 'shared_with_guardian')),
  CONSTRAINT notes_state_ck      CHECK (state IN ('active', 'archived', 'deleted'))
);

CREATE INDEX notes_owner_state_idx ON notes (owner_id, state, updated_at DESC);
-- Supports the teacher/guardian shared-note lookups without a full scan.
CREATE INDEX notes_shared_idx ON notes (owner_id, visibility)
  WHERE state = 'active' AND visibility <> 'private';

GRANT SELECT, INSERT, UPDATE, DELETE ON notes TO edu_app;
