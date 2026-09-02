-- =====================================================================
-- 0021 — Learning objectives, evidence and mastery
-- =====================================================================
-- Tasks 007 and 008 answered "what did this learner do?". This migration is
-- the first that tries to answer "what does this learner appear to understand?"
-- — and the whole of its design is about not overclaiming while doing so.
--
-- WHY OBJECTIVES BECOME A TABLE
--
-- 0016 gave lessons an `objectives text[]`: a list of statements, displayed
-- with the lesson. It is the platform's existing notion of an objective, and
-- extending it is right — but it CANNOT anchor evidence as it stands, for a
-- reason that is a property of 0016 rather than a matter of taste:
--
--   A PUBLISHED LESSON IS STILL EDITABLE. `lessons_update` admits a content
--   author for a published lesson (unlike an activity, which 0019 freezes).
--
-- So an evidence row that referenced an objective BY ITS TEXT would be silently
-- re-pointed when an author fixed a typo, and orphaned when they reordered the
-- array. A child's mastery record would change meaning because somebody edited
-- a sentence. Evidence therefore has to reference a stable identity, which is
-- what promoting the array to rows provides.
--
-- The column is backfilled and then DROPPED, rather than kept alongside: two
-- authoring surfaces for one concept is precisely the duplication that produces
-- a divergence nobody notices. The lesson API keeps returning
-- `objectives: string[]`, derived from these rows, so no reader sees a change.
-- ROLLBACK, verified by executing it against a populated upgrade database:
--
--   ALTER TABLE lessons ADD COLUMN objectives text[] NOT NULL DEFAULT '{}';
--   UPDATE lessons l SET objectives = COALESCE(
--     (SELECT array_agg(o.statement ORDER BY o.position)
--        FROM learning_objectives o WHERE o.lesson_id = l.id), '{}'::text[]);
--
-- The table is a superset of what the array held, so no authored statement is
-- lost in either direction. RUN IT AS A SUPERUSER: `lessons` carries FORCE ROW
-- LEVEL SECURITY and has no `edu_migrator` UPDATE policy, so the same statement
-- run as the owner silently updates ZERO rows — the VULN-007 failure mode, and
-- exactly the kind of thing a rollback discovers at the worst moment.
--
-- WHAT THIS MIGRATION REFUSES TO DO
--
--   * NO STORED MASTERY. Mastery is a function of evidence, computed on read.
--     A stored level is a second source of truth that can disagree with the
--     evidence it claims to summarise, and the disagreement is invisible.
--   * NO EVIDENCE WRITTEN BY THE APPLICATION. `edu_app` is granted SELECT on
--     `objective_evidence` and nothing else. Evidence is emitted by triggers on
--     the events that already exist, so "the client forged an evidence row" is
--     not a threat that has to be defended against — there is no privilege
--     through which it could be attempted.
--   * NO DECAY, no forgetting curve, no probabilistic inference, no weighting
--     that cannot be read off the rules below.
-- =====================================================================

-- =====================================================================
-- Objectives
-- =====================================================================

/**
 * One learning objective, belonging to one lesson.
 *
 * `statement` is MUTABLE and `id` is not, and that split is the entire point of
 * the table: an author may correct the wording of an objective a child has
 * already demonstrated, and the evidence stays attached to the same objective.
 *
 * Deletion is confined to draft lessons by the policy below, so an objective
 * that any learner could have studied cannot be removed out from under their
 * evidence.
 */
