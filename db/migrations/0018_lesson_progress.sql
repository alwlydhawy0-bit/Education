-- =====================================================================
-- 0018 — Learner progress
-- =====================================================================
-- The first table in the platform that holds PER-CHILD data written by the
-- child themselves. Everything before this was either content (published to
-- many) or structure (rosters, assignments). A progress row says what one
-- named person did, and it is read by their teacher and their guardian.
--
-- THE ASYMMETRY THAT DEFINES THIS TABLE
--
-- Reading your own progress and writing it are gated DIFFERENTLY, on purpose:
--
--   WRITE — only for a lesson the learner currently reaches through a class
--           (the whole Task 006 chain: active assignment, active class, active
--           membership, published content).
--   READ  — your own rows, ALWAYS, with no access check at all.
--
-- That asymmetry is the retention rule. A learner removed from a class, or
-- whose class loses a course, keeps every row they wrote — the record of what
-- they studied is theirs and is not erased by an administrative act — but they
-- can no longer add to or change it. Gating the read the same way as the write
-- would quietly delete a child's history from their own view every time a
-- timetable changed.
--
-- FORWARD-ONLY, and why
--
--   not_started -> in_progress -> completed, and `completed` is terminal.
--
-- A learner may not un-complete a lesson. This is a record a teacher reads, so
-- "completed" has to mean something durable; a status the subject can toggle
-- back is not evidence of anything. Revisiting is still recorded — every touch
-- moves `last_accessed_at` — so nothing about re-study is lost, only the
-- ability to retract a completion.
-- =====================================================================

