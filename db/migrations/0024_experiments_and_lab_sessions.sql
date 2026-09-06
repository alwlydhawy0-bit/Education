-- ============================================================================
-- 0024 — INTERACTIVE 2D EXPERIMENTS: LABS, SESSIONS, ARTIFACTS
-- ============================================================================
--
-- An experiment is a practical lab a learner works through in the browser: a
-- circuit to close, a logic gate to wire, a physics scene to settle. The
-- browser runs the simulation; THIS SERVER RUNS NOTHING. It stores the state
-- the learner reached and decides, from declarative rules, whether that state
-- satisfies the lab.
--
-- THREE DECISIONS SHAPE EVERYTHING BELOW
--
-- 1. AN EXPERIMENT HANGS OFF A learning_activity, exactly as an assessment
--    does. `learning_activities.activity_type` has reserved 'simulation' and
--    'experiment' since 0019. Hanging off it inherits the whole authorization
--    graph — lesson, unit, course, class assignment, organization — with no
--    second copy of any of it, and inherits draft/published from the activity
--    so there is one publication state, not two.
--
-- 2. THE VALIDATION RULES ARE AN ANSWER KEY, and they live in their own table
--    for the same reason `assessment_answer_keys` does. A learner who can read
--    "voltage must equal 5" has been handed the answer. Row Level Security is
--    row-level, and a learner and an author are both `edu_app`, so a column on
--    `experiments` could not be hidden from one and shown to the other. A
--    separate table is the only shape where RLS can tell them apart.
--
-- 3. THE RULE LANGUAGE HAS NO EVALUATOR. It is a flat list of comparisons over
--    bounded dot-paths, checked by `app_experiment_state_satisfies`. There is
--    no expression to parse, no recursion, no function call, and therefore
--    nothing to escape from. A rule either matches the state or it does not.
--    The most dangerous thing a malicious `validation_rules` value can do is
--    fail to match.
-- ============================================================================

-- ── EXPERIMENTS ─────────────────────────────────────────────────────────────

CREATE TABLE experiments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL UNIQUE REFERENCES learning_activities(id) ON DELETE CASCADE,

  -- What the browser is being asked to draw. The server never interprets this;
  -- it decides which client-side simulator to load. `code_sandbox` names a
  -- sandbox that runs IN THE BROWSER — nothing here executes learner code, and
  -- nothing here should ever start to.
  simulation_type text NOT NULL,

  -- The scene the learner starts from. Public to anyone who may see the
  -- activity: it is the question, not the answer.
  initial_config jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT experiments_simulation_type_ck
    CHECK (simulation_type IN ('circuit', 'physics', 'logic_gate', 'code_sandbox')),

  -- A byte ceiling stated as a constraint, not as a hope about the API. 64 KiB
  -- is a generous scene and a poor denial-of-service payload.
  CONSTRAINT experiments_initial_config_kind_ck CHECK (jsonb_typeof(initial_config) = 'object'),
  CONSTRAINT experiments_initial_config_size_ck
    CHECK (pg_column_size(initial_config) <= 65536)
);

-- ── VALIDATION RULES — THE ANSWER KEY ───────────────────────────────────────
--
-- One row per experiment. Separate table so RLS can show it to the author who
-- wrote it and hide it from the child sitting the lab.

CREATE TABLE experiment_validation_rules (
  experiment_id uuid PRIMARY KEY REFERENCES experiments(id) ON DELETE CASCADE,

  -- {"rules": [{"path": "...", "op": "...", "value": ...}, ...]}
  -- Shape is enforced by `app_experiment_rules_are_well_formed` at publication,
  -- where the same gate validates an assessment's questions.
  rules jsonb NOT NULL DEFAULT '{"rules": []}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT experiment_validation_rules_kind_ck CHECK (jsonb_typeof(rules) = 'object'),
  CONSTRAINT experiment_validation_rules_size_ck CHECK (pg_column_size(rules) <= 65536)
);

-- ── SESSIONS ────────────────────────────────────────────────────────────────
--
-- NO class_id COLUMN, DELIBERATELY.
--
-- The class is not a property of the lab work; it is a relationship that holds
-- at a moment, and `app_actor_observes_learner_lesson` resolves it live. A
-- stored class_id would be a second source of truth that goes stale the day a
-- child changes class, and a field a client could suggest. Same reasoning as
-- `lesson_progress` and `assessment_attempts`, neither of which stores one.

