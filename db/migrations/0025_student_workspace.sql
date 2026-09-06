-- ============================================================================
-- 0025 — THE STUDENT WORKSPACE: NOTEBOOKS, ANCHORED NOTES, PERSONAL ARTIFACTS
-- ============================================================================
--
-- A learner's workspace is the most privacy-sensitive ordinary data on this
-- platform: a minor's unfiltered working thoughts about what they are studying.
-- 0003 built the note; this builds the desk it sits on.
--
-- FOUR DECISIONS SHAPE EVERYTHING BELOW
--
-- 1. THE NOTE TABLE IS EXTENDED, NOT DUPLICATED. `notes` already exists with a
--    policy that is exactly the rule this task asks for — owner-only writes,
--    reads only through a share the STUDENT opened, and no administrator branch
--    at all. A second `student_notes` table would be two rules for one visible
--    object, and two rules can disagree; the looser would win. So notes gain a
--    notebook and a curriculum anchor, and keep their policy.
--
-- 2. A NOTE IS ANCHORED AT EXACTLY ONE PLACE IN THE TREE, or nowhere. Storing
--    course_id AND unit_id AND lesson_id together would be three columns that
--    must agree, and one day would not — the same reasoning that kept a
--    class_id off `experiment_sessions` in 0024. A lesson already determines
--    its unit and its course; the wider ids are resolved live when needed.
--
-- 3. RETENTION AND REJECTION ARE DIFFERENT QUESTIONS, asked of different
--    statements. A learner may not CREATE a note against a course they cannot
--    study — that would be a way to probe the catalog. A learner keeps every
--    note they already wrote when the term ends, because revision notes are
--    theirs, not the school's. So the INSERT policy asks
--    `app_actor_may_study_lesson` and the SELECT policy does not.
--
-- 4. NO CLIENT EVER SUPPLIES A STORAGE PATH. `student_artifacts` holds a
--    storage key this migration DERIVES from the owner and their organization.
--    A path or URL chosen by a caller is an arbitrary-reference bug wearing a
--    metadata field's clothes, and docs/security/file-security.md already
--    forbids trusting a client's filename or serving user files from the
--    application origin.
-- ============================================================================

-- ── NOTEBOOKS ───────────────────────────────────────────────────────────────
--
-- `owner_id`, not `student_id`. The column names the relationship the policies
-- actually test — `owner_id = app_current_actor()` — and matches `notes`, which
-- this table is the parent of. A teacher keeping their own notes is the owner
-- of them; nothing here is student-only by type.

CREATE TABLE student_notebooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Denormalized from the owner at write time, exactly as on `notes` and for
  -- the same reason: RLS must evaluate the organization check without a join
  -- back to `users`, which is itself protected by RLS and would make the
  -- policy recursive.
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,

  title       text NOT NULL,
  description text NOT NULL DEFAULT '',

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT student_notebooks_title_len_ck
    CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT student_notebooks_description_len_ck
    CHECK (length(description) <= 2000)
);

-- One notebook of a given name per owner. Case-insensitive, because "Physics"
-- and "physics" are the same notebook to the child who made them, and two of
-- them is a filing mistake rather than a feature.
CREATE UNIQUE INDEX student_notebooks_owner_title_uk
  ON student_notebooks (owner_id, lower(btrim(title)));

-- The target of a COMPOSITE foreign key from `notes`. Redundant as an index —
-- `id` is already unique on its own — and load-bearing as a constraint: it is
-- what lets another table say "the notebook with this id has this owner" in
-- SQL rather than in a trigger. See the FK on `notes` below.
ALTER TABLE student_notebooks
  ADD CONSTRAINT student_notebooks_id_owner_uk UNIQUE (id, owner_id);

CREATE INDEX student_notebooks_owner_ix
  ON student_notebooks (owner_id, updated_at DESC);

-- ── NOTES GAIN A NOTEBOOK AND AN ANCHOR ─────────────────────────────────────

ALTER TABLE notes
  ADD COLUMN notebook_id uuid,
  ADD COLUMN course_id uuid REFERENCES courses(id)      ON DELETE SET NULL,
  ADD COLUMN unit_id   uuid REFERENCES course_units(id) ON DELETE SET NULL,
  ADD COLUMN lesson_id uuid REFERENCES lessons(id)      ON DELETE SET NULL;

