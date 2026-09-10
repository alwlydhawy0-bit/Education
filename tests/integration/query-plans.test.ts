import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { TEST_SUPERUSER_URL } from '../setup/env.ts';
import { auditIndexes } from '../../tools/db/audit-indexes.ts';

/**
 * QUERY PLANS, ASSERTED AGAINST THE REAL PLANNER (Task 016).
 *
 * ---------------------------------------------------------------------------
 * WHY A PLAN TEST EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * Every other test in this repository asserts on a RESULT. That is the right
 * default, and it has one blind spot: two queries that return the same rows can
 * reach them by completely different routes, and for the vector search the
 * route is the security property.
 *
 * `knowledge.repository.ts` has said since Task 011 that the scope filter runs
 * BEFORE the vector scan, so a learner's enrolment bounds what is ranked rather
 * than being applied to a ranking of everybody's material. Until Task 016 that
 * was a property of the SQL TEXT. The planner is free to reorder, and with the
 * authorized course list arriving as a parameterized array it cannot estimate
 * the filter's selectivity — so at scale it chooses the approximate index for
 * the ORDER BY and filters afterwards.
 *
 * With pgvector 0.6 (no iterative index scan) that does not merely reorder the
 * work. The scan walks a fixed candidate list, the filter discards most of it,
 * and the query RETURNS FEWER ROWS THAN THE LIMIT with no error. Measured
 * during Task 016 on a 20,000-vector table: `LIMIT 8` returned 3, ten times out
 * of ten. A tutor that cites sources then answers from an arbitrary subset of
 * what the learner was entitled to, and nothing says so.
 *
 * The fix is `AS MATERIALIZED`, and this file is what stops it being deleted by
 * someone tidying up a CTE they think is redundant.
 *
 * ---------------------------------------------------------------------------
 * THE SQL IS READ FROM THE REPOSITORY, NOT COPIED
 * ---------------------------------------------------------------------------
 *
 * A duplicated query would drift, and a plan test asserting on a query nobody
 * runs is worse than no plan test. The literal is extracted from the source
 * file, so an edit to the real query is an edit to what is planned here — and
 * a rename of the CTE fails the extraction rather than silently testing
 * nothing.
 */
const REPOSITORY = resolve(
  import.meta.dirname,
  '../../apps/api/src/modules/knowledge/knowledge.repository.ts',
);

/** Pull the retrieval query out of the repository source. */
function retrievalSql(): string {
  const source = readFileSync(REPOSITORY, 'utf8');
  const match = /`(WITH scoped AS[\s\S]*?LIMIT \$5)`/.exec(source);
  if (!match?.[1]) {
    throw new Error(
      'Could not find the retrieval query in knowledge.repository.ts. If the query was ' +
        'restructured, this test must be updated deliberately — that is the point of it.',
    );
  }
  return match[1];
}

interface PlanNode {
  'Node Type': string;
  'CTE Name'?: string;
  'Index Name'?: string;
  'Sort Key'?: string[];
  Plans?: PlanNode[];
  'Parent Relationship'?: string;
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

const client = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
const connected = client.connect();

afterAll(async () => {
  await connected;
  await client.end();
});

async function planFor(sql: string, params: readonly unknown[]): Promise<PlanNode> {
  await connected;
  const { rows } = await client.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
    `EXPLAIN (FORMAT JSON, COSTS OFF) ${sql}`,
    params as unknown[],
  );
  const plan = rows[0]?.['QUERY PLAN']?.[0]?.Plan;
  if (!plan) throw new Error('EXPLAIN returned no plan');
  return plan;
}

/** A 768-dimension vector literal, matching migration 0026's column. */
const PROBE_VECTOR = `[${Array.from({ length: 768 }, () => '0.01').join(',')}]`;

describe('the curriculum retrieval query filters before it ranks', () => {
  const params = [
    ['00000000-0000-4000-8000-000000000001'],
    PROBE_VECTOR,
    'test-deterministic-768',
    null,
    8,
  ];

  it('plans the authorized scope as a materialized CTE', async () => {
    const nodes = flatten(await planFor(retrievalSql(), params));
    const cte = nodes.find((n) => n['CTE Name'] === 'scoped');
    // Without MATERIALIZED the planner inlines the CTE and is free to push the
    // ORDER BY down into an index scan on curriculum_embeddings. The presence
    // of the node IS the guarantee that it cannot.
    expect(cte, 'the scoped CTE was inlined — filter-before-rank is not guaranteed').toBeDefined();
  });

  it('never reaches the approximate vector index', async () => {
    const nodes = flatten(await planFor(retrievalSql(), params));
    const viaVectorIndex = nodes.filter((n) =>
      (n['Index Name'] ?? '').includes('curriculum_embeddings_vector_ix'),
    );
    // The HNSW index is APPROXIMATE and, on pgvector 0.6, silently returns
    // fewer rows than the limit once a filter discards its candidates. It stays
    // in the schema for a future pgvector with iterative scans (RISK-VEC-01);
    // it must not be on this query's path today.
    expect(viaVectorIndex.map((n) => n['Index Name'])).toEqual([]);
  });

  it('orders OUTSIDE the scope, so the ranking sees only authorized rows', async () => {
    const plan = await planFor(retrievalSql(), params);
    const inCte = (plan.Plans ?? [])
      .filter((n) => n['Parent Relationship'] === 'InitPlan' || n['CTE Name'] === 'scoped')
      .flatMap(flatten);
    const sortsInsideScope = inCte.filter(
      (n) => n['Node Type'] === 'Sort' || n['Node Type'] === 'Incremental Sort',
    );
    // The scope is computed, then sorted. A sort INSIDE the CTE would mean the
    // ordering had been pushed down to where the index lives.
    expect(sortsInsideScope.map((n) => n['Node Type'])).toEqual([]);

    const outerSort = flatten(plan).find((n) => n['Node Type'] === 'Sort');
    expect(outerSort, 'nothing sorts the scoped set — the top-K is not exact').toBeDefined();
  });

  it('uses the scope index to build the authorized set', async () => {
    const nodes = flatten(await planFor(retrievalSql(), params));
    const scoped = nodes.filter((n) =>
      (n['Index Name'] ?? '').startsWith('curriculum_embeddings_'),
    );
    // Exactness is worth paying for, but only up to the size of the authorized
    // set — this asserts the set itself is found by index rather than by
    // scanning every tenant's vectors and discarding them.
    expect(scoped.length).toBeGreaterThan(0);
  });
});

describe('the schema carries the indexes its own constraints require', () => {
  it('has no cascading foreign key without a covering index, and no redundant index', async () => {
    await connected;
    const findings = await auditIndexes(client);
    // Migration 0034 added thirty-four of these. The audit is what stops the
    // thirty-fifth arriving unnoticed: deleting one parent row would otherwise
    // sequentially scan and lock the child table, and the erasure path a school
    // is legally obliged to have runs exactly those deletes.
    expect(findings.map((f) => `[${f.rule}] ${f.subject}: ${f.detail}`)).toEqual([]);
  });
});
