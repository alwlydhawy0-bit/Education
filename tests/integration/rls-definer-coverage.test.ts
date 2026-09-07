import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { TEST_SUPERUSER_URL } from '../setup/env.ts';

/**
 * THE DEFINER/FORCE-RLS RULE, DERIVED FROM THE CATALOG RATHER THAN REMEMBERED.
 *
 * Migration 0014 wrote the rule down in 2024:
 *
 *   "EVERY table a SECURITY DEFINER function touches needs a policy for the
 *    definer role, for every command it performs."
 *
 * It has now been missed three times — VULN-044 in Task 010, VULN-050 in Task
 * 012, and `app_project_is_publicly_listed` in Task 013, where a genuinely
 * public project became invisible to the world because `edu_migrator` matched
 * no policy on `student_projects`. Each time the symptom was the same and each
 * time it was found by a probe rather than by a test.
 *
 * Three repeats of a written-down rule is not a memory problem, it is an
 * enforcement gap. So this suite does not enumerate functions. It asks the
 * catalog which functions are SECURITY DEFINER, asks which tables have FORCE
 * ROW LEVEL SECURITY, and asserts the pairing — which means the FOURTH instance
 * fails here instead of shipping, including in a domain nobody has written yet.
 *
 * ---------------------------------------------------------------------------
 * WHY IT MATTERS, MECHANICALLY
 * ---------------------------------------------------------------------------
 *
 * `FORCE ROW LEVEL SECURITY` binds the table OWNER too. A SECURITY DEFINER
 * function runs AS the owner (`edu_migrator`). Every ordinary policy on this
 * platform is written `TO edu_app`. So a definer function reading a FORCE-RLS
 * table matches NO policy and silently sees zero rows — no error, no warning,
 * just a helper that answers `false` for everything and a boundary that fails
 * in whichever direction the caller happened to write the condition.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS TEST CANNOT DO
 * ---------------------------------------------------------------------------
 *
 * It reads `prosrc` as text and looks for table names as whole words. That is a
 * heuristic, not a parser: a name inside a comment or a string literal counts,
 * and a table reached only through another function does not. Both errors are
 * in the safe direction — the first over-reports and is silenced by adding the
 * policy the rule wants anyway; the second is covered because the inner
 * function is itself in this scan.
 *
 * COMMAND COVERAGE IS CHECKED, not assumed. Some definer functions on this
 * platform write — the pre-authentication `auth_*` ones must, since there is no
 * actor yet to write as — so a SELECT policy is not enough for them. The
 * command is inferred from the statement's shape, and a bare mention counts as
 * a read because that is the case that fails silently.
 */
const client = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
await client.connect();

afterAll(async () => {
  await client.end();
});

interface DefinerFunction {
  name: string;
  source: string;
}

interface ForcedTable {
  name: string;
  /** The `polcmd` codes the owner role has a policy for. */
  definerCommands: Set<string>;
}

const definerFunctions = async (): Promise<DefinerFunction[]> => {
  const { rows } = await client.query<DefinerFunction>(
    `SELECT p.proname AS name, p.prosrc AS source
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prosecdef
      ORDER BY p.proname`,
  );
  return rows;
};

/**
 * Tables with FORCE ROW LEVEL SECURITY, and which COMMANDS the owner role has a
 * policy for.
 *
 * `pg_policy.polroles` holds the role oids; a policy with no `TO` clause has
 * `{0}`, meaning PUBLIC, which covers the owner too. `polcmd` is 'r' SELECT,
 * 'a' INSERT, 'w' UPDATE, 'd' DELETE, '*' ALL.
 */
const forcedTables = async (): Promise<ForcedTable[]> => {
  const { rows } = await client.query<{ name: string; commands: string[] }>(
    `SELECT c.relname AS name,
            coalesce(
              (SELECT array_agg(DISTINCT pol.polcmd::text)
                 FROM pg_policy pol
                WHERE pol.polrelid = c.oid
                  AND (0 = ANY (pol.polroles)
                       OR EXISTS (SELECT 1 FROM pg_roles r
                                   WHERE r.oid = ANY (pol.polroles)
                                     AND r.rolname = 'edu_migrator'))),
              ARRAY[]::text[]) AS commands
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relrowsecurity
        AND c.relforcerowsecurity
      ORDER BY c.relname`,
  );
  return rows.map((row) => ({ name: row.name, definerCommands: new Set(row.commands) }));
};

