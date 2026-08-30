/**
 * Test database configuration.
 *
 * Two URLs, because the whole point of the RLS tests is that the application
 * role is NOT the owner:
 *
 *   TEST_MIGRATOR_URL — owns the schema, runs migrations. Never used by the
 *                       code under test.
 *   TEST_APP_URL      — `edu_app`: NOBYPASSRLS, narrow grants. This is what the
 *                       application connects as, in tests exactly as in prod.
 *
 * A test that accidentally used the migrator URL would pass while proving
 * nothing, so `assertNotSuperuser` in global-db.ts checks this at startup.
 */
export const TEST_MIGRATOR_URL =
  process.env['TEST_MIGRATOR_URL'] ?? 'postgres://edu_migrator:mig_dev_pw@127.0.0.1:5432/edu_test'; // secret-scan-allow: local test database default, overridden by env in CI

export const TEST_APP_URL =
  process.env['TEST_APP_URL'] ?? 'postgres://edu_app:app_dev_pw@127.0.0.1:5432/edu_test'; // secret-scan-allow: local test database default, overridden by env in CI

/**
 * A connection that BYPASSES RLS.
 *
 * Two uses, both deliberate:
 *   1. Test fixtures. Seeding is not the thing under test, and FORCE ROW LEVEL
 *      SECURITY (correctly) blocks even the table owner from inserting rows no
 *      policy permits. Seeding as superuser lets a fixture construct states the
 *      application role could never create — a verified guardian link, an admin
 *      role — which is exactly what the negative tests need.
 *   2. tests/security/application-authz-without-rls.test.ts, which proves the
 *      application-layer authorization stands on its own with RLS out of the
 *      picture.
 *
 * No assertion is ever made through this connection about what the application
 * is permitted to see.
 */
export const TEST_SUPERUSER_URL =
  process.env['TEST_SUPERUSER_URL'] ??
  'postgres://postgres:postgres_test_pw@127.0.0.1:5432/edu_test'; // secret-scan-allow: local test database default, overridden by env in CI
