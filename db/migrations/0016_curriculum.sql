-- =====================================================================
-- 0016 — Curriculum, courses, units and lessons
-- =====================================================================
-- The educational content tree:
--
--     education_levels          (global reference data: Primary, Middle, ...)
--     curricula                 (subject catalog: Mathematics, Physics, ...)
--       └── courses             (a subject taught at a level)
--             └── course_units  (ordered)
--                   └── lessons (ordered)
--
-- TWO AXES OF ACCESS, and they are independent:
--
--   1. OWNERSHIP. `organization_id IS NULL` means the GLOBAL catalog, authored
--      by a platform operator and readable by everybody. A non-null value means
--      the content belongs to one school and is invisible outside it. There is
--      no third state, and no row may move between the two — a trigger below
--      pins `organization_id` for the life of the row.
--
--   2. LIFECYCLE. `draft` -> `published` -> `archived`, one way. A draft is
--      visible only to the people who may author it; `published` is what a
--      student may see; `archived` returns to authors-only. There is no
--      un-publish: retracting content a class is midway through is a decision
--      with consequences beyond this table, so the supported move is to archive
--      and supersede.
--
-- SEPARATION OF DUTIES. Two permissions, deliberately not one:
--   `content:author`  — create and edit DRAFT content in your own scope.
--   `content:publish` — move content along the lifecycle.
-- A teacher may write a draft; making it visible to students is an editorial
-- act held by reviewers and administrators. The status-transition trigger below
-- enforces this in the database, so it cannot be bypassed by an UPDATE that the
-- row-level policy would otherwise permit (a policy sees only the new row; it
-- cannot tell that `status` is what changed).
--
-- RECURSION. Same discipline as 0014: every cross-table check goes through a
-- SECURITY DEFINER helper, so policies on these tables never reference another
-- table directly and the reference graph stays acyclic.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

/**
 * Whether the CURRENT actor holds a named permission.
 *
 * Answers only about the caller, so it cannot be used to probe anybody else's
 * grants. Permissions are the RBAC currency the application already uses; asking
 * about them here keeps the two gates phrased in the same vocabulary instead of
 * the database re-deriving authority from role names.
 */
CREATE FUNCTION app_actor_has_permission(p_name text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM user_roles ur
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = app_current_actor()
      AND p.name = p_name
  );
$$;

REVOKE ALL ON FUNCTION app_actor_has_permission(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_actor_has_permission(text) TO edu_app;

-- The two helpers used throughout this migration. Named rather than inlined so
-- that "who may author?" has exactly one definition.
CREATE FUNCTION app_actor_authors_content() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $$ SELECT app_actor_has_permission('content:author'); $$;

CREATE FUNCTION app_actor_publishes_content() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $$ SELECT app_actor_has_permission('content:publish'); $$;

REVOKE ALL ON FUNCTION app_actor_authors_content() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_publishes_content() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_actor_authors_content() TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_publishes_content() TO edu_app;

-- ---------------------------------------------------------------------
-- education_levels — global reference data
-- ---------------------------------------------------------------------
-- Not owned by any organization: "Grade 7" means the same thing in every
-- school, and letting each school mint its own would make cross-school content
-- reuse impossible. Only a platform operator writes here.
CREATE TABLE education_levels (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL,
  name       text NOT NULL,
  stage      text NOT NULL,
  -- The grade within the stage, where the stage has numbered grades.
  grade      integer,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT education_levels_code_ck  CHECK (code ~ '^[a-z][a-z0-9_]{1,49}$'),
  CONSTRAINT education_levels_name_ck  CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT education_levels_stage_ck CHECK (stage IN ('primary', 'middle', 'secondary', 'university')),
  CONSTRAINT education_levels_grade_ck CHECK (grade IS NULL OR grade BETWEEN 1 AND 12)
);

CREATE UNIQUE INDEX education_levels_code_uk ON education_levels (code);
CREATE INDEX education_levels_order_idx ON education_levels (sort_order, code);

-- ---------------------------------------------------------------------
-- curricula — the subject catalog
-- ---------------------------------------------------------------------
CREATE TABLE curricula (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = the GLOBAL catalog. Non-null = private to one school.
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  code            text NOT NULL,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'draft',
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  archived_at     timestamptz,

  CONSTRAINT curricula_code_ck   CHECK (code ~ '^[a-z][a-z0-9_]{1,49}$'),
  CONSTRAINT curricula_name_ck   CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT curricula_desc_ck   CHECK (length(description) <= 4000),
  CONSTRAINT curricula_status_ck CHECK (status IN ('draft', 'published', 'archived')),
  -- The timestamps and the status cannot disagree: a published row records when.
  CONSTRAINT curricula_published_consistency_ck CHECK ((status = 'published') = (published_at IS NOT NULL AND archived_at IS NULL)),
  CONSTRAINT curricula_archived_consistency_ck  CHECK ((status = 'archived')  = (archived_at IS NOT NULL))
);

-- Unique per catalog: one `math` globally, and one `math` per school that
-- defines its own. COALESCE gives the global rows a stable key, because NULL is
-- not comparable in a unique index.
CREATE UNIQUE INDEX curricula_code_uk
  ON curricula (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), code);