CREATE TABLE learning_objectives (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id   uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  position    integer NOT NULL,
  statement   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT learning_objectives_position_ck  CHECK (position >= 1),
  -- The same bounds 0016 enforced on an array element, restated on the row.
  CONSTRAINT learning_objectives_statement_ck CHECK (length(btrim(statement)) BETWEEN 1 AND 300),
  CONSTRAINT learning_objectives_position_uk  UNIQUE (lesson_id, position) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX learning_objectives_lesson_idx ON learning_objectives (lesson_id, position);

-- The cardinality bound 0016 held as `cardinality(objectives) <= 20` cannot be
-- a CHECK on a row, so it moves to a trigger below. Stated here so the two are
-- read together.

/**
 * At most twenty objectives per lesson.
 *
 * 0016's `lessons_objectives_ck` bounded the array; this is the same bound
 * expressed over rows. A row-level CHECK cannot count siblings, so it is a
 * trigger — and a DEFERRABLE constraint trigger would let a transaction exceed
 * the bound transiently, which is fine, but a statement-level AFTER trigger is
 * simpler and refuses at the same moment the array CHECK used to.
 */
CREATE FUNCTION learning_objectives_cardinality_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Scoped to the lesson the row belongs to, not a scan for any offender: the
  -- statement that broke the bound is the one that should be refused, and a
  -- global HAVING would also blame a transaction for a violation somebody else
  -- had already committed.
  IF (SELECT count(*) FROM learning_objectives WHERE lesson_id = NEW.lesson_id) > 20 THEN
    RAISE EXCEPTION 'A lesson may carry at most 20 learning objectives'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER learning_objectives_cardinality
  AFTER INSERT OR UPDATE ON learning_objectives
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION learning_objectives_cardinality_guard();

/**
 * An objective cannot be moved to another lesson.
 *
 * The lesson is what decides who may read the objective and who may study it,
 * so moving one would move every attached evidence row across an authorization
 * boundary in a single UPDATE. Same technique and same reasoning as
 * `content_ownership_is_immutable` in 0016.
 */
CREATE FUNCTION learning_objective_lesson_is_immutable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.lesson_id <> OLD.lesson_id THEN
    RAISE EXCEPTION 'An objective cannot be moved to another lesson'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER learning_objectives_immutable_lesson
  BEFORE UPDATE ON learning_objectives
  FOR EACH ROW EXECUTE FUNCTION learning_objective_lesson_is_immutable();

-- --- Backfill, before the column goes ------------------------------------
-- `WITH ORDINALITY` preserves the authored order as `position`, so a lesson's
-- objectives read back in exactly the order they were written.
INSERT INTO learning_objectives (lesson_id, position, statement)
SELECT l.id, o.ord, o.statement
  FROM lessons l
  CROSS JOIN LATERAL unnest(l.objectives) WITH ORDINALITY AS o(statement, ord)
 WHERE cardinality(l.objectives) > 0;

ALTER TABLE lessons DROP CONSTRAINT lessons_objectives_ck;
ALTER TABLE lessons DROP COLUMN objectives;

-- =====================================================================
-- Evidence
-- =====================================================================

/**
 * One record that a learner did something an objective can be judged from.
 *
 * EVIDENCE IS NOT MASTERY, and this table is deliberately dull because of it.
 * A row says "this learner completed that lesson" or "this learner passed that
 * assessment" — a fact with a source, not a judgement. The judgement is
 * `app_objective_mastery` below, and it is computed rather than stored so the
 * two can never disagree.
 *
 * WHAT ATTACHES TO WHAT. An objective belongs to a lesson; both evidence
 * sources resolve to a lesson; so an event produces one row per objective of
 * ITS lesson. That is coarse on purpose. Attributing a lesson-wide quiz to one
 * objective rather than another would require per-question objective tagging,
 * which is a taxonomy this task explicitly declines to invent — and inventing
 * one would let the platform claim a precision it does not have. The
 * consequence is stated rather than hidden: within one lesson, objectives
 * assessed by the same quiz move together. See docs/api/mastery.md.
 *
 * IDEMPOTENCY IS THE UNIQUE CONSTRAINT, not a check in a service.
 * `(user_id, objective_id, source_kind, source_id)` is the deterministic event
 * identifier §18 asks for: a retried submission carries the same attempt id, so
 * the second insert is a no-op rather than a duplicate. Nothing about retry
 * safety depends on application code being careful.
 *
 * IT IS APPEND-ONLY. There is no UPDATE and no DELETE privilege for `edu_app`
 * below, and no INSERT either — see the grant. Ownership, timestamp and
 * objective association are immutable because there is no statement through
 * which any of them could be changed.
 */
CREATE TABLE objective_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  objective_id  uuid NOT NULL REFERENCES learning_objectives(id) ON DELETE CASCADE,

  evidence_type text NOT NULL,
  source_kind   text NOT NULL,
  -- Not a foreign key, because it points at one of two tables. The trigger that
  -- writes it is the only writer and always has a real row in hand; a polymorphic
  -- FK would need either a nullable column per source or a check constraint that
  -- cannot see another table. Both source tables CASCADE from `users`, so a
  -- deleted learner takes their evidence with them either way.
  source_id     uuid NOT NULL,

  -- The moment the EVENT happened, from the source row — not the moment this
  -- row was written. A late-arriving trigger must not re-date a child's work.
  occurred_at   timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT objective_evidence_type_ck CHECK (
    evidence_type IN ('lesson_completed', 'assessment_passed', 'assessment_not_passed')
  ),
  CONSTRAINT objective_evidence_source_ck CHECK (
    source_kind IN ('lesson_progress', 'assessment_attempt')
  ),
  -- The two vocabularies are not independent: a lesson completion cannot be a
  -- pass, and an assessment outcome cannot come from a progress row. Stated as
  -- a constraint so a future trigger edit cannot quietly produce a row that
  -- means nothing.
  CONSTRAINT objective_evidence_type_matches_source_ck CHECK (
    (source_kind = 'lesson_progress'   AND evidence_type = 'lesson_completed')
    OR
    (source_kind = 'assessment_attempt' AND evidence_type IN ('assessment_passed', 'assessment_not_passed'))
  )
);

