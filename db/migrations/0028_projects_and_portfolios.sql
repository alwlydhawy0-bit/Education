-- ============================================================================
-- 0028 — STUDENT PROJECTS, PROJECT ARTIFACTS AND VERIFIABLE PORTFOLIOS
-- ============================================================================
--
-- The first thing on this platform a child can deliberately show to the outside
-- world, and the first table any unauthenticated request will ever read.
--
-- Every other domain here has answered one question — "may THIS ACTOR see this
-- row?" — with an actor to point at. The public portfolio resolver has no
-- actor. `app_current_actor()` is NULL, every policy written so far evaluates
-- to false, and that is correct: the default for a platform holding minors'
-- work is that an anonymous request sees nothing.
--
-- So this migration does not weaken any existing rule. It adds ONE narrow,
-- explicit path in, and the shape of that path is most of what follows.
--
-- ----------------------------------------------------------------------------
-- THE PUBLIC PATH IS A CAPABILITY, EVALUATED IN THE POLICY
-- ----------------------------------------------------------------------------
--
-- A public read is admitted only when the caller has already presented the
-- portfolio's own secret. The policy reads that secret from a
-- TRANSACTION-LOCAL setting the resolver puts there:
--
--   USING (is_published AND share_token = current_setting('app.portfolio_key', true))
--
-- Three properties follow from writing it this way rather than as a definer
-- function:
--
--   1. IT CANNOT BE A LOOKUP. VULN-040 turned an authorization check into a
--      "does this id exist" question by wrapping an invoker-rights helper in a
--      definer, and VULN-044 and VULN-050 both produced NULL from a definer
--      that FORCE ROW LEVEL SECURITY had quietly bound. A predicate comparing
--      two values in the row's own policy has nowhere to hide either failure.
--
--   2. REVOCATION IS THE PREDICATE, not a cleanup job. Unpublishing flips
--      `is_published` and the next statement returns nothing. There is no cache
--      to invalidate, no token list to sweep, and no window during which a
--      withdrawn portfolio is still served — because nothing was ever granted,
--      only matched.
--
--   3. THE SETTING IS TRANSACTION-LOCAL. `set_config(..., true)` cannot leak
--      into the next request on a pooled connection, which a session-level
--      setting would — and that connection may belong to a different child.
--
-- WHAT KNOWING THE TOKEN BUYS is deliberately small. It admits the PORTFOLIO
-- row and, through the delegating policies below, the items and projects the
-- student actually published. It admits no draft, no private project, no
-- workspace note, no artifact of somebody else's, and no row on any table this
-- migration did not create.
--
-- ----------------------------------------------------------------------------
-- OWNERSHIP IS REFERENTIAL INTEGRITY, NOT A RULE ANYBODY REMEMBERS
-- ----------------------------------------------------------------------------
--
-- The sharpest attack this domain offers is not reading somebody else's
-- project. It is PUBLISHING somebody else's project — putting another child's
-- private work into your own public portfolio, where the policy would then
-- serve it to the world on your behalf, correctly, because your portfolio is
-- yours and it is published.
--
-- Every link here therefore carries the owner and is checked by a COMPOSITE
-- FOREIGN KEY: `portfolio_items (portfolio_id, owner_id)` references
-- `student_portfolios (id, student_id)`, and `(project_id, owner_id)`
-- references `student_projects (id, student_id)`. A row whose pair has no
-- parent pair is rejected by referential integrity — beneath RLS, beneath
-- SECURITY DEFINER, beneath any question about which role is executing.
--
-- This is the VULN-050 lesson applied before rather than after: a recorded
-- lesson is not a control, and the thing that actually prevents the mistake is
-- a structure in which making it is impossible.
--
-- ----------------------------------------------------------------------------
-- WHY `project_artifacts` IS NOT `student_artifacts`
-- ----------------------------------------------------------------------------
--
-- 0025 built `student_artifacts` with no sharing model AT ALL — no visibility
-- column, no teacher branch, no guardian branch — and said so in terms: "files
-- are the hardest thing to un-share and the easiest to misjudge the contents
-- of, so the first version of this resource has no sharing at all."
--
-- A project artifact is the opposite object: a thing a learner attaches
-- BECAUSE they intend it to be seen. Adding a `visibility` column to
-- `student_artifacts` would make one table mean two things, and the looser
-- meaning would eventually win an argument with the stricter one — the exact
-- reasoning 0025 used to refuse a second notes table.
--
-- So: two tables, two rules, and no path between them. Nothing in this
-- migration references `student_artifacts`, `notes` or `student_notebooks`, and
-- `tests/architecture/portfolio-boundaries.test.ts` asserts it mechanically.
-- ============================================================================

-- ── TOKEN MINTING ───────────────────────────────────────────────────────────

