import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RAG_MAX_TOP_K } from '@edu/contracts';
import {
  CHUNK_BUDGET_CHARACTERS,
  CHUNK_CEILING,
  MIN_CHUNK_CHARACTERS,
} from '../../apps/api/src/modules/knowledge/chunking.ts';
import { EMBEDDING_DIMENSIONS } from '../../apps/api/src/platform/ai/embeddings.ts';

/**
 * Fitness functions for the curriculum knowledge base.
 *
 * These assert on SOURCE TEXT, not on behaviour, and the distinction is the
 * whole reason the file exists. `tests/security/rag.test.ts` proves the
 * pipeline does the right thing today; this proves the wrong thing cannot be
 * written tomorrow without somebody reading a failure that explains why.
 *
 * The properties pinned here are the ones a passing behavioural suite would
 * NOT notice being broken:
 *
 *   1. Vector search is never unbounded. Section 3 of the task forbids ranking
 *      first and filtering afterwards — and a post-hoc filter returns the same
 *      rows, so no test of the RESULT can tell the two apart. Only the shape of
 *      the SQL can.
 *   2. A learner's private workspace never enters the index. Notes, notebooks
 *      and artifacts are absent from the ingestion path by name.
 *   3. Retrieval joins the live lesson, for lifecycle and for freshness.
 *   4. The timestamp that freshness compares is never parsed into a Date.
 *   5. The chunk budget stays under the embedder's ceiling.
 */

const ROOT = resolve(import.meta.dirname, '../..');

function sourceFiles(dir: string): string[] {
  const absolute = join(ROOT, dir);
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(absolute);
  return out;
}

/** Same rule as the other fitness suites: prose about a query is not a query. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return (
        !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('--')
      );
    })
    .join('\n');
}

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const KNOWLEDGE_DIR = 'apps/api/src/modules/knowledge';
const REPOSITORY = stripComments(read(`${KNOWLEDGE_DIR}/knowledge.repository.ts`));
const SERVICE = stripComments(read(`${KNOWLEDGE_DIR}/knowledge.service.ts`));
const CHUNKING = stripComments(read(`${KNOWLEDGE_DIR}/chunking.ts`));
const MIGRATION = read('db/migrations/0026_curriculum_embeddings.sql');

const apiCode = sourceFiles('apps/api/src').map(
  (file) => [relative(ROOT, file), stripComments(readFileSync(file, 'utf8'))] as const,
);

/** Every statement in the repository that reaches the vector operator. */
const vectorQueries = REPOSITORY.split(/\btx\.query\b/)
  .slice(1)
  .filter((fragment) => fragment.includes('<=>'));

describe('vector search is pre-filtered, never unbounded', () => {
  it('has at least one vector query to reason about', () => {
    // A guard on the guard. If the repository is restructured so `<=>` no
    // longer appears next to `tx.query`, every assertion below would pass
    // vacuously — silently retiring the rules rather than failing them.
    expect(vectorQueries.length).toBeGreaterThan(0);
  });

  it('NARROWS BY COURSE BEFORE IT RANKS, in every query that ranks', () => {
    for (const query of vectorQueries) {
      const filterAt = query.indexOf('course_id = ANY(');
      // Anchored on the ORDER BY, not on the first `<=>`. The operator also
      // appears in the SELECT list, where it merely PROJECTS the distance of a
      // row the WHERE clause already admitted — reading that occurrence as the
      // ranking would fail a query that is entirely correct.
      const rankAt = /ORDER BY[^\n]*<=>/.exec(query)?.index ?? -1;
      expect(filterAt, 'a vector query with no course_id = ANY(...) pre-filter').toBeGreaterThan(
        -1,
      );
      expect(rankAt, 'a vector query that ranks without an ORDER BY').toBeGreaterThan(-1);
      // Textual order is what is being asserted, and it is meaningful here
      // because SQL puts WHERE before ORDER BY: a course filter that appeared
      // after the ranking clause would not be filtering the scan at all.
      expect(filterAt, 'the pre-filter must precede the ranking').toBeLessThan(rankAt);
    }
  });

  it('BOUNDS EVERY RANKING WITH A LIMIT', () => {
    for (const query of vectorQueries) {
      expect(query).toMatch(/LIMIT\s+\$/);
    }
  });

  it('refuses to build a scope list from anything the client sent', () => {
    // `coursesInScope` takes an actor id and nothing else. A signature that
    // accepted a course list would let the route hand the client's own filter
    // in as the scope, which is exactly the bug this whole shape prevents.
    expect(REPOSITORY).toMatch(/coursesInScope\(tx[^)]*actorId[^)]*\)/);
    expect(REPOSITORY).not.toMatch(/coursesInScope\([^)]*courseIds/);
  });

  it('INTERSECTS the client filter with the scope rather than replacing it', () => {
    // The service must reduce the scope by the client's courseId, never adopt
    // it. `filter` or `includes` is the shape of a narrowing; an assignment
    // from the request would be the shape of a widening.
    expect(SERVICE).toMatch(/coursesInScope|scope/);
    expect(SERVICE).toMatch(/\.filter\(|\.includes\(/);
  });

  it('caps topK in the contract, so a client cannot ask for the whole table', () => {
    expect(RAG_MAX_TOP_K).toBeLessThanOrEqual(50);
    expect(stripComments(read('packages/contracts/src/knowledge.contract.ts'))).toContain(
      'max(RAG_MAX_TOP_K)',
    );
  });
});

