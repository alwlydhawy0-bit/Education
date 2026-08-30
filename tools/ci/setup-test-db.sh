#!/usr/bin/env bash
#
# Provisions a database for the integration and security suites.
#
# Mirrors what a DBA does in a real environment: a superuser creates the roles
# and the database, and everything after that runs as a non-superuser. The
# suites assert this — tests/setup/global-db.ts refuses to run if the
# application role turns out to be a superuser or to hold BYPASSRLS, because
# either would make the RLS tests pass while proving nothing.
#
# Usage:
#   PGHOST=... PGPORT=... PGPASSWORD=... tools/ci/setup-test-db.sh
set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
SUPERUSER="${PGSUPERUSER:-postgres}"
DB_NAME="${TEST_DB_NAME:-edu_test}"

APP_PASSWORD="${TEST_APP_PASSWORD:-app_dev_pw}"
MIGRATOR_PASSWORD="${TEST_MIGRATOR_PASSWORD:-mig_dev_pw}"
NORLS_PASSWORD="${TEST_NORLS_PASSWORD:-norls_test_pw}"

psql_super() {
  psql -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" -U "$SUPERUSER" "$@"
}

echo "==> Creating roles"
psql_super -d postgres \
  -v app_password="'${APP_PASSWORD}'" \
  -v migrator_password="'${MIGRATOR_PASSWORD}'" \
  -f db/bootstrap.sql

echo "==> Creating database ${DB_NAME}"
psql_super -d postgres -c "DROP DATABASE IF EXISTS ${DB_NAME};"
psql_super -d postgres -c "CREATE DATABASE ${DB_NAME} OWNER edu_migrator;"

# Test-only role: the same grants as edu_app, but with BYPASSRLS. Used by
# tests/security/layered-defense.test.ts to prove the APPLICATION authorization
# layer denies cross-user access on its own, with RLS out of the picture.
# It is never created outside a test environment.
echo "==> Creating the RLS-bypassing role used for layer-isolation tests"
psql_super -d "${DB_NAME}" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edu_app_norls') THEN
    CREATE ROLE edu_app_norls LOGIN BYPASSRLS PASSWORD '${NORLS_PASSWORD}';
  ELSE
    ALTER ROLE edu_app_norls LOGIN BYPASSRLS PASSWORD '${NORLS_PASSWORD}';
  END IF;
END
\$\$;
GRANT edu_app TO edu_app_norls;
SQL

echo "==> Applying migrations as edu_migrator"
DATABASE_URL="postgres://edu_migrator:${MIGRATOR_PASSWORD}@${PGHOST}:${PGPORT}/${DB_NAME}" \
  node --experimental-strip-types db/migrate.ts

echo "==> Test database ready: ${DB_NAME}"
