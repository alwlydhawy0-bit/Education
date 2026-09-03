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
 *   web          — React components in jsdom, with `fetch` stubbed. Still no
 *                  database and no network: a component test that reached a
 *                  real API would be an integration test wearing a disguise,
 *                  and would go stale the moment the API was slow.
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

const dbProject = (name: 'integration' | 'security' | 'evaluation', groupOrder: number) => ({
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
      {
        // JSX, so `.tsx`; esbuild reads the automatic runtime from
        // `apps/web/tsconfig.json`, which is why no React plugin is needed.
        test: {
          name: 'web',
          include: ['tests/web/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['tests/setup/web.ts'],
          sequence: { groupOrder: 0 },
        },
      },
      // Each DB-backed project gets its own group so they never overlap.
      dbProject('integration', 1),
      dbProject('security', 2),
      /**
       * The AI evaluation benchmark (Task 016). Its own group, LAST, for the
       * same reason the others are separated: it seeds a full curriculum and
       * runs the dataset against it, and a run overlapping another DB project
       * would truncate that corpus mid-benchmark and report meaningless
       * numbers rather than failing loudly.
       */
      dbProject('evaluation', 3),
    ],
  },
});
