-- =====================================================================
-- 0012 — Administrator visibility at the database layer
-- =====================================================================
-- The admin API added in Task 003 asks the policy engine "may this admin read
-- this user?", and the engine says yes for a user in the admin's own
-- organization. But `users_select` (0008) had no administrator branch, so RLS
-- returned no row and the request 404'd before the policy mattered.
--
-- That is the two-gate design behaving correctly — the stricter gate won, and it
-- failed CLOSED — but the two gates must agree on what is intended, or the
-- application policy becomes decorative. This migration teaches RLS the same
-- rule the engine already enforces.
--
-- THE RECURSION PROBLEM, AND WHY THESE HELPERS EXIST
--
-- The natural way to write the admin branch is:
--
--     users.organization_id = (SELECT organization_id FROM users WHERE id = actor)
--
-- but a policy on `users` that reads `users` is infinite recursion, and
-- PostgreSQL refuses it. The same applies to asking "does the actor hold an
-- admin role?" from inside a policy that `user_roles` participates in.
--
-- Both questions are therefore answered by SECURITY DEFINER helpers, which run
-- as the owner and so are not subject to `edu_app`'s policies. They are narrow,
-- read-only, and take no arguments — they can only ever describe the CURRENT
-- actor, so they cannot be used to ask about somebody else.
-- =====================================================================

/**
 * The current actor's organization, or NULL.
 */
CREATE FUNCTION app_actor_organization() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT u.organization_id FROM users u WHERE u.id = app_current_actor();
$$;

/**
 * Whether the current actor holds an organization-administration role.
 *
 * Deliberately limited to the two roles that administer accounts. It answers
 * only about the caller, so it cannot become a way to probe other users' roles.
 */
CREATE FUNCTION app_actor_is_org_admin() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = app_current_actor()
      AND r.name IN ('admin', 'security_admin')
  );
$$;

REVOKE ALL ON FUNCTION app_actor_organization() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_is_org_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_actor_organization() TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_is_org_admin() TO edu_app;

-- ---------------------------------------------------------------------
-- Recreate `users_select` with the administrator branch.
--
-- Note what the branch is NOT: it is not "admins see everything". It is scoped
-- to the admin's own organization, and an actor with no organization matches
-- nothing, so a stray admin grant cannot become platform-wide visibility.
-- ---------------------------------------------------------------------
DROP POLICY users_select ON users;

CREATE POLICY users_select ON users FOR SELECT TO edu_app
  USING (
    id = app_current_actor()
    OR (
      app_actor_is_org_admin()
      AND users.organization_id IS NOT NULL
      AND users.organization_id = app_actor_organization()
    )
    OR EXISTS (
      SELECT 1
      FROM teacher_assignments ta
      JOIN classes c ON c.id = ta.class_id
      JOIN class_memberships cm ON cm.class_id = ta.class_id
      WHERE ta.teacher_id = app_current_actor()
        AND ta.status = 'active'
        AND c.status = 'active'
        AND cm.user_id = users.id
        AND cm.status = 'active'
    )
    OR EXISTS (
      SELECT 1 FROM guardian_relationships gr
      WHERE gr.guardian_id = app_current_actor()
        AND gr.child_id = users.id
        AND gr.status = 'verified'
    )
  );

-- ---------------------------------------------------------------------
-- The same branch for profiles, so the two stay consistent.
-- ---------------------------------------------------------------------
DROP POLICY profiles_select ON profiles;

CREATE POLICY profiles_select ON profiles FOR SELECT TO edu_app
  USING (
    user_id = app_current_actor()
    OR (
      app_actor_is_org_admin()
      AND EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = profiles.user_id
          AND u.organization_id IS NOT NULL
          AND u.organization_id = app_actor_organization()
      )
    )
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

-- ---------------------------------------------------------------------
-- Administrators change account status, so `edu_app` needs an UPDATE path for
-- it. Narrowly scoped: same organization only, and the WITH CHECK stops a row
-- being moved into another organization on the way through.
--
-- Note this does NOT let an admin edit anything else about a user: column-level
-- restraint comes from the application, which only ever writes `status` here.
-- ---------------------------------------------------------------------
CREATE POLICY users_update_org_admin ON users FOR UPDATE TO edu_app
  USING (
    app_actor_is_org_admin()
    AND users.organization_id IS NOT NULL
    AND users.organization_id = app_actor_organization()
  )
  WITH CHECK (
    app_actor_is_org_admin()
    AND users.organization_id IS NOT NULL
    AND users.organization_id = app_actor_organization()
  );
