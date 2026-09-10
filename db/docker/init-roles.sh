#!/usr/bin/env bash
# =============================================================================
# One-time cluster bootstrap for the compose stack.
# =============================================================================
#
# The postgres image runs everything in /docker-entrypoint-initdb.d ONCE, on an
# empty data directory, as the superuser. That is exactly the window in which
# the role separation this platform depends on has to be established:
#
#   edu_migrator — owns the schema, runs migrations. NOBYPASSRLS, NOSUPERUSER.
#   edu_app      — what the server connects as. NOBYPASSRLS, non-owner.
#
# The separation is not tidiness. `FORCE ROW LEVEL SECURITY` binds the table
# owner too, and every SECURITY DEFINER function runs as the owner; a server
# connecting as edu_migrator would silently bypass Row-Level Security across
# the whole schema, with no error and no visible symptom.
#
# It DELEGATES to db/bootstrap.sql rather than restating it. A second copy of
# the role definitions would drift from the one CI uses, and the drift would be
# invisible until an environment behaved differently from the tests.
#
# The passwords below are local development values for a database that
# publishes no port to the host. A real deployment supplies them through the
# orchestrator's secret mechanism.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="'app_local_pw'" \
  -v migrator_password="'migrator_local_pw'" \
  -f /bootstrap/bootstrap.sql

# The entrypoint created POSTGRES_DB owned by the superuser. Migrations run as
# edu_migrator and create tables, so the schema has to belong to it — otherwise
# the first migration fails on "must be owner of schema public".
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "ALTER DATABASE ${POSTGRES_DB} OWNER TO edu_migrator;"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "ALTER SCHEMA public OWNER TO edu_migrator;"
