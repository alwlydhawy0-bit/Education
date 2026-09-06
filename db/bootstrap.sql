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

-- =====================================================================
-- EXTENSIONS
-- =====================================================================
-- `pgvector` lives in its OWN SCHEMA, and both halves of that are deliberate.
--
-- IT IS HERE, NOT IN A MIGRATION, because `CREATE EXTENSION vector` requires
-- superuser and `edu_migrator` is deliberately not one. A migration that
-- needed superuser would either fail in every correctly-configured
-- environment or push every deployment to run migrations as a superuser —
-- which would give every SECURITY DEFINER function on this platform superuser
-- rights. The privilege model is worth more than the convenience.
--
-- IT IS IN `extensions`, NOT `public`, because `db/migrate.ts --reset` does
-- `DROP SCHEMA public CASCADE`. An extension in `public` would be destroyed by
-- every test run and could not be recreated by the non-superuser that runs
-- them. In `extensions` it survives, which is also how every managed Postgres
-- provider arranges it.
--
-- The database search_path then makes the `vector` type, the HNSW operator
-- classes and the `<=>` operator resolve unqualified.
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO edu_migrator, edu_app;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;
  ELSE
    -- A WARNING rather than an exception: the rest of the platform works
    -- without it, and migration 0026 refuses clearly when it is missing. A
    -- failure here would block a cluster that only wanted identity and
    -- curriculum.
    RAISE WARNING 'pgvector is not available on this server. Install postgresql-%-pgvector; migration 0026 will refuse to apply until it is present.', current_setting('server_version_num')::int / 10000;
  END IF;
END
$$;

-- Applies to new sessions on this database. Named explicitly rather than
-- appended, so the resulting path is reviewable in one place.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = public, extensions', current_database());
END
$$;

\if :{?migrator_password}
  ALTER ROLE edu_migrator PASSWORD :migrator_password;
\endif
\if :{?app_password}
  ALTER ROLE edu_app PASSWORD :app_password;
\endif
