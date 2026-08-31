-- =====================================================================
-- 0017 — Course assignments to classes, and the narrowing they cause
-- =====================================================================
-- Task 004 built the class graph. Task 005 built the content tree. Nothing
-- joined them, so a published course was visible to an entire ORGANIZATION —
-- the loosest correct answer, and not the right one. A Grade 7 physics course
-- should reach Grade 7 physics.
--
-- This migration adds the edge and then USES it to narrow what a learner sees.
-- The narrowing is the point, and it is worth being explicit about because it
-- changes behaviour established in 0016:
--
--   BEFORE: a learner saw every published course in their organization, plus
--           every published course in the global catalog.
--   AFTER:  a learner sees a published course only when it is actively assigned
--           to an active class they are actively enrolled in.
--
-- Visibility only ever NARROWS. There is no branch below through which an
-- assignment could make content visible ACROSS an organization boundary: the
-- assignment itself is refused unless the course is global or belongs to the
-- class's own school, so the tenancy check in 0016 still runs and still decides
-- first.
--
-- WHAT IS DELIBERATELY *NOT* NARROWED: `curricula`. The subject catalog names
-- subjects — "Mathematics", "Physics" — not content. Making it conditional on
-- an assignment would mean a learner could not see that their school teaches
-- mathematics until somebody assigned them a maths course, which is not a
-- boundary anyone asked for and would make the catalog useless as a catalog.
-- =====================================================================

CREATE TABLE class_course_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE on both ends, matching `class_memberships` and
  -- `teacher_assignments`: this row is an EDGE, and an edge whose endpoint is
  -- gone means nothing. RESTRICT would also make deleting an organization fail
  -- part-way through its own cascade.
  class_id    uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,

  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),

  -- 'active'   — learners in the class reach the course through this row.
  -- 'inactive' — withdrawn by staff. Reversible: re-assigning creates a new
  --              active row, so each spell keeps its own dates.
  -- 'archived' — ended because the CLASS ended. Terminal, and set by the
  --              trigger below rather than by any endpoint.
  status      text NOT NULL DEFAULT 'active',
  ended_at    timestamptz,

  -- Optional scheduling metadata. Descriptive only: neither date gates access.
  -- A date that silently controlled visibility would be an authorization rule
  -- hiding in a calendar field, and the clock is not a gate this system trusts.
  starts_on   date,
  due_on      date,

  CONSTRAINT cca_status_ck CHECK (status IN ('active', 'inactive', 'archived')),
  CONSTRAINT cca_ended_consistency_ck CHECK ((status = 'active') = (ended_at IS NULL)),
  CONSTRAINT cca_dates_ck CHECK (starts_on IS NULL OR due_on IS NULL OR due_on >= starts_on)
);

-- At most one ACTIVE assignment per (class, course), and history may repeat.
--
-- An EXCLUSION constraint rather than a unique index, because it is the only
-- form PostgreSQL offers that is BOTH partial and DEFERRABLE: a partial unique
-- index cannot be deferred, and a deferrable UNIQUE constraint cannot be
-- partial. Nothing today rewrites the whole set in one statement, so the
-- deferral is unused — it is here so that a future bulk re-assignment cannot
-- be forced to choose between correctness and this constraint.
ALTER TABLE class_course_assignments
  ADD CONSTRAINT class_course_assignments_active_excl
  EXCLUDE USING btree (class_id WITH =, course_id WITH =)
  WHERE (status = 'active')
  DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX cca_class_idx  ON class_course_assignments (class_id)  WHERE status = 'active';
CREATE INDEX cca_course_idx ON class_course_assignments (course_id) WHERE status = 'active';

-- =====================================================================
-- Helpers
-- =====================================================================
-- Same discipline as 0014 and 0016: every cross-table check goes through a
-- SECURITY DEFINER helper, so no policy references another table directly and
-- the reference graph stays acyclic. And every table a definer function reads
-- needs an `edu_migrator` policy, or FORCE ROW LEVEL SECURITY makes it answer
-- false in silence (VULN-007, VULN-012).
-- =====================================================================

