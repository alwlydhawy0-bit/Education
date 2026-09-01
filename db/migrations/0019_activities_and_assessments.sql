-- =====================================================================
-- 0019 — Learning activities and objective assessments
-- =====================================================================
-- This migration adds the platform's first surface where the SERVER MAKES A
-- JUDGEMENT ABOUT A CHILD. Everything before it recorded facts somebody
-- asserted: a roster entry an administrator made, a progress row the learner
-- wrote about themselves. A score is different — the system computes it, the
-- learner cannot argue with it, and a teacher will act on it.
--
-- Three properties shape every table below.
--
-- 1. THE ANSWER KEY IS NOT A COLUMN, IT IS A TABLE.
--
--    `assessment_options` holds what a learner is shown. `assessment_answer_keys`
--    holds which of them is right, in a separate relation with its own policy
--    that no learner branch can satisfy. Storing correctness as a boolean on the
--    option row would make non-disclosure a matter of every SELECT list in the
--    codebase being written carefully forever — a discipline, not a boundary.
--    A separate table with its own RLS is a boundary: a learner's connection
--    cannot read the key even with arbitrary SQL.
--
-- 2. THE SCORE IS COMPUTED BY THE DATABASE, NOT SUBMITTED TO IT.
--
--    `assessment_attempt_submit_guard` OVERWRITES score, max_score, percentage,
--    passed and submitted_at with values it derives itself, on every transition
--    into `submitted`. The application does not calculate a score and pass it
--    down; it sets `status = 'submitted'` and the database fills in the rest.
--    So a forged score cannot land even from a fully compromised application
--    layer — there is no code path, correct or malicious, that writes one.
--
-- 3. A SUBMITTED ATTEMPT IS FROZEN.
--
--    No column of it may change afterwards, and its answers may not be added to,
--    altered or removed. Enforced by a trigger (which can see OLD) and by the
--    absence of grants (there is no DELETE on any table here).
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO: grading by a human, free-text
-- answers, partial credit, mastery, or any roll-up beyond one attempt's own
-- score. Those are later tasks and the shapes here do not presume them.
-- =====================================================================

-- =====================================================================
-- learning_activities — the generic boundary under a lesson
-- =====================================================================
-- An activity is the extension point every future practical feature hangs off:
-- a 2D chemistry simulation, a physics experiment, an exercise set, a research
-- task. NONE of those exist yet, and this table is deliberately ignorant of
-- them — it carries identity, a lesson, a type, ordering and a lifecycle, and
-- nothing that presumes what an activity DOES.
--
-- `activity_type` is a CHECK over a named set rather than a foreign key to a
-- types table. A new type is then a one-line migration that a reviewer reads in
-- full, instead of a row somebody inserts at runtime — and an activity type is
-- an authorization-relevant fact (it decides which sub-table and which rules
-- apply), so it should not be data anybody can add.
--
-- TENANCY IS NOT STORED. It is derived from the lesson's course, through the
-- existing helpers. A denormalized copy would be a second source of truth for
-- the question "whose content is this?", and the answer is already settled two
-- levels up.
CREATE TABLE learning_activities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id     uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  position      integer NOT NULL,
  activity_type text NOT NULL,
  title         text NOT NULL,
  instructions  text NOT NULL DEFAULT '',

  status        text NOT NULL DEFAULT 'draft',
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  archived_at   timestamptz,

  CONSTRAINT learning_activities_position_ck CHECK (position >= 1),
  CONSTRAINT learning_activities_title_ck    CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT learning_activities_instructions_ck CHECK (length(instructions) <= 8000),
  -- The extensible set. `assessment` is the only one with an implementation in
  -- this task; the rest are declared so the vocabulary is decided once, and so
  -- that adding the 2D experiment engine later is a new module rather than a
  -- new shape for this table.
  CONSTRAINT learning_activities_type_ck CHECK (
    activity_type IN ('assessment', 'practice', 'exercise', 'simulation', 'experiment', 'research_task')
  ),
  CONSTRAINT learning_activities_status_ck CHECK (status IN ('draft', 'published', 'archived')),
  -- Identical to the content tables', so `content_lifecycle_guard` — which
  -- compares `to_jsonb(NEW)` minus the lifecycle columns — is correct here
  -- without modification.
  CONSTRAINT learning_activities_published_consistency_ck
    CHECK ((status = 'published') = (published_at IS NOT NULL AND archived_at IS NULL)),
  CONSTRAINT learning_activities_archived_consistency_ck
    CHECK ((status = 'archived') = (archived_at IS NOT NULL)),

  CONSTRAINT learning_activities_position_uk UNIQUE (lesson_id, position) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX learning_activities_lesson_idx ON learning_activities (lesson_id, position);

-- =====================================================================
-- assessments — the assessment-shaped extension of an activity
-- =====================================================================
-- 1:1 with an activity of type `assessment`, and WITHOUT A LIFECYCLE OF ITS
-- OWN. The activity's status is the assessment's status.
--
-- That is a deliberate reduction of the state space. Two independently
-- publishable rows describing one thing a learner sees can disagree — a
-- published activity wrapping a draft assessment, or the reverse — and every
-- such combination would need a rule. Here there is one lifecycle, one gate,
-- and no combination to reason about.
--
-- `max_attempts` HAS NO "UNLIMITED" VALUE, on purpose. An assessment a learner
-- may attempt without bound is an answer-key oracle: submit, read the score,
-- vary one answer, repeat. The attempt limit is the primary control against
-- that, and rate limiting is only a secondary one (it is per-IP, and a
-- classroom shares an IP). See docs/security/limitations.md.
CREATE TABLE assessments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id     uuid NOT NULL UNIQUE REFERENCES learning_activities(id) ON DELETE CASCADE,

  -- Percentage, not a raw mark: the maximum score is derived from the questions
  -- and changes when one is added, so a raw threshold would silently drift.
  passing_percentage integer NOT NULL DEFAULT 50,
  max_attempts       integer NOT NULL DEFAULT 1,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT assessments_passing_ck  CHECK (passing_percentage BETWEEN 0 AND 100),
  CONSTRAINT assessments_attempts_ck CHECK (max_attempts BETWEEN 1 AND 50)
);

-- =====================================================================
-- assessment_questions / assessment_options / assessment_answer_keys
-- =====================================================================
-- Three tables where a simpler design would have used one, and the split IS the
-- security control. See the header.
--
-- `question_type` is again a CHECK over a named set. Only objective types
-- exist: the server can score them without judgement, which is the whole reason
-- this task can compute a result at all. Free text, essays and code are absent
-- because scoring them is a different problem with a different threat model.
CREATE TABLE assessment_questions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  position      integer NOT NULL,
  question_type text NOT NULL,
  prompt        text NOT NULL,
  -- All-or-nothing per question. Partial credit is a policy decision with
  -- pedagogical consequences and no obvious right answer for multiple-choice;
  -- it is not being made silently here.
  points        integer NOT NULL DEFAULT 1,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT assessment_questions_position_ck CHECK (position >= 1),
  CONSTRAINT assessment_questions_points_ck   CHECK (points BETWEEN 1 AND 100),
  CONSTRAINT assessment_questions_prompt_ck   CHECK (length(btrim(prompt)) BETWEEN 1 AND 4000),
  CONSTRAINT assessment_questions_type_ck
    CHECK (question_type IN ('single_choice', 'multiple_choice', 'true_false')),

  CONSTRAINT assessment_questions_position_uk UNIQUE (assessment_id, position) DEFERRABLE INITIALLY IMMEDIATE,
  -- Referenced by the composite foreign key on `assessment_attempt_answers`.
  -- That FK is what makes "this question belongs to this assessment" a
  -- structural fact rather than something a handler has to remember to check.
  CONSTRAINT assessment_questions_assessment_uk UNIQUE (assessment_id, id)
);