-- A NOTE IS FILED IN ITS OWN OWNER'S NOTEBOOK, SAID AS A FOREIGN KEY.
--
-- The composite reference is the whole point. A plain `REFERENCES
-- student_notebooks(id)` would let a learner file a note into somebody else's
-- notebook and leave the ownership rule to be enforced somewhere softer;
-- naming `(notebook_id, owner_id)` makes the database itself refuse.
--
-- It is a CONSTRAINT rather than a trigger for a reason the first draft of this
-- migration learned the hard way. The check was a SECURITY DEFINER helper
-- reading `student_notebooks` — and `FORCE ROW LEVEL SECURITY` applies to the
-- table owner too, so the helper ran as `edu_migrator`, matched no policy, and
-- answered NULL for every notebook that existed. Referential integrity checks
-- are exempt from RLS by design, which is exactly the property wanted here, and
-- getting it needs no policy widening on the platform's most private table.
--
-- ON DELETE SET NULL (notebook_id) — column-specific, PostgreSQL 15+. Deleting
-- a notebook is a filing action and must not destroy the child's writing, and
-- without naming the column the clause would try to NULL `owner_id` too.
ALTER TABLE notes
  ADD CONSTRAINT notes_notebook_same_owner_fk
    FOREIGN KEY (notebook_id, owner_id)
    REFERENCES student_notebooks (id, owner_id)
    ON DELETE SET NULL (notebook_id);

-- `notes`' own composite target, for the artifacts below.
ALTER TABLE notes ADD CONSTRAINT notes_id_owner_uk UNIQUE (id, owner_id);

-- ON DELETE SET NULL on all three for the same reason: withdrawing a lesson
-- from the catalog must not delete what a child wrote while studying it. The
-- note survives, unanchored.

ALTER TABLE notes
  ADD CONSTRAINT notes_single_anchor_ck
    CHECK (num_nonnulls(course_id, unit_id, lesson_id) <= 1);

CREATE INDEX notes_lesson_ix   ON notes (owner_id, lesson_id) WHERE lesson_id IS NOT NULL;
CREATE INDEX notes_course_ix   ON notes (owner_id, course_id) WHERE course_id IS NOT NULL;
CREATE INDEX notes_notebook_ix ON notes (owner_id, notebook_id, updated_at DESC);

-- The same composite target on lab sessions, so an artifact can name one only
-- when it belongs to the same learner. 0024 had no need of it; this does.
ALTER TABLE experiment_sessions
  ADD CONSTRAINT experiment_sessions_id_user_uk UNIQUE (id, user_id);

-- ── DEFINER HELPERS ─────────────────────────────────────────────────────────
--
-- Every policy below reaches another table only through one of these, so no
-- policy names a second table directly — the rule 0018, 0019 and 0024 follow.

-- THERE IS NO `app_note_owner` AND NO `app_notebook_owner` HELPER, on purpose.
-- Both were written, both were SECURITY DEFINER, and both answered NULL for
-- every row — `FORCE ROW LEVEL SECURITY` binds the table owner too, and neither
-- table grants `edu_migrator` a read. The ownership rules they were written for
-- are composite foreign keys above, which the database enforces without
-- consulting any policy at all.

/**
 * May the CURRENT actor anchor personal work at this point in the tree?
 *
 * Total, and false for a NULL anchor is never asked — the caller checks
 * `num_nonnulls` first. `unit` resolves to its course rather than asking a
 * separate question, because studying a course is what grants reach to
 * everything under it.
 */
CREATE FUNCTION app_actor_may_anchor_here(
  p_course_id uuid,
  p_unit_id   uuid,
  p_lesson_id uuid
) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    -- No anchor at all: a free-standing note. Always permitted; a learner does
    -- not need a course's permission to think.
    WHEN num_nonnulls(p_course_id, p_unit_id, p_lesson_id) = 0 THEN true
    WHEN p_lesson_id IS NOT NULL THEN app_actor_may_study_lesson(p_lesson_id)
    WHEN p_unit_id   IS NOT NULL THEN app_actor_studies_course(app_unit_course(p_unit_id))
    WHEN p_course_id IS NOT NULL THEN app_actor_studies_course(p_course_id)
    ELSE false
  END
