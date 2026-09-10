-- ===========================================================================
-- 0032 — INSTITUTIONAL ANALYTICS
-- ===========================================================================
--
-- Aggregated engagement, mastery and usage metrics for the adults who run a
-- school. Two tables, two refresh functions, and a tenant boundary that is
-- structural rather than remembered.
--
-- ---------------------------------------------------------------------------
-- THE TENANT COMES FROM THE LEARNER'S CLASS, NEVER FROM THE CONTENT
-- ---------------------------------------------------------------------------
--
-- The obvious way to scope a metric about an assessment attempt is to walk the
-- content chain: attempt -> assessment -> activity -> lesson -> unit -> course,
-- and read `courses.organization_id`. THAT IS WRONG HERE, and it is wrong in a
-- way that produces a plausible-looking number rather than an error.
--
-- `courses.organization_id` IS NULLABLE ON PURPOSE. A null course is shared
-- curriculum — authored centrally and studied by many schools. So the content
-- chain answers NULL for exactly the courses most schools use, and for a course
-- that IS owned by a school it answers that school even when the learner
-- studying it belongs to another.
--
-- Activity belongs to the school whose learner performed it. `classes` carries
-- `organization_id NOT NULL`, `class_memberships` says who is in a class, and
-- that pair is the only tenant anchor in this schema that is both non-null and
-- about a person. Every aggregate below reaches its tenant that way.
--
-- ---------------------------------------------------------------------------
-- THE ORGANIZATION IS BOUND BY A COMPOSITE FOREIGN KEY
-- ---------------------------------------------------------------------------
--
-- `analytics_course_performance` carries both `class_id` and `organization_id`,
-- which is a denormalization and therefore an opportunity for the two to
-- disagree. A trigger could keep them in step; a policy could check them. Both
-- are code that has to keep being right.
--
-- Instead `classes` gains `UNIQUE (id, organization_id)` and this table
-- references the pair. A row whose organization does not match its class's
-- CANNOT BE WRITTEN — not by a bug in the refresh function, not by a future
-- endpoint, not by anybody with INSERT on the table. This is the technique
-- 0029 used for the reply tree and 0024 for lab sessions, applied to the thing
-- this task exists to protect.
--
-- ---------------------------------------------------------------------------
-- THE REFRESH HAS NO ACTOR, SO ITS VANTAGE POINT IS DECLARED
-- ---------------------------------------------------------------------------
--
-- `app_objective_mastery(user_id, objective_id)` from 0021 is ACTOR-DEPENDENT:
-- it withholds an unreleased result from the learner and their guardian, and
-- reports the truth to everybody else. That is right for an endpoint and
-- impossible for a stored aggregate, which is computed once, by nobody, and
-- read later by many.
--
-- So the refresh functions do NOT call it. They recompute the same tally with
-- the withholding clause removed, which is the STAFF vantage point — the truth,
-- the same number a teacher already sees today. That is the only defensible
-- choice for a table whose entire readership is staff, and it is safe only
-- because §2C bans learners and guardians from every row here. The RLS below is
-- what makes that true rather than hoped.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The structural prerequisite.
-- ---------------------------------------------------------------------------
-- Additive: a unique constraint on a column pair that is already unique because
-- `id` is the primary key. It exists solely so other tables can reference the
-- pair and inherit the tenant.
ALTER TABLE classes ADD CONSTRAINT classes_id_organization_uk UNIQUE (id, organization_id);

-- ---------------------------------------------------------------------------
-- Covering indexes on the SOURCE tables.
-- ---------------------------------------------------------------------------
-- Section 2A requires aggregation "without full sequential table scans", and
-- without these that is exactly what a daily rollup would do: none of the
-- source tables was indexed on the date column a rollup filters by.
--
-- Each is a partial index over the rows a rollup actually reads, so it stays
-- small: only completed lessons have a `completed_at`, only submitted attempts
-- have a `submitted_at`.
CREATE INDEX lesson_progress_completed_at_ix
  ON lesson_progress (completed_at) WHERE completed_at IS NOT NULL;

CREATE INDEX lesson_progress_accessed_at_ix
  ON lesson_progress (last_accessed_at);

CREATE INDEX assessment_attempts_started_at_ix
  ON assessment_attempts (started_at);

CREATE INDEX assessment_attempts_submitted_at_ix
  ON assessment_attempts (submitted_at) WHERE submitted_at IS NOT NULL;

