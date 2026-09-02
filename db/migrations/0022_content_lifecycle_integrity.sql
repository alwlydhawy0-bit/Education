-- =====================================================================
-- 0022 — Content lifecycle integrity
-- =====================================================================
-- 0016 gave content a lifecycle (draft -> published -> archived, forward only)
-- and a duty split (an author writes, a publisher moves the status). 0019 froze
-- an assessment's questions at publication; 0020 froze its configuration. What
-- none of them did was ask the question Task 010 made urgent:
--
--   IF A LEARNER'S EVIDENCE POINTS AT THIS ROW, WHICH OF ITS COLUMNS CAN STILL
--   MOVE WITHOUT CHANGING WHAT THAT EVIDENCE MEANS?
--
-- Probing the live schema before writing this migration answered it exactly.
-- These were ALLOWED for a content author on PUBLISHED content:
--
--   * `learning_objectives.statement` — even with evidence attached.
--   * INSERTing a new objective onto a published lesson.
--   * `learning_objectives.position`.
--   * `learning_activities.title` and `.instructions`.
--   * publishing a lesson whose UNIT is still a draft.
--   * publishing a lesson with no body and no external link.
--   * archiving a unit while published lessons still hang off it.
--
-- And these were already refused, correctly, and are left alone: assessment
-- questions, options, answer keys and configuration; the status transition
-- graph; the author/publisher split; and every learner-visibility rule — an
-- archived ancestor already hides a lesson, and archiving an activity already
-- preserves the attempts and evidence beneath it.
--
-- ONE SUSPECTED GAP TURNED OUT NOT TO BE ONE, and it is recorded because the
-- near-miss is instructive. A first probe reported `lessons.unit_id` as mutable
-- on a published lesson, and a trigger to freeze it was written. Re-probing
-- showed the first probe had set the column to the SAME unit it already held:
-- `NEW.unit_id <> OLD.unit_id` was false, so 0016's
-- `content_ownership_is_immutable` never fired and the probe read its silence as
-- permission. Re-parenting a lesson is in fact refused OUTRIGHT by 0016, for
-- drafts as well as published rows, which is stricter than the rule that was
-- about to be added. The redundant trigger was deleted. A second copy of a rule
-- is not extra safety — it is a place for two rules to disagree.
--
-- WHY THERE IS NO VERSIONING HERE.
--
-- Full content versioning was considered and refused. Every mutation above that
-- changes the meaning of stored evidence is closable by freezing one field;
-- none of them needs two live versions of the same lesson to coexist. Versioning
-- would mean carrying a version id on `assessment_attempts`, `lesson_progress`
-- and `objective_evidence` and rewriting every join that reads them — the major
-- database rewrite this task places out of scope, bought for a problem that a
-- trigger solves. The cost of NOT versioning is stated in
-- docs/api/curriculum.md rather than hidden: a published lesson's BODY stays
-- editable, so "completed this lesson" refers to whatever the body says now.
-- The claim the evidence makes — completed, on that date, against those
-- objectives — is what this migration keeps true.
--
-- AND NO REVIEW STATE.
--
-- A `review` status between draft and published would encode "an author has
-- finished and a publisher has not yet looked". The platform already says that:
-- `draft` plus the `content:publish` permission the author does not hold. A
-- state whose only content is the absence of an action somebody else takes is a
-- state every reader has to reason about for nothing — the same argument 0020
-- used to refuse a `pending_review` attempt status.
-- =====================================================================

-- =====================================================================
-- Status helpers the freezes need
-- =====================================================================
-- Same discipline as every migration since 0014: a trigger or policy reaches
-- another table only through a SECURITY DEFINER helper, so the reference graph
-- stays acyclic and FORCE ROW LEVEL SECURITY cannot make a check answer false
-- in silence (VULN-007, VULN-012).

