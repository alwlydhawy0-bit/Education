import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { TEST_APP_URL, TEST_MIGRATOR_URL } from './env.js';

/**
 * Runs once before the integration and security suites.
 *
 * Rebuilds the test schema from the migrations on every run, so the tests
 * always describe the CURRENT schema rather than whatever state a previous run
 * left behind. It also asserts the two properties the security tests depend on:
 * the application role must not be a superuser, and must not have BYPASSRLS.
 * Without those checks a misconfigured environment would turn the RLS suite
 * into a set of tests that pass while proving nothing.
 */
export async function setup(): Promise<void> {
  execFileSync(process.execPath, ['--experimental-strip-types', 'db/migrate.ts', '--reset'], {
    env: { ...process.env, DATABASE_URL: TEST_MIGRATOR_URL },
    stdio: 'pipe',
  });

  const client = new pg.Client({ connectionString: TEST_APP_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT current_user, r.rolsuper, r.rolbypassrls
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    const row = rows[0];
    if (!row) throw new Error('Could not determine the test application role.');

    if (row.rolsuper) {
      throw new Error(
        `TEST_APP_URL connects as superuser "${row.current_user}". ` +
          'Superusers bypass RLS, so the security suite would pass vacuously. Refusing to run.',
      );
    }
    if (row.rolbypassrls) {
      throw new Error(
        `TEST_APP_URL role "${row.current_user}" has BYPASSRLS. ` +
          'The RLS tests would pass vacuously. Refusing to run.',
      );
    }
  } finally {
    await client.end();
  }
}