const mentions = (source: string, table: string): boolean =>
  new RegExp(`(^|[^a-z0-9_])${table}([^a-z0-9_]|$)`, 'i').test(source);

/**
 * Which commands a function body performs against one table.
 *
 * Crude on purpose — see the header. A bare mention counts as a read, because
 * that is the case that fails silently; the write forms are matched by their
 * SQL shape so that a definer function which INSERTs is not satisfied by a
 * SELECT policy.
 */
function commandsAgainst(source: string, table: string): Set<string> {
  const commands = new Set<string>();
  if (new RegExp(`insert\\s+into\\s+${table}\\b`, 'i').test(source)) commands.add('a');
  if (new RegExp(`update\\s+${table}\\b`, 'i').test(source)) commands.add('w');
  if (new RegExp(`delete\\s+from\\s+${table}\\b`, 'i').test(source)) commands.add('d');
  if (mentions(source, table)) commands.add('r');
  return commands;
}

const COMMAND_NAMES: Readonly<Record<string, string>> = {
  r: 'SELECT',
  a: 'INSERT',
  w: 'UPDATE',
  d: 'DELETE',
};

describe('SECURITY DEFINER functions and FORCE ROW LEVEL SECURITY', () => {
  it('finds definer functions and forced tables to check', async () => {
    // A guard against this whole suite quietly passing because a query broke.
    expect((await definerFunctions()).length).toBeGreaterThan(5);
    expect((await forcedTables()).length).toBeGreaterThan(10);
  });

  it('every FORCE-RLS table a definer function touches has a policy for that command', async () => {
    const functions = await definerFunctions();
    const tables = await forcedTables();

    const gaps: string[] = [];
    for (const table of tables) {
      if (table.definerCommands.has('*')) continue;
      for (const fn of functions) {
        for (const command of commandsAgainst(fn.source, table.name)) {
          if (table.definerCommands.has(command)) continue;
          gaps.push(
            `${table.name}: ${fn.name} performs ${COMMAND_NAMES[command]} but there is no ` +
              `${COMMAND_NAMES[command]} policy for edu_migrator. That statement sees or ` +
              'writes ZERO ROWS, silently. Add: CREATE POLICY ' +
              `${table.name}_definer_${(COMMAND_NAMES[command] ?? '').toLowerCase()} ON ` +
              `${table.name} FOR ${COMMAND_NAMES[command]} TO edu_migrator ` +
              `${command === 'a' ? 'WITH CHECK (true)' : 'USING (true)'};`,
          );
        }
      }
    }

    expect(gaps, `\n${gaps.join('\n')}`).toEqual([]);
  });

  /**
   * Two known instances, pinned by name.
   *
   * The catalog-derived assertion above is the real control; these exist so
   * that a future change which accidentally narrows THAT query — making it
   * vacuously true — still fails on cases we already know about.
   *
   * VULN-050 is deliberately NOT pinned here. Its fix was to DELETE the definer
   * function and replace it with a composite foreign key, so `ai_conversations`
   * correctly has no definer policy and needs none. Pinning it would assert the
   * wrong remedy — the better fix for this class of bug is usually to stop
   * needing the definer function, not to grant it more.
   */
  it.each([
    ['users', 'the pre-authentication path, definer since Task 001'],
    ['student_projects', 'Task 013, the third instance of the definer/FORCE-RLS trap'],
  ])('%s has definer policies for what its definer functions do (%s)', async (table) => {
    const found = (await forcedTables()).find((t) => t.name === table);
    expect(found, `${table} is not a FORCE-RLS table any more`).toBeDefined();
    expect(found?.definerCommands.size ?? 0).toBeGreaterThan(0);
  });
});