CREATE INDEX ai_messages_created_at_ix
  ON ai_messages (created_at);

CREATE INDEX objective_evidence_occurred_at_ix
  ON objective_evidence (occurred_at);

-- ===========================================================================
-- analytics_daily_school_metrics
-- ===========================================================================
--
-- One row per school per day. The executive dashboard reads it and nothing
-- else: an endpoint that recomputed on request would put a full-school scan in
-- the path of a page load.
--
-- `average_mastery_score` IS NULLABLE AND THAT IS NOT AN OVERSIGHT. A school
-- whose learners have generated no gradeable evidence has no average, and zero
-- would be a lie that reads as failure. Null means "no evidence"; 0.00 means
-- "evidence, all of it bad". A dashboard that cannot tell those apart will
-- eventually be used to make a decision about a person.
CREATE TABLE analytics_daily_school_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  metric_date date NOT NULL,

  total_active_students integer NOT NULL DEFAULT 0,
  total_active_teachers integer NOT NULL DEFAULT 0,
  lessons_completed integer NOT NULL DEFAULT 0,
  quizzes_attempted integer NOT NULL DEFAULT 0,
  average_mastery_score numeric(5,2),
  ai_tutor_sessions integer NOT NULL DEFAULT 0,

  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT analytics_daily_school_metrics_day_uk UNIQUE (organization_id, metric_date),

  -- Counts are counts. A negative one means the refresh function is broken, and
  -- the database should say so at the moment it happens rather than let a
  -- dashboard render it.
  CONSTRAINT analytics_daily_counts_ck CHECK (
    total_active_students >= 0 AND total_active_teachers >= 0
    AND lessons_completed >= 0 AND quizzes_attempted >= 0
    AND ai_tutor_sessions >= 0
  ),
  CONSTRAINT analytics_daily_mastery_range_ck CHECK (
    average_mastery_score IS NULL
    OR (average_mastery_score >= 0 AND average_mastery_score <= 100)
  ),

  -- No metric_date in the future. A row dated tomorrow is either a clock
  -- problem or a caller passing a parameter it should not control, and both are
  -- worth refusing at the boundary.
  CONSTRAINT analytics_daily_not_future_ck CHECK (metric_date <= CURRENT_DATE)
);

CREATE INDEX analytics_daily_school_metrics_org_date_ix
  ON analytics_daily_school_metrics (organization_id, metric_date DESC);

-- ===========================================================================
-- analytics_course_performance
-- ===========================================================================
--
-- One row per (school, class, course). The grain is the CLASS and not the
-- course, because a course taught to four classes has four different stories
-- and averaging them tells none of them — and because a teacher is authorized
-- per class, so a course-grained row could not be shown to them at all.
CREATE TABLE analytics_course_performance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  class_id uuid NOT NULL,

  enrollment_count integer NOT NULL DEFAULT 0,
  completion_rate_pct numeric(5,2) NOT NULL DEFAULT 0,
  avg_quiz_score numeric(5,2),
  flagged_struggling_students_count integer NOT NULL DEFAULT 0,

  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT analytics_course_performance_uk UNIQUE (organization_id, class_id, course_id),

  -- THE TENANT, STRUCTURALLY. See the header. A row cannot claim a school its
  -- class does not belong to, and no code is involved in that being true.
  CONSTRAINT analytics_course_performance_class_fk
    FOREIGN KEY (class_id, organization_id)
    REFERENCES classes (id, organization_id) ON DELETE CASCADE,

  CONSTRAINT analytics_course_counts_ck CHECK (
    enrollment_count >= 0 AND flagged_struggling_students_count >= 0
    AND flagged_struggling_students_count <= enrollment_count
  ),
  CONSTRAINT analytics_course_rates_ck CHECK (
    completion_rate_pct >= 0 AND completion_rate_pct <= 100
    AND (avg_quiz_score IS NULL OR (avg_quiz_score >= 0 AND avg_quiz_score <= 100))
  )
);

CREATE INDEX analytics_course_performance_org_ix
  ON analytics_course_performance (organization_id);
CREATE INDEX analytics_course_performance_class_ix
  ON analytics_course_performance (class_id);