CREATE INDEX curricula_org_status_idx ON curricula (organization_id, status);

-- ---------------------------------------------------------------------
-- courses
-- ---------------------------------------------------------------------
CREATE TABLE courses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: deleting a subject must not silently delete every
  -- course taught under it. The catalog entry has to be emptied first.
  curriculum_id   uuid NOT NULL REFERENCES curricula(id) ON DELETE RESTRICT,
  level_id        uuid NOT NULL REFERENCES education_levels(id) ON DELETE RESTRICT,
  title           text NOT NULL,
  summary         text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'draft',
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  archived_at     timestamptz,

  CONSTRAINT courses_title_ck   CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT courses_summary_ck CHECK (length(summary) <= 4000),
  CONSTRAINT courses_status_ck  CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT courses_published_consistency_ck CHECK ((status = 'published') = (published_at IS NOT NULL AND archived_at IS NULL)),
  CONSTRAINT courses_archived_consistency_ck  CHECK ((status = 'archived')  = (archived_at IS NOT NULL))
);

CREATE INDEX courses_org_status_idx  ON courses (organization_id, status);
CREATE INDEX courses_curriculum_idx  ON courses (curriculum_id);
CREATE INDEX courses_level_idx       ON courses (level_id);

-- ---------------------------------------------------------------------
-- course_units — ordered within a course
-- ---------------------------------------------------------------------
CREATE TABLE course_units (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position     integer NOT NULL,
  title        text NOT NULL,
  summary      text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'draft',
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  archived_at  timestamptz,

  CONSTRAINT course_units_position_ck CHECK (position >= 1),
  CONSTRAINT course_units_title_ck    CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT course_units_summary_ck  CHECK (length(summary) <= 4000),
  CONSTRAINT course_units_status_ck   CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT course_units_published_consistency_ck CHECK ((status = 'published') = (published_at IS NOT NULL AND archived_at IS NULL)),
  CONSTRAINT course_units_archived_consistency_ck  CHECK ((status = 'archived')  = (archived_at IS NOT NULL)),

  -- DEFERRABLE so a reorder can rewrite every position in one transaction
  -- without tripping over itself mid-shuffle. INITIALLY IMMEDIATE means the
  -- ordinary insert path still fails fast; only the reorder defers it, and the
  -- invariant is still checked before the transaction commits.
  CONSTRAINT course_units_position_uk UNIQUE (course_id, position) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX course_units_course_idx ON course_units (course_id, position);

-- ---------------------------------------------------------------------
-- lessons — ordered within a unit
-- ---------------------------------------------------------------------
-- Content is stored as MARKDOWN OR PLAIN TEXT, never HTML. Accepting HTML would
-- make every lesson a stored-XSS vector, and the renderer is not in this
-- repository to be audited. `external_url` is https-only for the same family of
-- reasons (a `javascript:` or `data:` URL is script injection; an arbitrary
-- scheme is an SSRF vector once anything server-side fetches it).
CREATE TABLE lessons (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id           uuid NOT NULL REFERENCES course_units(id) ON DELETE CASCADE,
  position          integer NOT NULL,
  title             text NOT NULL,
  summary           text NOT NULL DEFAULT '',
  content_format    text NOT NULL DEFAULT 'markdown',
  content_body      text NOT NULL DEFAULT '',
  external_url      text,
  estimated_minutes integer,
  objectives        text[] NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'draft',
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  published_at      timestamptz,
  archived_at       timestamptz,

  CONSTRAINT lessons_position_ck  CHECK (position >= 1),
  CONSTRAINT lessons_title_ck     CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT lessons_summary_ck   CHECK (length(summary) <= 4000),
  CONSTRAINT lessons_format_ck    CHECK (content_format IN ('markdown', 'plain')),
  -- Looser than the API contract's 64,000 on purpose: this is the backstop for
  -- anything reaching the table without passing validation, not the advertised
  -- limit. A CHECK equal to the contract would make the two indistinguishable
  -- and hide which one was doing the work.
  CONSTRAINT lessons_body_ck      CHECK (length(content_body) <= 65536),
  -- Three separate conditions rather than one clever pattern. PostgreSQL caps
  -- a bounded repetition at 255, so `[^\s]{1,2000}` is not merely wrong about
  -- `\s` (which is not a shorthand inside a POSIX bracket expression) — it
  -- fails to COMPILE, and a CHECK that throws rejects every row including the
  -- valid ones. Length and whitespace are cheaper to state directly.
  CONSTRAINT lessons_url_scheme_ck CHECK (external_url IS NULL OR external_url ~ '^https://'),
  CONSTRAINT lessons_url_len_ck    CHECK (external_url IS NULL OR length(external_url) BETWEEN 9 AND 2000),
  CONSTRAINT lessons_url_space_ck  CHECK (external_url IS NULL OR external_url !~ '[[:space:]]'),
  CONSTRAINT lessons_minutes_ck   CHECK (estimated_minutes IS NULL OR estimated_minutes BETWEEN 1 AND 1440),
  -- No subquery: a CHECK constraint may not contain one. `= ANY(array)` is a
  -- scalar expression, and bounding the joined length bounds the storage the
  -- column can consume, which is the property that actually matters here.
  CONSTRAINT lessons_objectives_ck CHECK (
    cardinality(objectives) <= 20
    AND NOT ('' = ANY (objectives))
    AND length(array_to_string(objectives, '|')) <= 6000
  ),
  CONSTRAINT lessons_status_ck    CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT lessons_published_consistency_ck CHECK ((status = 'published') = (published_at IS NOT NULL AND archived_at IS NULL)),
  CONSTRAINT lessons_archived_consistency_ck  CHECK ((status = 'archived')  = (archived_at IS NOT NULL)),

  CONSTRAINT lessons_position_uk UNIQUE (unit_id, position) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX lessons_unit_idx ON lessons (unit_id, position);

-- =====================================================================
-- Definer helpers for the content tree
-- =====================================================================
-- FORCE ROW LEVEL SECURITY binds the table OWNER too, and a SECURITY DEFINER
-- function runs AS the owner — so each table these read needs a policy for
-- `edu_migrator`, or the helpers silently answer NULL. That is VULN-007 and
-- VULN-012 in one sentence, and it is why the definer policies come first.
-- =====================================================================

ALTER TABLE education_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE education_levels FORCE ROW LEVEL SECURITY;
ALTER TABLE curricula        ENABLE ROW LEVEL SECURITY;
ALTER TABLE curricula        FORCE ROW LEVEL SECURITY;
ALTER TABLE courses          ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses          FORCE ROW LEVEL SECURITY;
ALTER TABLE course_units     ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_units     FORCE ROW LEVEL SECURITY;
ALTER TABLE lessons          ENABLE ROW LEVEL SECURITY;
ALTER TABLE lessons          FORCE ROW LEVEL SECURITY;

CREATE POLICY curricula_definer_select    ON curricula    FOR SELECT TO edu_migrator USING (true);
CREATE POLICY courses_definer_select      ON courses      FOR SELECT TO edu_migrator USING (true);
CREATE POLICY course_units_definer_select ON course_units FOR SELECT TO edu_migrator USING (true);
CREATE POLICY lessons_definer_select      ON lessons      FOR SELECT TO edu_migrator USING (true);

/**
 * The organization that owns a course, and NULL for the global catalog.
 *
 * Ambiguous by nature — NULL means both "global" and "no such course" — so
 * every caller pairs it with an explicit existence question rather than reading
 * a NULL as permission. `app_course_exists` is that question.
 */
CREATE FUNCTION app_course_organization(p_course_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT c.organization_id FROM courses c WHERE c.id = p_course_id; $$;

CREATE FUNCTION app_course_is_global(p_course_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM courses c WHERE c.id = p_course_id AND c.organization_id IS NULL);
$$;

CREATE FUNCTION app_course_status(p_course_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT c.status FROM courses c WHERE c.id = p_course_id; $$;

CREATE FUNCTION app_curriculum_organization(p_curriculum_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT c.organization_id FROM curricula c WHERE c.id = p_curriculum_id; $$;

CREATE FUNCTION app_curriculum_is_global(p_curriculum_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM curricula c WHERE c.id = p_curriculum_id AND c.organization_id IS NULL);
$$;

CREATE FUNCTION app_unit_course(p_unit_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT u.course_id FROM course_units u WHERE u.id = p_unit_id; $$;

/**
 * Whether a unit AND the course above it are both published.
 *
 * The tree is only as visible as its least-visible ancestor: a published lesson
 * inside a draft unit is not student-visible, and neither is a published unit
 * inside a draft course. Answering that here means every policy below asks the
 * whole-chain question rather than each level asking half of it.
 */
CREATE FUNCTION app_unit_chain_published(p_unit_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM course_units u
    JOIN courses c ON c.id = u.course_id
    WHERE u.id = p_unit_id
      AND u.status = 'published'
      AND c.status = 'published'
  );
$$;

REVOKE ALL ON FUNCTION app_course_organization(uuid)     FROM PUBLIC;
REVOKE ALL ON FUNCTION app_course_is_global(uuid)        FROM PUBLIC;
REVOKE ALL ON FUNCTION app_course_status(uuid)           FROM PUBLIC;
REVOKE ALL ON FUNCTION app_curriculum_organization(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_curriculum_is_global(uuid)    FROM PUBLIC;
REVOKE ALL ON FUNCTION app_unit_course(uuid)             FROM PUBLIC;
REVOKE ALL ON FUNCTION app_unit_chain_published(uuid)    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_course_organization(uuid)     TO edu_app;
GRANT EXECUTE ON FUNCTION app_course_is_global(uuid)        TO edu_app;
GRANT EXECUTE ON FUNCTION app_course_status(uuid)           TO edu_app;
GRANT EXECUTE ON FUNCTION app_curriculum_organization(uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_curriculum_is_global(uuid)    TO edu_app;
GRANT EXECUTE ON FUNCTION app_unit_course(uuid)             TO edu_app;
GRANT EXECUTE ON FUNCTION app_unit_chain_published(uuid)    TO edu_app;

-- =====================================================================
-- Lifecycle and ownership triggers
-- =====================================================================
-- A row-level policy sees only the NEW row. It cannot tell that `status` is the
-- column that changed, nor that `organization_id` was re-pointed at another
-- school. Both need OLD, so both are triggers — the same reasoning as
-- `relationship_parties_are_immutable` in 0014.
-- =====================================================================

CREATE FUNCTION content_lifecycle_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  status_changed  boolean := NEW.status IS DISTINCT FROM OLD.status;
  -- Everything EXCEPT the lifecycle columns. Comparing the rest as jsonb keeps
  -- this one function correct for all four content tables without naming their
  -- columns — and, more usefully, keeps it correct when a column is added.
  content_changed boolean := (to_jsonb(NEW) - 'status' - 'published_at' - 'archived_at' - 'updated_at')
                          IS DISTINCT FROM
                             (to_jsonb(OLD) - 'status' - 'published_at' - 'archived_at' - 'updated_at');
BEGIN
  IF status_changed THEN
    -- The transition graph, in one place. Forward only.
    IF NOT (
         (OLD.status = 'draft'     AND NEW.status IN ('published', 'archived'))
      OR (OLD.status = 'published' AND NEW.status = 'archived')
    ) THEN
      RAISE EXCEPTION 'Unsupported content transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  -- SEPARATION OF DUTIES, enforced per COLUMN GROUP.
  --
  -- The row-level policy admits anyone with either authority, because a policy
  -- sees only the new row and cannot tell which columns moved. Only a trigger
  -- can, so the split lives here: an author writes the content, a publisher
  -- moves the lifecycle, and holding one does not confer the other.
  --
  -- The NULL guard is the escape hatch for migrations and operator scripts,
  -- which run with no actor set. It matches the bootstrap exemption in 0013.
  -- A PLATFORM OPERATOR is exempt from the split, and has to be.
  --
  -- They are the only actor who can author global content, and `security_admin`
  -- deliberately carries neither content permission (see the note at the foot of
  -- this file). Without this branch the shared catalog could be written and then
  -- never published — and the policy engine, which grants an operator every
  -- content action, would be saying something the database refused. Two gates
  -- are only worth having while they agree about what is permitted.
  IF app_current_actor() IS NOT NULL AND NOT app_actor_is_platform_operator() THEN
    IF status_changed AND NOT app_actor_publishes_content() THEN
      RAISE EXCEPTION 'Changing content status requires the content:publish permission'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF content_changed AND NOT app_actor_authors_content() THEN
      RAISE EXCEPTION 'Editing content requires the content:author permission'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- The branches are NESTED, not combined with AND, and that is load-bearing.
-- plpgsql plans `TG_TABLE_NAME = 'lessons' AND NEW.unit_id <> OLD.unit_id` as a
-- single SQL expression, so it resolves `NEW.unit_id` even for a `curricula`
-- row and fails with "record NEW has no field unit_id". Each field reference
-- has to sit inside a branch already narrowed to its own table.
CREATE FUNCTION content_ownership_is_immutable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_NAME IN ('curricula', 'courses') THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      RAISE EXCEPTION 'Content cannot be moved between the global catalog and an organization'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'course_units' THEN
    IF NEW.course_id <> OLD.course_id THEN
      RAISE EXCEPTION 'A unit cannot be moved to another course'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'lessons' THEN
    IF NEW.unit_id <> OLD.unit_id THEN
      RAISE EXCEPTION 'A lesson cannot be moved to another unit'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Authorship cannot be reassigned'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

/**
 * A course may only sit under a curriculum it is allowed to see.
 *
 * A foreign key proves the curriculum exists; it cannot express "and it belongs
 * to the global catalog or to this same school". Without this, an organization
 * course could be filed under another school's private subject — which would
 * leak that subject's existence through every course listing.
 */
-- Uses the DEFINER helpers rather than reading `curricula` directly.
--
-- A trigger function runs as the INVOKER, so a direct read here would be
-- subject to `curricula_select` — and would then refuse a perfectly legitimate
-- course because the author happens not to be able to SEE the global subject
-- (an unpublished one, say). Visibility is the policy layer's question. This
-- trigger answers a structural one — "do these two rows belong together?" — and
-- must answer it the same way for everybody.
CREATE FUNCTION course_curriculum_is_in_scope() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  curriculum_org uuid := app_curriculum_organization(NEW.curriculum_id);
  is_global boolean := app_curriculum_is_global(NEW.curriculum_id);
BEGIN
  IF curriculum_org IS NULL AND NOT is_global THEN
    -- `app_curriculum_organization` answers NULL for both "global" and "no such
    -- row"; `app_curriculum_is_global` separates the two.
    RAISE EXCEPTION 'Unknown curriculum' USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT is_global AND curriculum_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'A course may only use the global catalog or its own organization''s curricula'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- A GLOBAL course may not depend on any organization's private subject: the
  -- global catalog must stand on its own, or deleting a school would orphan it.
  IF NEW.organization_id IS NULL AND NOT is_global THEN
    RAISE EXCEPTION 'A global course may only use a global curriculum'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER curricula_lifecycle     BEFORE UPDATE ON curricula    FOR EACH ROW EXECUTE FUNCTION content_lifecycle_guard();
CREATE TRIGGER courses_lifecycle       BEFORE UPDATE ON courses      FOR EACH ROW EXECUTE FUNCTION content_lifecycle_guard();
CREATE TRIGGER course_units_lifecycle  BEFORE UPDATE ON course_units FOR EACH ROW EXECUTE FUNCTION content_lifecycle_guard();
CREATE TRIGGER lessons_lifecycle       BEFORE UPDATE ON lessons      FOR EACH ROW EXECUTE FUNCTION content_lifecycle_guard();

CREATE TRIGGER curricula_ownership     BEFORE UPDATE ON curricula    FOR EACH ROW EXECUTE FUNCTION content_ownership_is_immutable();
CREATE TRIGGER courses_ownership       BEFORE UPDATE ON courses      FOR EACH ROW EXECUTE FUNCTION content_ownership_is_immutable();
CREATE TRIGGER course_units_ownership  BEFORE UPDATE ON course_units FOR EACH ROW EXECUTE FUNCTION content_ownership_is_immutable();
CREATE TRIGGER lessons_ownership       BEFORE UPDATE ON lessons      FOR EACH ROW EXECUTE FUNCTION content_ownership_is_immutable();

CREATE TRIGGER courses_curriculum_scope
  BEFORE INSERT OR UPDATE ON courses
  FOR EACH ROW EXECUTE FUNCTION course_curriculum_is_in_scope();

-- =====================================================================
-- Row-Level Security
-- =====================================================================
-- The shape repeats at every level of the tree, so it is stated once here:
--
--   READ  = a platform operator
--         | published content in a catalog the actor can see
--         | any content in the actor's OWN organization, if they may author
--           OR publish content there
--   WRITE = the same editorial branch, and nothing else
--
-- "May author or publish" rather than "may author", because a reviewer whose
-- only permission is `content:publish` still has to READ a draft in order to
-- decide about it. Which of the two permissions lets them change WHICH columns
-- is settled by `content_lifecycle_guard`, not here — a policy sees only the
-- new row and cannot tell what moved.
--
-- Two consequences worth naming. A student holds neither permission, so draft
-- and archived content is invisible to them — not merely unlisted. And an
-- organization's editors never match the global catalog's write branch, so "a
-- teacher edits a global course" has no expressible path.
-- =====================================================================

-- ---------------------------------------------------------------------
-- education_levels — readable by everyone, written by platform operators
-- ---------------------------------------------------------------------
-- Grade names are not sensitive and every catalog listing needs them. Making
-- them writable per-organization would fork the vocabulary that makes content
-- shareable between schools, so writes are deliberately central.
CREATE POLICY education_levels_select ON education_levels FOR SELECT TO edu_app
  USING (app_current_actor() IS NOT NULL);

CREATE POLICY education_levels_insert ON education_levels FOR INSERT TO edu_app
  WITH CHECK (app_actor_is_platform_operator());

CREATE POLICY education_levels_update ON education_levels FOR UPDATE TO edu_app
  USING (app_actor_is_platform_operator())
  WITH CHECK (app_actor_is_platform_operator());

GRANT SELECT, INSERT, UPDATE ON education_levels TO edu_app;

-- ---------------------------------------------------------------------
-- curricula
-- ---------------------------------------------------------------------
CREATE POLICY curricula_select ON curricula FOR SELECT TO edu_app
  USING (
    app_actor_is_platform_operator()
    OR (status = 'published' AND (organization_id IS NULL OR organization_id = app_actor_organization()))
    OR (
      organization_id IS NOT NULL
      AND organization_id = app_actor_organization()
      AND (app_actor_authors_content() OR app_actor_publishes_content())
    )
  );

-- Content is always born a DRAFT, and always attributed to its actual author.
-- Both are pinned in the WITH CHECK rather than trusted from the statement, so
-- an INSERT cannot assert its own publication or somebody else's authorship.
CREATE POLICY curricula_insert ON curricula FOR INSERT TO edu_app
  WITH CHECK (
    status = 'draft'
    AND created_by = app_current_actor()
    AND (
      (organization_id IS NOT NULL AND organization_id = app_actor_organization() AND app_actor_authors_content())
      OR (organization_id IS NULL AND app_actor_is_platform_operator())
    )
  );

-- UPDATE admits EITHER authority — writing content or moving its lifecycle —
-- because a policy cannot tell which columns changed. `content_lifecycle_guard`
-- makes that distinction, so a reviewer who may publish still cannot rewrite
-- the text, and an author who may write still cannot publish.
CREATE POLICY curricula_update ON curricula FOR UPDATE TO edu_app
  USING (
    (organization_id IS NOT NULL AND organization_id = app_actor_organization()
      AND (app_actor_authors_content() OR app_actor_publishes_content()))
    OR (organization_id IS NULL AND app_actor_is_platform_operator())
  )
  WITH CHECK (
    (organization_id IS NOT NULL AND organization_id = app_actor_organization()
      AND (app_actor_authors_content() OR app_actor_publishes_content()))
    OR (organization_id IS NULL AND app_actor_is_platform_operator())
  );

-- DELETE is confined to drafts. Published content has been seen by students and
-- may be referenced elsewhere; the supported way to remove it is to archive it,
-- which keeps the record. A never-published draft has no such history.
CREATE POLICY curricula_delete ON curricula FOR DELETE TO edu_app
  USING (
    status = 'draft'
    AND (
      (organization_id IS NOT NULL AND organization_id = app_actor_organization() AND app_actor_authors_content())
      OR (organization_id IS NULL AND app_actor_is_platform_operator())
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON curricula TO edu_app;

-- ---------------------------------------------------------------------
-- courses
-- ---------------------------------------------------------------------
CREATE POLICY courses_select ON courses FOR SELECT TO edu_app
  USING (
    app_actor_is_platform_operator()
    OR (status = 'published' AND (organization_id IS NULL OR organization_id = app_actor_organization()))
    OR (
      organization_id IS NOT NULL
      AND organization_id = app_actor_organization()
      AND (app_actor_authors_content() OR app_actor_publishes_content())
    )
  );

CREATE POLICY courses_insert ON courses FOR INSERT TO edu_app
  WITH CHECK (
    status = 'draft'
    AND created_by = app_current_actor()
    AND (
      (organization_id IS NOT NULL AND organization_id = app_actor_organization() AND app_actor_authors_content())
      OR (organization_id IS NULL AND app_actor_is_platform_operator())
    )
  );

CREATE POLICY courses_update ON courses FOR UPDATE TO edu_app
  USING (
    (organization_id IS NOT NULL AND organization_id = app_actor_organization()
      AND (app_actor_authors_content() OR app_actor_publishes_content()))
    OR (organization_id IS NULL AND app_actor_is_platform_operator())
  )
  WITH CHECK (
    (organization_id IS NOT NULL AND organization_id = app_actor_organization()
      AND (app_actor_authors_content() OR app_actor_publishes_content()))
    OR (organization_id IS NULL AND app_actor_is_platform_operator())
  );

CREATE POLICY courses_delete ON courses FOR DELETE TO edu_app
  USING (
    status = 'draft'
    AND (
      (organization_id IS NOT NULL AND organization_id = app_actor_organization() AND app_actor_authors_content())
      OR (organization_id IS NULL AND app_actor_is_platform_operator())
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON courses TO edu_app;

-- ---------------------------------------------------------------------
-- course_units — authority is inherited from the course, never re-derived
-- ---------------------------------------------------------------------
-- Every branch below asks about `course_id` through a definer helper. That is
-- what keeps the policy graph acyclic AND what guarantees a unit can never be
-- more visible than the course it belongs to.
CREATE POLICY course_units_select ON course_units FOR SELECT TO edu_app
  USING (
    app_actor_is_platform_operator()
    OR (
      status = 'published'
      AND app_course_status(course_id) = 'published'
      AND (app_course_is_global(course_id) OR app_course_organization(course_id) = app_actor_organization())
    )
    OR (
      NOT app_course_is_global(course_id)
      AND app_course_organization(course_id) = app_actor_organization()
      AND (app_actor_authors_content() OR app_actor_publishes_content())
    )
  );

CREATE POLICY course_units_insert ON course_units FOR INSERT TO edu_app
  WITH CHECK (
    status = 'draft'
    AND created_by = app_current_actor()
    AND (
      (NOT app_course_is_global(course_id)
        AND app_course_organization(course_id) = app_actor_organization()
        AND app_actor_authors_content())
      OR (app_course_is_global(course_id) AND app_actor_is_platform_operator())
    )
  );

CREATE POLICY course_units_update ON course_units FOR UPDATE TO edu_app
  USING (
    (NOT app_course_is_global(course_id)
      AND app_course_organization(course_id) = app_actor_organization()
      AND (app_actor_authors_content() OR app_actor_publishes_content()))
    OR (app_course_is_global(course_id) AND app_actor_is_platform_operator())
  )
  WITH CHECK (
    (NOT app_course_is_global(course_id)
      AND app_course_organization(course_id) = app_actor_organization()
      AND (app_actor_authors_content() OR app_actor_publishes_content()))
    OR (app_course_is_global(course_id) AND app_actor_is_platform_operator())
  );

CREATE POLICY course_units_delete ON course_units FOR DELETE TO edu_app
  USING (
    status = 'draft'
    AND (
      (NOT app_course_is_global(course_id)
        AND app_course_organization(course_id) = app_actor_organization()
        AND app_actor_authors_content())
      OR (app_course_is_global(course_id) AND app_actor_is_platform_operator())
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON course_units TO edu_app;

-- ---------------------------------------------------------------------
-- lessons — authority inherited from the unit, and through it the course
-- ---------------------------------------------------------------------
CREATE POLICY lessons_select ON lessons FOR SELECT TO edu_app
  USING (
    app_actor_is_platform_operator()
    OR (
      status = 'published'
      AND app_unit_chain_published(unit_id)
      AND (
        app_course_is_global(app_unit_course(unit_id))
        OR app_course_organization(app_unit_course(unit_id)) = app_actor_organization()
      )
    )
    OR (
      NOT app_course_is_global(app_unit_course(unit_id))
      AND app_course_organization(app_unit_course(unit_id)) = app_actor_organization()
      AND (app_actor_authors_content() OR app_actor_publishes_content())
    )
  );

CREATE POLICY lessons_insert ON lessons FOR INSERT TO edu_app
  WITH CHECK (
    status = 'draft'
    AND created_by = app_current_actor()
    AND (
      (NOT app_course_is_global(app_unit_course(unit_id))
        AND app_course_organization(app_unit_course(unit_id)) = app_actor_organization()
        AND app_actor_authors_content())
      OR (app_course_is_global(app_unit_course(unit_id)) AND app_actor_is_platform_operator())
    )
  );

CREATE POLICY lessons_update ON lessons FOR UPDATE TO edu_app
  USING (
    (NOT app_course_is_global(app_unit_course(unit_id))
      AND app_course_organization(app_unit_course(unit_id)) = app_actor_organization()
      AND (app_actor_authors_content() OR app_actor_publishes_content()))
    OR (app_course_is_global(app_unit_course(unit_id)) AND app_actor_is_platform_operator())
  )
  WITH CHECK (
    (NOT app_course_is_global(app_unit_course(unit_id))
      AND app_course_organization(app_unit_course(unit_id)) = app_actor_organization()
      AND (app_actor_authors_content() OR app_actor_publishes_content()))
    OR (app_course_is_global(app_unit_course(unit_id)) AND app_actor_is_platform_operator())
  );

CREATE POLICY lessons_delete ON lessons FOR DELETE TO edu_app
  USING (
    status = 'draft'
    AND (
      (NOT app_course_is_global(app_unit_course(unit_id))
        AND app_course_organization(app_unit_course(unit_id)) = app_actor_organization()
        AND app_actor_authors_content())
      OR (app_course_is_global(app_unit_course(unit_id)) AND app_actor_is_platform_operator())
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON lessons TO edu_app;

-- =====================================================================
-- Permissions
-- =====================================================================
-- `content:author` and `content:publish` are deliberately separate. An author
-- writes; making the work visible to students is an editorial decision, and the
-- two being one permission is how unreviewed material reaches a classroom.
-- =====================================================================
-- Seeding reference data needs an owner INSERT path: `FORCE ROW LEVEL SECURITY`
-- binds `edu_migrator` too, and 0010 gave these tables SELECT policies only.
--
-- This does NOT widen what the application can do. `edu_app` holds no INSERT
-- privilege on either table (0007 grants it SELECT and nothing else), and a
-- policy cannot grant a privilege that was never granted. The reachable set of
-- writers here remains "whoever runs migrations".
CREATE POLICY permissions_definer_insert ON permissions
  FOR INSERT TO edu_migrator WITH CHECK (true);
CREATE POLICY role_permissions_definer_insert ON role_permissions
  FOR INSERT TO edu_migrator WITH CHECK (true);

INSERT INTO permissions (name, resource, action, description) VALUES
  ('content:author',  'content', 'author',  'Create and edit draft educational content in scope.'),
  ('content:publish', 'content', 'publish', 'Move educational content through its lifecycle.');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE (r.name = 'content_author' AND p.name IN ('content:author'))
   OR (r.name = 'teacher'        AND p.name IN ('content:author'))
   OR (r.name = 'reviewer'       AND p.name IN ('content:publish'))
   OR (r.name = 'admin'          AND p.name IN ('content:author', 'content:publish'));

-- The `content:publish` grant to `security_admin` is deliberately ABSENT.
-- That role administers accounts and lockouts; giving it editorial control over
-- what students read would merge two unrelated authorities in one compromise.