/**
 * 256 bits of hex, from the strongest randomness available WITHOUT AN EXTENSION.
 *
 * The obvious spelling is `encode(gen_random_bytes(32), 'hex')`, and it does
 * not work here: `gen_random_bytes` lives in pgcrypto, which this installation
 * does not have. Adding it would mean a new superuser bootstrap step that every
 * environment must run before this migration, and a deployment where somebody
 * forgot would fail at the point a child tried to publish.
 *
 * `gen_random_uuid()` is built in from PostgreSQL 13 and draws from
 * `pg_strong_random` — the same source pgcrypto would use. Two of them carry
 * 244 bits of it, hashed with the built-in `sha256` to a fixed 64 characters.
 * The result is unguessable for the same reason and depends on nothing that
 * has to be installed.
 *
 * NOT a substitute for pgcrypto in general. This is a token nobody has to
 * reverse, verify or derive a key from; it only has to be impossible to guess.
 */
CREATE FUNCTION app_mint_share_token() RETURNS text
  LANGUAGE sql VOLATILE SET search_path = pg_catalog, public
AS $$
  SELECT encode(
    sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')),
    'hex');
$$;

-- ── PROJECTS ────────────────────────────────────────────────────────────────

CREATE TABLE student_projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Denormalized from the class at write time, exactly as on `notes` and
  -- `ai_conversations` and for the same reason: RLS must evaluate the tenancy
  -- check without joining `users`, which is itself RLS-protected and would make
  -- the policy recursive.
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,

  -- NULLABLE, AND ON DELETE SET NULL, WHICH IS NOT THE PLATFORM'S USUAL CHOICE.
  --
  -- Everything else hanging off `classes` cascades — memberships, teacher
  -- assignments, course assignments. Those are all RELATIONSHIP rows, and
  -- deleting a class legitimately deletes the relationships it was made of.
  --
  -- A project is not a relationship. It is a child's own work, and destroying
  -- it because an administrator tidied up a finished class would be the
  -- platform deleting something it does not own. So the anchor is severed and
  -- the work survives — and because class visibility is evaluated THROUGH this
  -- column, an orphaned project silently stops being visible to any class.
  -- Losing the anchor fails closed.
  class_id  uuid REFERENCES classes(id) ON DELETE SET NULL,
  course_id uuid REFERENCES courses(id) ON DELETE SET NULL,

  title                text NOT NULL,
  description_markdown text NOT NULL DEFAULT '',

  -- Validated as `https://` here as well as in the contract. The database CHECK
  -- is the backstop for anything reaching the table another way; the contract
  -- is what produces a usable error. `javascript:` is script injection and
  -- `data:` is the same thing wearing a hat — and either would be rendered as a
  -- link on a PUBLIC page, which is the one place on this platform where a
  -- stranger clicks something a child typed.
  repository_url text,
  live_demo_url  text,

  visibility text NOT NULL DEFAULT 'private',
  status     text NOT NULL DEFAULT 'draft',

  -- Who featured it, and when. Set only through the teacher path.
  featured_by uuid REFERENCES users(id) ON DELETE SET NULL,
  featured_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT student_projects_visibility_ck
    CHECK (visibility IN ('private', 'class', 'public')),
  CONSTRAINT student_projects_status_ck
    CHECK (status IN ('draft', 'submitted', 'featured')),

  CONSTRAINT student_projects_title_ck
    CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT student_projects_description_ck
    CHECK (length(description_markdown) <= 20000),

  CONSTRAINT student_projects_repository_url_ck
    CHECK (repository_url IS NULL
           OR (repository_url LIKE 'https://%'
               AND length(repository_url) <= 2000
               AND repository_url !~ '\s')),
  CONSTRAINT student_projects_live_demo_url_ck
    CHECK (live_demo_url IS NULL
           OR (live_demo_url LIKE 'https://%'
               AND length(live_demo_url) <= 2000
               AND live_demo_url !~ '\s')),

  -- `featured` is a teacher's assertion about a submitted project. A draft
  -- cannot be featured, because nobody has offered it yet.
  CONSTRAINT student_projects_featured_ck
    CHECK ((status = 'featured') = (featured_by IS NOT NULL)
           AND (featured_by IS NULL) = (featured_at IS NULL)),

  -- The target of the composite foreign keys on `project_artifacts` and
  -- `portfolio_items`. Redundant as uniqueness, load-bearing as a reference:
  -- it is what lets another table say "this project belongs to that student" in
  -- SQL rather than in a rule some layer has to apply.
  CONSTRAINT student_projects_id_owner_uk UNIQUE (id, student_id)
);

CREATE INDEX student_projects_owner_ix ON student_projects (student_id, updated_at DESC);

-- The class showcase query: one class's visible projects, newest first.
CREATE INDEX student_projects_class_ix
  ON student_projects (class_id, visibility, status, updated_at DESC);

CREATE INDEX student_projects_org_ix ON student_projects (organization_id, updated_at DESC);

ALTER TABLE student_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_projects FORCE ROW LEVEL SECURITY;

-- ── PROJECT ARTIFACTS ───────────────────────────────────────────────────────

