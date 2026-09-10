/**
 * Row-Level Security audit, derived from the catalog rather than from memory.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS WHEN THERE ARE ALREADY TWENTY RLS TEST FILES
 * ---------------------------------------------------------------------------
 *
 * `tests/integration/rls-*.test.ts` prove that specific boundaries hold for
 * specific rows: this learner cannot read that note, this teacher cannot see
 * that other class. They are the right tests and they are ENUMERATIVE — each
 * one is a scenario somebody thought of and wrote down.
 *
 * The failure they cannot catch is the table nobody wrote a scenario for. A new
 * migration adds a table, grants `edu_app` the four commands, and forgets
 * `ENABLE ROW LEVEL SECURITY`. Every existing test still passes, the feature
 * works perfectly in development, and one tenant can read another's rows. There
 * is no scenario to fail because the scenario was never written.
 *
 * So this audit asks the catalog what EXISTS and applies the platform's rules
 * to all of it. A table added next year is in scope the moment it is created,
 * without anybody remembering to add it here.
 *
 * ---------------------------------------------------------------------------
 * THE SIX RULES
 * ---------------------------------------------------------------------------
 *
 * R1  REACHABLE ⇒ PROTECTED. Any table the application role can touch has RLS
 *     enabled AND forced. `ENABLE` alone exempts the owner, and the owner is
 *     what every SECURITY DEFINER function runs as.
 *
 * R2  GRANTED ⇒ COVERED. For every command granted to `edu_app` there is a
 *     policy for `edu_app` covering that command. A grant with no policy is a
 *     silent, total denial — the feature simply returns nothing, and it will be
 *     "fixed" under time pressure by someone widening a policy.
 *
 * R3  A POLICY MUST RESTRICT. A policy for `edu_app` whose USING and WITH CHECK
 *     are both unconditionally true is RLS that is switched on and enforcing
 *     nothing, which is worse than no RLS because it reads as protection. The
 *     one legitimate case is declared below and asserted to be the only one.
 *
 * R4  TENANT COLUMNS ⇒ TENANT OR OWNER SCOPING. Every table carrying
 *     `organization_id` must be narrowed either by the actor's organization or
 *     by the actor themselves. Owner scoping counts, and is STRICTER: a user
 *     belongs to one organization, so `owner_id = app_current_actor()` implies
 *     the tenant predicate.
 *
 * R5  DEFINER ⇒ POLICY FOR THE DEFINER. The rule migration 0014 wrote down and
 *     that has been missed four times. `tests/integration/rls-definer-coverage`
 *     is the enforcement; this reports it too, so one artifact answers "is the
 *     database safe" rather than three.
 *
 * R6  THE APPLICATION ROLE CANNOT BYPASS. `edu_app` must be NOSUPERUSER and
 *     NOBYPASSRLS. Everything above is decoration if it is not.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CANNOT DO
 * ---------------------------------------------------------------------------
 *
 * It reads policy expressions as TEXT and looks for actor-derived helpers by
 * name. It cannot tell a correct predicate from an incorrect one — only a
 * present one from an absent one. A policy reading
 * `organization_id <> app_actor_organization()` passes R4 and is catastrophic.
 * That is what the behavioural RLS suites are for, and why this is an addition
 * to them rather than a replacement.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node --experimental-strip-types tools/security/audit-rls.ts
 *   ... --json      machine-readable, for a checklist artifact
 *
 * Exit code 1 on any finding.
 */
import pg from 'pg';

export interface Finding {
  readonly rule: 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';
  readonly subject: string;
  readonly detail: string;
}

/** The role the application connects as. Every rule below is about this role. */
const APP_ROLE = 'edu_app';

/**
 * Helpers whose presence in a policy expression means "narrowed to the caller".
 *
 * Named rather than pattern-matched: a rule that accepted any mention of
 * `actor` would be satisfied by a column called `actor_note`, and a rule this
 * blunt should at least be blunt about something real.
 */
const ACTOR_PREDICATES = [
  'app_current_actor()',
  'app_actor_organization()',
  'app_actor_has_role',
  'app_actor_teaches_class',
  'app_actor_in_class',
  'app_actor_is_guardian_of',
  'app_actor_can_read_student',
  'app_actor_moderates_class',
  'app_portfolio_key()',
];

/**
 * R3 exemptions: `edu_app` policies that are deliberately unconditional.
 *
 * The list is asserted to be EXACT by `tests/integration/rls-audit.test.ts`, so
 * a second unconditional policy fails the build rather than joining a list
 * nobody rereads.
 */
