-- =====================================================================
-- 0006 — The pre-authentication boundary
-- =====================================================================
-- Registration, login and session resolution all need to touch rows BEFORE
-- there is an authenticated actor — so RLS, which keys off `app.actor_id`,
-- cannot help there. Rather than punching a hole in the policies (a permanent
-- weakening), those three operations are the ONLY things allowed through, via
-- narrow SECURITY DEFINER functions.
--
-- Properties that make this safe to reason about:
--   * Each function does exactly one thing and returns exactly the columns that
--     operation needs. `auth_find_user_for_login` returns the password hash;
--     nothing else in the codebase can read that column at all.
--   * `search_path` is pinned on every one of them. Without that pin, a caller
--     who can create objects in a schema earlier on the search path could
--     shadow `users` and capture credentials. `edu_app` has had CREATE on
--     public revoked (0001) as a second layer against exactly that.
--   * EXECUTE is revoked from PUBLIC and granted only to `edu_app`.
--   * They run as the owner (`edu_migrator`), which is not a superuser.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Registration.
--
-- The 'student' role is a literal, NOT a parameter. This is the control that
-- makes vertical privilege escalation through the registration endpoint
-- structurally impossible: `edu_app` holds no INSERT privilege on `user_roles`
-- (0001), and the only function that writes to it cannot be asked for any role
-- other than 'student'. Granting elevated roles is a future, separately audited
-- operator path that does not exist yet.
-- ---------------------------------------------------------------------
CREATE FUNCTION auth_register_user(
  p_email         text,
  p_password_hash text,
  p_display_name  text,
  p_locale        text
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO users (email, password_hash, display_name, locale)
  VALUES (lower(btrim(p_email)), p_password_hash, p_display_name, p_locale)
  RETURNING id INTO new_id;

  INSERT INTO user_roles (user_id, role) VALUES (new_id, 'student');

  RETURN new_id;
END
$$;

-- ---------------------------------------------------------------------
-- Credential lookup. Returns at most one row.
--
-- Deliberately returns the row for a SUSPENDED user too, so the caller can
-- still perform the password verification and keep the timing of a
-- suspended-account login indistinguishable from an active one.
-- ---------------------------------------------------------------------
CREATE FUNCTION auth_find_user_for_login(p_email text)
  RETURNS TABLE (
    id              uuid,
    email           text,
    password_hash   text,
    display_name    text,
    locale          text,
    status          text,
    organization_id uuid
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.email, u.password_hash, u.display_name, u.locale, u.status, u.organization_id
  FROM users u
  WHERE u.email = lower(btrim(p_email));
$$;

-- ---------------------------------------------------------------------
-- Session creation. Takes the SHA-256 of the token, never the token.
-- ---------------------------------------------------------------------
CREATE FUNCTION auth_create_session(
  p_user_id    uuid,
  p_token_hash bytea,
  p_expires_at timestamptz,
  p_ip         inet,
  p_user_agent text
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent)
  VALUES (p_user_id, p_token_hash, p_expires_at, p_ip, left(p_user_agent, 400))
  RETURNING id INTO new_id;
  RETURN new_id;
END
$$;

-- ---------------------------------------------------------------------
-- Session resolution — the hot path on every authenticated request.
--
-- Expiry and revocation are evaluated HERE, in SQL, rather than in application
-- code. A caller cannot accidentally accept an expired session, because an
-- expired session simply produces no row.
--
-- It also refreshes `last_used_at`, throttled to once a minute so that a busy
-- session does not generate a write per request.
-- ---------------------------------------------------------------------
CREATE FUNCTION auth_resolve_session(p_token_hash bytea)
  RETURNS TABLE (
    session_id      uuid,
    user_id         uuid,
    email           text,
    display_name    text,
    locale          text,
    status          text,
    organization_id uuid,
    roles           text[],
    expires_at      timestamptz
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
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
    COALESCE(
      (SELECT array_agg(r.role ORDER BY r.role) FROM user_roles r WHERE r.user_id = u.id),
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
-- Revocation by token (logout). Scoped to the single matching session.
-- ---------------------------------------------------------------------
CREATE FUNCTION auth_revoke_session(p_token_hash bytea) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE sessions
     SET revoked_at = now()
   WHERE token_hash = p_token_hash
     AND revoked_at IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END
$$;

-- ---------------------------------------------------------------------
-- Lock down execution on all of the above.
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION auth_register_user(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_find_user_for_login(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_create_session(uuid, bytea, timestamptz, inet, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_resolve_session(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_revoke_session(bytea) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth_register_user(text, text, text, text) TO edu_app;
GRANT EXECUTE ON FUNCTION auth_find_user_for_login(text) TO edu_app;
GRANT EXECUTE ON FUNCTION auth_create_session(uuid, bytea, timestamptz, inet, text) TO edu_app;
GRANT EXECUTE ON FUNCTION auth_resolve_session(bytea) TO edu_app;
GRANT EXECUTE ON FUNCTION auth_revoke_session(bytea) TO edu_app;