ALTER TABLE class_course_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_course_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY class_course_assignments_definer_select
  ON class_course_assignments FOR SELECT TO edu_migrator USING (true);

/**
 * Whether the current actor reaches a course as a LEARNER: an active assignment
 * to an active class in which they hold an active membership.
 *
 * Every hop is status-checked, and the join is written once. That is what makes
 * revocation instant: ending the membership, deactivating the assignment or
 * archiving the class each break the chain on the next query, with no second
 * table to remember to update.
 */
CREATE FUNCTION app_actor_studies_course(p_course_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM class_course_assignments a
    JOIN classes c            ON c.id = a.class_id
    JOIN class_memberships cm ON cm.class_id = a.class_id
    WHERE a.course_id = p_course_id
      AND a.status  = 'active'
      AND c.status  = 'active'
      AND cm.status = 'active'
      AND cm.user_id = app_current_actor()
  );
$$;

/**
 * The same question for a TEACHER of the class.
 *
 * Note what this is NOT: it is not how a teacher reads their own school's
 * content. A teacher holds `content:author`, so 0016's editorial branch already
 * shows them everything in their organization, drafts included. This branch
 * matters for content the editorial branch does not cover — today that is the
 * GLOBAL catalog, where a teacher has no editorial standing at all.
 */
CREATE FUNCTION app_actor_teaches_course(p_course_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM class_course_assignments a
    JOIN classes c             ON c.id = a.class_id
    JOIN teacher_assignments ta ON ta.class_id = a.class_id
    WHERE a.course_id = p_course_id
      AND a.status  = 'active'
      AND c.status  = 'active'
      AND ta.status = 'active'
      AND ta.teacher_id = app_current_actor()
  );
$$;