CREATE TABLE lesson_progress (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE on both ends, matching every other per-user table. A row about a
  -- person who no longer exists is not a record worth keeping, and the lesson
  -- FK is unreachable in practice: a lesson may only be deleted while DRAFT,
  -- and a draft lesson can never have been studied.
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id        uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,

  status           text NOT NULL DEFAULT 'not_started',
  completed_at     timestamptz,
  last_accessed_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT lesson_progress_status_ck CHECK (status IN ('not_started', 'in_progress', 'completed')),
  -- The timestamp and the status cannot disagree: a completed row records when.
  CONSTRAINT lesson_progress_completed_consistency_ck
    CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

-- One row per (learner, lesson), for all time. Unlike a roster membership,
-- progress has no "spells" to keep apart — the row IS the learner's running
-- record for that lesson, so a total unique constraint is right here where a
-- partial one was right in 0015.
CREATE UNIQUE INDEX lesson_progress_pair_uk ON lesson_progress (user_id, lesson_id);

-- Supports "everything this learner has done", which is `GET /me/progress` and
-- the teacher and guardian views alike.
CREATE INDEX lesson_progress_user_idx ON lesson_progress (user_id, last_accessed_at DESC);
CREATE INDEX lesson_progress_lesson_idx ON lesson_progress (lesson_id);

-- =====================================================================
-- Helpers
-- =====================================================================
-- Same discipline as 0014, 0016 and 0017: every cross-table check goes through
-- a SECURITY DEFINER helper, so no policy references another table directly and
-- the reference graph stays acyclic. And every table a definer function reads
-- needs an `edu_migrator` policy, or FORCE ROW LEVEL SECURITY makes it answer
-- false in silence (VULN-007, VULN-012).
-- =====================================================================

ALTER TABLE lesson_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE lesson_progress FORCE ROW LEVEL SECURITY;

CREATE POLICY lesson_progress_definer_select
  ON lesson_progress FOR SELECT TO edu_migrator USING (true);

/**
 * Whether the CURRENT actor holds a named role.
 *
 * `app_actor_is_org_admin` (0012) answers for `admin` OR `security_admin`
 * together, which is right for the surfaces it was written for — account
 * administration, rosters, classes. It is NOT right here.
 *
 * A security administrator manages accounts and lockouts. Giving them every
 * child's learning record in the school would merge two unrelated authorities
 * in one compromise, the same reasoning that withheld `content:publish` from
 * them in 0016. So the progress policy admits `admin` only, and this helper is
 * what lets RLS say the same thing — a boundary that only one of the two gates
 * enforced would be a disagreement, not extra safety (VULN-020).
 */
CREATE FUNCTION app_actor_holds_role(p_name text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = app_current_actor() AND r.name = p_name
  );
$$;

/**
 * Whether a NAMED user is an active member of an active class.
 *
 * Unlike `app_actor_is_member_of_class` (0014) this asks about somebody else,
 * so it does disclose one fact — "is that person in that class?" — to anyone
 * who can guess both ids. It exists because the teacher and administrator
 * progress views must answer `404` for a student who is NOT in the named class,
 * and an empty list would not satisfy that.
 *
 * The service calls it only AFTER establishing that the actor may see the class
 * at all, so the disclosure is bounded to people who already have standing
 * there. It is not granted to `edu_app` for any wider purpose.
 */
CREATE FUNCTION app_user_is_member_of_class(p_user_id uuid, p_class_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM class_memberships cm
    JOIN classes c ON c.id = cm.class_id
    WHERE cm.class_id = p_class_id
      AND cm.user_id = p_user_id
      AND cm.status = 'active'
      AND c.status = 'active'
  );
$$;

/** The course a lesson belongs to, two levels up. */
CREATE FUNCTION app_lesson_course(p_lesson_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT u.course_id
    FROM lessons l JOIN course_units u ON u.id = l.unit_id
   WHERE l.id = p_lesson_id;
$$;

/**
 * Whether the CURRENT actor may record progress against a lesson.
 *
 * The whole Task 006 chain in one place, plus the publication rule: the lesson
 * and both its ancestors published, the course actively assigned to an active
 * class, and the actor an active MEMBER of that class.
 *
 * Membership, deliberately — not `app_actor_reaches_course`, which also admits
 * a teacher. Recording progress is something a learner does; a teacher reading
 * the class's material is not studying it.
 */
CREATE FUNCTION app_actor_may_study_lesson(p_lesson_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM lessons l
    JOIN course_units u          ON u.id = l.unit_id
    JOIN courses co              ON co.id = u.course_id
    JOIN class_course_assignments a ON a.course_id = co.id
    JOIN classes c               ON c.id = a.class_id
    JOIN class_memberships cm    ON cm.class_id = c.id
    WHERE l.id = p_lesson_id
      AND l.status  = 'published'
      AND u.status  = 'published'
      AND co.status = 'published'
      AND a.status  = 'active'
      AND c.status  = 'active'
      AND cm.status = 'active'
      AND cm.user_id = app_current_actor()
  );
$$;

/**
 * Whether the CURRENT actor may observe one learner's progress on one lesson
 * AS THEIR TEACHER.
 *
 * The task's rule stated exactly: the learner is currently enrolled in a class
 * the actor teaches, AND the lesson's course is assigned TO THAT SAME CLASS.
 * The `c.id` shared by every join below is what makes it the same class — two
 * separate checks ("I teach them somewhere" and "I reach that course somewhere")
 * would let a teacher read a learner's progress on a course assigned to a
 * DIFFERENT class they happen to teach.
 *
 * Note what is NOT required: that the content still be published, or the
 * assignment still active at read time. A teacher may look at what a student
 * did last term. Only the ENROLMENT is required to be current, because that is
 * the relationship that makes them this child's teacher at all.
 */
CREATE FUNCTION app_actor_observes_learner_lesson(p_learner_id uuid, p_lesson_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM teacher_assignments ta
    JOIN classes c                  ON c.id = ta.class_id
    JOIN class_memberships cm       ON cm.class_id = c.id
    JOIN class_course_assignments a ON a.class_id  = c.id
    JOIN course_units u             ON u.course_id = a.course_id
    JOIN lessons l                  ON l.unit_id   = u.id
    WHERE ta.teacher_id = app_current_actor()
      AND ta.status = 'active'
      AND c.status  = 'active'
      AND cm.user_id = p_learner_id
      AND cm.status = 'active'
      AND l.id = p_lesson_id
  );
$$;

/**
 * The names around a lesson, for rendering a progress row.
 *
 * A DEFINER function rather than a join, and the reason is the retention rule
 * itself. A learner removed from a class keeps their progress rows — that is
 * the whole point of the read/write asymmetry above — but they immediately stop
 * being able to SEE the lesson (Task 006 narrowed content to what a class is
 * currently assigned). So an endpoint that joined `lessons` to render a title
 * would return NOTHING, silently erasing the learner's own history from their
 * own view and defeating the rule it was meant to serve. The same is true for a
 * verified guardian, who has no content access at all.
 *
 * THE DISCLOSURE THIS MAKES, stated plainly: whoever can read a progress row
 * learns the lesson, unit and course NAMES attached to it. That is bounded by
 * the progress row's own visibility — the owner, their verified guardian, their
 * teacher for that class, an administrator of their school — and it is the
 * minimum that makes the record legible. It does NOT disclose lesson CONTENT:
 * the body, the objectives and the links stay behind `lessons_select`.
 *
 * Every column is table-qualified. A `RETURNS TABLE` output name that collides
 * with a column is the ambiguity that caused VULN-008.
 */
CREATE FUNCTION app_lesson_label(p_lesson_id uuid)
  RETURNS TABLE (lesson_title text, unit_title text, course_id uuid, course_title text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT l.title, u.title, co.id, co.title
    FROM lessons l
    JOIN course_units u ON u.id = l.unit_id
    JOIN courses co     ON co.id = u.course_id
   WHERE l.id = p_lesson_id;
$$;

REVOKE ALL ON FUNCTION app_user_is_member_of_class(uuid, uuid)          FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_user_is_member_of_class(uuid, uuid)       TO edu_app;

REVOKE ALL ON FUNCTION app_actor_holds_role(text)                       FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_actor_holds_role(text)                    TO edu_app;

REVOKE ALL ON FUNCTION app_lesson_label(uuid)                           FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_lesson_label(uuid)                        TO edu_app;

REVOKE ALL ON FUNCTION app_lesson_course(uuid)                          FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_may_study_lesson(uuid)                 FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_observes_learner_lesson(uuid, uuid)    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_lesson_course(uuid)                       TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_may_study_lesson(uuid)              TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_observes_learner_lesson(uuid, uuid) TO edu_app;

-- =====================================================================
-- Integrity trigger
-- =====================================================================

/**
 * The progress state machine, and the immutability of the row's subject.
 *
 * A row-level policy sees only the NEW row, so it cannot tell that `status` went
 * BACKWARDS, nor that `user_id` was re-pointed at another child. Both need OLD,
 * so both are here — the same reasoning as the lifecycle guards in 0016 and
 * 0017.
 */
CREATE FUNCTION lesson_progress_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id OR NEW.lesson_id <> OLD.lesson_id THEN
    RAISE EXCEPTION 'The learner or lesson of a progress row cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- Forward only. `completed` is terminal.
    IF NOT (
         (OLD.status = 'not_started' AND NEW.status IN ('in_progress', 'completed'))
      OR (OLD.status = 'in_progress' AND NEW.status = 'completed')
    ) THEN
      RAISE EXCEPTION 'Unsupported progress transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  -- A completion timestamp is written once and never moved. Without this, a
  -- learner could re-stamp an old completion as today's work.
  IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    RAISE EXCEPTION 'A completion timestamp cannot be changed once set'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER lesson_progress_guard_trigger
  BEFORE UPDATE ON lesson_progress
  FOR EACH ROW EXECUTE FUNCTION lesson_progress_guard();

-- =====================================================================
-- Row-Level Security
-- =====================================================================

/**
 * Four ways to read somebody's progress, and one of them is "it is yours".
 *
 * The owner's branch carries NO access check. That is the retention rule: an
 * administrative change to a timetable must not erase a child's record from
 * their own view. Every other branch passes through the relationship graph
 * built in Tasks 003, 004 and 006, and each is a definer helper so this policy
 * touches no other table directly.
 */
CREATE POLICY lesson_progress_select ON lesson_progress FOR SELECT TO edu_app
  USING (
    app_actor_is_platform_operator()
    OR user_id = app_current_actor()
    -- A VERIFIED guardian of this child (0014). A pending claim grants nothing.
    OR app_actor_guards(user_id)
    -- Their teacher, for a lesson assigned to the class they share.
    OR app_actor_observes_learner_lesson(user_id, lesson_id)
    -- An administrator of their school. `admin` specifically, not
    -- `app_actor_is_org_admin()`, which would also admit `security_admin`.
    OR (
      app_actor_holds_role('admin')
      AND app_user_organization(user_id) IS NOT NULL
      AND app_user_organization(user_id) = app_actor_organization()
    )
  );

/**
 * Writing is the learner's alone, and only while they still have the lesson.
 *
 * `user_id = app_current_actor()` is the whole of "whose row is this" — there
 * is no branch here for a teacher, an administrator or a platform operator,
 * because nobody may author a claim about what another person studied.
 */
CREATE POLICY lesson_progress_insert ON lesson_progress FOR INSERT TO edu_app
  WITH CHECK (
    user_id = app_current_actor()
    AND app_actor_may_study_lesson(lesson_id)
  );

CREATE POLICY lesson_progress_update ON lesson_progress FOR UPDATE TO edu_app
  USING (
    user_id = app_current_actor()
    AND app_actor_may_study_lesson(lesson_id)
  )
  WITH CHECK (
    user_id = app_current_actor()
    AND app_actor_may_study_lesson(lesson_id)
  );

-- NO DELETE POLICY, and no DELETE privilege below.
--
-- Progress is a record of what a child did. There is no endpoint that removes
-- one and no policy that would permit it; rows leave only when the learner's
-- account does, through the FK cascade.
GRANT SELECT, INSERT, UPDATE ON lesson_progress TO edu_app;