CREATE TABLE experiment_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- in_progress -> submitted (rules not satisfied) | completed (satisfied).
  -- `completed` is a fact the server decided, never a word the client sent.
  status text NOT NULL DEFAULT 'in_progress',

  current_state jsonb NOT NULL DEFAULT '{}'::jsonb,

  passed       boolean,
  started_at   timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  completed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT experiment_sessions_status_ck
    CHECK (status IN ('in_progress', 'submitted', 'completed')),

  CONSTRAINT experiment_sessions_state_kind_ck CHECK (jsonb_typeof(current_state) = 'object'),
  -- 256 KiB. A circuit with a few hundred components fits comfortably; a state
  -- blob big enough to hurt the database does not.
  CONSTRAINT experiment_sessions_state_size_ck
    CHECK (pg_column_size(current_state) <= 262144),

  -- The three states, each fully determined. Written as a CASE rather than a
  -- set of implications for the reason VULN-026 taught in 0019: an implication
  -- leaves holes where both sides are false and a nonsense row slips through.
  CONSTRAINT experiment_sessions_lifecycle_ck CHECK (
    CASE status
      WHEN 'in_progress' THEN
        submitted_at IS NULL AND completed_at IS NULL AND passed IS NULL
      WHEN 'submitted' THEN
        submitted_at IS NOT NULL AND completed_at IS NULL AND passed = false
      WHEN 'completed' THEN
        submitted_at IS NOT NULL AND completed_at IS NOT NULL AND passed = true
    END
  )
);

-- §2A: at most one live session per learner per experiment. Partial, so a
-- learner may hold one active session and any number of finished ones.
CREATE UNIQUE INDEX experiment_sessions_one_active_uk
  ON experiment_sessions (experiment_id, user_id)
  WHERE status = 'in_progress';

CREATE INDEX experiment_sessions_owner_ix ON experiment_sessions (user_id, experiment_id);

-- ── ARTIFACTS ───────────────────────────────────────────────────────────────
--
-- Append-only by privilege: SELECT and INSERT are granted below, UPDATE and
-- DELETE are not. A telemetry log that can be rewritten is not telemetry.

CREATE TABLE experiment_artifacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES experiment_sessions(id) ON DELETE CASCADE,

  artifact_type text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT experiment_artifacts_type_ck
    CHECK (artifact_type IN ('snapshot', 'telemetry_log', 'output_result')),
  CONSTRAINT experiment_artifacts_payload_kind_ck CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT experiment_artifacts_payload_size_ck CHECK (pg_column_size(payload) <= 131072)
);

CREATE INDEX experiment_artifacts_session_ix ON experiment_artifacts (session_id, created_at);

-- ============================================================================
-- DEFINER HELPERS
--
-- Every policy below reaches other tables only through one of these, so no
-- policy ever names a second table directly — the rule 0018 and 0019 follow.
-- ============================================================================

