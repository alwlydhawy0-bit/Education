-- =====================================================================
-- 0001 — Roles, organizations, users, sessions
-- =====================================================================
-- PRIVILEGE MODEL
--
-- Migrations run as a privileged migration role (the table owner). The
-- application connects as `edu_app`, which is deliberately NOT the owner and is
-- created NOBYPASSRLS. Combined with FORCE ROW LEVEL SECURITY in 0005, that
-- means row-level policies apply to the application's every query — including
-- queries written by future code that forgets to filter.
--
-- `edu_app` is granted the narrowest set of table privileges the request path
-- actually needs. Notably it gets NO write privilege on `user_roles`, so a bug
-- in application code cannot grant anybody a role. Role assignment happens only
-- inside the SECURITY DEFINER functions in 0006.
-- =====================================================================

-- Roles are created by db/bootstrap.sql, which a DBA runs once as superuser.
-- Migrations themselves run as `edu_migrator`, a NON-superuser that owns every
-- object. That matters for 0006: SECURITY DEFINER functions execute with the
-- owner's rights, and we want those rights to be "the migrator", never "the
-- superuser". Fail loudly rather than silently producing an unprotected schema.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edu_app') THEN
    RAISE EXCEPTION 'Role edu_app is missing. Run db/bootstrap.sql as a superuser first.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) THEN
    RAISE WARNING 'Migrations are running as a SUPERUSER (%). SECURITY DEFINER functions will inherit superuser rights. Use edu_migrator outside of throwaway environments.', current_user;
  END IF;
END
$$;

-- The application role may use the schema but may not create objects in it.
GRANT USAGE ON SCHEMA public TO edu_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM edu_app;

-- ---------------------------------------------------------------------
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_name_len_ck CHECK (length(btrim(name)) BETWEEN 1 AND 200)
);

-- ---------------------------------------------------------------------
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  password_hash   text NOT NULL,
  display_name    text NOT NULL,
  locale          text NOT NULL DEFAULT 'ar',
  status          text NOT NULL DEFAULT 'active',
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Emails are stored normalized. Enforcing it here rather than trusting the
  -- application means a second code path cannot introduce a duplicate account
  -- differing only by case — an account-takeover vector on any future
  -- "look up user by email" flow.
  CONSTRAINT users_email_normalized_ck CHECK (email = lower(email)),
  CONSTRAINT users_email_len_ck        CHECK (length(email) BETWEEN 3 AND 254),
  CONSTRAINT users_display_name_len_ck CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  CONSTRAINT users_locale_ck           CHECK (locale IN ('ar', 'en')),
  CONSTRAINT users_status_ck           CHECK (status IN ('active', 'suspended', 'pending_verification'))
);

CREATE UNIQUE INDEX users_email_uk ON users (email);
CREATE INDEX users_organization_id_idx ON users (organization_id) WHERE organization_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Roles are rows, not a column on `users`. A user may hold several (a teacher
-- who is also a guardian), and each grant records who made it, so that a
-- privilege escalation is reconstructable after the fact.
CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, role),
  CONSTRAINT user_roles_role_ck CHECK (role IN (
    'student', 'teacher', 'guardian', 'content_author',
    'reviewer', 'moderator', 'admin', 'security_admin'
  ))
);

-- ---------------------------------------------------------------------
-- Sessions are opaque server-side records. The raw token is NEVER stored: only
-- its SHA-256. A database disclosure therefore does not yield usable tokens.
CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  ip            inet,
  user_agent    text,
  CONSTRAINT sessions_expiry_ck    CHECK (expires_at > created_at),
  CONSTRAINT sessions_token_len_ck CHECK (octet_length(token_hash) = 32)
);

CREATE UNIQUE INDEX sessions_token_hash_uk ON sessions (token_hash);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
-- Supports the expired-session reaper without scanning the whole table.
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

GRANT SELECT ON organizations TO edu_app;
GRANT SELECT, UPDATE ON users TO edu_app;
GRANT SELECT ON user_roles TO edu_app;
GRANT SELECT, UPDATE, DELETE ON sessions TO edu_app;