-- ===========================================================================
-- THE MASTERY SCALE
-- ===========================================================================
--
-- 0021 produces a mastery STATE, which is a word. A dashboard wants a number,
-- and turning one into the other is a modelling choice that should be written
-- down once rather than implied in four places.
--
--   no_evidence   -> excluded from the average entirely (see below)
--   attempted     ->   0.00
--   developing    ->  33.33
--   demonstrated  ->  66.67
--   mastered      -> 100.00
--
-- An ordinal scale 0..3 rendered as a percentage of the maximum. It is a
-- reporting convenience and NOT a grade: nobody scored 33% on anything, and the
-- number must never be shown to a learner as if they had. §2C bans learners
-- from these tables for several reasons and this is one of them.
--
-- `no_evidence` IS EXCLUDED RATHER THAN SCORED ZERO. A learner who has not yet
-- reached an objective has not failed it. Scoring absence as zero would make a
-- school's index fall every time it published new curriculum, which is both
-- wrong and the exact incentive a school should not be given.
CREATE FUNCTION app_analytics_mastery_points(p_state text) RETURNS numeric
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE p_state
           WHEN 'attempted'    THEN 0.0
           WHEN 'developing'   THEN 100.0 / 3.0
           WHEN 'demonstrated' THEN 200.0 / 3.0
           WHEN 'mastered'     THEN 100.0
           ELSE NULL
         END::numeric;
$$;

/**
 * The AUTHORITATIVE mastery state for one learner and one objective.
 *
 * A DELIBERATE SIBLING OF `app_objective_mastery`, NOT A REPLACEMENT, and the
 * difference between them is the whole reason this one exists.
 *
 * 0021's function answers the question "what may THIS READER be told about this
 * learner's mastery", and it withholds an unreleased result from the learner
 * and their guardian so that a mastery endpoint cannot be used to announce a
 * mark a teacher has not released. That is correct there and unusable here: a
 * stored aggregate is computed once, by nobody, and read later by many, so
 * there is no reader whose entitlements could be applied.
 *
 * This one answers "what is TRUE", which is what a teacher already sees. It is
 * the staff vantage point, declared rather than inherited.
 *
 * THAT IS ONLY SAFE BECAUSE NOTHING DOWNSTREAM SHOWS IT TO A LEARNER. The RLS
 * on both analytics tables admits organization administrators and the teachers
 * of a class, and nobody else — no learner, no guardian, at any grain. If that
 * ever changes, this function becomes a disclosure and the change must start
 * here.
 *
 * It is deliberately NOT granted to `edu_app`. It exists to be called by the
 * refresh functions in this file and by nothing else, so an id alone buys
 * nothing even for staff.
 */
