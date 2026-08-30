-- =====================================================================
-- 0005 — Row-Level Security
-- =====================================================================
-- RLS here is DEFENCE IN DEPTH, not the primary authorization mechanism. The
-- authoritative decision is made by the policy engine in `@edu/authz`, which
-- can express rules SQL cannot (and which produces an auditable reason string).
--
-- What RLS buys us is a second, independent gate that a future application bug
-- cannot talk its way past: if a handler forgets a `WHERE owner_id = $actor`,
-- the database returns zero rows instead of somebody else's notebook.
--
-- Both layers are required. Neither is trusted alone. See
-- docs/security/authorization.md ("Two independent gates").
--
-- IMPORTANT: FORCE ROW LEVEL SECURITY is set on every table so the policies
-- apply to the table OWNER as well. Without FORCE, `edu_migrator` — and any
-- future job running as it — would silently bypass every policy below.
-- Superusers still bypass RLS entirely; that is a PostgreSQL property we cannot
-- switch off, and it is why the application never connects as one.
-- =====================================================================

-- Resolves the actor for the current transaction.
--
-- The application sets this with `set_config('app.actor_id', $1, true)` — the
-- `true` makes it transaction-LOCAL, so a pooled connection handed to the next
-- request cannot inherit the previous request's identity. That is the single
-- most important detail in this file.
--
-- Returns NULL when unset or malformed. Every policy below compares against
-- this value, and `x = NULL` is NULL (not true), so an unset actor fails closed.
CREATE FUNCTION app_current_actor() RETURNS uuid
  LANGUAGE plpgsql
  STABLE
  SET search_path = pg_catalog, public
AS $$
DECLARE
  raw text;
BEGIN
  raw := current_setting('app.actor_id', true);
  IF raw IS NULL OR raw = '' THEN
    RETURN NULL;
  END IF;
  RETURN raw::uuid;
EXCEPTION
  WHEN others THEN
    -- A malformed setting must not raise (that would turn a bug into an
    -- outage); it must deny.
    RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app_current_actor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_current_actor() TO edu_app;

-- ---------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

CREATE POLICY organizations_select ON organizations FOR SELECT TO edu_app
  USING (id = (SELECT u.organization_id FROM users u WHERE u.id = app_current_actor()));

-- ---------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY users_select ON users FOR SELECT TO edu_app
  USING (
    id = app_current_actor()
    OR EXISTS (
      SELECT 1 FROM teacher_assignments ta
      WHERE ta.teacher_id = app_current_actor()
        AND ta.student_id = users.id
        AND ta.status = 'active'
    )
    OR EXISTS (
      SELECT 1 FROM guardian_links gl
      WHERE gl.guardian_id = app_current_actor()
        AND gl.student_id = users.id
        AND gl.status = 'verified'
    )
  );

-- Self-service profile edits only. Note the WITH CHECK: it stops a user from
-- updating their own row into somebody else's id.
CREATE POLICY users_update_self ON users FOR UPDATE TO edu_app
  USING (id = app_current_actor())
  WITH CHECK (id = app_current_actor());

-- ---------------------------------------------------------------------
-- user_roles — readable only for oneself. `edu_app` holds no write privilege
-- on this table at all, so no write policy is needed (or wanted).
-- ---------------------------------------------------------------------
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;

CREATE POLICY user_roles_select_self ON user_roles FOR SELECT TO edu_app
  USING (user_id = app_current_actor());

-- ---------------------------------------------------------------------
-- sessions — a user may enumerate and revoke their own sessions, nobody else's.
-- ---------------------------------------------------------------------
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY sessions_select_own ON sessions FOR SELECT TO edu_app
  USING (user_id = app_current_actor());

CREATE POLICY sessions_update_own ON sessions FOR UPDATE TO edu_app
  USING (user_id = app_current_actor())
  WITH CHECK (user_id = app_current_actor());

CREATE POLICY sessions_delete_own ON sessions FOR DELETE TO edu_app
  USING (user_id = app_current_actor());

-- ---------------------------------------------------------------------
-- relationship tables — visible to either participant.
--
-- These policies must permit the actor to see the edges naming them, because
-- the `notes` and `users` policies above evaluate EXISTS subqueries against
-- these tables, and those subqueries are themselves subject to RLS.
-- ---------------------------------------------------------------------
ALTER TABLE guardian_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardian_links FORCE ROW LEVEL SECURITY;

CREATE POLICY guardian_links_select_participant ON guardian_links FOR SELECT TO edu_app
  USING (guardian_id = app_current_actor() OR student_id = app_current_actor());

ALTER TABLE teacher_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY teacher_assignments_select_participant ON teacher_assignments FOR SELECT TO edu_app
  USING (teacher_id = app_current_actor() OR student_id = app_current_actor());

