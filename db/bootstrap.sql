-- =====================================================================
-- bootstrap.sql — run ONCE per cluster, as a superuser, before migrations.
-- =====================================================================
-- Separated from the migrations because it needs privileges the migration role
-- must not itself hold (CREATEROLE). Keeping it separate means the day-to-day
-- migration path never runs as superuser.
--
--   psql -v app_password="'...'" -v migrator_password="'...'" -f db/bootstrap.sql
--
-- Passwords are passed as psql variables so they are not committed here.
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edu_migrator') THEN
    CREATE ROLE edu_migrator LOGIN NOBYPASSRLS NOSUPERUSER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edu_app') THEN
    CREATE ROLE edu_app LOGIN NOBYPASSRLS NOSUPERUSER;
  END IF;

  -- Re-assert the security-relevant attributes on every run, so that a role
  -- accidentally granted BYPASSRLS or SUPERUSER by hand is corrected here.
  ALTER ROLE edu_migrator NOBYPASSRLS NOSUPERUSER NOCREATEROLE;
  ALTER ROLE edu_app      NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
END
$$;

\if :{?migrator_password}
  ALTER ROLE edu_migrator PASSWORD :migrator_password;
\endif
\if :{?app_password}
  ALTER ROLE edu_app PASSWORD :app_password;
\endif