const UNCONDITIONAL_BY_DESIGN: Readonly<Record<string, string>> = {
  'audit_log.audit_log_insert':
    'The audit trail is append-only and the application must be able to record ANY event, ' +
    'including events about actors it has just refused. A WITH CHECK narrowing this would make ' +
    'the completeness of the audit trail depend on the authorization outcome it is recording. ' +
    'Reads are separately policied; only the insert is unconditional.',
};

/**
 * R1 exemptions: tables with RLS enabled but not FORCED.
 *
 * Both hold single-use authentication tokens that `edu_app` is granted NOTHING
 * on — they are reachable only through SECURITY DEFINER functions running as
 * the owner, which is precisely what FORCE would block. The audit verifies the
 * "granted nothing" half rather than taking it on trust.
 */
const OWNER_ONLY_TABLES = new Set(['email_verifications', 'password_reset_tokens']);

interface TableRow {
  relname: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
  has_org_column: boolean;
  grants: string[];
}

interface PolicyRow {
  relname: string;
  polname: string;
  polcmd: string;
  roles: string[];
  qual: string | null;
  withcheck: string | null;
}

const COMMAND_CODE: Readonly<Record<string, string>> = {
  SELECT: 'r',
  INSERT: 'a',
  UPDATE: 'w',
  DELETE: 'd',
};

