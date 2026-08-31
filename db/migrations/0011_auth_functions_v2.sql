-- =====================================================================
-- 0011 — The pre-authentication boundary, version 2
-- =====================================================================
-- Replaces the functions from 0006 to account for the reshaped RBAC tables,
-- profiles, refresh tokens, lockout and single-use tokens.
--
-- The properties from 0006 are preserved and extended:
--   * Each function does one thing and returns only what that operation needs.
--   * `search_path` is pinned on every one — without it, a caller able to create
--     objects earlier on the path could shadow `users` and capture credentials.
--   * EXECUTE is revoked from PUBLIC and granted only to `edu_app`.
--   * They run as `edu_migrator`, which is not a superuser.
--
-- New in this version: expiry, single-use and lockout are all enforced HERE, in
-- SQL, rather than in application code. An expired or already-used token simply
-- produces no row, so "did I remember to check?" stops being a question.
-- =====================================================================

DROP FUNCTION IF EXISTS auth_register_user(text, text, text, text);
DROP FUNCTION IF EXISTS auth_find_user_for_login(text);
DROP FUNCTION IF EXISTS auth_create_session(uuid, bytea, timestamptz, inet, text);
DROP FUNCTION IF EXISTS auth_resolve_session(bytea);

-- ---------------------------------------------------------------------
-- Registration: user + profile + the default role, atomically.
--
-- The 'student' role is a literal, NOT a parameter. This is what makes vertical
-- privilege escalation through registration structurally impossible: `edu_app`
-- holds no write privilege on `user_roles`, and the only function that writes to
-- it during registration cannot be asked for any other role.
-- ---------------------------------------------------------------------
CREATE FUNCTION auth_register_user(
  p_email         text,
  p_password_hash text,
  p_display_name  text,
  p_locale        text
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  new_id  uuid;
  role_id uuid;
BEGIN
  INSERT INTO users (email, password_hash, display_name, locale)
  VALUES (lower(btrim(p_email)), p_password_hash, p_display_name, p_locale)
  RETURNING id INTO new_id;

  INSERT INTO profiles (user_id, display_name, locale)
  VALUES (new_id, p_display_name, p_locale);

  SELECT r.id INTO role_id FROM roles r WHERE r.name = 'student';
  IF role_id IS NULL THEN
    RAISE EXCEPTION 'System role "student" is missing; refusing to register a user with no role.';
  END IF;

  INSERT INTO user_roles (user_id, role_id, scope_type, scope_id)
  VALUES (new_id, role_id, 'global', NULL);

  RETURN new_id;
END
$$;

-- ---------------------------------------------------------------------
-- Credential lookup.
--
-- Returns the row for a locked, suspended or unverified account too, so the
-- caller can still run the password verification and keep the timing of every
-- failure mode indistinguishable.
-- ---------------------------------------------------------------------
CREATE FUNCTION auth_find_user_for_login(p_email text)
  RETURNS TABLE (
    id                 uuid,
    email              text,
    password_hash      text,
    display_name       text,
    locale             text,
    status             text,
    organization_id    uuid,
    email_verified_at  timestamptz,
    failed_login_count integer,
    locked_until       timestamptz
  )
  LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.email, u.password_hash, u.display_name, u.locale, u.status,
         u.organization_id, u.email_verified_at, u.failed_login_count, u.locked_until
  FROM users u
  WHERE u.email = lower(btrim(p_email));
$$;

-- ---------------------------------------------------------------------
-- Account lockout.
--
-- The counter and the lock live in the database, not in memory, so they survive
-- a restart and are shared across every application instance — unlike the
-- in-process rate limiter, which is per-replica. Lockout is therefore the
-- durable control against distributed password guessing.
-- ---------------------------------------------------------------------
CREATE FUNCTION auth_record_login_failure(
  p_user_id         uuid,
  p_max_attempts    integer,
  p_lockout_minutes integer
) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  attempts integer;
BEGIN
  UPDATE users
     SET failed_login_count = failed_login_count + 1,
         locked_until = CASE
           WHEN failed_login_count + 1 >= p_max_attempts
             THEN now() + make_interval(mins => p_lockout_minutes)
           ELSE locked_until
         END,
         updated_at = now()
   WHERE id = p_user_id
  RETURNING failed_login_count INTO attempts;

  RETURN COALESCE(attempts, 0) >= p_max_attempts;
END
$$;

CREATE FUNCTION auth_record_login_success(p_user_id uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  UPDATE users
     SET failed_login_count = 0, locked_until = NULL, updated_at = now()
   WHERE id = p_user_id;
$$;

-- ---------------------------------------------------------------------
-- Session creation, now carrying a refresh token and device metadata.
-- ---------------------------------------------------------------------
CREATE FUNCTION auth_create_session(
  p_user_id            uuid,
  p_token_hash         bytea,
  p_refresh_token_hash bytea,
  p_expires_at         timestamptz,
  p_refresh_expires_at timestamptz,
  p_ip                 inet,
  p_user_agent         text,
  p_device_label       text,
  p_rotated_from       uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO sessions (
    user_id, token_hash, refresh_token_hash, expires_at, refresh_expires_at,
    ip, user_agent, device_label, rotated_from
  ) VALUES (
    p_user_id, p_token_hash, p_refresh_token_hash, p_expires_at, p_refresh_expires_at,
    p_ip, left(p_user_agent, 400), left(p_device_label, 100), p_rotated_from
  ) RETURNING id INTO new_id;
  RETURN new_id;
END
$$;

-- ---------------------------------------------------------------------
-- Session resolution — the hot path on every authenticated request.
--
-- Returns the actor's role GRANTS with their scopes, and the flattened set of
-- permission names. The application never derives either from client input.
-- ---------------------------------------------------------------------
CREATE FUNCTION auth_resolve_session(p_token_hash bytea)
  RETURNS TABLE (
    session_id        uuid,
    user_id           uuid,
    email             text,
    display_name      text,
    locale            text,
    status            text,
    organization_id   uuid,
    email_verified    boolean,
    grants            jsonb,
    permissions       text[],
    expires_at        timestamptz
  )
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Throttled to once a minute so a busy session does not write per request.
  UPDATE sessions s
     SET last_used_at = now()
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND s.last_used_at < now() - interval '1 minute';

  RETURN QUERY
  SELECT
    s.id,
    u.id,
    u.email,
    u.display_name,
    u.locale,
    u.status,
    u.organization_id,
    (u.email_verified_at IS NOT NULL),
    COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
                'role', r.name, 'scopeType', ur.scope_type, 'scopeId', ur.scope_id)
              ORDER BY r.name, ur.scope_type)
         FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = u.id),
      '[]'::jsonb
    ),
    COALESCE(
      (SELECT array_agg(DISTINCT p.name ORDER BY p.name)
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = u.id),
      ARRAY[]::text[]
    ),
    s.expires_at
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > now();
END
$$;