CREATE FUNCTION app_experiment_activity(p_experiment_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT e.activity_id FROM experiments e WHERE e.id = p_experiment_id $$;

CREATE FUNCTION app_experiment_lesson(p_experiment_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT app_activity_lesson(app_experiment_activity(p_experiment_id)) $$;

/**
 * INVOKER RIGHTS, NOT DEFINER — and the whole visibility model turns on it.
 *
 * `app_actor_sees_activity` is itself invoker-rights on purpose: it is an
 * EXISTS over `learning_activities`, and what makes it an authorization check
 * rather than a lookup is that the caller's own Row Level Security decides
 * which activities exist for them. Wrapping it in a SECURITY DEFINER function
 * runs that EXISTS as the table OWNER, for whom every row exists, so it
 * returns true unconditionally.
 *
 * It was written SECURITY DEFINER, matching its neighbours here rather than
 * its counterpart in 0019, and `experiments_select` therefore admitted
 * everybody — a draft lab to a learner, and a lab to a teacher at another
 * school. Found by the probe in tests/integration/rls-experiments.test.ts
 * before any application code existed. Every sibling in the schema
 * (`app_actor_sees_lesson`, `_activity`, `_assessment`, `_question`) is
 * invoker-rights; this one is now the fifth.
 */
CREATE FUNCTION app_actor_sees_experiment(p_experiment_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $$ SELECT app_actor_sees_activity(app_experiment_activity(p_experiment_id)) $$;

CREATE FUNCTION app_experiment_organization(p_experiment_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT app_activity_organization(app_experiment_activity(p_experiment_id)) $$;

CREATE FUNCTION app_session_experiment(p_session_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT s.experiment_id FROM experiment_sessions s WHERE s.id = p_session_id $$;

CREATE FUNCTION app_session_owner(p_session_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT s.user_id FROM experiment_sessions s WHERE s.id = p_session_id $$;

CREATE FUNCTION app_session_status(p_session_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT s.status FROM experiment_sessions s WHERE s.id = p_session_id $$;

CREATE FUNCTION app_session_lesson(p_session_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT app_experiment_lesson(app_session_experiment(p_session_id)) $$;

/**
 * A label for an experiment, for the one place a name may cross a boundary
 * that the row itself may not. Mirrors `app_assessment_label`.
 */
CREATE FUNCTION app_experiment_label(p_experiment_id uuid)
  RETURNS TABLE (title text, lesson_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT a.title, a.lesson_id
  FROM learning_activities a
  WHERE a.id = app_experiment_activity(p_experiment_id)
$$;

-- ============================================================================
-- THE RULE LANGUAGE
--
-- A rule is {"path": "a.b.c", "op": "<operator>", "value": <json>}.
--
-- `path`  a dot-separated walk into the state object. Segments are
--         [A-Za-z0-9_] only and at most 8 deep, so a path cannot be built to
--         wander or to blow the stack. No wildcards, no array slicing, no `..`.
-- `op`    one of a closed set. Anything else makes the rule set malformed and
--         the experiment unpublishable.
-- `value` compared, never executed.
--
-- Evaluation is TOTAL: a path that does not resolve is a rule that fails. It
-- is never an error, because an error on a child's submission would be a way
-- to make the lab unmarkable.
-- ============================================================================

CREATE FUNCTION app_experiment_path_is_safe(p_path text) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public
AS $$
  SELECT p_path IS NOT NULL
     AND p_path <> ''
     AND length(p_path) <= 200
     AND p_path ~ '^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,7}$'
$$;

/**
 * Resolves a safe dot-path against a state object, or NULL if it does not
 * resolve. `#>` takes the path as an array, so nothing is interpolated into a
 * query and there is no injection surface.
 */
CREATE FUNCTION app_experiment_state_at(p_state jsonb, p_path text) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN NOT app_experiment_path_is_safe(p_path) THEN NULL
    ELSE p_state #> string_to_array(p_path, '.')
  END
$$;

/**
 * One rule against one state. Returns false for anything it does not
 * understand — an unknown operator, an unresolvable path, a value of the wrong
 * shape. Never raises.
 */
CREATE FUNCTION app_experiment_rule_holds(p_state jsonb, p_rule jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public
AS $$
DECLARE
  found jsonb;
  op    text;
  want  jsonb;
  a     numeric;
  b     numeric;
BEGIN
  IF jsonb_typeof(p_rule) <> 'object' THEN RETURN false; END IF;

  op   := p_rule ->> 'op';
  want := p_rule -> 'value';
  found := app_experiment_state_at(p_state, p_rule ->> 'path');

  IF op IS NULL THEN RETURN false; END IF;

  -- Presence operators come first: they are the only ones defined when the
  -- path does not resolve.
  IF op = 'exists'    THEN RETURN found IS NOT NULL; END IF;
  IF op = 'absent'    THEN RETURN found IS NULL;     END IF;
  IF found IS NULL    THEN RETURN false;             END IF;

  IF op = 'eq'      THEN RETURN found = want;  END IF;
  IF op = 'neq'     THEN RETURN found <> want; END IF;
  IF op = 'isTrue'  THEN RETURN found = 'true'::jsonb;  END IF;
  IF op = 'isFalse' THEN RETURN found = 'false'::jsonb; END IF;

  IF op IN ('lengthEq', 'lengthGte', 'lengthLte') THEN
    IF jsonb_typeof(found) <> 'array' OR jsonb_typeof(want) <> 'number' THEN RETURN false; END IF;
    a := jsonb_array_length(found);
    b := (want #>> '{}')::numeric;
    RETURN CASE op
      WHEN 'lengthEq'  THEN a =  b
      WHEN 'lengthGte' THEN a >= b
      ELSE                  a <= b
    END;
  END IF;

  IF op IN ('gt', 'gte', 'lt', 'lte', 'approx') THEN
    IF jsonb_typeof(found) <> 'number' OR jsonb_typeof(want) <> 'number' THEN RETURN false; END IF;
    a := (found #>> '{}')::numeric;
    b := (want  #>> '{}')::numeric;
    IF op = 'approx' THEN
      -- Physics does not land on exact decimals. Tolerance is the rule's own,
      -- defaulting to a hair rather than to zero.
      RETURN abs(a - b) <= COALESCE((p_rule ->> 'tolerance')::numeric, 0.001);
    END IF;
    RETURN CASE op WHEN 'gt' THEN a > b WHEN 'gte' THEN a >= b
                   WHEN 'lt' THEN a < b ELSE a <= b END;
  END IF;

  -- Unknown operator. A rule nobody can satisfy is safer than a rule everybody
  -- satisfies, so this is false and not true.
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  -- Totality, restated at runtime. A malformed value must not make a child's
  -- submission unmarkable.
  RETURN false;
END
$$;

/**
 * THE VALIDATION ENGINE. Every rule must hold. An empty rule set is satisfied
 * — an experiment with nothing to check is a sandbox, and finishing it is
 * simply finishing it.
 */
CREATE FUNCTION app_experiment_state_satisfies(p_experiment_id uuid, p_state jsonb)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(
    bool_and(app_experiment_rule_holds(p_state, rule)),
    true
  )
  FROM experiment_validation_rules v
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(v.rules -> 'rules') = 'array'
         THEN v.rules -> 'rules'
         ELSE '[]'::jsonb END
  ) AS rule
  WHERE v.experiment_id = p_experiment_id
$$;

/**
 * The publication gate, mirroring `app_assessment_is_well_formed`. A rule set
 * is checked ONCE, at the moment the activity is published and the lab becomes
 * visible to children — the same instant 0019 chose for assessments.
 */
CREATE FUNCTION app_experiment_rules_are_well_formed(p_experiment_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM experiment_validation_rules v
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(v.rules -> 'rules') = 'array'
           THEN v.rules -> 'rules'
           ELSE '[]'::jsonb END
    ) AS rule
    WHERE v.experiment_id = p_experiment_id
      AND (
        jsonb_typeof(rule) <> 'object'
        OR NOT app_experiment_path_is_safe(rule ->> 'path')
        OR COALESCE(rule ->> 'op', '') NOT IN (
          'exists', 'absent', 'eq', 'neq', 'isTrue', 'isFalse',
          'lengthEq', 'lengthGte', 'lengthLte',
          'gt', 'gte', 'lt', 'lte', 'approx'
        )
      )
  )
  -- A rules row must exist at all. An experiment published with no rules row
  -- would be silently unmarkable.
  AND EXISTS (SELECT 1 FROM experiment_validation_rules v WHERE v.experiment_id = p_experiment_id)
$$;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

CREATE FUNCTION experiment_matches_activity() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  kind text;
BEGIN
  SELECT a.activity_type INTO kind FROM learning_activities a WHERE a.id = NEW.activity_id;
  IF kind IS NULL THEN
    RAISE EXCEPTION 'Unknown activity' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF kind NOT IN ('simulation', 'experiment') THEN
    RAISE EXCEPTION 'Only a simulation or experiment activity may carry an experiment'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.activity_id <> OLD.activity_id THEN
    RAISE EXCEPTION 'An experiment cannot be moved to another activity'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER experiments_match_activity
  BEFORE INSERT OR UPDATE ON experiments
  FOR EACH ROW EXECUTE FUNCTION experiment_matches_activity();

/**
 * The scene and the answer key freeze when the lab is published, for the reason
 * 0019 freezes questions: a child who sat the lab yesterday and one sitting it
 * today must have been asked the same thing.
 */
CREATE FUNCTION experiment_content_is_draft_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  target uuid;
  state  text;
  rec    jsonb;
BEGIN
  -- The row is reached through `to_jsonb`, NOT through NEW.id / NEW.experiment_id.
  --
  -- One function guards two tables whose key columns are named differently, and
  -- plpgsql resolves a record field reference even on the branch it does not
  -- take: `CASE ... WHEN 'experiments' THEN NEW.id ELSE NEW.experiment_id END`
  -- raises `record "new" has no field "id"` on every insert into
  -- experiment_validation_rules. Found by probing this migration before any
  -- application code was written, which is the only reason it is not a
  -- production defect: the failure is at INSERT, so authoring a lab's rules
  -- would have been impossible.
  rec := to_jsonb(CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END);

  IF TG_TABLE_NAME = 'experiments' THEN
    target := (rec ->> 'id')::uuid;
  ELSE
    target := (rec ->> 'experiment_id')::uuid;
  END IF;

  SELECT a.status INTO state
  FROM learning_activities a
  WHERE a.id = app_experiment_activity(target);

  IF state IS NOT NULL AND state <> 'draft' THEN
    RAISE EXCEPTION 'A published experiment cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

CREATE TRIGGER experiments_draft_only
  BEFORE UPDATE OR DELETE ON experiments
  FOR EACH ROW EXECUTE FUNCTION experiment_content_is_draft_only();

CREATE TRIGGER experiment_validation_rules_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON experiment_validation_rules
  FOR EACH ROW EXECUTE FUNCTION experiment_content_is_draft_only();

/**
 * Starting a session. EVERY authoritative column is assigned here, so a client
 * that posts `{"status": "completed", "passed": true}` is posting into fields
 * this trigger is about to overwrite.
 */
CREATE FUNCTION experiment_session_start_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF app_experiment_activity(NEW.experiment_id) IS NULL THEN
    RAISE EXCEPTION 'Unknown experiment' USING ERRCODE = 'foreign_key_violation';
  END IF;

  NEW.status        := 'in_progress';
  NEW.current_state := COALESCE(NEW.current_state, '{}'::jsonb);
  NEW.passed        := NULL;
  NEW.started_at    := now();
  NEW.submitted_at  := NULL;
  NEW.completed_at  := NULL;
  RETURN NEW;
END
$$;

CREATE TRIGGER experiment_sessions_start
  BEFORE INSERT ON experiment_sessions
  FOR EACH ROW EXECUTE FUNCTION experiment_session_start_guard();

/**
 * THE SUBMISSION GATE — where §3's "never trust client-reported completion"
 * actually lives.
 *
 * The client may change exactly two things: `current_state`, and `status` from
 * 'in_progress' to 'submitted' to mean "mark this". Everything else it sends is
 * discarded, and the outcome is computed here from the rules the learner cannot
 * read. A payload claiming `passed: true` reaches this trigger and leaves it
 * carrying whatever the rules actually decided.
 *
 * SECURITY DEFINER for one reason, exactly as `assessment_attempt_submit_guard`
 * is in 0019: `app_experiment_state_satisfies` is granted to nobody, because
 * anyone who could call it could probe the answer key a state at a time. The
 * marking has to happen somewhere the learner cannot stand, and this trigger is
 * that place. It reads no table the learner named and returns nothing to them
 * but the verdict.
 */
CREATE FUNCTION experiment_session_submit_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  satisfied boolean;
BEGIN
  IF OLD.status <> 'in_progress' THEN
    RAISE EXCEPTION 'This lab session has already been submitted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Identity is never re-pointed by an update.
  NEW.id            := OLD.id;
  NEW.experiment_id := OLD.experiment_id;
  NEW.user_id       := OLD.user_id;
  NEW.started_at    := OLD.started_at;
  NEW.updated_at    := now();

  IF NEW.status = 'in_progress' THEN
    -- A save. State moves; nothing else may.
    NEW.passed       := NULL;
    NEW.submitted_at := NULL;
    NEW.completed_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.status <> 'submitted' THEN
    -- 'completed' is the server's word, never the client's. A client asking for
    -- it directly is asking to mark its own work.
    RAISE EXCEPTION 'A lab session is submitted, never completed directly'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  satisfied := app_experiment_state_satisfies(NEW.experiment_id, NEW.current_state);

  NEW.submitted_at := now();
  NEW.passed       := satisfied;
  NEW.status       := CASE WHEN satisfied THEN 'completed' ELSE 'submitted' END;
  NEW.completed_at := CASE WHEN satisfied THEN now() ELSE NULL END;
  RETURN NEW;
END
$$;

CREATE TRIGGER experiment_sessions_submit
  BEFORE UPDATE ON experiment_sessions
  FOR EACH ROW EXECUTE FUNCTION experiment_session_submit_guard();

/**
 * An artifact belongs to the session named on it, and only its owner may add
 * one. The RLS policy says the same thing; this says it again for the paths RLS
 * does not cover — the migration role, and any future definer function.
 */
CREATE FUNCTION experiment_artifact_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF app_session_owner(NEW.session_id) IS NULL THEN
    RAISE EXCEPTION 'Unknown lab session' USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER experiment_artifacts_insert
  BEFORE INSERT ON experiment_artifacts
  FOR EACH ROW EXECUTE FUNCTION experiment_artifact_guard();

/**
 * Extends 0019's publication gate to labs. An experiment activity cannot be
 * published until its experiment exists and its rules are well formed —
 * otherwise it would go live unmarkable.
 */
CREATE FUNCTION experiment_activity_publication_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  target uuid;
BEGIN
  IF NEW.status = 'published'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'published')
     AND NEW.activity_type IN ('simulation', 'experiment') THEN
    SELECT e.id INTO target FROM experiments e WHERE e.activity_id = NEW.id;
    IF target IS NULL THEN
      RAISE EXCEPTION 'An experiment activity cannot be published before its experiment exists'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT app_experiment_rules_are_well_formed(target) THEN
      RAISE EXCEPTION 'This experiment has validation rules that cannot be evaluated and cannot be published'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER learning_activities_experiment_publication
  BEFORE INSERT OR UPDATE ON learning_activities
  FOR EACH ROW EXECUTE FUNCTION experiment_activity_publication_guard();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE experiments                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiments                  FORCE  ROW LEVEL SECURITY;
ALTER TABLE experiment_validation_rules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment_validation_rules  FORCE  ROW LEVEL SECURITY;
ALTER TABLE experiment_sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment_sessions          FORCE  ROW LEVEL SECURITY;
ALTER TABLE experiment_artifacts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment_artifacts         FORCE  ROW LEVEL SECURITY;

-- FORCE applies to the owner too, so the migration role needs its own policy
-- on every table it must still reach. Same shape as 0018 and 0019.
CREATE POLICY experiments_definer_all ON experiments
  FOR ALL TO edu_migrator USING (true) WITH CHECK (true);
CREATE POLICY experiment_validation_rules_definer_all ON experiment_validation_rules
  FOR ALL TO edu_migrator USING (true) WITH CHECK (true);
CREATE POLICY experiment_sessions_definer_all ON experiment_sessions
  FOR ALL TO edu_migrator USING (true) WITH CHECK (true);
CREATE POLICY experiment_artifacts_definer_all ON experiment_artifacts
  FOR ALL TO edu_migrator USING (true) WITH CHECK (true);

-- ── experiments: the question, visible to whoever may see the activity ──────

CREATE POLICY experiments_select ON experiments FOR SELECT TO edu_app
  USING (app_actor_sees_experiment(id));

CREATE POLICY experiments_insert ON experiments FOR INSERT TO edu_app
  WITH CHECK (
    (app_actor_authors_content() OR app_actor_publishes_content())
    AND app_experiment_organization(id) IS NOT NULL
    AND app_experiment_organization(id) = app_actor_organization()
  );

CREATE POLICY experiments_update ON experiments FOR UPDATE TO edu_app
  USING (
    (app_actor_authors_content() OR app_actor_publishes_content())
    AND app_experiment_organization(id) = app_actor_organization()
  )
  WITH CHECK (
    (app_actor_authors_content() OR app_actor_publishes_content())
    AND app_experiment_organization(id) = app_actor_organization()
  );

-- ── validation rules: THE ANSWER KEY. No learner branch exists. ─────────────
--
-- Exactly the shape of `assessment_answer_keys_select`. A learner is not
-- refused by the application here; the row is not returned to them at all.

CREATE POLICY experiment_validation_rules_select ON experiment_validation_rules
  FOR SELECT TO edu_app
  USING (
    app_actor_is_platform_operator()
    OR (
      (app_actor_authors_content() OR app_actor_publishes_content())
      AND app_experiment_organization(experiment_id) IS NOT NULL
      AND app_experiment_organization(experiment_id) = app_actor_organization()
    )
  );

CREATE POLICY experiment_validation_rules_insert ON experiment_validation_rules
  FOR INSERT TO edu_app
  WITH CHECK (
    (app_actor_authors_content() OR app_actor_publishes_content())
    AND app_experiment_organization(experiment_id) IS NOT NULL
    AND app_experiment_organization(experiment_id) = app_actor_organization()
  );

CREATE POLICY experiment_validation_rules_update ON experiment_validation_rules
  FOR UPDATE TO edu_app
  USING (
    (app_actor_authors_content() OR app_actor_publishes_content())
    AND app_experiment_organization(experiment_id) = app_actor_organization()
  )
  WITH CHECK (
    (app_actor_authors_content() OR app_actor_publishes_content())
    AND app_experiment_organization(experiment_id) = app_actor_organization()
  );

-- ── sessions ────────────────────────────────────────────────────────────────
--
-- Reading mirrors `assessment_attempts_select` and `lesson_progress_select`:
-- the owner unconditionally (retention — an administrative change to a
-- timetable must not erase a child's lab work from their own view), then the
-- relationship graph.

CREATE POLICY experiment_sessions_select ON experiment_sessions FOR SELECT TO edu_app
  USING (
    app_actor_is_platform_operator()
    OR user_id = app_current_actor()
    OR app_actor_guards(user_id)
    OR app_actor_observes_learner_lesson(user_id, app_experiment_lesson(experiment_id))
    OR (
      app_actor_holds_role('admin')
      AND app_user_organization(user_id) IS NOT NULL
      AND app_user_organization(user_id) = app_actor_organization()
    )
  );

-- §3 INSTANT STATE ISOLATION. `app_actor_may_study_lesson` is evaluated on
-- every write, so the moment a learner leaves the class or the course is
-- withdrawn, the next save is refused — while the SELECT policy above keeps
-- the work readable.
CREATE POLICY experiment_sessions_insert ON experiment_sessions FOR INSERT TO edu_app
  WITH CHECK (
    user_id = app_current_actor()
    AND app_actor_sees_experiment(experiment_id)
    AND app_actor_may_study_lesson(app_experiment_lesson(experiment_id))
  );

CREATE POLICY experiment_sessions_update ON experiment_sessions FOR UPDATE TO edu_app
  USING (
    user_id = app_current_actor()
    AND status = 'in_progress'
    AND app_actor_sees_experiment(experiment_id)
    AND app_actor_may_study_lesson(app_experiment_lesson(experiment_id))
  )
  WITH CHECK (user_id = app_current_actor());

-- ── artifacts ───────────────────────────────────────────────────────────────
--
-- Visible to whoever may see the session; appendable only by its owner, and
-- only while the session is live.

CREATE POLICY experiment_artifacts_select ON experiment_artifacts FOR SELECT TO edu_app
  USING (
    app_actor_is_platform_operator()
    OR app_session_owner(session_id) = app_current_actor()
    OR app_actor_guards(app_session_owner(session_id))
    OR app_actor_observes_learner_lesson(app_session_owner(session_id), app_session_lesson(session_id))
    OR (
      app_actor_holds_role('admin')
      AND app_user_organization(app_session_owner(session_id)) IS NOT NULL
      AND app_user_organization(app_session_owner(session_id)) = app_actor_organization()
    )
  );

CREATE POLICY experiment_artifacts_insert ON experiment_artifacts FOR INSERT TO edu_app
  WITH CHECK (
    app_session_owner(session_id) = app_current_actor()
    AND app_session_status(session_id) = 'in_progress'
    AND app_actor_may_study_lesson(app_session_lesson(session_id))
  );

-- ============================================================================
-- PRIVILEGES
--
-- No DELETE anywhere, and no UPDATE on artifacts. Lab work is a record of what
-- a child did.
-- ============================================================================

-- EXECUTE ON A FUNCTION IS GRANTED TO PUBLIC BY DEFAULT. Declining to name a
-- function in the GRANT list below does not withhold it — PostgreSQL has
-- already given it to everyone, `edu_app` included. Withholding takes an
-- explicit REVOKE, which is why every migration from 0006 onward writes one.
--
-- 0024 shipped its first revision without this block, so
-- `app_experiment_state_satisfies` — the marker, which reads the answer key —
-- was callable by the application role despite the comment at the foot of this
-- file saying it was not. A learner could have called it with candidate states
-- and read the rules back one bit at a time. Found by the probe; the note at
-- the foot of the file was true about the GRANT and false about the effect.
REVOKE ALL ON FUNCTION app_experiment_activity(uuid)              FROM PUBLIC;
REVOKE ALL ON FUNCTION app_experiment_lesson(uuid)                FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_sees_experiment(uuid)            FROM PUBLIC;
REVOKE ALL ON FUNCTION app_experiment_organization(uuid)          FROM PUBLIC;
REVOKE ALL ON FUNCTION app_session_experiment(uuid)               FROM PUBLIC;
REVOKE ALL ON FUNCTION app_session_owner(uuid)                    FROM PUBLIC;
REVOKE ALL ON FUNCTION app_session_status(uuid)                   FROM PUBLIC;
REVOKE ALL ON FUNCTION app_session_lesson(uuid)                   FROM PUBLIC;
REVOKE ALL ON FUNCTION app_experiment_label(uuid)                 FROM PUBLIC;
REVOKE ALL ON FUNCTION app_experiment_path_is_safe(text)          FROM PUBLIC;
REVOKE ALL ON FUNCTION app_experiment_state_at(jsonb, text)       FROM PUBLIC;
REVOKE ALL ON FUNCTION app_experiment_rule_holds(jsonb, jsonb)    FROM PUBLIC;
REVOKE ALL ON FUNCTION app_experiment_rules_are_well_formed(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_experiment_state_satisfies(uuid, jsonb) FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON experiments                 TO edu_app;
GRANT SELECT, INSERT, UPDATE ON experiment_validation_rules TO edu_app;
GRANT SELECT, INSERT, UPDATE ON experiment_sessions         TO edu_app;
GRANT SELECT, INSERT         ON experiment_artifacts        TO edu_app;

GRANT EXECUTE ON FUNCTION app_experiment_activity(uuid)              TO edu_app;
GRANT EXECUTE ON FUNCTION app_experiment_lesson(uuid)                TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_sees_experiment(uuid)            TO edu_app;
GRANT EXECUTE ON FUNCTION app_experiment_organization(uuid)          TO edu_app;
GRANT EXECUTE ON FUNCTION app_session_experiment(uuid)               TO edu_app;
GRANT EXECUTE ON FUNCTION app_session_owner(uuid)                    TO edu_app;
GRANT EXECUTE ON FUNCTION app_session_status(uuid)                   TO edu_app;
GRANT EXECUTE ON FUNCTION app_session_lesson(uuid)                   TO edu_app;
GRANT EXECUTE ON FUNCTION app_experiment_label(uuid)                 TO edu_app;
GRANT EXECUTE ON FUNCTION app_experiment_path_is_safe(text)          TO edu_app;
GRANT EXECUTE ON FUNCTION app_experiment_state_at(jsonb, text)       TO edu_app;
GRANT EXECUTE ON FUNCTION app_experiment_rule_holds(jsonb, jsonb)    TO edu_app;

-- REVOKED AND NEVER GRANTED, both of them:
--
--   app_experiment_state_satisfies      the marker. It reads the answer key,
--                                       so a caller who could invoke it could
--                                       probe the rules a state at a time.
--                                       Only the submit trigger calls it.
--   app_experiment_rules_are_well_formed the publication gate, mirroring
--                                       `app_assessment_is_well_formed` in
--                                       0019, which is likewise revoked and
--                                       never granted. Only the publication
--                                       trigger calls it.
--
-- Both are SECURITY DEFINER and both run inside a trigger, which is why
-- withholding EXECUTE costs the application nothing.
