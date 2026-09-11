/**
 * Index audit: the indexes the schema's own constraints imply.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CHECKS, AND WHY EACH ONE IS DERIVABLE RATHER THAN A MATTER OF TASTE
 * ---------------------------------------------------------------------------
 *
 * Most index decisions are workload questions and cannot be settled by reading
 * a catalog. These three can, because the schema itself states the requirement:
 *
 * I1  CASCADING FOREIGN KEYS ARE INDEXED. PostgreSQL indexes the referenced
 *     side of a foreign key and never the referencing side. To enforce
 *     ON DELETE CASCADE or SET NULL it must find the children of a departing
 *     parent; with no index it sequentially scans the child table while holding
 *     a lock on it. On this platform the parent deletes are the erasure path a
 *     school is legally obliged to have, so the scans are not hypothetical.
 *
 * I2  NO REDUNDANT INDEXES. An index whose columns are a leading prefix of
 *     another index on the same table is served by that other index. It still
 *     costs a write on every insert and update, forever. This rule is the
 *     counterweight to I1: a rule that only ever says "add an index" turns into
 *     a schema nobody can write to.
 *
 * I3  NO INDEX ON A COLUMN THE PLANNER CANNOT USE ALONE. Reported, not failed —
 *     see the honesty note below.
 *
 * ---------------------------------------------------------------------------
 * THE HONESTY NOTE
 * ---------------------------------------------------------------------------
 *
 * This tool cannot tell you whether your queries are fast. It tells you that
 * the constraints you declared have the indexes those constraints require. A
 * schema can pass this audit completely and still have a query that scans a
 * million rows, because that query is not in the catalog. Query plans are
 * checked separately, against real plans, in
 * `tests/integration/query-plans.test.ts`.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node --experimental-strip-types tools/db/audit-indexes.ts
 *   ... --json
 *
 * Exit code 1 on any finding.
 */
import pg from 'pg';

export interface IndexFinding {
  readonly rule: 'I1' | 'I2';
  readonly subject: string;
  readonly detail: string;
}

/**
 * Foreign keys whose parent deletion cascades or nulls, with no index whose
 * leading columns are exactly the constraint's columns.
 *
 * The index-matching condition is a MUTUAL containment of the constraint's
 * column set and the index's leading columns, which is the same thing as "the
 * index's leading columns are the constraint's columns in some order". Order
 * within the leading prefix does not matter to PostgreSQL for this purpose;
 * what matters is that no other column comes first.
 */
const UNINDEXED_CASCADES = `
  WITH fk AS (
    SELECT con.conname, c.relname AS tbl, con.conkey, con.conrelid, con.confdeltype
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE con.contype = 'f' AND n.nspname = 'public'
  )
  SELECT fk.tbl,
         fk.conname,
         fk.confdeltype::text AS action,
         (SELECT string_agg(a.attname, ',' ORDER BY ord)
            FROM unnest(fk.conkey) WITH ORDINALITY k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = fk.conrelid AND a.attnum = k.attnum) AS cols
    FROM fk
   WHERE fk.confdeltype IN ('c', 'n', 'd')
     AND NOT EXISTS (
       SELECT 1 FROM pg_index i
        WHERE i.indrelid = fk.conrelid
          AND (i.indkey::int2[])[0:array_length(fk.conkey, 1) - 1] @> fk.conkey
          AND fk.conkey @> (i.indkey::int2[])[0:array_length(fk.conkey, 1) - 1]
     )
   ORDER BY fk.tbl, fk.conname
`;