-- IDEMPOTENCY. One row per (learner, objective, source event), for all time.
CREATE UNIQUE INDEX objective_evidence_event_uk
  ON objective_evidence (user_id, objective_id, source_kind, source_id);

-- "Everything this learner has demonstrated", which is every read path.
CREATE INDEX objective_evidence_user_idx ON objective_evidence (user_id, objective_id);
CREATE INDEX objective_evidence_objective_idx ON objective_evidence (objective_id);

-- =====================================================================
-- Helpers
-- =====================================================================
-- Same discipline as 0014, 0016, 0017, 0018 and 0019: every cross-table check
-- goes through a SECURITY DEFINER helper, so no policy references another table
-- directly and the reference graph stays acyclic. Every table a definer reads
-- needs an `edu_migrator` policy, or FORCE ROW LEVEL SECURITY makes it answer
-- false in silence (VULN-007, VULN-012).
-- =====================================================================

ALTER TABLE learning_objectives ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_objectives FORCE ROW LEVEL SECURITY;
ALTER TABLE objective_evidence  ENABLE ROW LEVEL SECURITY;
ALTER TABLE objective_evidence  FORCE ROW LEVEL SECURITY;

CREATE POLICY learning_objectives_definer_select
  ON learning_objectives FOR SELECT TO edu_migrator USING (true);
CREATE POLICY objective_evidence_definer_select
  ON objective_evidence FOR SELECT TO edu_migrator USING (true);
CREATE POLICY objective_evidence_definer_insert
  ON objective_evidence FOR INSERT TO edu_migrator WITH CHECK (true);

/**
 * A lesson's publication status.
 *
 * 0016's own `lessons_delete` reads `status` straight off the row it filters,
 * which an objective's policy cannot do — the status lives on the parent. Same
 * shape as `app_assessment_status` (0019), which exists for the same reason.
 */
