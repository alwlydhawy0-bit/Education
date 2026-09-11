import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RULE_OPERATORS, RULE_PATH_PATTERN } from '@edu/contracts';

/**
 * Fitness functions for the interactive-lab layer.
 *
 * These assert on SOURCE TEXT rather than on behaviour, which is the point: a
 * behavioural test proves the code does the right thing today, and a structural
 * one proves the wrong thing cannot be written tomorrow without somebody
 * reading a failure that explains why.
 *
 * Three properties are pinned here:
 *
 *   1. The validation rules — the answer key — are never read on a path a
 *      learner can reach.
 *   2. The marker is never called from application code.
 *   3. The operator vocabulary in TypeScript and the one in SQL are the same
 *      list, because a divergence produces a lab an author can save and can
 *      never publish.
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

/** Same rule as `dependency-rules.test.ts`: prose about a query is not a query. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');
}

const apiCode = sourceFiles('apps/api/src').map(
  (file) => [relative(ROOT, file), stripComments(readFileSync(file, 'utf8'))] as const,
);

const MIGRATION = readFileSync(
  join(ROOT, 'db/migrations/0024_experiments_and_lab_sessions.sql'),
  'utf8',
);

describe('the validation rules stay in the database', () => {
  it('reads experiment_validation_rules from exactly one function', () => {
    // The rules are an answer key. A SELECT that reaches them from a session
    // path is one careless spread away from a response body, and nobody reading
    // the response schema would see it.
    //
    // `readRulesForAuthor` is the single permitted reader, and its name is the
    // rule: RLS returns those rows only to somebody holding `content:author` or
    // `content:publish` in the lab's own school. Everything else must not touch
    // the table at all.
    const reads = /\b(from|join)\s+(public\.)?experiment_validation_rules\b/i;
    const violations = apiCode
      .filter(([name, code]) => reads.test(code) && !name.endsWith('experiment.repository.ts'))
      .map(([name]) => name);
    expect(violations).toEqual([]);
  });

  it('mentions the rules table only in its upsert and its one read', () => {
    // Catches a subquery or CTE under a name the regex above would miss, by
    // requiring every surviving mention to be one of the two permitted
    // statements.
    const violations: string[] = [];
    for (const [name, code] of apiCode) {
      for (const line of code.split('\n')) {
        if (!/experiment_validation_rules/i.test(line)) continue;
        const permitted =
          /insert\s+into\s+experiment_validation_rules/i.test(line) ||
          /from\s+experiment_validation_rules\s+v\b/i.test(line);
        if (!permitted) violations.push(`${name}: ${line.trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('never calls the marker from application code', () => {
    // `app_experiment_state_satisfies` is revoked from PUBLIC and granted to
    // nobody. It is reachable only from the submit trigger, which is SECURITY
    // DEFINER for exactly that reason. A call from here would be a runtime
    // permission error — and, worse, an attempt to mark work without consulting
    // a policy first.
    const violations = apiCode
      .filter(([, code]) => /app_experiment_state_satisfies/.test(code))
      .map(([name]) => name);
    expect(violations).toEqual([]);
  });

  it('the migration revokes the marker from PUBLIC rather than merely not granting it', () => {
    // EXECUTE is granted to PUBLIC by default, so declining to name a function
    // in a GRANT list withholds nothing. 0024 shipped its first revision
    // without this line and the marker was callable by `edu_app`; the assertion
    // exists so that cannot recur silently.
    expect(MIGRATION).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+app_experiment_state_satisfies\(uuid,\s*jsonb\)\s+FROM\s+PUBLIC/i,
    );
    expect(MIGRATION).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+app_experiment_state_satisfies/i,
    );
  });

  it('every function 0024 declares is revoked from PUBLIC', () => {
    const declared = [...MIGRATION.matchAll(/^CREATE FUNCTION (app_[a-z_]+)\(/gm)].map(
      (m) => m[1] as string,
    );
    expect(declared.length).toBeGreaterThan(10);
    const unrevoked = declared.filter(
      (fn) => !new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${fn}\\(`, 'i').test(MIGRATION),
    );
    expect(unrevoked).toEqual([]);
  });
});

describe('no lab visibility helper is SECURITY DEFINER', () => {
  it('declares app_actor_sees_experiment with invoker rights', () => {
    // `app_actor_sees_activity` is an EXISTS over `learning_activities` whose
    // whole meaning comes from the CALLER'S Row Level Security. Wrapping it in
    // a definer function runs it as the owner, for whom every row exists, so it
    // returns true for everybody — which is precisely the defect 0024 shipped
    // and the probe caught. Every sibling in the schema is invoker-rights.
    const declaration =
      /CREATE FUNCTION app_actor_sees_experiment\(p_experiment_id uuid\)[\s\S]{0,200}?AS \$\$/.exec(
        MIGRATION,
      );
    expect(declaration, 'app_actor_sees_experiment must be declared').not.toBeNull();
    expect(declaration?.[0]).not.toMatch(/SECURITY DEFINER/);
  });
});

describe('the rule vocabulary is one vocabulary', () => {
  it('matches the operator list the SQL evaluator will publish', () => {
    // `app_experiment_rules_are_well_formed` holds the closed set that decides
    // whether a lab may be published. An operator this contract accepts but
    // that list rejects produces a lab an author can save and can never
    // publish — a worse day than a 400, and one with no error message pointing
    // at the cause.
    const gate = /NOT IN \(([\s\S]*?)\)\s*\)/.exec(
      MIGRATION.slice(MIGRATION.indexOf('app_experiment_rules_are_well_formed')),
    );
    expect(gate, 'the publication gate must list its operators').not.toBeNull();
    const inSql = [...(gate?.[1] ?? '').matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1] as string);
    expect([...inSql].sort()).toEqual([...RULE_OPERATORS].sort());
  });

  it('matches the path pattern the SQL evaluator enforces', () => {
    // The pattern bounds how deep and how wide a path may reach. If TypeScript
    // were the looser of the two, a saved rule could be unevaluable; if SQL
    // were, the contract would be rejecting paths the engine handles.
    const sql = /p_path\s*~\s*'([^']+)'/.exec(MIGRATION);
    expect(sql, 'the SQL path pattern must exist').not.toBeNull();
    expect(sql?.[1]).toBe(RULE_PATH_PATTERN.source);
  });

  it('has no evaluator in TypeScript', () => {
    // Marking lives in SQL and nowhere else. A TypeScript implementation would
    // be a second opinion about the same question, and the one a learner could
    // reach would be the one that mattered.
    const domain = stripComments(
      readFileSync(join(ROOT, 'apps/api/src/modules/experiment/experiment.domain.ts'), 'utf8'),
    );
    expect(domain).not.toMatch(/\bsatisfies\s*\(|ruleHolds|evaluateRule|stateSatisfies/i);
  });
});

describe('lab work is a record, not a draft', () => {
  it('grants no DELETE on any lab table', () => {
    // Line by line, and with SQL comments dropped first. A whole-file regex
    // matched a GRANT that was followed, many lines later, by the word DELETE
    // inside a comment explaining that DELETE is not granted — which is the
    // hazard `stripComments` exists for on the TypeScript side.
    const statements = MIGRATION.split('\n')
      .map((line) => line.replace(/--.*$/, '').trim())
      .filter((line) => /^GRANT\b/i.test(line));
    expect(statements.length).toBeGreaterThan(4);
    expect(statements.filter((line) => /\bDELETE\b/i.test(line))).toEqual([]);
  });

  it('grants no UPDATE on artifacts', () => {
    const grant = /GRANT\s+([A-Z,\s]+)\s+ON\s+experiment_artifacts\s+TO\s+edu_app/i.exec(MIGRATION);
    expect(grant, 'artifacts must have an explicit grant').not.toBeNull();
    expect(grant?.[1]).not.toMatch(/UPDATE/i);
    expect(grant?.[1]).toMatch(/SELECT/i);
    expect(grant?.[1]).toMatch(/INSERT/i);
  });

  it('has no route that edits or deletes an artifact', () => {
    const routes = stripComments(
      readFileSync(join(ROOT, 'apps/api/src/modules/experiment/experiment.routes.ts'), 'utf8'),
    );
    expect(routes).not.toMatch(/app\.(delete|patch)\(/);
    expect(routes).not.toMatch(/artifacts\/:/);
  });
});