export async function auditRls(client: pg.ClientBase): Promise<Finding[]> {
  const findings: Finding[] = [];

  const { rows: tables } = await client.query<TableRow>(
    `
    SELECT c.relname,
           c.relrowsecurity,
           c.relforcerowsecurity,
           EXISTS (
             SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND a.attnum > 0
                AND NOT a.attisdropped
           ) AS has_org_column,
           COALESCE((
             SELECT array_agg(DISTINCT g.privilege_type::text)
               FROM information_schema.role_table_grants g
              WHERE g.table_schema = 'public'
                AND g.table_name = c.relname::text
                AND g.grantee = $1
                AND g.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')
           ), ARRAY[]::text[]) AS grants
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname
  `,
    [APP_ROLE],
  );

  const { rows: policies } = await client.query<PolicyRow>(`
    SELECT c.relname,
           p.polname,
           p.polcmd::text AS polcmd,
           ARRAY(SELECT r::regrole::text FROM unnest(p.polroles) r) AS roles,
           pg_get_expr(p.polqual, p.polrelid) AS qual,
           pg_get_expr(p.polwithcheck, p.polrelid) AS withcheck
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
     ORDER BY c.relname, p.polname
  `);

  const appPolicies = policies.filter((p) => p.roles.includes(APP_ROLE));

  for (const table of tables) {
    const reachable = table.grants.length > 0;

    // --- R1 -----------------------------------------------------------------
    if (reachable && !table.relrowsecurity) {
      findings.push({
        rule: 'R1',
        subject: table.relname,
        detail: `granted ${table.grants.sort().join(',')} to ${APP_ROLE} with ROW LEVEL SECURITY DISABLED — every row is readable by every actor`,
      });
    } else if (reachable && !table.relforcerowsecurity) {
      findings.push({
        rule: 'R1',
        subject: table.relname,
        detail:
          'RLS is enabled but not FORCED; the owner bypasses it, and every SECURITY DEFINER function runs as the owner',
      });
    }

    if (!reachable && !table.relforcerowsecurity && OWNER_ONLY_TABLES.has(table.relname)) {
      // The exemption asserts its own premise: unforced is only acceptable
      // because the application role is granted nothing here. If a future
      // migration adds a grant, the R1 branch above fires instead.
      continue;
    }

    // --- R2 -----------------------------------------------------------------
    const mine = appPolicies.filter((p) => p.relname === table.relname);
    for (const grant of table.grants) {
      const code = COMMAND_CODE[grant];
      const covered = mine.some((p) => p.polcmd === '*' || p.polcmd === code);
      if (!covered) {
        findings.push({
          rule: 'R2',
          subject: `${table.relname}.${grant}`,
          detail: `${APP_ROLE} is granted ${grant} but no policy covers it — the command is silently denied for every row`,
        });
      }
    }

    // --- R4 -----------------------------------------------------------------
    if (table.has_org_column && reachable) {
      const scoped = mine.some((p) =>
        [p.qual ?? '', p.withcheck ?? ''].some((expr) =>
          ACTOR_PREDICATES.some((helper) => expr.includes(helper)),
        ),
      );
      if (!scoped) {
        findings.push({
          rule: 'R4',
          subject: table.relname,
          detail:
            'carries organization_id but no policy narrows by the actor or their organization — a tenant boundary that exists as a column and not as a rule',
        });
      }
    }
  }

  // --- R3 -------------------------------------------------------------------
  for (const policy of appPolicies) {
    const qual = (policy.qual ?? 'true').trim();
    const check = (policy.withcheck ?? 'true').trim();
    if (qual !== 'true' || check !== 'true') continue;
    const key = `${policy.relname}.${policy.polname}`;
    if (key in UNCONDITIONAL_BY_DESIGN) continue;
    findings.push({
      rule: 'R3',
      subject: key,
      detail:
        'policy is unconditionally true for the application role — RLS switched on and enforcing nothing',
    });
  }

  // --- R5 -------------------------------------------------------------------
  const { rows: definerGaps } = await client.query<{ proname: string; relname: string }>(`
    WITH definers AS (
      SELECT p.proname, p.prosrc
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef
    ),
    forced AS (
      SELECT c.oid, c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity
    ),
    owner AS (SELECT rolname FROM pg_roles WHERE oid = (SELECT relowner FROM pg_class WHERE relname = 'users' AND relkind = 'r'))
    SELECT d.proname, f.relname
      FROM definers d
      JOIN forced f ON d.prosrc ~ ('\\m' || f.relname || '\\M')
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_policy p
        WHERE p.polrelid = f.oid
          AND EXISTS (
            SELECT 1 FROM unnest(p.polroles) r
             WHERE r::regrole::text = (SELECT rolname FROM owner)
          )
     )
     ORDER BY 1, 2
  `);
  for (const gap of definerGaps) {
    findings.push({
      rule: 'R5',
      subject: `${gap.proname} -> ${gap.relname}`,
      detail:
        'a SECURITY DEFINER function names a FORCE-RLS table with no policy for the definer role — the function matches no policy and silently sees zero rows',
    });
  }

  // --- R6 -------------------------------------------------------------------
  const { rows: roleRows } = await client.query<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>('SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
  const appRole = roleRows[0];
  if (!appRole) {
    findings.push({ rule: 'R6', subject: APP_ROLE, detail: 'the application role does not exist' });
  } else {
    if (appRole.rolsuper) {
      findings.push({
        rule: 'R6',
        subject: APP_ROLE,
        detail: 'the application role is SUPERUSER — every policy above is decoration',
      });
    }
    if (appRole.rolbypassrls) {
      findings.push({
        rule: 'R6',
        subject: APP_ROLE,
        detail: 'the application role has BYPASSRLS — every policy above is decoration',
      });
    }
  }

  return findings;
}

/** Counts for the readiness checklist, so "passing" has a denominator. */
export async function auditScope(
  client: pg.ClientBase,
): Promise<{ tables: number; reachable: number; policies: number; definers: number }> {
  const one = async (sql: string): Promise<number> => {
    const { rows } = await client.query<{ n: string }>(sql);
    return Number(rows[0]?.n ?? 0);
  };
  return {
    tables: await one(
      "SELECT count(*) n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'",
    ),
    reachable: await one(
      `SELECT count(DISTINCT table_name) n FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee='${APP_ROLE}'`,
    ),
    policies: await one(
      "SELECT count(*) n FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'",
    ),
    definers: await one(
      "SELECT count(*) n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef",
    ),
  };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required. Use a role that can read pg_catalog and pg_policy.');
    process.exit(2);
  }
  const asJson = process.argv.includes('--json');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const findings = await auditRls(client);
    const scope = await auditScope(client);

    if (asJson) {
      console.log(JSON.stringify({ scope, findings }, null, 2));
    } else {
      console.log(
        `RLS audit — ${scope.tables} tables, ${scope.reachable} reachable by ${APP_ROLE}, ` +
          `${scope.policies} policies, ${scope.definers} SECURITY DEFINER functions.`,
      );
      if (findings.length === 0) {
        console.log('PASS — no findings against R1-R6.');
      } else {
        console.error(`\nFAIL — ${findings.length} finding(s):\n`);
        for (const f of findings) console.error(`  [${f.rule}] ${f.subject}\n        ${f.detail}`);
        console.error('');
      }
    }
    process.exit(findings.length === 0 ? 0 : 1);
  } finally {
    await client.end();
  }
}

// Run only when invoked directly; the test suite imports `auditRls`.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