CREATE FUNCTION app_lesson_status(p_lesson_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT status FROM lessons WHERE id = p_lesson_id;
$$;

/** The lesson an objective belongs to. */
CREATE FUNCTION app_objective_lesson(p_objective_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT lesson_id FROM learning_objectives WHERE id = p_objective_id;
$$;

-- =====================================================================
-- Evidence is EMITTED, never submitted
-- =====================================================================
-- The two functions below are the only writers of `objective_evidence`. They
-- run as the owner (SECURITY DEFINER) on events that have already passed every
-- authorization check the platform has: a `lesson_progress` row exists only
-- because the learner reached the lesson, and an `assessment_attempts` row is
-- `submitted` only because the learner sat it and the database scored it.
--
-- So evidence cannot be forged by anyone, including a compromised application
-- process, without first performing the real educational act. That is a
-- stronger property than validating an evidence payload would be, and it is the
-- reason `edu_app` has no INSERT privilege on the table at all.

/**
 * A completed lesson is evidence for every objective of that lesson.
 *
 * `completed` only. `in_progress` is engagement, not evidence — 0018 already
 * records it, and a row saying "opened the page" would be the fake progress
 * this task is told to avoid. Completion is learner-authored and forward-only
 * (0018), so it is a durable claim rather than a page view.
 */
CREATE FUNCTION emit_lesson_completion_evidence() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status <> 'completed' THEN
    RETURN NULL;
  END IF;
  -- Only on the TRANSITION into completed. 0018 makes `completed` terminal, so
  -- this can fire at most once per row in practice; the guard makes that true
  -- by construction rather than by relying on it.
  IF TG_OP = 'UPDATE' AND OLD.status = 'completed' THEN
    RETURN NULL;
  END IF;

  INSERT INTO objective_evidence
    (user_id, objective_id, evidence_type, source_kind, source_id, occurred_at)
  SELECT NEW.user_id, o.id, 'lesson_completed', 'lesson_progress', NEW.id,
         COALESCE(NEW.completed_at, now())
    FROM learning_objectives o
   WHERE o.lesson_id = NEW.lesson_id
  -- The unique index is the idempotency, and this is what makes a retry a
  -- no-op rather than an error the caller has to interpret.
  ON CONFLICT (user_id, objective_id, source_kind, source_id) DO NOTHING;

  RETURN NULL;
END
$$;

CREATE TRIGGER lesson_progress_emits_evidence
  AFTER INSERT OR UPDATE ON lesson_progress
  FOR EACH ROW EXECUTE FUNCTION emit_lesson_completion_evidence();

/**
 * A submitted attempt is evidence for every objective of its lesson.
 *
 * ON SUBMISSION, NOT ON RELEASE. Withholding a result from a learner (Task 009)
 * is a decision about what the CHILD is told; it is not a claim that the child
 * did not sit the paper. Tying evidence to release would mean an unreleased
 * result silently erased the learning it recorded, and a teacher looking at
 * their class would see a hole where a completed quiz was.
 *
 * `passed` is read from the row the database itself computed in the submit
 * guard (0019/0020). Nothing here re-scores, re-thresholds, or re-reads an
 * answer key — there is exactly one scoring engine on this platform and it is
 * `app_score_attempt`.
 */
CREATE FUNCTION emit_assessment_evidence() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  target_lesson uuid;
BEGIN
  IF NEW.status <> 'submitted' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'submitted' THEN
    -- A release is an UPDATE on an already-submitted attempt. It must not emit
    -- a second round of evidence, and it must not re-date the first.
    RETURN NULL;
  END IF;

  target_lesson := app_attempt_lesson(NEW.id);
  IF target_lesson IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO objective_evidence
    (user_id, objective_id, evidence_type, source_kind, source_id, occurred_at)
  SELECT NEW.user_id, o.id,
         CASE WHEN NEW.passed THEN 'assessment_passed' ELSE 'assessment_not_passed' END,
         'assessment_attempt', NEW.id,
         COALESCE(NEW.submitted_at, now())
    FROM learning_objectives o
   WHERE o.lesson_id = target_lesson
  ON CONFLICT (user_id, objective_id, source_kind, source_id) DO NOTHING;

  RETURN NULL;
END
$$;

CREATE TRIGGER assessment_attempts_emit_evidence
  AFTER INSERT OR UPDATE ON assessment_attempts
  FOR EACH ROW EXECUTE FUNCTION emit_assessment_evidence();

-- =====================================================================
-- Who may read a learner's evidence
-- =====================================================================

/**
 * The same five readers as `lesson_progress`, through the same helpers.
 *
 * It is the same question about the same child — "who may look at what this
 * learner did?" — and a second, subtly different answer would be a
 * disagreement waiting to be exploited from whichever side is looser, not extra
 * safety. The only difference is that the lesson is reached through the
 * objective rather than held directly.
 *
 * Extracted rather than written inline because the mastery function below needs
 * the identical predicate, and 0020 (VULN-030) is the record of what happens
 * when a policy predicate and its second caller drift apart.
 *
 * It takes the ROW'S COLUMNS rather than looking the row up, for the reason
 * VULN-030 documents: a STABLE function reading its own table cannot see a row
 * the current statement is inserting, and `INSERT ... RETURNING` would refuse.
 */
CREATE FUNCTION app_actor_may_read_objective_evidence(p_user_id uuid, p_objective_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $$
  SELECT app_actor_is_platform_operator()
      -- Unconditional, and deliberately not gated on current class access: a
      -- learner keeps the record of what they demonstrated. Same retention rule
      -- as 0018 and 0019.
      OR p_user_id = app_current_actor()
      OR app_actor_guards(p_user_id)
      OR app_actor_observes_learner_lesson(p_user_id, app_objective_lesson(p_objective_id))
      OR (
        app_actor_holds_role('admin')
        AND app_user_organization(p_user_id) IS NOT NULL
        AND app_user_organization(p_user_id) = app_actor_organization()
      );
$$;

/**
 * The names around an objective, for a reader who may see the EVIDENCE but not
 * the CONTENT.
 *
 * Exactly the problem `app_lesson_label` solved in 0018, one level down. A
 * verified guardian has no content access at all, and a learner who has left a
 * class loses theirs — so a query that JOINED `lessons`, `course_units` and
 * `courses` to label an objective would return ZERO ROWS for precisely the two
 * readers the retention rule exists to protect. A guardian would be told their
 * child has demonstrated nothing; a learner would watch their own record empty
 * itself when a timetable changed.
 *
 * THE DISCLOSURE THIS MAKES, stated plainly: whoever can read an evidence row
 * learns the objective STATEMENT and the lesson, unit and course names attached
 * to it. That is bounded by the evidence row's own visibility — the learner,
 * their verified guardian, their teacher for that class, an administrator of
 * their school — and it is the minimum that makes "you have demonstrated this"
 * mean anything. It discloses no lesson CONTENT: the body and the links stay
 * behind `lessons_select`.
 *
 * Every column is table-qualified. A `RETURNS TABLE` output name that collides
 * with a column is the ambiguity behind VULN-008.
 */
CREATE FUNCTION app_objective_label(p_objective_id uuid)
  RETURNS TABLE (
    statement       text,
    -- `objective_position`, not `position`: PostgreSQL treats `position` as a
    -- reserved word and a RETURNS TABLE column named that is a syntax error.
    -- Same collision 0020 hit.
    objective_position integer,
    lesson_id       uuid,
    lesson_title    text,
    unit_id         uuid,
    unit_title      text,
    unit_position   integer,
    course_id       uuid,
    course_title    text
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT o.statement, o.position, l.id, l.title, u.id, u.title, u.position, c.id, c.title
    FROM learning_objectives o
    JOIN lessons l      ON l.id = o.lesson_id
    JOIN course_units u ON u.id = l.unit_id
    JOIN courses c      ON c.id = u.course_id
   WHERE o.id = p_objective_id;
$$;

-- =====================================================================
-- Mastery — derived, deterministic, and explainable in five lines
-- =====================================================================

/**
 * A learner's mastery of one objective.
 *
 * DERIVED, NOT STORED. There is no `mastery` column anywhere in this schema, so
 * there is nothing for a client to forge, nothing for a service to write, and
 * no possibility of a stored level disagreeing with the evidence it claims to
 * summarise. The cost is a query per objective; the benefit is that "why does
 * it say that?" is always answerable by listing the rows.
 *
 * THE RULES, in full:
 *
 *   no_evidence   no evidence rows at all.
 *   attempted     evidence exists, but none of it is a COUNTABLE assessment
 *                 outcome — a completed lesson, or an attempt whose result the
 *                 reader may not yet see.
 *   developing    countable assessment outcomes exist; none of them passed.
 *   demonstrated  exactly ONE distinct assessment passed.
 *   mastered      TWO OR MORE DISTINCT assessments passed.
 *
 * DISTINCT BY ASSESSMENT, not by attempt, and that is the load-bearing word.
 * Passing the same quiz three times is one piece of evidence repeated; passing
 * two different assessments that cover the objective is genuinely stronger. If
 * attempts were counted instead, `mastered` would mean "sat the same paper
 * twice", which is a claim about persistence rather than understanding.
 *
 * IT NEVER GOES DOWN. Every rule counts things that only accumulate, so a later
 * failure adds a row without removing a pass, and no amount of elapsed time
 * changes anything. There is no decay in this model — not because forgetting
 * is not real, but because a decay curve is a claim about a child that this
 * platform has no evidence to support.
 *
 * THE WITHHELD-RESULT RULE. An attempt whose result has not been released
 * counts as `attempted` FOR THE SUBJECT AND THEIR GUARDIAN, and as its true
 * outcome for everybody else. Task 009 withholds a mark from the child until a
 * teacher releases it; a mastery state that jumped to `demonstrated` on
 * submission would announce the mark through a different endpoint, and a state
 * that read `developing` would announce the failure. Neither the evidence nor
 * the authoritative state depends on release — a teacher sees the truth
 * immediately, and the stored rows are identical either way — only what the
 * child is shown does. It is the same expression that redacts the score columns
 * in `assessment.repository.ts` and gates `app_attempt_review`, so all three
 * withhold from exactly the same people.
 *
 * SELF-AUTHORIZING, like `app_attempt_review` (0020) and for the same reason:
 * it is granted to `edu_app`, so an id alone must buy nothing.
 */
CREATE FUNCTION app_objective_mastery(p_user_id uuid, p_objective_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  WITH graded AS (
    SELECT
      e.evidence_type,
      t.assessment_id,
      -- A result the reader may not see cannot count for or against them.
      (
        e.source_kind = 'assessment_attempt'
        AND (
          t.released_at IS NOT NULL
          OR NOT (e.user_id = app_current_actor() OR app_actor_guards(e.user_id))
        )
      ) AS countable
    FROM objective_evidence e
    LEFT JOIN assessment_attempts t
      ON e.source_kind = 'assessment_attempt' AND t.id = e.source_id
    WHERE e.user_id = p_user_id
      AND e.objective_id = p_objective_id
      AND app_actor_may_read_objective_evidence(p_user_id, p_objective_id)
  ),
  tally AS (
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE countable) AS assessed,
      count(DISTINCT assessment_id)
        FILTER (WHERE countable AND evidence_type = 'assessment_passed') AS passed_assessments
    FROM graded
  )
  SELECT CASE
           WHEN total = 0              THEN 'no_evidence'
           WHEN assessed = 0           THEN 'attempted'
           WHEN passed_assessments = 0 THEN 'developing'
           WHEN passed_assessments = 1 THEN 'demonstrated'
           ELSE                             'mastered'
         END
    FROM tally;
$$;

REVOKE ALL ON FUNCTION app_objective_mastery(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_may_read_objective_evidence(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_objective_lesson(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_lesson_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_objective_label(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_objective_mastery(uuid, uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_may_read_objective_evidence(uuid, uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_objective_lesson(uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_lesson_status(uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_objective_label(uuid) TO edu_app;

-- =====================================================================
-- Row-level security
-- =====================================================================

-- --- learning_objectives -------------------------------------------------
-- An objective is CONTENT, and inherits its lesson's visibility exactly. It is
-- not a new disclosure: 0016 already returned these statements to anyone who
-- could read the lesson, as an array on the lesson row.
CREATE POLICY learning_objectives_select ON learning_objectives FOR SELECT TO edu_app
  USING (app_actor_is_platform_operator() OR app_actor_sees_lesson(lesson_id));

-- Authoring follows the lesson's own write rule, through the same helpers, so
-- an author who may edit a lesson may edit its objectives and nobody else can.
CREATE POLICY learning_objectives_insert ON learning_objectives FOR INSERT TO edu_app
  WITH CHECK (
    (NOT app_course_is_global(app_lesson_course(lesson_id))
      AND app_course_organization(app_lesson_course(lesson_id)) = app_actor_organization()
      AND app_actor_authors_content())
    OR (app_course_is_global(app_lesson_course(lesson_id))
      AND app_actor_is_platform_operator())
  );

CREATE POLICY learning_objectives_update ON learning_objectives FOR UPDATE TO edu_app
  USING (
    (NOT app_course_is_global(app_lesson_course(lesson_id))
      AND app_course_organization(app_lesson_course(lesson_id)) = app_actor_organization()
      AND app_actor_authors_content())
    OR (app_course_is_global(app_lesson_course(lesson_id))
      AND app_actor_is_platform_operator())
  )
  WITH CHECK (
    (NOT app_course_is_global(app_lesson_course(lesson_id))
      AND app_course_organization(app_lesson_course(lesson_id)) = app_actor_organization()
      AND app_actor_authors_content())
    OR (app_course_is_global(app_lesson_course(lesson_id))
      AND app_actor_is_platform_operator())
  );

-- DELETE is confined to DRAFT lessons, matching 0016's rule for lessons
-- themselves. Once a lesson is published a learner may have demonstrated its
-- objectives, and removing one would cascade away their evidence — deleting a
-- record of what a child did in order to tidy a content tree.
CREATE POLICY learning_objectives_delete ON learning_objectives FOR DELETE TO edu_app
  USING (
    app_lesson_status(lesson_id) = 'draft'
    AND (
      (NOT app_course_is_global(app_lesson_course(lesson_id))
        AND app_course_organization(app_lesson_course(lesson_id)) = app_actor_organization()
        AND app_actor_authors_content())
      OR (app_course_is_global(app_lesson_course(lesson_id))
        AND app_actor_is_platform_operator())
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON learning_objectives TO edu_app;

-- --- objective_evidence --------------------------------------------------
CREATE POLICY objective_evidence_select ON objective_evidence FOR SELECT TO edu_app
  USING (app_actor_may_read_objective_evidence(user_id, objective_id));

-- NO INSERT, UPDATE OR DELETE POLICY, and no such privilege below.
--
-- This is the strongest statement in the migration. `edu_app` — the role the
-- entire application runs as — cannot write this table by any statement, so
-- every attack in §15 of the task ("client inserts evidence directly", "client
-- changes evidence timestamp", "client changes evidence owner", "client changes
-- objective association") is refused by a missing privilege rather than by a
-- check somebody could get wrong. Evidence exists only because a trigger
-- observed a real educational event.
GRANT SELECT ON objective_evidence TO edu_app;
