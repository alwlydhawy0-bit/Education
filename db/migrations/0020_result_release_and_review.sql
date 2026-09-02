-- =====================================================================
-- 0020 — Result release and assessment review
-- =====================================================================
-- Task 008 left a deliberate gap, recorded in docs/security/limitations.md: a
-- learner is told a score and nothing else. Per-question correctness was
-- withheld because on a two-option question "you got this wrong" IS the answer
-- key, and releasing it needed a policy about WHEN a paper may be reviewed —
-- which did not exist. This migration is that policy.
--
-- THE ONE NEW IDEA: SUBMITTED IS NOT RELEASED.
--
-- Scoring and disclosure become separate events. An attempt is scored the
-- instant it is submitted (unchanged, and still by the database). Whether the
-- learner may SEE that score, and review the paper, is a second decision with
-- its own authority and its own audit trail.
--
-- WHAT IS DELIBERATELY NOT ADDED. No PENDING_REVIEW state. Every question type
-- here is objective and machine-scored, so there is nothing for a human to mark
-- and no interval during which a result is incomplete. A state that nothing can
-- occupy is a state every reader has to reason about for nothing. Release is
-- therefore a timestamp, not a status column: `released_at IS NULL` is the
-- whole of "not released", and it carries who did it and when for free.
--
-- BACKWARD COMPATIBILITY IS THE DEFAULT. `review_policy` defaults to
-- `on_submission`, which releases the attempt in the same statement that scores
-- it. Every assessment that existed before this migration therefore behaves
-- exactly as it did in Task 008. Withholding is opt-in, per assessment, decided
-- by the author at creation.
-- =====================================================================

