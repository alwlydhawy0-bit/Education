import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANALYTICS_REPORT_ACTIONS } from '@edu/authz';
import {
  CSV_INJECTION_PAYLOADS,
  CSV_MUST_NOT_MANGLE,
  csvCell,
} from '../../apps/api/src/modules/analytics/csv-safety.ts';

/**
 * Fitness functions for institutional analytics.
 *
 * SOURCE TEXT, NOT BEHAVIOUR. `tests/security/analytics.test.ts` proves the
 * pipeline does the right thing today; this proves the wrong thing cannot be
 * written tomorrow without somebody reading a failure that explains why.
 *
 * Two assertions here are the permanent structural record of a defect found
 * while building this domain, and each names it:
 *
 *   No request schema may declare an `organizationId` — the tenant comes from
 *   the session or it does not come at all, and a field to put one in is the
 *   difference between a structural guarantee and a check somebody maintains.
 *
 *   Every query against an analytics table must carry its own tenant predicate
 *   — VULN-056, where the platform's one route that stood on RLS alone returned
 *   any row to anybody against a BYPASSRLS role.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const MODULE = 'apps/api/src/modules/analytics';

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

/** Prose about a query is not a query. Same rule as the other fitness suites. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('--');
    })
    .join('\n');
}

/**
 * SQL comments removed.
 *
 * A migration that explains what it does NOT do will contain the very strings a
 * fitness function looks for. Both `--` lines and block comments go.
 */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const code = (path: string): string => stripComments(read(path));

const CSV = `${MODULE}/csv-safety.ts`;
const REPOSITORY = `${MODULE}/analytics.repository.ts`;
const SERVICE = `${MODULE}/analytics.service.ts`;
const ROUTES = `${MODULE}/analytics.routes.ts`;
const CONTRACT = 'packages/contracts/src/analytics.contract.ts';
const POLICY = 'packages/authz/src/policies/analytics.policy.ts';
const MIGRATION = 'db/migrations/0032_institutional_analytics.sql';