CREATE FUNCTION app_analytics_authoritative_mastery(p_user_id uuid, p_objective_id uuid)
  RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  WITH tally AS (
    SELECT
      count(*) AS total,
      count(DISTINCT t.assessment_id)
        FILTER (WHERE e.evidence_type = 'assessment_passed') AS passed_assessments,
      count(*) FILTER (WHERE e.source_kind = 'assessment_attempt') AS assessed
    FROM objective_evidence e
    LEFT JOIN assessment_attempts t
      ON e.source_kind = 'assessment_attempt' AND t.id = e.source_id
    WHERE e.user_id = p_user_id
      AND e.objective_id = p_objective_id
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

REVOKE ALL ON FUNCTION app_analytics_authoritative_mastery(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_analytics_mastery_points(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_analytics_mastery_points(text) TO edu_app;

-- ===========================================================================
-- THE LEARNER ROSTER OF A SCHOOL
-- ===========================================================================
--
-- Every aggregate below starts here, and it is one place rather than six so
-- that "who counts as this school's learner" has a single answer.
--
-- ACTIVE MEMBERSHIP OF AN ACTIVE CLASS, and the school comes from the class.
-- Not `users.organization_id`: a user record's organization is where the person
-- is registered, and a learner registered at a school but enrolled in nothing
-- has no activity to attribute. Reaching through the class also means the
-- number cannot disagree with the class-grained table, which is bound to the
-- same rows by its composite foreign key.
CREATE FUNCTION app_analytics_org_learners(p_organization_id uuid)
  RETURNS TABLE (user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT DISTINCT m.user_id
    FROM class_memberships m
    JOIN classes c ON c.id = m.class_id
   WHERE c.organization_id = p_organization_id
     AND m.status = 'active'
     AND c.status = 'active'
     AND m.role_in_class = 'student';
$$;

REVOKE ALL ON FUNCTION app_analytics_org_learners(uuid) FROM PUBLIC;

-- ===========================================================================
-- THE DAILY REFRESH
-- ===========================================================================
--
-- Bounded by (organization, date) — one school, one day, per call. Section 2B
-- asks for aggregation that does not contend with live traffic, and the shape
-- of the work is most of that answer:
--
--   NO LOCKS ARE TAKEN ON THE SOURCE TABLES. Every read below is a plain
--   SELECT at READ COMMITTED. There is no `FOR UPDATE`, no `FOR SHARE`, and no
--   `LOCK TABLE`, so a rollup running over `assessment_attempts` cannot block a
--   learner submitting one. `tests/integration/rls-analytics.test.ts` asserts
--   this against `pg_locks` rather than trusting the reading.
--
--   THE WRITE IS AN UPSERT, not DELETE-then-INSERT. A reader is never shown the
--   gap between the two halves of a refresh, because there is no gap.
--
--   IT IS NOT `REFRESH MATERIALIZED VIEW`. That statement takes an ACCESS
--   EXCLUSIVE lock on the view for its whole duration, so every dashboard in
--   the school blocks behind the nightly job; the CONCURRENTLY form needs a
--   unique index and still rewrites the entire view for all tenants. A plain
--   table with a per-tenant upsert refreshes one school without the other
--   schools noticing. Section 2A permits either; this is why it is this one.
--
-- The day boundary is UTC, which is what `timestamptz::date` gives at the
-- server's default. RISK-AN-03 records what that costs a school in a timezone
-- where the school day straddles midnight UTC.
CREATE FUNCTION app_analytics_refresh_daily(p_organization_id uuid, p_metric_date date)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_learners uuid[];
BEGIN
  IF p_organization_id IS NULL OR p_metric_date IS NULL THEN
    RAISE EXCEPTION 'A refresh needs a school and a date'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- THE TENANT CONSTRAINT IS TAKEN ONCE AND EVERY AGGREGATE BELOW IS BOUNDED BY
  -- IT. Section 3: "aggregation queries MUST NEVER fall back to unbounded table
  -- scans without an explicit tenant constraint." Materialising the roster is
  -- how that is made structural — an aggregate below cannot forget the
  -- constraint, because the constraint is the array it reads from.
  SELECT coalesce(array_agg(user_id), '{}') INTO v_learners
    FROM app_analytics_org_learners(p_organization_id);

  INSERT INTO analytics_daily_school_metrics AS m (
    organization_id, metric_date,
    total_active_students, total_active_teachers,
    lessons_completed, quizzes_attempted,
    average_mastery_score, ai_tutor_sessions, updated_at
  )
  SELECT
    p_organization_id,
    p_metric_date,

    -- ACTIVE means DID SOMETHING, not "is enrolled". An enrolment count that
    -- calls itself "active students" is the single most common way an
    -- engagement dashboard lies to a head teacher.
    (SELECT count(DISTINCT u) FROM (
        SELECT lp.user_id AS u FROM lesson_progress lp
         WHERE lp.user_id = ANY (v_learners)
           AND lp.last_accessed_at >= p_metric_date::timestamptz
           AND lp.last_accessed_at <  (p_metric_date + 1)::timestamptz
        UNION
        SELECT a.user_id FROM assessment_attempts a
         WHERE a.user_id = ANY (v_learners)
           AND a.started_at >= p_metric_date::timestamptz
           AND a.started_at <  (p_metric_date + 1)::timestamptz
        UNION
        SELECT msg.owner_id FROM ai_messages msg
         WHERE msg.owner_id = ANY (v_learners)
           AND msg.created_at >= p_metric_date::timestamptz
           AND msg.created_at <  (p_metric_date + 1)::timestamptz
      ) AS active_learners),

    -- A teacher counts as active for the school whose class they teach, which
    -- is why this reaches through `teacher_assignments` rather than through
    -- `users.organization_id`: a teacher may hold classes in more than one
    -- school and each should see the days they worked in it.
    (SELECT count(DISTINCT ta.teacher_id)
       FROM teacher_assignments ta
       JOIN classes c ON c.id = ta.class_id
      WHERE c.organization_id = p_organization_id
        AND ta.status = 'active' AND c.status = 'active'
        AND EXISTS (
          SELECT 1 FROM assessment_attempts a
           WHERE a.released_by = ta.teacher_id
             AND a.released_at >= p_metric_date::timestamptz
             AND a.released_at <  (p_metric_date + 1)::timestamptz)),

    (SELECT count(*) FROM lesson_progress lp
      WHERE lp.user_id = ANY (v_learners)
        AND lp.status = 'completed'
        AND lp.completed_at >= p_metric_date::timestamptz
        AND lp.completed_at <  (p_metric_date + 1)::timestamptz),

    (SELECT count(*) FROM assessment_attempts a
      WHERE a.user_id = ANY (v_learners)
        AND a.started_at >= p_metric_date::timestamptz
        AND a.started_at <  (p_metric_date + 1)::timestamptz),

    -- THE SCHOOL'S MASTERY INDEX, as of this date rather than on it. Mastery is
    -- cumulative state, not a daily event: a learner who mastered an objective
    -- in March is still masterful in June, and a day on which nobody sat an
    -- assessment is not a day on which the school forgot everything. So the
    -- tally reads all evidence up to and including this date.
    (SELECT round(avg(app_analytics_mastery_points(s.state)), 2)
       FROM (
         SELECT app_analytics_authoritative_mastery(e.user_id, e.objective_id) AS state
           FROM (SELECT DISTINCT ev.user_id, ev.objective_id
                   FROM objective_evidence ev
                  WHERE ev.user_id = ANY (v_learners)
                    AND ev.occurred_at < (p_metric_date + 1)::timestamptz) e
       ) s
      WHERE app_analytics_mastery_points(s.state) IS NOT NULL),

    -- A SESSION IS A CONVERSATION THAT SAW TRAFFIC TODAY, counted through the
    -- learner rather than through `ai_conversations.organization_id`. That
    -- column is derived from the COURSE (0027), and a course's organization is
    -- null for shared curriculum — so counting by it would silently report zero
    -- AI usage for every school studying centrally authored material, which is
    -- most of them. Reaching through the roster is both correct and immune to
    -- that column changing meaning later.
    (SELECT count(DISTINCT msg.conversation_id) FROM ai_messages msg
      WHERE msg.owner_id = ANY (v_learners)
        AND msg.created_at >= p_metric_date::timestamptz
        AND msg.created_at <  (p_metric_date + 1)::timestamptz),

    now()
  ON CONFLICT ON CONSTRAINT analytics_daily_school_metrics_day_uk DO UPDATE
    SET total_active_students = excluded.total_active_students,
        total_active_teachers = excluded.total_active_teachers,
        lessons_completed     = excluded.lessons_completed,
        quizzes_attempted     = excluded.quizzes_attempted,
        average_mastery_score = excluded.average_mastery_score,
        ai_tutor_sessions     = excluded.ai_tutor_sessions,
        updated_at            = now();
END;
$$;

REVOKE ALL ON FUNCTION app_analytics_refresh_daily(uuid, date) FROM PUBLIC;

-- ===========================================================================
-- THE COURSE-PERFORMANCE REFRESH
-- ===========================================================================
--
-- One school per call, every (class, course) pair in it. Same discipline: plain
-- reads, upsert, tenant taken once at the top.
--
-- THE STRUGGLING THRESHOLD IS A PARAMETER WITH A DEFAULT, not a literal buried
-- in a CASE. A school will want to move it, and the number that decides which
-- children get called in for extra help should be visible in a function
-- signature rather than discovered by reading SQL.
CREATE FUNCTION app_analytics_refresh_courses(
  p_organization_id uuid,
  p_struggling_below numeric DEFAULT 50.0
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'A refresh needs a school' USING ERRCODE = 'null_value_not_allowed';
  END IF;
  IF p_struggling_below < 0 OR p_struggling_below > 100 THEN
    RAISE EXCEPTION 'A mastery threshold is a percentage' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO analytics_course_performance AS p (
    organization_id, course_id, class_id,
    enrollment_count, completion_rate_pct, avg_quiz_score,
    flagged_struggling_students_count, updated_at
  )
  WITH pairs AS (
    -- THE TENANT CONSTRAINT, ONCE, AT THE TOP. Everything downstream is a join
    -- against this, so no aggregate below can reach a class in another school
    -- even if somebody later edits it carelessly.
    SELECT cca.class_id, cca.course_id, c.organization_id
      FROM class_course_assignments cca
      JOIN classes c ON c.id = cca.class_id
     WHERE c.organization_id = p_organization_id
       AND cca.status = 'active'
       AND c.status = 'active'
  ),
  roster AS (
    SELECT pr.class_id, pr.course_id, m.user_id
      FROM pairs pr
      JOIN class_memberships m
        ON m.class_id = pr.class_id AND m.status = 'active' AND m.role_in_class = 'student'
  ),
  -- Published lessons are the denominator of completion. A draft lesson is not
  -- work anybody was asked to do, and counting it would make a course look
  -- unfinished the moment an author started writing the next unit.
  course_lessons AS (
    SELECT pr.course_id, l.id AS lesson_id
      FROM (SELECT DISTINCT course_id FROM pairs) pr
      JOIN course_units cu ON cu.course_id = pr.course_id AND cu.status = 'published'
      JOIN lessons l ON l.unit_id = cu.id AND l.status = 'published'
  ),
  lesson_counts AS (
    SELECT course_id, count(*) AS lessons_total FROM course_lessons GROUP BY course_id
  ),
  completions AS (
    SELECT r.class_id, r.course_id, count(*) AS completed
      FROM roster r
      JOIN course_lessons cl ON cl.course_id = r.course_id
      JOIN lesson_progress lp
        ON lp.user_id = r.user_id AND lp.lesson_id = cl.lesson_id AND lp.status = 'completed'
     GROUP BY r.class_id, r.course_id
  ),
  -- SUBMITTED ATTEMPTS ONLY, and the score is the recorded percentage. An
  -- in-progress attempt has no score; averaging it as zero would drag a class's
  -- number down for the sole reason that somebody is mid-quiz right now.
  quiz_scores AS (
    SELECT r.class_id, r.course_id, avg(a.percentage) AS avg_pct
      FROM roster r
      JOIN course_lessons cl ON cl.course_id = r.course_id
      JOIN learning_activities la ON la.lesson_id = cl.lesson_id
      JOIN assessments s ON s.activity_id = la.id
      JOIN assessment_attempts a
        ON a.assessment_id = s.id AND a.user_id = r.user_id
       AND a.status = 'submitted' AND a.percentage IS NOT NULL
     GROUP BY r.class_id, r.course_id
  ),
  -- STRUGGLING IS ABOUT EVIDENCE, NOT ABSENCE. A learner with no evidence at
  -- all is not flagged: they may have started the course yesterday, and putting
  -- them on an intervention list would send a teacher to the wrong child. Only
  -- a learner who HAS produced evidence and is averaging below the threshold is
  -- counted.
  learner_mastery AS (
    SELECT r.class_id, r.course_id, r.user_id,
           avg(app_analytics_mastery_points(
             app_analytics_authoritative_mastery(pairs2.user_id, pairs2.objective_id))) AS pct
      FROM roster r
      JOIN LATERAL (
        SELECT DISTINCT ev.user_id, ev.objective_id
          FROM objective_evidence ev
          JOIN learning_objectives lo ON lo.id = ev.objective_id
          JOIN course_lessons cl2 ON cl2.lesson_id = lo.lesson_id AND cl2.course_id = r.course_id
         WHERE ev.user_id = r.user_id
      ) pairs2 ON true
     GROUP BY r.class_id, r.course_id, r.user_id
  ),
  struggling AS (
    SELECT class_id, course_id, count(*) AS n
      FROM learner_mastery
     WHERE pct IS NOT NULL AND pct < p_struggling_below
     GROUP BY class_id, course_id
  ),
  enrolments AS (
    SELECT class_id, course_id, count(*) AS n FROM roster GROUP BY class_id, course_id
  )
  SELECT
    pr.organization_id,
    pr.course_id,
    pr.class_id,
    coalesce(e.n, 0),
    CASE
      WHEN coalesce(e.n, 0) = 0 OR coalesce(lc.lessons_total, 0) = 0 THEN 0
      ELSE least(100, round(
        (coalesce(cm.completed, 0)::numeric * 100) / (e.n * lc.lessons_total), 2))
    END,
    round(qs.avg_pct, 2),
    coalesce(st.n, 0),
    now()
  FROM pairs pr
  LEFT JOIN enrolments    e  ON e.class_id  = pr.class_id AND e.course_id  = pr.course_id
  LEFT JOIN lesson_counts lc ON lc.course_id = pr.course_id
  LEFT JOIN completions   cm ON cm.class_id = pr.class_id AND cm.course_id = pr.course_id
  LEFT JOIN quiz_scores   qs ON qs.class_id = pr.class_id AND qs.course_id = pr.course_id
  LEFT JOIN struggling    st ON st.class_id = pr.class_id AND st.course_id = pr.course_id
  ON CONFLICT ON CONSTRAINT analytics_course_performance_uk DO UPDATE
    SET enrollment_count                  = excluded.enrollment_count,
        completion_rate_pct               = excluded.completion_rate_pct,
        avg_quiz_score                    = excluded.avg_quiz_score,
        flagged_struggling_students_count = excluded.flagged_struggling_students_count,
        updated_at                        = now();
END;
$$;

REVOKE ALL ON FUNCTION app_analytics_refresh_courses(uuid, numeric) FROM PUBLIC;

-- ===========================================================================
-- THE AT-RISK READER
-- ===========================================================================
--
-- The one endpoint in this task that returns rows about NAMED CHILDREN rather
-- than totals, which makes it the one that needs the most care.
--
-- SECTION 2B, THE FERPA CLAUSE: "high-level admin reports must summarize trends
-- without leaking raw individual student responses outside assigned
-- teacher-student boundaries." This function is where that line is drawn, and
-- it is drawn in two places at once:
--
--   WHO IT WILL ANSWER FOR. Only classes the caller actually teaches. An
--   organization administrator gets NOTHING from this function — not a reduced
--   list, nothing — because a head teacher does not need a named list of
--   struggling children to run a school, and the administrator's legitimate
--   view is the count in `analytics_course_performance`. The named list exists
--   for the adult who will actually sit down with the child.
--
--   WHAT IT RETURNS. A learner id, a display name, and a rounded index. NOT
--   their answers, NOT their scores on individual assessments, NOT which
--   questions they got wrong. "Falling below a threshold" is the finding; the
--   evidence behind it stays in the assessment endpoints, behind their own
--   authorization, where a teacher reaches it one child at a time.
--
-- It is a function rather than a table because it is about the present, and a
-- nightly snapshot of who is struggling would send a teacher to a child who
-- caught up on Tuesday.
CREATE FUNCTION app_analytics_at_risk(p_threshold numeric DEFAULT 50.0)
  RETURNS TABLE (
    class_id uuid,
    course_id uuid,
    student_id uuid,
    display_name text,
    mastery_index numeric,
    objectives_with_evidence integer
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  WITH taught AS (
    -- THE AUTHORIZATION, INSIDE THE FUNCTION AND NOT AROUND IT. A definer
    -- function that trusted its caller to have checked would be a hole with a
    -- comment on it.
    SELECT cca.class_id, cca.course_id
      FROM class_course_assignments cca
      JOIN classes c ON c.id = cca.class_id
     WHERE cca.status = 'active' AND c.status = 'active'
       AND app_actor_teaches_class(cca.class_id)
  ),
  roster AS (
    SELECT t.class_id, t.course_id, m.user_id
      FROM taught t
      JOIN class_memberships m
        ON m.class_id = t.class_id AND m.status = 'active' AND m.role_in_class = 'student'
  ),
  scored AS (
    SELECT r.class_id, r.course_id, r.user_id,
           avg(app_analytics_mastery_points(
             app_analytics_authoritative_mastery(p.user_id, p.objective_id))) AS pct,
           count(*) AS objectives
      FROM roster r
      JOIN LATERAL (
        SELECT DISTINCT ev.user_id, ev.objective_id
          FROM objective_evidence ev
          JOIN learning_objectives lo ON lo.id = ev.objective_id
          JOIN lessons l  ON l.id = lo.lesson_id AND l.status = 'published'
          JOIN course_units cu ON cu.id = l.unit_id AND cu.status = 'published'
         WHERE ev.user_id = r.user_id AND cu.course_id = r.course_id
      ) p ON true
     GROUP BY r.class_id, r.course_id, r.user_id
  )
  SELECT s.class_id, s.course_id, s.user_id, u.display_name,
         round(s.pct, 2), s.objectives::integer
    FROM scored s
    JOIN users u ON u.id = s.user_id
   WHERE s.pct IS NOT NULL AND s.pct < p_threshold
   ORDER BY s.pct ASC, u.display_name ASC;
$$;

REVOKE ALL ON FUNCTION app_analytics_at_risk(numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_analytics_at_risk(numeric) TO edu_app;

-- ===========================================================================
-- ROW-LEVEL SECURITY
-- ===========================================================================
ALTER TABLE analytics_daily_school_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_daily_school_metrics FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics_course_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_course_performance FORCE ROW LEVEL SECURITY;

/**
 * The executive dashboard is ADMINISTRATORS ONLY.
 *
 * Section 2C separates two audiences and this policy is the separation. A
 * school-wide row — every learner, every teacher, the whole institution's
 * index — answers a question about the institution, and the person accountable
 * for the institution is its administrator.
 *
 * A TEACHER IS NOT ADMITTED HERE, AT ALL. Not to their own school's row, not
 * read-only, not "just the totals". A teacher's legitimate analytics scope is
 * the classes they teach, and that is the other table. Section 2E asks for a
 * test that a teacher reaching for school-wide metrics is refused; this is the
 * line that refuses them.
 *
 * `app_actor_is_org_admin()` alone would be a platform-wide grant: it asks only
 * whether the actor holds the role, which is the established shape on this
 * platform (0014) precisely because every caller pairs it with the tenant
 * equality that follows it here. The pairing IS the cross-tenant boundary that
 * section 2C names, so it is written on one line and tested from both sides.
 */
CREATE POLICY analytics_daily_school_metrics_select
  ON analytics_daily_school_metrics FOR SELECT TO edu_app
  USING (
    app_actor_is_org_admin()
    AND organization_id IS NOT NULL
    AND organization_id = app_actor_organization()
  );

/**
 * Course performance is the ADMINISTRATOR'S school, or the TEACHER'S class.
 *
 * Two disjuncts, deliberately not one. An administrator sees every class in
 * their school because the whole school is their remit. A teacher sees the
 * classes they actively teach and no others — not their colleagues' classes,
 * not the rest of their department, not the year group.
 *
 * `app_actor_teaches_class` (0014) already requires an ACTIVE assignment to an
 * ACTIVE class, so a teacher who leaves stops seeing the class's numbers on the
 * same day they stop teaching it.
 */
CREATE POLICY analytics_course_performance_select
  ON analytics_course_performance FOR SELECT TO edu_app
  USING (
    (app_actor_is_org_admin()
       AND organization_id IS NOT NULL
       AND organization_id = app_actor_organization())
    OR app_actor_teaches_class(class_id)
  );

-- NO INSERT, UPDATE OR DELETE POLICY, AND NO WRITE GRANT, FOR `edu_app`.
--
-- These tables are derived. Every number in them is a fact about rows that live
-- somewhere else, and the only correct way to change one is to change the
-- underlying fact and refresh. A write path would be a way to make the
-- dashboard say something the school's data does not — which, for a table used
-- to judge teachers and children, is the failure mode worth designing out
-- rather than auditing.
--
-- The refresh functions write as the table owner, through the definer policies
-- below.
GRANT SELECT ON analytics_daily_school_metrics TO edu_app;
GRANT SELECT ON analytics_course_performance TO edu_app;

-- ---------------------------------------------------------------------------
-- THE DEFINER POLICIES.
-- ---------------------------------------------------------------------------
-- Migration 0014's rule, which this platform has now learned four times
-- (VULN-044, VULN-050, the 0028 finding, VULN-057): EVERY table a SECURITY
-- DEFINER function touches needs a policy for the definer role, for every
-- command it performs. `FORCE ROW LEVEL SECURITY` binds the owner too, so
-- without these the refresh functions would see zero rows and write zeroes —
-- silently, with no error, into a dashboard somebody trusts.
--
-- `tests/integration/rls-definer-coverage.test.ts` derives this list from
-- `pg_proc` and `pg_class` rather than taking it on trust.
CREATE POLICY analytics_daily_definer_all ON analytics_daily_school_metrics
  FOR ALL TO edu_migrator USING (true) WITH CHECK (true);
CREATE POLICY analytics_course_definer_all ON analytics_course_performance
  FOR ALL TO edu_migrator USING (true) WITH CHECK (true);

-- `ai_conversations` and `ai_messages` had NO definer policy before this
-- migration, because 0027 deliberately removed its definer helper in favour of
-- a composite foreign key (VULN-050). The daily refresh reads both to count
-- tutor sessions, so it needs them now — SELECT only, which is all it does.
CREATE POLICY ai_conversations_definer_select ON ai_conversations
  FOR SELECT TO edu_migrator USING (true);
CREATE POLICY ai_messages_definer_select ON ai_messages
  FOR SELECT TO edu_migrator USING (true);

COMMENT ON TABLE analytics_daily_school_metrics IS
  'Derived. One row per school per day. Administrators of that school only.';
COMMENT ON TABLE analytics_course_performance IS
  'Derived. One row per school/class/course. That school''s administrators, or the class''s teachers.';