/** Either route into a course through a class. */
CREATE FUNCTION app_actor_reaches_course(p_course_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $$
  SELECT app_actor_studies_course(p_course_id) OR app_actor_teaches_course(p_course_id);
$$;

/** The organization a class belongs to, for the cross-tenant checks below. */
CREATE FUNCTION app_class_organization_of(p_class_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT c.organization_id FROM classes c WHERE c.id = p_class_id; $$;

/** Whether a class exists and is currently active. */
CREATE FUNCTION app_class_is_active(p_class_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM classes c WHERE c.id = p_class_id AND c.status = 'active');
$$;

REVOKE ALL ON FUNCTION app_actor_studies_course(uuid)  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_teaches_course(uuid)  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_reaches_course(uuid)  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_class_organization_of(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_class_is_active(uuid)       FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_actor_studies_course(uuid)  TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_teaches_course(uuid)  TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_reaches_course(uuid)  TO edu_app;
GRANT EXECUTE ON FUNCTION app_class_organization_of(uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_class_is_active(uuid)       TO edu_app;

-- =====================================================================
-- Integrity triggers
-- =====================================================================

/**
 * A course may only be assigned to a class it is allowed to reach.
 *
 * A foreign key proves both rows exist; it cannot express "and they belong to
 * the same school". Without this, an administrator could assign their own
 * school's course to another school's class — or worse, another school's PRIVATE
 * course to their own class, which would hand their students content the
 * tenancy rule in 0016 exists to keep from them.
 *
 * Uses the definer helpers rather than reading `classes` and `courses`
 * directly. A trigger runs as the INVOKER, so a direct read would be subject to
 * the caller's own RLS and would refuse legitimate rows the caller happens not
 * to be able to see. Visibility is the policy layer's question; this trigger
 * answers a structural one, and must answer it the same way for everybody.
 */
CREATE FUNCTION class_course_assignment_is_in_scope() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  class_org  uuid := app_class_organization_of(NEW.class_id);
  course_org uuid := app_course_organization(NEW.course_id);
  course_is_global boolean := app_course_is_global(NEW.course_id);
BEGIN
  IF class_org IS NULL THEN
    RAISE EXCEPTION 'Unknown class' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF course_org IS NULL AND NOT course_is_global THEN
    -- `app_course_organization` answers NULL for both "global" and "no such
    -- course"; `app_course_is_global` separates the two.
    RAISE EXCEPTION 'Unknown course' USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT course_is_global AND course_org IS DISTINCT FROM class_org THEN
    RAISE EXCEPTION 'A course may only be assigned to a class in its own organization'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Only PUBLISHED content reaches a classroom. A draft is unreviewed by
  -- definition, and assigning one would route around the duty split in ADR 0009
  -- by making unpublished work reachable to learners the moment it is published.
  IF app_course_status(NEW.course_id) <> 'published' THEN
    RAISE EXCEPTION 'Only a published course may be assigned to a class'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END
$$;

/**
 * The parties and the lifecycle of an assignment.
 *
 * Re-pointing an assignment at a different class or course would inherit its
 * status and its history — the same reasoning as
 * `relationship_parties_are_immutable` in 0014. And the status graph is
 * forward-only into `archived`; `active` and `inactive` may alternate, because
 * withdrawing a course from a class and putting it back is ordinary teaching.
 */
CREATE FUNCTION class_course_assignment_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.class_id <> OLD.class_id OR NEW.course_id <> OLD.course_id THEN
    RAISE EXCEPTION 'The class or course of an assignment cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.assigned_by IS DISTINCT FROM OLD.assigned_by THEN
    RAISE EXCEPTION 'The assigner of an assignment cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'archived' AND NEW.status <> 'archived' THEN
    RAISE EXCEPTION 'An archived assignment cannot be reopened'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER class_course_assignments_scope
  BEFORE INSERT OR UPDATE ON class_course_assignments
  FOR EACH ROW EXECUTE FUNCTION class_course_assignment_is_in_scope();

CREATE TRIGGER class_course_assignments_guard
  BEFORE UPDATE ON class_course_assignments
  FOR EACH ROW EXECUTE FUNCTION class_course_assignment_guard();

/**
 * Archiving a class archives its course assignments.
 *
 * This is BOOKKEEPING, not the control. Access already stops the moment the
 * class stops being active, because `app_actor_studies_course` checks the
 * class's status on every query — so this trigger changes no boundary. What it
 * does is keep the record honest: an archived class should not leave rows
 * behind that claim to be active assignments.
 *
 * SECURITY DEFINER so the cascade does not depend on the archiving actor also
 * passing the assignment table's own write policy.
 */
CREATE FUNCTION archive_class_course_assignments() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status = 'archived' AND OLD.status <> 'archived' THEN
    UPDATE class_course_assignments
       SET status = 'archived', ended_at = now()
     WHERE class_id = NEW.id AND status <> 'archived';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER classes_archive_course_assignments
  AFTER UPDATE ON classes
  FOR EACH ROW EXECUTE FUNCTION archive_class_course_assignments();

-- The definer function above UPDATEs as the owner, so FORCE ROW LEVEL SECURITY
-- requires an owner policy for that command as well as for SELECT.
CREATE POLICY class_course_assignments_definer_update
  ON class_course_assignments FOR UPDATE TO edu_migrator USING (true) WITH CHECK (true);

-- =====================================================================
-- Row-Level Security
-- =====================================================================

/**
 * Who may SEE an assignment.
 *
 * A learner may see which courses their own class has — that list is the
 * syllabus, and hiding it from the people studying it serves nothing. A teacher
 * of the class and an administrator of its school see the same. Everybody else
 * sees nothing, including staff of another school.
 */
CREATE POLICY class_course_assignments_select ON class_course_assignments FOR SELECT TO edu_app
  USING (
    app_actor_is_platform_operator()
    OR app_actor_is_member_of_class(class_id)
    OR app_actor_teaches_class(class_id)
    OR (app_actor_is_org_admin() AND app_class_organization_of(class_id) = app_actor_organization())
  );

/**
 * Who may ASSIGN.
 *
 * A teacher of the class, or an administrator of its organization — exactly the
 * standing `class_memberships` requires to manage a roster (0014). Choosing
 * which PUBLISHED course a class studies is running the class, which a teacher
 * does; it is not deciding what content exists, which they do not.
 *
 * The class must be ACTIVE and in the actor's own organization. Whether the
 * COURSE is reachable from that class is the trigger's question, and it is
 * asked structurally so the two cannot disagree.
 */
CREATE POLICY class_course_assignments_insert ON class_course_assignments FOR INSERT TO edu_app
  WITH CHECK (
    status = 'active'
    AND assigned_by = app_current_actor()
    AND app_class_is_active(class_id)
    AND app_class_organization_of(class_id) = app_actor_organization()
    AND (app_actor_teaches_class(class_id) OR app_actor_is_org_admin())
  );

/**
 * Unassignment is a status change, never a DELETE.
 *
 * Which courses a class was taught, and when, is part of the record of what a
 * child was shown. `USING` admits any non-archived row so a withdrawal can be
 * recorded; the trigger above refuses reopening an archived one.
 */
CREATE POLICY class_course_assignments_update ON class_course_assignments FOR UPDATE TO edu_app
  USING (
    status <> 'archived'
    AND app_class_organization_of(class_id) = app_actor_organization()
    AND (app_actor_teaches_class(class_id) OR app_actor_is_org_admin())
  )
  WITH CHECK (
    app_class_organization_of(class_id) = app_actor_organization()
    AND (app_actor_teaches_class(class_id) OR app_actor_is_org_admin())
  );

GRANT SELECT, INSERT, UPDATE ON class_course_assignments TO edu_app;

-- =====================================================================
-- The narrowing
-- =====================================================================
-- 0016's learner branch was "published, and in a catalog I can see". It becomes
-- "published, in a catalog I can see, AND assigned to a class I am in".
--
-- The catalog test is UNCHANGED and still runs first, so an assignment can
-- never widen visibility across an organization boundary. It can only remove
-- content from the set a learner already could have seen.
--
-- The editorial branch is untouched: authors, reviewers and administrators
-- still see everything in their own school regardless of assignment, because
-- their reason for reading it is not that they are studying it.
--
-- And the narrowing applies to LEARNERS ONLY. Anyone holding a content
-- permission still reads the published catalog — their own school's and the
-- global one — without an assignment, because choosing what to assign to a
-- class means browsing the candidates first, and a person who cannot see a
-- course cannot assign it. That branch grants nothing publication had not
-- already made public to their organization.
-- =====================================================================

DROP POLICY courses_select ON courses;

CREATE POLICY courses_select ON courses FOR SELECT TO edu_app
  USING (
    app_actor_is_platform_operator()
    OR (
      status = 'published'
      AND (organization_id IS NULL OR organization_id = app_actor_organization())
      AND (
        app_actor_reaches_course(id)
        OR app_actor_authors_content()
        OR app_actor_publishes_content()
      )
    )
    OR (
      organization_id IS NOT NULL
      AND organization_id = app_actor_organization()
      AND (app_actor_authors_content() OR app_actor_publishes_content())
    )
  );

DROP POLICY course_units_select ON course_units;

CREATE POLICY course_units_select ON course_units FOR SELECT TO edu_app
  USING (
    app_actor_is_platform_operator()
    OR (
      status = 'published'
      AND app_course_status(course_id) = 'published'
      AND (app_course_is_global(course_id) OR app_course_organization(course_id) = app_actor_organization())
      AND (
        app_actor_reaches_course(course_id)
        OR app_actor_authors_content()
        OR app_actor_publishes_content()
      )
    )
    OR (
      NOT app_course_is_global(course_id)
      AND app_course_organization(course_id) = app_actor_organization()
      AND (app_actor_authors_content() OR app_actor_publishes_content())
    )
  );

DROP POLICY lessons_select ON lessons;

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
      AND (
        app_actor_reaches_course(app_unit_course(unit_id))
        OR app_actor_authors_content()
        OR app_actor_publishes_content()
      )
    )
    OR (
      NOT app_course_is_global(app_unit_course(unit_id))
      AND app_course_organization(app_unit_course(unit_id)) = app_actor_organization()
      AND (app_actor_authors_content() OR app_actor_publishes_content())
    )
  );
