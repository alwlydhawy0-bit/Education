/**
 * Test projects.
 *
 * The layers are separated so a developer can run the fast ones on every save
 * and CI can run all of them. `security` is its own named project so that a CI
 * job can fail the build on security-test failure specifically, and so nobody
 * can quietly drop those tests by editing an unrelated `include` glob.
 *
 *   unit         — pure logic. No database, no network, no filesystem.
 *   architecture — fitness functions asserting the dependency rules hold.
 *   integration  — real PostgreSQL. Proves the schema, constraints and RLS.
 *   security     — real PostgreSQL + real HTTP. Proves the security boundaries.
 *
 * CONCURRENCY. `integration` and `security` share one PostgreSQL database and
 * truncate it between tests, so they must never run at the same time — as each
 * other, or as anything else touching the database. Two mechanisms enforce that:
 *
 *   - `sequence.groupOrder` puts each DB-backed project in its own group, and
 *     Vitest runs groups strictly in ascending order.
 *   - `singleFork` keeps each project's own files serial within its group.
 *
 * Without both, tests fail intermittently with foreign-key violations as one
 * suite truncates rows another is mid-way through using. (That is exactly what
 * happened on the Vitest 4 upgrade, which made projects run in parallel by
 * default.)
 */
import { defineConfig } from 'vitest/config';

const dbProject = (name: 'integration' | 'security', groupOrder: number) => ({
  test: {
    name,
    include: [`tests/${name}/**/*.test.ts`],
    globalSetup: ['tests/setup/global-db.ts'],
    pool: 'forks' as const,
    // Vitest 4 moved the pool options to the top level; the old
    // `poolOptions.forks.singleFork` is silently ignored, which is how the
    // upgrade turned these suites flaky without any error.
    maxWorkers: 1,
    minWorkers: 1,
    // Files within this project run strictly one at a time.
    fileParallelism: false,
    sequence: { groupOrder },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: 'architecture',
          include: ['tests/architecture/**/*.test.ts'],
          sequence: { groupOrder: 0 },
        },
      },
      // Each DB-backed project gets its own group so they never overlap.
      dbProject('integration', 1),
      dbProject('security', 2),
    ],
  },
});