-- ---------------------------------------------------------------------
-- notes — the protected resource this foundation is built around.
--
-- These policies mirror `notePolicy` in @edu/authz. They are deliberately
-- written to be slightly BROADER-OR-EQUAL than the application policy is
-- allowed to be: RLS is the floor, the policy engine is the ceiling. Where they
-- disagree, the stricter one wins, because a row must pass both.
--
-- tests/security/rls.test.ts asserts the two agree on the cases that matter.
-- ---------------------------------------------------------------------
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;

-- IMPORTANT PostgreSQL SEMANTIC — verified empirically, see
-- docs/architecture/adr/0007-soft-delete-and-rls.md.
--
-- On an UPDATE, PostgreSQL applies the SELECT policy to the NEW row in addition
-- to the UPDATE policy's WITH CHECK. A row therefore cannot be updated OUT of
-- the actor's own visibility. Putting `state <> 'deleted'` at the top of this
-- policy makes soft-delete impossible: the owner's own
-- `UPDATE ... SET state = 'deleted'` fails with "new row violates row-level
-- security policy for table notes".
--
-- So the owner branch below deliberately does NOT filter on state. The owner
-- can see their own rows at the database layer, soft-deleted ones included;
-- hiding a deleted note from its owner happens one layer up, in `notePolicy`
-- (which denies state='deleted' for everyone, unit-tested) and in `listOwn`
-- (which filters it out).
--
-- The security-relevant behaviour is unchanged: the SHARED branches still
-- filter on state, so a soft-deleted note is invisible to teachers and
-- guardians at the database layer no matter what the application does.
CREATE POLICY notes_select ON notes FOR SELECT TO edu_app
  USING (
    owner_id = app_current_actor()
    OR (
      state <> 'deleted'
      AND (
        (
          visibility = 'shared_with_teacher'
          AND EXISTS (
            SELECT 1 FROM teacher_assignments ta
            WHERE ta.teacher_id = app_current_actor()
              AND ta.student_id = notes.owner_id
              AND ta.status = 'active'
              AND ta.organization_id = notes.organization_id
          )
        )
        OR (
          visibility = 'shared_with_guardian'
          AND EXISTS (
            SELECT 1 FROM guardian_links gl
            WHERE gl.guardian_id = app_current_actor()
              AND gl.student_id = notes.owner_id
              AND gl.status = 'verified'
          )
        )
      )
    )
  );

-- Writes are owner-only, without exception. No role, relationship, or share
-- grants write access to another student's notebook.
CREATE POLICY notes_insert_own ON notes FOR INSERT TO edu_app
  WITH CHECK (owner_id = app_current_actor());

CREATE POLICY notes_update_own ON notes FOR UPDATE TO edu_app
  USING (owner_id = app_current_actor() AND state <> 'deleted')
  -- The WITH CHECK stops an owner from re-parenting their note to another user.
  WITH CHECK (owner_id = app_current_actor());

CREATE POLICY notes_delete_own ON notes FOR DELETE TO edu_app
  USING (owner_id = app_current_actor());

-- ---------------------------------------------------------------------
-- audit_log — insert-only. There is intentionally NO select policy, so even if
-- SELECT were granted by mistake, RLS would still return nothing.
-- ---------------------------------------------------------------------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_log_insert ON audit_log FOR INSERT TO edu_app
  WITH CHECK (true);

-- =====================================================================
-- Policies for the SECURITY DEFINER owner (`edu_migrator`)
-- =====================================================================
-- FORCE ROW LEVEL SECURITY applies to the table OWNER as well — which is the
-- property we want, but it also means the SECURITY DEFINER functions in 0006
-- (which execute as the owner) are subject to policies too. Without the
-- policies below, registration and login fail closed. That is the correct
-- default; these grants open exactly the pre-authentication paths and nothing
-- more.
--
-- Scope note: `edu_migrator` is used only to run migrations and as the definer
-- of the five audited functions in 0006. The application never connects as it.
-- =====================================================================

-- Registration inserts the user row; login and session resolution read it.
CREATE POLICY users_definer_insert ON users FOR INSERT TO edu_migrator WITH CHECK (true);
CREATE POLICY users_definer_select ON users FOR SELECT TO edu_migrator USING (true);

-- Session resolution reads roles; registration inserts the default role.
--
-- The WITH CHECK repeats, at the database layer, the restriction that
-- `auth_register_user` already encodes in its function body. Belt and braces:
-- even a future definer function with a role parameter could not insert
-- anything but 'student' without an explicit, reviewable migration that adds a
-- policy for it. This is the last line of defence against vertical privilege
-- escalation through the registration path.
CREATE POLICY user_roles_definer_select ON user_roles FOR SELECT TO edu_migrator USING (true);
CREATE POLICY user_roles_definer_insert ON user_roles FOR INSERT TO edu_migrator
  WITH CHECK (role = 'student');

-- Session create / resolve / revoke.
CREATE POLICY sessions_definer_select ON sessions FOR SELECT TO edu_migrator USING (true);
CREATE POLICY sessions_definer_insert ON sessions FOR INSERT TO edu_migrator WITH CHECK (true);
CREATE POLICY sessions_definer_update ON sessions FOR UPDATE TO edu_migrator
  USING (true) WITH CHECK (true);