/** A unit's publication status. Mirrors `app_lesson_status` (0021). */
CREATE FUNCTION app_unit_status(p_unit_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT status FROM course_units WHERE id = p_unit_id;
$$;

/** A curriculum's publication status. */
CREATE FUNCTION app_curriculum_status(p_curriculum_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT status FROM curricula WHERE id = p_curriculum_id;
$$;

/** An activity's publication status. */
CREATE FUNCTION app_activity_status(p_activity_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT status FROM learning_activities WHERE id = p_activity_id;
$$;

REVOKE ALL ON FUNCTION app_unit_status(uuid)       FROM PUBLIC;
REVOKE ALL ON FUNCTION app_curriculum_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_activity_status(uuid)   FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_unit_status(uuid)       TO edu_app;
GRANT EXECUTE ON FUNCTION app_curriculum_status(uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_activity_status(uuid)   TO edu_app;

-- =====================================================================
-- THE OBJECTIVE FREEZE — the most important thing in this migration
-- =====================================================================

/**
 * A published lesson's objectives are fixed: their wording, their order, and
 * which of them there are.
 *
 * WHY THE STATEMENT IS FROZEN. `objective_evidence` records "this learner
 * demonstrated objective X" by id. The statement is what X MEANS. Rewording it
 * after a child has demonstrated it silently rewrites the claim the platform is
 * making about that child — and a typo fix and a meaning change are
 * indistinguishable to a database, so neither can be allowed once the objective
 * has been published to learners.
 *
 * The cost is real and is not disguised: correcting a published objective's
 * wording is not possible. That is the same answer 0019 gave for a mistyped
 * assessment question ("correcting a published assessment means publishing a new
 * one"), and it is given here for the same reason — a mark, or a mastery state,
 * must always name the thing it was actually awarded against.
 *
 * WHY INSERTS ARE FROZEN TOO, which is less obvious and matters as much.
 * Mastery is reported as a tally over a lesson's objectives. A learner who
 * completed the lesson last term has evidence for the objectives that existed
 * then. Adding a twelfth objective to a published lesson gives them a new
 * `no_evidence` row they had no opportunity to earn, and their recorded mastery
 * DROPS without them doing anything. Nothing in the evidence table changed; the
 * denominator did.
 *
 * DELETES were already confined to draft lessons by 0021's policy. This trigger
 * completes the set, so a published lesson's objective list is closed in all
 * three directions.
 */
CREATE FUNCTION learning_objectives_are_draft_only() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  target_lesson uuid := COALESCE(NEW.lesson_id, OLD.lesson_id);
BEGIN
  IF app_lesson_status(target_lesson) IS DISTINCT FROM 'draft' THEN
    -- The message names the ACT, not the field, because an author who hits this
    -- needs to know the lesson is closed rather than which column tripped.
    RAISE EXCEPTION 'A lesson''s objectives cannot be changed after it leaves draft'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER learning_objectives_draft_only
  BEFORE INSERT OR UPDATE ON learning_objectives
  FOR EACH ROW EXECUTE FUNCTION learning_objectives_are_draft_only();

-- =====================================================================
-- Published rows keep their parent, and their given task
-- =====================================================================

/**
 * A published activity's title and instructions are fixed.
 *
 * `docs/api/assessment.md` has claimed since Task 008 that "a published activity
 * cannot be edited". Probing the schema showed that was true of its QUESTIONS
 * and false of the activity row itself: title and instructions were freely
 * mutable. This makes the documentation true.
 *
 * The instructions are the task a learner was given. Changing them after
 * attempts exist changes what those attempts were attempts AT, which is the same
 * class of harm as rewording a question — and 0019 already refused that.
 *
 * The lifecycle columns are excluded so publishing and archiving still work, and
 * `position` is excluded because reordering activities within a lesson changes
 * presentation rather than any claim about a learner.
 */
CREATE FUNCTION activity_definition_is_frozen_when_published() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'draft'
     AND (NEW.title IS DISTINCT FROM OLD.title
          OR NEW.instructions IS DISTINCT FROM OLD.instructions
          OR NEW.activity_type IS DISTINCT FROM OLD.activity_type
          OR NEW.lesson_id IS DISTINCT FROM OLD.lesson_id) THEN
    RAISE EXCEPTION 'A published activity''s definition cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER learning_activities_definition_frozen
  BEFORE UPDATE ON learning_activities
  FOR EACH ROW EXECUTE FUNCTION activity_definition_is_frozen_when_published();

-- =====================================================================
-- The tree's status must be consistent, in both directions
-- =====================================================================
-- Two rules, one principle: a published node's ancestors are published, and an
-- archived node has no published descendants. Publishing walks UP, archiving is
-- refused while anything below is still live.
--
-- Both are enforced HERE rather than in a service, because a partially
-- published tree is the state §10 of the task calls out — "lesson published but
-- objective unpublished", "activity published but parent lesson unavailable" —
-- and a rule that lives only in application code is one direct statement away
-- from being bypassed.
--
-- ARCHIVAL REFUSES RATHER THAN CASCADES, deliberately. Cascading would archive a
-- learner-visible lesson as an invisible side effect of archiving its unit; a
-- refusal makes the author archive downward on purpose, and every step of it is
-- a separate audited act. It is also the safer failure: the worst outcome of a
-- refusal is an annoyed author, and the worst outcome of a silent cascade is
-- content disappearing from a class mid-term.

/**
 * A content node may only be published beneath published ancestors, and may only
 * be archived once nothing published hangs off it.
 *
 * One function for all four tables, dispatching on `TG_TABLE_NAME`. The branches
 * are NESTED rather than combined with AND for the reason 0016 recorded on
 * `content_ownership_is_immutable`: plpgsql resolves `NEW.unit_id` even in a
 * branch narrowed to another table, and fails with "record NEW has no field".
 */
CREATE FUNCTION content_tree_status_is_consistent() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  publishing boolean := NEW.status = 'published' AND OLD.status IS DISTINCT FROM 'published';
  archiving  boolean := NEW.status = 'archived'  AND OLD.status IS DISTINCT FROM 'archived';
  live_below integer;
BEGIN
  IF TG_TABLE_NAME = 'lessons' THEN
    IF publishing AND NOT app_unit_chain_published(NEW.unit_id) THEN
      RAISE EXCEPTION 'A lesson cannot be published while its unit or course is not published'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF archiving THEN
      SELECT count(*) INTO live_below FROM learning_activities
       WHERE lesson_id = NEW.id AND status = 'published';
      IF live_below > 0 THEN
        RAISE EXCEPTION 'Archive this lesson''s % published activities first', live_below
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'course_units' THEN
    IF publishing AND app_course_status(NEW.course_id) IS DISTINCT FROM 'published' THEN
      RAISE EXCEPTION 'A unit cannot be published while its course is not published'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF archiving THEN
      SELECT count(*) INTO live_below FROM lessons
       WHERE unit_id = NEW.id AND status = 'published';
      IF live_below > 0 THEN
        RAISE EXCEPTION 'Archive this unit''s % published lessons first', live_below
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'courses' THEN
    IF publishing AND app_curriculum_status(NEW.curriculum_id) IS DISTINCT FROM 'published' THEN
      RAISE EXCEPTION 'A course cannot be published while its curriculum is not published'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF archiving THEN
      SELECT count(*) INTO live_below FROM course_units
       WHERE course_id = NEW.id AND status = 'published';
      IF live_below > 0 THEN
        RAISE EXCEPTION 'Archive this course''s % published units first', live_below
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'curricula' THEN
    -- A curriculum has no parent, so only the archival half applies.
    IF archiving THEN
      SELECT count(*) INTO live_below FROM courses
       WHERE curriculum_id = NEW.id AND status = 'published';
      IF live_below > 0 THEN
        RAISE EXCEPTION 'Archive this curriculum''s % published courses first', live_below
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER curricula_tree_consistent
  BEFORE UPDATE ON curricula
  FOR EACH ROW EXECUTE FUNCTION content_tree_status_is_consistent();
CREATE TRIGGER courses_tree_consistent
  BEFORE UPDATE ON courses
  FOR EACH ROW EXECUTE FUNCTION content_tree_status_is_consistent();
CREATE TRIGGER course_units_tree_consistent
  BEFORE UPDATE ON course_units
  FOR EACH ROW EXECUTE FUNCTION content_tree_status_is_consistent();
CREATE TRIGGER lessons_tree_consistent
  BEFORE UPDATE ON lessons
  FOR EACH ROW EXECUTE FUNCTION content_tree_status_is_consistent();

-- =====================================================================
-- A lesson must have something in it to publish
-- =====================================================================

/**
 * A published lesson carries a body or an external link.
 *
 * The ONE structural requirement this migration adds, and the bar is
 * deliberately low. `content_body` defaults to `''` and `external_url` is
 * nullable, so today a lesson consisting of nothing but a title can be published
 * to a class. That is not a judgement about pedagogy; it is a lesson with no
 * lesson in it.
 *
 * WHAT IS DELIBERATELY *NOT* REQUIRED, because §11 says every validation must
 * have a real reason and these do not have one:
 *
 *   * At least one OBJECTIVE. A reading lesson with nothing assessable is a
 *     legitimate thing to publish; it contributes `lesson_progress` and simply
 *     produces no mastery evidence, which is the honest outcome.
 *   * At least one ACTIVITY. Same reason.
 *   * A summary, an estimated duration, or a minimum body length. Editorial
 *     preferences, not integrity rules, and a database is the wrong place to
 *     hold an opinion about how long a lesson should be.
 */
CREATE FUNCTION lesson_is_publishable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status = 'published' AND OLD.status IS DISTINCT FROM 'published' THEN
    IF length(btrim(NEW.content_body)) = 0 AND NEW.external_url IS NULL THEN
      RAISE EXCEPTION 'A lesson cannot be published with no content and no external link'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER lessons_publishable
  BEFORE UPDATE ON lessons
  FOR EACH ROW EXECUTE FUNCTION lesson_is_publishable();

-- =====================================================================
-- Backfill: nothing to do, and that is worth stating
-- =====================================================================
-- Every rule above constrains FUTURE writes. No existing row is rewritten, no
-- status is changed, and no learner's attempts, progress, evidence or mastery is
-- touched — this migration adds triggers and functions only.
--
-- Existing data that would violate the new rules (a published lesson under a
-- draft unit, say, created before this migration) is LEFT AS IT IS rather than
-- corrected. Silently republishing or unpublishing content a class may be part
-- way through is a worse act than tolerating an inconsistency the new rules stop
-- growing. The triggers fire on UPDATE, so such a row is only forced into line
-- when somebody next moves its status deliberately.
--
-- ROLLBACK: drop the four triggers, the three status helpers and the five
-- functions this file creates. Nothing else changes, because nothing else was
-- written. Content authored while the migration was live remains valid under the
-- looser rules, so the rollback is total and lossless in both directions.