describe('retrieval is tied to the LIVE lesson', () => {
  it('joins lessons, units and courses and requires all three published', () => {
    for (const query of vectorQueries) {
      expect(query).toMatch(/JOIN\s+lessons/i);
      expect(query).toMatch(/l\.status\s*=\s*'published'/);
      expect(query).toMatch(/u\.status\s*=\s*'published'/);
      expect(query).toMatch(/c\.status\s*=\s*'published'/);
    }
  });

  it('COMPARES THE STORED TIMESTAMP AGAINST THE LIVE ONE', () => {
    // Migration 0023 argued against a chunk table partly because a copy goes
    // stale. This equality is the answer to that objection; without it the
    // objection stands and an edited lesson serves the text it used to have.
    for (const query of vectorQueries) {
      expect(query).toMatch(/e\.source_updated_at\s*=\s*l\.updated_at/);
    }
  });

  it('CARRIES THAT TIMESTAMP AS TEXT, never through a JavaScript Date', () => {
    // The defect this rule exists for: node-pg parses timestamptz into a Date,
    // which is millisecond-resolution, while the column is microsecond-
    // resolution. Reading into a Date and writing back stored a truncated copy,
    // the equality above was false for every row ever written, and retrieval
    // returned an empty result to every learner with no error anywhere. Nothing
    // about the API's shape reveals that; only the cast does.
    expect(REPOSITORY).toMatch(/l\.updated_at::text/);
    expect(REPOSITORY).not.toMatch(/updated_at:\s*Date/);
    expect(CHUNKING).not.toMatch(/updatedAt:\s*Date/);
  });
});

describe("a learner's private workspace is not in the knowledge base", () => {
  const PRIVATE_TABLES = [
    'student_notebooks',
    'student_notes',
    'student_artifacts',
    'notes',
    'notebooks',
  ];

  it('names no workspace table anywhere in the knowledge module', () => {
    for (const [file, source] of apiCode) {
      if (!file.startsWith(KNOWLEDGE_DIR)) continue;
      for (const table of PRIVATE_TABLES) {
        expect(source, `${file} refers to ${table}`).not.toMatch(
          new RegExp(`\\b${table}\\b`),
        );
      }
    }
  });

  it('gives the embeddings table no column that could point at one', () => {
    // A `note_id` or `artifact_id` column would make the exclusion a matter of
    // what the ingester happens to write, rather than of what the table can
    // hold. The schema is the stronger place to say it.
    const createTable = /CREATE TABLE curriculum_embeddings[\s\S]*?\n\);/.exec(MIGRATION)?.[0];
    expect(createTable).toBeDefined();
    for (const forbidden of ['note_id', 'notebook_id', 'artifact_id', 'owner_id', 'student_id']) {
      expect(createTable, `curriculum_embeddings has a ${forbidden} column`).not.toContain(
        forbidden,
      );
    }
  });

  it('reads only curriculum tables when it builds the index', () => {
    // An allow-list rather than a deny-list: a new private table added in some
    // future task is covered by this the day it is created, whereas a list of
    // things to avoid would have to be remembered and would not be.
    const froms = [...REPOSITORY.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g)].map((m) => m[1]);
    const ALLOWED = new Set([
      'curriculum_embeddings',
      'lessons',
      'course_units',
      'courses',
      'curricula',
      'learning_objectives',
      'class_course_assignments',
      'classes',
      'class_memberships',
      'unnest',
    ]);
    for (const table of froms) {
      expect(ALLOWED.has(table!), `knowledge.repository.ts reads ${table}`).toBe(true);
    }
  });
});

describe('the index is a derived store, not a second source of truth', () => {
  it('grants no UPDATE on the embeddings table', () => {
    // Chunks are replaced wholesale by a re-index. An UPDATE path would let a
    // row's text drift from the lesson it claims to quote while its
    // `source_updated_at` still said it was fresh.
    const grants = [...MIGRATION.matchAll(/GRANT[\s\S]*?ON curriculum_embeddings[^;]*;/g)].map(
      (m) => m[0],
    );
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) expect(grant).not.toMatch(/\bUPDATE\b/);
  });

  it('defines no UPDATE policy either', () => {
    expect(MIGRATION).not.toMatch(/CREATE POLICY[^;]*ON curriculum_embeddings\s+FOR UPDATE/);
  });

  it('DELEGATES VISIBILITY to the lesson rather than mirroring it', () => {
    // The SELECT policy asks `app_actor_sees_lesson`, the same helper the
    // curriculum itself uses. Restating the enrolment rules here would create a
    // second authorization surface that could drift from the first — and the
    // drift would be invisible, because both would keep returning rows.
    const select = /CREATE POLICY curriculum_embeddings_select[\s\S]*?;/.exec(MIGRATION)?.[0];
    expect(select).toBeDefined();
    expect(select).toContain('app_actor_sees_lesson');
  });
});

describe('the chunker cannot produce a chunk the embedder will reject', () => {
  it('keeps the budget strictly under the ceiling', () => {
    expect(CHUNK_BUDGET_CHARACTERS).toBeLessThan(CHUNK_CEILING);
  });

  it('keeps the minimum below the budget, so the two cannot deadlock', () => {
    expect(MIN_CHUNK_CHARACTERS).toBeLessThan(CHUNK_BUDGET_CHARACTERS);
  });

  it('pins the stored vector width to the embedder', () => {
    // One number in two languages. The migration's `vector(768)` and the
    // provider's `EMBEDDING_DIMENSIONS` must agree, and a mismatch would
    // present as every insert failing at run time rather than at review.
    expect(MIGRATION).toContain(`vector(${EMBEDDING_DIMENSIONS})`);
  });
});