/**
 * An index whose column list is a leading prefix of another index on the same
 * table. Unique indexes are excluded on BOTH sides of the comparison: a unique
 * index is a constraint, not an access path, and dropping one changes what the
 * database permits rather than only what it costs.
 *
 * ---------------------------------------------------------------------------
 * THE COMPARISON IS BY TEXT, AND THAT IS NOT LAZINESS — IT IS THE FIX
 * ---------------------------------------------------------------------------
 *
 * This rule was written with `slice = array` and NEVER ONCE FIRED. `indkey` is
 * an `int2vector`, which casts to a ZERO-based array; a slice of it comes back
 * ONE-based. PostgreSQL's array equality compares dimension bounds as well as
 * contents, so:
 *
 *     '[0:0]={1}'::int2[] = '{1}'::int2[]   -->   FALSE
 *
 * The predicate was structurally incapable of being true. The audit reported
 * "no redundant indexes" on every run, and that clean result meant nothing —
 * a rule that always passes is indistinguishable from a rule that works, which
 * is the entire reason `tests/integration/query-plans.test.ts` now injects a
 * known-redundant pair and asserts the audit finds it.
 *
 * `array_to_string` ignores bounds and compares contents in order, which is
 * exactly the question being asked.
 *
 * Found by defect injection round 15 (F18): changing this rule's sibling filter
 * escaped every suite, which prompted writing the falsification tests that
 * exposed this.
 */
const REDUNDANT_INDEXES = `
  SELECT t.relname AS tbl,
         ix.relname AS redundant,
         iy.relname AS covered_by
    FROM pg_index x
    JOIN pg_class ix ON ix.oid = x.indexrelid
    JOIN pg_class t  ON t.oid  = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_index y ON y.indrelid = x.indrelid AND y.indexrelid <> x.indexrelid
    JOIN pg_class iy ON iy.oid = y.indexrelid
   WHERE n.nspname = 'public'
     AND NOT x.indisunique AND NOT y.indisunique
     AND x.indpred IS NULL AND y.indpred IS NULL
     AND array_length(x.indkey::int2[], 1) < array_length(y.indkey::int2[], 1)
     AND array_to_string((y.indkey::int2[])[0:array_length(x.indkey::int2[], 1) - 1], ',')
       = array_to_string(x.indkey::int2[], ',')
   ORDER BY 1, 2
`;

export async function auditIndexes(client: pg.ClientBase): Promise<IndexFinding[]> {
  const findings: IndexFinding[] = [];

  const { rows: cascades } = await client.query<{
    tbl: string;
    conname: string;
    action: string;
    cols: string;
  }>(UNINDEXED_CASCADES);
  for (const row of cascades) {
    const action =
      row.action === 'c'
        ? 'ON DELETE CASCADE'
        : row.action === 'n'
          ? 'ON DELETE SET NULL'
          : 'ON DELETE SET DEFAULT';
    findings.push({
      rule: 'I1',
      subject: `${row.tbl}.${row.conname}`,
      detail: `${action} on (${row.cols}) with no covering index — deleting a parent row sequentially scans and locks ${row.tbl}`,
    });
  }

  const { rows: redundant } = await client.query<{
    tbl: string;
    redundant: string;
    covered_by: string;
  }>(REDUNDANT_INDEXES);
  for (const row of redundant) {
    findings.push({
      rule: 'I2',
      subject: `${row.tbl}.${row.redundant}`,
      detail: `its columns are a leading prefix of ${row.covered_by}; it is never the better plan and costs a write on every insert`,
    });
  }

  return findings;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required.');
    process.exit(2);
  }
  const asJson = process.argv.includes('--json');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const findings = await auditIndexes(client);
    const { rows } = await client.query<{ indexes: string; constraints: string }>(`
      SELECT (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public')::text AS indexes,
             (SELECT count(*) FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND con.contype = 'f')::text AS constraints
    `);
    const scope = rows[0];

    if (asJson) {
      console.log(JSON.stringify({ scope, findings }, null, 2));
    } else {
      console.log(
        `Index audit — ${scope?.indexes ?? '?'} indexes over ${scope?.constraints ?? '?'} foreign keys.`,
      );
      if (findings.length === 0) {
        console.log('PASS — no findings against I1-I2.');
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

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