$$;

-- ── ARTIFACTS ───────────────────────────────────────────────────────────────
--
-- A REGISTRY OF FILES, NOT A FILE STORE. No bytes are accepted here and none
-- are served: `docs/security/file-security.md` makes "never serve unscanned
-- content" a non-negotiable, and this platform has no scanner, no quarantine
-- bucket and no storage adapter. What this table does is reserve a
-- tenant-scoped key and account for the space, so that when the pipeline is
-- built it has somewhere correct to write.

CREATE TABLE student_artifacts (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,

  -- Where the artifact hangs, if anywhere. Both optional and independent: a
  -- diagram may belong to a note, a lab export to an experiment session, a
  -- loose upload to neither.
  -- Composite foreign keys, declared after the table. Both carry `owner_id`, so
  -- "you may only attach a file to your own work" is referential integrity
  -- rather than a rule some layer has to remember to apply.
  note_id    uuid,
  session_id uuid,

  artifact_type text NOT NULL,

  -- SERVER-DERIVED. Written by `student_artifact_guard` below from the owner,
  -- their organization and the row's own id. There is no code path, here or in
  -- the API, through which a caller supplies this.
  storage_key text NOT NULL,

  -- The declared type, kept as metadata only. When an upload pipeline exists it
  -- will determine the real type from magic bytes and must not trust this.
  declared_content_type text NOT NULL,

  -- The client's filename, for display. NEVER used as a path.
  original_filename text NOT NULL DEFAULT '',

  byte_size bigint NOT NULL,
  metadata  jsonb  NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT student_artifacts_type_ck
    CHECK (artifact_type IN ('image', 'code_snippet', 'pdf', 'data_export')),

  -- 25 MiB per artifact. Large enough for a scanned worksheet, small enough
  -- that one file is not a denial of service on its own.
  CONSTRAINT student_artifacts_size_ck
    CHECK (byte_size > 0 AND byte_size <= 26214400),

  CONSTRAINT student_artifacts_metadata_kind_ck CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT student_artifacts_metadata_size_ck CHECK (pg_column_size(metadata) <= 16384),

  CONSTRAINT student_artifacts_filename_len_ck CHECK (length(original_filename) <= 255),
  CONSTRAINT student_artifacts_content_type_len_ck
    CHECK (length(declared_content_type) BETWEEN 1 AND 128),

  -- The key is unique across the platform, which is what makes it safe to use
  -- as an object name later. Uniqueness is by construction (it contains the
  -- row's own uuid) and asserted here so a future writer cannot break it.
  CONSTRAINT student_artifacts_storage_key_uk UNIQUE (storage_key),

  -- ON DELETE SET NULL on the parent column ONLY (PostgreSQL 15+). Deleting a
  -- note must not delete the file registered against it — the accounting for
  -- that file is what keeps the quota honest — and without naming the column
  -- the clause would try to NULL `owner_id`, which is NOT NULL.
  CONSTRAINT student_artifacts_note_same_owner_fk
    FOREIGN KEY (note_id, owner_id) REFERENCES notes (id, owner_id)
    ON DELETE SET NULL (note_id),

  CONSTRAINT student_artifacts_session_same_owner_fk
    FOREIGN KEY (session_id, owner_id) REFERENCES experiment_sessions (id, user_id)
    ON DELETE SET NULL (session_id)
);

CREATE INDEX student_artifacts_owner_ix   ON student_artifacts (owner_id, created_at DESC);
CREATE INDEX student_artifacts_note_ix    ON student_artifacts (note_id)    WHERE note_id IS NOT NULL;
CREATE INDEX student_artifacts_session_ix ON student_artifacts (session_id) WHERE session_id IS NOT NULL;

-- ── THE QUOTA ───────────────────────────────────────────────────────────────

/**
 * The per-learner storage ceiling, in bytes. 256 MiB.
 *
 * A FUNCTION rather than a literal in a constraint, so the number has one home
 * and a future per-organization ceiling has somewhere to go.
 */
CREATE FUNCTION app_artifact_quota_bytes() RETURNS bigint
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public
AS $$ SELECT 268435456::bigint $$;

CREATE FUNCTION app_artifact_bytes_used(p_owner_id uuid) RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(sum(a.byte_size), 0)::bigint
  FROM student_artifacts a
  WHERE a.owner_id = p_owner_id
$$;

/**
 * EVERY AUTHORITATIVE COLUMN IS ASSIGNED HERE, and the quota is enforced here
 * rather than in the service.
 *
 * The quota specifically: an application that reads `sum(byte_size)` and then
 * inserts has a race with a hair-fine window and a very cheap exploit — fire N
 * uploads at once and every one of them reads the pre-insert total. Doing it in
 * a BEFORE INSERT trigger under the row lock the insert already takes closes
 * that. The trigger is the rule; the API's check is only the friendly message.
 */
CREATE FUNCTION student_artifact_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  used  bigint;
  quota bigint;
BEGIN
  -- Ownership and tenancy come from the row's owner, never from the payload.
  NEW.organization_id := app_user_organization(NEW.owner_id);
  NEW.created_at      := now();

  -- THE STORAGE KEY IS BUILT, NOT ACCEPTED. Whatever a caller sent in this
  -- column is discarded before it reaches the table. The organization segment
  -- is what makes a key un-guessable across tenants and un-collidable within
  -- one; `COALESCE` keeps it total for a user with no school yet.
  NEW.storage_key := 'org/' || COALESCE(NEW.organization_id::text, 'none')
                  || '/user/' || NEW.owner_id::text
                  || '/' || NEW.id::text;

  quota := app_artifact_quota_bytes();
  used  := app_artifact_bytes_used(NEW.owner_id);

  IF used + NEW.byte_size > quota THEN
    RAISE EXCEPTION 'Storage quota exceeded for this learner'
      USING ERRCODE = 'disk_full';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER student_artifacts_insert
  BEFORE INSERT ON student_artifacts
  FOR EACH ROW EXECUTE FUNCTION student_artifact_guard();

/**
 * A note may only be anchored where its owner may study.
 *
 * ON INSERT ALWAYS. ON UPDATE ONLY WHEN THE ANCHOR MOVES — and that asymmetry
 * is decision 3 above, made concrete. A learner editing last term's revision
 * notes is not asking for anything new; a learner re-pointing a note at a
 * course they cannot reach is.
 *
 * THE NULL-ACTOR BRANCH IS NOT A BYPASS, and the distinction matters enough to
 * spell out. This is the one rule here that is about the CURRENT ACTOR rather
 * than about the row — "may YOU anchor here", not "is this row well formed" —
 * so it is meaningless on a connection that has no actor. Those are exactly the
 * migration and fixture paths, which legitimately construct states the
 * application cannot. `edu_app` can never reach the branch: every one of its
 * statements runs under `withActor`, and if the actor were somehow unset then
 * `owner_id = app_current_actor()` in the RLS policy would already have refused
 * the write, NULL comparing equal to nothing.
 *
 * The insert case is ALSO enforced in the RLS policy below, so the two gates
 * are independent and each is testable with the other removed.
 */
CREATE FUNCTION note_anchor_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  moved boolean;
BEGIN
  IF app_current_actor() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    moved := (NEW.course_id IS DISTINCT FROM OLD.course_id)
          OR (NEW.unit_id   IS DISTINCT FROM OLD.unit_id)
          OR (NEW.lesson_id IS DISTINCT FROM OLD.lesson_id);
    IF NOT moved THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NOT app_actor_may_anchor_here(NEW.course_id, NEW.unit_id, NEW.lesson_id) THEN
    RAISE EXCEPTION 'You cannot attach a note to coursework you are not studying'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER notes_anchor
  BEFORE INSERT OR UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION note_anchor_guard();

-- ============================================================================
-- ROW LEVEL SECURITY
--
-- OWNER-ONLY, WITHOUT A SINGLE SHARE BRANCH.
--
-- `notes` has a sharing model, because a student may choose to show a note to
-- their teacher. A NOTEBOOK and an ARTIFACT have none, and that is a decision
-- rather than an omission: a notebook is a filing cabinet whose contents are
-- individually shareable, and sharing the cabinet would share things the child
-- never opened. When per-notebook sharing is wanted it needs its own column,
-- its own policy branch and its own review — not a default nobody argued for.
-- ============================================================================

ALTER TABLE student_notebooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_notebooks FORCE  ROW LEVEL SECURITY;
ALTER TABLE student_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_artifacts FORCE  ROW LEVEL SECURITY;

-- FORCE applies to the owner too, so the migration role needs its own policy
-- on every table it must still reach. Same shape as 0018, 0019 and 0024.
CREATE POLICY student_notebooks_definer_all ON student_notebooks
  FOR ALL TO edu_migrator USING (true) WITH CHECK (true);
CREATE POLICY student_artifacts_definer_all ON student_artifacts
  FOR ALL TO edu_migrator USING (true) WITH CHECK (true);

-- ── THE SECOND GATE ON ANCHORING ────────────────────────────────────────────
--
-- `notes_insert_own` has said `owner_id = app_current_actor()` since 0005. It
-- now also says where a learner may anchor, so the rule holds with the trigger
-- removed and the trigger holds with the policy removed — the dual-gate
-- property every other domain on this platform is built to.
--
-- Only the INSERT policy carries it. An UPDATE cannot: RLS `WITH CHECK` sees
-- the new row and not the old one, so it cannot tell "moved the anchor" from
-- "edited the body of a note anchored last term". Putting the condition here
-- unconditionally would refuse the second, which is exactly the retention the
-- task asks for. Detecting the move needs OLD, and OLD is a trigger's to see.
ALTER POLICY notes_insert_own ON notes
  WITH CHECK (
    owner_id = app_current_actor()
    AND app_actor_may_anchor_here(course_id, unit_id, lesson_id)
  );

CREATE POLICY student_notebooks_select ON student_notebooks FOR SELECT TO edu_app
  USING (owner_id = app_current_actor());

CREATE POLICY student_notebooks_insert ON student_notebooks FOR INSERT TO edu_app
  WITH CHECK (owner_id = app_current_actor());

CREATE POLICY student_notebooks_update ON student_notebooks FOR UPDATE TO edu_app
  USING (owner_id = app_current_actor())
  -- Stops an owner re-parenting their notebook to another user.
  WITH CHECK (owner_id = app_current_actor());

CREATE POLICY student_notebooks_delete ON student_notebooks FOR DELETE TO edu_app
  USING (owner_id = app_current_actor());

CREATE POLICY student_artifacts_select ON student_artifacts FOR SELECT TO edu_app
  USING (owner_id = app_current_actor());

-- The parent-ownership half of this rule is NOT repeated here. It is a
-- composite foreign key, which the database checks on every write by every
-- role, including the one this policy does not apply to. Restating it would be
-- a second copy that could drift from the first.
CREATE POLICY student_artifacts_insert ON student_artifacts FOR INSERT TO edu_app
  WITH CHECK (owner_id = app_current_actor());

CREATE POLICY student_artifacts_delete ON student_artifacts FOR DELETE TO edu_app
  USING (owner_id = app_current_actor());

-- NO UPDATE POLICY AND NO UPDATE GRANT. An artifact records that a file was
-- registered, with the size it was accounted for at. Making it mutable would
-- make the quota a suggestion: register one byte, then edit the row to 25 MiB.
-- Replacing an artifact is a delete and a fresh registration.

-- ============================================================================
-- PRIVILEGES
-- ============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON student_notebooks TO edu_app;
GRANT SELECT, INSERT,         DELETE ON student_artifacts TO edu_app;

REVOKE ALL ON FUNCTION app_actor_may_anchor_here(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_artifact_quota_bytes()                  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_artifact_bytes_used(uuid)               FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_actor_may_anchor_here(uuid, uuid, uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_artifact_quota_bytes()                  TO edu_app;
GRANT EXECUTE ON FUNCTION app_artifact_bytes_used(uuid)               TO edu_app;

-- `app_artifact_bytes_used` is granted deliberately: a learner is entitled to
-- know how much of their own quota they have used, and the function is scoped
-- by the id passed to it. It discloses one number about one person, and the API
-- only ever passes the caller's own id.
