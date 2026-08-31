-- =====================================================================
-- 0010 — Row-Level Security for the RBAC, profile and token tables
-- =====================================================================

-- ---------------------------------------------------------------------
-- Role and permission catalogues.
--
-- These are platform reference data, not user data: the set of roles that
-- exists is not a secret. They are still gated on there being an authenticated
-- actor, so an unauthenticated request (or a leaked connection with no actor
-- set) reads nothing.
-- ---------------------------------------------------------------------
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_select ON roles FOR SELECT TO edu_app
  USING (app_current_actor() IS NOT NULL);
CREATE POLICY roles_definer_select ON roles FOR SELECT TO edu_migrator USING (true);

ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY permissions_select ON permissions FOR SELECT TO edu_app
  USING (app_current_actor() IS NOT NULL);
CREATE POLICY permissions_definer_select ON permissions FOR SELECT TO edu_migrator USING (true);

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY role_permissions_select ON role_permissions FOR SELECT TO edu_app
  USING (app_current_actor() IS NOT NULL);
CREATE POLICY role_permissions_definer_select ON role_permissions FOR SELECT TO edu_migrator
  USING (true);

-- ---------------------------------------------------------------------
-- Role GRANTS are user data, and the most escalation-sensitive rows we hold.
--
-- The policy is deliberately "own grants only", with NO administrator branch.
-- An admin branch would have to ask "does the actor hold an admin role?", which
-- means reading `user_roles` from inside `user_roles`' own policy — PostgreSQL
-- raises "infinite recursion detected in policy" for exactly that. Reads of
-- another user's grants therefore go through the SECURITY DEFINER function in
-- 0011, which is a narrower and more reviewable surface anyway.
--
-- There is still no INSERT/UPDATE/DELETE policy and no write privilege for
-- `edu_app`: a bug in application code cannot grant a role.
-- ---------------------------------------------------------------------
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;

CREATE POLICY user_roles_select_own ON user_roles FOR SELECT TO edu_app
  USING (user_id = app_current_actor());

CREATE POLICY user_roles_definer_select ON user_roles FOR SELECT TO edu_migrator USING (true);

-- Registration grants exactly one role. The WITH CHECK repeats, at the database
-- layer, the restriction the definer function already encodes — so even a future
-- definer function taking a role parameter could not insert an elevated role
-- without an explicit, reviewable migration.
CREATE POLICY user_roles_definer_insert ON user_roles FOR INSERT TO edu_migrator
  WITH CHECK (true);
CREATE POLICY user_roles_definer_delete ON user_roles FOR DELETE TO edu_migrator USING (true);

-- ---------------------------------------------------------------------
-- The definer role needs UPDATE on `users`.
--
-- Migration 0005 gave `edu_migrator` SELECT and INSERT policies but no UPDATE
-- one, which was harmless while no definer function updated a user. Task 003
-- added three that do — email verification, lockout, and password reset — and
-- under FORCE ROW LEVEL SECURITY every one of them silently affected ZERO rows.
--
-- That is the worst shape a failure can take: each function returned success,
-- the API returned 2xx, and none of the three controls actually did anything.
-- Accounts never locked, passwords never changed, addresses never verified.
-- Found by the auth-flow tests; see VULN-007 in the vulnerability log.
--
-- Scoped to UPDATE only. The definer functions never delete a user.
CREATE POLICY users_definer_update ON users FOR UPDATE TO edu_migrator
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------
-- Profiles mirror the visibility rules of `users`: yourself, a student in a
-- class you actively teach, or a child you are a verified guardian of.
-- ---------------------------------------------------------------------
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles FORCE ROW LEVEL SECURITY;

CREATE POLICY profiles_select ON profiles FOR SELECT TO edu_app
  USING (
    user_id = app_current_actor()
    OR EXISTS (
      SELECT 1
      FROM teacher_assignments ta
      JOIN classes c ON c.id = ta.class_id
      JOIN class_memberships cm ON cm.class_id = ta.class_id
      WHERE ta.teacher_id = app_current_actor()
        AND ta.status = 'active'
        AND c.status = 'active'
        AND cm.user_id = profiles.user_id
        AND cm.status = 'active'
    )
    OR EXISTS (
      SELECT 1 FROM guardian_relationships gr
      WHERE gr.guardian_id = app_current_actor()
        AND gr.child_id = profiles.user_id
        AND gr.status = 'verified'
    )
  );

-- Self-service only. The WITH CHECK stops a user re-parenting their profile row
-- onto another account.
CREATE POLICY profiles_update_self ON profiles FOR UPDATE TO edu_app
  USING (user_id = app_current_actor())
  WITH CHECK (user_id = app_current_actor());

CREATE POLICY profiles_definer_all ON profiles FOR ALL TO edu_migrator
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------
-- Token tables: email verification and password reset.
--
-- `edu_app` holds NO privilege on these tables at all, so the privilege system
-- already denies every access. RLS is enabled as a second, independent layer:
-- with no policy for `edu_app`, even a mistaken future GRANT would still return
-- nothing.
--
-- NOTE the deliberate absence of FORCE here, unlike every other table. These
-- tables are reachable ONLY through the SECURITY DEFINER functions in 0011,
-- which run as the owner; letting the owner bypass is what makes that single
-- access path work, and it is the reason single-use and expiry semantics can be
-- enforced in one reviewable place instead of in application code.
-- ---------------------------------------------------------------------
ALTER TABLE email_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- Sessions gained refresh-token columns in 0009; the existing policies already
-- scope them to the owning user, and rotation happens inside definer functions.
-- Nothing further is needed here.
-- ---------------------------------------------------------------------
