-- ===========================================================================
-- 0033 — THE MASTERY SCALE WAS INCOHERENT, AND THE ORDER WAS BACKWARDS
-- ===========================================================================
--
-- 0032 mapped the five mastery states onto an ordinal 0..3 scale:
--
--     no_evidence   -> excluded
--     attempted     ->   0.00
--     developing    ->  33.33
--     demonstrated  ->  66.67
--     mastered      -> 100.00
--
-- That reads sensibly and is wrong, because `attempted` and `developing` are
-- not two points on one line. Reading 0021's definitions:
--
--     `attempted`  — evidence exists, and NONE of it is from an assessment.
--                    The learner has opened lessons. Nobody has graded them.
--     `developing` — assessment evidence exists, and no assessment was passed.
--                    The learner sat something and did not pass it.
--
-- So the 0032 scale scored A LEARNER NOBODY HAS ASSESSED YET BELOW A LEARNER
-- WHO SAT AN ASSESSMENT AND FAILED IT. A class that has done the reading but
-- not yet reached the quiz reports 0.00 — total failure, to whoever opens the
-- dashboard — and its index goes UP the moment they sit the quiz and fail.
--
-- That is not a rescaling quibble. This number is put in front of people who
-- make decisions about staff and children, and a metric that rewards being
-- assessed badly over not being assessed yet will produce exactly the
-- behaviour it measures.
--
-- ---------------------------------------------------------------------------
-- THE CORRECTION: `attempted` CARRIES NO MASTERY INFORMATION, SO IT IS EXCLUDED
-- ---------------------------------------------------------------------------
--
--     no_evidence   -> excluded (nothing has happened)
--     attempted     -> excluded (something happened; none of it was graded)
--     developing    ->   0.00   (graded, passed nothing)
--     demonstrated  ->  50.00   (graded, passed one assessment)
--     mastered      -> 100.00   (graded, passed more than one)
--
-- The scale now measures ONE thing — graded outcomes — over the population it
-- has graded outcomes for. `no_evidence` and `attempted` are both "we do not
-- know", and the honest rendering of "we do not know" is absence from the
-- average rather than a zero that reads as failure.
--
-- The cost is stated plainly: a school where nothing has been assessed shows
-- NULL rather than a number, which some dashboards find harder to draw than a
-- zero. That is the right way round. RISK-AN-06 records it.
--
-- ---------------------------------------------------------------------------
-- WHY A NEW MIGRATION RATHER THAN AN EDIT TO 0032
-- ---------------------------------------------------------------------------
--
-- Migrations are checksummed and 0032 has been applied. Editing an applied file
-- is refused by the migrator, and correctly: a fix that rewrites history leaves
-- two databases that ran different SQL under the same version number. Fixes go
-- in new files, and the new file gets to explain itself — which is most of the
-- value.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app_analytics_mastery_points(p_state text) RETURNS numeric
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE p_state
           -- 'no_evidence' and 'attempted' both return NULL: neither says
           -- anything about mastery, and `avg()` skips a NULL rather than
           -- dragging the mean toward a number nobody measured.
           WHEN 'developing'   THEN 0.0
           WHEN 'demonstrated' THEN 50.0
           WHEN 'mastered'     THEN 100.0
           ELSE NULL
         END::numeric;
$$;

COMMENT ON FUNCTION app_analytics_mastery_points(text) IS
  'Graded mastery states only. no_evidence and attempted are NULL — not yet assessed is not failure.';