-- ---------------------------------------------------------------------
-- Refresh rotation, with reuse detection.
--
-- A refresh token is single use. Presenting one that has ALREADY been rotated is
-- the signature of a stolen token being replayed: the legitimate client rotated
-- it, so whoever is presenting it again is not the legitimate client (or the
-- legitimate client's copy was captured). Either way the safe response is to
-- revoke the entire family, forcing a fresh login.
--
-- Outcomes: 'rotated' | 'reuse_detected' | 'invalid'.
-- ---------------------------------------------------------------------
CREATE FUNCTION auth_rotate_refresh(
  p_old_refresh_hash   bytea,
  p_new_token_hash     bytea,
  p_new_refresh_hash   bytea,
  p_expires_at         timestamptz,
  p_refresh_expires_at timestamptz,
  p_ip                 inet,
  p_user_agent         text,
  p_device_label       text
) RETURNS TABLE (outcome text, session_id uuid, user_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  existing sessions%ROWTYPE;
  new_id   uuid;
BEGIN
  SELECT * INTO existing FROM sessions s
   WHERE s.refresh_token_hash = p_old_refresh_hash
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  -- Already rotated, or revoked for any reason: treat as replay.
  --
  -- NOTE the table alias. `RETURNS TABLE (... user_id uuid ...)` declares an OUT
  -- parameter of that name, so an unqualified `user_id` here is ambiguous and
  -- PostgreSQL refuses the statement at runtime — turning the reuse-detection
  -- path into a 500 instead of a revocation. Every column below is qualified for
  -- that reason. See VULN-008.
  IF existing.refresh_rotated_at IS NOT NULL OR existing.revoked_at IS NOT NULL THEN
    UPDATE sessions s
       SET revoked_at = COALESCE(s.revoked_at, now()),
           revoked_reason = 'refresh_reuse_detected'
     WHERE s.user_id = existing.user_id
       AND s.revoked_at IS NULL;
    RETURN QUERY SELECT 'reuse_detected'::text, NULL::uuid, existing.user_id;
    RETURN;
  END IF;

  IF existing.refresh_expires_at IS NULL OR existing.refresh_expires_at <= now() THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  -- Retire the old session and issue its successor, chained for auditability.
  UPDATE sessions s
     SET refresh_rotated_at = now(), revoked_at = now(), revoked_reason = 'rotated'
   WHERE s.id = existing.id;

  INSERT INTO sessions (
    user_id, token_hash, refresh_token_hash, expires_at, refresh_expires_at,
    ip, user_agent, device_label, rotated_from
  ) VALUES (
    existing.user_id, p_new_token_hash, p_new_refresh_hash, p_expires_at, p_refresh_expires_at,
    p_ip, left(p_user_agent, 400), left(p_device_label, 100), existing.id
  ) RETURNING id INTO new_id;

  RETURN QUERY SELECT 'rotated'::text, new_id, existing.user_id;
END
$$;

-- ---------------------------------------------------------------------
-- Revocation.
-- ---------------------------------------------------------------------
CREATE FUNCTION auth_revoke_all_sessions(p_user_id uuid, p_reason text) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE sessions s
     SET revoked_at = now(), revoked_reason = p_reason
   WHERE s.user_id = p_user_id AND s.revoked_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END
$$;

-- ---------------------------------------------------------------------
-- Email verification. Single use, and bound to the address it was issued for,
-- so a token cannot confirm an address the user changed to afterwards.
-- ---------------------------------------------------------------------
CREATE FUNCTION auth_create_email_verification(
  p_user_id    uuid,
  p_token_hash bytea,
  p_email      text,
  p_expires_at timestamptz
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO email_verifications (user_id, token_hash, email, expires_at)
  VALUES (p_user_id, p_token_hash, lower(btrim(p_email)), p_expires_at)
  RETURNING id INTO new_id;
  RETURN new_id;
END
$$;

CREATE FUNCTION auth_verify_email(p_token_hash bytea) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  target_user uuid;
  target_email text;
BEGIN
  UPDATE email_verifications ev
     SET verified_at = now()
   WHERE ev.token_hash = p_token_hash
     AND ev.verified_at IS NULL
     AND ev.expires_at > now()
  RETURNING ev.user_id, ev.email INTO target_user, target_email;

  IF target_user IS NULL THEN
    RETURN NULL;
  END IF;

  -- Only marks the account verified when the address still matches the one the
  -- token was issued for.
  UPDATE users
     SET email_verified_at = now(),
         status = CASE WHEN status = 'pending_verification' THEN 'active' ELSE status END,
         updated_at = now()
   WHERE id = target_user AND email = target_email;

  RETURN target_user;
END
$$;

-- ---------------------------------------------------------------------
-- Password reset. Consuming a token also changes the password AND revokes every
-- session, in one transaction — a reset is normally an account-recovery event,
-- so leaving an attacker's session alive would defeat the point.
-- ---------------------------------------------------------------------
CREATE FUNCTION auth_create_password_reset(
  p_user_id    uuid,
  p_token_hash bytea,
  p_expires_at timestamptz,
  p_ip         inet
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  new_id uuid;
BEGIN
  -- Invalidate any outstanding reset for this user: only the newest may be used.
  UPDATE password_reset_tokens
     SET used_at = now()
   WHERE user_id = p_user_id AND used_at IS NULL;

  INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip)
  VALUES (p_user_id, p_token_hash, p_expires_at, p_ip)
  RETURNING id INTO new_id;
  RETURN new_id;
END
$$;

CREATE FUNCTION auth_consume_password_reset(
  p_token_hash        bytea,
  p_new_password_hash text
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  target_user uuid;
BEGIN
  UPDATE password_reset_tokens
     SET used_at = now()
   WHERE token_hash = p_token_hash
     AND used_at IS NULL
     AND expires_at > now()
  RETURNING user_id INTO target_user;

  IF target_user IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE users
     SET password_hash = p_new_password_hash,
         password_changed_at = now(),
         failed_login_count = 0,
         locked_until = NULL,
         updated_at = now()
   WHERE id = target_user;

  UPDATE sessions
     SET revoked_at = now(), revoked_reason = 'password_changed'
   WHERE user_id = target_user AND revoked_at IS NULL;

  RETURN target_user;
END
$$;

-- ---------------------------------------------------------------------
-- Role administration.
--
-- `edu_app` cannot write `user_roles` directly, so every grant and revoke flows
-- through here. The function does NOT decide whether the caller is allowed to
-- do this — that is the policy engine's job, in the application, before it calls.
-- This is the mechanism, not the authorization.
-- ---------------------------------------------------------------------
CREATE FUNCTION auth_assign_role(
  p_user_id    uuid,
  p_role_name  text,
  p_scope_type text,
  p_scope_id   uuid,
  p_granted_by uuid
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  target_role uuid;
  new_id      uuid;
BEGIN
  SELECT r.id INTO target_role FROM roles r WHERE r.name = p_role_name;
  IF target_role IS NULL THEN
    RAISE EXCEPTION 'Unknown role "%"', p_role_name USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO user_roles (user_id, role_id, scope_type, scope_id, granted_by)
  VALUES (p_user_id, target_role, p_scope_type, p_scope_id, p_granted_by)
  ON CONFLICT DO NOTHING
  RETURNING id INTO new_id;

  RETURN new_id;
END
$$;

CREATE FUNCTION auth_revoke_role(
  p_user_id    uuid,
  p_role_name  text,
  p_scope_type text,
  p_scope_id   uuid
) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  affected integer;
BEGIN
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

-- Reads another user's grants. Needed because `user_roles`' own RLS policy is
-- deliberately "own grants only" to avoid policy recursion (see 0010).
CREATE FUNCTION auth_user_grants(p_user_id uuid)
  RETURNS TABLE (role_name text, scope_type text, scope_id uuid, granted_at timestamptz)
  LANGUAGE sql SECURITY DEFINER STABLE SET search_path = pg_catalog, public
AS $$
  SELECT r.name, ur.scope_type, ur.scope_id, ur.granted_at
  FROM user_roles ur JOIN roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_user_id
  ORDER BY r.name, ur.scope_type;
$$;

-- ---------------------------------------------------------------------
-- Lock down execution on everything above.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'auth\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO edu_app', fn.sig);
  END LOOP;
END
$$;