-- --- assessments: when may a learner see their result? -------------------
--
-- Two values, and no more, because only two are needed. A third ("after a
-- date") would put an authorization rule inside a clock, which Task 006 already
-- refused for `startsOn`/`dueOn`.
ALTER TABLE assessments
  ADD COLUMN review_policy text NOT NULL DEFAULT 'on_submission';

ALTER TABLE assessments
  ADD CONSTRAINT assessments_review_policy_ck
  CHECK (review_policy IN ('on_submission', 'on_release'));

COMMENT ON COLUMN assessments.review_policy IS
  'on_submission: the attempt is released as it is scored. on_release: marks and '
  'review are withheld from the learner until an authorised teacher or admin releases it.';

-- --- questions: the educational half of a review -------------------------
--
-- Authored content, written by the same person who wrote the question, under
-- the same rules: it may only be set while the activity is a draft, there is no
-- UPDATE grant, and it is therefore fixed for every learner who sits the paper.
-- A review that only says "wrong" teaches nothing; this is where "why" lives.
--
-- It is NOT feedback about a particular learner — that is `teacher_comment` on
-- the attempt. Keeping them apart matters: this text is disclosed to everyone
-- who reviews the assessment, and per-learner remarks must never leak into it.
ALTER TABLE assessment_questions
  ADD COLUMN explanation text NOT NULL DEFAULT '';

ALTER TABLE assessment_questions
  ADD CONSTRAINT assessment_questions_explanation_ck
  CHECK (length(explanation) <= 4000);

-- --- attempts: the release record ----------------------------------------
ALTER TABLE assessment_attempts
  ADD COLUMN released_at    timestamptz,
  ADD COLUMN released_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN teacher_comment text;

-- A release cannot exist without the attempt it releases being finished, and a
-- releaser cannot exist without a release. Stated as constraints rather than
-- trusted to the trigger below, for the reason VULN-026 taught: a constraint
-- that permits a state only a trigger prevents is one dropped trigger away from
-- being wrong.
ALTER TABLE assessment_attempts
  ADD CONSTRAINT assessment_attempts_release_requires_submission_ck
    CHECK (released_at IS NULL OR status = 'submitted'),
  ADD CONSTRAINT assessment_attempts_releaser_requires_release_ck
    CHECK (released_by IS NULL OR released_at IS NOT NULL),
  -- A remark about a learner's paper is part of releasing it. Allowing one on an
  -- unreleased attempt would create feedback nobody can read and nobody deleted.
  ADD CONSTRAINT assessment_attempts_comment_requires_release_ck
    CHECK (teacher_comment IS NULL OR released_at IS NOT NULL),
  ADD CONSTRAINT assessment_attempts_comment_length_ck
    CHECK (teacher_comment IS NULL OR length(teacher_comment) <= 2000);

CREATE INDEX assessment_attempts_released_idx
  ON assessment_attempts (assessment_id, released_at);

-- =====================================================================
-- Visibility, extracted to ONE definition
-- =====================================================================

/**
 * May the current actor read this attempt?
 *
 * The five branches were previously written inline in
 * `assessment_attempts_select`. The review function below needs the SAME
 * question answered, and a second copy of a five-branch authorization predicate
 * is a drift waiting to happen — the kind where the copies disagree and the
 * looser one is the one an attacker finds. So the predicate is extracted here
 * and the policy is rewritten to call it, leaving exactly one definition.
 *
 * IT TAKES THE ROW'S COLUMNS, NOT JUST ITS ID, and that signature is load-bearing
 * rather than a convenience.
 *
 * The obvious shape — `app_actor_may_read_attempt(id)`, looking the attempt up
 * itself — is broken, and broken in a way no security test would have caught,
 * because it fails CLOSED. A `STABLE` function sees the snapshot as of the start
 * of the statement, so during `INSERT ... RETURNING id` the row being checked
 * DOES NOT YET EXIST for the function's own SELECT. `EXISTS` returns false, the
 * SELECT policy refuses the returned row, and a learner can no longer start an
 * attempt at all. The whole assessment flow stops.
 *
 * Reading the columns the policy is already holding avoids the lookup entirely
 * and reproduces 0019's inline predicate term for term — which is what makes
 * this an extraction rather than a rewrite. `app_attempt_lesson(p_attempt_id)`
 * survives inside the fourth branch only because the branches before it
 * short-circuit for the row's own learner, exactly as they did inline.
 *
 * It needs no SECURITY DEFINER either, now that it reads no table: the helpers
 * it calls are definers in their own right, and a function that runs with the
 * owner's rights when it does not need them is privilege nobody asked for.
 *
 * `tests/integration/rls-assessment.test.ts` asserts the rewritten policy admits
 * exactly the same actors as before.
 */
CREATE FUNCTION app_actor_may_read_attempt(p_attempt_id uuid, p_user_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $$
  SELECT app_actor_is_platform_operator()
      -- Unconditional, and deliberately not gated on current class access: a
      -- learner keeps the record of what they sat. Same retention rule as 0018.
      OR p_user_id = app_current_actor()
      OR app_actor_guards(p_user_id)
      OR app_actor_observes_learner_lesson(p_user_id, app_attempt_lesson(p_attempt_id))
      OR (
        app_actor_holds_role('admin')
        AND app_user_organization(p_user_id) IS NOT NULL
        AND app_user_organization(p_user_id) = app_actor_organization()
      );
$$;

/**
 * May the current actor RELEASE this attempt?
 *
 * A strictly narrower set than the readers above, and the two omissions are the
 * point:
 *
 *   - THE LEARNER IS NOT HERE. A result the subject can release is not a result
 *     anyone else can rely on; the whole purpose of withholding is that the
 *     decision belongs to somebody else.
 *   - THE GUARDIAN IS NOT HERE either. A guardian may READ what their child was
 *     told; deciding what a child is told about their own assessment is a
 *     teaching act, not a parental one.
 *
 * Unlike the read predicate above, this one DOES look the attempt up by id, and
 * that difference is deliberate. It is only ever called on a row that already
 * exists (the UPDATE policy's `USING` and `WITH CHECK`), so the snapshot problem
 * that forced the read predicate to take its columns cannot arise — and reading
 * the STORED `status` rather than the row under test is what stops a caller
 * smuggling `status = 'submitted'` into the same statement to manufacture the
 * standing to release.
 *
 * A platform operator MAY release, unlike `start` and `submit` where they are
 * excluded. The reason is the direction of the act: releasing discloses a mark
 * the database already computed, it does not manufacture evidence about what a
 * child did. Recorded as an operator capability in the threat model.
 */
CREATE FUNCTION app_actor_may_release_attempt(p_attempt_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM assessment_attempts t
    WHERE t.id = p_attempt_id
      AND t.status = 'submitted'
      AND (
        app_actor_is_platform_operator()
        OR app_actor_observes_learner_lesson(t.user_id, app_attempt_lesson(t.id))
        OR (
          app_actor_holds_role('admin')
          AND app_user_organization(t.user_id) IS NOT NULL
          AND app_user_organization(t.user_id) = app_actor_organization()
        )
      )
  );
$$;

/** The release policy an attempt's assessment carries. */
CREATE FUNCTION app_attempt_review_policy(p_attempt_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT s.review_policy
    FROM assessment_attempts t JOIN assessments s ON s.id = t.assessment_id
   WHERE t.id = p_attempt_id;
$$;

REVOKE ALL ON FUNCTION app_actor_may_read_attempt(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_may_release_attempt(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_attempt_review_policy(uuid)     FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_actor_may_read_attempt(uuid, uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_may_release_attempt(uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_attempt_review_policy(uuid)     TO edu_app;

-- The extraction. Behaviourally identical; asserted by the existing visibility
-- matrix in the RLS suite, which is left unchanged so it can prove that.
DROP POLICY assessment_attempts_select ON assessment_attempts;

CREATE POLICY assessment_attempts_select ON assessment_attempts FOR SELECT TO edu_app
  USING (app_actor_may_read_attempt(id, user_id));

-- =====================================================================
-- THE REVIEW
-- =====================================================================

/**
 * A learner's paper, marked.
 *
 * This is the one function in the system that returns per-question correctness
 * AND the correct option ids — the answer key, for one attempt. Everything
 * about its shape is arranged so that it cannot become a way to read the key
 * generally:
 *
 *   1. IT SELF-AUTHORIZES. `app_score_attempt` (0019) is granted to nobody
 *      because it takes an id and answers unconditionally; this one is granted
 *      to `edu_app` and is safe only because the WHERE clause below re-asks
 *      both questions itself. An id alone buys nothing.
 *   2. IT REQUIRES RELEASE — OF THE SUBJECT, AND ONLY THE SUBJECT. Before
 *      release, a learner and their guardian get NO ROWS AT ALL: not the key,
 *      not correctness, not even how many questions there were. Empty rather
 *      than redacted, because a redacted paper still discloses its shape.
 *
 *      A teacher or an administrator is NOT gated on release, and that
 *      asymmetry is the whole mechanism rather than an exception to it:
 *      somebody has to be able to look at a marked paper in order to decide
 *      whether to release it, and if that somebody were also the subject there
 *      would be nothing left to decide. The same expression governs the score
 *      columns in `assessment.repository.ts`, so the two layers withhold from
 *      exactly the same people.
 *   3. IT IS SCOPED TO ONE ATTEMPT. There is no form of this query that walks
 *      an assessment, a class or a learner.
 *
 * The key still lives behind `assessment_answer_keys_select`, whose policy is
 * NOT widened by this migration. A learner's own connection still reads zero
 * rows from that table; what changes is that a released attempt can be
 * rendered, through a function that hands back one paper's worth of answers.
 */
CREATE FUNCTION app_attempt_review(p_attempt_id uuid)
  RETURNS TABLE (
    question_id        uuid,
    -- `question_position`, not `position`: PostgreSQL treats `position` as a
    -- reserved word (the `position(x in y)` function), and a RETURNS TABLE
    -- column named that is a syntax error. Same family of collision as VULN-008.
    question_position  integer,
    question_type      text,
    prompt             text,
    explanation        text,
    points             integer,
    awarded            integer,
    is_correct         boolean,
    selected_option_ids uuid[],
    correct_option_ids  uuid[]
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  WITH graded AS (
    SELECT
      q.id, q.position, q.question_type, q.prompt, q.explanation, q.points,
      (
        SELECT coalesce(array_agg(k.option_id ORDER BY k.option_id), '{}'::uuid[])
          FROM assessment_answer_keys k WHERE k.question_id = q.id
      ) AS key_options,
      (
        SELECT coalesce(array_agg(a.option_id ORDER BY a.option_id), '{}'::uuid[])
          FROM assessment_attempt_answers a
         WHERE a.attempt_id = p_attempt_id AND a.question_id = q.id
      ) AS chosen_options
    FROM assessment_attempts t
    JOIN assessment_questions q ON q.assessment_id = t.assessment_id
    WHERE t.id = p_attempt_id
      -- Both gates, re-asked. Removing either turns this into a key oracle.
      --
      -- The release gate binds the SUBJECT of the attempt — the learner and
      -- their verified guardian. Everyone else who may read the attempt at all
      -- reaches the marked paper before release, which is how a release
      -- decision gets made.
      AND (
        t.released_at IS NOT NULL
        OR NOT (t.user_id = app_current_actor() OR app_actor_guards(t.user_id))
      )
      AND app_actor_may_read_attempt(t.id, t.user_id)
  )
  SELECT
    id, position, question_type, prompt, explanation, points,
    -- The same rule the scorer uses: full marks for exact set equality, and an
    -- empty key never pays out. Stated once more here rather than shared,
    -- because `app_score_attempt` returns totals and this returns rows; the RLS
    -- suite asserts the two agree.
    CASE WHEN cardinality(key_options) > 0 AND key_options = chosen_options
         THEN points ELSE 0 END,
    (cardinality(key_options) > 0 AND key_options = chosen_options),
    chosen_options,
    key_options
  FROM graded
  ORDER BY position;
$$;

REVOKE ALL ON FUNCTION app_attempt_review(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_attempt_review(uuid) TO edu_app;

-- =====================================================================
-- The configuration is frozen with the paper
-- =====================================================================

/**
 * An assessment's configuration cannot change once its activity leaves draft.
 *
 * 0019 froze an assessment's QUESTIONS, options and answer keys at publication
 * (`assessment_content_is_draft_only`) but left the `assessments` row itself
 * writable by any content author in the school. Nothing in the application ever
 * updated it, so nothing exercised the gap — until this migration added a column
 * where the gap matters.
 *
 * `review_policy` decides whether a child sees their mark. If it could be
 * changed after papers were sat, a teacher could retro-withhold results children
 * had already been shown, or retro-disclose results the class was told would be
 * held back, and either would be invisible after the fact because the column
 * carries no history. The same argument was always true of
 * `passing_percentage` — moving the pass mark after a paper is sat re-decides
 * who failed — so the freeze covers the whole configuration rather than the one
 * column that prompted it.
 *
 * The freeze is stated over a column group rather than a list of comparisons,
 * by the same `to_jsonb` technique used in the submit guard, so a configuration
 * column added later is frozen by default rather than by remembering to.
 */
CREATE FUNCTION assessment_config_is_draft_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF app_assessment_status(OLD.id) IS DISTINCT FROM 'draft'
     AND (to_jsonb(NEW) - 'id' - 'activity_id' - 'created_at' - 'updated_at')
         IS DISTINCT FROM
         (to_jsonb(OLD) - 'id' - 'activity_id' - 'created_at' - 'updated_at') THEN
    RAISE EXCEPTION 'An assessment''s configuration cannot be changed after it leaves draft'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER assessments_config_draft_only
  BEFORE UPDATE ON assessments
  FOR EACH ROW EXECUTE FUNCTION assessment_config_is_draft_only();

-- =====================================================================
-- Release: who may write it, and what they may write
-- =====================================================================

/**
 * Rewritten to admit exactly ONE change to a submitted attempt: its release.
 *
 * 0019's version refused every update to a submitted attempt, which is what
 * froze a mark. That freeze is kept in full — the exception below is not a
 * loosening of it, because a release cannot alter a single column the freeze
 * was protecting. The `to_jsonb` comparison is what makes that a fact rather
 * than an intention: every column except the three release columns must be
 * BYTE-IDENTICAL, so a statement that sets `released_at` and `score` together
 * is refused outright rather than partially applied.
 *
 * The same technique as `content_lifecycle_guard` (0016), and for the same
 * reason: it stays correct when a column is added later, which a hand-written
 * list of column comparisons would not.
 */
CREATE OR REPLACE FUNCTION assessment_attempt_submit_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  computed_score integer;
  computed_max   integer;
  threshold      integer;
  pct            numeric(5,2);
  release_only   boolean;
BEGIN
  IF OLD.status = 'submitted' THEN
    -- Everything except the release columns must be unchanged.
    release_only := (to_jsonb(NEW) - 'released_at' - 'released_by' - 'teacher_comment' - 'updated_at')
                    IS NOT DISTINCT FROM
                    (to_jsonb(OLD) - 'released_at' - 'released_by' - 'teacher_comment' - 'updated_at');

    IF release_only AND OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
      -- A release, and only a release. The server clock decides when, so a
      -- caller cannot backdate one.
      NEW.released_at := now();
      NEW.updated_at  := now();
      RETURN NEW;
    END IF;

    -- Covers a second release, an un-release, and any attempt to smuggle a
    -- score change alongside one.
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
    NEW.passed       := (computed_max > 0 AND pct >= threshold);
    NEW.submitted_at := now();

    -- AUTO-RELEASE, when the assessment says results are not withheld. This is
    -- what makes `on_submission` behave exactly as Task 008 did: scored and
    -- released in one statement.
    --
    -- `released_by` stays NULL, and that is meaningful rather than lazy: nobody
    -- released this, the assessment's own policy did. A non-null `released_by`
    -- always names a person who made a decision.
    IF app_attempt_review_policy(OLD.id) = 'on_submission' THEN
      NEW.released_at := now();
      NEW.released_by := NULL;
    ELSE
      NEW.released_at := NULL;
      NEW.released_by := NULL;
    END IF;
    NEW.teacher_comment := NULL;
  ELSE
    NEW.score           := NULL;
    NEW.max_score       := NULL;
    NEW.percentage      := NULL;
    NEW.passed          := NULL;
    NEW.submitted_at    := NULL;
    -- An unsubmitted attempt has nothing to release.
    NEW.released_at     := NULL;
    NEW.released_by     := NULL;
    NEW.teacher_comment := NULL;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END
$$;

/**
 * A releaser may update the attempt.
 *
 * PostgreSQL ORs permissive policies, so this WIDENS who may issue an UPDATE —
 * which is why the trigger above, not this policy, is what decides which
 * columns may move. The policy answers "may this person act on this row at
 * all", the trigger answers "and may they change that".
 *
 * `released_at IS NULL` in USING makes a released attempt invisible to a second
 * release attempt, so re-release matches zero rows rather than erroring. The
 * service treats that as success, which is what makes release idempotent.
 *
 * The learner's own update policy is untouched and still requires
 * `status = 'in_progress'`, so a learner cannot reach a submitted attempt
 * through either policy.
 */
CREATE POLICY assessment_attempts_release ON assessment_attempts FOR UPDATE TO edu_app
  USING (released_at IS NULL AND app_actor_may_release_attempt(id))
  WITH CHECK (app_actor_may_release_attempt(id));

-- Backfill: every attempt submitted before this migration was, under Task 008's
-- behaviour, immediately visible to its learner. Leaving them unreleased would
-- silently retract results children had already been shown, so they are marked
-- released at the moment they were submitted, by nobody.
UPDATE assessment_attempts
   SET released_at = submitted_at
 WHERE status = 'submitted' AND released_at IS NULL;