CREATE INDEX assessment_questions_assessment_idx ON assessment_questions (assessment_id, position);

-- What a learner is SHOWN. Nothing here says which one is right.
CREATE TABLE assessment_options (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES assessment_questions(id) ON DELETE CASCADE,
  position    integer NOT NULL,
  body        text NOT NULL,

  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT assessment_options_position_ck CHECK (position >= 1),
  CONSTRAINT assessment_options_body_ck     CHECK (length(btrim(body)) BETWEEN 1 AND 1000),
  CONSTRAINT assessment_options_position_uk UNIQUE (question_id, position) DEFERRABLE INITIALLY IMMEDIATE,
  -- Lets the key and the submitted answers both reference (question, option) as
  -- a pair, so an option can never be attached to a question it does not
  -- belong to. This is the structural answer to "student manipulates question
  -- identifiers".
  CONSTRAINT assessment_options_question_uk UNIQUE (question_id, id)
);

CREATE INDEX assessment_options_question_idx ON assessment_options (question_id, position);

/**
 * THE ANSWER KEY.
 *
 * One row per CORRECT option. A question's key is the set of its rows, so a
 * single-choice question has one and a multiple-choice question has several,
 * without a nullable column or an array to keep consistent.
 *
 * The composite foreign key means a key row can only ever name an option of its
 * own question. There is no trigger to forget and no check to get wrong.
 *
 * Its RLS policy has NO learner branch at all — not a narrowed one. See the
 * policy at the foot of this file.
 */
CREATE TABLE assessment_answer_keys (
  question_id uuid NOT NULL REFERENCES assessment_questions(id) ON DELETE CASCADE,
  option_id   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (question_id, option_id),
  CONSTRAINT assessment_answer_keys_option_fk
    FOREIGN KEY (question_id, option_id)
    REFERENCES assessment_options (question_id, id) ON DELETE CASCADE
);

-- =====================================================================
-- assessment_attempts — one learner's attempt at one assessment
-- =====================================================================
-- Every authoritative column here is written by the database, never by the
-- application: `attempt_number` by an insert trigger, and score, max_score,
-- percentage, passed and submitted_at by the submit trigger. The application
-- supplies exactly two things, the assessment and `status = 'submitted'`, and
-- the learner is taken from the session.
CREATE TABLE assessment_attempts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id  uuid NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,

  status         text NOT NULL DEFAULT 'in_progress',
  started_at     timestamptz NOT NULL DEFAULT now(),
  submitted_at   timestamptz,

  score          integer,
  max_score      integer,
  percentage     numeric(5,2),
  passed         boolean,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT assessment_attempts_status_ck CHECK (status IN ('in_progress', 'submitted')),
  CONSTRAINT assessment_attempts_number_ck CHECK (attempt_number >= 1),

  -- The result columns exist together or not at all, AND ONLY ON A SUBMITTED
  -- ROW. Stated as a CASE rather than as an equivalence, because the
  -- equivalence has a hole: for an in-progress row carrying a score but no
  -- `submitted_at`, both sides evaluate false and the row is admitted. The
  -- triggers below happen to null the result block on every path that exists
  -- today, but a constraint that permits a state only a trigger prevents is
  -- one dropped trigger away from being wrong — and this one would be wrong
  -- about a child's mark. Found by probing this migration before any
  -- application code was written; see VULN-026.
  CONSTRAINT assessment_attempts_result_consistency_ck CHECK (
    CASE status
      WHEN 'submitted' THEN
        submitted_at IS NOT NULL AND score IS NOT NULL AND max_score IS NOT NULL
        AND percentage IS NOT NULL AND passed IS NOT NULL
      ELSE
        submitted_at IS NULL AND score IS NULL AND max_score IS NULL
        AND percentage IS NULL AND passed IS NULL
    END
  ),
  -- The score bounds, stated as constraints rather than trusted to the code
  -- that computes them. A negative score, or one above the maximum, cannot be
  -- stored even by a direct statement from the migration role.
  CONSTRAINT assessment_attempts_score_ck CHECK (score IS NULL OR score >= 0),
  CONSTRAINT assessment_attempts_max_score_ck CHECK (max_score IS NULL OR max_score >= 0),
  CONSTRAINT assessment_attempts_score_bound_ck
    CHECK (score IS NULL OR max_score IS NULL OR score <= max_score),
  CONSTRAINT assessment_attempts_percentage_ck
    CHECK (percentage IS NULL OR (percentage >= 0 AND percentage <= 100)),

  CONSTRAINT assessment_attempts_number_uk UNIQUE (assessment_id, user_id, attempt_number)
);

CREATE INDEX assessment_attempts_user_idx ON assessment_attempts (user_id, started_at DESC);
CREATE INDEX assessment_attempts_assessment_idx ON assessment_attempts (assessment_id);

/**
 * What the learner selected.
 *
 * One row per selected option, so a duplicate selection is a primary-key
 * collision rather than a value the scorer has to normalize, and the composite
 * foreign key means a selected option always belongs to the question it is
 * recorded against.
 *
 * There is no `updated_at` and no UPDATE grant. An answer is written once,
 * inside the submitting transaction, and is thereafter part of the frozen
 * attempt.
 */
CREATE TABLE assessment_attempt_answers (
  attempt_id   uuid NOT NULL REFERENCES assessment_attempts(id) ON DELETE CASCADE,
  question_id  uuid NOT NULL REFERENCES assessment_questions(id) ON DELETE CASCADE,
  option_id    uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (attempt_id, question_id, option_id),
  CONSTRAINT assessment_attempt_answers_option_fk
    FOREIGN KEY (question_id, option_id)
    REFERENCES assessment_options (question_id, id) ON DELETE CASCADE
);

-- =====================================================================
-- Definer policies
-- =====================================================================
-- FORCE ROW LEVEL SECURITY binds the owner too, and every SECURITY DEFINER
-- helper below runs AS the owner. Each table one of them reads therefore needs
-- an `edu_migrator` policy, or the helper answers false in silence — VULN-007
-- and VULN-012, which is why these come before anything that reads them.
-- =====================================================================

