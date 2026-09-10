import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { TEST_SUPERUSER_URL } from '../setup/env.ts';
import { auditRls, auditScope, type Finding } from '../../tools/security/audit-rls.ts';

/**
 * THE RLS AUDIT, AND THE PROOF THAT IT CAN FAIL.
 *
 * `tools/security/audit-rls.ts` derives six rules from the catalog and applies
 * them to every table that exists, so a table added next year is in scope
 * without anybody remembering to add it here. That is the whole value, and it
 * is also the whole risk: AN AUDIT THAT ALWAYS PASSES IS INDISTINGUISHABLE
 * FROM AN AUDIT THAT WORKS.
 *
 * So this file does two things. The first block asserts the real schema is
 * clean. The second block BREAKS the schema, one rule at a time, inside a
 * transaction that is rolled back, and asserts the audit notices. Without the
 * second block the first is a green tick with nothing behind it — and a green
 * tick with nothing behind it is exactly what a production readiness checklist
 * must not contain.
 *
 * Everything runs as the superuser because the audit reads `pg_policy` and
 * `pg_proc`, and because the injections need DDL. Nothing here asserts what the
 * application can see; that is what the other twenty rls-*.test.ts files do.
 */
const client = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
const connected = client.connect();

afterAll(async () => {
  await connected;
  await client.end();
});

/**
 * Run `fn`'s DDL, audit inside the same transaction, and roll everything back.
 *
 * PostgreSQL makes DDL transactional, which is what allows a test to create a
 * deliberately broken table, observe the audit's reaction, and leave no trace.
 * The rollback is in a `finally` so a failing expectation cannot leak a broken
 * table into the suites that run after this one.
 */
async function withBrokenSchema(ddl: string): Promise<Finding[]> {
  await connected;
  await client.query('BEGIN');
  try {
    await client.query(ddl);
    return await auditRls(client);
  } finally {
    await client.query('ROLLBACK');
  }
}

const findingsFor = (findings: readonly Finding[], rule: Finding['rule'], subject: string) =>
  findings.filter((f) => f.rule === rule && f.subject.includes(subject));

describe('the real schema passes the audit', () => {
  it('has no findings against any of the six rules', async () => {
    await connected;
    const findings = await auditRls(client);
    // Printed rather than summarised: a failure here should say WHICH table,
    // because the next question is always "which one".
    expect(findings.map((f) => `[${f.rule}] ${f.subject}: ${f.detail}`)).toEqual([]);
  });

  it('audits a schema large enough for the result to mean something', async () => {
    await connected;
    const scope = await auditScope(client);
    // Not exact numbers — those change with every migration and would make this
    // a test of the changelog. The assertion is that the audit is looking at a
    // real schema rather than at an empty one, which is the failure mode that
    // would make "PASS" meaningless.
    expect(scope.tables).toBeGreaterThan(40);
    expect(scope.reachable).toBeGreaterThan(40);
    expect(scope.policies).toBeGreaterThan(100);
    expect(scope.definers).toBeGreaterThan(50);
  });
});