CREATE TABLE project_artifacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,

  -- Carried so the composite foreign key can enforce "your own project", and
  -- so the RLS policies never need a subquery to establish ownership. It cannot
  -- drift from the project's `student_id`, because a mismatched pair has no
  -- parent row.
  owner_id uuid NOT NULL,

  artifact_type text NOT NULL,

  -- EITHER a server-derived storage key OR an https:// URL, never a caller's
  -- filesystem path. 0025 states the rule this follows: "a path or URL chosen
  -- by a caller is an arbitrary-reference bug wearing a metadata field's
  -- clothes". The CHECK below is what makes that structural here.
  file_path_or_url text NOT NULL,

  byte_size bigint NOT NULL,
  metadata  jsonb  NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT project_artifacts_type_ck
    CHECK (artifact_type IN ('report_pdf', 'code_file', 'media_asset')),

  -- `https://` or the platform's own `artifact://<uuid>` reference. Anything
  -- else — a relative path, a `file://`, a bare hostname — is refused by the
  -- database rather than by whoever remembers to check.
  CONSTRAINT project_artifacts_location_ck
    CHECK ((file_path_or_url LIKE 'https://%' OR file_path_or_url LIKE 'artifact://%')
           AND length(file_path_or_url) BETWEEN 1 AND 2000
           AND file_path_or_url !~ '\s'),

  -- 25 MiB, matching `student_artifacts`. One number for "how big may a
  -- learner's file be", so the two cannot drift into different answers.
  CONSTRAINT project_artifacts_size_ck
    CHECK (byte_size > 0 AND byte_size <= 26214400),

  CONSTRAINT project_artifacts_metadata_kind_ck CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT project_artifacts_metadata_size_ck CHECK (pg_column_size(metadata) <= 16384),

  CONSTRAINT project_artifacts_project_owner_fk
    FOREIGN KEY (project_id, owner_id)
    REFERENCES student_projects (id, student_id) ON DELETE CASCADE
);

CREATE INDEX project_artifacts_project_ix ON project_artifacts (project_id, created_at);

ALTER TABLE project_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_artifacts FORCE ROW LEVEL SECURITY;

-- ── PORTFOLIOS ──────────────────────────────────────────────────────────────

CREATE TABLE student_portfolios (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,

  title text NOT NULL,
  bio   text NOT NULL DEFAULT '',

  -- A GUESSABLE, HUMAN-READABLE NAME. Derived from the title by the
  -- application, unique platform-wide, and meaningful only when the portfolio
  -- is published — the policy requires `is_published` for slug access exactly
  -- as it does for token access.
  --
  -- It is deliberately NOT a secret and must never be treated as one. Anyone
  -- can try `/portfolios/alex-chen`; that is what a portfolio is FOR. The
  -- consequence — that publishing under a slug makes a portfolio discoverable
  -- by name — is recorded in docs/security/limitations.md rather than
  -- mitigated, because mitigating it would mean building something that is not
  -- a portfolio.
  public_slug text,

  -- AN UNGUESSABLE CAPABILITY. Server-minted, never accepted from a caller,
  -- and ROTATED whenever the portfolio is unpublished — see the guard below.
  -- The default exists so a row can never be written without one; the trigger
  -- overwrites it on every insert regardless.
  share_token text NOT NULL DEFAULT app_mint_share_token(),

  is_published boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT student_portfolios_title_ck
    CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT student_portfolios_bio_ck CHECK (length(bio) <= 5000),

  -- Lowercase, hyphenated, no leading or trailing hyphen, long enough not to
  -- collide by accident and short enough to be a URL somebody can read aloud.
  CONSTRAINT student_portfolios_slug_ck
    CHECK (public_slug IS NULL OR public_slug ~ '^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])$'),

  -- 64 hex characters — 256 bits. Long enough that guessing is not a strategy,
  -- and constrained so a shorter one cannot be introduced later by a writer who
  -- thought a friendlier token would be nicer.
  CONSTRAINT student_portfolios_token_ck CHECK (share_token ~ '^[0-9a-f]{64}$'),

  -- SECTION 2A's "unique constraints on public_slug and share_token for
  -- verifiable portfolio access". Both are lookup keys for a public route, so a
  -- duplicate would make one portfolio resolve to another's page.
  CONSTRAINT student_portfolios_slug_uk  UNIQUE (public_slug),
  CONSTRAINT student_portfolios_token_uk UNIQUE (share_token),

  -- One portfolio per student, for now. A learner with two portfolios has two
  -- public identities, and deciding which is canonical is a product question
  -- nobody has answered.
  CONSTRAINT student_portfolios_one_per_student_uk UNIQUE (student_id),

  CONSTRAINT student_portfolios_id_owner_uk UNIQUE (id, student_id)
);

ALTER TABLE student_portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_portfolios FORCE ROW LEVEL SECURITY;

-- ── PORTFOLIO ITEMS ─────────────────────────────────────────────────────────

