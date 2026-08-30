/**
 * Migration runner.
 *
 * Deliberately small and dependency-light: migrations are plain SQL files
 * applied in filename order, each inside its own transaction, recorded in
 * `schema_migrations` with a SHA-256 checksum.
 *
 * The checksum is the point. Once a migration has been applied, editing it is
 * an error rather than a silent no-op — which is what stops "I fixed the
 * migration" from meaning "production and my laptop now have different
 * schemas". Section 25 of the platform brief (backward compatibility) depends
 * on this being non-negotiable.
 *
 * Usage:
 *   DATABASE_URL=postgres://edu_migrator:...@host/db node --experimental-strip-types db/migrate.ts  // secret-scan-allow: documentation example, not a real credential
 *   ... db/migrate.ts --reset     # drops and recreates the public schema first
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

interface MigrationFile {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

async function loadMigrations(): Promise<MigrationFile[]> {
  const entries = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const name of entries) {
    const sql = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
    files.push({ name, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return files;
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }

  const reset = process.argv.includes('--reset');
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    if (reset) {
      if (process.env['NODE_ENV'] === 'production') {
        throw new Error('Refusing to --reset with NODE_ENV=production.');
      }
      console.log('Resetting schema public...');
      await client.query('DROP SCHEMA IF EXISTS public CASCADE');
      await client.query('CREATE SCHEMA public');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = new Map<string, string>();
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    for (const row of rows) applied.set(row.name, row.checksum);

    const migrations = await loadMigrations();
    let ran = 0;

    for (const migration of migrations) {
      const previous = applied.get(migration.name);

      if (previous !== undefined) {
        if (previous !== migration.checksum) {
          throw new Error(
            `Migration "${migration.name}" has already been applied but its contents have changed.\n` +
              `  applied checksum: ${previous}\n` +
              `  current checksum: ${migration.checksum}\n` +
              'Applied migrations are immutable. Add a new migration instead of editing this one.',
          );
        }
        continue;
      }

      console.log(`Applying ${migration.name}...`);
      // Each migration is atomic: a failure part-way leaves the schema exactly
      // as it was, so a retry is always safe.
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          migration.name,
          migration.checksum,
        ]);
        await client.query('COMMIT');
        ran += 1;
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration "${migration.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    console.log(
      ran === 0 ? 'Schema is up to date; nothing to apply.' : `Applied ${ran} migration(s).`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
