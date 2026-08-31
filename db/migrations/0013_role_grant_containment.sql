-- =====================================================================
-- 0013 — Database-level containment for role grants
-- =====================================================================
-- Task 001 had a hard guarantee: `edu_app` held no write privilege on
-- `user_roles`, and the single function that wrote to it hardcoded 'student'.
-- Application code could not grant a privileged role even if it wanted to.
--
-- Task 003 needed real role administration, so `auth_assign_role` takes the role
-- as a PARAMETER and `edu_app` may execute it. That is necessary — but it means
-- the only thing standing between a bug in application code and an `admin` grant
-- is the policy engine. One gate, where there used to be two.
--
-- Found during the Task 003 adversarial review. This migration puts the
-- containment rules back into the database, so they hold even if the application
-- check is bypassed, mis-ordered, or removed:
--
--   1. Nobody may grant or revoke a role for THEMSELVES.
--   2. `admin` and `security_admin` may only be granted by an actor who already
--      holds `security_admin`.
--   3. Those privileged roles may never be granted with global scope.
--
-- These duplicate `roleGrantPolicy` deliberately. The application policy remains
-- the authoritative, expressive gate — it also enforces organization scoping and
-- produces an auditable reason — and this is the floor beneath it.
--
-- NOTE: the rules key off `app_current_actor()`, so they apply to calls made
-- inside a request transaction. A migration or operator script running with no
-- actor set is not constrained here; that is a deliberate escape hatch for
-- bootstrapping the first administrator, and it is why the function still
-- records `granted_by`.
-- =====================================================================

CREATE OR REPLACE FUNCTION auth_assign_role(
  p_user_id    uuid,
  p_role_name  text,
  p_scope_type text,
  p_scope_id   uuid,
  p_granted_by uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  target_role  uuid;
  new_id       uuid;
  caller       uuid := app_current_actor();
  is_privileged boolean := p_role_name IN ('admin', 'security_admin');
BEGIN
  SELECT r.id INTO target_role FROM roles r WHERE r.name = p_role_name;
  IF target_role IS NULL THEN
    RAISE EXCEPTION 'Unknown role "%"', p_role_name USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF caller IS NOT NULL THEN
    -- Rule 1: no self-modification of privileges, for anyone.
    IF caller = p_user_id THEN
      RAISE EXCEPTION 'Refusing to grant a role to the acting user'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Rule 2: privileged roles are a security administrator's to give.
    IF is_privileged AND NOT EXISTS (
      SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = caller AND r.name = 'security_admin'
    ) THEN
      RAISE EXCEPTION 'Only a security administrator may grant "%"', p_role_name
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- Rule 3: a privileged role granted globally would reach every organization on
  -- the platform. Refused regardless of who is asking, including an operator
  -- script with no actor set.
  IF is_privileged AND p_scope_type = 'global' THEN
    RAISE EXCEPTION 'Privileged role "%" may not be granted globally', p_role_name
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO user_roles (user_id, role_id, scope_type, scope_id, granted_by)
  VALUES (p_user_id, target_role, p_scope_type, p_scope_id, p_granted_by)
  ON CONFLICT DO NOTHING
  RETURNING id INTO new_id;

  RETURN new_id;
END
$$;

CREATE OR REPLACE FUNCTION auth_revoke_role(
  p_user_id    uuid,
  p_role_name  text,
  p_scope_type text,
  p_scope_id   uuid
) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  affected integer;
  caller   uuid := app_current_actor();
BEGIN
  -- Rule 1 applies to revocation too: removing your own role is still changing
  -- your own privileges, and an operator who needs it can ask another operator.
  IF caller IS NOT NULL AND caller = p_user_id THEN
    RAISE EXCEPTION 'Refusing to revoke a role from the acting user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM user_roles ur
   USING roles r
   WHERE ur.role_id = r.id
     AND r.name = p_role_name
     AND ur.user_id = p_user_id
     AND ur.scope_type = p_scope_type
     AND ur.scope_id IS NOT DISTINCT FROM p_scope_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END
$$;

REVOKE ALL ON FUNCTION auth_assign_role(uuid, text, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_revoke_role(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_assign_role(uuid, text, text, uuid, uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION auth_revoke_role(uuid, text, text, uuid) TO edu_app;