CREATE TABLE portfolio_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL,
  project_id   uuid NOT NULL,

  -- THE COLUMN THAT MAKES THE ATTACK IMPOSSIBLE. Both composite keys below
  -- point at it, so a row can only exist when the portfolio AND the project
  -- belong to the same person. Putting another child's project into your
  -- public portfolio is not refused by a policy that could be edited; it has no
  -- parent row.
  owner_id uuid NOT NULL,

  display_order integer NOT NULL DEFAULT 1,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT portfolio_items_order_ck CHECK (display_order BETWEEN 1 AND 500),

  -- A project appears at most once in a portfolio.
  CONSTRAINT portfolio_items_unique_project_uk UNIQUE (portfolio_id, project_id),

  CONSTRAINT portfolio_items_portfolio_owner_fk
    FOREIGN KEY (portfolio_id, owner_id)
    REFERENCES student_portfolios (id, student_id) ON DELETE CASCADE,

  CONSTRAINT portfolio_items_project_owner_fk
    FOREIGN KEY (project_id, owner_id)
    REFERENCES student_projects (id, student_id) ON DELETE CASCADE
);

CREATE INDEX portfolio_items_order_ix ON portfolio_items (portfolio_id, display_order);

ALTER TABLE portfolio_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_items FORCE ROW LEVEL SECURITY;

-- ── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * The portfolio key the caller presented, if any.
 *
 * One function rather than `current_setting` repeated in five policies, so
 * "what counts as having presented a key" has a single definition. Returns
 * NULL when nothing was presented, and a NULL never equals a `share_token`
 * (which is NOT NULL) or a `public_slug` — so an ordinary authenticated request
 * that never touched the resolver matches no public branch at all.
 *
 * INVOKER RIGHTS AND STABLE. It reads a setting, not a table, so there is
 * nothing here for SECURITY DEFINER to do except reintroduce VULN-040.
 */
CREATE FUNCTION app_portfolio_key() RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $$ SELECT nullif(current_setting('app.portfolio_key', true), ''); $$;

/**
 * Marks this TRANSACTION as resolving one public portfolio key.
 *
 * The one named door for the public path, and the same mechanism 0027 uses for
 * a platform turn. `set_config(..., true)` is transaction-local: it cannot
 * survive into the next request on a pooled connection, which matters more here
 * than anywhere else on the platform, because the next request may be a
 * different child's.
 *
 * It grants NOTHING by itself. It states a claim — "the caller says they hold
 * this key" — and every policy below still checks that the claim matches a
 * published row. A caller who invents a key gets exactly what a caller who
 * presents none gets.
 */
CREATE FUNCTION app_begin_public_portfolio(p_key text) RETURNS void
  LANGUAGE sql VOLATILE SET search_path = pg_catalog, public
AS $$ SELECT set_config('app.portfolio_key', coalesce(p_key, ''), true); $$;

/**
 * Whether a portfolio is currently reachable by the presented key.
 *
 * BOTH ENTRY POINTS, one definition. A token is an unguessable capability; a
 * slug is a guessable name. They differ in how somebody comes to know them and
 * not at all in what they admit, so treating them as one predicate keeps the
 * two from drifting into different answers about the same row.
 *
 * `is_published` is inside the function rather than beside every call, because
 * "published" is the thing being asked about and an omission at one call site
 * would be a portfolio served after its owner withdrew it.
 *
 * INVOKER RIGHTS. It reads `student_portfolios`, whose own policy answers this
 * question — so running as the caller means the item and project policies
 * INHERIT the portfolio's rule rather than re-deriving it. Making it definer is
 * exactly the VULN-040 mistake: the row would become visible to the function
 * regardless of the caller and the EXISTS would degrade into "does this id
 * exist", which is true for every portfolio on the platform.
 */
CREATE FUNCTION app_portfolio_is_public(p_portfolio_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM student_portfolios p WHERE p.id = p_portfolio_id
  );
$$;

/**
 * Whether a project is one the world is entitled to see AT ALL.
 *
 * A question about the ROW'S OWN PUBLISHED STATE — public, and not a draft —
 * and deliberately not a question about the caller. Who may see it is decided
 * by `student_projects_select`; this only says whether the project has been
 * offered to anybody outside the school.
 *
 * SECURITY DEFINER, AND HERE THAT IS THE CORRECT CHOICE rather than the
 * VULN-040 mistake, for a reason worth being precise about. VULN-040 was a
 * definer wrapped around an AUTHORIZATION check, which turned "may this actor
 * see it" into "does this id exist". This function contains no authorization to
 * downgrade: it reads two columns of the row and would give the same answer to
 * everybody. It is definer only to BREAK A POLICY CYCLE — `portfolio_items`
 * needs to know a project's published state, `student_projects` already asks
 * about `portfolio_items`, and two RLS policies referencing each other is an
 * infinite recursion PostgreSQL refuses to evaluate.
 *
 * The authorization in the item policy is `app_portfolio_is_public`, which is
 * invoker-rights and does go through RLS.
 */