ALTER TABLE learning_activities        ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_activities        FORCE  ROW LEVEL SECURITY;
ALTER TABLE assessments                ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessments                FORCE  ROW LEVEL SECURITY;
ALTER TABLE assessment_questions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_questions       FORCE  ROW LEVEL SECURITY;
ALTER TABLE assessment_options         ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_options         FORCE  ROW LEVEL SECURITY;
ALTER TABLE assessment_answer_keys     ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_answer_keys     FORCE  ROW LEVEL SECURITY;
ALTER TABLE assessment_attempts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_attempts        FORCE  ROW LEVEL SECURITY;
ALTER TABLE assessment_attempt_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_attempt_answers FORCE  ROW LEVEL SECURITY;

CREATE POLICY learning_activities_definer_select
  ON learning_activities FOR SELECT TO edu_migrator USING (true);
CREATE POLICY assessments_definer_select
  ON assessments FOR SELECT TO edu_migrator USING (true);
CREATE POLICY assessment_questions_definer_select
  ON assessment_questions FOR SELECT TO edu_migrator USING (true);
CREATE POLICY assessment_options_definer_select
  ON assessment_options FOR SELECT TO edu_migrator USING (true);
CREATE POLICY assessment_answer_keys_definer_select
  ON assessment_answer_keys FOR SELECT TO edu_migrator USING (true);
CREATE POLICY assessment_attempts_definer_select
  ON assessment_attempts FOR SELECT TO edu_migrator USING (true);
CREATE POLICY assessment_attempt_answers_definer_select
  ON assessment_attempt_answers FOR SELECT TO edu_migrator USING (true);

-- The submit trigger writes the computed result back through the owner, so the
-- owner needs an UPDATE policy of its own — the trigger runs as the invoker,
-- but `app_score_attempt` below does not.
CREATE POLICY assessment_attempts_definer_update
  ON assessment_attempts FOR UPDATE TO edu_migrator USING (true) WITH CHECK (true);

-- =====================================================================
-- Visibility helpers — INVOKER, deliberately
-- =====================================================================
-- These four are the unusual ones in this codebase: they are NOT
-- `SECURITY DEFINER`. They run as the caller, so the query inside each is
-- subject to the policies of the table it reads.
--
-- That is the entire point. "May this actor see this lesson?" is already
-- answered, exactly and in one place, by `lessons_select` — a policy that took
-- three migrations and two vulnerabilities to get right. Restating it here as a
-- definer helper would create a second copy that could drift from the first,
-- and the drift would be invisible because each copy would have its own tests.
-- Asking the table instead means there is nothing to keep in step.
--
-- The reference graph stays acyclic: `lessons_select` does not mention
-- activities, `learning_activities_select` does not mention assessments, and so
-- on down the chain. Each helper reads strictly one level up.
--
-- `SET search_path` blocks inlining, which costs a little planning efficiency
-- and buys immunity to a search_path attack. Correctness over performance, per
-- the task's stated priority order.
-- =====================================================================