describe('the audit detects each violation it claims to detect', () => {
  it('R1 — a reachable table with ROW LEVEL SECURITY switched off', async () => {
    const findings = await withBrokenSchema(`
      CREATE TABLE audit_probe_r1 (id uuid PRIMARY KEY, organization_id uuid);
      GRANT SELECT, INSERT ON audit_probe_r1 TO edu_app;
    `);
    const hit = findingsFor(findings, 'R1', 'audit_probe_r1');
    expect(hit).toHaveLength(1);
    expect(hit[0]?.detail).toContain('ROW LEVEL SECURITY DISABLED');
  });

  it('R1 — RLS enabled but not FORCED, which exempts the owner every definer runs as', async () => {
    const findings = await withBrokenSchema(`
      CREATE TABLE audit_probe_r1b (id uuid PRIMARY KEY);
      ALTER TABLE audit_probe_r1b ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON audit_probe_r1b TO edu_app;
      CREATE POLICY p ON audit_probe_r1b FOR SELECT TO edu_app USING (id = app_current_actor());
    `);
    const hit = findingsFor(findings, 'R1', 'audit_probe_r1b');
    expect(hit).toHaveLength(1);
    expect(hit[0]?.detail).toContain('not FORCED');
  });

  it('R2 — a granted command with no policy covering it', async () => {
    const findings = await withBrokenSchema(`
      CREATE TABLE audit_probe_r2 (id uuid PRIMARY KEY);
      ALTER TABLE audit_probe_r2 ENABLE ROW LEVEL SECURITY;
      ALTER TABLE audit_probe_r2 FORCE ROW LEVEL SECURITY;
      GRANT SELECT, UPDATE ON audit_probe_r2 TO edu_app;
      CREATE POLICY p ON audit_probe_r2 FOR SELECT TO edu_app USING (id = app_current_actor());
    `);
    // SELECT is covered; UPDATE is granted and silently denied for every row.
    expect(findingsFor(findings, 'R2', 'audit_probe_r2.UPDATE')).toHaveLength(1);
    expect(findingsFor(findings, 'R2', 'audit_probe_r2.SELECT')).toHaveLength(0);
  });

  it('R3 — a policy that is switched on and enforcing nothing', async () => {
    const findings = await withBrokenSchema(`
      CREATE TABLE audit_probe_r3 (id uuid PRIMARY KEY);
      ALTER TABLE audit_probe_r3 ENABLE ROW LEVEL SECURITY;
      ALTER TABLE audit_probe_r3 FORCE ROW LEVEL SECURITY;
      GRANT SELECT ON audit_probe_r3 TO edu_app;
      CREATE POLICY p ON audit_probe_r3 FOR SELECT TO edu_app USING (true);
    `);
    expect(findingsFor(findings, 'R3', 'audit_probe_r3.p')).toHaveLength(1);
  });

  it('R4 — organization_id present, but no policy narrows by actor or tenant', async () => {
    const findings = await withBrokenSchema(`
      CREATE TABLE audit_probe_r4 (id uuid PRIMARY KEY, organization_id uuid NOT NULL);
      ALTER TABLE audit_probe_r4 ENABLE ROW LEVEL SECURITY;
      ALTER TABLE audit_probe_r4 FORCE ROW LEVEL SECURITY;
      GRANT SELECT ON audit_probe_r4 TO edu_app;
      -- A predicate, so R3 is satisfied. It just is not an ACTOR predicate:
      -- every row of every school still matches.
      CREATE POLICY p ON audit_probe_r4 FOR SELECT TO edu_app USING (organization_id IS NOT NULL);
    `);
    expect(findingsFor(findings, 'R4', 'audit_probe_r4')).toHaveLength(1);
    expect(findingsFor(findings, 'R3', 'audit_probe_r4')).toHaveLength(0);
  });

  it('R4 — owner scoping counts, because it is stricter than the tenant predicate', async () => {
    const findings = await withBrokenSchema(`
      CREATE TABLE audit_probe_r4b (id uuid PRIMARY KEY, organization_id uuid, owner_id uuid);
      ALTER TABLE audit_probe_r4b ENABLE ROW LEVEL SECURITY;
      ALTER TABLE audit_probe_r4b FORCE ROW LEVEL SECURITY;
      GRANT SELECT ON audit_probe_r4b TO edu_app;
      CREATE POLICY p ON audit_probe_r4b FOR SELECT TO edu_app USING (owner_id = app_current_actor());
    `);
    // The real schema relies on this: student_notebooks, student_artifacts and
    // student_portfolios all carry organization_id and are scoped by owner.
    expect(findingsFor(findings, 'R4', 'audit_probe_r4b')).toHaveLength(0);
  });

  it('R5 — a SECURITY DEFINER function reading a FORCE-RLS table with no definer policy', async () => {
    const findings = await withBrokenSchema(`
      CREATE TABLE audit_probe_r5 (id uuid PRIMARY KEY);
      ALTER TABLE audit_probe_r5 ENABLE ROW LEVEL SECURITY;
      ALTER TABLE audit_probe_r5 FORCE ROW LEVEL SECURITY;
      CREATE FUNCTION audit_probe_fn() RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER
        AS $$ SELECT EXISTS (SELECT 1 FROM audit_probe_r5) $$;
    `);
    expect(findingsFor(findings, 'R5', 'audit_probe_fn')).toHaveLength(1);
  });

  it('R6 — the application role granted BYPASSRLS', async () => {
    // ALTER ROLE is transactional, so this is rolled back with everything else.
    // It is the one injection that would invalidate every other rule at once,
    // which is why it is worth proving the audit sees it.
    const findings = await withBrokenSchema('ALTER ROLE edu_app BYPASSRLS;');
    const hit = findingsFor(findings, 'R6', 'edu_app');
    expect(hit).toHaveLength(1);
    expect(hit[0]?.detail).toContain('BYPASSRLS');
  });
});

describe('the declared exemptions are exactly the ones that exist', () => {
  it('audit_log.audit_log_insert is the only unconditional application policy', async () => {
    await connected;
    const { rows } = await client.query<{ subject: string }>(`
      SELECT c.relname || '.' || p.polname AS subject
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND EXISTS (SELECT 1 FROM unnest(p.polroles) r WHERE r::regrole::text = 'edu_app')
         AND COALESCE(pg_get_expr(p.polqual, p.polrelid), 'true') = 'true'
         AND COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), 'true') = 'true'
       ORDER BY 1
    `);
    // If this fails, a new unconditional policy was added. Either narrow it or
    // add it to UNCONDITIONAL_BY_DESIGN with a reason — but the reason has to
    // be written, which is the point.
    expect(rows.map((r) => r.subject)).toEqual(['audit_log.audit_log_insert']);
  });

  it('the unforced tables are unforced only because the application cannot reach them', async () => {
    await connected;
    const { rows } = await client.query<{ relname: string; grants: number }>(`
      SELECT c.relname,
             (SELECT count(*) FROM information_schema.role_table_grants g
               WHERE g.table_schema = 'public' AND g.table_name = c.relname::text
                 AND g.grantee = 'edu_app')::int AS grants
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND c.relrowsecurity AND NOT c.relforcerowsecurity
       ORDER BY 1
    `);
    expect(rows.map((r) => r.relname)).toEqual(['email_verifications', 'password_reset_tokens']);
    // The premise of the exemption, checked rather than trusted: these are safe
    // WITHOUT force only while edu_app holds no privilege on them at all.
    for (const row of rows) expect(row.grants).toBe(0);
  });
});