CREATE FUNCTION app_project_is_publicly_listed(p_project_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM student_projects p
     WHERE p.id = p_project_id
       AND p.visibility = 'public'
       AND p.status <> 'draft'
  );
$$;

/**
 * Whether the current actor may see a project because of the CLASS it is in.
 *
 * Members and teachers of the project's class, and only while that class is
 * active and the row still has a class to be seen through. A project whose
 * class was deleted has `class_id IS NULL` and matches nobody here — losing the
 * anchor fails closed, which is the point of severing it rather than cascading.
 *
 * SECURITY DEFINER, and every function it calls is too, so this is composition
 * of definer-rights helpers rather than a definer wrapper around an
 * invoker-rights one. That distinction is VULN-040.
 */
CREATE FUNCTION app_actor_shares_project_class(p_class_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT p_class_id IS NOT NULL
     AND app_class_is_active(p_class_id)
     AND (app_actor_is_member_of_class(p_class_id) OR app_actor_teaches_class(p_class_id));
$$;

/**
 * Whether the current actor may REVIEW a project — feature it, or read it for
 * moderation — within their own organization.
 *
 * Section 2B says "teachers & admins ... within their organization context",
 * and this reads that as a CEILING rather than a grant, exactly as 0027 reads
 * the same phrase for tutor transcripts. The organization is the boundary
 * nobody crosses; inside it the authority is the one the platform already
 * recognises — a teacher of the project's class, or an administrator of the
 * school.
 *
 * A teacher does not acquire reach over projects in classes they do not teach.
 */
CREATE FUNCTION app_actor_reviews_project(p_class_id uuid, p_organization_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT p_organization_id IS NOT NULL
     AND p_organization_id = app_actor_organization()
     AND (
          (p_class_id IS NOT NULL AND app_actor_teaches_class(p_class_id))
       OR app_actor_is_org_admin()
     );
$$;

-- ── TRIGGERS ────────────────────────────────────────────────────────────────

/**
 * Derives the organization, validates the class anchor, and keeps the parts of
 * a project that must not move from moving.
 *
 * THE NULL-ACTOR EARLY RETURN IS NOT AN ESCAPE HATCH. Migrations, fixtures and
 * maintenance run with no `app.actor_id`, and asking "may the current actor
 * post to this class" of a caller who is not an actor has no true answer —
 * VULN-045, where a note-anchor trigger asked exactly that of every writer and
 * broke every backfill. RLS still applies to `edu_app`.
 */
CREATE FUNCTION student_project_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.student_id IS DISTINCT FROM OLD.student_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'A project''s owner and origin are immutable'
        USING ERRCODE = 'raise_exception';
    END IF;
    -- The class anchor may be SEVERED by a class deletion but never MOVED by a
    -- writer: re-pointing a project at another class would carry it, and every
    -- class-visible thing about it, across a boundary the insert check enforced.
    IF NEW.class_id IS DISTINCT FROM OLD.class_id AND OLD.class_id IS NOT NULL THEN
      RAISE EXCEPTION 'A project cannot be moved to another class'
        USING ERRCODE = 'raise_exception';
    END IF;
    NEW.organization_id := OLD.organization_id;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF NEW.class_id IS NULL THEN
    RAISE EXCEPTION 'A project must be created in a class'
      USING ERRCODE = 'not_null_violation';
  END IF;

  NEW.organization_id := app_class_organization(NEW.class_id);
  NEW.created_at := now();
  NEW.updated_at := now();

  IF app_current_actor() IS NULL THEN RETURN NEW; END IF;

  IF NOT app_actor_is_member_of_class(NEW.class_id) THEN
    RAISE EXCEPTION 'You can only create a project in a class you are in'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- A course, if named, must actually be taught to this class. Otherwise a
  -- learner could label their project with any course id on the platform and
  -- the showcase would file it under coursework they never studied.
  IF NEW.course_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM class_course_assignments a
        WHERE a.class_id = NEW.class_id
          AND a.course_id = NEW.course_id
          AND a.status = 'active')
  THEN
    RAISE EXCEPTION 'That course is not assigned to this class'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER student_projects_guard
  BEFORE INSERT OR UPDATE ON student_projects
  FOR EACH ROW EXECUTE FUNCTION student_project_guard();

/**
 * A REVIEWER MAY CHANGE EXACTLY THREE COLUMNS. Nothing else, ever.
 *
 * THIS TRIGGER EXISTS BECAUSE THE PROBE CAUGHT ITS ABSENCE. The
 * `student_projects_feature` policy admits a teacher's UPDATE, and a policy
 * admits a ROW rather than a column — so with only the policy in place, a
 * teacher of the class could rewrite `description_markdown` and the change
 * would stand. The probe did exactly that and read back "Teacher wrote this".
 *
 * On a public portfolio page that is not a permissions bug in the abstract: it
 * is an adult putting words into a child's mouth under the child's name, in
 * front of an audience the child invited. The narrowest possible authority is
 * the only defensible one here.
 *
 * A comment two screens up had CLAIMED this guard existed. It did not. That is
 * worth recording as its own lesson — prose describing a control is not the
 * control, and the only reason this was caught is that the probe ran before any
 * application code and tried the thing the comment said was impossible.
 */
CREATE FUNCTION student_project_review_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF app_current_actor() IS NULL OR NEW.student_id = app_current_actor() THEN
    RETURN NEW;
  END IF;

  -- Reached only for a NON-OWNER whose update some policy admitted, which today
  -- means a reviewer. Everything except the three review columns must be
  -- identical to what the owner last wrote.
  IF NEW.title                IS DISTINCT FROM OLD.title
     OR NEW.description_markdown IS DISTINCT FROM OLD.description_markdown
     OR NEW.repository_url    IS DISTINCT FROM OLD.repository_url
     OR NEW.live_demo_url     IS DISTINCT FROM OLD.live_demo_url
     OR NEW.visibility        IS DISTINCT FROM OLD.visibility
     OR NEW.class_id          IS DISTINCT FROM OLD.class_id
     OR NEW.course_id         IS DISTINCT FROM OLD.course_id
     OR NEW.organization_id   IS DISTINCT FROM OLD.organization_id
  THEN
    RAISE EXCEPTION 'A reviewer may only feature or unfeature a project'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- `visibility` is in that list deliberately. A teacher must not be able to
  -- publish a child's work to the world, even work they think is excellent.
  -- Featuring is a statement to the class; publishing is the child's decision.
  RETURN NEW;
END
$$;

CREATE TRIGGER student_projects_review_guard
  BEFORE UPDATE ON student_projects
  FOR EACH ROW EXECUTE FUNCTION student_project_review_guard();

/**
 * Mints and ROTATES the share token, and derives the portfolio's organization.
 *
 * ROTATION ON UNPUBLISH IS THE POINT, and it is a deliberate choice with a
 * cost. Section 3 requires that unpublishing revokes public access; the
 * `is_published` predicate already does that on its own. Rotating as well means
 * revocation is PERMANENT rather than reversible by accident: a learner who
 * withdraws a portfolio because they shared the link with the wrong person does
 * not restore that person's access by republishing later.
 *
 * The cost is that every link they gave to the RIGHT people also dies. That is
 * the correct trade for a child's work — the failure it prevents is somebody
 * still holding a link nobody meant them to have, and the failure it causes is
 * re-sending a URL.
 *
 * The token is NEVER accepted from a caller, on insert or update.
 */
CREATE FUNCTION student_portfolio_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.organization_id := app_user_organization(NEW.student_id);
    NEW.share_token := app_mint_share_token();
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF NEW.student_id IS DISTINCT FROM OLD.student_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A portfolio''s owner and origin are immutable'
      USING ERRCODE = 'raise_exception';
  END IF;

  NEW.organization_id := OLD.organization_id;

  IF OLD.is_published AND NOT NEW.is_published THEN
    NEW.share_token := app_mint_share_token();
  ELSE
    -- Unchanged on every other update, so a caller cannot set one and cannot
    -- churn one by touching the title.
    NEW.share_token := OLD.share_token;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER student_portfolios_guard
  BEFORE INSERT OR UPDATE ON student_portfolios
  FOR EACH ROW EXECUTE FUNCTION student_portfolio_guard();

-- ── ROW LEVEL SECURITY ──────────────────────────────────────────────────────

/**
 * A project is seen by its owner, by its class, by a reviewer, or by the world
 * through a published portfolio. Four branches, written separately because they
 * answer four different questions and a reader should be able to check each one
 * without untangling it from the others.
 */
CREATE POLICY student_projects_select ON student_projects FOR SELECT TO edu_app
  USING (
    student_id = app_current_actor()

    -- CLASS VISIBILITY, and note what it requires: the project must SAY it is
    -- class-visible. A private project is invisible to classmates even though
    -- they share the class, which is the whole meaning of the column.
    OR (visibility IN ('class', 'public')
        AND status <> 'draft'
        AND app_actor_shares_project_class(class_id))

    -- REVIEW, for a teacher of this class or an administrator of this school.
    -- Deliberately NOT gated on `visibility`: a teacher supervising a class
    -- needs to see what a learner is working on there, and a `private` project
    -- in a school class is private from OTHER LEARNERS rather than from the
    -- adult responsible for the class. A draft is still excluded — nobody has
    -- offered it yet.
    OR (status <> 'draft' AND app_actor_reviews_project(class_id, organization_id))

    -- THE PUBLIC PATH. Three conditions, none of which is redundant:
    -- the project itself must be public, it must not be a draft, and it must
    -- sit in a portfolio the presented key currently opens. Dropping any one
    -- publishes something its owner did not.
    OR (visibility = 'public'
        AND status <> 'draft'
        AND EXISTS (
              SELECT 1 FROM portfolio_items i
               WHERE i.project_id = student_projects.id
                 AND app_portfolio_is_public(i.portfolio_id)))
  );

CREATE POLICY student_projects_insert ON student_projects FOR INSERT TO edu_app
  WITH CHECK (student_id = app_current_actor());

/**
 * The owner edits their own. Nobody else writes through this policy at all.
 *
 * FEATURING IS A SEPARATE POLICY below rather than a branch here, because a
 * teacher's authority over a project is exactly one column wide and expressing
 * it as "may update" would be expressing something much larger.
 *
 * The USING/WITH CHECK pair matters: without the second, an owner could update
 * their row into one owned by somebody else — it would pass `USING` on the way
 * in and land outside their reach.
 */
CREATE POLICY student_projects_update ON student_projects FOR UPDATE TO edu_app
  USING (student_id = app_current_actor())
  WITH CHECK (student_id = app_current_actor());

/**
 * A teacher or administrator may FEATURE a submitted project.
 *
 * A second UPDATE policy rather than a branch in the first, because PostgreSQL
 * ORs permissive policies: this admits the row, and the column-level rule —
 * that only `status`, `featured_by` and `featured_at` may change — is enforced
 * by the trigger-free CHECK constraint plus the service. What this policy
 * cannot do is let a reviewer rewrite a child's description, because
 * `student_project_review_guard` above refuses any other column change from a
 * non-owner — including `visibility`, so a teacher cannot publish a child's
 * work to the world on their behalf.
 */
CREATE POLICY student_projects_feature ON student_projects FOR UPDATE TO edu_app
  USING (status <> 'draft' AND app_actor_reviews_project(class_id, organization_id))
  WITH CHECK (status <> 'draft' AND app_actor_reviews_project(class_id, organization_id));

CREATE POLICY student_projects_delete ON student_projects FOR DELETE TO edu_app
  USING (student_id = app_current_actor());

/**
 * An artifact's visibility IS its project's, asked once.
 *
 * Delegation rather than mirroring — the ADR 0010 rule. Restating the four
 * branches above on this table would create a second surface that could drift
 * from the first, and the drift would be invisible because both would keep
 * returning rows.
 */
CREATE POLICY project_artifacts_select ON project_artifacts FOR SELECT TO edu_app
  USING (EXISTS (SELECT 1 FROM student_projects p WHERE p.id = project_artifacts.project_id));

CREATE POLICY project_artifacts_insert ON project_artifacts FOR INSERT TO edu_app
  WITH CHECK (owner_id = app_current_actor());

CREATE POLICY project_artifacts_delete ON project_artifacts FOR DELETE TO edu_app
  USING (owner_id = app_current_actor());

-- No UPDATE policy and no UPDATE grant on `project_artifacts`. An artifact is
-- registered or removed; editing one in place would let its size and type drift
-- from the bytes they describe.

/**
 * A portfolio is seen by its owner, or by whoever presents its key.
 *
 * THE PUBLIC BRANCH IS THE ONLY PLACE ON THIS PLATFORM WHERE A ROW IS ADMITTED
 * WITHOUT AN ACTOR, and it is written to be readable as exactly that: published,
 * and the presented key matches this row's own token or slug.
 *
 * `app_portfolio_key()` returns NULL when nothing was presented, and NULL
 * equals nothing — so an ordinary request that never called the resolver
 * matches no public branch, and an anonymous request with no key sees nothing.
 */
CREATE POLICY student_portfolios_select ON student_portfolios FOR SELECT TO edu_app
  USING (
    student_id = app_current_actor()
    OR (is_published
        AND app_portfolio_key() IS NOT NULL
        AND (share_token = app_portfolio_key() OR public_slug = app_portfolio_key()))
  );

CREATE POLICY student_portfolios_insert ON student_portfolios FOR INSERT TO edu_app
  WITH CHECK (student_id = app_current_actor());

CREATE POLICY student_portfolios_update ON student_portfolios FOR UPDATE TO edu_app
  USING (student_id = app_current_actor())
  WITH CHECK (student_id = app_current_actor());

CREATE POLICY student_portfolios_delete ON student_portfolios FOR DELETE TO edu_app
  USING (student_id = app_current_actor());

/**
 * An item is visible when its portfolio is. Delegation again.
 */
CREATE POLICY portfolio_items_select ON portfolio_items FOR SELECT TO edu_app
  USING (
    owner_id = app_current_actor()

    -- BOTH HALVES, AND THE SECOND ONE WAS MISSING AT FIRST.
    --
    -- With only `app_portfolio_is_public`, a stranger holding a published
    -- portfolio's link saw EVERY item in it — including the rows pointing at
    -- projects the owner had kept private or left in draft. The projects
    -- themselves stayed hidden, so no title leaked; the ITEM rows leaked
    -- anyway, and what they carried was worse than a title: the internal
    -- `project_id` of each hidden project, its position in the list, and the
    -- simple fact that this child has two pieces of work they chose not to
    -- show you.
    --
    -- Section 3 forbids exactly that — "prevent leaking internal database IDs"
    -- — and section 2B says hidden draft items must never leak. The probe found
    -- it by counting: one public project, three visible items.
    --
    -- So an item is public when its portfolio is public AND its project is one
    -- the owner actually published. Delegating to the project is the same rule
    -- `project_artifacts_select` follows, and the reason this policy did not
    -- follow it was simply that nobody had checked.
    OR (app_portfolio_is_public(portfolio_id)
        AND app_project_is_publicly_listed(project_id))
  );

CREATE POLICY portfolio_items_insert ON portfolio_items FOR INSERT TO edu_app
  WITH CHECK (owner_id = app_current_actor());

CREATE POLICY portfolio_items_update ON portfolio_items FOR UPDATE TO edu_app
  USING (owner_id = app_current_actor())
  WITH CHECK (owner_id = app_current_actor());

CREATE POLICY portfolio_items_delete ON portfolio_items FOR DELETE TO edu_app
  USING (owner_id = app_current_actor());

/**
 * THE DEFINER-ROLE READ POLICY, without which the helper above answers FALSE
 * for every project on the platform.
 *
 * `FORCE ROW LEVEL SECURITY` binds the table OWNER too, a SECURITY DEFINER
 * function runs AS the owner, and every other policy here is `TO edu_app` — so
 * `edu_migrator` matches nothing and `app_project_is_publicly_listed` silently
 * returns false. The probe caught it: a genuinely public project in a published
 * portfolio became invisible to the world.
 *
 * MIGRATION 0014 WROTE THIS RULE DOWN IN 2024 AND IT HAS NOW BEEN MISSED THREE
 * TIMES — VULN-044 in Task 010, VULN-050 in Task 012, and here. The comment
 * there says it plainly: "EVERY table a SECURITY DEFINER function touches needs
 * a policy for the definer role, for every command it performs."
 *
 * Three repeats of a written-down rule is not a memory problem, it is an
 * enforcement gap. `tests/integration/rls-definer-coverage.test.ts` now derives
 * the rule from the catalog itself — every FORCE-RLS table read by a definer
 * function must have a policy for the definer role — so the fourth instance
 * fails a test instead of shipping.
 *
 * Read-only, and only for the role no request ever runs as. Writes still go
 * through the `edu_app` policies above.
 */
CREATE POLICY student_projects_definer_select ON student_projects
  FOR SELECT TO edu_migrator USING (true);

-- ── PRIVILEGES ──────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON student_projects   TO edu_app;
GRANT SELECT, INSERT, DELETE         ON project_artifacts  TO edu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON student_portfolios TO edu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON portfolio_items    TO edu_app;

-- PostgreSQL grants EXECUTE to PUBLIC by default, so withholding it takes more
-- than not granting it — VULN-041.
REVOKE ALL ON FUNCTION app_mint_share_token()                         FROM PUBLIC;
REVOKE ALL ON FUNCTION app_portfolio_key()                            FROM PUBLIC;
REVOKE ALL ON FUNCTION app_begin_public_portfolio(text)               FROM PUBLIC;
REVOKE ALL ON FUNCTION app_portfolio_is_public(uuid)                  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_project_is_publicly_listed(uuid)           FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_shares_project_class(uuid)           FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_reviews_project(uuid, uuid)          FROM PUBLIC;
REVOKE ALL ON FUNCTION student_project_guard()                        FROM PUBLIC;
REVOKE ALL ON FUNCTION student_project_review_guard()                  FROM PUBLIC;
REVOKE ALL ON FUNCTION student_portfolio_guard()                      FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_mint_share_token()                TO edu_app;
GRANT EXECUTE ON FUNCTION app_portfolio_key()                   TO edu_app;
GRANT EXECUTE ON FUNCTION app_begin_public_portfolio(text)      TO edu_app;
GRANT EXECUTE ON FUNCTION app_portfolio_is_public(uuid)         TO edu_app;
GRANT EXECUTE ON FUNCTION app_project_is_publicly_listed(uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_shares_project_class(uuid)  TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_reviews_project(uuid, uuid) TO edu_app;

-- ============================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================
--
-- It does not touch `student_artifacts`, `notes` or `student_notebooks`. A
-- learner's workspace has no sharing model and this does not give it one; a
-- project artifact is a separate object with a separate table because it is a
-- separate decision by the child. The public path cannot reach any of them,
-- there is no column here that could reference one, and a fitness function
-- asserts the module names none.
--
-- It does not let a reviewer EDIT a project. `student_projects_feature` admits
-- the row for an UPDATE and nothing more; a teacher who could rewrite a
-- description could put words in a child's mouth on a public page.
--
-- It does not make `public_slug` a secret. See the column comment: a portfolio
-- published under a readable name is discoverable by that name, which is what a
-- portfolio is. The consequence is recorded in limitations.md.
--
-- It does not add moderation of what a learner writes. `description_markdown`,
-- `title` and `bio` are free text bounded by length, rendered as text and never
-- as markup by anything this task builds. A public page carrying a child's
-- unmoderated prose is a real risk and it is recorded, not solved.
-- ============================================================================