CREATE FUNCTION app_actor_sees_lesson(p_lesson_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $$ SELECT EXISTS (SELECT 1 FROM lessons l WHERE l.id = p_lesson_id) $$;

CREATE FUNCTION app_actor_sees_activity(p_activity_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $$ SELECT EXISTS (SELECT 1 FROM learning_activities a WHERE a.id = p_activity_id) $$;

CREATE FUNCTION app_actor_sees_assessment(p_assessment_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $$ SELECT EXISTS (SELECT 1 FROM assessments s WHERE s.id = p_assessment_id) $$;

CREATE FUNCTION app_actor_sees_question(p_question_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $$ SELECT EXISTS (SELECT 1 FROM assessment_questions q WHERE q.id = p_question_id) $$;

REVOKE ALL ON FUNCTION app_actor_sees_lesson(uuid)     FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_sees_activity(uuid)   FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_sees_assessment(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_sees_question(uuid)   FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_actor_sees_lesson(uuid)     TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_sees_activity(uuid)   TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_sees_assessment(uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_sees_question(uuid)   TO edu_app;

-- =====================================================================
-- Structural helpers — DEFINER
-- =====================================================================
-- These answer structural questions ("which lesson is this activity on?") that
-- must have the same answer for everybody. A visibility-dependent answer here
-- would make a trigger refuse a legitimate write because the writer happens not
-- to be able to SEE something — the reasoning behind
-- `course_curriculum_is_in_scope` in 0016.
-- =====================================================================

/** The lesson an activity hangs off. NULL only when the activity is absent. */
CREATE FUNCTION app_activity_lesson(p_activity_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT a.lesson_id FROM learning_activities a WHERE a.id = p_activity_id $$;

/** The activity an assessment extends. */
CREATE FUNCTION app_assessment_activity(p_assessment_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT s.activity_id FROM assessments s WHERE s.id = p_assessment_id $$;

/** The lesson an assessment ultimately sits under, two hops up. */
CREATE FUNCTION app_assessment_lesson(p_assessment_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT a.lesson_id
    FROM assessments s JOIN learning_activities a ON a.id = s.activity_id
   WHERE s.id = p_assessment_id;
$$;

/** The assessment an attempt belongs to. */
CREATE FUNCTION app_attempt_assessment(p_attempt_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT t.assessment_id FROM assessment_attempts t WHERE t.id = p_attempt_id $$;

/** The learner an attempt belongs to. Used by the answer-write guard. */
CREATE FUNCTION app_attempt_owner(p_attempt_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT t.user_id FROM assessment_attempts t WHERE t.id = p_attempt_id $$;

/** The lesson an attempt's assessment sits under. */
CREATE FUNCTION app_attempt_lesson(p_attempt_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT a.lesson_id
    FROM assessment_attempts t
    JOIN assessments s            ON s.id = t.assessment_id
    JOIN learning_activities a    ON a.id = s.activity_id
   WHERE t.id = p_attempt_id;
$$;

/**
 * The organization that owns the content a question belongs to.
 *
 * NULL for the global catalog AND for a question that does not exist — the two
 * are separated by `app_actor_sees_question` where it matters. Used by the
 * answer-key policy to confine an editor to their own school.
 */
CREATE FUNCTION app_question_organization(p_question_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT co.organization_id
    FROM assessment_questions q
    JOIN assessments s         ON s.id = q.assessment_id
    JOIN learning_activities a ON a.id = s.activity_id
    JOIN lessons l             ON l.id = a.lesson_id
    JOIN course_units u        ON u.id = l.unit_id
    JOIN courses co            ON co.id = u.course_id
   WHERE q.id = p_question_id;
$$;

/**
 * The same, for an assessment.
 *
 * Needed because a question's own organization cannot be asked BEFORE the
 * question row exists, and its insert policy has to confine the author to their
 * own school.
 */
CREATE FUNCTION app_assessment_organization(p_assessment_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT co.organization_id
    FROM assessments s
    JOIN learning_activities a ON a.id = s.activity_id
    JOIN lessons l             ON l.id = a.lesson_id
    JOIN course_units u        ON u.id = l.unit_id
    JOIN courses co            ON co.id = u.course_id
   WHERE s.id = p_assessment_id;
$$;

/** The same, for an activity. Drives the editorial branch of its policy. */
CREATE FUNCTION app_activity_organization(p_activity_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT co.organization_id
    FROM learning_activities a
    JOIN lessons l      ON l.id = a.lesson_id
    JOIN course_units u ON u.id = l.unit_id
    JOIN courses co     ON co.id = u.course_id
   WHERE a.id = p_activity_id;
$$;

/**
 * The names around an assessment, for rendering a result row.
 *
 * A DEFINER function rather than a join, and the reason is the same one that
 * produced `app_lesson_label` in 0018 — VULN-024, arrived at again by probing.
 *
 * A learner keeps every attempt they submitted (`assessment_attempts_select`
 * admits the owner unconditionally) but loses sight of the assessment itself
 * the moment their class membership ends. So an endpoint that joined
 * `assessments` to label a result with "which quiz was this?" would return
 * ZERO ROWS for exactly the learner whose history the retention rule exists to
 * protect — silently erasing their marks from their own view while the rows sat
 * intact. The same is true for a verified guardian, who has no content access
 * at all.
 *
 * THE DISCLOSURE THIS MAKES: whoever can read an attempt learns the titles
 * around it and the percentage that was needed to pass. It discloses no
 * question, no option and — obviously — no key. Bounded by the attempt's own
 * visibility: the learner, their verified guardian, their teacher for that
 * class, an administrator of their school.
 *
 * Every column is table-qualified, because a `RETURNS TABLE` output name that
 * collides with a column is the ambiguity behind VULN-008.
 */
CREATE FUNCTION app_assessment_label(p_assessment_id uuid)
  RETURNS TABLE (
    activity_title     text,
    lesson_id          uuid,
    lesson_title       text,
    course_id          uuid,
    course_title       text,
    passing_percentage integer
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT a.title, l.id, l.title, co.id, co.title, s.passing_percentage
    FROM assessments s
    JOIN learning_activities a ON a.id = s.activity_id
    JOIN lessons l             ON l.id = a.lesson_id
    JOIN course_units u        ON u.id = l.unit_id
    JOIN courses co            ON co.id = u.course_id
   WHERE s.id = p_assessment_id;
$$;

/** Whether an activity exists at all, regardless of who is asking. */
CREATE FUNCTION app_activity_exists(p_activity_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT EXISTS (SELECT 1 FROM learning_activities a WHERE a.id = p_activity_id) $$;

/**
 * How many attempts a learner has already made at an assessment.
 *
 * DEFINER because it must count rows the learner can see AND any they cannot;
 * an attempt that RLS hid from the counter would hand out a free extra attempt.
 */
CREATE FUNCTION app_attempt_count(p_assessment_id uuid, p_user_id uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::integer FROM assessment_attempts t
   WHERE t.assessment_id = p_assessment_id AND t.user_id = p_user_id;
$$;

REVOKE ALL ON FUNCTION app_activity_lesson(uuid)          FROM PUBLIC;
REVOKE ALL ON FUNCTION app_assessment_activity(uuid)      FROM PUBLIC;
REVOKE ALL ON FUNCTION app_assessment_lesson(uuid)        FROM PUBLIC;
REVOKE ALL ON FUNCTION app_attempt_assessment(uuid)       FROM PUBLIC;
REVOKE ALL ON FUNCTION app_attempt_owner(uuid)            FROM PUBLIC;
REVOKE ALL ON FUNCTION app_attempt_lesson(uuid)           FROM PUBLIC;
REVOKE ALL ON FUNCTION app_question_organization(uuid)    FROM PUBLIC;
REVOKE ALL ON FUNCTION app_assessment_organization(uuid)  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_activity_organization(uuid)    FROM PUBLIC;
REVOKE ALL ON FUNCTION app_assessment_label(uuid)         FROM PUBLIC;
REVOKE ALL ON FUNCTION app_activity_exists(uuid)          FROM PUBLIC;
REVOKE ALL ON FUNCTION app_attempt_count(uuid, uuid)      FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_activity_lesson(uuid)       TO edu_app;
GRANT EXECUTE ON FUNCTION app_assessment_activity(uuid)   TO edu_app;
GRANT EXECUTE ON FUNCTION app_assessment_lesson(uuid)     TO edu_app;
GRANT EXECUTE ON FUNCTION app_attempt_assessment(uuid)    TO edu_app;
GRANT EXECUTE ON FUNCTION app_attempt_owner(uuid)         TO edu_app;
GRANT EXECUTE ON FUNCTION app_attempt_lesson(uuid)        TO edu_app;
GRANT EXECUTE ON FUNCTION app_question_organization(uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_assessment_organization(uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_activity_organization(uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_assessment_label(uuid)      TO edu_app;
GRANT EXECUTE ON FUNCTION app_activity_exists(uuid)       TO edu_app;
GRANT EXECUTE ON FUNCTION app_attempt_count(uuid, uuid)   TO edu_app;

/** The activity status an assessment inherits. NULL when absent. */
CREATE FUNCTION app_assessment_status(p_assessment_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT a.status
    FROM assessments s JOIN learning_activities a ON a.id = s.activity_id
   WHERE s.id = p_assessment_id;
$$;

/** The assessment a question belongs to. */
CREATE FUNCTION app_question_assessment(p_question_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT q.assessment_id FROM assessment_questions q WHERE q.id = p_question_id $$;

/** An attempt's status, for the answer-write guard. */
CREATE FUNCTION app_attempt_status(p_attempt_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT t.status FROM assessment_attempts t WHERE t.id = p_attempt_id $$;

/**
 * The configured attempt limit, asked STRUCTURALLY.
 *
 * DEFINER rather than a plain read, so the limit is the same number whether or
 * not the asker can see the assessment. A limit check that silently passed
 * because RLS hid the row would hand out unlimited attempts in exactly the
 * situation where the caller had least standing.
 */
CREATE FUNCTION app_assessment_max_attempts(p_assessment_id uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT s.max_attempts FROM assessments s WHERE s.id = p_assessment_id $$;

CREATE FUNCTION app_assessment_passing_percentage(p_assessment_id uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT s.passing_percentage FROM assessments s WHERE s.id = p_assessment_id $$;

REVOKE ALL ON FUNCTION app_assessment_status(uuid)             FROM PUBLIC;
REVOKE ALL ON FUNCTION app_question_assessment(uuid)           FROM PUBLIC;
REVOKE ALL ON FUNCTION app_attempt_status(uuid)                FROM PUBLIC;
REVOKE ALL ON FUNCTION app_assessment_max_attempts(uuid)       FROM PUBLIC;
REVOKE ALL ON FUNCTION app_assessment_passing_percentage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assessment_status(uuid)             TO edu_app;
GRANT EXECUTE ON FUNCTION app_question_assessment(uuid)           TO edu_app;
GRANT EXECUTE ON FUNCTION app_attempt_status(uuid)                TO edu_app;
GRANT EXECUTE ON FUNCTION app_assessment_max_attempts(uuid)       TO edu_app;
GRANT EXECUTE ON FUNCTION app_assessment_passing_percentage(uuid) TO edu_app;

-- =====================================================================
-- THE SCORER
-- =====================================================================

/**
 * Computes an attempt's score from the authoritative answer key.
 *
 * SECURITY DEFINER, and it returns TWO INTEGERS. That signature is the control:
 * the answer key is read inside the database, compared inside the database, and
 * what comes back out is a number. There is no code path — not in the
 * application, not in a repository, not in a DTO — through which a learner
 * request causes the key to be loaded into application memory at all. It cannot
 * leak through a serializer that was written carelessly because it is never in
 * the serializer's reach.
 *
 * THE SCORING RULE, stated once:
 *
 *   A question is awarded its full `points` when the SET of options the learner
 *   selected is exactly the SET of options in its key. Otherwise it is awarded
 *   nothing. There is no partial credit, and there is no negative marking.
 *
 * `array_agg(... ORDER BY ...)` makes the comparison order-independent, and the
 * primary keys on both tables make it duplicate-independent — so the rule really
 * is set equality, not list equality.
 *
 * `cardinality(key) > 0` is not redundant. A question with an EMPTY key and a
 * learner who selected nothing would otherwise compare equal and be awarded
 * full marks for answering nothing. Publication validation refuses to publish
 * such a question, so this is the second gate under the first — but a scorer
 * that pays out on malformed data is the kind of defect that surfaces once, in
 * production, in a real child's mark.
 *
 * `max_score` sums every question's points regardless of what was answered, so
 * an unanswered question lowers the percentage rather than shrinking the
 * denominator.
 */
CREATE FUNCTION app_score_attempt(p_attempt_id uuid)
  RETURNS TABLE (score integer, max_score integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  WITH graded AS (
    SELECT
      q.points,
      (
        SELECT coalesce(array_agg(k.option_id ORDER BY k.option_id), '{}'::uuid[])
          FROM assessment_answer_keys k WHERE k.question_id = q.id
      ) AS key_options,
      (
        SELECT coalesce(array_agg(ans.option_id ORDER BY ans.option_id), '{}'::uuid[])
          FROM assessment_attempt_answers ans
         WHERE ans.attempt_id = p_attempt_id AND ans.question_id = q.id
      ) AS chosen_options
    FROM assessment_attempts t
    JOIN assessment_questions q ON q.assessment_id = t.assessment_id
    WHERE t.id = p_attempt_id
  )
  SELECT
    coalesce(sum(
      CASE WHEN cardinality(key_options) > 0 AND key_options = chosen_options
           THEN points ELSE 0 END
    ), 0)::integer,
    coalesce(sum(points), 0)::integer
  FROM graded;
$$;

/**
 * Whether an assessment's questions are all well formed.
 *
 * Checked at PUBLICATION, which is the only moment it can be checked once and
 * mean something: questions are immutable after publication (there is no UPDATE
 * grant, and the insert guards refuse a non-draft parent), so an assessment
 * that was well formed when it was published stays well formed.
 *
 * The rules, and why each one is a scoring-integrity rule rather than a
 * usability one:
 *
 *   - at least one question, and at most 100 — a zero-question assessment
 *     scores 0/0, which is not a result;
 *   - between 2 and 10 options per question — one option is not a choice, and
 *     an unbounded option list is an unbounded response payload;
 *   - `true_false` has exactly 2 options;
 *   - `single_choice` and `true_false` have exactly ONE key row — two correct
 *     answers to a single-choice question makes it unanswerable, since the
 *     scorer demands set equality;
 *   - `multiple_choice` has at least one key row and at least one option that
 *     is NOT in the key — a question where every option is correct cannot be
 *     got wrong, so it adds marks without measuring anything.
 */
CREATE FUNCTION app_assessment_is_well_formed(p_assessment_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  WITH q AS (
    SELECT
      qq.question_type,
      (SELECT count(*) FROM assessment_options o     WHERE o.question_id = qq.id) AS options,
      (SELECT count(*) FROM assessment_answer_keys k WHERE k.question_id = qq.id) AS keys
    FROM assessment_questions qq
    WHERE qq.assessment_id = p_assessment_id
  )
  SELECT count(*) BETWEEN 1 AND 100
     AND count(*) FILTER (WHERE
           options < 2 OR options > 10
           OR (question_type = 'true_false'   AND options <> 2)
           OR (question_type IN ('single_choice', 'true_false') AND keys <> 1)
           OR (question_type = 'multiple_choice' AND (keys < 1 OR keys >= options))
         ) = 0
  FROM q;
$$;

REVOKE ALL ON FUNCTION app_score_attempt(uuid)              FROM PUBLIC;
REVOKE ALL ON FUNCTION app_assessment_is_well_formed(uuid)  FROM PUBLIC;
-- NEITHER IS GRANTED TO edu_app, and that is load-bearing rather than tidy.
--
-- `app_score_attempt` takes an attempt id and returns that attempt's marks. It
-- consults no policy — it cannot, it is the thing the policy protects — so an
-- application role able to execute it could read ANY learner's score by id,
-- straight past `assessment_attempts_select`. Granting it "because the trigger
-- needs it" would have opened exactly the hole the rest of this file closes.
--
-- The two guards below are therefore SECURITY DEFINER: they run as the owner,
-- which is what lets them call these, and they are the only callers there are.
-- Both are short, do no dynamic SQL, pin `search_path`, and write nothing but
-- their own NEW record.

-- =====================================================================
-- Integrity triggers
-- =====================================================================

/**
 * Structural rules for an activity: what cannot move, and what publication
 * requires.
 *
 * SECURITY DEFINER so it can call `app_assessment_is_well_formed`, which is
 * granted to nobody. It reads; it never writes.
 *
 * The lifecycle itself — forward-only, and the author/publisher duty split —
 * is NOT restated here. `content_lifecycle_guard` from migration 0016 already
 * enforces it for every content table, and this table's lifecycle columns were
 * shaped to match so that function could be reused verbatim. The trigger names
 * order the two: `learning_activities_lifecycle` sorts before
 * `learning_activities_structure`, so an author lacking `content:publish` is
 * told THAT rather than being told their questions are malformed.
 */
CREATE FUNCTION learning_activity_structure_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  assessment_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.lesson_id <> OLD.lesson_id THEN
      -- Moving an activity to another lesson would move it to another course,
      -- and possibly another school — silently re-pointing every attempt
      -- recorded against it. Same reasoning as `content_ownership_is_immutable`.
      RAISE EXCEPTION 'An activity cannot be moved to another lesson'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.activity_type <> OLD.activity_type THEN
      RAISE EXCEPTION 'An activity type cannot be changed'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'Authorship cannot be reassigned'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  -- The publication gate for assessments. An assessment becomes visible to
  -- children at this instant and its questions become immutable at the same
  -- instant, so this is the one moment the whole question set can be validated
  -- once and stay valid.
  IF NEW.status = 'published'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'published')
     AND NEW.activity_type = 'assessment' THEN
    SELECT s.id INTO assessment_id FROM assessments s WHERE s.activity_id = NEW.id;
    IF assessment_id IS NULL THEN
      RAISE EXCEPTION 'An assessment activity cannot be published before its assessment exists'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT app_assessment_is_well_formed(assessment_id) THEN
      RAISE EXCEPTION 'This assessment has questions that cannot be scored fairly and cannot be published'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER learning_activities_lifecycle
  BEFORE UPDATE ON learning_activities
  FOR EACH ROW EXECUTE FUNCTION content_lifecycle_guard();

CREATE TRIGGER learning_activities_structure
  BEFORE INSERT OR UPDATE ON learning_activities
  FOR EACH ROW EXECUTE FUNCTION learning_activity_structure_guard();

/**
 * Questions, options and keys may only be written while the assessment is a
 * DRAFT.
 *
 * This is the rule that makes a mark mean something. If a question could be
 * added — or an option, or a key row — after learners had been scored, then two
 * attempts at "the same assessment" would have been marked against different
 * papers, and the earlier one could not be re-derived. It is also the reason
 * `app_assessment_is_well_formed` only has to run once: nothing it validated
 * can change afterwards.
 *
 * There is no UPDATE or DELETE grant on any of the three tables, so this guard
 * only has to cover INSERT. Correcting a published assessment means publishing
 * a new one, which keeps what each learner actually sat recoverable.
 */
CREATE FUNCTION assessment_content_is_draft_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  target_assessment uuid;
BEGIN
  IF TG_TABLE_NAME = 'assessment_questions' THEN
    target_assessment := NEW.assessment_id;
  ELSIF TG_TABLE_NAME = 'assessment_options' THEN
    target_assessment := app_question_assessment(NEW.question_id);
  ELSIF TG_TABLE_NAME = 'assessment_answer_keys' THEN
    target_assessment := app_question_assessment(NEW.question_id);
  END IF;

  IF target_assessment IS NULL THEN
    RAISE EXCEPTION 'Unknown assessment' USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF app_assessment_status(target_assessment) IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'An assessment''s questions cannot be changed after it leaves draft'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER assessment_questions_draft_only
  BEFORE INSERT ON assessment_questions
  FOR EACH ROW EXECUTE FUNCTION assessment_content_is_draft_only();
CREATE TRIGGER assessment_options_draft_only
  BEFORE INSERT ON assessment_options
  FOR EACH ROW EXECUTE FUNCTION assessment_content_is_draft_only();
CREATE TRIGGER assessment_answer_keys_draft_only
  BEFORE INSERT ON assessment_answer_keys
  FOR EACH ROW EXECUTE FUNCTION assessment_content_is_draft_only();

/**
 * An assessment's activity must be of type `assessment`, and must be a draft
 * when the assessment row is created.
 */
CREATE FUNCTION assessment_matches_activity() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  kind text;
BEGIN
  SELECT a.activity_type INTO kind FROM learning_activities a WHERE a.id = NEW.activity_id;
  IF kind IS NULL THEN
    RAISE EXCEPTION 'Unknown activity' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF kind <> 'assessment' THEN
    RAISE EXCEPTION 'Only an activity of type assessment may carry an assessment'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.activity_id <> OLD.activity_id THEN
    RAISE EXCEPTION 'An assessment cannot be moved to another activity'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER assessments_match_activity
  BEFORE INSERT OR UPDATE ON assessments
  FOR EACH ROW EXECUTE FUNCTION assessment_matches_activity();

/**
 * Starting an attempt. Every authoritative column is assigned HERE.
 *
 * `attempt_number` is computed, not accepted: whatever the caller supplied is
 * overwritten. So is the status, the start time, and the entire result block —
 * an INSERT that arrives claiming `status = 'submitted', score = 100` is stored
 * as a fresh in-progress attempt with no result, without an error and without
 * the caller learning that anything was ignored.
 *
 * The ATTEMPT LIMIT is enforced here rather than only in the service, because
 * the service is one code path and this is all of them. `app_attempt_count` is
 * a definer function on purpose: counting only the attempts the CALLER can see
 * would grant a free attempt in precisely the case where RLS had hidden one.
 *
 * The race between two concurrent starts is resolved by
 * `assessment_attempts_number_uk`: both compute the same number, one commits,
 * the other gets a unique violation that the service turns into a 409. Reading
 * the count under a lock would serialize every start on the platform to buy
 * a nicer error for a case that a retry already handles.
 */
CREATE FUNCTION assessment_attempt_start_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  used    integer;
  allowed integer;
BEGIN
  allowed := app_assessment_max_attempts(NEW.assessment_id);
  IF allowed IS NULL THEN
    RAISE EXCEPTION 'Unknown assessment' USING ERRCODE = 'foreign_key_violation';
  END IF;

  used := app_attempt_count(NEW.assessment_id, NEW.user_id);
  IF used >= allowed THEN
    RAISE EXCEPTION 'The attempt limit for this assessment has been reached'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  NEW.attempt_number := used + 1;
  NEW.status         := 'in_progress';
  NEW.started_at     := now();
  NEW.submitted_at   := NULL;
  NEW.score          := NULL;
  NEW.max_score      := NULL;
  NEW.percentage     := NULL;
  NEW.passed         := NULL;
  RETURN NEW;
END
$$;

CREATE TRIGGER assessment_attempts_start
  BEFORE INSERT ON assessment_attempts
  FOR EACH ROW EXECUTE FUNCTION assessment_attempt_start_guard();

/**
 * Submission: the database computes the result, and a submitted attempt is
 * frozen.
 *
 * THE APPLICATION DOES NOT CALCULATE A SCORE. It issues
 * `UPDATE assessment_attempts SET status = 'submitted' WHERE id = $1`, and
 * every other column of the result is assigned below from
 * `app_score_attempt`, which the application cannot execute. So a forged score
 * is not merely rejected — there is no code path, correct or compromised,
 * through which one could be written. That is a stronger claim than validation,
 * and it is the reason this logic is here rather than in TypeScript.
 *
 * SECURITY DEFINER for one reason: `app_score_attempt` is granted to nobody, so
 * only the owner may call it. See the note above its REVOKE.
 *
 * The freeze is the first thing checked. An attempt that has been submitted
 * cannot be updated at all — not its answers (they have no UPDATE grant), not
 * its status, and not its marks.
 */
CREATE FUNCTION assessment_attempt_submit_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  computed_score integer;
  computed_max   integer;
  threshold      integer;
  pct            numeric(5,2);
BEGIN
  IF OLD.status = 'submitted' THEN
    RAISE EXCEPTION 'A submitted attempt cannot be modified'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.id <> OLD.id
     OR NEW.assessment_id <> OLD.assessment_id
     OR NEW.user_id <> OLD.user_id
     OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'The identity of an attempt cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Assigned by the start trigger and never negotiable afterwards.
  NEW.attempt_number := OLD.attempt_number;

  IF NEW.status = 'submitted' THEN
    SELECT sc.score, sc.max_score INTO computed_score, computed_max
      FROM app_score_attempt(OLD.id) sc;

    threshold := app_assessment_passing_percentage(OLD.assessment_id);

    pct := CASE
             WHEN computed_max > 0
               THEN round((computed_score::numeric * 100) / computed_max, 2)
             ELSE 0
           END;

    NEW.score        := computed_score;
    NEW.max_score    := computed_max;
    NEW.percentage   := pct;
    -- An assessment with no marks available cannot be passed. Publication
    -- validation makes that unreachable for a published assessment; this is
    -- the answer if it is ever reached anyway.
    NEW.passed       := (computed_max > 0 AND pct >= threshold);
    NEW.submitted_at := now();
  ELSE
    -- Still in progress. A result cannot appear on a row that has not been
    -- submitted, whatever the statement asked for.
    NEW.score        := NULL;
    NEW.max_score    := NULL;
    NEW.percentage   := NULL;
    NEW.passed       := NULL;
    NEW.submitted_at := NULL;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER assessment_attempts_submit
  BEFORE UPDATE ON assessment_attempts
  FOR EACH ROW EXECUTE FUNCTION assessment_attempt_submit_guard();

/**
 * An answer may only be recorded against an in-progress attempt, and only for a
 * question that belongs to that attempt's own assessment.
 *
 * The second check is the structural answer to "student manipulates question
 * identifiers". The composite foreign key already guarantees that a selected
 * OPTION belongs to the question it is recorded against; this guarantees that
 * the QUESTION belongs to the assessment being attempted. Between them, an
 * answer payload naming another assessment's question and that question's own
 * option is refused by the database, not by a handler that remembered to look.
 */
CREATE FUNCTION assessment_attempt_answer_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF app_attempt_status(NEW.attempt_id) IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'Answers can only be recorded while an attempt is in progress'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF app_question_assessment(NEW.question_id) IS DISTINCT FROM app_attempt_assessment(NEW.attempt_id) THEN
    RAISE EXCEPTION 'That question does not belong to the assessment being attempted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER assessment_attempt_answers_guard
  BEFORE INSERT ON assessment_attempt_answers
  FOR EACH ROW EXECUTE FUNCTION assessment_attempt_answer_guard();

-- =====================================================================
-- Row-Level Security
-- =====================================================================
-- Read access composes, one level at a time, and NEVER restates the level above
-- it:
--
--   lesson visibility   — `lessons_select` (0016, narrowed by 0017)
--     activity          — the lesson is visible AND the activity is published
--                         (or the actor is an editor of its school)
--       assessment      — the activity is visible
--         question      — the assessment is visible
--           option      — the question is visible
--
--   answer key          — NOT ON THAT CHAIN AT ALL. Editorial standing only.
--
-- Each link asks the level above through an INVOKER helper, so there is exactly
-- one definition of "may this actor see a lesson?" in the system and everything
-- downstream inherits it. Narrowing lesson access — as Task 006 did — narrows
-- every one of these on the next request, with nothing to remember to update.
-- =====================================================================

-- --- learning_activities ------------------------------------------------
-- The editorial branch requires the actor's school to OWN the content, which
-- excludes the global catalog (`IS NOT NULL`): a global activity is authored by
-- a platform operator, exactly as a global course is. Without that test, any
-- teacher anywhere could see draft activities attached to a published global
-- lesson, because a published global lesson is visible to all content staff.
CREATE POLICY learning_activities_select ON learning_activities FOR SELECT TO edu_app
  USING (
    app_actor_is_platform_operator()
    OR (
      app_actor_sees_lesson(lesson_id)
      AND (
        status = 'published'
        OR (
          (app_actor_authors_content() OR app_actor_publishes_content())
          AND app_course_organization(app_lesson_course(lesson_id)) IS NOT NULL
          AND app_course_organization(app_lesson_course(lesson_id)) = app_actor_organization()
        )
      )
    )
  );

CREATE POLICY learning_activities_insert ON learning_activities FOR INSERT TO edu_app
  WITH CHECK (
    app_actor_is_platform_operator()
    OR (
      app_actor_sees_lesson(lesson_id)
      AND (app_actor_authors_content() OR app_actor_publishes_content())
      AND app_course_organization(app_lesson_course(lesson_id)) IS NOT NULL
      AND app_course_organization(app_lesson_course(lesson_id)) = app_actor_organization()
      -- Born a draft, like every other piece of content. A request asserting
      -- its own publication is refused here and, independently, by the policy
      -- engine.
      AND status = 'draft'
    )
  );

CREATE POLICY learning_activities_update ON learning_activities FOR UPDATE TO edu_app
  USING (
    app_actor_is_platform_operator()
    OR (
      app_actor_sees_lesson(lesson_id)
      AND (app_actor_authors_content() OR app_actor_publishes_content())
      AND app_course_organization(app_lesson_course(lesson_id)) IS NOT NULL
      AND app_course_organization(app_lesson_course(lesson_id)) = app_actor_organization()
    )
  )
  WITH CHECK (
    app_actor_is_platform_operator()
    OR (
      app_actor_sees_lesson(lesson_id)
      AND (app_actor_authors_content() OR app_actor_publishes_content())
      AND app_course_organization(app_lesson_course(lesson_id)) IS NOT NULL
      AND app_course_organization(app_lesson_course(lesson_id)) = app_actor_organization()
    )
  );

-- No DELETE policy and no DELETE grant. Archiving is the supported way to
-- withdraw an activity, and it keeps every attempt already recorded against it
-- interpretable. A deleted activity would cascade its assessment, its questions
-- and every learner's attempt into nothing.
GRANT SELECT, INSERT, UPDATE ON learning_activities TO edu_app;

-- --- assessments --------------------------------------------------------
-- Visibility is the activity's visibility, with nothing added. That is what
-- "no independent lifecycle" means in practice: there is no rule here that
-- could disagree with the rule above it.
CREATE POLICY assessments_select ON assessments FOR SELECT TO edu_app
  USING (app_actor_is_platform_operator() OR app_actor_sees_activity(activity_id));

CREATE POLICY assessments_insert ON assessments FOR INSERT TO edu_app
  WITH CHECK (
    app_actor_is_platform_operator()
    OR (
      app_actor_authors_content()
      AND app_activity_organization(activity_id) IS NOT NULL
      AND app_activity_organization(activity_id) = app_actor_organization()
    )
  );

CREATE POLICY assessments_update ON assessments FOR UPDATE TO edu_app
  USING (
    app_actor_is_platform_operator()
    OR (
      app_actor_authors_content()
      AND app_activity_organization(activity_id) IS NOT NULL
      AND app_activity_organization(activity_id) = app_actor_organization()
    )
  )
  WITH CHECK (
    app_actor_is_platform_operator()
    OR (
      app_actor_authors_content()
      AND app_activity_organization(activity_id) IS NOT NULL
      AND app_activity_organization(activity_id) = app_actor_organization()
    )
  );

GRANT SELECT, INSERT, UPDATE ON assessments TO edu_app;

-- --- assessment_questions and assessment_options ------------------------
-- A learner reaching a published assessment can read its questions and the
-- options they must choose between. That is the whole of what an assessment
-- discloses to them.
CREATE POLICY assessment_questions_select ON assessment_questions FOR SELECT TO edu_app
  USING (app_actor_is_platform_operator() OR app_actor_sees_assessment(assessment_id));

CREATE POLICY assessment_questions_insert ON assessment_questions FOR INSERT TO edu_app
  WITH CHECK (
    app_actor_is_platform_operator()
    OR (
      app_actor_authors_content()
      AND app_assessment_organization(assessment_id) IS NOT NULL
      AND app_assessment_organization(assessment_id) = app_actor_organization()
    )
  );

CREATE POLICY assessment_options_select ON assessment_options FOR SELECT TO edu_app
  USING (app_actor_is_platform_operator() OR app_actor_sees_question(question_id));

CREATE POLICY assessment_options_insert ON assessment_options FOR INSERT TO edu_app
  WITH CHECK (
    app_actor_is_platform_operator()
    OR (
      app_actor_authors_content()
      AND app_question_organization(question_id) IS NOT NULL
      AND app_question_organization(question_id) = app_actor_organization()
    )
  );

-- INSERT only. There is no UPDATE and no DELETE grant on either table, so a
-- question that has been written cannot be reworded and an option cannot be
-- changed. Combined with the draft-only guard, that means the paper a learner
-- sat is exactly the paper their mark was computed against, permanently.
GRANT SELECT, INSERT ON assessment_questions TO edu_app;
GRANT SELECT, INSERT ON assessment_options   TO edu_app;

-- --- assessment_answer_keys ---------------------------------------------
--
-- THE POLICY THIS WHOLE MIGRATION IS ARRANGED AROUND.
--
-- Read the branches and note what is missing: there is no `app_actor_sees_...`
-- anywhere. Being able to see the question, the assessment, the activity or the
-- lesson grants NOTHING here. The only ways in are a platform operator, or an
-- actor holding a content permission IN THE SCHOOL THAT OWNS THE CONTENT.
--
-- A learner holds neither content permission, so no branch can match for them —
-- not for their own assessment, not after submitting, not ever. This is why the
-- key is a separate table: on a single table, "students may read the option but
-- not the correctness column" is not something row-level security can say, and
-- the alternative would have been a convention that every SELECT list in the
-- codebase, forever, must remember.
--
-- WHO THIS DOES ADMIT, stated plainly: every teacher in the school, because the
-- `teacher` role carries `content:author`. That is intended — a teacher
-- discussing an assessment needs its answers — but it means the key is visible
-- to a much wider group than its author. Recorded as RISK-ASSESS-02.
CREATE POLICY assessment_answer_keys_select ON assessment_answer_keys FOR SELECT TO edu_app
  USING (
    app_actor_is_platform_operator()
    OR (
      (app_actor_authors_content() OR app_actor_publishes_content())
      AND app_question_organization(question_id) IS NOT NULL
      AND app_question_organization(question_id) = app_actor_organization()
    )
  );

CREATE POLICY assessment_answer_keys_insert ON assessment_answer_keys FOR INSERT TO edu_app
  WITH CHECK (
    app_actor_is_platform_operator()
    OR (
      app_actor_authors_content()
      AND app_question_organization(question_id) IS NOT NULL
      AND app_question_organization(question_id) = app_actor_organization()
    )
  );

GRANT SELECT, INSERT ON assessment_answer_keys TO edu_app;

-- --- assessment_attempts -------------------------------------------------
-- The same five readers as `lesson_progress`, through the same helpers, because
-- it is the same question about the same child: who may look at what this
-- learner did? Restating it differently here would be a second answer to a
-- settled question.
CREATE POLICY assessment_attempts_select ON assessment_attempts FOR SELECT TO edu_app
  USING (
    app_actor_is_platform_operator()
    -- Unconditional, and deliberately not gated on current class access: a
    -- learner keeps the record of what they sat. Same retention rule as 0018.
    OR user_id = app_current_actor()
    OR app_actor_guards(user_id)
    OR app_actor_observes_learner_lesson(user_id, app_attempt_lesson(id))
    OR (
      app_actor_holds_role('admin')
      AND app_user_organization(user_id) IS NOT NULL
      AND app_user_organization(user_id) = app_actor_organization()
    )
  );

-- Starting an attempt requires CURRENT access, exactly as recording progress
-- does. `app_actor_may_study_lesson` is the whole Task 006 chain — active
-- assignment, active class, active membership, published content — plus the
-- learner being a MEMBER rather than a teacher. A teacher of the class cannot
-- start an attempt, which is right: sitting an assessment is something a
-- learner does, and an attempt in a teacher's name would be evidence of
-- nothing.
CREATE POLICY assessment_attempts_insert ON assessment_attempts FOR INSERT TO edu_app
  WITH CHECK (
    user_id = app_current_actor()
    -- TWO conditions, and the first one is here because probing this migration
    -- proved the second is not enough on its own (VULN-027).
    --
    -- `app_actor_may_study_lesson` answers about the LESSON: is it published,
    -- assigned to an active class, is this learner an active member? All true
    -- for a lesson that also carries an UNPUBLISHED activity — so with only
    -- that check, a learner who guessed a draft assessment's id could open an
    -- attempt at unreviewed material, and the successful insert would confirm
    -- the id was real.
    --
    -- `app_actor_sees_assessment` is the publication chain: it asks
    -- `assessments_select`, which asks the activity, which asks the lesson. It
    -- does NOT ask about membership, which is why both are needed and neither
    -- is redundant.
    AND app_actor_sees_assessment(assessment_id)
    AND app_actor_may_study_lesson(app_assessment_lesson(assessment_id))
  );

-- Only your own attempt, only while it is in progress. `status = 'in_progress'`
-- in USING is evaluated against the OLD row, so it is a second, independent
-- statement of the freeze the submit trigger enforces.
CREATE POLICY assessment_attempts_update ON assessment_attempts FOR UPDATE TO edu_app
  USING (
    user_id = app_current_actor()
    AND status = 'in_progress'
    AND app_actor_sees_assessment(assessment_id)
    AND app_actor_may_study_lesson(app_assessment_lesson(assessment_id))
  )
  WITH CHECK (user_id = app_current_actor());

-- No DELETE policy and no DELETE privilege. An attempt is a record of what a
-- child did; it leaves only when their account does, through the FK cascade.
GRANT SELECT, INSERT, UPDATE ON assessment_attempts TO edu_app;

-- --- assessment_attempt_answers ------------------------------------------
-- THE OWNER ONLY, deliberately narrower than the attempt itself.
--
-- A teacher can read a learner's SCORE; nothing in this task returns the
-- individual selections, so nothing here grants them. Widening this later is
-- then a visible decision in a migration rather than something a new endpoint
-- inherits by accident.
CREATE POLICY assessment_attempt_answers_select ON assessment_attempt_answers FOR SELECT TO edu_app
  USING (
    app_actor_is_platform_operator()
    OR app_attempt_owner(attempt_id) = app_current_actor()
  );

CREATE POLICY assessment_attempt_answers_insert ON assessment_attempt_answers FOR INSERT TO edu_app
  WITH CHECK (app_attempt_owner(attempt_id) = app_current_actor());

-- SELECT and INSERT only: an answer is written once, inside the submitting
-- transaction, and is then part of the frozen attempt.
GRANT SELECT, INSERT ON assessment_attempt_answers TO edu_app;