describe('the tenant has nowhere to arrive from a request', () => {
  it('NO REQUEST SCHEMA DECLARES AN organizationId', () => {
    /**
     * Section 2B asks that the tenant be "derived directly from the
     * authenticated user's auth context". The way to fail that is to accept an
     * `organizationId` and check it — which works until somebody adds a branch,
     * an endpoint, or a "just for support staff" flag.
     *
     * The way to pass it structurally is to have nowhere to put one. With
     * `.strict()` schemas and no such field, the attack is a 400 about a field
     * that does not exist.
     */
    const contract = code(CONTRACT);
    const requestSchemas = contract.match(/export const \w*QuerySchema[\s\S]*?\.strict\(\);/g) ?? [];
    expect(requestSchemas.length).toBeGreaterThanOrEqual(4);
    for (const schema of requestSchemas) {
      expect(schema, schema.slice(0, 60)).not.toMatch(/organizationId|organization_id|schoolId/);
    }
  });

  it('no route takes an organization in its path', () => {
    const routes = code(ROUTES);
    const paths = routes.match(/'\/api\/v1\/analytics[^']*'/g) ?? [];
    expect(paths.length).toBeGreaterThanOrEqual(4);
    for (const path of paths) {
      expect(path).not.toMatch(/:org|:school|:tenant/);
    }
  });

  it('every request schema is strict', () => {
    // A field that arrives undeclared is a 400, not a silent ignore — which is
    // how `organizationId` would otherwise reach a query somebody widened.
    const contract = code(CONTRACT);
    const objects = (contract.match(/z\.object\(/g) ?? []).length;
    const stricts = (contract.match(/\.strict\(\)/g) ?? []).length;
    expect(stricts).toBeGreaterThanOrEqual(objects);
  });
});

describe('every analytics query carries its own tenant predicate', () => {
  it('EACH STATEMENT AGAINST AN ANALYTICS TABLE FILTERS ON app_actor_organization()', () => {
    /**
     * VULN-056'S LESSON, APPLIED BEFORE IT CAN RECUR.
     *
     * In Task 013 the public portfolio resolver carried no WHERE clause and let
     * RLS match the key — reasoning that two places deciding one thing is how
     * they come to disagree. Against a BYPASSRLS role it returned any portfolio
     * to anybody.
     *
     * It is the SAME predicate from the SAME source, so the two cannot drift;
     * and with RLS removed these queries are still bounded to one school, which
     * is what the layered-defence block measures.
     */
    const repository = code(REPOSITORY);
    const statements = repository.match(/FROM analytics_\w+[\s\S]*?`/g) ?? [];
    expect(statements.length).toBeGreaterThanOrEqual(2);
    for (const statement of statements) {
      expect(statement, statement.slice(0, 80)).toContain('app_actor_organization()');
    }
  });

  it('the predicate handles NULL explicitly', () => {
    // `organization_id = app_actor_organization()` is NULL — not false — when
    // the actor has no organization, and a NULL in a WHERE clause admits
    // nothing, so this is belt and braces rather than a fix. It is asserted
    // because the RLS policy makes the same explicit check, and the two should
    // say the same thing.
    const repository = code(REPOSITORY);
    expect(repository).toContain('app_actor_organization() IS NOT NULL');
    expect(read(MIGRATION)).toContain('organization_id IS NOT NULL');
  });

  it('THE TENANT IS NEVER A QUERY PARAMETER', () => {
    // `app_actor_organization()` is CALLED, never passed. No caller can point
    // one of these queries at a different school by handing it an argument.
    const repository = code(REPOSITORY);
    const analyticsQueries = repository.match(/FROM analytics_\w+[\s\S]*?`/g) ?? [];
    for (const statement of analyticsQueries) {
      // The permitted parameters are paging and an optional class filter —
      // never an organization.
      const params = statement.match(/\$\d+/g) ?? [];
      for (const param of params) {
        expect(statement.includes(`organization_id = ${param}`)).toBe(false);
      }
    }
  });

  it('no SQL in the module is built by concatenation of a value', () => {
    /**
     * ONLY SQL TEMPLATE LITERALS ARE INSPECTED, and the narrowing is the point
     * rather than a convenience. The repository also builds a synthetic
     * resource descriptor — `school:${id}` — with a template literal, which is
     * not SQL and is not a risk; a check that flagged it would be a check
     * somebody eventually turns off.
     *
     * A literal counts as SQL if it names one of the statement keywords.
     */
    for (const file of sourceFiles(MODULE)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      const literals = source.match(/`[^`]*`/g) ?? [];
      for (const literal of literals) {
        if (!/\b(SELECT|INSERT|UPDATE|DELETE|FROM)\b/.test(literal)) continue;
        const interpolations = literal.match(/\$\{[^}]+\}/g) ?? [];
        expect(interpolations, `${file} interpolates into SQL: ${literal.slice(0, 60)}`).toEqual(
          [],
        );
      }
    }
  });
});

describe('the tables are derived, and the schema says so', () => {
  it('grants edu_app SELECT and nothing else', () => {
    const migration = read(MIGRATION);
    expect(migration).toContain('GRANT SELECT ON analytics_daily_school_metrics TO edu_app;');
    expect(migration).toContain('GRANT SELECT ON analytics_course_performance TO edu_app;');
    // No INSERT/UPDATE/DELETE grant, and therefore no way for a request to make
    // the dashboard say something the school's data does not.
    expect(migration).not.toMatch(/GRANT[^;]*INSERT[^;]*ON analytics_/);
    expect(migration).not.toMatch(/GRANT[^;]*UPDATE[^;]*ON analytics_/);
    expect(migration).not.toMatch(/GRANT[^;]*DELETE[^;]*ON analytics_/);
  });

  it('declares no write policy for the application role', () => {
    const migration = read(MIGRATION);
    // `[\s\S]*?` rather than `\s+`: the policy name and its ON clause sit on
    // separate lines, and the first version of this matched nothing at all —
    // which passed the `.toContain('FOR SELECT')` loop vacuously over an empty
    // array. A fitness function that matches nothing asserts nothing, so the
    // count is checked first.
    const appPolicies =
      migration.match(/CREATE POLICY analytics_\w+[\s\S]{0,80}?TO edu_app/g) ?? [];
    expect(appPolicies.length).toBeGreaterThanOrEqual(2);
    for (const policy of appPolicies) {
      expect(policy, policy).toContain('FOR SELECT');
    }
  });

  it('BINDS THE TENANT WITH A COMPOSITE FOREIGN KEY, not a trigger', () => {
    /**
     * `analytics_course_performance` carries both `class_id` and
     * `organization_id`, which is a denormalization and therefore an
     * opportunity for the two to disagree. A trigger could keep them in step; a
     * policy could check them. Both are code that has to keep being right.
     *
     * Referencing the pair means a row whose organization does not match its
     * class CANNOT BE WRITTEN — not by a bug in the refresh, not by a future
     * endpoint, not by anybody holding INSERT.
     */
    const migration = read(MIGRATION);
    expect(migration).toContain('classes_id_organization_uk UNIQUE (id, organization_id)');
    expect(migration).toMatch(
      /FOREIGN KEY \(class_id, organization_id\)\s*REFERENCES classes \(id, organization_id\)/,
    );
  });

  it('every table a definer function touches has a policy for the definer role', () => {
    // Migration 0014's rule, which this platform has now learned five times.
    // `tests/integration/rls-definer-coverage.test.ts` proves it against the
    // live catalog; this is the cheap textual half.
    const migration = read(MIGRATION);
    for (const policy of [
      'analytics_daily_definer_all',
      'analytics_course_definer_all',
      'ai_conversations_definer_select',
      'ai_messages_definer_select',
    ]) {
      expect(migration, `${policy} is missing`).toContain(policy);
    }
  });

  it('the refresh takes no lock stronger than a plain read', () => {
    // The textual half of what `rls-analytics.test.ts` measures against
    // `pg_locks`. A `FOR UPDATE` added for a plausible-sounding reason — "so
    // the numbers are consistent" — would start blocking learners mid-quiz.
    // COMMENTS STRIPPED FIRST. The migration's header explains at length that
    // it takes no `FOR UPDATE`, and a check reading the prose would fail on the
    // very sentence promising the property — the same trap as every other
    // fitness suite here, which is why `stripComments` exists.
    const migration = stripSqlComments(read(MIGRATION));
    expect(migration).not.toMatch(/FOR UPDATE|FOR SHARE|LOCK TABLE/i);
    // And it is not a materialized view, whose REFRESH takes ACCESS EXCLUSIVE.
    expect(migration).not.toMatch(/REFRESH MATERIALIZED VIEW/i);
  });
});

describe('the CSV sanitizer', () => {
  it('neutralizes every published payload and mangles no ordinary value', () => {
    // The two halves of the contract, asserted against the module's own
    // exported lists so the test cannot drift from what the code believes.
    for (const payload of CSV_INJECTION_PAYLOADS) {
      expect(csvCell(payload).slice(1), payload).toMatch(/^'/);
    }
    for (const value of CSV_MUST_NOT_MANGLE) {
      expect(csvCell(value).slice(1, -1).replace(/""/g, '"'), value).toBe(value);
    }
  });

  it('is pure: no database, no clock, no configuration', () => {
    const source = code(CSV);
    for (const forbidden of ['tx.query', 'Date.now', 'Math.random', 'process.env', 'require(']) {
      expect(source, `${forbidden} in the sanitizer`).not.toContain(forbidden);
    }
  });

  it('imports nothing at all', () => {
    // No import line means no way to acquire a dependency on a layer above it,
    // and no way for module initialization order to change what it decides.
    expect(code(CSV)).not.toMatch(/^\s*import\b/m);
  });

  it('INCLUDES THE WHITESPACE TRIGGERS the specification’s list of four omits', () => {
    // Excel strips leading whitespace before deciding whether a cell is a
    // formula, so a check that looks at index 0 for `= + - @` hands the
    // spreadsheet a live formula prefixed with a tab.
    const source = code(CSV);
    expect(source).toMatch(/FORMULA_TRIGGERS[\s\S]*?'\\t'/);
    expect(source).toMatch(/FORMULA_TRIGGERS[\s\S]*?'\\r'/);
  });

  it('every export cell goes through the sanitizer', () => {
    // The service must not assemble a CSV any other way. `toCsv` is the only
    // door, and it runs `csvCell` over the headers as well as the data.
    const service = code(SERVICE);
    expect(service).toContain('toCsv(headers, rows)');
    expect(service).not.toMatch(/\.join\(','\)/);
  });

  it('the filename is sanitized separately from the content', () => {
    // A filename lands in a Content-Disposition header, where the danger is
    // header injection rather than a formula.
    expect(code(SERVICE)).toContain('csvFilename(');
    expect(code(ROUTES)).toContain('Content-Disposition');
    expect(code(ROUTES)).toContain('nosniff');
  });
});

describe('the decision is taken before the aggregate is computed', () => {
  it('every service method decides before it reads rows', () => {
    /**
     * "Read it then decide" is right when the resource IS the row. It is wrong
     * for an aggregate: it would mean computing a school's numbers and THEN
     * deciding whether the caller may have them, leaving those numbers in
     * memory in a process serving somebody with no right to them.
     *
     * Asserted positionally — the `decide` call must appear before the first
     * repository read in each method's body.
     */
    const service = code(SERVICE);
    for (const method of ['schoolOverview', 'coursePerformance', 'atRisk', 'exportReport']) {
      const start = service.indexOf(`async ${method}(`);
      expect(start, method).toBeGreaterThan(-1);
      const body = service.slice(start, service.indexOf('\n    },', start));
      const decideAt = body.indexOf('decide(ctx,');
      const readAt = body.search(/repository\.(dailyMetrics|coursePerformance|atRisk)\(/);
      expect(decideAt, `${method} never decides`).toBeGreaterThan(-1);
      if (readAt > -1) {
        expect(decideAt, `${method} reads before deciding`).toBeLessThan(readAt);
      }
    }
  });

  it('the export reuses the read path rather than assembling its own SQL', () => {
    // Two doors onto the same data must be authorized by the same facts. An
    // export with its own queries would drift — most likely toward being wider,
    // because it is the one nobody opens on screen.
    const service = code(SERVICE);
    expect(service).toContain('admitCourseRows(ctx, tx,');
    expect((service.match(/admitCourseRows\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('reading and exporting emit DIFFERENT security events', () => {
    // The bytes may be identical; the acts are not. A dashboard closes with the
    // tab, and a file does not.
    const service = code(SERVICE);
    expect(service).toContain('ANALYTICS_REPORT_READ');
    expect(service).toContain('ANALYTICS_EXPORTED');
  });
});

describe('the vocabulary says only what the system does', () => {
  it('has no create, update or delete verb', () => {
    // Nobody creates or edits a report. A write verb would advertise a power
    // the database does not grant and could not be made to grant without a way
    // to make the dashboard disagree with the school's data.
    for (const action of ANALYTICS_REPORT_ACTIONS) {
      expect(action).not.toMatch(/:(create|update|delete|write)$/);
    }
  });

  it('separates at_risk from the executive verbs', () => {
    // Its holder is different from every other verb here: the teacher who will
    // sit down with the child, and not the institution.
    expect(ANALYTICS_REPORT_ACTIONS).toContain('analytics_report:at_risk');
    expect(ANALYTICS_REPORT_ACTIONS).toContain('analytics_report:read_school');
  });

  it('separates export from read', () => {
    expect(ANALYTICS_REPORT_ACTIONS).toContain('analytics_report:export');
  });

  it('every action is authorized somewhere in the module', () => {
    const source = sourceFiles(MODULE)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    for (const action of ANALYTICS_REPORT_ACTIONS) {
      expect(source, `${action} is declared but never authorized`).toContain(action);
    }
  });
});

describe('the FERPA line is where the policy says it is', () => {
  it('AN ADMINISTRATOR IS REFUSED THE NAMED LIST', () => {
    // Seniority narrows rather than widens. Asserted as source text because
    // this is the branch a future "just let admins see it too" edit would
    // delete, and deleting it produces no test failure anywhere else that
    // reads as a policy change.
    const policy = code(POLICY);
    expect(policy).toContain('at_risk_is_for_teachers');
    expect(policy).toMatch(/actorIsOrgAdmin && report\.actorTeachesClass !== true/);
  });

  it('the at-risk payload declares no answers and no scores', () => {
    const contract = code(CONTRACT);
    const schema = contract.slice(
      contract.indexOf('atRiskStudentSchema'),
      contract.indexOf('atRiskResponseSchema'),
    );
    for (const forbidden of ['answer', 'percentage', 'attemptId', 'score:', 'email']) {
      expect(schema, `${forbidden} in the at-risk payload`).not.toContain(forbidden);
    }
  });

  it('AT-RISK CANNOT BE EXPORTED — the dataset enum does not contain it', () => {
    // A CSV of struggling minors is the artefact that gets forwarded and left
    // on laptops. The door is not there, rather than being guarded.
    const contract = code(CONTRACT);
    const datasets = contract.slice(
      contract.indexOf('exportDatasetSchema'),
      contract.indexOf('exportQuerySchema'),
    );
    expect(datasets).not.toContain('at_risk');
    expect(datasets).toContain('school_overview');
  });

  it('the at-risk function authorizes itself inside the definer', () => {
    // A SECURITY DEFINER function that trusted its caller to have checked would
    // be a hole with a comment on it.
    const migration = read(MIGRATION);
    const fn = migration.slice(migration.indexOf('FUNCTION app_analytics_at_risk'));
    expect(fn.slice(0, fn.indexOf('$$', fn.indexOf('$$') + 2))).toContain(
      'app_actor_teaches_class',
    );
  });
});
